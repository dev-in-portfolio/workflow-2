const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { loadRuntimeEnv } = require('./runtime-env');
const { nowIso } = require('./util');
const { appendOperatorTimelineEvent } = require('./operator-timeline');

const execFileAsync = promisify(execFile);

const SCANNER_PROFILES = {
  'live-market': {
    label: 'Live market',
    script: 'scripts/start-stock-scanner.js',
  },
  'crypto-only': {
    label: 'Crypto only',
    script: 'scripts/start-crypto-scanner.js',
  },
  'market-aware-auto': {
    label: 'Market-aware auto',
    script: 'scripts/start-overnight-scanner.js',
  },
};

function createLocalProcessController(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const execFileAsyncImpl = options.execFileAsync || execFileAsync;
  const traderPort = Number.isFinite(Number(options.traderPort)) ? Number(options.traderPort) : 3001;
  const runtimeEnv = options.runtimeEnv || loadRuntimeEnv(env, repoRoot);
  const workflowStatePath = options.workflowStatePath || path.join(repoRoot, 'data', 'workflow-state.json');
  const persisted = readPersistedWorkflowState();
  const desiredProfile = normalizeScannerProfile(persisted.desired_scanner_profile || persisted.scanner_profile || 'crypto-only') || 'crypto-only';
  const state = {
    workflow: {
      status: 'stopped',
      desired_scanner_profile: desiredProfile,
      lock: null,
      issues: [],
      verified_at: null,
    },
    trader: {
      pid: null,
      status: 'stopped',
      port: traderPort,
      base_url: `http://127.0.0.1:${traderPort}`,
      started_at: null,
      last_action_at: null,
      last_error: null,
      managed: false,
    },
    scanner: {
      pid: null,
      pids: [],
      profile: null,
      last_profile: desiredProfile,
      desired_profile: desiredProfile,
      status: 'stopped',
      script: null,
      started_at: null,
      last_action_at: null,
      last_error: null,
      managed: false,
      multiple_running: false,
      discovered: [],
    },
    last_action: null,
    updated_at: nowIso(),
  };

  async function refresh() {
    state.trader = await refreshTraderState(state.trader);
    state.scanner = await refreshScannerState(state.scanner);
    updateWorkflowStatus();
    state.updated_at = nowIso();
    return getState();
  }

  async function startWorkflow(profile = null) {
    return withWorkflowLock('start-workflow', async () => {
      state.workflow.status = 'starting';
      const nextProfile = setDesiredScannerProfile(profile || state.workflow.desired_scanner_profile || state.scanner.last_profile || 'crypto-only');
      const traderResult = await startTrader();
      if (!traderResult.ok) {
        updateWorkflowStatus();
        return markAction('start-workflow', false, traderResult.message, { scanner_profile: nextProfile });
      }
      const scannerResult = await startScanner(nextProfile);
      await refresh();
      if (!scannerResult.ok) {
        return markAction('start-workflow', false, `Trader started, but scanner failed: ${scannerResult.message}`, { scanner_profile: nextProfile });
      }
      return markAction('start-workflow', state.workflow.status === 'running', `Workflow started with ${displayScannerProfile(nextProfile)} scanner`, { scanner_profile: nextProfile });
    });
  }

  async function stopWorkflow() {
    return withWorkflowLock('stop-workflow', async () => {
      state.workflow.status = 'stopping';
      const scannerResult = await stopScanner();
      const traderResult = await stopTrader();
      await refresh();
      const ok = state.workflow.status === 'stopped';
      return markAction(
        'stop-workflow',
        ok,
        ok ? 'Workflow stopped; no repo trader/scanner processes remain' : 'Workflow stop attempted, but a repo process still appears to be running',
        { scanner_result: scannerResult.message, trader_result: traderResult.message },
      );
    });
  }

  async function restartWorkflow(profile = null) {
    return withWorkflowLock('restart-workflow', async () => {
      const nextProfile = setDesiredScannerProfile(profile || state.workflow.desired_scanner_profile || state.scanner.last_profile || 'crypto-only');
      await stopScanner();
      await stopTrader();
      await startTrader();
      await startScanner(nextProfile);
      await refresh();
      return markAction(
        'restart-workflow',
        state.workflow.status === 'running',
        state.workflow.status === 'running'
          ? `Workflow restarted with ${displayScannerProfile(nextProfile)} scanner`
          : `Workflow restart degraded: ${state.workflow.issues.join(', ') || 'verification incomplete'}`,
        { scanner_profile: nextProfile },
      );
    });
  }

  async function startTrader() {
    await refreshTraderState(state.trader);
    if (state.trader.status === 'running' || await isUrlAlive(state.trader.base_url)) {
      return markAction('start-trader', true, 'Trader already running');
    }
    if (await isPortOccupied(traderPort) && !(await isUrlAlive(state.trader.base_url))) {
      return markAction('start-trader', false, `Port ${traderPort} is already in use`);
    }
    const child = launchNodeScript('src/trader-cli.js', {
      PORT: String(traderPort),
      SERVER_PORT: String(traderPort),
    });
    state.trader = {
      ...state.trader,
      pid: child.pid,
      status: 'starting',
      started_at: nowIso(),
      last_action_at: nowIso(),
      last_error: null,
      managed: true,
    };
    const ready = await waitForUrl(state.trader.base_url, 10_000);
    state.trader.status = ready ? 'running' : 'starting';
    state.updated_at = nowIso();
    return markAction('start-trader', true, ready ? 'Trader started' : 'Trader launch in progress');
  }

  async function stopTrader() {
    const pids = await resolveTraderPids();
    if (!pids.length) {
      state.trader.status = 'stopped';
      state.trader.pid = null;
      state.trader.managed = false;
      state.updated_at = nowIso();
      return markAction('stop-trader', true, 'Trader already stopped');
    }
    await killPids(pids);
    state.trader.pid = null;
    state.trader.status = 'stopped';
    state.trader.managed = false;
    state.trader.last_action_at = nowIso();
    state.updated_at = nowIso();
    return markAction('stop-trader', true, `Stopped ${pids.length} trader process${pids.length === 1 ? '' : 'es'}`);
  }

  async function restartTrader() {
    return restartWorkflow(state.workflow.desired_scanner_profile || state.scanner.last_profile || 'crypto-only');
  }

  async function startScanner(profile = 'crypto-only') {
    const nextProfile = setDesiredScannerProfile(profile);
    if (!nextProfile) {
      return markAction('start-scanner', false, 'Unknown scanner profile');
    }
    const existing = await discoverScannerProcesses();
    if (existing.length) {
      await stopScanner();
    }
    const script = SCANNER_PROFILES[nextProfile].script;
    const child = launchNodeScript(script, buildScannerEnv(nextProfile));
    state.scanner = {
      ...state.scanner,
      pid: child.pid,
      pids: [child.pid],
      profile: nextProfile,
      last_profile: nextProfile,
      desired_profile: nextProfile,
      status: 'starting',
      script,
      started_at: nowIso(),
      last_action_at: nowIso(),
      last_error: null,
      managed: true,
      multiple_running: false,
      discovered: [],
    };
    await sleep(700);
    state.scanner.status = isPidAlive(child.pid) ? 'running' : 'starting';
    state.updated_at = nowIso();
    return markAction('start-scanner', true, `${displayScannerProfile(nextProfile)} scanner launched`);
  }

  async function stopScanner() {
    const rememberedProfile = state.scanner.profile || state.workflow.desired_scanner_profile || state.scanner.last_profile || null;
    const discovered = await discoverScannerProcesses();
    const pids = uniqueNumbers([
      ...discovered.map((processInfo) => processInfo.pid),
      state.scanner.pid,
      ...(state.scanner.pids || []),
    ]).filter(isPidAlive);
    if (!pids.length) {
      state.scanner = {
        ...state.scanner,
        pid: null,
        pids: [],
        status: 'stopped',
        profile: rememberedProfile,
        last_profile: rememberedProfile,
        desired_profile: state.workflow.desired_scanner_profile,
        managed: false,
        multiple_running: false,
        discovered: [],
      };
      state.updated_at = nowIso();
      return markAction('stop-scanner', true, 'Scanner already stopped');
    }
    await killPids(pids);
    state.scanner = {
      ...state.scanner,
      pid: null,
      pids: [],
      status: 'stopped',
      profile: rememberedProfile,
      last_profile: rememberedProfile,
      desired_profile: state.workflow.desired_scanner_profile,
      managed: false,
      multiple_running: false,
      discovered: [],
      last_action_at: nowIso(),
    };
    state.updated_at = nowIso();
    return markAction('stop-scanner', true, `Stopped ${pids.length} scanner process${pids.length === 1 ? '' : 'es'}`);
  }

  async function switchScannerProfile(profile) {
    const nextProfile = setDesiredScannerProfile(profile);
    if (!nextProfile) {
      return markAction('switch-scanner', false, 'Unknown scanner profile');
    }
    await stopScanner();
    return startScanner(nextProfile);
  }

  async function restartScanner(profile = null) {
    const nextProfile = setDesiredScannerProfile(profile || state.scanner.profile || state.workflow.desired_scanner_profile || 'crypto-only');
    await stopScanner();
    return startScanner(nextProfile);
  }

  async function refreshTraderState(traderState) {
    const pids = await resolveTraderPids();
    const baseUrl = traderState.base_url;
    const alive = await isUrlAlive(baseUrl);
    return {
      ...traderState,
      pid: alive ? pids[0] || traderState.pid : null,
      status: alive ? 'running' : 'stopped',
      managed: Boolean(pids[0] && traderState.managed),
    };
  }

  async function refreshScannerState(scannerState) {
    const discovered = await discoverScannerProcesses();
    if (!discovered.length) {
      return {
        ...scannerState,
        pid: null,
        pids: [],
        status: 'stopped',
        profile: scannerState.profile || state.workflow.desired_scanner_profile || scannerState.last_profile || null,
        last_profile: scannerState.last_profile || scannerState.profile || state.workflow.desired_scanner_profile || null,
        desired_profile: state.workflow.desired_scanner_profile,
        managed: false,
        multiple_running: false,
        discovered: [],
      };
    }
    const preferred = discovered.find((processInfo) => processInfo.profile === state.workflow.desired_scanner_profile) || discovered[0];
    return {
      ...scannerState,
      pid: preferred.pid,
      pids: discovered.map((processInfo) => processInfo.pid),
      status: discovered.length === 1 ? 'running' : 'degraded',
      profile: preferred.profile,
      last_profile: preferred.profile,
      desired_profile: state.workflow.desired_scanner_profile,
      script: preferred.script,
      managed: Boolean(scannerState.managed && discovered.some((processInfo) => processInfo.pid === scannerState.pid)),
      multiple_running: discovered.length > 1,
      discovered,
    };
  }

  function launchNodeScript(scriptRelativePath, extraEnv = {}) {
    const scriptPath = path.join(repoRoot, scriptRelativePath);
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Missing launcher script: ${scriptRelativePath}`);
    }
    const child = spawnImpl(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: {
        ...runtimeEnv,
        ...extraEnv,
        PATH: env.PATH,
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    if (child.unref) child.unref();
    return child;
  }

  function buildScannerEnv(profile) {
    const traderBaseUrl = state.trader.base_url;
    const common = {
      LOCAL_BASE_URL: traderBaseUrl,
      SCANNER_PROFILE: profile,
      SCANNER_RUNTIME_STATE_ENABLED: 'true',
      SCANNER_RECENT_SYMBOLS_ENABLED: 'true',
    };
    if (profile === 'live-market') {
      return { ...common, STOCK_SCANNER_LOCAL_BASE_URL: traderBaseUrl };
    }
    if (profile === 'market-aware-auto') {
      return { ...common, OVERNIGHT_SCANNER_LOCAL_BASE_URL: traderBaseUrl };
    }
    return {
      ...common,
      CRYPTO_SCANNER_LOCAL_BASE_URL: traderBaseUrl,
      OVERNIGHT_SCANNER_LOCAL_BASE_URL: traderBaseUrl,
    };
  }

  function getState() {
    return {
      workflow: { ...state.workflow, issues: [...state.workflow.issues] },
      trader: { ...state.trader },
      scanner: {
        ...state.scanner,
        pids: [...(state.scanner.pids || [])],
        discovered: [...(state.scanner.discovered || [])],
      },
      last_action: state.last_action,
      updated_at: state.updated_at,
    };
  }

  async function markAction(action, ok, message, details = {}) {
    const at = nowIso();
    state.last_action = {
      action,
      ok,
      message,
      details,
      at,
    };
    appendOperatorTimelineEvent({
      timestamp: at,
      event_type: `workflow.${action}`,
      source: 'local-process-controller',
      title: action.replace(/-/g, ' '),
      message,
      severity: ok ? 'info' : 'warning',
      details: {
        ok,
        workflow_status: state.workflow.status,
        trader_status: state.trader.status,
        scanner_status: state.scanner.status,
        scanner_profile: state.scanner.profile || state.workflow.desired_scanner_profile || null,
        ...details,
      },
    }, { env, repoRoot });
    state.updated_at = nowIso();
    return {
      ok,
      action,
      message,
      state: getState(),
      ...details,
    };
  }

  async function withWorkflowLock(action, fn) {
    if (state.workflow.lock) {
      return markAction(action, false, `Workflow is busy with ${state.workflow.lock}`);
    }
    state.workflow.lock = action;
    try {
      return await fn();
    } finally {
      state.workflow.lock = null;
      updateWorkflowStatus();
    }
  }

  function updateWorkflowStatus() {
    const issues = [];
    if (state.scanner.multiple_running) issues.push('MULTIPLE_SCANNERS_RUNNING');
    if (state.trader.status === 'running' && state.scanner.status === 'stopped') issues.push('TRADER_RUNNING_SCANNER_STOPPED');
    if (state.trader.status !== 'running' && state.scanner.status === 'running') issues.push('SCANNER_RUNNING_TRADER_STOPPED');
    if (state.scanner.profile && state.workflow.desired_scanner_profile && state.scanner.profile !== state.workflow.desired_scanner_profile) {
      issues.push('SCANNER_PROFILE_DRIFT');
    }
    state.workflow.issues = issues;
    if (state.trader.status === 'starting' || state.scanner.status === 'starting') {
      state.workflow.status = 'starting';
    } else if (state.trader.status === 'stopped' && state.scanner.status === 'stopped') {
      state.workflow.status = 'stopped';
    } else if (state.trader.status === 'running' && state.scanner.status === 'running' && !issues.length) {
      state.workflow.status = 'running';
    } else {
      state.workflow.status = 'degraded';
    }
    state.workflow.verified_at = nowIso();
  }

  async function waitForUrl(url, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isUrlAlive(url)) return true;
      await sleep(500);
    }
    return false;
  }

  async function isUrlAlive(url) {
    if (!fetchImpl || !url) return false;
    try {
      const response = await fetchImpl(`${url}/status`, { cache: 'no-store' });
      return Boolean(response && response.ok);
    } catch {
      return false;
    }
  }

  async function resolveTraderPids() {
    const byPort = await findPidByPort(traderPort);
    const byScript = await findNodeProcessesByFragments(['src/trader-cli.js', 'src/minimal-cli.js']);
    return uniqueNumbers([byPort, state.trader.pid, ...byScript.map((processInfo) => processInfo.pid)]).filter(isPidAlive);
  }

  async function findPidByPort(port) {
    try {
      const { stdout } = await execFileAsyncImpl('netstat', ['-ano', '-p', 'tcp']);
      const lines = String(stdout || '').split(/\r?\n/);
      const match = lines.find((line) => new RegExp(`:${port}\\s+.*LISTENING\\s+(\\d+)`, 'i').test(line));
      if (!match) return null;
      const pidMatch = match.match(/LISTENING\s+(\d+)/i);
      return pidMatch ? Number(pidMatch[1]) : null;
    } catch {
      return null;
    }
  }

  async function discoverScannerProcesses() {
    const discovered = await findNodeProcessesByFragments(Object.values(SCANNER_PROFILES).map((profile) => profile.script));
    return discovered.map((processInfo) => ({
      ...processInfo,
      profile: profileFromCommandLine(processInfo.commandLine),
      script: scriptFromCommandLine(processInfo.commandLine),
    })).filter((processInfo) => processInfo.profile);
  }

  async function findNodeProcessesByFragments(fragments) {
    const escapedFragments = fragments
      .map((fragment) => String(fragment).replace(/\\/g, '[\\\\/]').replace(/\//g, '[\\\\/]'))
      .join('|');
    try {
      const { stdout } = await execFileAsyncImpl('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match '${escapedFragments}' } | Select-Object ProcessId,CommandLine; $items | ConvertTo-Json -Compress`,
      ]);
      const raw = String(stdout || '').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .map((row) => ({
          pid: Number(row.ProcessId),
          commandLine: String(row.CommandLine || ''),
        }))
        .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
    } catch {
      return [];
    }
  }

  async function isPortOccupied(port) {
    const pid = await findPidByPort(port);
    return Boolean(pid);
  }

  function isPidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  }

  async function killPids(pids) {
    for (const pid of uniqueNumbers(pids)) {
      await killProcessTree(pid);
    }
  }

  async function killProcessTree(pid) {
    if (!pid) return;
    const numericPid = Number(pid);
    if (!Number.isFinite(numericPid)) return;
    if (process.platform === 'win32') {
      try {
        await execFileAsyncImpl('taskkill', ['/PID', String(numericPid), '/T', '/F']);
        return;
      } catch {
        // fall through to process.kill
      }
    }
    try {
      process.kill(numericPid);
    } catch {
      // best effort
    }
  }

  function setDesiredScannerProfile(profile) {
    const normalized = normalizeScannerProfile(profile);
    if (!normalized) return null;
    state.workflow.desired_scanner_profile = normalized;
    state.scanner.desired_profile = normalized;
    state.scanner.last_profile = normalized;
    writePersistedWorkflowState({ desired_scanner_profile: normalized });
    return normalized;
  }

  function readPersistedWorkflowState() {
    try {
      return JSON.parse(fs.readFileSync(workflowStatePath, 'utf8'));
    } catch {
      return {};
    }
  }

  function writePersistedWorkflowState(patch = {}) {
    try {
      fs.mkdirSync(path.dirname(workflowStatePath), { recursive: true });
      const current = readPersistedWorkflowState();
      fs.writeFileSync(workflowStatePath, `${JSON.stringify({ ...current, ...patch, updated_at: nowIso() }, null, 2)}\n`);
    } catch {
      // Persistence is helpful, but process control should still function without it.
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    refresh,
    startWorkflow,
    stopWorkflow,
    restartWorkflow,
    startTrader,
    stopTrader,
    restartTrader,
    startScanner,
    stopScanner,
    restartScanner,
    switchScannerProfile,
    getState,
  };
}

function normalizeScannerProfile(profile) {
  const normalized = String(profile || '').trim().toLowerCase();
  if (['live-market', 'live', 'stocks', 'stock'].includes(normalized)) return 'live-market';
  if (['crypto-only', 'crypto', 'overnight-crypto', 'overnight'].includes(normalized)) return 'crypto-only';
  if (['market-aware-auto', 'market-aware', 'auto', 'market-auto'].includes(normalized)) return 'market-aware-auto';
  return null;
}

function displayScannerProfile(profile) {
  return SCANNER_PROFILES[normalizeScannerProfile(profile)]?.label || 'Unknown';
}

function profileFromCommandLine(commandLine = '') {
  const normalized = commandLine.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('scripts/start-stock-scanner.js')) return 'live-market';
  if (normalized.includes('scripts/start-crypto-scanner.js')) return 'crypto-only';
  if (normalized.includes('scripts/start-overnight-scanner.js')) return 'market-aware-auto';
  return null;
}

function scriptFromCommandLine(commandLine = '') {
  const normalized = commandLine.replace(/\\/g, '/').toLowerCase();
  return Object.values(SCANNER_PROFILES).find((profile) => normalized.includes(profile.script.toLowerCase()))?.script || null;
}

function uniqueNumbers(values = []) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
}

module.exports = {
  createLocalProcessController,
  normalizeScannerProfile,
  displayScannerProfile,
};
