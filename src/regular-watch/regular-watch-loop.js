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
    lastRunAt: null,
    lastError: null,
  };
  const refreshIntervalMs = Number.isFinite(Number(options.refreshIntervalMs))
    ? Number(options.refreshIntervalMs)
    : Math.max(5_000, Number(env.REGULAR_WATCH_REFRESH_SECONDS || 30) * 1000 || 30_000);

  async function refresh(runOptions = {}) {
    const runtimeState = loadRegularWatchState({
      env,
      repoRoot,
      filePath: options.statePath || resolveRegularWatchStatePath({ dataDir, repoRoot }),
    });
    const currentStatus = loadRegularWatchStatus({
      dataDir,
      filePath: options.statusPath || resolveRegularWatchStatusPath({ dataDir, repoRoot }),
    });
    const result = await runRegularWatchSources({
      env,
      fetchImpl: options.fetchImpl || globalThis.fetch,
      repoRoot,
      dataDir,
      runtimeState,
      status: currentStatus,
      timeoutMs: runOptions.timeoutMs || options.timeoutMs,
      maxSymbolsPerRun: runOptions.maxSymbolsPerRun || options.maxSymbolsPerRun,
    });
    state.lastRunAt = result.updated_at || result.generatedAt || null;
    state.lastError = result.lastError || null;
    return result;
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

module.exports = {
  createRegularWatchLoop,
};
