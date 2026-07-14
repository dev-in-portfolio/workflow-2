const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { AlpacaTradeAdapter } = require('./alpaca-adapter');
const { PaperTradeAdapter } = require('./paper-adapter');
const { createMinimalTradingServer } = require('./minimal-server');
const { nowIso, resolveRepoRoot } = require('./util');
const { loadRuntimeEnv } = require('./runtime-env');
const { validateExecutionIntent } = require('./execution-mode');
const { parseSymbolList } = require('./volatile-stock-universe');

function resolvePerformanceHistoryPath(env = process.env) {
  const configuredPath = String(env.PERFORMANCE_HISTORY_PATH || '').trim();
  return configuredPath ? path.resolve(resolveRepoRoot(), configuredPath) : path.resolve(resolveRepoRoot(), 'data', 'performance-history.jsonl');
}

function resolvePolicyPath(env = process.env) {
  const configuredPath = String(env.LIVE_POLICY_PATH || '').trim();
  return configuredPath ? path.resolve(resolveRepoRoot(), configuredPath) : path.resolve(resolveRepoRoot(), 'data', 'live-policy.json');
}

function resolvePolicyHistoryPath(env = process.env) {
  const configuredPath = String(env.POLICY_HISTORY_PATH || '').trim();
  return configuredPath ? path.resolve(resolveRepoRoot(), configuredPath) : path.resolve(resolveRepoRoot(), 'data', 'policy-history.jsonl');
}

function resolveStatusSnapshotPath(env = process.env) {
  const configuredPath = String(env.OVERNIGHT_STATUS_PATH || env.STATUS_SNAPSHOT_PATH || '').trim();
  return configuredPath ? path.resolve(resolveRepoRoot(), configuredPath) : path.resolve(resolveRepoRoot(), 'data', 'logs', 'overnight-status.json');
}

function resolveStatusHeartbeatIntervalMs(env = process.env) {
  const raw = Number(env.OVERNIGHT_STATUS_HEARTBEAT_MS ?? env.STATUS_HEARTBEAT_MS ?? 300000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 300000;
}

function readExistingPolicySnapshot(policyPath) {
  if (!policyPath) return null;
  try {
    if (!fs.existsSync(policyPath)) return null;
    const raw = fs.readFileSync(policyPath, 'utf8');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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

function startMinimalTradingServer(env = process.env, options = {}) {
  const runtimeEnv = env === process.env ? loadRuntimeEnv(env) : env;
  const config = options.config || loadConfig(runtimeEnv);
  const executionAdapter = buildExecutionAdapter(runtimeEnv, config, options);
  const startedAt = nowIso();
  const policyPath = options.policyPath || resolvePolicyPath(runtimeEnv);
  const existingPolicySnapshot = options.startupPolicyPatch ? null : readExistingPolicySnapshot(policyPath);
  const operationalPolicyPatch = {
    source: existingPolicySnapshot?.source || 'startup-config',
    captured_at: nowIso(),
    report_date: nowIso().slice(0, 10),
    reason_codes: [...new Set([...(existingPolicySnapshot?.reason_codes || []), 'RUNTIME_MODE_AUTHORITATIVE'])],
    policy: {
      requireHumanApproval: config.REQUIRE_HUMAN_APPROVAL,
      maxSpreadSlippagePct: config.MAX_SPREAD_SLIPPAGE_PCT,
      tradingMode: config.TRADING_MODE,
      liveTradingEnabled: config.LIVE_TRADING_ENABLED,
      executionMode: config.TRADING_MODE === 'live' && config.LIVE_TRADING_ENABLED ? 'live' : 'paper',
    },
  };
  const startupPolicyPatch = options.startupPolicyPatch || (!existingPolicySnapshot ? {
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
      sellProfitThresholdPct: Number(runtimeEnv.OVERNIGHT_SCANNER_SELL_PROFIT_THRESHOLD_PCT || runtimeEnv.STOCK_SCANNER_SELL_PROFIT_THRESHOLD_PCT || 5),
      sellNetProfitFloorDollars: Number(runtimeEnv.SELL_NET_PROFIT_FLOOR_DOLLARS || runtimeEnv.OVERNIGHT_SCANNER_SELL_NET_PROFIT_FLOOR_DOLLARS || 1),
      tradingMode: config.TRADING_MODE,
      liveTradingEnabled: config.LIVE_TRADING_ENABLED,
      executionMode: config.TRADING_MODE === 'live' && config.LIVE_TRADING_ENABLED ? 'live' : 'paper',
    },
  } : operationalPolicyPatch);
  const server = createMinimalTradingServer({
    ...options.serverOptions,
    executionAdapter,
    performanceHistoryPath: options.performanceHistoryPath || resolvePerformanceHistoryPath(runtimeEnv),
    policyPath,
    policyHistoryPath: options.policyHistoryPath || resolvePolicyHistoryPath(runtimeEnv),
    statusSnapshotPath: options.statusSnapshotPath || resolveStatusSnapshotPath(runtimeEnv),
    statusHeartbeatIntervalMs: options.statusHeartbeatIntervalMs ?? resolveStatusHeartbeatIntervalMs(runtimeEnv),
    buyNotionalTarget: config.BUY_NOTIONAL_TARGET,
    minBuyNotional: config.MIN_BUY_NOTIONAL,
    startedAt,
    startupPolicyPatch,
    confirmationAttempts: options.confirmationAttempts || 6,
    confirmationDelayMs: options.confirmationDelayMs || 500,
    confirmationMaxDelayMs: options.confirmationMaxDelayMs || 1500,
  });
  const port = options.port ?? resolveServerPort(runtimeEnv);

  server.listen(port, () => {
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : port;
    process.stdout.write(`${JSON.stringify({
      status: 'listening',
      port: resolvedPort,
      mode: config.TRADING_MODE,
      alpaca_execution_enabled: config.ALPACA_EXECUTION_ENABLED,
      performance_history_path: options.performanceHistoryPath || resolvePerformanceHistoryPath(runtimeEnv),
      policy_path: options.policyPath || resolvePolicyPath(runtimeEnv),
      policy_history_path: options.policyHistoryPath || resolvePolicyHistoryPath(runtimeEnv),
      status_snapshot_path: options.statusSnapshotPath || resolveStatusSnapshotPath(runtimeEnv),
      status_heartbeat_ms: options.statusHeartbeatIntervalMs ?? resolveStatusHeartbeatIntervalMs(runtimeEnv),
      started_at: startedAt,
      request_count: 0,
      heartbeat_count: 0,
      last_request_at: null,
      timestamp: nowIso(),
    })}\n`);
  });

  return server;
}

if (require.main === module) {
  startMinimalTradingServer();
}

module.exports = {
  buildExecutionAdapter,
  resolvePerformanceHistoryPath,
  resolvePolicyHistoryPath,
  resolvePolicyPath,
  resolveStatusSnapshotPath,
  resolveStatusHeartbeatIntervalMs,
  resolveServerPort,
  startMinimalTradingServer,
};
