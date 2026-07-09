const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const {
  buildStockCandidateForSymbol,
  calculateEffectiveStopLossDollars,
  calculateSpreadRankPenalty,
  createStockScanner,
  buildScannerConfig,
  normalizeRecentTradePenaltyMap,
  rankScannerBuyCandidates,
  resolveScannerWatchConfig,
} = require('../src');
const { APPROVED_LIVE_MARKET_SYMBOLS } = require('../src/volatile-stock-universe');
const { updateMemeMonitorFeatureState } = require('../src/meme-monitor-state');

test('stock scanner builds real buy candidates from fresh bullish Alpaca data', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', {
    latestQuote: {
      bp: 17.60,
      ap: 17.66,
      t: '2026-06-16T20:00:00.000Z',
    },
    latestTrade: {
      p: 17.63,
      t: '2026-06-16T20:00:00.000Z',
    },
    minuteBar: {
      v: 42,
      h: 17.72,
      l: 17.55,
      t: '2026-06-16T20:00:00.000Z',
    },
    prevDailyBar: {
      c: 17.40,
      v: 200000,
    },
  }, {
    bp: 17.60,
    ap: 17.66,
    t: '2026-06-16T20:00:00.000Z',
  }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    notional: 150,
    runId: 'stock-test-run',
    assetType: 'stock',
  });

  assert(candidate);
  assert.equal(candidate.payload.action_candidate, 'paper_buy');
  assert.equal(candidate.payload.market_context.scanner.run_id, 'stock-test-run');
  assert.equal(candidate.payload.symbol, 'NVDA');
  assert.equal(candidate.payload.asset_type, 'stock');
  assert.equal(candidate.payload.supports_fractional_shares, true);
});

test('stock scanner rejects stale market data before ranking a buy candidate', () => {
  const skips = [];
  const candidate = buildStockCandidateForSymbol('SCAGW', {
    latestQuote: {
      bp: 0.02,
      ap: 0.03,
      t: '2026-06-01T10:00:00.000Z',
    },
    latestTrade: {
      p: 0.021,
      t: '2026-06-01T10:00:00.000Z',
    },
    minuteBar: {
      v: 1200,
      h: 0.03,
      l: 0.02,
      t: '2026-06-01T10:00:00.000Z',
    },
    prevDailyBar: {
      c: 0.06,
      v: 600,
    },
  }, {
    bp: 0.02,
    ap: 0.03,
    t: '2026-06-01T10:00:00.000Z',
  }, {
    receivedAt: '2026-07-08T15:10:00.000Z',
    notional: 150,
    runId: 'stock-stale-test',
    assetType: 'stock',
    maxStalenessSeconds: 60,
    skipTracker: { record: (reason, details) => skips.push({ reason, details }) },
  });

  assert.equal(candidate, null);
  assert.equal(skips[0].reason, 'DATA_STALE_OR_UNAVAILABLE');
});

test('stock scanner requires fresh upward pressure when recent momentum gate is enabled', () => {
  const skips = [];
  const flat = buildStockCandidateForSymbol('FLAT', {
    latestQuote: { bp: 10.00, ap: 10.02, t: '2026-06-16T20:00:00.000Z' },
    latestTrade: { p: 10.01, t: '2026-06-16T20:00:00.000Z' },
    minuteBar: { o: 10.01, c: 10.01, h: 10.02, l: 10.00, v: 42, t: '2026-06-16T20:00:00.000Z' },
    prevDailyBar: { c: 9.50, v: 200000 },
  }, { bp: 10.00, ap: 10.02, t: '2026-06-16T20:00:00.000Z' }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    requireMultiSourceConfirmation: false,
    requireRecentMomentum: true,
    minMovePct: 0.2,
    minRecentMovePct: 0.03,
    minRecentRangePct: 0.05,
    minRecentCloseLocationPct: 60,
    skipTracker: { record: (reason, details) => skips.push({ reason, details }) },
  });
  const rising = buildStockCandidateForSymbol('RISE', {
    latestQuote: { bp: 10.04, ap: 10.06, t: '2026-06-16T20:00:00.000Z' },
    latestTrade: { p: 10.05, t: '2026-06-16T20:00:00.000Z' },
    minuteBar: { o: 9.95, c: 10.05, h: 10.05, l: 9.94, v: 420, t: '2026-06-16T20:00:00.000Z' },
    prevDailyBar: { c: 9.50, v: 200000 },
  }, { bp: 10.04, ap: 10.06, t: '2026-06-16T20:00:00.000Z' }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    requireMultiSourceConfirmation: false,
    requireRecentMomentum: true,
    minMovePct: 0.2,
    minRecentMovePct: 0.03,
    minRecentRangePct: 0.05,
    minRecentCloseLocationPct: 60,
  });

  assert.equal(flat, null);
  assert.equal(skips[0].reason, 'RECENT_UPWARD_MOMENTUM_WEAK');
  assert(rising);
  assert.equal(rising.payload.symbol, 'RISE');
});

test('live scanner defaults tighten the entry feed around real momentum', () => {
  const liveConfig = buildScannerConfig({
    TRADING_MODE: 'live',
  });

  assert.equal(liveConfig.requireRecentMomentum, true);
  assert.equal(liveConfig.minMovePct, 0.25);
  assert.equal(liveConfig.minRecentMovePct, 0.15);
  assert.equal(liveConfig.minRecentRangePct, 0.15);
  assert.equal(liveConfig.minRecentCloseLocationPct, 65);
});

test('stock scanner can allow high-score single-source momentum buys when explicitly enabled', () => {
  const candidate = buildStockCandidateForSymbol('VRM', rankedSnapshot({
    bid: 4.04,
    ask: 4.05,
    previousClose: 8.66,
    volume: 2_000,
    timestamp: '2026-07-06T15:05:00.000Z',
  }), {
    bp: 4.04,
    ap: 4.05,
    t: '2026-07-06T15:05:00.000Z',
  }, {
    receivedAt: '2026-07-06T15:05:01.000Z',
    requireMultiSourceConfirmation: true,
    twelveDataQuote: { price: 8.50, timestamp: '2026-07-06T15:05:00.000Z' },
    singleSourceMomentumEnabled: true,
    singleSourceMomentumMinRankScore: 500,
    allowContrarianEntries: true,
    maxBuyRiskScore: 100,
    notional: 35,
  });

  assert(candidate);
  assert.equal(candidate.payload.single_source_momentum_override, true);
  assert.equal(candidate.payload.market_context.single_source_momentum_override.reason_code, 'SINGLE_SOURCE_MOMENTUM_OVERRIDE');
  assert.equal(candidate.payload.action_candidate, 'paper_buy');
});

test('stock scanner still builds candidates when the move is tiny and the spread is wide', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', {
    latestQuote: {
      bp: 17.00,
      ap: 18.50,
      t: '2026-06-16T20:00:00.000Z',
    },
    latestTrade: {
      p: 17.75,
      t: '2026-06-16T20:00:00.000Z',
    },
    minuteBar: {
      v: 42,
      h: 18.0,
      l: 17.0,
      t: '2026-06-16T20:00:00.000Z',
    },
    prevDailyBar: {
      c: 17.74,
      v: 200000,
    },
  }, {
    bp: 17.00,
    ap: 18.50,
    t: '2026-06-16T20:00:00.000Z',
  }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    minMovePct: 999,
    maxSpreadPct: 0.01,
    notional: 150,
    runId: 'stock-test-wide',
    assetType: 'stock',
    allowContrarianEntries: true,
    maxBuyRiskScore: 100,
  });

  assert(candidate);
  assert.equal(candidate.payload.symbol, 'NVDA');
  assert.equal(candidate.payload.action_candidate, 'paper_buy');
});

test('stock scanner allows fractional stock buys when the budget is below one share', () => {
  const candidate = buildStockCandidateForSymbol('INTC', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    notional: 65.76,
    minMovePct: 0.25,
    allowContrarianEntries: true,
  });

  assert(candidate);
  assert.equal(candidate.payload.supports_fractional_shares, true);
});

test('stock scanner keeps fixed-notional sizing details when risk-budget sizing is disabled', () => {
  const candidate = buildStockCandidateForSymbol('MU', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
  });

  assert(candidate);
  assert.equal(candidate.payload.sizing_method, 'fixed_notional');
  assert.equal(candidate.payload.notional, 150);
  assert.equal(candidate.payload.quantity, null);
  assert.equal(candidate.payload.risk_budget_sizing, null);
  assert.equal(candidate.payload.structure_stop, null);
});

test('stock scanner writes risk-budget sizing and structure stop details when enabled', () => {
  const candidate = buildStockCandidateForSymbol('MU', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    riskBudgetSizingEnabled: true,
    maxRiskPerTradeDollars: 1,
    maxRiskPerTradePctEquity: 1,
    minStopDistanceDollars: 0.25,
    maxStopDistanceDollars: 2,
    allowRiskBudgetFractionalShares: true,
    riskBudgetRequireBrokerEquity: true,
    portfolio: {
      account: { equity: '1000', cash: '500', buying_power: '500' },
      cash: 500,
      buying_power: 500,
    },
  });

  assert(candidate);
  assert.equal(candidate.payload.sizing_method, 'risk_budget');
  assert.equal(candidate.payload.risk_budget_sizing.accepted, true);
  assert.equal(candidate.payload.structure_stop.accepted, true);
  assert.equal(candidate.payload.structure_stop.method, 'swing_low');
  assert.equal(candidate.payload.notional <= 150, true);
  assert.equal(candidate.payload.stop_loss, candidate.payload.structure_stop.stop_price);
  assert.equal(candidate.payload.market_context.scanner.sizing_method, 'risk_budget');
});

test('stock scanner writes buying-power sizing when selected explicitly', () => {
  const candidate = buildStockCandidateForSymbol('MTAL', rankedSnapshot({
    bid: 5.07,
    ask: 5.09,
    previousClose: 5,
    volume: 100000,
    timestamp: '2026-06-16T20:00:00.000Z',
  }), {
    bp: 5.07,
    ap: 5.09,
    t: '2026-06-16T20:00:00.000Z',
  }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 1000,
    allowContrarianEntries: true,
    positionSizingMode: 'buying_power',
    maxBuyingPowerDeploymentPct: 100,
    buyingPowerCashReserve: 0,
    allowBuyingPowerFractionalShares: false,
    minStopDistanceDollars: 0.25,
    maxStopDistanceDollars: 2,
    portfolio: {
      account: { equity: '194.68', cash: '194.68', buying_power: '194.68' },
      cash: 194.68,
      buying_power: 194.68,
    },
  });

  assert(candidate);
  assert.equal(candidate.payload.sizing_method, 'buying_power');
  assert.equal(candidate.payload.buying_power_sizing.accepted, true);
  assert.equal(candidate.payload.quantity, 38);
  assert.equal(candidate.payload.notional, 193.04);
  assert.equal(candidate.payload.market_context.scanner.buying_power_sizing.quantity, 38);
  assert.equal(candidate.payload.market_context.scanner.sizing_method, 'buying_power');
});

test('stock scanner applies a 20 point rank penalty to a recent sell symbol', () => {
  const plain = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
  });
  const penalized = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    recentTradePenalty: {
      symbol: 'NVDA',
      last_traded_at: '2026-06-16T19:58:01.000Z',
      penalty: 20,
      reason: 'compound_recent_sell',
    },
  });

  assert(plain);
  assert(penalized);
  assert.equal(Number((plain.rankScore - penalized.rankScore).toFixed(6)), 20);
  assert.equal(penalized.recentTradeRankPenalty, 20);
  assert.equal(penalized.payload.market_context.scanner.recent_trade_rank_penalty, 20);
  assert.equal(penalized.payload.market_context.scanner.recent_trade_penalty_reason, 'compound_recent_sell');
});

test('stock scanner applies execution quality penalties to buy candidates and leaves sells alone', () => {
  const executionQualitySummary = {
    status: 'active',
    total_entries: 1,
    total_trades: 1,
    average_quality_score: 54,
    average_slippage: 1.9,
    average_execution_drag: 0.5,
    partial_fill_rate: 0,
    rejection_rate: 0,
    cancellation_rate: 0,
    duplicate_risk_rate: 0,
    by_symbol: [{
      symbol: 'NVDA',
      setup_key: 'breakout',
      side: 'buy',
      time_regime: 'regular',
      trade_count: 1,
      average_quality_score: 54,
      average_slippage: 1.9,
      average_execution_drag: 0.5,
      penalty_points: 46,
      effective_penalty_points: 18,
      size_multiplier: 0.77,
      effective_size_multiplier: 0.91,
      last_classification: 'bad_fill',
      classifications: {
        bad_fill: 1,
        excellent_fill: 0,
        normal_fill: 0,
        high_slippage: 0,
        partial_fill: 0,
        rejected_order: 0,
        canceled_order: 0,
        stale_execution: 0,
        duplicate_risk: 0,
        unknown: 0,
      },
      recent_records: [],
    }],
    by_setup: [],
    recent_bad_fills: [],
    penalty_symbols: [],
    size_reduction_symbols: [],
    warnings: [],
  };
  const plain = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
  });
  const penalized = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    setupKey: 'breakout',
    setupFatigueState: {},
    executionQualitySummary,
    executionQualityRankPenaltyEnabled: true,
    executionQualitySizeMultiplierEnabled: true,
    executionQualityCooldownEnabled: true,
  });
  const sellCandidate = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', unrealized_pl: '-2.25' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
    setupFatigueState: {},
    executionQualitySummary,
    executionQualityRankPenaltyEnabled: true,
    executionQualitySizeMultiplierEnabled: true,
    executionQualityCooldownEnabled: true,
  });

  assert(plain);
  assert(penalized);
  assert(sellCandidate);
  assert.equal(Number((plain.rankScore - penalized.rankScore).toFixed(6)), 18);
  assert.equal(penalized.payload.market_context.scanner.execution_quality_rank_penalty, 18);
  assert.equal(penalized.payload.market_context.scanner.execution_quality_size_multiplier, 0.91);
  assert.equal(penalized.payload.market_context.scanner.execution_quality_penalty_reason, 'bad_fill');
  assert.equal(sellCandidate.payload.side, 'sell');
  assert.equal(sellCandidate.payload.market_context.scanner.execution_quality_rank_penalty, 0);
});

test('stock scanner compounds recent sell timers and ignores buys', () => {
  const penalties = normalizeRecentTradePenaltyMap([
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'buy',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:59:01.000Z',
          order_id: 'recent-buy-mu',
        },
      },
    },
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:58:01.000Z',
          order_id: 'recent-sell-mu-1',
        },
      },
    },
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:50:01.000Z',
          order_id: 'recent-sell-mu-2',
        },
      },
    },
  ], {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
  });

  const penalty = penalties.get('MU');
  assert(penalty);
  assert.equal(penalty.penalty, 40);
  assert.equal(penalty.reason, 'compound_recent_sell');
  assert.equal(penalty.components.length, 2);
  assert.deepEqual(penalty.components.map((component) => component.remaining_seconds).sort((a, b) => b - a), [780, 300]);
});

test('stock scanner lets stacked sell timers decay as older timers expire', () => {
  const records = [
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:58:01.000Z',
          order_id: 'recent-sell-mu-1',
        },
      },
    },
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:50:01.000Z',
          order_id: 'recent-sell-mu-2',
        },
      },
    },
  ];
  const stacked = normalizeRecentTradePenaltyMap(records, {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
  });
  const decayed = normalizeRecentTradePenaltyMap(records, {
    now: '2026-06-16T20:06:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
  });

  assert.equal(stacked.get('MU').penalty, 40);
  assert.equal(decayed.get('MU').penalty, 20);
  assert.equal(decayed.get('MU').components.length, 1);
});

test('stock scanner stacks losing sell penalty with the normal recent sell timer', () => {
  const penalties = normalizeRecentTradePenaltyMap([
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'MU',
        side: 'sell',
        pnl: -1.12,
        paper_result: {
          status: 'filled',
          filled_at: '2026-06-16T19:58:01.000Z',
          order_id: 'loss-exit-mu',
        },
        original_signal: {
          market_context: {
            exit_state: {
              exit_reason: 'STOP_LOSS_DOLLARS',
              unrealized_pl: -1.12,
            },
          },
        },
      },
    },
  ], {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
    stopWindowMinutes: 30,
    stopPenalty: 80,
  });

  const penalty = penalties.get('MU');
  assert(penalty);
  assert.equal(penalty.penalty, 160);
  assert.equal(penalty.reason, 'compound_recent_sell_loss_and_stop');
  assert.equal(penalty.loss_exit, true);
  assert.equal(penalty.stop_exit, true);
  assert.equal(penalty.exit_reason, 'STOP_LOSS_DOLLARS');
  assert.deepEqual(penalty.components.map((component) => component.reason).sort(), ['recent_loss_exit', 'recent_sell', 'recent_stop_exit']);
});

test('stock scanner adds a stale-exit penalty on top of the normal recent sell timer', () => {
  const penalties = normalizeRecentTradePenaltyMap([
    {
      entry_type: 'paper_outcome',
      record: {
        symbol: 'EVGO',
        side: 'sell',
        pnl: -0.36,
        trade_duration_seconds: 720,
        paper_result: {
          status: 'filled',
          filled_at: '2026-07-09T17:03:03.088Z',
          order_id: 'stale-exit-evgo',
        },
        exit_reason: 'STALE_POSITION_TIMEOUT',
      },
    },
  ], {
    now: '2026-07-09T17:10:03.088Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
    staleWindowMinutes: 20,
    stalePenalty: 40,
  });

  const penalty = penalties.get('EVGO');
  assert(penalty);
  assert.equal(penalty.penalty, 120);
  assert.equal(penalty.reason, 'compound_recent_sell_loss_and_stale');
  assert.equal(penalty.exit_reason, 'STALE_POSITION_TIMEOUT');
  assert.deepEqual(penalty.components.map((component) => component.reason).sort(), ['recent_loss_exit', 'recent_sell', 'recent_stale_exit']);
});

test('stock scanner blocks buys for fatigued setups but still allows sells', () => {
  const blockedBuy = buildStockCandidateForSymbol('MU', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    setupKey: 'mu-breakout',
    setupFatigueState: {
      setups: {
        'mu-breakout': {
          setup_key: 'mu-breakout',
          fatigue_score: 72,
          active: true,
          paused_until: '2026-06-16T20:30:00.000Z',
          reason_codes: ['SETUP_FATIGUE_ACTIVE'],
          recent_trades: 4,
          recent_losses: 3,
          recent_stopouts: 2,
          recent_wins: 1,
        },
      },
    },
  });
  const sellCandidate = buildStockCandidateForSymbol('MU', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    allowContrarianEntries: true,
    setupKey: 'mu-breakout',
    sessionGuards: {
      buy_blocked: true,
      sells_allowed: true,
      manage_only: true,
      reason_codes: ['SETUP_FATIGUE_ACTIVE'],
      active_guards: [{ guard: 'setup_fatigue', reason_codes: ['SETUP_FATIGUE_ACTIVE'] }],
    },
    position: {
      qty: 1,
      avg_entry_price: 100,
      unrealized_pl: -20,
    },
  });

  assert.equal(blockedBuy, null);
  assert(sellCandidate);
  assert.equal(sellCandidate.payload.side, 'sell');
});

test('stock scanner temporarily skips buys after clustered stop exits in the same symbol', () => {
  const skips = [];
  const penalties = normalizeRecentTradePenaltyMap([
    stopExitRecord('ABSI', '2026-06-16T19:58:01.000Z', -1.25, 'stop-1'),
    stopExitRecord('ABSI', '2026-06-16T19:53:01.000Z', -1.35, 'stop-2'),
  ], {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
    stopWindowMinutes: 30,
    stopPenalty: 80,
  });
  const candidate = buildStockCandidateForSymbol('ABSI', rankedSnapshot({
    bid: 10.18,
    ask: 10.20,
    previousClose: 7.37,
    volume: 350000,
    timestamp: '2026-06-16T20:00:00.000Z',
  }), { bp: 10.18, ap: 10.20, t: '2026-06-16T20:00:00.000Z' }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    recentTradePenalty: penalties.get('ABSI'),
    stopoutClusterBlockMinutes: 30,
    stopoutClusterBlockCount: 2,
    skipTracker: { record: (reason, details) => skips.push({ reason, details }) },
  });

  assert.equal(candidate, null);
  assert.equal(skips[0].reason, 'RECENT_STOPOUT_CLUSTER');
  assert.equal(skips[0].details.stop_exit_count, 2);
  assert.equal(skips[0].details.required_count, 2);
});

test('stock scanner keeps a symbol eligible with only one recent stop exit', () => {
  const penalties = normalizeRecentTradePenaltyMap([
    stopExitRecord('ABSI', '2026-06-16T19:58:01.000Z', -1.25, 'stop-1'),
  ], {
    now: '2026-06-16T20:00:01.000Z',
    windowMinutes: 15,
    penalty: 20,
    lossWindowMinutes: 10,
    lossPenalty: 60,
    stopWindowMinutes: 30,
    stopPenalty: 80,
  });
  const candidate = buildStockCandidateForSymbol('ABSI', rankedSnapshot({
    bid: 10.18,
    ask: 10.20,
    previousClose: 7.37,
    volume: 350000,
    timestamp: '2026-06-16T20:00:00.000Z',
  }), { bp: 10.18, ap: 10.20, t: '2026-06-16T20:00:00.000Z' }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    recentTradePenalty: penalties.get('ABSI'),
    stopoutClusterBlockMinutes: 30,
    stopoutClusterBlockCount: 2,
  });

  assert(candidate);
  assert.equal(candidate.payload.symbol, 'ABSI');
});

test('stock scanner skips buy candidates above the scanner risk limit before posting', () => {
  const skips = [];
  const candidate = buildStockCandidateForSymbol('VTAK', rankedSnapshot({
    bid: 1.23,
    ask: 1.39,
    previousClose: 0.942,
    volume: 64544,
    timestamp: '2026-06-16T20:00:00.000Z',
  }), { bp: 1.23, ap: 1.39, t: '2026-06-16T20:00:00.000Z' }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    maxBuyRiskScore: 70,
    skipTracker: { record: (reason, details) => skips.push({ reason, details }) },
  });

  assert.equal(candidate, null);
  assert.equal(skips[0].reason, 'BUY_RISK_SCORE_ABOVE_SCANNER_LIMIT');
  assert(skips[0].details.risk_score > 70);
});

test('stock scanner skips excluded buy symbols without affecting exit handling', () => {
  const skips = [];
  const buyCandidate = buildStockCandidateForSymbol('ABSI', rankedSnapshot({
    bid: 10.18,
    ask: 10.20,
    previousClose: 7.37,
    volume: 350000,
    timestamp: '2026-06-16T20:00:00.000Z',
  }), { bp: 10.18, ap: 10.20, t: '2026-06-16T20:00:00.000Z' }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
    excludedBuySymbols: ['ABSI'],
    skipTracker: { record: (reason, details) => skips.push({ reason, details }) },
  });
  const sellCandidate = buildStockCandidateForSymbol('ABSI', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    position: { symbol: 'ABSI', qty: '2', qty_available: '2', avg_entry_price: '80.75', unrealized_pl: '-2.25' },
    excludedBuySymbols: ['ABSI'],
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });

  assert.equal(buyCandidate, null);
  assert.equal(skips[0].reason, 'SYMBOL_EXCLUDED_FROM_BUYS');
  assert(sellCandidate);
  assert.equal(sellCandidate.payload.side, 'sell');
});

test('stock scanner applies capped spread rank pressure without hard-blocking buys', () => {
  const timestamp = '2026-06-16T20:00:00.000Z';
  const tight = buildStockCandidateForSymbol('DFTX', rankedSnapshot({
    bid: 43.95,
    ask: 44.05,
    previousClose: 36.17,
    volume: 241651,
    timestamp,
  }), { bp: 43.95, ap: 44.05, t: timestamp }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
  });
  const wide = buildStockCandidateForSymbol('DFTX', rankedSnapshot({
    bid: 43.61,
    ask: 44.60,
    previousClose: 36.17,
    volume: 241651,
    timestamp,
  }), { bp: 43.61, ap: 44.60, t: timestamp }, {
    receivedAt: '2026-06-16T20:00:01.000Z',
    notional: 150,
    allowContrarianEntries: true,
  });

  assert(tight);
  assert(wide);
  assert(wide.spreadRankPenalty > tight.spreadRankPenalty);
  assert(wide.rankScore < wide.baseRankScore - wide.recentTradeRankPenalty);
  assert.equal(wide.payload.market_context.scanner.spread_rank_penalty, Number(wide.spreadRankPenalty.toFixed(3)));
  assert.equal(calculateSpreadRankPenalty(10, { thresholdPct: 0.75, penaltyPerPct: 25, cap: 80 }), 80);
});

test('stock scanner defaults to simplified live-market rules', () => {
  const scanner = createStockScanner({
    enabled: true,
    env: {},
    localBaseUrl: 'http://127.0.0.1:65535',
    marketFetch: async () => buildResponse({ snapshots: {} }),
    localFetch: async () => buildResponse({}),
  });

  assert.deepEqual(scanner.config.symbols, APPROVED_LIVE_MARKET_SYMBOLS);
  assert.equal(scanner.config.notional, 150);
  assert.equal(scanner.config.maxOpenPositions, 2);
  assert.equal(scanner.config.stopLossDollars, 1);
  assert.equal(scanner.config.stopLossNotionalPct, 0.75);
  assert.equal(scanner.config.stopLossMaxDollars, 2.5);
  assert.equal(scanner.config.trailingProfitStartDollars, 0.45);
  assert.equal(scanner.config.trailingProfitGivebackDollars, 0.1);
  assert.equal(scanner.config.recentTradePenaltyMinutes, 15);
  assert.equal(scanner.config.recentTradeRankPenalty, 20);
  assert.equal(scanner.config.recentLossPenaltyMinutes, 10);
  assert.equal(scanner.config.recentLossRankPenalty, 60);
  assert.equal(scanner.config.recentStaleExitPenaltyMinutes, 20);
  assert.equal(scanner.config.recentStaleExitRankPenalty, 40);
  assert.equal(scanner.config.recentStopExitPenaltyMinutes, 30);
  assert.equal(scanner.config.recentStopExitRankPenalty, 80);
  assert.equal(scanner.config.stopoutClusterBlockMinutes, 30);
  assert.equal(scanner.config.stopoutClusterBlockCount, 2);
  assert.equal(scanner.config.maxBuyRiskScore, 70);
  assert.deepEqual(scanner.config.excludedBuySymbols, []);
  assert.equal(scanner.config.spreadRankPenaltyThresholdPct, 0.75);
  assert.equal(scanner.config.spreadRankPenaltyPerPct, 25);
  assert.equal(scanner.config.spreadRankPenaltyCap, 80);
  scanner.stop();
});

test('stock scanner posts candidates to the local paper order endpoint', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const localServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accepted: true, final_decision: 'approved_for_paper' }));
    });
  });
  await new Promise((resolve) => localServer.listen(0, resolve));
  const localPort = localServer.address().port;

  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    twelveDataApiKey: 'twelve-key',
    twelveDataBaseUrl: 'https://api.twelvedata.com',
    localBaseUrl: `http://127.0.0.1:${localPort}`,
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['SOFI'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    marketOpen: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/orders?status=open')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/account')) {
        return buildResponse({ cash: '267.11', buying_power: '267.11' });
      }
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            SOFI: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      if (url.includes('api.twelvedata.com/quote?')) {
        return buildResponse({
          data: [
            {
              symbol: 'SOFI',
              price: 17.65,
              datetime: alpacaTimestamp,
              volume: 1200,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: global.fetch,
  });

  const result = await scanner.runOnce({ runId: 'stock-test-scan' });
  scanner.stop();
  await new Promise((resolve) => localServer.close(resolve));

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/paper-order');
  assert.equal(requests[0].body.action_candidate, 'paper_buy');
  assert.equal(requests[0].body.symbol, 'SOFI');
  assert.equal(requests[0].body.supports_fractional_shares, true);
  assert.equal(requests[0].body.market_context.scanner.run_id, 'stock-test-scan');
});

test('stock scanner honors the configured approved rotation without fallback expansion', () => {
  const scanner = createStockScanner({
    enabled: false,
    env: {
      STOCK_SCANNER_SYMBOLS: 'SOFI,AAPL,AMD,INTC,MSFT,NVDA,AMZN,META,TSLA,GOOGL,PLTR,CRM',
    },
    marketFetch: async () => buildResponse({}),
    localFetch: async () => buildResponse({}),
  });

  assert.deepEqual(scanner.config.symbols, ['SOFI', 'AAPL', 'AMD', 'INTC', 'MSFT', 'NVDA', 'AMZN', 'META', 'TSLA', 'GOOGL', 'PLTR', 'CRM']);
  scanner.stop();
});

test('stock scanner creates a full-position sell at the dollar stop', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', unrealized_pl: '-2.25' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });

  assert(candidate);
  assert.equal(candidate.payload.side, 'sell');
  assert.equal(candidate.payload.quantity, 2);
  assert.equal(candidate.exitState.exit_reason, 'STOP_LOSS_DOLLARS');
  assert.equal(candidate.exitState.gross_pnl, -1.5);
  assert.equal(candidate.exitState.execution_drag, 0);
  assert.equal(candidate.exitState.net_pnl, -1.5);
  assert.equal(candidate.exitState.real_gain, false);
});

test('stock scanner widens the hard stop by position notional with a cap', () => {
  assert.equal(calculateEffectiveStopLossDollars({
    baseStopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    positionMarketValue: 260,
  }), 1.95);
  assert.equal(calculateEffectiveStopLossDollars({
    baseStopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    positionMarketValue: 1000,
  }), 2.5);
  assert.equal(calculateEffectiveStopLossDollars({
    baseStopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    positionMarketValue: 260,
    positionQuantity: 2,
  }), 2);
  assert.equal(calculateEffectiveStopLossDollars({
    baseStopLossDollars: 0.25,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    positionMarketValue: 192.5,
    positionQuantity: 25,
  }), 6.25);

  const normalWiggle = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', market_value: '260', unrealized_pl: '-1.25' },
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });
  assert.equal(normalWiggle, null);

  const breach = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', market_value: '260', unrealized_pl: '-2.05' },
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });
  assert(breach);
  assert.equal(breach.payload.side, 'sell');
  assert.equal(breach.exitState.exit_reason, 'STOP_LOSS_DOLLARS');
  assert.equal(breach.exitState.stop_loss_dollars, 2);
  assert.equal(breach.exitState.stop_loss_per_share, 1);
  assert.equal(breach.exitState.hard_stop_price, 79.75);
  assert.equal(breach.exitState.base_stop_loss_dollars, 1);
  assert.equal(breach.exitState.distance_to_stop_dollars, -0.05);
});

test('stock scanner run applies the widened hard stop to live positions', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['NVDA'],
    intervalMs: 60_000,
    maxOpenPositions: 1,
    marketOpen: true,
    stopLossDollars: 1,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([
          { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', market_value: '260', unrealized_pl: '-1.25' },
        ]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '0', buying_power: '0' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            NVDA: {
              latestQuote: { bp: 79.95, ap: 80.05, t: alpacaTimestamp },
              latestTrade: { p: 80, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 80.5, l: 79.5, t: alpacaTimestamp },
              prevDailyBar: { c: 79, v: 100000 },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (...args) => {
      requests.push(args);
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stock-widened-stop-run' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
  assert.equal(result.skip_summary.EXIT_TARGET_NOT_MET, 1);
});

test('stock scanner run passes the sell profit floor into exit evaluation', async () => {
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['NVDA'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    maxOpenPositions: 1,
    marketOpen: true,
    sellNetProfitFloorDollars: 1.2,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([
          {
            symbol: 'NVDA',
            qty: '2',
            qty_available: '2',
            avg_entry_price: '80',
            unrealized_pl: '0.70',
            market_value: '160.70',
          },
        ]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            NVDA: {
              latestQuote: { bp: 80.34, ap: 80.36, t: alpacaTimestamp },
              latestTrade: { p: 80.35, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 80.4, l: 80.3, t: alpacaTimestamp },
              prevDailyBar: { c: 79, v: 100000 },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async () => buildResponse({ accepted: true, final_decision: 'approved_for_paper' }),
  });

  const result = await scanner.runOnce({ runId: 'stock-sell-floor-pass-through-test' });
  scanner.stop();

  const exitSkip = result.recent_skips.find((entry) => entry.reason === 'EXIT_TARGET_NOT_MET');
  assert(exitSkip);
  assert.equal(exitSkip.sell_net_profit_floor_dollars, 1.2);
});

test('stock scanner trails winners after peak profit and sell on giveback', () => {
  const beforeStart = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '0.49' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.49 } } },
  });
  assert.equal(beforeStart, null);

  const risingWinnerSkips = [];
  const risingWinner = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80', unrealized_pl: '0.80' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.8 } } },
    skipTracker: { record: (reason, detail) => risingWinnerSkips.push({ reason, detail }) },
  });
  assert.equal(risingWinner, null);
  assert.equal(risingWinnerSkips[0]?.reason, 'EXIT_TARGET_NOT_MET');
  assert.equal(risingWinnerSkips[0]?.detail?.exit_mode, 'profit_protection_active');
  assert.equal(risingWinnerSkips[0]?.detail?.profit_protection_active, true);

  const giveback = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '79.85', unrealized_pl: '0.45', entry_slippage: '0.03', exit_slippage: '0.02', fees: '0.01' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.8 } } },
  });
  assert(giveback);
  assert.equal(giveback.payload.side, 'sell');
  assert.equal(giveback.exitState.exit_mode, 'trailing_profit_giveback_triggered');
  assert.equal(giveback.exitState.profit_protection_active, true);
  assert.equal(giveback.exitState.exit_reason, 'TRAILING_PROFIT_GIVEBACK');
  assert.equal(giveback.exitState.gross_pnl, 0.3);
  assert.equal(giveback.exitState.execution_drag, 0.06);
  assert.equal(giveback.exitState.net_pnl, 0.24);
  assert.equal(giveback.exitState.real_gain, true);
});

test('stock scanner exits stale positions that never become runners', () => {
  const stale = buildStockCandidateForSymbol('SVC', {
    latestQuote: { bp: 8.61, ap: 8.63, t: '2026-07-07T15:36:00.000Z' },
    latestTrade: { p: 8.62, t: '2026-07-07T15:36:00.000Z' },
    minuteBar: { o: 8.62, c: 8.62, h: 8.63, l: 8.61, v: 500, t: '2026-07-07T15:36:00.000Z' },
    prevDailyBar: { c: 8.50, v: 100000 },
  }, { bp: 8.61, ap: 8.63, t: '2026-07-07T15:36:00.000Z' }, {
    receivedAt: '2026-07-07T15:36:00.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'SVC', qty: '20', qty_available: '20', avg_entry_price: '8.66', unrealized_pl: '-0.80' },
    stopLossDollars: 0.25,
    stopLossNotionalPct: 0.75,
    stopLossMaxDollars: 2.5,
    trailingProfitStartDollars: 1.3,
    trailingProfitGivebackDollars: 0.3,
    stalePositionExitEnabled: true,
    stalePositionMaxHoldMinutes: 12,
    stalePositionMinPeakProfitDollars: 0.25,
    stalePositionMaxExitPnlDollars: 0,
    trailingState: {
      positions: {
        SVC: {
          opened_at: '2026-07-07T15:13:19.397Z',
          peak_unrealized_pl: -0.1,
        },
      },
    },
  });

  assert(stale);
  assert.equal(stale.payload.side, 'sell');
  assert.equal(stale.exitState.exit_reason, 'STALE_POSITION_TIMEOUT');
  assert.equal(stale.exitState.exit_mode, 'stale_position_recycle');
  assert.equal(stale.exitState.held_seconds >= 12 * 60, true);
});

test('stock scanner recycles minor green positions that never arm trailing protection', () => {
  const staleGreen = buildStockCandidateForSymbol('PDDL', {
    latestQuote: { bp: 1.52, ap: 1.54, t: '2026-07-09T19:30:34.000Z' },
    latestTrade: { p: 1.53, t: '2026-07-09T19:30:34.000Z' },
    minuteBar: { o: 1.53, c: 1.53, h: 1.54, l: 1.52, v: 900, t: '2026-07-09T19:30:34.000Z' },
    prevDailyBar: { c: 1.48, v: 250000 },
  }, { bp: 1.52, ap: 1.54, t: '2026-07-09T19:30:34.000Z' }, {
    receivedAt: '2026-07-09T19:30:34.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'PDDL', qty: '106', qty_available: '106', avg_entry_price: '1.5272', unrealized_pl: '0.294' },
    stopLossDollars: 0.25,
    stopLossNotionalPct: 0.6075,
    stopLossMaxDollars: 1.8062,
    sellNetProfitFloorDollars: 0.35,
    trailingProfitStartDollars: 0.45,
    trailingProfitGivebackDollars: 0.1,
    stalePositionExitEnabled: true,
    stalePositionMaxHoldMinutes: 12,
    stalePositionMinPeakProfitDollars: 0.25,
    stalePositionMaxExitPnlDollars: 0.35,
    trailingState: {
      positions: {
        PDDL: {
          opened_at: '2026-07-09T18:52:39.048Z',
          peak_updated_at: '2026-07-09T18:52:39.048Z',
          peak_unrealized_pl: 0.294,
        },
      },
    },
  });

  assert(staleGreen);
  assert.equal(staleGreen.payload.side, 'sell');
  assert.equal(staleGreen.exitState.exit_reason, 'STALE_POSITION_TIMEOUT');
  assert.equal(staleGreen.exitState.exit_mode, 'stale_position_recycle');
  assert.equal(staleGreen.exitState.profit_protection_active, false);
  assert.equal(staleGreen.exitState.held_seconds >= 12 * 60, true);
});

test('stock scanner exits stalled protected winners so capital can recycle', () => {
  const stalledWinner = buildStockCandidateForSymbol('GOGL', {
    latestQuote: { bp: 29.14, ap: 29.16, t: '2026-07-07T16:18:00.000Z' },
    latestTrade: { p: 29.15, t: '2026-07-07T16:18:00.000Z' },
    minuteBar: { o: 29.15, c: 29.15, h: 29.16, l: 29.14, v: 1000, t: '2026-07-07T16:18:00.000Z' },
    prevDailyBar: { c: 28.7, v: 100000 },
  }, { bp: 29.14, ap: 29.16, t: '2026-07-07T16:18:00.000Z' }, {
    receivedAt: '2026-07-07T16:18:00.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'GOGL', qty: '6', qty_available: '6', avg_entry_price: '28.72', unrealized_pl: '2.58' },
    stopLossDollars: 0.25,
    trailingProfitStartDollars: 1.3,
    trailingProfitGivebackDollars: 0.3,
    stalledWinnerExitEnabled: true,
    stalledWinnerMaxHoldMinutes: 10,
    stalledWinnerMaxMinutesSincePeak: 5,
    stalledWinnerMinProfitDollars: 0.45,
    trailingState: {
      positions: {
        GOGL: {
          opened_at: '2026-07-07T15:57:42.077Z',
          peak_updated_at: '2026-07-07T15:58:36.518Z',
          peak_unrealized_pl: 2.58,
          trailing_active: true,
        },
      },
    },
  });

  assert(stalledWinner);
  assert.equal(stalledWinner.payload.side, 'sell');
  assert.equal(stalledWinner.exitState.exit_reason, 'STALLED_WINNER_TIMEOUT');
  assert.equal(stalledWinner.exitState.exit_mode, 'stalled_winner_recycle');
  assert.equal(stalledWinner.exitState.held_seconds >= 10 * 60, true);
  assert.equal(stalledWinner.exitState.seconds_since_peak >= 5 * 60, true);
});

test('stock scanner does not harvest trailing wins below the net profit floor', () => {
  const tinyGiveback = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '79.85', unrealized_pl: '0.45', entry_slippage: '0.03', exit_slippage: '0.02', fees: '0.01' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    sellNetProfitFloorDollars: 1,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 0.8 } } },
  });
  assert.equal(tinyGiveback, null);

  const realGiveback = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    maxSpreadPct: 0.8,
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '79.4', unrealized_pl: '1.25', entry_slippage: '0.03', exit_slippage: '0.02', fees: '0.01' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    sellNetProfitFloorDollars: 1,
    trailingState: { positions: { NVDA: { peak_unrealized_pl: 1.6 } } },
  });
  assert(realGiveback);
  assert.equal(realGiveback.exitState.exit_reason, 'TRAILING_PROFIT_GIVEBACK');
  assert(realGiveback.exitState.net_pnl >= 1);
  assert.equal(realGiveback.exitState.trailing_activation_profit_dollars, 1.36);
});

test('stock scanner does not apply recent-symbol rank penalties to sell exits', () => {
  const candidate = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-16T20:00:01.000Z',
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', unrealized_pl: '-2.25' },
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
    recentTradePenalty: {
      symbol: 'NVDA',
      last_traded_at: '2026-06-16T19:58:01.000Z',
      penalty: 8,
    },
  });

  assert(candidate);
  assert.equal(candidate.payload.side, 'sell');
  assert.equal(candidate.payload.market_context.scanner.recent_trade_rank_penalty, 0);
  assert.equal(candidate.exitState.exit_mode, 'hard_stop_triggered');
  assert.equal(candidate.exitState.exit_reason, 'STOP_LOSS_DOLLARS');
});

test('stock scanner rotates away from a recently traded symbol when another rank stays stronger', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MU', 'WDC'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 1,
    maxOpenPositions: 1,
    marketOpen: true,
    antiChurnState: {
      symbol_cooldowns: {
        MU: {
          symbol: 'MU',
          penalty: 20,
          remaining_seconds: 300,
          cooldown_until: new Date(Date.now() + 300_000).toISOString(),
          last_traded_at: new Date(Date.now() - 60_000).toISOString(),
          reason: 'recent_sell',
        },
      },
      setup_cooldowns: {},
      recent_classifications: [],
      churn_guard: null,
      recent_winner_protection: {},
    },
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 129.9, ask: 130.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 104.9, ask: 105.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' });
    },
  });

  const result = await scanner.runOnce({ runId: 'recent-symbol-still-best' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'WDC');
  assert.equal(requests[0].market_context.scanner.recent_trade_rank_penalty, 0);
  assert(requests[0].market_context.scanner.rank_score > 0);
});

test('stock scanner rotates away from a recent losing exit when another rank is close', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const recentLossAt = new Date(Date.now() - 60_000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MU', 'WDC'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 1,
    maxOpenPositions: 1,
    marketOpen: true,
    antiChurnState: {
      symbol_cooldowns: {
        MU: {
          symbol: 'MU',
          penalty: 80,
          remaining_seconds: 300,
          cooldown_until: new Date(Date.now() + 300_000).toISOString(),
          last_traded_at: recentLossAt,
          reason: 'recent_loss_exit',
        },
      },
      setup_cooldowns: {},
      recent_classifications: [],
      churn_guard: null,
      recent_winner_protection: {},
    },
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 116.9, ask: 117.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' });
    },
  });

  const result = await scanner.runOnce({ runId: 'recent-loss-rotation' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'WDC');
});

test('stock scanner rotates away from stacked recent sells when another rank is close', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const firstSellAt = new Date(Date.now() - 60_000).toISOString();
  const secondSellAt = new Date(Date.now() - 8 * 60_000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MU', 'WDC'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 1,
    maxOpenPositions: 1,
    marketOpen: true,
    antiChurnState: {
      symbol_cooldowns: {
        MU: {
          symbol: 'MU',
          penalty: 120,
          remaining_seconds: 300,
          cooldown_until: new Date(Date.now() + 300_000).toISOString(),
          last_traded_at: firstSellAt,
          reason: 'stacked_recent_sells',
        },
      },
      setup_cooldowns: {},
      recent_classifications: [],
      churn_guard: null,
      recent_winner_protection: {},
    },
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 116.9, ask: 117.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stacked-recent-sell-rotation' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'WDC');
});

test('stock scanner keeps a recent winner eligible when it remains the strongest rank', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const antiChurnState = {
    version: '2026-06-25.anti-churn-state.1',
    updated_at: '2026-06-25T14:00:00.000Z',
    last_reconciled_at: '2026-06-25T14:00:00.000Z',
    symbol_cooldowns: {
      MU: {
        symbol: 'MU',
        classification: 'clean_win',
        severity: 'low',
        penalty_points: 0,
        penalty: 0,
        cooldown_seconds: 0,
        cooldown_until: null,
        expires_at: null,
        remaining_seconds: 0,
        reason: 'CLEAN_WIN_NO_PENALTY',
        reason_codes: ['RECENT_WINNER_PROTECTED', 'CLEAN_WIN_NO_PENALTY'],
        recent_winner_protected: true,
        components: [],
      },
    },
    setup_cooldowns: {},
    recent_classifications: [],
    churn_guard: { active: false, triggered_at: null, expires_at: null, window_seconds: 3600, trade_count: 0, churn_score: 0, reason_codes: [], explanation: '' },
    recent_winner_protection: {
      MU: {
        symbol: 'MU',
        cooldown_until: null,
        remaining_seconds: 0,
        penalty: 0,
        reason_codes: ['RECENT_WINNER_PROTECTED', 'CLEAN_WIN_NO_PENALTY'],
        recent_winner_protected: true,
      },
    },
  };
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MU', 'WDC'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 1,
    maxOpenPositions: 1,
    marketOpen: true,
    antiChurnState,
    env: { PERFORMANCE_HISTORY_PATH: 'non_existent_file.jsonl' },
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 104.9, ask: 105.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' });
    },
  });

  const result = await scanner.runOnce({ runId: 'recent-winner-eligible' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].symbol, 'MU');
  assert.equal(requests[0].market_context.scanner.recent_trade_rank_penalty, 0);
});

test('stock scanner blocks buy churn but still allows sell exits', () => {
  const antiChurnState = {
    churn_guard: {
      active: true,
      triggered_at: '2026-06-25T14:00:00.000Z',
      expires_at: '2026-06-25T14:30:00.000Z',
      window_seconds: 1800,
      trade_count: 4,
      churn_score: 90,
      reason_codes: ['CHURN_RATE_GUARD_ACTIVE'],
      explanation: 'Churn guard active',
    },
    symbol_cooldowns: {
      MU: {
        symbol: 'MU',
        penalty: 0,
        remaining_seconds: 0,
        cooldown_until: null,
        reason: 'CLEAN_WIN_NO_PENALTY',
        reason_codes: ['CLEAN_WIN_NO_PENALTY'],
        components: [],
      },
    },
    setup_cooldowns: {},
  };
  const buyCandidate = buildStockCandidateForSymbol('MU', rankedSnapshot({
    bid: 119.9,
    ask: 120.1,
    previousClose: 100,
    volume: 100000,
    timestamp: '2026-06-25T14:00:01.000Z',
  }), stockQuote(), {
    receivedAt: '2026-06-25T14:00:01.000Z',
    antiChurnState,
    setupKey: null,
    maxOpenPositions: 1,
    portfolio: { remaining_position_slots: 1 },
    allowContrarianEntries: true,
  });
  const sellCandidate = buildStockCandidateForSymbol('NVDA', stockSnapshot(), stockQuote(), {
    receivedAt: '2026-06-25T14:00:01.000Z',
    position: { symbol: 'NVDA', qty: '2', qty_available: '2', avg_entry_price: '80.75', unrealized_pl: '-2.25' },
    antiChurnState,
    stopLossDollars: 1,
    trailingProfitStartDollars: 0.5,
    trailingProfitGivebackDollars: 0.3,
    trailingState: { positions: {} },
  });

  assert.equal(buyCandidate, null);
  assert(sellCandidate);
  assert.equal(sellCandidate.payload.side, 'sell');
});

test('stock scanner runtime snapshot includes anti-churn details', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-scanner-anti-churn-'));
  const runtimePath = path.join(tempDir, 'scanner-runtime.json');
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MU'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 1,
    maxOpenPositions: 1,
    marketOpen: true,
    antiChurnState: {
      symbol_cooldowns: {
        MU: {
          symbol: 'MU',
          penalty: 5,
          penalty_points: 5,
          remaining_seconds: 600,
          cooldown_until: '2026-06-25T14:10:00.000Z',
          reason: 'TRAILING_WIN_LIGHT_PENALTY',
          reason_codes: ['RECENT_WINNER_PROTECTED', 'TRAILING_WIN_LIGHT_PENALTY'],
          recent_winner_protected: true,
          components: [
            {
              classification: 'trailing_win',
              penalty_points: 5,
              remaining_seconds: 600,
              cooldown_seconds: 600,
              cooldown_until: '2026-06-25T14:10:00.000Z',
              reason_codes: ['RECENT_WINNER_PROTECTED', 'TRAILING_WIN_LIGHT_PENALTY'],
              recent_winner_protected: true,
            },
          ],
        },
      },
      setup_cooldowns: {},
      recent_classifications: [],
      churn_guard: { active: false, triggered_at: null, expires_at: null, window_seconds: 3600, trade_count: 0, churn_score: 0, reason_codes: [], explanation: '' },
      recent_winner_protection: {},
    },
    env: {
      SCANNER_RUNTIME_STATE_ENABLED: 'true',
      SCANNER_RUNTIME_STATE_PATH: runtimePath,
    },
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: '2026-06-25T14:00:01.000Z' }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async () => buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' }),
  });

  const result = await scanner.runOnce({ runId: 'stock-runtime-anti-churn' });
  scanner.stop();
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

  assert.equal(result.accepted, true);
  assert.equal(runtime.anti_churn_summary.symbol_cooldown_count, 1);
  assert.equal(runtime.anti_churn_summary.recent_exit_count, 0);
  assert.equal(runtime.anti_churn_state.symbol_cooldowns.MU.reason, 'TRAILING_WIN_LIGHT_PENALTY');
});

test('stock scanner runtime snapshot includes candidate lifecycle details when enabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-scanner-candidate-lifecycle-'));
  const runtimePath = path.join(tempDir, 'scanner-runtime.json');
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['MU', 'WDC'],
    intervalMs: 60_000,
    maxCandidatesPerRun: 1,
    maxOpenPositions: 1,
    marketOpen: true,
    env: {
      SCANNER_RUNTIME_STATE_ENABLED: 'true',
      SCANNER_RUNTIME_STATE_PATH: runtimePath,
      CANDIDATE_QUEUE_ENABLED: 'true',
      CANDIDATE_MIN_SCANS_BEFORE_ENTRY: '1',
      CANDIDATE_MIN_SECONDS_BEFORE_ENTRY: '0',
      CANDIDATE_MAX_AGE_SECONDS: '600',
      CANDIDATE_CONFIRMATION_REQUIRED: 'false',
      CANDIDATE_QUEUE_MAX_SIZE: '4',
      RANK_CONFIDENCE_DECAY_ENABLED: 'false',
      HUNT_TO_MONITOR_LATCH_ENABLED: 'false',
      MICRO_ROTATION_GUARD_ENABLED: 'true',
      ROTATION_SOFT_BAND_POINTS: '4',
      ROTATION_HARD_BAND_POINTS: '12',
      ROTATION_MIN_HOLD_SCANS: '1',
    },
    candidateLifecycleState: {},
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            MU: rankedSnapshot({ bid: 119.9, ask: 120.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
            WDC: rankedSnapshot({ bid: 104.9, ask: 105.1, previousClose: 100, volume: 100000, timestamp: alpacaTimestamp }),
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async () => buildResponse({ accepted: true, final_decision: 'APPROVED_FOR_PAPER' }),
  });

  const result = await scanner.runOnce({ runId: 'candidate-lifecycle-runtime' });
  scanner.stop();
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

  assert.equal(result.accepted, true);
  assert.equal(runtime.candidate_lifecycle_summary.queue_enabled, true);
  assert.equal(runtime.candidate_lifecycle_summary.total_count >= 1, true);
  assert.equal(Object.keys(runtime.candidate_lifecycle_state.candidates).length >= 1, true);
});

test('stock scanner batches large stock universes into multiple market-data requests', async () => {
  const requestedUrls = [];
  const symbols = Array.from({ length: 26 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`);
  const snapshotPayload = Object.fromEntries(symbols.map((symbol) => ([
    symbol,
    {
      latestQuote: { bp: 10, ap: 10.1, t: '2026-06-16T20:00:00.000Z' },
      latestTrade: { p: 10.05, t: '2026-06-16T20:00:00.000Z' },
      minuteBar: { v: 1000, h: 10.2, l: 9.9, t: '2026-06-16T20:00:00.000Z' },
      prevDailyBar: { c: 10, v: 100000 },
    },
  ])));

  const scanner = createStockScanner({
    enabled: true,
    env: {
      STOCK_SCANNER_SYMBOLS: symbols.join(','),
    },
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    marketFetch: async (url) => {
      requestedUrls.push(url);
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({ snapshots: snapshotPayload });
      }
      return buildResponse({});
    },
    localFetch: async () => buildResponse({ accepted: true, final_decision: 'blocked' }),
    minMovePct: 999,
    marketOpen: true,
  });

  const result = await scanner.runOnce({ runId: 'batch-test' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requestedUrls.filter((url) => url.includes('/v2/stocks/snapshots?')).length, 2);
});

test('stock scanner skips buy candidates when buys are blocked', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const localServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ accepted: true, final_decision: 'approved_for_paper' }));
    });
  });
  await new Promise((resolve) => localServer.listen(0, resolve));
  const localPort = localServer.address().port;

  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    twelveDataApiKey: 'twelve-key',
    twelveDataBaseUrl: 'https://api.twelvedata.com',
    localBaseUrl: `http://127.0.0.1:${localPort}`,
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['SOFI'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    blockBuys: true,
    marketOpen: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/orders?status=open')) {
        return buildResponse([]);
      }
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            SOFI: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      if (url.includes('api.twelvedata.com/quote?')) {
        return buildResponse({
          data: [
            {
              symbol: 'SOFI',
              price: 17.65,
              datetime: alpacaTimestamp,
              volume: 1200,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: global.fetch,
  });

  const result = await scanner.runOnce({ runId: 'stock-buy-block-test' });
  scanner.stop();
  await new Promise((resolve) => localServer.close(resolve));

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
});

test('stock scanner blocks stock buys while the US market is closed', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['NVDA'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    marketOpen: false,
    requireMarketOpen: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse([]);
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            NVDA: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (...args) => {
      requests.push(args);
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stock-market-closed-test' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
  assert.equal(result.skip_summary.MARKET_CLOSED_FOR_STOCKS, 2);
});

test('stock scanner writes an off-hours preview without submitting orders', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-scanner-preview-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const originalCwd = process.cwd();
  process.chdir(tempRoot);

  try {
    const scanner = createStockScanner({
      enabled: true,
      baseUrl: 'https://data.alpaca.markets',
      localBaseUrl: 'http://127.0.0.1:65535',
      apiKeyId: 'key',
      apiSecretKey: 'secret',
      symbols: ['NVDA'],
      intervalMs: 60_000,
      cooldownMs: 60_000,
      minMovePct: 0.25,
      maxSpreadPct: 0.8,
      marketOpen: false,
      dataDir,
      repoRoot: tempRoot,
      runtimeStateEnabled: true,
      marketFetch: async (url) => {
        if (url.includes('/v2/positions')) return buildResponse([]);
        if (url.includes('/v2/orders?status=open')) return buildResponse([]);
        if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
        if (url.includes('/v2/stocks/snapshots?')) {
          return buildResponse({
            snapshots: {
              NVDA: {
                latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
                latestTrade: { p: 17.63, t: alpacaTimestamp },
                minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
                prevDailyBar: { c: 17.40, v: 100000 },
              },
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      localFetch: async (...args) => {
        requests.push(args);
        return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
      },
    });

    const result = await scanner.runOnce({ runId: 'stock-preview-test' });
    scanner.stop();

    const runtimePath = path.join(dataDir, 'state', 'scanner-runtime.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

    assert.equal(result.accepted, true);
    assert.equal(requests.length, 0);
    assert.equal(runtime.candidate_count, 0);
    assert.equal(runtime.preview_candidate_count, 1);
    assert.equal(runtime.market_closed_execution_block, true);
    assert.equal(runtime.waiting_for_buy.reason_code, 'SCANNER_PREVIEW_ONLY_MARKET_CLOSED');
    assert.equal(runtime.preview_reason_codes.includes('MARKET_CLOSED_FOR_STOCKS'), true);
    assert.equal(runtime.top_preview_candidates[0].symbol, 'NVDA');
    assert.equal(runtime.top_preview_candidates[0].status, 'preview_only');
    assert.equal(runtime.top_preview_candidates[0].execution_blocked, true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('stock scanner keeps market-open behavior unchanged', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-scanner-open-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const originalCwd = process.cwd();
  process.chdir(tempRoot);

  try {
    const scanner = createStockScanner({
      enabled: true,
      baseUrl: 'https://data.alpaca.markets',
      localBaseUrl: 'http://127.0.0.1:65535',
      apiKeyId: 'key',
      apiSecretKey: 'secret',
      symbols: ['NVDA'],
      intervalMs: 60_000,
      cooldownMs: 60_000,
      minMovePct: 0.25,
      maxSpreadPct: 0.8,
      marketOpen: true,
      dataDir,
      repoRoot: tempRoot,
      runtimeStateEnabled: true,
      marketFetch: async (url) => {
        if (url.includes('/v2/positions')) return buildResponse([]);
        if (url.includes('/v2/orders?status=open')) return buildResponse([]);
        if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
        if (url.includes('/v2/stocks/snapshots?')) {
          return buildResponse({
            snapshots: {
              NVDA: {
                latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
                latestTrade: { p: 17.63, t: alpacaTimestamp },
                minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
                prevDailyBar: { c: 17.40, v: 100000 },
              },
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
      localFetch: async (...args) => {
        requests.push(args);
        return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
      },
    });

    const result = await scanner.runOnce({ runId: 'stock-open-test' });
    scanner.stop();

    const runtimePath = path.join(dataDir, 'state', 'scanner-runtime.json');
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

    assert.equal(result.accepted, true);
    assert.equal(requests.length, 1);
    assert.equal(runtime.candidate_count, 1);
    assert.equal(runtime.preview_candidate_count, 0);
    assert.equal(runtime.broker_truth.source_of_truth, 'alpaca');
    assert(runtime.broker_truth.freshness === 'fresh' || runtime.broker_truth.freshness === 'unknown');
    assert.equal(runtime.waiting_for_buy.reason_code, 'LIVE_BUY_CANDIDATE_READY');
    assert.equal(runtime.candidate_rank_details[0].execution_status, 'eligible_for_risk_check');
    assert.equal(typeof runtime.candidate_rank_details[0].sizing_explanation, 'object');
    assert.equal(Array.isArray(runtime.preview_candidates) && runtime.preview_candidates.length, 0);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('stock scanner counts all live Alpaca positions against the max-position cap', async () => {
  const requests = [];
  const alpacaTimestamp = new Date(Date.now() - 3000).toISOString();
  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols: ['NVDA'],
    intervalMs: 60_000,
    cooldownMs: 60_000,
    minMovePct: 0.25,
    maxSpreadPct: 0.8,
    maxOpenPositions: 2,
    marketOpen: true,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) {
        return buildResponse([
          { symbol: 'AAPL', qty: '1' },
          { symbol: 'MSFT', qty: '1' },
        ]);
      }
      if (url.includes('/v2/orders?status=open')) return buildResponse([]);
      if (url.includes('/v2/account')) return buildResponse({ cash: '500', buying_power: '500' });
      if (url.includes('/v2/stocks/snapshots?')) {
        return buildResponse({
          snapshots: {
            NVDA: {
              latestQuote: { bp: 17.60, ap: 17.66, t: alpacaTimestamp },
              latestTrade: { p: 17.63, t: alpacaTimestamp },
              minuteBar: { v: 50, h: 17.72, l: 17.55, t: alpacaTimestamp },
              prevDailyBar: { c: 17.40, v: 100000 },
            },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (...args) => {
      requests.push(args);
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  const result = await scanner.runOnce({ runId: 'stock-max-live-positions-test' });
  scanner.stop();

  assert.equal(result.accepted, true);
  assert.equal(requests.length, 0);
  assert.equal(result.portfolio.open_positions_count, 2);
  assert.equal(result.skip_summary.MAX_POSITION_SLOTS_FILLED, 2);
});

test('stock scanner ignores dynamic watchlist symbols when the feature is disabled', async () => {
  const harness = createScannerHarness({
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      TWELVEDATA_API_KEY: 'td-key',
    },
    snapshots: {
      AAA: rankedSnapshot({ bid: 9.90, ask: 10.10, previousClose: 9.50, volume: 1_000_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      HOT: rankedSnapshot({ bid: 19.90, ask: 20.10, previousClose: 19.50, volume: 200_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      HOTT: rankedSnapshot({ bid: 29.90, ask: 30.10, previousClose: 29.50, volume: 250_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    dynamicHotList: {
      generatedAt: '2026-07-01T00:00:00.000Z',
      lastScoredAt: '2026-07-01T00:00:00.000Z',
      mode: 'shadow',
      source: 'test',
      enabled: true,
      status: 'shadow',
      stale: false,
      dynamicHotList: [{
        symbol: 'HOT',
        memeHeatScore: 84,
        marketConfirmationScore: 82,
        status: 'dynamic_watch',
        reasonCodes: ['social_heat'],
        riskWarnings: [],
        expiresAt: '2026-07-02T15:00:00.000Z',
      }],
      hotHotList: [{
        symbol: 'HOTT',
        memeHeatScore: 95,
        marketConfirmationScore: 91,
        status: 'hot_hot',
        priorityOverrideEligible: true,
        reasonCodes: ['market_confirmation_passed'],
        riskWarnings: [],
        expiresAt: '2026-07-02T15:00:00.000Z',
      }],
      expired: [],
      rejected: [],
    },
  });

  try {
    const result = await harness.scanner.runOnce({ runId: 'dynamic-disabled-test' });
    assert.equal(result.accepted, true);
    assert.deepEqual(harness.requestedSymbols, ['AAA']);
    assert.deepEqual(harness.secondaryRequestedSymbols, ['AAA']);
    const watchConfig = resolveScannerWatchConfig({
      env: {
        ...harness.env,
      },
      repoRoot: harness.repoRoot,
      dataDir: harness.dataDir,
      currentDate: '2026-06-30T20:34:00.000Z',
      approvedSymbols: ['AAA'],
    });
    assert.deepEqual(watchConfig.attentionSymbols, ['AAA']);
  } finally {
    harness.cleanup();
  }
});

test('stock scanner includes fresh dynamic watchlist symbols and keeps expired symbols out', async () => {
  const freshScoredAt = new Date().toISOString();
  const freshExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const harness = createScannerHarness({
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_HOT_LIST_TTL_MINUTES: '120',
      TWELVEDATA_API_KEY: 'td-key',
    },
    snapshots: {
      AAA: rankedSnapshot({ bid: 9.90, ask: 10.10, previousClose: 9.50, volume: 1_000_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      HOT: rankedSnapshot({ bid: 19.90, ask: 20.10, previousClose: 19.50, volume: 200_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      OLD: rankedSnapshot({ bid: 29.90, ask: 30.10, previousClose: 29.50, volume: 250_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    dynamicHotList: {
      generatedAt: freshScoredAt,
      lastScoredAt: freshScoredAt,
      mode: 'active',
      source: 'test',
      enabled: true,
      status: 'active',
      stale: false,
      dynamicHotList: [{
        symbol: 'HOT',
        memeHeatScore: 84,
        marketConfirmationScore: 82,
        status: 'dynamic_watch',
        reasonCodes: ['social_heat'],
        riskWarnings: [],
        expiresAt: freshExpiresAt,
      }],
      hotHotList: [],
      expired: [{
        symbol: 'OLD',
        memeHeatScore: 90,
        marketConfirmationScore: 90,
        status: 'hot_hot',
        reasonCodes: ['expired'],
        riskWarnings: [],
        expiresAt: '2026-06-29T15:00:00.000Z',
        expired: true,
      }],
      rejected: [],
    },
  });

  try {
    const result = await harness.scanner.runOnce({ runId: 'dynamic-enabled-test' });
    assert.equal(result.accepted, true);
    assert.deepEqual(harness.requestedSymbols.sort(), ['HOT']);
    assert.equal(harness.requestedSymbols.includes('OLD'), false);
    assert.deepEqual(harness.secondaryRequestedSymbols.sort(), ['HOT']);
    assert.equal(harness.secondaryRequestedSymbols.includes('OLD'), false);
    const watchConfig = resolveScannerWatchConfig({
      env: {
        ...harness.env,
      },
      repoRoot: harness.repoRoot,
      dataDir: harness.dataDir,
      currentDate: '2026-06-30T20:34:00.000Z',
      approvedSymbols: ['AAA'],
    });
    assert.equal(watchConfig.attentionSymbols.includes('HOT'), true);
    assert.equal(watchConfig.attentionSymbols.includes('OLD'), false);
    assert.equal(watchConfig.attentionSymbols.includes('AAA'), false);
  } finally {
    harness.cleanup();
  }
});

test('resolveScannerWatchConfig selects approved, dynamic, and hybrid scanner source modes', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-scanner-source-modes-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });

  const regularWatchStatus = {
    status: 'active',
    regularWatchList: [{ symbol: 'HOT' }],
    regularWatchMovers: [{ symbol: 'HOTT' }],
    sources: [],
  };
  const dynamicHotList = {
    enabled: true,
    status: 'active',
    dynamicHotList: [{ symbol: 'HOT', status: 'dynamic_watch' }],
    hotHotList: [{ symbol: 'HOTT', status: 'hot_hot' }],
    generatedAt: '2026-07-02T20:00:00.000Z',
  };
  fs.writeFileSync(path.join(dataDir, 'runtime', 'dynamic-hot-list.json'), JSON.stringify(dynamicHotList, null, 2));

  const approved = resolveScannerWatchConfig({
    env: { SCANNER_SYMBOL_SOURCE: 'approved' },
    dataDir,
    repoRoot: tempRoot,
    approvedSymbols: ['AAA'],
    regularWatchStatus,
    dynamicHotListPath: path.join(dataDir, 'runtime', 'dynamic-hot-list.json'),
    attentionSymbols: ['AAA'],
    scannerSymbolSource: 'approved',
    currentDate: '2026-07-02T20:00:00.000Z',
  });
  const dynamic = resolveScannerWatchConfig({
    env: { SCANNER_SYMBOL_SOURCE: 'dynamic' },
    dataDir,
    repoRoot: tempRoot,
    approvedSymbols: ['AAA'],
    regularWatchStatus,
    dynamicHotListPath: path.join(dataDir, 'runtime', 'dynamic-hot-list.json'),
    scannerSymbolSource: 'dynamic',
    currentDate: '2026-07-02T20:00:00.000Z',
  });
  const hybrid = resolveScannerWatchConfig({
    env: { SCANNER_SYMBOL_SOURCE: 'hybrid' },
    dataDir,
    repoRoot: tempRoot,
    approvedSymbols: ['AAA'],
    regularWatchStatus,
    dynamicHotListPath: path.join(dataDir, 'runtime', 'dynamic-hot-list.json'),
    scannerSymbolSource: 'hybrid',
    currentDate: '2026-07-02T20:00:00.000Z',
  });

  assert.deepEqual(approved.attentionSymbols, ['AAA']);
  assert.equal(approved.scannerSymbolSource, 'approved');
  assert.equal(approved.sourceCounts.approved_source_count, 1);
  assert.equal(dynamic.scannerSymbolSource, 'dynamic');
  assert.deepEqual(dynamic.attentionSymbols.sort(), ['HOT', 'HOTT']);
  assert.equal(dynamic.dynamicSourceEmpty, false);
  assert.equal(dynamic.sourceCounts.dynamic_source_count, 2);
  assert.equal(dynamic.sourceCounts.regular_watch_source_count, 1);
  assert.equal(dynamic.sourceCounts.dynamic_hot_source_count, 2);
  assert.equal(dynamic.sourceCounts.hot_hot_source_count, 1);
  assert.equal(dynamic.sourceListsBySymbol.get('HOT').source_lists.includes('Regular Watch List'), true);
  assert.equal(dynamic.sourceListsBySymbol.get('HOT').source_lists.includes('Dynamic Hot List'), true);
  assert.equal(dynamic.sourceListsBySymbol.get('HOTT').source_lists.includes('Regular Watch Movers List'), true);
  assert.equal(dynamic.sourceListsBySymbol.get('HOTT').source_lists.includes('Hot Hot List'), true);
  assert.deepEqual(hybrid.attentionSymbols.sort(), ['AAA', 'HOT', 'HOTT']);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('stock scanner uses the dynamic source universe and records source metadata', async () => {
  const harness = createScannerHarness({
    env: {
      SCANNER_SYMBOL_SOURCE: 'dynamic',
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      TWELVEDATA_API_KEY: 'td-key',
    },
    snapshots: {
      AAA: rankedSnapshot({ bid: 9.90, ask: 10.10, previousClose: 9.50, volume: 1_000_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      HOT: rankedSnapshot({ bid: 19.90, ask: 20.10, previousClose: 19.50, volume: 200_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      HOTT: rankedSnapshot({ bid: 29.90, ask: 30.10, previousClose: 29.50, volume: 250_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    dynamicHotList: {
      generatedAt: '2099-07-02T20:00:00.000Z',
      lastScoredAt: '2099-07-02T20:00:00.000Z',
      mode: 'active',
      source: 'test',
      enabled: true,
      status: 'active',
      stale: false,
      dynamicHotList: [{
        symbol: 'HOT',
        memeHeatScore: 84,
        marketConfirmationScore: 82,
        status: 'dynamic_watch',
        reasonCodes: ['social_heat'],
        riskWarnings: [],
        expiresAt: '2099-07-05T15:00:00.000Z',
      }],
      hotHotList: [{
        symbol: 'HOTT',
        memeHeatScore: 95,
        marketConfirmationScore: 91,
        status: 'hot_hot',
        priorityOverrideEligible: true,
        reasonCodes: ['market_confirmation_passed'],
        riskWarnings: [],
        expiresAt: '2099-07-05T15:00:00.000Z',
      }],
      expired: [],
      rejected: [],
    },
    regularWatchStatus: {
      status: 'active',
      regularWatchList: [{ symbol: 'HOT', score: 62 }],
      regularWatchMovers: [{ symbol: 'HOTT', score: 74 }],
      universe: {
        source: 'alpaca_assets',
        full_eligible_count: 1250,
        current_batch_size: 500,
        rotation_batch_size: 450,
        fast_lane_candidate_count: 50,
        fast_lane_limit: 250,
        merged_scan_size: 500,
        displayed_top_limit: 100,
        scanned_today_count: 500,
        fresh_data_count: 480,
      },
      sources: [],
    },
  });

  try {
    const result = await harness.scanner.runOnce({ runId: 'dynamic-source-test' });
    const runtime = JSON.parse(fs.readFileSync(harness.scannerRuntimePath, 'utf8'));

    assert.equal(result.accepted, true);
    assert.deepEqual(harness.requestedSymbols.sort(), ['HOT', 'HOTT']);
    assert.equal(harness.requestedSymbols.includes('AAA'), false);
    assert.equal(runtime.scanner_symbol_source, 'dynamic');
    assert.equal(runtime.dynamic_source_empty, false);
    assert.equal(runtime.active_source_count, 2);
    assert.equal(runtime.source_counts.dynamic_source_count, 2);
    assert.equal(runtime.source_counts.regular_watch_source_count, 1);
    assert.equal(runtime.source_counts.regular_watch_full_universe_count, 1250);
    assert.equal(runtime.source_counts.regular_watch_current_batch_count, 500);
    assert.equal(runtime.source_counts.regular_watch_rotation_batch_count, 450);
    assert.equal(runtime.source_counts.regular_watch_fast_lane_count, 50);
    assert.equal(runtime.source_counts.regular_watch_merged_scan_size, 500);
    assert.equal(runtime.source_counts.regular_watch_scanned_today_count, 500);
    assert.equal(runtime.source_counts.regular_watch_fresh_data_count, 480);
    assert.equal(runtime.symbol_universe.full_eligible_count, 1250);
    assert.equal(runtime.source_lists_by_symbol.HOT.source_lists.includes('Regular Watch List'), true);
    assert.equal(runtime.source_lists_by_symbol.HOT.source_mode, 'dynamic');
    assert.equal(runtime.source_lists_by_symbol.HOTT.source_lists.includes('Regular Watch Movers List'), true);
    assert.equal(runtime.source_lists_by_symbol.HOTT.source_lists.includes('Hot Hot List'), true);
  } finally {
    harness.cleanup();
  }
});

test('stock scanner reports an empty dynamic source without falling back to the approved list', async () => {
  const harness = createScannerHarness({
    env: {
      SCANNER_SYMBOL_SOURCE: 'dynamic',
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      TWELVEDATA_API_KEY: 'td-key',
    },
    snapshots: {
      AAA: rankedSnapshot({ bid: 9.90, ask: 10.10, previousClose: 9.50, volume: 1_000_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    regularWatchStatus: {
      status: 'inactive',
      regularWatchList: [],
      regularWatchMovers: [],
      sources: [],
    },
    dynamicHotList: {
      generatedAt: '2026-07-02T20:00:00.000Z',
      lastScoredAt: '2026-07-02T20:00:00.000Z',
      mode: 'active',
      source: 'test',
      enabled: true,
      status: 'active',
      stale: false,
      dynamicHotList: [],
      hotHotList: [],
      expired: [],
      rejected: [],
    },
  });

  try {
    const result = await harness.scanner.runOnce({ runId: 'dynamic-empty-source-test' });
    const runtime = JSON.parse(fs.readFileSync(harness.scannerRuntimePath, 'utf8'));

    assert.equal(result.accepted, true);
    assert.deepEqual(harness.requestedSymbols, []);
    assert.equal(runtime.scanner_symbol_source, 'dynamic');
    assert.equal(runtime.dynamic_source_empty, true);
    assert.equal(runtime.active_source_count, 0);
    assert.equal(runtime.candidate_count, 0);
    assert.equal(runtime.preview_candidate_count, 0);
  } finally {
    harness.cleanup();
  }
});

test('stock scanner moves hot-hot candidates ahead when priority override is enabled but still obeys full-account blocks', async () => {
  const priorityHarness = createScannerHarness({
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
    },
    snapshots: {
      AAA: rankedSnapshot({ bid: 9.90, ask: 10.10, previousClose: 9.50, volume: 1_000_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      HOT: rankedSnapshot({ bid: 19.80, ask: 20.20, previousClose: 19.70, volume: 100_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    dynamicHotList: {
      generatedAt: '2026-07-01T00:00:00.000Z',
      lastScoredAt: '2026-07-01T00:00:00.000Z',
      mode: 'active',
      source: 'test',
      enabled: true,
      status: 'active',
      stale: false,
      dynamicHotList: [{
        symbol: 'HOT',
        memeHeatScore: 84,
        marketConfirmationScore: 82,
        status: 'hot_hot',
        priorityOverrideEligible: true,
        reasonCodes: ['market_confirmation_passed'],
        riskWarnings: [],
        expiresAt: '2026-07-02T15:00:00.000Z',
      }],
      hotHotList: [{
        symbol: 'HOT',
        memeHeatScore: 84,
        marketConfirmationScore: 82,
        status: 'hot_hot',
        priorityOverrideEligible: true,
        reasonCodes: ['market_confirmation_passed'],
        riskWarnings: [],
        expiresAt: '2026-07-02T15:00:00.000Z',
      }],
      expired: [],
      rejected: [],
    },
  });

  try {
    const result = await priorityHarness.scanner.runOnce({ runId: 'priority-enabled-test' });
    assert.equal(result.accepted, true);
    const aaaCandidate = buildStockCandidateForSymbol('AAA', stockSnapshot(), stockQuote(), {
      receivedAt: '2026-06-30T20:34:00.000Z',
      notional: 150,
      allowContrarianEntries: true,
      maxBuyRiskScore: 100,
    });
    const hotCandidate = buildStockCandidateForSymbol('HOT', rankedSnapshot({ bid: 19.80, ask: 20.20, previousClose: 19.70, volume: 100_000, timestamp: '2026-06-30T20:34:00.000Z' }), { bp: 19.80, ap: 20.20, t: '2026-06-30T20:34:00.000Z' }, {
      receivedAt: '2026-06-30T20:34:00.000Z',
      notional: 150,
      allowContrarianEntries: true,
      maxBuyRiskScore: 100,
    });
    const rankedWithoutOverride = rankScannerBuyCandidates([aaaCandidate, hotCandidate], { priorityOverrideSymbols: new Set() });
    const rankedWithOverride = rankScannerBuyCandidates([aaaCandidate, hotCandidate], { priorityOverrideSymbols: new Set(['HOT']) });
    assert.equal(rankedWithoutOverride[0]?.symbol, 'AAA');
    assert.equal(rankedWithOverride[0]?.symbol, 'HOT');
  } finally {
    priorityHarness.cleanup();
  }

  const blockedHarness = createScannerHarness({
    env: {
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'true',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
    },
    positions: [{ symbol: 'AAA', qty: '1' }],
    maxOpenPositions: 1,
    snapshots: {
      AAA: rankedSnapshot({ bid: 9.90, ask: 10.10, previousClose: 9.50, volume: 1_000_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      HOT: rankedSnapshot({ bid: 19.80, ask: 20.20, previousClose: 19.70, volume: 100_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    dynamicHotList: {
      generatedAt: '2026-07-01T00:00:00.000Z',
      lastScoredAt: '2026-07-01T00:00:00.000Z',
      mode: 'active',
      source: 'test',
      enabled: true,
      status: 'active',
      stale: false,
      dynamicHotList: [{
        symbol: 'HOT',
        memeHeatScore: 84,
        marketConfirmationScore: 82,
        status: 'hot_hot',
        priorityOverrideEligible: true,
        reasonCodes: ['market_confirmation_passed'],
        riskWarnings: [],
        expiresAt: '2026-07-02T15:00:00.000Z',
      }],
      hotHotList: [{
        symbol: 'HOT',
        memeHeatScore: 84,
        marketConfirmationScore: 82,
        status: 'hot_hot',
        priorityOverrideEligible: true,
        reasonCodes: ['market_confirmation_passed'],
        riskWarnings: [],
        expiresAt: '2026-07-02T15:00:00.000Z',
      }],
      expired: [],
      rejected: [],
    },
  });

  try {
    const result = await blockedHarness.scanner.runOnce({ runId: 'priority-blocked-test' });
    assert.equal(result.accepted, true);
    const watchConfig = resolveScannerWatchConfig({
      env: {
        ...blockedHarness.env,
      },
      repoRoot: blockedHarness.repoRoot,
      dataDir: blockedHarness.dataDir,
      currentDate: '2026-06-30T20:34:00.000Z',
      approvedSymbols: ['AAA'],
    });
    assert.equal(watchConfig.priorityOverrideSymbols.size, 1);
  } finally {
    blockedHarness.cleanup();
  }
});

test('stock scanner keeps regular watch ranking off by default and only boosts approved symbols when enabled', async () => {
  const baseRegularWatchState = {
    source: 'unit-test',
    features: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: { effective: true, status: 'active' },
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { effective: true, status: 'active' },
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: { effective: false, status: 'off' },
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { effective: false, status: 'off' },
    },
  };

  const offHarness = createScannerHarness({
    symbols: ['AAA', 'BBB'],
    env: {
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'false',
    },
    snapshots: {
      AAA: rankedSnapshot({ bid: 10.02, ask: 10.04, previousClose: 10, volume: 450_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      BBB: rankedSnapshot({ bid: 11.8, ask: 11.9, previousClose: 10, volume: 2_200_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    regularWatchState: baseRegularWatchState,
    regularWatchStatus: regularWatchStatusFixture([
      {
        symbol: 'AAA',
        score: 92,
        status: 'watching',
        sourceStatus: [{ source: 'wallstreetbets', tier: 'tier_1', status: 'active', lastScanAt: '2026-06-19T15:00:00.000Z' }],
        scannerWatched: true,
      },
      {
        symbol: 'BBB',
        score: 54,
        status: 'watching',
        sourceStatus: [{ source: 'stocks', tier: 'tier_2', status: 'active', lastScanAt: '2026-06-19T15:00:00.000Z' }],
        scannerWatched: true,
      },
      {
        symbol: 'ZZZ',
        score: 99,
        status: 'watching',
        sourceStatus: [{ source: 'wallstreetbets', tier: 'tier_1', status: 'active', lastScanAt: '2026-06-19T15:00:00.000Z' }],
        scannerWatched: false,
      },
    ], { scannerRanking: false, positionAwareness: false }),
  });

  try {
    await offHarness.scanner.runOnce({ runId: 'regular-watch-ranking-off' });
    const offRuntime = JSON.parse(fs.readFileSync(offHarness.scannerRuntimePath, 'utf8'));
    const offDetails = offRuntime.candidate_rank_details || [];
    assert.equal(offHarness.postedSymbols[0], 'BBB');
    assert.equal(offDetails.find((entry) => entry.symbol === 'AAA')?.regular_watch_comparison?.rankingApplied, false);
    assert.equal(offDetails.find((entry) => entry.symbol === 'AAA')?.regular_watch_comparison?.blockedReason, null);
    assert.equal(offDetails.some((entry) => entry.symbol === 'ZZZ'), false);
  } finally {
    offHarness.cleanup();
  }

  const onHarness = createScannerHarness({
    symbols: ['AAA', 'BBB'],
    env: {
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: 'true',
    },
    snapshots: {
      AAA: rankedSnapshot({ bid: 10.02, ask: 10.04, previousClose: 10, volume: 450_000, timestamp: '2026-06-19T15:00:00.000Z' }),
      BBB: rankedSnapshot({ bid: 11.8, ask: 11.9, previousClose: 10, volume: 2_200_000, timestamp: '2026-06-19T15:00:00.000Z' }),
    },
    regularWatchState: {
      source: 'unit-test',
      features: {
        REGULAR_WATCH_INTELLIGENCE_ENABLED: { effective: true, status: 'active' },
        REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { effective: true, status: 'active' },
        REGULAR_WATCH_SCANNER_RANKING_ENABLED: { effective: true, status: 'active' },
        REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { effective: true, status: 'active' },
      },
    },
    regularWatchStatus: regularWatchStatusFixture([
      {
        symbol: 'AAA',
        score: 96,
        status: 'watching',
        sourceStatus: [{ source: 'wallstreetbets', tier: 'tier_1', status: 'active', lastScanAt: '2026-06-19T15:00:00.000Z' }],
        scannerWatched: true,
      },
      {
        symbol: 'BBB',
        score: 52,
        status: 'watching',
        sourceStatus: [{ source: 'stocks', tier: 'tier_2', status: 'active', lastScanAt: '2026-06-19T15:00:00.000Z' }],
        scannerWatched: true,
      },
    ], { scannerRanking: true, positionAwareness: true }),
  });

  try {
    await onHarness.scanner.runOnce({ runId: 'regular-watch-ranking-on' });
    const onRuntime = JSON.parse(fs.readFileSync(onHarness.scannerRuntimePath, 'utf8'));
    const onDetails = onRuntime.candidate_rank_details || [];
    assert.equal(onHarness.postedSymbols[0], 'AAA');
    assert.equal(onDetails.find((entry) => entry.symbol === 'AAA')?.regular_watch_comparison?.rankingApplied, true);
    assert.ok(Number(onDetails.find((entry) => entry.symbol === 'AAA')?.regular_watch_comparison?.sortScore) > Number(onDetails.find((entry) => entry.symbol === 'BBB')?.regular_watch_comparison?.sortScore));
  } finally {
    onHarness.cleanup();
  }
});

test('stock scanner passes buying-power sizing mode through the full scanner path', async () => {
  const harness = createScannerHarness({
    env: {
      POSITION_SIZING_MODE: 'buying_power',
      RISK_BUDGET_SIZING_ENABLED: 'true',
      MAX_BUYING_POWER_DEPLOYMENT_PCT: '100',
      BUYING_POWER_CASH_RESERVE: '0',
      ALLOW_BUYING_POWER_FRACTIONAL_SHARES: 'false',
      MIN_STOP_DISTANCE_DOLLARS: '0.25',
      MAX_STOP_DISTANCE_DOLLARS: '2',
      MIN_BUY_NOTIONAL: '25',
    },
    symbols: ['MTAL'],
    snapshots: {
      MTAL: rankedSnapshot({
        bid: 5.07,
        ask: 5.09,
        previousClose: 5,
        volume: 100000,
        timestamp: '2026-06-16T20:00:00.000Z',
      }),
    },
    buyingPower: '194.68',
    cash: '194.68',
    maxOpenPositions: 1,
  });

  try {
    await harness.scanner.runOnce({ runId: 'buying-power-pass-through-test' });
    const runtime = JSON.parse(fs.readFileSync(harness.scannerRuntimePath, 'utf8'));
    const detail = runtime.candidate_rank_details.find((entry) => entry.symbol === 'MTAL');
    const sizingDetail = runtime.position_sizing.latest_candidates.find((entry) => entry.symbol === 'MTAL');

    assert.equal(runtime.position_sizing.mode, 'buying_power');
    assert(detail);
    assert.equal(detail.sizing_method, 'buying_power');
    assert(sizingDetail);
    assert.equal(sizingDetail.buying_power_sizing.accepted, true);
    assert.equal(sizingDetail.buying_power_sizing.quantity, 38);
    assert.equal(detail.risk_budget_sizing, null);
  } finally {
    harness.cleanup();
  }
});

test('stock scanner reports occupied slot as the no-buy reason even when candidates exist', async () => {
  const harness = createScannerHarness({
    symbols: ['MTAL'],
    snapshots: {
      MTAL: rankedSnapshot({
        bid: 5.07,
        ask: 5.09,
        previousClose: 5,
        volume: 100000,
        timestamp: '2026-06-16T20:00:00.000Z',
      }),
    },
    positions: [{ symbol: 'YHNAU', qty: '7' }],
    maxOpenPositions: 1,
  });

  try {
    await harness.scanner.runOnce({ runId: 'occupied-slot-waiting-reason-test' });
    const runtime = JSON.parse(fs.readFileSync(harness.scannerRuntimePath, 'utf8'));

    assert.equal(runtime.portfolio.open_positions_count, 1);
    assert.equal(runtime.portfolio.remaining_position_slots, 0);
    assert.equal(runtime.waiting_for_buy.reason_code, 'MAX_POSITION_SLOTS_FILLED');
    assert.match(runtime.waiting_for_buy.message, /slot is occupied/);
  } finally {
    harness.cleanup();
  }
});

function createScannerHarness({
  env = {},
  snapshots = {},
  dynamicHotList = null,
  positions = [],
  openOrders = [],
  buyingPower = '500',
  cash = '500',
  maxOpenPositions = 4,
  maxBuyRiskScore = 100,
  symbols = ['AAA'],
  regularWatchState = null,
  regularWatchStatus = null,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-scanner-watch-test-'));
  const dataDir = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });

  const featureEnv = {
    MEME_MONITOR_ENABLED: 'true',
    MEME_REDDIT_SCANNER_ENABLED: 'true',
    MEME_HOT_LIST_ENABLED: 'false',
    MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
    MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
    MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
    MAX_STALENESS_SECONDS: '20000000',
    SCANNER_SYMBOL_SOURCE: String(env.SCANNER_SYMBOL_SOURCE || env.MEME_DYNAMIC_WATCHLIST_ENABLED || '').toLowerCase() === 'true'
      ? 'dynamic'
      : 'approved',
    SCANNER_RUNTIME_STATE_PATH: path.join(dataDir, 'state', 'scanner-runtime.json'),
    ...env,
  };

  for (const key of ['MEME_MONITOR_ENABLED', 'MEME_REDDIT_SCANNER_ENABLED', 'MEME_HOT_LIST_ENABLED', 'MEME_DYNAMIC_WATCHLIST_ENABLED', 'MEME_PRIORITY_OVERRIDE_ENABLED', 'MEME_HOT_SLOT_ROTATION_ENABLED']) {
    updateMemeMonitorFeatureState({
      featureKey: key,
      enabled: featureEnv[key] === 'true',
      env: featureEnv,
      filePath: path.join(dataDir, 'state', 'meme-monitor-state.json'),
      changedBy: 'test',
      source: 'unit-test',
    });
  }

  if (dynamicHotList) {
    fs.writeFileSync(path.join(dataDir, 'runtime', 'dynamic-hot-list.json'), JSON.stringify(dynamicHotList, null, 2));
  }

  const requestedSymbols = [];
  const secondaryRequestedSymbols = [];
  const postedSymbols = [];

  const scanner = createStockScanner({
    enabled: true,
    baseUrl: 'https://data.alpaca.markets',
    localBaseUrl: 'http://127.0.0.1:65535',
    apiKeyId: 'key',
    apiSecretKey: 'secret',
    symbols,
    intervalMs: 60_000,
    maxCandidatesPerRun: 2,
    maxOpenPositions,
    maxBuyRiskScore,
    marketOpen: true,
    dataDir,
    repoRoot: tempRoot,
    env: featureEnv,
    runtimeStateEnabled: true,
    regularWatchState,
    regularWatchStatus,
    marketFetch: async (url) => {
      if (url.includes('/v2/positions')) return buildResponse(positions);
      if (url.includes('/v2/orders?status=open')) return buildResponse(openOrders);
      if (url.includes('/v2/account')) return buildResponse({ cash, buying_power: buyingPower });
      if (url.includes('/v2/stocks/snapshots?')) {
        const parsed = new URL(url);
        const symbolList = decodeURIComponent(parsed.searchParams.get('symbols') || '').split(',').map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
        requestedSymbols.push(...symbolList);
        const payload = {};
        for (const symbol of symbolList) {
          payload[symbol] = snapshots[symbol] || stockSnapshot();
        }
        return buildResponse({ snapshots: payload });
      }
      if (url.includes('/quote?symbol=')) {
        const parsed = new URL(url);
        const symbolList = decodeURIComponent(parsed.searchParams.get('symbol') || '').split(',').map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
        secondaryRequestedSymbols.push(...symbolList);
        return buildResponse({
          data: symbolList.map((symbol) => ({
            symbol,
            price: snapshots[symbol]?.latestTrade?.p || snapshots[symbol]?.latestQuote?.bp || 1,
            previous_close: snapshots[symbol]?.prevDailyBar?.c || snapshots[symbol]?.dailyBar?.c || 1,
            volume: snapshots[symbol]?.prevDailyBar?.v || snapshots[symbol]?.dailyBar?.v || 1,
            datetime: snapshots[symbol]?.latestTrade?.t || snapshots[symbol]?.latestQuote?.t || new Date().toISOString(),
          })),
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
    localFetch: async (_url, init = {}) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      postedSymbols.push(body.symbol);
      return buildResponse({ accepted: true, final_decision: 'approved_for_paper' });
    },
  });

  return {
    scanner,
    requestedSymbols,
    secondaryRequestedSymbols,
    postedSymbols,
    scannerRuntimePath: path.join(dataDir, 'state', 'scanner-runtime.json'),
    env: featureEnv,
    repoRoot: tempRoot,
    dataDir,
    cleanup: () => {
      try {
        scanner.stop();
      } catch {
        // Ignore cleanup issues in temp harness teardown.
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function stockSnapshot() {
  return {
    latestQuote: { bp: 79.95, ap: 80.05, t: '2026-06-16T20:00:00.000Z' },
    latestTrade: { p: 80, t: '2026-06-16T20:00:00.000Z' },
    minuteBar: { v: 50, h: 80.5, l: 79.5, t: '2026-06-16T20:00:00.000Z' },
    prevDailyBar: { c: 79, v: 100000 },
  };
}

function stockQuote() {
  return { bp: 79.95, ap: 80.05, t: '2026-06-16T20:00:00.000Z' };
}

function rankedSnapshot({ bid, ask, previousClose, volume, timestamp }) {
  const midpoint = (bid + ask) / 2;
  return {
    latestQuote: { bp: bid, ap: ask, t: timestamp },
    latestTrade: { p: midpoint, t: timestamp },
    minuteBar: { v: 50, h: midpoint + 0.5, l: midpoint - 0.5, t: timestamp },
    prevDailyBar: { c: previousClose, v: volume },
  };
}

function regularWatchStatusFixture(entries = [], overrides = {}) {
  const now = overrides.now || '2026-06-30T14:05:00.000Z';
  return {
    version: '2026-06-30.regular-watch-status.2',
    updated_at: now,
    enabled: true,
    regularWatchIntelligence: {
      enabled: true,
      status: overrides.status || 'active',
      lastRunAt: now,
      lastError: null,
      symbolsChecked: entries.length,
      moversFound: entries.length,
      blockedSymbols: 0,
      features: {
        marketConfirmation: true,
        assetValidation: true,
        haltCheck: true,
        secRiskCheck: true,
        newsCatalyst: false,
        priorityScoring: true,
        scannerRanking: Boolean(overrides.scannerRanking),
        positionAwareness: Boolean(overrides.positionAwareness),
      },
    },
    scannerRanking: {
      enabled: Boolean(overrides.scannerRanking),
      status: overrides.scannerRanking ? (overrides.status || 'active') : 'off',
      lastRunAt: now,
      lastError: null,
    },
    positionAwareness: {
      enabled: Boolean(overrides.positionAwareness),
      status: overrides.positionAwareness ? (overrides.status || 'active') : 'off',
      lastRunAt: now,
      lastError: null,
    },
    regularWatchList: entries,
    regularWatchMovers: entries.slice(0, 2),
    sources: overrides.sources || [],
    generatedAt: now,
    stale: false,
    status: overrides.status || 'active',
    lastRunAt: now,
    lastError: null,
  };
}

function stopExitRecord(symbol, filledAt, pnl, orderId) {
  return {
    entry_type: 'paper_outcome',
    record: {
      symbol,
      side: 'sell',
      pnl,
      recorded_at: filledAt,
      paper_result: {
        status: 'filled',
        filled_at: filledAt,
        order_id: orderId,
      },
      original_signal: {
        market_context: {
          exit_state: {
            exit_reason: 'STOP_LOSS_DOLLARS',
            unrealized_pl: pnl,
          },
        },
      },
    },
  };
}

function buildResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    },
  };
}
