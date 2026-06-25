const path = require('path');
const { spawn } = require('child_process');
const { loadRuntimeEnv } = require('./runtime-env');
const { DEFAULT_DASHBOARD_PORT } = require('./dashboard-server');
const { getNewYorkMarketParts, isRegularUsMarketHours } = require('./market-hours');
const { isUsMarketHoliday } = require('./us-market-holidays');
const { nowIso } = require('./util');

const DASHBOARD_PROBE_LIMIT = 12;

function isUsMarketWeekday(date = new Date()) {
  const parts = getNewYorkMarketParts(date);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday || '');
}

function resolveAutomationAction(input = {}) {
  const raw = String(input.action || input.mode || input.command || '').trim().toLowerCase();
  if (raw === 'start' || raw === 'stop') {
    return raw;
  }
  return null;
}

async function runLiveMarketDailyAutomation(options = {}) {
  const env = options.env || process.env;
  const runtimeEnv = options.runtimeEnv || loadRuntimeEnv(env, options.repoRoot || process.cwd());
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const logger = options.logger || console;
  const action = resolveAutomationAction(options) || 'start';
  const now = options.now || new Date();

  if (!fetchImpl) {
    throw new Error('Fetch support is required for dashboard automation');
  }

  const marketState = {
    timestamp: nowIso(),
    weekday: getNewYorkMarketParts(now).weekday,
    holiday: isUsMarketHoliday(now),
    regular_us_market_hours: isRegularUsMarketHours(now),
  };

  if (action === 'start' && (!isUsMarketWeekday(now) || marketState.holiday)) {
    return {
      ok: true,
      action,
      skipped: true,
      reason: marketState.holiday ? 'us_market_holiday' : 'not_a_us_market_weekday',
      market_state: marketState,
    };
  }

  let dashboard = await findDashboard({ env: runtimeEnv, fetchImpl });
  if (!dashboard) {
    dashboard = await launchDashboardAndWait({ env: runtimeEnv, repoRoot, fetchImpl, spawnImpl, logger });
  }

  if (!dashboard) {
    return {
      ok: false,
      action,
      skipped: false,
      reason: 'dashboard_unreachable',
      market_state: marketState,
    };
  }

  const before = await readDashboardState(dashboard.baseUrl, fetchImpl);
  const requestedAction = action === 'stop' ? 'stop-workflow' : 'start-workflow';
  let actionResult = null;

  if (before.control?.workflow?.status !== (action === 'stop' ? 'stopped' : 'running')) {
    actionResult = await postControlAction(dashboard.baseUrl, requestedAction, 'live-market', fetchImpl);
  } else {
    actionResult = {
      ok: true,
      action: requestedAction,
      message: action === 'stop' ? 'Workflow already stopped' : 'Workflow already running',
      verified: true,
      response: before,
    };
  }

  const after = await readDashboardState(dashboard.baseUrl, fetchImpl);
  const summary = buildAutomationSummary({
    action,
    marketState,
    dashboard: dashboard.baseUrl,
    before,
    after,
    actionResult,
  });

  if (logger && typeof logger.log === 'function') {
    logger.log(formatAutomationSummary(summary));
  }

  return summary;
}

async function findDashboard({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const candidates = dashboardCandidates(env);
  for (const baseUrl of candidates) {
    const probe = await probeDashboard(baseUrl, fetchImpl);
    if (probe.ok) {
      return { baseUrl };
    }
  }
  return null;
}

async function launchDashboardAndWait({ env = process.env, repoRoot = process.cwd(), fetchImpl = globalThis.fetch, spawnImpl = spawn, logger = console } = {}) {
  const dashboardCli = path.join(repoRoot, 'scripts', 'dashboard-cli.js');
  const child = spawnImpl(process.execPath, [dashboardCli], {
    cwd: repoRoot,
    env: {
      ...loadRuntimeEnv(env, repoRoot),
      DASHBOARD_OPEN_BROWSER: 'false',
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (child.unref) child.unref();

  if (logger && typeof logger.log === 'function') {
    logger.log(`Dashboard not reachable; launched local dashboard helper pid ${child.pid || 'unknown'}.`);
  }

  const deadlines = Date.now() + 15_000;
  while (Date.now() < deadlines) {
    const dashboard = await findDashboard({ env, fetchImpl });
    if (dashboard) {
      return dashboard;
    }
    await sleep(500);
  }
  return null;
}

async function probeDashboard(baseUrl, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/api/health`, {
      method: 'GET',
      cache: 'no-store',
    });
    if (!response.ok) {
      return { ok: false, baseUrl, status: response.status };
    }
    return { ok: true, baseUrl };
  } catch (error) {
    return { ok: false, baseUrl, error: error.message };
  }
}

async function readDashboardState(baseUrl, fetchImpl = globalThis.fetch) {
  const [control, snapshot] = await Promise.all([
    fetchJson(fetchImpl, `${trimTrailingSlash(baseUrl)}/api/control/state`),
    fetchJson(fetchImpl, `${trimTrailingSlash(baseUrl)}/api/snapshot`),
  ]);
  return { control, snapshot };
}

async function postControlAction(baseUrl, action, profile, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/api/control/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, profile }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      action,
      error: payload?.error || `HTTP_${response.status}`,
      message: payload?.message || `Control action failed: ${response.status}`,
      payload,
    };
  }
  return payload;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `HTTP_${response.status}`);
  }
  return payload;
}

function dashboardCandidates(env = process.env) {
  const base = [];
  const explicit = String(env.DASHBOARD_BASE_URL || env.DASHBOARD_URL || '').trim();
  if (explicit) {
    base.push(explicit);
  }
  const preferredPort = Number(env.TRADER_DASHBOARD_PORT || env.DASHBOARD_PORT || DEFAULT_DASHBOARD_PORT);
  const firstPort = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DASHBOARD_PORT;
  for (let offset = 0; offset < DASHBOARD_PROBE_LIMIT; offset += 1) {
    base.push(`http://127.0.0.1:${firstPort + offset}`);
  }
  return [...new Set(base)];
}

function buildAutomationSummary({ action, marketState, dashboard, before, after, actionResult }) {
  const control = after.control || before.control || {};
  const snapshot = after.snapshot || before.snapshot || {};
  const regime = snapshot.regime || {};
  const summary = snapshot.summary || {};
  const live = snapshot.live || {};
  const positions = Array.isArray(live.open_positions)
    ? live.open_positions
    : Array.isArray(live.positions)
      ? live.positions
      : [];
  const warnings = buildWarnings({ action, control, snapshot, actionResult, marketState });

  return {
    ok: Boolean(actionResult?.ok),
    action,
    dashboard_url: dashboard,
    market_state: marketState,
    workflow_state: control.workflow?.status || null,
    trader: {
      status: control.trader?.status || null,
      pid: control.trader?.pid || null,
      managed: control.trader?.managed ?? null,
      port: control.trader?.port || null,
    },
    scanner: {
      status: control.scanner?.status || null,
      pid: control.scanner?.pid || null,
      profile: control.scanner?.profile || control.workflow?.desired_scanner_profile || null,
      managed: control.scanner?.managed ?? null,
      script: control.scanner?.script || null,
    },
    config: {
      approved_symbols: regime.approved_symbols || snapshot.dashboard?.approved_symbols || [],
      max_open_positions: regime.max_open_positions ?? summary.max_open_positions ?? null,
      buy_notional_target: regime.buy_notional_target ?? summary.buy_notional_target ?? null,
      min_buy_notional: regime.min_buy_notional ?? summary.min_buy_notional ?? null,
    },
    account: {
      buying_power: summary.account_buying_power ?? live.account?.buying_power ?? null,
      daily_change: summary.daily_change ?? null,
    },
    open_positions: positions.map(formatPosition),
    warnings,
    action_result: {
      ok: Boolean(actionResult?.ok),
      message: actionResult?.message || null,
      error: actionResult?.error || null,
      verified: actionResult?.verified ?? null,
    },
  };
}

function buildWarnings({ action, control, snapshot, actionResult, marketState }) {
  const warnings = [];
  const scanner = control.scanner || {};
  const regime = snapshot.regime || {};

  if (actionResult && !actionResult.ok) {
    warnings.push(actionResult.message || actionResult.error || 'Action failed');
  }
  if (scanner.multiple_running) {
    warnings.push('Multiple scanner processes are still present.');
  }
  if (action === 'start' && scanner.profile && scanner.profile !== 'live-market') {
    warnings.push(`Unexpected scanner profile: ${scanner.profile}`);
  }
  if (action === 'start' && marketState.regular_us_market_hours === false) {
    warnings.push('Market is not open yet; market-open protections should remain active.');
  }
  if (regime.approved_symbols && Array.isArray(regime.approved_symbols) && !regime.approved_symbols.length) {
    warnings.push('Approved symbol list is empty.');
  }
  return warnings;
}

function formatPosition(position) {
  if (!position || typeof position !== 'object') {
    return { symbol: null, quantity: null, market_value: null, unrealized_pl: null };
  }
  return {
    symbol: position.symbol || null,
    quantity: position.quantity ?? position.net_quantity ?? position.qty ?? null,
    market_value: position.market_value ?? position.marketValue ?? null,
    unrealized_pl: position.unrealized_pl ?? position.unrealizedPnl ?? position.unrealized_intraday_pl ?? null,
  };
}

function formatAutomationSummary(summary) {
  const lines = [];
  lines.push(`Dashboard: ${summary.dashboard_url}`);
  lines.push(`Workflow: ${summary.workflow_state || '-'}`);
  lines.push(`Trader: ${summary.trader.status || '-'}${summary.trader.pid ? ` (pid ${summary.trader.pid})` : ''}`);
  lines.push(`Scanner: ${summary.scanner.status || '-'}${summary.scanner.pid ? ` (pid ${summary.scanner.pid})` : ''}${summary.scanner.profile ? ` [${summary.scanner.profile}]` : ''}`);
  lines.push(`Approved symbols: ${(summary.config.approved_symbols || []).join(', ') || '-'}`);
  lines.push(`Open positions: ${summary.open_positions.length ? summary.open_positions.map((position) => `${position.symbol || '?'}${position.quantity !== null ? ` x${position.quantity}` : ''}`).join('; ') : 'none'}`);
  lines.push(`Buying power: ${summary.account.buying_power ?? '-'}`);
  lines.push(`Daily change: ${summary.account.daily_change ?? '-'}`);
  if (summary.warnings.length) {
    lines.push(`Warnings: ${summary.warnings.join(' | ')}`);
  }
  return lines.join('\n');
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildAutomationSummary,
  dashboardCandidates,
  findDashboard,
  formatAutomationSummary,
  formatPosition,
  isUsMarketWeekday,
  launchDashboardAndWait,
  postControlAction,
  probeDashboard,
  readDashboardState,
  resolveAutomationAction,
  runLiveMarketDailyAutomation,
};
