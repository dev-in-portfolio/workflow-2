const { createStockScanner } = require('./stock-scanner');
const { createOvernightScanner } = require('./overnight-scanner');
const { loadRuntimeEnv } = require('./runtime-env');
const { nowIso } = require('./util');
const { resolveMarketRegime } = require('./market-hours');
const { resolveRotatingStockSymbols } = require('./volatile-stock-universe');

function createMarketAwareScanner(options = {}) {
  const env = options.env || process.env;
  const runtimeEnv = env === process.env ? loadRuntimeEnv(env) : env;
  const localBaseUrl = String(options.localBaseUrl || options.local_url || '').trim();
  if (!localBaseUrl) {
    throw new Error('Market-aware scanner requires a local base URL');
  }

  const state = {
    timer: null,
    activeScanner: null,
    activeRegime: null,
    lastSwitchAt: null,
  };

  const switchPollMs = Math.max(15_000, Number(options.switchPollMs ?? 60_000) || 60_000);
  const keepAlive = options.keepAlive ?? true;
  const stockSellProfitThresholdPct = resolveThreshold(
    options.stockSellProfitThresholdPct,
    runtimeEnv.STOCK_SCANNER_SELL_PROFIT_THRESHOLD_PCT,
    5.0,
  );
  const overnightSellProfitThresholdPct = resolveThreshold(
    options.overnightSellProfitThresholdPct,
    runtimeEnv.OVERNIGHT_SCANNER_SELL_PROFIT_THRESHOLD_PCT,
    5.0,
  );
  const stockSymbols = options.stockSymbols
    || resolveRotatingStockSymbols(runtimeEnv.STOCK_SCANNER_SYMBOLS || env.STOCK_SCANNER_SYMBOLS);
  const overnightSymbols = options.overnightSymbols || runtimeEnv.OVERNIGHT_SCANNER_SYMBOLS || env.OVERNIGHT_SCANNER_SYMBOLS;

  function buildStockScanner() {
    return (options.stockScannerFactory || createStockScanner)({
      env: runtimeEnv,
      localBaseUrl,
      enabled: true,
      keepAlive: true,
      symbols: stockSymbols,
      intervalMs: options.stockIntervalMs || 30_000,
      cooldownMs: options.stockCooldownMs || 4 * 60_000,
      minMovePct: options.stockMinMovePct || 0.35,
      maxSpreadPct: options.stockMaxSpreadPct || 1.5,
      maxCandidatesPerRun: options.stockMaxCandidatesPerRun || 8,
      notional: Number(runtimeEnv.BUY_NOTIONAL_TARGET || 200),
      sellProfitThresholdPct: stockSellProfitThresholdPct,
      allowContrarianEntries: true,
      logger: options.logger,
    });
  }

  function buildOvernightScanner() {
    return (options.overnightScannerFactory || createOvernightScanner)({
      env: runtimeEnv,
      localBaseUrl,
      enabled: true,
      keepAlive: true,
      symbols: overnightSymbols,
      intervalMs: options.overnightIntervalMs || 15_000,
      cooldownMs: options.overnightCooldownMs || 90_000,
      minMovePct: options.overnightMinMovePct || 0.01,
      maxSpreadPct: options.overnightMaxSpreadPct || 1.0,
      maxCandidatesPerRun: options.overnightMaxCandidatesPerRun || 4,
      notional: Number(runtimeEnv.BUY_NOTIONAL_TARGET || 200),
      sellProfitThresholdPct: overnightSellProfitThresholdPct,
      sellNetProfitFloorDollars: Number(runtimeEnv.SELL_NET_PROFIT_FLOOR_DOLLARS || runtimeEnv.OVERNIGHT_SCANNER_SELL_NET_PROFIT_FLOOR_DOLLARS || 1),
      sellLossThresholdPct: Number(runtimeEnv.OVERNIGHT_SCANNER_SELL_LOSS_EXIT_THRESHOLD_PCT || 0.75),
      allowContrarianEntries: true,
      logger: options.logger,
    });
  }

  function buildScannerForRegime(regime) {
    return regime === 'stocks' ? buildStockScanner() : buildOvernightScanner();
  }

  function activateRegime(regime) {
    if (state.activeRegime === regime && state.activeScanner) return state.activeScanner;
    if (state.activeScanner?.stop) state.activeScanner.stop();
    state.activeScanner = buildScannerForRegime(regime);
    state.activeRegime = regime;
    state.lastSwitchAt = nowIso();
    state.activeScanner.start?.();
    return state.activeScanner;
  }

  function refreshRegime(now = options.nowProvider ? options.nowProvider() : new Date()) {
    return activateRegime(resolveMarketRegime(now));
  }

  async function runOnce(runOptions = {}) {
    const scanner = refreshRegime();
    if (typeof scanner.runOnce !== 'function') {
      return { accepted: false, reason: 'ACTIVE_SCANNER_MISSING_RUN_ONCE', regime: state.activeRegime };
    }
    const result = await scanner.runOnce(runOptions);
    return { ...result, regime: state.activeRegime };
  }

  function start() {
    if (state.timer) return controller;
    refreshRegime();
    state.timer = setInterval(() => {
      try {
        refreshRegime();
      } catch (error) {
        if (typeof options.logger === 'function') {
          options.logger({ level: 'error', event: 'market_regime_switch_error', message: error.message });
        }
      }
    }, switchPollMs);
    if (!keepAlive) state.timer.unref?.();
    return controller;
  }

  function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    if (state.activeScanner?.stop) state.activeScanner.stop();
    state.activeScanner = null;
    state.activeRegime = null;
  }

  const controller = {
    start,
    stop,
    runOnce,
    refreshRegime,
    state,
    config: {
      localBaseUrl,
      switchPollMs,
      stockSymbols,
      overnightSymbols,
      stockSellProfitThresholdPct,
      overnightSellProfitThresholdPct,
    },
  };

  return controller;
}

function resolveThreshold(optionValue, envValue, fallback) {
  const parsed = Number(optionValue ?? envValue ?? fallback);
  return Math.max(5.0, Number.isFinite(parsed) ? parsed : fallback);
}

module.exports = {
  createMarketAwareScanner,
};
