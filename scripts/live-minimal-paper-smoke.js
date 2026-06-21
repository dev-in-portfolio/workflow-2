const fs = require('fs');
const { AlpacaTradeAdapter, PerformanceStore, processTradingSignal } = require('../src');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { nowIso } = require('../src/util');

function loadEnvFile(filePath) {
  const env = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }
  return env;
}

async function main() {
  const env = loadRuntimeEnv(fs.existsSync('.env.local') ? loadEnvFile('.env.local') : process.env);
  const performance = new PerformanceStore();
  performance.setPolicySnapshot({
    source: 'smoke',
    captured_at: nowIso(),
    report_date: nowIso().slice(0, 10),
    policy: {
      killSwitch: false,
      paperAdapterEnabled: true,
      requireHumanApproval: true,
      minConfidenceForPaper: 72,
      minFreshnessScore: 55,
      minSourceQualityScore: 40,
      minProviderConfirmationScore: 70,
      minEdgeScore: 60,
      minLiquidityScore: 40,
      minVolume: 1000,
      maxContradictionScore: 50,
      maxRiskScore: 70,
      maxOpenPositions: 5,
      positionSizeMultiplier: 1,
    },
  });

  const executionAdapter = new AlpacaTradeAdapter({
    baseUrl: env.ALPACA_API_BASE_URL,
    apiKeyId: env.ALPACA_API_KEY_ID,
    apiSecretKey: env.ALPACA_API_SECRET_KEY,
    paperTrading: true,
  });

  const timestamp = nowIso();
  const result = await processTradingSignal({
    signal: {
      signal_id: `smoke-${Date.now()}`,
      symbol: 'SOFI',
      asset_type: 'stock',
      strategy_name: 'minimal-v1-smoke',
      timeframe: '5m',
      direction: 'bullish',
      action_candidate: 'paper_buy',
      side: 'buy',
      quantity: 1,
      confidence_score: 95,
      freshness_score: 95,
      source_quality_score: 95,
      contradiction_score: 5,
      risk_score: 10,
      provider_confirmation_score: 95,
      edge_score: 90,
      stop_loss: 17.23,
      take_profit: 18.83,
      entry_price: 17.76,
      price: 17.76,
      volume: 100000,
      created_at: timestamp,
      market_context: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'SOFI',
          asset_type: 'stock',
          timestamp,
          received_at: timestamp,
          price: 17.76,
          volume: 100000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'SOFI',
          asset_type: 'stock',
          timestamp,
          received_at: timestamp,
          price: 17.78,
          volume: 100050,
        },
      },
    },
    portfolio: {
      trade_count_today: 0,
      daily_loss: 0,
      position_notional: 0,
      available: true,
      open_positions_count: 0,
    },
  }, {
    executionAdapter,
    performance,
    policySnapshot: performance.getPolicySnapshot(),
    source: 'smoke',
    confirmationAttempts: 6,
    confirmationDelayMs: 500,
    confirmationMaxDelayMs: 1500,
    marketContext: {
        alpaca_quote: {
          provider: 'alpaca',
          symbol: 'SOFI',
          asset_type: 'stock',
          timestamp,
          received_at: timestamp,
          price: 17.76,
          volume: 100000,
        },
        twelve_data_quote: {
          provider: 'twelvedata',
          symbol: 'SOFI',
          asset_type: 'stock',
          timestamp,
          received_at: timestamp,
          price: 17.78,
          volume: 100050,
        },
    },
  });

  process.stdout.write(`${JSON.stringify({
    accepted: result.accepted,
    stage: result.stage,
    order_id: result.paperOrder?.order_id || null,
    broker_status: result.confirmation?.confirmation_status || null,
    confirmed: result.confirmation?.confirmed || false,
    paper_result_status: result.paperResult?.status || null,
    paper_outcome_status: result.paperOutcome?.paper_result?.status || null,
    paper_outcome_win_loss: result.paperOutcome?.win_loss || null,
    timestamp: nowIso(),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
