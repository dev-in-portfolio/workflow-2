const path = require('path');
const { resolveRepoRoot } = require('../util');
const { loadRegularWatchState, resolveRegularWatchStatePath } = require('./regular-watch-feature-state');
const { loadRegularWatchStatus, resolveRegularWatchStatusPath } = require('./regular-watch-status');
const { runRegularWatchSources } = require('./regular-watch-source-runner');

function createRegularWatchLoop(options = {}) {
  const env = options.env || process.env;
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const dataDir = options.dataDir || path.resolve(repoRoot, 'data');
  const state = {
    running: false,
    timer: null,
    inFlight: false,
    lastRunAt: null,
    lastError: null,
    lastSkippedAt: null,
    lastSkipReason: null,
    nextRetryAt: null,
  };
  const refreshIntervalMs = Number.isFinite(Number(options.refreshIntervalMs))
    ? Number(options.refreshIntervalMs)
    : Math.max(5_000, Number(env.REGULAR_WATCH_REFRESH_SECONDS || 30) * 1000 || 30_000);

  async function refresh(runOptions = {}) {
    const nowMs = Date.now();
    if (state.inFlight) {
      state.lastSkippedAt = new Date(nowMs).toISOString();
      state.lastSkipReason = 'refresh_in_flight';
      return loadCurrentStatus();
    }
    const nextRetryMs = state.nextRetryAt ? new Date(state.nextRetryAt).getTime() : 0;
    if (!runOptions.force && Number.isFinite(nextRetryMs) && nextRetryMs > nowMs) {
      state.lastSkippedAt = new Date(nowMs).toISOString();
      state.lastSkipReason = 'rate_limit_cooldown';
      return loadCurrentStatus();
    }
    state.inFlight = true;
    const runtimeState = loadRegularWatchState({
      env,
      repoRoot,
      filePath: options.statePath || resolveRegularWatchStatePath({ dataDir, repoRoot }),
    });
    const currentStatus = loadRegularWatchStatus({
      dataDir,
      filePath: options.statusPath || resolveRegularWatchStatusPath({ dataDir, repoRoot }),
    });
    try {
      const result = await (options.runRegularWatchSources || runRegularWatchSources)({
        env,
        fetchImpl: options.fetchImpl || globalThis.fetch,
        repoRoot,
        dataDir,
        runtimeState,
        status: currentStatus,
        timeoutMs: runOptions.timeoutMs || options.timeoutMs,
        maxSymbolsPerRun: runOptions.maxSymbolsPerRun || options.maxSymbolsPerRun,
      });
      const alpacaMarket = findAlpacaMarketStatus(result);
      state.lastRunAt = result.updated_at || result.generatedAt || null;
      state.lastError = result.lastError || null;
      state.nextRetryAt = String(alpacaMarket?.status || '').toLowerCase() === 'rate_limited'
        || alpacaMarket?.blockedReason === 'rate_limited'
        ? (alpacaMarket.nextRetryAt || alpacaMarket.retryAfterAt || null)
        : null;
      state.lastSkipReason = null;
      return result;
    } finally {
      state.inFlight = false;
    }
  }

  function loadCurrentStatus() {
    return loadRegularWatchStatus({
      dataDir,
      filePath: options.statusPath || resolveRegularWatchStatusPath({ dataDir, repoRoot }),
    });
  }

  async function start() {
    state.running = true;
    clearTimer();
    const result = await refresh({ reason: 'start' });
    state.timer = setInterval(() => {
      refresh({ reason: 'interval' }).catch((error) => {
        state.lastError = error.message;
      });
    }, refreshIntervalMs);
    if (state.timer.unref) state.timer.unref();
    return result;
  }

  async function stop() {
    state.running = false;
    clearTimer();
    return loadRegularWatchStatus({
      dataDir,
      filePath: options.statusPath || resolveRegularWatchStatusPath({ dataDir, repoRoot }),
    });
  }

  function clearTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  return {
    start,
    stop,
    refresh,
    getState: () => ({ ...state }),
    isRunning: () => state.running,
  };
}

function findAlpacaMarketStatus(result = {}) {
  const sources = result.sources || result.regularWatchIntelligence?.sources || [];
  return (Array.isArray(sources) ? sources : []).find((source) => source?.source === 'alpacaMarket') || null;
}

module.exports = {
  createRegularWatchLoop,
};
