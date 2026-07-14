const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { createLocalProcessController } = require('./local-process-controller');
const { loadRuntimeEnv } = require('./runtime-env');
const { nowIso, resolveRepoRoot } = require('./util');
const { acquireProcessLock, releaseProcessLock } = require('./process-lock');

const execFileAsync = promisify(execFile);
const WORKFLOW_SCANNER_PROFILE = 'live-market';

function createWorkflowSupervisor(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || resolveRepoRoot());
  const env = options.runtimeEnv || loadRuntimeEnv(options.env || process.env, repoRoot);
  const controller = options.controller || createLocalProcessController({ repoRoot, env, runtimeEnv: env, allowLegacyScannerProfiles: true });
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const statePath = options.statePath || path.join(repoRoot, 'data', 'runtime', 'workflow-supervisor.json');
  const logDir = options.logDir || path.join(repoRoot, 'data', 'logs');
  const dashboardRuntimePath = path.join(repoRoot, 'data', 'runtime', 'dashboard-runtime.json');
  const scannerRuntimePath = path.join(repoRoot, 'data', 'state', 'scanner-runtime.json');
  const maxAttempts = Math.max(1, Number(options.maxAttempts || env.WORKFLOW_START_MAX_ATTEMPTS || 3));
  const monitorIntervalMs = Math.max(2_000, Number(options.monitorIntervalMs || env.WORKFLOW_MONITOR_INTERVAL_MS || 15_000));
  const readinessTimeoutMs = Math.max(1_000, Number(options.readinessTimeoutMs || env.WORKFLOW_READINESS_TIMEOUT_MS || 15_000));
  let dashboardChild = null;
  let stopping = false;
  let monitoring = false;
  let monitorTimer = null;
  let state = normalizeState(readJson(statePath), { maxAttempts });

  function persist(patch = {}) {
    state = { ...state, ...patch, updated_at: nowIso() };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return getState();
  }

  function log(event, details = {}) {
    fs.mkdirSync(logDir, { recursive: true });
    rotateLog(path.join(logDir, 'workflow-supervisor.log'));
    fs.appendFileSync(path.join(logDir, 'workflow-supervisor.log'), `${JSON.stringify({ at: nowIso(), event, ...details })}\n`);
  }

  async function start({ monitor = true, recovery = false } = {}) {
    const lock = acquireProcessLock({ repoRoot, name: 'workflow-supervisor', owner: 'workflow-supervisor', pid: process.pid });
    if (!lock.acquired && Number(lock.lock?.pid) !== process.pid) {
      const existing = readJson(statePath);
      return { ok: existing.status === 'healthy', reused: true, message: 'Workflow supervisor is already running', state: existing };
    }
    persist({ status: recovery ? 'recovering' : 'starting', supervisor_pid: process.pid, started_at: state.started_at || nowIso(), last_failure: null });
    const preflight = readJson(path.join(repoRoot, 'data', 'runtime', 'live-preflight-latest.json'));
    if (Array.isArray(preflight.critical_failures) && preflight.critical_failures.length) {
      const failure = `Live preflight blocked startup: ${preflight.critical_failures.join(', ')}`;
      persist({ status: 'failed', failed_component: 'preflight', last_failure: failure, recommended_action: 'Resolve live preflight failures and run start again.' });
      releaseProcessLock({ repoRoot, name: 'workflow-supervisor', pid: process.pid });
      return { ok: false, message: failure, state: getState() };
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      persist({ attempt, status: recovery ? 'recovering' : 'starting' });
      log('start_attempt', { attempt, recovery });
      const result = await startAttempt(attempt);
      if (result.ok) {
        persist({ status: 'healthy', healthy_at: nowIso(), last_failure: null, failed_component: null, recommended_action: null, recovery_attempts: recovery ? Number(state.recovery_attempts || 0) + 1 : 0 });
        log('healthy', { attempt, services: state.services });
        if (monitor) startMonitor();
        return { ok: true, message: 'Trader, scanner, and dashboard are healthy', state: getState() };
      }
      await stopServices({ finalStatus: 'recovering' });
      persist({ last_failure: result.failure, failed_component: result.component });
      log('start_failed', { attempt, ...result });
      if (attempt < maxAttempts) await sleep(Math.min(10_000, attempt * 2_000));
    }
    await stopServices({ finalStatus: 'failed' });
    persist({ status: 'failed', recommended_action: 'Review workflow-supervisor.log, resolve the reported component failure, then run start again.' });
    return { ok: false, message: state.last_failure || 'Workflow failed to start', state: getState() };
  }

  async function startAttempt(attempt) {
    const traderResult = await controller.startWorkflow(WORKFLOW_SCANNER_PROFILE);
    if (!traderResult.ok) return { ok: false, component: 'trader_or_scanner', failure: traderResult.message };
    const controlState = await controller.refresh();
    if (controlState.trader?.status !== 'running') return { ok: false, component: 'trader', failure: 'Trader did not become healthy' };
    if (controlState.scanner?.status !== 'running') return { ok: false, component: 'scanner', failure: 'Scanner did not remain running' };
    if (!isFresh(scannerRuntimePath, 120_000)) return { ok: false, component: 'scanner', failure: 'Scanner heartbeat was not written' };
    persist({ services: { ...state.services, trader: serviceState(controlState.trader), scanner: serviceState(controlState.scanner) } });

    const dashboard = await ensureDashboard(attempt);
    if (!dashboard.ok) return { ok: false, component: 'dashboard', failure: dashboard.message };
    persist({ services: { ...state.services, dashboard: dashboard.service }, scanner_profile: controlState.scanner.profile });
    return { ok: true };
  }

  async function ensureDashboard(attempt) {
    const existing = readJson(dashboardRuntimePath);
    if (existing.pid && isPidAlive(existing.pid) && await urlHealthy(existing.dashboard_base_url, '/api/health')) {
      return { ok: true, service: { status: 'running', pid: existing.pid, port: existing.dashboard_port, base_url: existing.dashboard_base_url, reused: true } };
    }
    const logs = serviceLogPaths('dashboard');
    const dashboardScript = path.join(repoRoot, 'scripts', 'dashboard-cli.js');
    const command = `${process.execPath} ${dashboardScript}`;
    dashboardChild = spawnImpl(process.execPath, [dashboardScript], {
      cwd: repoRoot,
      env: { ...env, DASHBOARD_OPEN_BROWSER: 'false' },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fs.openSync(logs.out, 'a'), fs.openSync(logs.err, 'a')],
    });
    try {
      await waitForSpawn(dashboardChild);
    } catch (error) {
      const message = `Dashboard launch failed: ${command}; ${error.code || error.name}: ${error.message}; stderr: ${logs.err}`;
      log('service_launch_failed', { service: 'dashboard', command, code: error.code || null, error: error.message, log_file: logs.err });
      return { ok: false, message };
    }
    dashboardChild.unref?.();
    const deadline = Date.now() + readinessTimeoutMs;
    while (Date.now() < deadline) {
      const runtime = readJson(dashboardRuntimePath);
      if (runtime.pid === dashboardChild.pid && await urlHealthy(runtime.dashboard_base_url, '/api/health')) {
        log('service_ready', { service: 'dashboard', attempt, pid: runtime.pid, port: runtime.dashboard_port });
        return { ok: true, service: { status: 'running', pid: runtime.pid, port: runtime.dashboard_port, base_url: runtime.dashboard_base_url, reused: false } };
      }
      if (!isPidAlive(dashboardChild.pid)) return { ok: false, message: 'Dashboard exited before becoming healthy' };
      await sleep(500);
    }
    return { ok: false, message: 'Dashboard readiness check timed out' };
  }

  async function health() {
    const control = await controller.refresh();
    const runtime = readJson(dashboardRuntimePath);
    const checks = {
      trader: control.trader?.status === 'running',
      scanner: control.scanner?.status === 'running' && isFresh(scannerRuntimePath, 120_000),
      dashboard: Boolean(runtime.pid && isPidAlive(runtime.pid) && await urlHealthy(runtime.dashboard_base_url, '/api/health')),
    };
    return { ok: Object.values(checks).every(Boolean), checks, control, dashboard: runtime };
  }

  function startMonitor() {
    if (monitoring) return;
    monitoring = true;
    monitorTimer = setInterval(async () => {
      if (stopping) return;
      const result = await health();
      if (result.ok) return;
      clearInterval(monitorTimer);
      monitoring = false;
      persist({ status: 'recovering', failed_component: Object.keys(result.checks).find((key) => !result.checks[key]) });
      await stopServices({ finalStatus: 'recovering' });
      await start({ monitor: true, recovery: true });
    }, monitorIntervalMs);
    monitorTimer.unref?.();
  }

  async function stopServices({ finalStatus = 'stopped' } = {}) {
    stopping = true;
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = null;
    monitoring = false;
    const runtime = readJson(dashboardRuntimePath);
    if (runtime.pid && isPidAlive(runtime.pid)) await killTree(runtime.pid);
    if (dashboardChild?.pid && isPidAlive(dashboardChild.pid)) await killTree(dashboardChild.pid);
    await controller.stopWorkflow();
    dashboardChild = null;
    persist({ status: finalStatus, services: emptyServices(), stopped_at: nowIso() });
    stopping = false;
  }

  async function stop() {
    await stopServices({ finalStatus: 'stopped' });
    releaseProcessLock({ repoRoot, name: 'workflow-supervisor' });
    log('stopped');
    return { ok: true, message: 'Workflow stopped', state: getState() };
  }

  async function restart() {
    await stopServices({ finalStatus: 'stopped' });
    return start();
  }

  async function urlHealthy(baseUrl, route) {
    if (!baseUrl || !fetchImpl) return false;
    try { return Boolean((await fetchImpl(`${baseUrl}${route}`, { cache: 'no-store' })).ok); } catch { return false; }
  }

  function serviceLogPaths(name) {
    fs.mkdirSync(logDir, { recursive: true });
    const out = path.join(logDir, `${name}-supervised.out.log`);
    const err = path.join(logDir, `${name}-supervised.err.log`);
    rotateLog(out); rotateLog(err);
    return { out, err };
  }

  function getState() { return JSON.parse(JSON.stringify(state)); }
  return { start, stop, restart, health, getState, statePath };
}

function normalizeState(value, { maxAttempts }) {
  return { status: 'stopped', supervisor_pid: null, attempt: 0, max_attempts: maxAttempts, recovery_attempts: 0, scanner_profile: null, services: emptyServices(), last_failure: null, failed_component: null, recommended_action: null, ...(value || {}) };
}
function emptyServices() { return { trader: { status: 'stopped' }, scanner: { status: 'stopped' }, dashboard: { status: 'stopped' } }; }
function serviceState(value = {}) { return { status: value.status, pid: value.pid, port: value.port, base_url: value.base_url, started_at: value.started_at }; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function isFresh(file, maxAgeMs) { try { return Date.now() - fs.statSync(file).mtimeMs <= maxAgeMs; } catch { return false; } }
function isPidAlive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }
async function killTree(pid) {
  if (!isPidAlive(pid)) return;
  if (process.platform === 'win32') { try { await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']); return; } catch { /* fall through */ } }
  try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already stopped */ }
}
function rotateLog(file, maxBytes = 2 * 1024 * 1024) {
  try { if (fs.statSync(file).size < maxBytes) return; fs.renameSync(file, `${file}.1`); } catch { /* missing or locked log */ }
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

module.exports = { WORKFLOW_SCANNER_PROFILE, createWorkflowSupervisor, isFresh, normalizeState };
