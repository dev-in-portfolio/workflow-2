const path = require('path');
const { loadConfig } = require('./config');
const { AlpacaTradeAdapter } = require('./alpaca-adapter');
const { PaperTradeAdapter } = require('./paper-adapter');
const { createTradingControlServer } = require('./server');
const { nowIso, resolveRepoRoot } = require('./util');
const { loadRuntimeEnv } = require('./runtime-env');
const { validateExecutionIntent } = require('./execution-mode');
const { createOvernightScanner } = require('./overnight-scanner');
const { parseSymbolList } = require('./volatile-stock-universe');
const { loadMemeMonitorState } = require('./meme-monitor-state');

function resolvePerformanceHistoryPath(env = process.env) {
  const configuredPath = String(env.PERFORMANCE_HISTORY_PATH || '').trim();
  if (configuredPath) {
    return path.resolve(resolveRepoRoot(), configuredPath);
  }
  return path.resolve(resolveRepoRoot(), 'data', 'performance-history.jsonl');
}

function resolvePolicyPath(env = process.env) {
  const configuredPath = String(env.LIVE_POLICY_PATH || '').trim();
  if (configuredPath) {
    return path.resolve(resolveRepoRoot(), configuredPath);
  }
  return path.resolve(resolveRepoRoot(), 'data', 'live-policy.json');
}

function resolvePolicyHistoryPath(env = process.env) {
  const configuredPath = String(env.POLICY_HISTORY_PATH || '').trim();
  if (configuredPath) {
    return path.resolve(resolveRepoRoot(), configuredPath);
  }
  return path.resolve(resolveRepoRoot(), 'data', 'policy-history.jsonl');
}

function buildExecutionAdapter(env = process.env, config = loadConfig(env), options = {}) {
  if (options.executionAdapter) {
    return options.executionAdapter;
  }
  validateExecutionIntent(config, env, { action: 'build-execution-adapter' });
  if (!config.ALPACA_EXECUTION_ENABLED) {
    return options.paperAdapter || new PaperTradeAdapter({ dryRun: true });
  }
  return new AlpacaTradeAdapter({
    baseUrl: config.ALPACA_API_BASE_URL || undefined,
    apiKeyId: config.ALPACA_API_KEY_ID || undefined,
    apiSecretKey: config.ALPACA_API_SECRET_KEY || undefined,
    paperTrading: !(config.TRADING_MODE === 'live' && config.LIVE_TRADING_ENABLED),
  });
}

function resolveServerPort(env = process.env) {
  const rawPort = Number(env.PORT ?? env.SERVER_PORT ?? 3000);
  return Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;
}

function listenWithFallback(server, preferredPort, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 10) || 10);
  let attempts = 0;
  let currentPort = preferredPort;
  let listening = false;

  const onListening = () => {
    listening = true;
    server.off('error', onError);
  };

  const onError = (error) => {
    if (!listening && error && error.code === 'EADDRINUSE' && attempts < maxAttempts - 1) {
      attempts += 1;
      currentPort += 1;
      server.listen(currentPort);
      return;
    }
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  };

  server.on('listening', onListening);
  server.on('error', onError);
  server.listen(currentPort);

  return server;
}

function startTradingControlServer(env = process.env, options = {}) {
  const runtimeEnv = env === process.env ? loadRuntimeEnv(env) : env;
  const config = options.config || loadConfig(runtimeEnv);
  const memeFeatureState = loadMemeMonitorState({ env: runtimeEnv, repoRoot: options.repoRoot || path.resolve(__dirname, '..') });
  const executionAdapter = buildExecutionAdapter(runtimeEnv, config, options);
  const startupPolicyPatch = options.startupPolicyPatch || {
    source: 'startup-config',
    captured_at: nowIso(),
    report_date: nowIso().slice(0, 10),
    reason_codes: ['STARTUP_CONFIG'],
    policy: {
      killSwitch: config.TRADING_MODE === 'live' ? config.KILL_SWITCH : false,
      paperAdapterEnabled: config.PAPER_ADAPTER_ENABLED,
      requireHumanApproval: config.REQUIRE_HUMAN_APPROVAL,
      minConfidenceForPaper: config.MIN_CONFIDENCE_FOR_PAPER,
      minLiquidityScore: config.MIN_LIQUIDITY_SCORE,
      minProviderConfirmationScore: config.MIN_PROVIDER_CONFIRMATION_SCORE,
      minCryptoProviderConfirmationScore: config.MIN_CRYPTO_PROVIDER_CONFIRMATION_SCORE,
      minSellProviderConfirmationScore: config.MIN_SELL_PROVIDER_CONFIRMATION_SCORE,
      sellMaxProviderPriceDiffPct: config.SELL_MAX_PROVIDER_PRICE_DIFF_PCT,
      maxSpreadSlippagePct: config.MAX_SPREAD_SLIPPAGE_PCT,
      minEdgeScore: config.MIN_EDGE_SCORE,
      blockedCalibrationBuckets: [],
      blockedBuyCalibrationBuckets: [],
      blockBuys: config.BLOCK_BUYS,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minVolume: config.MIN_VOLUME,
      maxOpenPositions: config.MAX_OPEN_POSITIONS,
      positionSizeMultiplier: 1,
      buyNotionalTarget: config.BUY_NOTIONAL_TARGET,
      minBuyNotional: config.MIN_BUY_NOTIONAL,
      volatilityThresholdPct: null,
      approvedSymbols: parseSymbolList(runtimeEnv.STOCK_SCANNER_SYMBOLS, []),
      positionStopLossDollars: Number(runtimeEnv.POSITION_STOP_LOSS_DOLLARS || config.POSITION_STOP_LOSS_DOLLARS || 1),
      positionStopLossNotionalPct: Number(runtimeEnv.POSITION_STOP_LOSS_NOTIONAL_PCT || config.POSITION_STOP_LOSS_NOTIONAL_PCT || 0.75),
      positionStopLossMaxDollars: Number(runtimeEnv.POSITION_STOP_LOSS_MAX_DOLLARS || config.POSITION_STOP_LOSS_MAX_DOLLARS || 2.5),
      trailingProfitStartDollars: Number(runtimeEnv.TRAILING_PROFIT_START_DOLLARS || config.TRAILING_PROFIT_START_DOLLARS || 0.5),
      trailingProfitGivebackDollars: Number(runtimeEnv.TRAILING_PROFIT_GIVEBACK_DOLLARS || config.TRAILING_PROFIT_GIVEBACK_DOLLARS || 0.3),
    },
  };
  const server = createTradingControlServer({
    ...options.serverOptions,
    executionAdapter,
    performanceHistoryPath: options.performanceHistoryPath || resolvePerformanceHistoryPath(runtimeEnv),
    policyPath: options.policyPath || resolvePolicyPath(runtimeEnv),
    policyHistoryPath: options.policyHistoryPath || resolvePolicyHistoryPath(runtimeEnv),
    startupPolicyPatch,
    buyNotionalTarget: config.BUY_NOTIONAL_TARGET,
    minBuyNotional: config.MIN_BUY_NOTIONAL,
    autoPolicyRefresh: config.AUTO_POLICY_REFRESH,
    autoPolicyRefreshMinBlockedCount: config.AUTO_POLICY_REFRESH_MIN_BLOCKED_COUNT,
    autoPolicyRefreshMinRejectionPressureScore: config.AUTO_POLICY_REFRESH_MIN_REJECTION_PRESSURE_SCORE,
    autoPolicyRefreshMinPaperOutcomes: config.AUTO_POLICY_REFRESH_MIN_PAPER_OUTCOMES,
  });
  const port = options.port ?? resolveServerPort(runtimeEnv);
  let overnightScanner = null;

  server.on('listening', () => {
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    if (options.startOvernightScanner && !overnightScanner) {
      overnightScanner = createOvernightScanner({
        env: runtimeEnv,
        apiKeyId: config.ALPACA_API_KEY_ID,
        apiSecretKey: config.ALPACA_API_SECRET_KEY,
      baseUrl: runtimeEnv.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets',
      localBaseUrl: `http://127.0.0.1:${resolvedPort}`,
      enabled: true,
      symbols: options.overnightScannerSymbols,
        intervalMs: options.overnightScannerIntervalMs || 30_000,
        cooldownMs: options.overnightScannerCooldownMs || 5 * 60_000,
        minMovePct: options.overnightScannerMinMovePct || 0.05,
        maxSpreadPct: options.overnightScannerMaxSpreadPct || 1.0,
        maxCandidatesPerRun: options.overnightScannerMaxCandidatesPerRun || 12,
        notional: options.overnightScannerNotional,
        sellProfitThresholdPct: options.overnightScannerSellProfitThresholdPct || 5.0,
        logger: options.logger,
      });
      overnightScanner.start();
    }
    process.stdout.write(`${JSON.stringify({
      status: 'listening',
      port: resolvedPort,
      mode: config.TRADING_MODE,
      alpaca_execution_enabled: config.ALPACA_EXECUTION_ENABLED,
      meme_monitor: memeFeatureState.summary?.master_enabled ? 'enabled' : 'disabled',
      meme_feature_state_source: memeFeatureState.source || 'env + runtime state',
      meme_blocked_features: memeFeatureState.blocked_features || [],
      performance_history_path: options.performanceHistoryPath || resolvePerformanceHistoryPath(runtimeEnv),
      policy_path: options.policyPath || resolvePolicyPath(runtimeEnv),
      policy_history_path: options.policyHistoryPath || resolvePolicyHistoryPath(runtimeEnv),
      timestamp: nowIso(),
    })}\n`);
  });
  listenWithFallback(server, port, { maxAttempts: options.maxPortAttempts || 10 });
  server.on('close', () => {
    overnightScanner?.stop();
  });
  return server;
}

if (require.main === module) {
  startTradingControlServer();
}

module.exports = {
  buildExecutionAdapter,
  resolvePerformanceHistoryPath,
  resolvePolicyHistoryPath,
  resolvePolicyPath,
  resolveServerPort,
  listenWithFallback,
  startTradingControlServer,
};
