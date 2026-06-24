const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { AlpacaTradeAdapter } = require('./alpaca-adapter');
const { loadConfig } = require('./config');
const { loadRuntimeEnv } = require('./runtime-env');
const { listProcessLocks } = require('./process-lock');
const { evaluatePolicyHealth } = require('./policy-health');
const { nowIso, safeNumber } = require('./util');

const execFileAsync = promisify(execFile);

const Reason = {
  PREFLIGHT_BROKER_ACCOUNT_UNAVAILABLE: 'PREFLIGHT_BROKER_ACCOUNT_UNAVAILABLE',
  PREFLIGHT_BROKER_POSITIONS_UNAVAILABLE: 'PREFLIGHT_BROKER_POSITIONS_UNAVAILABLE',
  PREFLIGHT_BROKER_OPEN_ORDERS_UNAVAILABLE: 'PREFLIGHT_BROKER_OPEN_ORDERS_UNAVAILABLE',
  PREFLIGHT_BROKER_STATE_REQUIRED: 'PREFLIGHT_BROKER_STATE_REQUIRED',
  PREFLIGHT_ALPACA_CREDENTIALS_MISSING: 'PREFLIGHT_ALPACA_CREDENTIALS_MISSING',
  ENV_CHANGED_AFTER_START_RESTART_REQUIRED: 'ENV_CHANGED_AFTER_START_RESTART_REQUIRED',
};

async function runLivePreflight(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const dataDir = path.resolve(options.dataDir || path.join(repoRoot, 'data'));
  const checkedAt = options.now || nowIso();
  const nowMs = new Date(checkedAt).getTime();
  const runtimeEnv = options.runtimeEnv || loadRuntimeEnv(options.env || process.env, repoRoot);
  const criticalFailures = [];
  const warnings = [];
  const info = [];
  const recommendedActions = [];

  const config = buildConfigState({ repoRoot, runtimeEnv, options, warnings, recommendedActions });
  const liveCapable = isLiveCapable(runtimeEnv, config.loaded_config);
  const broker = await buildBrokerState({ runtimeEnv, options, liveCapable, criticalFailures, warnings, recommendedActions });
  const policySnapshot = options.policySnapshot !== undefined
    ? options.policySnapshot
    : readJsonFile(path.join(dataDir, 'live-policy.json'));
  const policyHealth = evaluatePolicyHealth({
    policySnapshot,
    runtimeEnv,
    envLocalMtimeMs: config.env_local_mtime_ms,
    now: checkedAt,
  });
  const policy = {
    available: Boolean(policySnapshot),
    stale: policyHealth.stale,
    source: policyHealth.source,
    scope: policyHealth.scope,
    captured_at: policyHealth.captured_at,
    deprecated_fields: policyHealth.deprecated_fields,
    suspicious_fields: policyHealth.suspicious_fields,
    drift: policyHealth.drift,
    warnings: policyHealth.warnings,
    critical_failures: policyHealth.critical_failures,
    health: policyHealth,
  };
  warnings.push(...policyHealth.warnings);
  criticalFailures.push(...policyHealth.critical_failures);
  if (policyHealth.warnings.length || policyHealth.critical_failures.length) {
    recommendedActions.push('Review active policy health before starting or continuing live operation.');
  }

  const processDiscovery = options.processDiscovery || await discoverRepoProcesses();
  const processes = buildProcessState(processDiscovery, options.scannerRuntime, {
    dataDir,
    nowMs,
    warnings,
    recommendedActions,
  });
  const locks = buildLockState({ repoRoot, options });
  const files = buildFileState({ dataDir, repoRoot, scannerRuntime: processes.scanner_runtime_file });

  const uniqueCritical = [...new Set(criticalFailures.filter(Boolean))];
  const uniqueWarnings = [...new Set(warnings.filter(Boolean))];
  const status = uniqueCritical.length ? 'NO_GO' : uniqueWarnings.length ? 'WARN' : 'GO';
  if (status === 'NO_GO') recommendedActions.push('Do not start new live operation until critical preflight failures are resolved.');
  if (status === 'WARN') recommendedActions.push('Proceed only after reviewing preflight warnings.');

  const result = {
    status,
    checked_at: checkedAt,
    critical_failures: uniqueCritical,
    warnings: uniqueWarnings,
    info: [...new Set(info)],
    broker,
    config: redactConfig(config),
    policy,
    processes: {
      trader: processes.trader,
      scanner: processes.scanner,
      dashboard: processes.dashboard,
      duplicate_warnings: processes.duplicate_warnings,
      scanner_runtime_stale: processes.scanner_runtime_stale,
    },
    locks,
    files,
    recommended_actions: [...new Set(recommendedActions.filter(Boolean))],
  };

  if (options.writeLatest !== false) {
    writeLatestPreflight(result, options.outputPath || path.join(dataDir, 'runtime', 'live-preflight-latest.json'));
  }
  return result;
}

function buildConfigState({ repoRoot, runtimeEnv, options, warnings, recommendedActions }) {
  const envLocalPath = path.join(repoRoot, '.env.local');
  const envLocalStat = statFile(envLocalPath);
  const runtimeStartedAt = options.runtimeStartedAt || inferRuntimeStartedAt(options);
  const runtimeStartedMs = new Date(runtimeStartedAt || 0).getTime();
  const changedAfterStart = Boolean(
    envLocalStat.exists
    && Number.isFinite(envLocalStat.mtime_ms)
    && Number.isFinite(runtimeStartedMs)
    && runtimeStartedMs > 0
    && envLocalStat.mtime_ms > runtimeStartedMs
  );
  let loadedConfig = null;
  let loaded = true;
  let loadError = null;
  try {
    loadedConfig = loadConfig(runtimeEnv);
  } catch (error) {
    loaded = false;
    loadError = error.message;
    warnings.push('CONFIG_LOAD_FAILED');
    recommendedActions.push('Fix runtime configuration validation errors.');
  }
  if (changedAfterStart) {
    warnings.push(Reason.ENV_CHANGED_AFTER_START_RESTART_REQUIRED);
    recommendedActions.push('Restart trader/scanner/dashboard so .env.local changes are loaded.');
  }
  return {
    loaded,
    load_error: loadError,
    env_local_exists: envLocalStat.exists,
    env_local_changed_after_start: changedAfterStart,
    env_local_mtime: envLocalStat.mtime,
    env_local_mtime_ms: envLocalStat.mtime_ms,
    runtime_started_at: runtimeStartedAt || null,
    config_loaded_at: nowIso(),
    drift: [],
    loaded_config: loadedConfig,
  };
}

async function buildBrokerState({ runtimeEnv, options, liveCapable, criticalFailures, warnings, recommendedActions }) {
  const broker = {
    account_available: false,
    positions_available: false,
    open_orders_available: false,
    account_summary: {},
    position_count: 0,
    open_order_count: 0,
  };
  const credentialsMissing = !runtimeEnv.ALPACA_API_KEY_ID || !runtimeEnv.ALPACA_API_SECRET_KEY;
  if (liveCapable && credentialsMissing) {
    criticalFailures.push(Reason.PREFLIGHT_ALPACA_CREDENTIALS_MISSING, Reason.PREFLIGHT_BROKER_STATE_REQUIRED);
    recommendedActions.push('Configure Alpaca credentials locally before live-capable operation.');
    return broker;
  }
  const adapter = options.executionAdapter || new AlpacaTradeAdapter({
    apiKeyId: runtimeEnv.ALPACA_API_KEY_ID,
    apiSecretKey: runtimeEnv.ALPACA_API_SECRET_KEY,
    baseUrl: runtimeEnv.ALPACA_API_BASE_URL || undefined,
    paperTrading: String(runtimeEnv.ALPACA_PAPER_TRADING || '').toLowerCase() !== 'false',
    fetch: options.fetchImpl || globalThis.fetch,
  });

  const [accountState, positionsState, openOrdersState] = await Promise.all([
    readBroker(() => adapter.getAccount(), Reason.PREFLIGHT_BROKER_ACCOUNT_UNAVAILABLE),
    readBroker(() => adapter.getPositions(), Reason.PREFLIGHT_BROKER_POSITIONS_UNAVAILABLE),
    readBroker(() => adapter.getOpenOrders(), Reason.PREFLIGHT_BROKER_OPEN_ORDERS_UNAVAILABLE),
  ]);

  broker.account_available = accountState.available;
  broker.positions_available = positionsState.available;
  broker.open_orders_available = openOrdersState.available;
  broker.account_summary = summarizeAccount(accountState.data);
  broker.position_count = Array.isArray(positionsState.data) ? positionsState.data.length : 0;
  broker.open_order_count = Array.isArray(openOrdersState.data) ? openOrdersState.data.length : 0;

  for (const state of [accountState, positionsState, openOrdersState]) {
    if (!state.available) {
      if (liveCapable) criticalFailures.push(state.reason_code, Reason.PREFLIGHT_BROKER_STATE_REQUIRED);
      else warnings.push(state.reason_code);
      if (state.error) warnings.push(`${state.reason_code}: ${state.error}`);
    }
  }
  if (liveCapable && (!broker.account_available || !broker.positions_available || !broker.open_orders_available)) {
    recommendedActions.push('Restore broker account, positions, and open-order visibility before live buys.');
  }
  return broker;
}

function buildProcessState(processDiscovery, scannerRuntimeOverride, { dataDir, nowMs, warnings, recommendedActions }) {
  const traderCount = processDiscovery.traders?.length || 0;
  const scannerCount = processDiscovery.scanners?.length || 0;
  const dashboardCount = processDiscovery.dashboards?.length || 0;
  const duplicateWarnings = [];
  if (traderCount > 1) duplicateWarnings.push('DUPLICATE_TRADER_PROCESSES');
  if (scannerCount > 1) duplicateWarnings.push('DUPLICATE_SCANNER_PROCESSES');
  if (dashboardCount > 1) duplicateWarnings.push('DUPLICATE_DASHBOARD_PROCESSES');
  if (traderCount > 0 && scannerCount === 0) duplicateWarnings.push('TRADER_RUNNING_SCANNER_STOPPED');
  if (scannerCount > 0 && traderCount === 0) duplicateWarnings.push('SCANNER_RUNNING_TRADER_STOPPED');
  warnings.push(...duplicateWarnings);
  if (duplicateWarnings.length) recommendedActions.push('Resolve duplicate or mismatched local workflow processes.');

  const scannerRuntimeFile = scannerRuntimeOverride || readJsonFile(path.join(dataDir, 'logs', 'scanner-runtime.json'));
  const lastScanMs = new Date(scannerRuntimeFile?.last_scan_time || scannerRuntimeFile?.updated_at || 0).getTime();
  const scannerRuntimeStale = Number.isFinite(lastScanMs) && lastScanMs > 0 && Number.isFinite(nowMs) && (nowMs - lastScanMs) > 5 * 60_000;
  if (scannerRuntimeStale) warnings.push('SCANNER_RUNTIME_STALE');
  return {
    trader: { count: traderCount, pids: (processDiscovery.traders || []).map((item) => item.pid) },
    scanner: { count: scannerCount, pids: (processDiscovery.scanners || []).map((item) => item.pid) },
    dashboard: { count: dashboardCount, pids: (processDiscovery.dashboards || []).map((item) => item.pid) },
    duplicate_warnings: duplicateWarnings,
    scanner_runtime_stale: scannerRuntimeStale,
    scanner_runtime_file: scannerRuntimeFile,
  };
}

function buildLockState({ repoRoot, options }) {
  const locks = options.locks || listProcessLocks({ repoRoot });
  return {
    count: locks.length,
    items: locks.map((entry) => ({
      name: entry.lock?.name || null,
      exists: Boolean(entry.exists),
      pid: entry.lock?.pid || null,
      owner: entry.lock?.owner || null,
      acquired_at: entry.lock?.acquired_at || null,
      updated_at: entry.lock?.updated_at || null,
      path: entry.path,
    })),
  };
}

function buildFileState({ dataDir, repoRoot }) {
  return {
    env_local: statFile(path.join(repoRoot, '.env.local')),
    live_policy: statFile(path.join(dataDir, 'live-policy.json')),
    policy_history: statFile(path.join(dataDir, 'policy-history.jsonl')),
    scanner_runtime: statFile(path.join(dataDir, 'logs', 'scanner-runtime.json')),
    preflight_latest: statFile(path.join(dataDir, 'runtime', 'live-preflight-latest.json')),
  };
}

function isLiveCapable(runtimeEnv, config = null) {
  return String(runtimeEnv.TRADING_MODE || config?.TRADING_MODE || '').toLowerCase() === 'live'
    || String(runtimeEnv.LIVE_TRADING_ENABLED || config?.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true'
    || String(runtimeEnv.ALPACA_EXECUTION_ENABLED || config?.ALPACA_EXECUTION_ENABLED || '').toLowerCase() === 'true';
}

function inferRuntimeStartedAt(options = {}) {
  return options.startedAt
    || options.scannerRuntime?.mode_since
    || options.scannerRuntime?.started_at
    || options.controlState?.scanner?.started_at
    || options.controlState?.trader?.started_at
    || null;
}

async function readBroker(readFn, reasonCode) {
  try {
    const data = await readFn();
    return { available: data !== null && data !== undefined, data, reason_code: reasonCode, error: null };
  } catch (error) {
    return { available: false, data: null, reason_code: reasonCode, error: error.message };
  }
}

function summarizeAccount(account = {}) {
  if (!account) return {};
  return {
    status: account.status || null,
    trading_blocked: account.trading_blocked ?? null,
    account_blocked: account.account_blocked ?? null,
    cash: account.cash ?? null,
    buying_power: account.buying_power ?? null,
    equity: account.equity ?? account.portfolio_value ?? null,
    pattern_day_trader: account.pattern_day_trader ?? null,
  };
}

function statFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      mtime_ms: stat.mtimeMs,
    };
  } catch {
    return { path: filePath, exists: false };
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLatestPreflight(result, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`);
}

function redactConfig(config) {
  const { loaded_config: loadedConfig, ...rest } = config;
  return {
    ...rest,
    loaded_config: loadedConfig ? {
      TRADING_MODE: loadedConfig.TRADING_MODE,
      LIVE_TRADING_ENABLED: loadedConfig.LIVE_TRADING_ENABLED,
      ALPACA_EXECUTION_ENABLED: loadedConfig.ALPACA_EXECUTION_ENABLED,
      MAX_OPEN_POSITIONS: loadedConfig.MAX_OPEN_POSITIONS,
      BUY_NOTIONAL_TARGET: loadedConfig.BUY_NOTIONAL_TARGET,
      MIN_BUY_NOTIONAL: loadedConfig.MIN_BUY_NOTIONAL,
      MAX_SPREAD_SLIPPAGE_PCT: loadedConfig.MAX_SPREAD_SLIPPAGE_PCT,
      MIN_VOLUME: loadedConfig.MIN_VOLUME,
    } : null,
  };
}

async function discoverRepoProcesses() {
  if (process.platform !== 'win32') return { current_pid: process.pid, dashboards: [], traders: [], scanners: [] };
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dashboard-cli\\.js|trader-cli\\.js|minimal-cli\\.js|start-(stock|crypto|overnight)-scanner\\.js' } | Select-Object ProcessId,CommandLine; $items | ConvertTo-Json -Compress`,
    ]);
    const raw = String(stdout || '').trim();
    if (!raw) return { current_pid: process.pid, dashboards: [], traders: [], scanners: [] };
    const parsed = JSON.parse(raw);
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      command_line: String(row.CommandLine || ''),
    })).filter((row) => Number.isFinite(row.pid));
    return {
      current_pid: process.pid,
      dashboards: rows.filter((row) => /dashboard-cli\.js/i.test(row.command_line)).map((row) => ({ ...row, current: row.pid === process.pid })),
      traders: rows.filter((row) => /trader-cli\.js|minimal-cli\.js/i.test(row.command_line)),
      scanners: rows.filter((row) => /start-(stock|crypto|overnight)-scanner\.js/i.test(row.command_line)),
    };
  } catch {
    return { current_pid: process.pid, dashboards: [], traders: [], scanners: [] };
  }
}

module.exports = {
  PreflightReason: Reason,
  discoverRepoProcesses,
  runLivePreflight,
  writeLatestPreflight,
};
