const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createDashboardServer, buildDashboardSnapshot, resolveDashboardPort } = require('../src/dashboard-server');
const { shouldAutoOpenBrowser } = require('../scripts/dashboard-cli');

test('dashboard snapshot aggregates read-only endpoints and local files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-06-19',
    timestamp: '2026-06-19T15:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), JSON.stringify({
    scanner: 'stock-scanner',
    mode: 'live-market',
    last_scan_time: '2026-06-19T15:01:00.000Z',
    last_scan_duration_ms: 42,
    candidate_rank_details: [{
      symbol: 'SPCX',
      rank_score: 68,
      adjusted_rank_score: 68,
      current_price: 10.2,
      previous_close: 9.9,
      move_pct: 3.03,
      spread_pct: 0.22,
      volume: 1_200_000,
      average_volume: 800_000,
      volume_multiple: 1.5,
      tradable_status: 'tradable',
      halt_status: 'not_halted',
      source_status: [{
        source: 'wallstreetbets',
        tier: 'tier_1',
        status: 'active',
        lastScanAt: '2026-06-19T15:01:00.000Z',
        lastError: null,
        symbolsDetected: 4,
        blockedReason: null,
      }],
    }],
    recent_skips: [],
    hot_slot_rotation: {
      enabled: false,
      status: 'off',
      lastDecision: 'rotation_off',
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'live-policy.json'), JSON.stringify({
    source: 'startup-config',
    policy: {
      minConfidenceForPaper: 72,
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), [
    JSON.stringify({ entry_type: 'paper_outcome', record: { symbol: 'AAPL', side: 'buy', quantity: 2, paper_result: { filled_quantity: 2, average_fill_price: 101.12, filled_at: '2026-06-19T15:00:01.000Z', order_id: 'ord-1', status: 'filled' }, pnl: 1.25, adjusted_pnl: 1.1, execution_drag: 0.15, win_loss: 'win', calibration_bucket: '80-89', recorded_at: '2026-06-19T15:00:01.000Z' } }),
    JSON.stringify({ entry_type: 'paper_outcome', record: { symbol: 'AAPL', side: 'sell', quantity: 1, paper_result: { filled_quantity: 1, average_fill_price: 102.5, filled_at: '2026-06-19T15:04:01.000Z', order_id: 'ord-2', status: 'filled' }, pnl: 0.25, adjusted_pnl: 0.2, execution_drag: 0.05, win_loss: 'win', calibration_bucket: '80-89', recorded_at: '2026-06-19T15:04:01.000Z' } }),
    JSON.stringify({ entry_type: 'risk_decision', record: { decision: 'BLOCKED', reason_codes: ['LOW_CONFIDENCE'], recorded_at: '2026-06-19T15:00:02.000Z' } }),
  ].join('\n'));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'anti-churn-state.json'), JSON.stringify({
    version: '2026-06-25.anti-churn-state.1',
    updated_at: '2026-06-19T15:05:00.000Z',
    last_reconciled_at: '2026-06-19T15:05:00.000Z',
    symbol_cooldowns: {
      AAPL: {
        symbol: 'AAPL',
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
    recent_classifications: [
      {
        symbol: 'AAPL',
        classification: 'clean_win',
        penalty_points: 0,
        cooldown_seconds: 0,
        cooldown_until: null,
        reason_codes: ['RECENT_WINNER_PROTECTED', 'CLEAN_WIN_NO_PENALTY'],
        recent_winner_protected: true,
      },
    ],
    churn_guard: {
      active: true,
      triggered_at: '2026-06-19T15:05:00.000Z',
      expires_at: '2026-06-19T15:35:00.000Z',
      window_seconds: 1800,
      trade_count: 4,
      churn_score: 88,
      reason_codes: ['CHURN_RATE_GUARD_ACTIVE', 'RAPID_ROUND_TRIP_CHURN'],
      explanation: 'Churn guard active.',
      indicators: { rapid_round_trip_count: 3 },
    },
    recent_winner_protection: {
      AAPL: {
        symbol: 'AAPL',
        cooldown_until: null,
        remaining_seconds: 0,
        penalty: 0,
        reason_codes: ['RECENT_WINNER_PROTECTED', 'CLEAN_WIN_NO_PENALTY'],
        recent_winner_protected: true,
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'setup-fatigue-state.json'), JSON.stringify({
    version: '2026-06-25.setup-fatigue-state.1',
    updated_at: '2026-06-19T15:05:00.000Z',
    last_reconciled_at: '2026-06-19T15:05:00.000Z',
    setups: {
      'mu-breakout': {
        setup_key: 'mu-breakout',
        recent_trades: 4,
        recent_losses: 3,
        recent_stopouts: 2,
        recent_wins: 1,
        net_pnl: -2.4,
        last_failure_at: '2026-06-19T15:04:00.000Z',
        last_success_at: '2026-06-19T14:30:00.000Z',
        fatigue_score: 72,
        paused_until: '2026-06-19T15:35:00.000Z',
        active: true,
        reason_codes: ['SETUP_FATIGUE_RECENT_LOSS', 'SETUP_FATIGUE_ACTIVE'],
        explanation: 'Setup fatigue score 72 of threshold 60.',
        warnings: [],
        recent_outcomes: [],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), JSON.stringify({
    source: 'startup-config',
    captured_at: '2026-06-19T14:46:40.126Z',
    policy: {
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
      minConfidenceForPaper: 72,
    },
  }) + '\n');
  fs.writeFileSync(path.join(dataDir, 'runtime', 'live-preflight-latest.json'), JSON.stringify({
    status: 'WARN',
    checked_at: '2026-06-19T14:59:00.000Z',
    critical_failures: [],
    warnings: ['ENV_CHANGED_AFTER_START_RESTART_REQUIRED'],
    policy: {
      health: {
        status: 'WARN',
        warnings: ['POLICY_STALE'],
        critical_failures: [],
        deprecated_fields: [],
        suspicious_fields: [],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'broker-local-reconciliation-latest.json'), JSON.stringify({
    status: 'WARN',
    checked_at: '2026-06-19T15:00:30.000Z',
    warnings: ['STALE_TRAILING_STATE'],
    critical_failures: [],
    mismatches: [{ type: 'STALE_TRAILING_STATE', symbol: 'AAPL', severity: 'warning' }],
    local_phantom_positions: [],
    broker_positions_missing_locally: [],
    quantity_mismatches: [],
    open_order_mismatches: [],
    trailing_state_mismatches: [{ type: 'STALE_TRAILING_STATE', symbol: 'AAPL' }],
    pnl_mismatches: [],
    recommended_actions: ['Refresh scanner/trailing runtime state so exits remain explainable.'],
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'partial-fill-state.json'), JSON.stringify({
    version: '2026-06-25.partial-fill-state.1',
    updated_at: '2026-06-19T15:01:00.000Z',
    last_reconciled_at: '2026-06-19T15:01:00.000Z',
    orders: {
      'ord-partial-aapl': {
        order_id: 'ord-partial-aapl',
        client_order_id: 'client-partial-aapl',
        symbol: 'AAPL',
        side: 'buy',
        submitted_qty: 2,
        filled_qty: 1,
        remaining_qty: 1,
        submitted_notional: 202,
        filled_notional: 101,
        average_fill_price: 101,
        status: 'partially_filled',
        first_seen_at: '2026-06-19T15:00:00.000Z',
        last_seen_at: '2026-06-19T15:01:00.000Z',
        last_reconciled_at: '2026-06-19T15:01:00.000Z',
        warnings: [],
        reason_codes: ['PARTIAL_FILL_PENDING'],
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'execution-quality-state.json'), JSON.stringify({
    version: '2026-06-25.execution-quality-state.1',
    updated_at: '2026-06-19T15:01:30.000Z',
    last_reconciled_at: '2026-06-19T15:01:30.000Z',
    entries: {
      'MU::mu-breakout::buy::regular': {
        key: 'MU::mu-breakout::buy::regular',
        symbol: 'MU',
        setup_key: 'mu-breakout',
        side: 'buy',
        time_regime: 'regular',
        trade_count: 1,
        average_quality_score: 54,
        average_slippage: 1.9,
        average_execution_drag: 0.5,
        partial_fill_count: 0,
        rejection_count: 0,
        cancellation_count: 0,
        duplicate_risk_count: 0,
        last_bad_execution_at: '2026-06-19T15:01:30.000Z',
        penalty_points: 46,
        size_multiplier: 0.77,
        updated_at: '2026-06-19T15:01:30.000Z',
        recent_records: [{
          timestamp: '2026-06-19T15:01:30.000Z',
          classification: 'bad_fill',
          execution_quality_score: 54,
          execution_penalty_points: 46,
          slippage: 1.9,
          execution_drag: 0.5,
          reason_codes: ['BAD_FILL_SLIPPAGE'],
        }],
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
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'candidate-lifecycle-state.json'), JSON.stringify({
    version: '2026-06-25.candidate-lifecycle-state.1',
    updated_at: '2026-06-19T15:02:00.000Z',
    last_reconciled_at: '2026-06-19T15:02:00.000Z',
    mode: 'hunt',
    queue_enabled: true,
    selected_key: 'MU::mu-breakout',
    selection_state: {
      selected_key: 'MU::mu-breakout',
      selected_symbol: 'MU',
      selected_rank: 71.2,
      selected_decayed_rank: 69.8,
      selected_at: '2026-06-19T15:02:00.000Z',
      hold_scans: 2,
    },
    queue_state: {
      soft_band_points: 4,
      hard_band_points: 12,
      min_hold_scans: 2,
      rank_floor: 60,
      last_rotation_at: '2026-06-19T15:01:30.000Z',
      last_rotation_reason_codes: ['CANDIDATE_QUEUE_CONFIRMED'],
    },
    candidates: {
      'MU::mu-breakout': {
        candidate_key: 'MU::mu-breakout',
        symbol: 'MU',
        setup_key: 'mu-breakout',
        first_seen_at: '2026-06-19T14:59:30.000Z',
        last_seen_at: '2026-06-19T15:02:00.000Z',
        scans_seen: 3,
        latest_rank: 71.2,
        peak_rank: 72,
        decayed_rank: 69.8,
        rank_history: [],
        status: 'entered',
        expires_at: null,
        reason_codes: ['CANDIDATE_QUEUE_CONFIRMED'],
        updated_at: '2026-06-19T15:02:00.000Z',
      },
      'WDC::wdc-breakout': {
        candidate_key: 'WDC::wdc-breakout',
        symbol: 'WDC',
        setup_key: 'wdc-breakout',
        first_seen_at: '2026-06-19T15:01:30.000Z',
        last_seen_at: '2026-06-19T15:02:00.000Z',
        scans_seen: 1,
        latest_rank: 59.3,
        peak_rank: 59.3,
        decayed_rank: 59.3,
        rank_history: [],
        status: 'blocked',
        expires_at: null,
        reason_codes: ['CANDIDATE_RANK_BELOW_FLOOR'],
        updated_at: '2026-06-19T15:02:00.000Z',
      },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), JSON.stringify({
    scanner: 'stock-scanner',
    mode: 'live-market',
    last_scan_time: '2026-06-19T15:01:00.000Z',
    risk_budget_sizing: {
      enabled: true,
      max_risk_per_trade_dollars: 1,
      latest_candidates: [{
        symbol: 'MU',
        sizing_method: 'risk_budget',
        risk_budget_sizing: { accepted: true, notional: 120, quantity: 1.5 },
        structure_stop: { accepted: true, method: 'swing_low', stop_distance: 0.5 },
      }],
    },
    setup_fatigue_summary: {
      setup_count: 1,
      active_setup_count: 1,
      paused_setup_count: 1,
      active_setups: [{
        setup_key: 'mu-breakout',
        fatigue_score: 72,
        paused_until: '2026-06-19T15:35:00.000Z',
        active: true,
        reason_codes: ['SETUP_FATIGUE_ACTIVE'],
      }],
      paused_setups: [{
        setup_key: 'mu-breakout',
        fatigue_score: 72,
        paused_until: '2026-06-19T15:35:00.000Z',
        active: true,
        reason_codes: ['SETUP_FATIGUE_ACTIVE'],
      }],
      warnings: ['SETUP_FATIGUE_ACTIVE'],
      recommended_actions: ['Avoid new buys in setups flagged by setup fatigue until pauses clear.'],
      last_reconciled_at: '2026-06-19T15:05:00.000Z',
    },
    candidate_lifecycle_summary: {
      status: 'ACTIVE',
      queue_enabled: true,
      scanner_mode: 'hunt',
      selected_key: 'MU::mu-breakout',
      selected_symbol: 'MU',
      selected_rank: 71.2,
      selected_decayed_rank: 69.8,
      watched_count: 0,
      eligible_count: 1,
      entered_count: 1,
      expired_count: 0,
      blocked_count: 1,
      total_count: 2,
      watched_candidates: [],
      eligible_candidates: [{
        candidate_key: 'MU::mu-breakout',
        symbol: 'MU',
        status: 'eligible',
      }],
      entered_candidates: [{
        candidate_key: 'MU::mu-breakout',
        symbol: 'MU',
        status: 'entered',
      }],
      expired_candidates: [],
      blocked_candidates: [{
        candidate_key: 'WDC::wdc-breakout',
        symbol: 'WDC',
        status: 'blocked',
      }],
      rank_floor: 60,
      queue_state: {
        soft_band_points: 4,
        hard_band_points: 12,
        min_hold_scans: 2,
        rank_floor: 60,
        last_rotation_at: '2026-06-19T15:01:30.000Z',
        last_rotation_reason_codes: ['CANDIDATE_QUEUE_CONFIRMED'],
      },
      selection_state: {
        selected_key: 'MU::mu-breakout',
        selected_symbol: 'MU',
        selected_rank: 71.2,
        selected_decayed_rank: 69.8,
        selected_at: '2026-06-19T15:02:00.000Z',
        hold_scans: 2,
      },
      rotation_decision: {
        selected_key: 'MU::mu-breakout',
        last_rotation_at: '2026-06-19T15:01:30.000Z',
        last_rotation_reason_codes: ['CANDIDATE_QUEUE_CONFIRMED'],
      },
      reason_codes: ['CANDIDATE_QUEUE_CONFIRMED', 'CANDIDATE_RANK_BELOW_FLOOR'],
      warnings: ['BLOCKED_CANDIDATES_PRESENT'],
      recommended_actions: ['Review blocked candidates and lift the blocker if the setup should be allowed.'],
      last_reconciled_at: '2026-06-19T15:02:00.000Z',
    },
    session_guards: {
      status: 'ACTIVE',
      active_guards: [{
        guard: 'setup_fatigue',
        active: true,
        expires_at: '2026-06-19T15:35:00.000Z',
        reason_codes: ['SETUP_FATIGUE_ACTIVE'],
        explanation: 'Setup fatigue is active.',
      }],
      buy_blocked: true,
      sells_allowed: true,
      manage_only: true,
      reason_codes: ['SETUP_FATIGUE_ACTIVE', 'MANAGE_ONLY_MODE_ACTIVE'],
      expires_at: '2026-06-19T15:35:00.000Z',
      explanation: 'Setup fatigue is active.',
      intraday_regime: {
        regime: 'opening_noise',
        market_open: true,
        manage_only: true,
        buys_allowed: false,
        sells_allowed: true,
        reason_code: 'OPENING_NOISE_MANAGE_ONLY',
      },
      metrics: {
        recent_trade_count: 2,
        daily_pnl: -2.6,
        rolling_drawdown: -2.6,
        consecutive_losses: 2,
        stopout_count: 2,
        win_rate: 0,
        churn_score: 2,
      },
      setup_fatigue_summary: {
        setup_count: 1,
        active_setup_count: 1,
        paused_setup_count: 1,
      },
    },
  }, null, 2));

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 4, blocked_count: 1, approved_count: 3, paper_pnl: 2.5, execution_drag: 0, drawdown: 0.1, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { accepted: true, tuning: { recommended_tuning_notes: ['Keep the floor tight.'] } },
      '/policy-effectiveness': { accepted: true, policy_effectiveness: { intervals: [] } },
      '/overnight-status': { accepted: true, status: 'ok', mode: 'minimal-v1' },
    };
    const payload = payloads[req.url];
    res.setHeader('content-type', 'application/json');
    if (!payload) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;

  const snapshot = await buildDashboardSnapshot({
    traderBaseUrl: baseUrl,
    port: 1111,
    dataDir,
    nowProvider: () => new Date('2026-06-17T12:00:00Z'),
    env: {
      ALPACA_API_KEY_ID: '',
      ALPACA_API_SECRET_KEY: '',
      ALPACA_API_BASE_URL: '',
      MAX_OPEN_POSITIONS: '1',
      BUY_NOTIONAL_TARGET: '150',
      MIN_BUY_NOTIONAL: '25',
      STOCK_SCANNER_SYMBOLS: 'SPCX,SMCI,FDX,MU,APGE,NVDA,IBM,INTC,MRVL,MARA,IREN,GOOGL,FCEL,CBRS,VIX,AMO,SNDK,VTAK',
      POSITION_STOP_LOSS_DOLLARS: '1',
      POSITION_STOP_LOSS_NOTIONAL_PCT: '0.75',
      POSITION_STOP_LOSS_MAX_DOLLARS: '2.50',
      TRAILING_PROFIT_START_DOLLARS: '0.50',
      TRAILING_PROFIT_GIVEBACK_DOLLARS: '0.30',
      RISK_BUDGET_SIZING_ENABLED: 'true',
      MAX_RISK_PER_TRADE_DOLLARS: '1',
      MAX_RISK_PER_TRADE_PCT_EQUITY: '0.5',
      MAX_TRADE_NOTIONAL: '150',
      MIN_STOP_DISTANCE_DOLLARS: '0.25',
      MAX_STOP_DISTANCE_DOLLARS: '2',
      ALLOW_RISK_BUDGET_FRACTIONAL_SHARES: 'true',
      RISK_BUDGET_REQUIRE_BROKER_EQUITY: 'true',
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    fetchImpl: global.fetch,
  }, {
    dataDir,
  }, {});

  await new Promise((resolve) => trader.close(resolve));

  assert.equal(snapshot.dashboard.port, 1111);
  assert.equal(snapshot.dashboard.trader_base_url, baseUrl);
  assert(snapshot.dashboard.runtime_version);
  assert.equal(snapshot.live.exit_management.state, 'unmanaged');
  assert.equal(snapshot.live.preflight.status, 'WARN');
  assert.equal(snapshot.live.policy_health.status, 'WARN');
  assert.equal(snapshot.summary.preflight_status, 'WARN');
  assert.equal(snapshot.live.broker_local_reconciliation.status, 'WARN');
  assert.equal(snapshot.live.reconciliation_summary.mismatch_count, 1);
  assert.equal(snapshot.live.partial_fill_summary.count, 1);
  assert.equal(snapshot.live.execution_quality_summary.total_trades, 1);
  assert.equal(snapshot.live.execution_quality_summary.by_symbol[0].symbol, 'MU');
  assert.deepEqual(snapshot.live.partial_fill_summary.blocked_symbols, ['AAPL']);
  assert.equal(snapshot.live.candidate_lifecycle_summary.queue_enabled, true);
  assert.equal(snapshot.live.candidate_lifecycle_summary.selected_symbol, 'MU');
  assert.equal(snapshot.live.candidate_lifecycle_summary.blocked_count, 1);
  assert.equal(snapshot.live.anti_churn_summary.active_churn_guard, true);
  assert.equal(snapshot.live.anti_churn_summary.symbols_under_cooldown.length, 0);
  assert.equal(snapshot.live.anti_churn_summary.recent_winner_protection.length, 1);
  assert.equal(snapshot.live.setup_fatigue_summary.active_setup_count, 1);
  assert.equal(snapshot.live.meme_monitor_state.summary.master_enabled, false);
  assert.deepEqual(snapshot.live.meme_monitor_state.summary.blocked_features, []);
  assert.equal(snapshot.live.session_guards.buy_blocked, true);
  assert.equal(snapshot.live.session_guards.manage_only, true);
  assert.equal(snapshot.live.risk_budget_sizing.config.enabled, true);
  assert.equal(snapshot.live.risk_budget_sizing.config.max_risk_per_trade_dollars, 1);
  assert.equal(snapshot.live.risk_budget_sizing.runtime.enabled, true);
  assert.equal(snapshot.live.risk_budget_sizing.latest_candidates[0].symbol, 'MU');
  assert.equal(snapshot.summary.reconciliation_status, 'WARN');
  assert.equal(snapshot.summary.reconciliation_mismatch_count, 1);
  assert.equal(snapshot.summary.partial_fill_count, 1);
  assert.equal(snapshot.summary.execution_quality_total_trades, 1);
  assert.equal(snapshot.summary.execution_quality_average_score, 54);
  assert.equal(snapshot.summary.candidate_lifecycle_queue_enabled, true);
  assert.equal(snapshot.summary.candidate_lifecycle_selected_symbol, 'MU');
  assert.equal(snapshot.summary.candidate_lifecycle_blocked_count, 1);
  assert.equal(snapshot.summary.anti_churn_active, true);
  assert.equal(snapshot.summary.anti_churn_reason_codes[0], 'CHURN_RATE_GUARD_ACTIVE');
  assert.equal(snapshot.summary.setup_fatigue_active_count, 1);
  assert.equal(snapshot.summary.session_guard_buy_blocked, true);
  assert.equal(snapshot.summary.meme_monitor_enabled, false);
  assert.deepEqual(snapshot.summary.meme_monitor_blocked_features, []);
  assert.equal(snapshot.summary.risk_budget_sizing_enabled, true);
  assert.equal(snapshot.summary.risk_budget_latest_candidate_count, 1);
  assert.equal(snapshot.watch.dynamicHotList.status, 'disabled');
  assert.equal(snapshot.watch.hotHotList.status, 'disabled');
  assert.equal(snapshot.memeMonitor.dynamicWatchlist.status, 'blocked');
  assert.equal(snapshot.memeMonitor.priorityOverride.status, 'blocked');
  assert.equal(snapshot.file_snapshots.live_preflight.exists, true);
  assert.equal(snapshot.file_snapshots.broker_local_reconciliation.exists, true);
  assert.equal(snapshot.file_snapshots.partial_fill_state.exists, true);
  assert.equal(snapshot.file_snapshots.candidate_lifecycle_state.exists, true);
  assert.equal(snapshot.file_snapshots.anti_churn_state.exists, true);
  assert.equal(snapshot.file_snapshots.setup_fatigue_state.exists, true);
  assert.equal(snapshot.file_snapshots.meme_monitor_state.exists, false);
  assert.equal(typeof snapshot.live.config_drift.has_drift, 'boolean');
  assert.equal(snapshot.summary.trader_status, 'ok');
  assert.equal(snapshot.summary.paper_pnl, 2.5);
  assert.equal(snapshot.live.report.execution_drag, 0);
  assert.equal(snapshot.summary.blocked_count, 1);
  assert.equal(snapshot.summary.approved_count, 3);
  assert.equal(snapshot.regime.workflow, 'Live Market');
  assert.deepEqual(snapshot.regime.approved_symbols, ['SPCX', 'SMCI', 'FDX', 'MU', 'APGE', 'NVDA', 'IBM', 'INTC', 'MRVL', 'MARA', 'IREN', 'GOOGL', 'FCEL', 'CBRS', 'VIX', 'AMO', 'SNDK', 'VTAK']);
  assert.equal(snapshot.regime.stop_loss_dollars, 1);
  assert.equal(snapshot.regime.stop_loss_notional_pct, 0.75);
  assert.equal(snapshot.regime.stop_loss_max_dollars, 2.5);
  assert.equal(snapshot.regime.trailing_profit_start_dollars, 0.5);
  assert.equal(snapshot.regime.trailing_profit_giveback_dollars, 0.3);
  assert.equal(snapshot.automation.live_market.current.market_day, true);
  assert.equal(snapshot.automation.live_market.start.today, true);
  assert.equal(snapshot.automation.live_market.stop.today, true);
  assert(snapshot.automation.live_market.start.label.includes('8:30 AM ET'));
  assert.equal(snapshot.live.policy.policy.maxOpenPositions, 9);
  assert.equal(snapshot.recent_activity.paperOutcomes.length, 2);
  assert.equal(snapshot.recent_activity.orders.length, 2);
  assert.equal(snapshot.recent_activity.derived_open_positions.length, 1);
  assert.equal(snapshot.summary.open_positions_count, 1);
  assert.equal(snapshot.summary.open_positions_count_source, 'derived');
  assert.equal(snapshot.summary.last_trade_at, '2026-06-19T15:04:01.000Z');
  assert.equal(snapshot.recent_activity.riskDecisions.length, 1);
  assert(snapshot.source_health.length >= 5);
});

test('dashboard snapshot includes watch data when watch fixtures exist', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-watch-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), JSON.stringify({
    scanner: 'stock-scanner',
    mode: 'live-market',
    last_scan_time: '2026-06-19T15:01:00.000Z',
    candidate_rank_details: [{
      symbol: 'AMO',
      current_price: 121.24,
      previous_close: 118.50,
      move_pct: 2.31,
      spread_pct: 0.18,
      volume: 5200000,
      average_volume: 2100000,
      volume_multiple: 2.48,
      rank_score: 88.4,
      adjusted_rank_score: 88.4,
      reason_codes: ['volume_confirmed'],
      candidate_lifecycle_reason_codes: ['CANDIDATE_QUEUE_CONFIRMED'],
    }],
    recent_skips: [{ symbol: 'IBM', reason: 'EXCLUDED_BUY_SYMBOL' }],
    risk_budget_sizing: { enabled: true, latest_candidates: [] },
    hot_slot_rotation: {
      requested: true,
      enabled: true,
      status: 'active',
      lastDecision: 'rotation_complete',
      lastDecisionAt: '2026-06-19T15:03:00.000Z',
      candidate: 'SOUN',
      candidateHeatScore: 94,
      candidateMarketScore: 82,
      accountFull: true,
      evictionCandidate: 'MARA',
      evictionReason: 'small_profit_weak_momentum',
      expectedExitPnl: 0.72,
      decision: 'rotation_complete',
      reasonCodes: ['hot_slot_rotation_requested', 'rotation_eviction_candidate_selected', 'rotation_complete'],
      rotationEligible: true,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'state', 'meme-monitor-state.json'), JSON.stringify({
    version: '2026-06-30.meme-monitor-state.1',
    updated_at: '2026-06-19T15:00:00.000Z',
    source: 'unit-test',
    features: {
      MEME_MONITOR_ENABLED: { key: 'MEME_MONITOR_ENABLED', runtime: true, changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      MEME_REDDIT_SCANNER_ENABLED: { key: 'MEME_REDDIT_SCANNER_ENABLED', runtime: true, changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      MEME_HOT_LIST_ENABLED: { key: 'MEME_HOT_LIST_ENABLED', runtime: true, changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      MEME_DYNAMIC_WATCHLIST_ENABLED: { key: 'MEME_DYNAMIC_WATCHLIST_ENABLED', runtime: true, changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      MEME_PRIORITY_OVERRIDE_ENABLED: { key: 'MEME_PRIORITY_OVERRIDE_ENABLED', runtime: false, changed_at: null, changed_by: null, source: null },
      MEME_HOT_SLOT_ROTATION_ENABLED: { key: 'MEME_HOT_SLOT_ROTATION_ENABLED', runtime: false, changed_at: null, changed_by: null, source: null },
      MEME_AUTO_ACTION_ENABLED: { key: 'MEME_AUTO_ACTION_ENABLED', runtime: false, changed_at: null, changed_by: null, source: null },
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'meme-monitor-status.json'), JSON.stringify({
    version: '2026-06-30.meme-monitor-status.1',
    updated_at: '2026-06-19T15:02:00.000Z',
    enabled: true,
    redditScanner: {
      enabled: true,
      status: 'shadow',
      lastRunAt: '2026-06-19T15:02:00.000Z',
      lastError: null,
      sources: ['wallstreetbets'],
      symbolsDetected: 2,
      rejectedTokens: 0,
      mode: 'shadow',
    },
    hotList: {
      enabled: true,
      status: 'shadow',
      dynamicCount: 1,
      hotHotCount: 1,
      lastScoredAt: '2026-06-19T15:02:00.000Z',
      stale: false,
      lastError: null,
    },
    hotHotScoring: {
      enabled: true,
      status: 'active',
      lastScoredAt: '2026-06-19T15:02:00.000Z',
      lastError: null,
      stale: false,
    },
    phaseA: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-06-30T14:05:00.000Z',
      lastError: null,
      sources: {
        reddit: { source: 'reddit', tier: 'tier_1', status: 'active', lastScanAt: '2026-06-30T14:05:00.000Z', symbolsDetected: 4, blockedReason: null },
        alpacaMarket: { source: 'alpacaMarket', tier: 'tier_1', status: 'active', lastScanAt: '2026-06-30T14:05:00.000Z', symbolsConfirmed: 1, blockedReason: null },
        alpacaAssets: { source: 'alpacaAssets', tier: 'tier_1', status: 'inactive', lastScanAt: null, lastError: 'blocked', blockedReason: 'source_not_found_or_inaccessible' },
        nasdaqHalts: { source: 'nasdaqHalts', tier: 'tier_1', status: 'active', lastScanAt: '2026-06-30T14:05:00.000Z', blockedSymbols: 0, blockedReason: null },
        secEdgar: { source: 'secEdgar', tier: 'tier_1', status: 'active', lastScanAt: '2026-06-30T14:05:00.000Z', catalystsDetected: 1, blockedReason: null },
      },
      symbols: [
        {
          symbol: 'SOUN',
          socialHeatScore: 12,
          marketConfirmationScore: 84,
          catalystScore: 25,
          riskBlockScore: 0,
          haltStatus: 'not_halted',
          tradableStatus: 'tradable',
          status: 'active',
          sourceConfirmations: { reddit: true, alpacaMarket: true, alpacaAssets: false, nasdaqHalts: true, secEdgar: true },
          reasonCodes: ['reddit_tier_1_signal', 'sec_recent_8k_detected'],
          riskWarnings: [],
          rawSummary: {},
          sources: ['reddit/tier_1:ACTIVE', 'alpacaMarket/tier_1:ACTIVE'],
        },
      ],
    },
    phaseB: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-06-30T14:06:00.000Z',
      lastError: null,
      sources: {
        stocktwits: { source: 'stocktwits', status: 'active', lastScanAt: '2026-06-30T14:06:00.000Z', symbolsDetected: 1, blockedReason: null },
        polygon: { source: 'polygon', status: 'active', lastScanAt: '2026-06-30T14:06:00.000Z', symbolsConfirmed: 1, blockedReason: null },
        alphaVantage: { source: 'alphaVantage', status: 'active', lastScanAt: '2026-06-30T14:06:00.000Z', newsItemsMatched: 2, blockedReason: null },
      },
      symbols: [
        {
          symbol: 'SOUN',
          socialConfirmation: { reddit: 88, stocktwits: 74, score: 84, reasonCodes: ['reddit_mention_velocity_spike', 'stocktwits_cashtag_velocity_confirmed'] },
          marketConfirmation: { alpaca: 81, polygon: 85, alphaVantage: 70, score: 82, reasonCodes: ['alpaca_volume_confirmed', 'polygon_snapshot_confirmed', 'alpha_vantage_intraday_confirmed'] },
          riskConfirmation: { nasdaqHalts: 'not_halted', alpacaAssets: 'tradable', secEdgar: 'no_blocking_filing', score: 92 },
          finalMemeScore: 89,
          status: 'hot_candidate',
          reasonCodes: ['cross_source_social_confirmation', 'cross_source_market_confirmation'],
          riskWarnings: [],
          crossSourceConfirmation: true,
          phaseBConfirmation: true,
          borderlineUpgrade: true,
        },
      ],
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'state', 'regular-watch-state.json'), JSON.stringify({
    version: '2026-06-30.regular-watch-state.1',
    updated_at: '2026-06-19T15:00:00.000Z',
    source: 'unit-test',
    features: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: { key: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', runtime: true, effective: true, status: 'active', changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: { key: 'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED', runtime: true, effective: true, status: 'active', changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { key: 'REGULAR_WATCH_PRIORITY_SCORING_ENABLED', runtime: true, effective: true, status: 'active', changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: { key: 'REGULAR_WATCH_SCANNER_RANKING_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_ASSET_VALIDATION_ENABLED: { key: 'REGULAR_WATCH_ASSET_VALIDATION_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_HALT_CHECK_ENABLED: { key: 'REGULAR_WATCH_HALT_CHECK_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_SEC_RISK_CHECK_ENABLED: { key: 'REGULAR_WATCH_SEC_RISK_CHECK_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_NEWS_CATALYST_ENABLED: { key: 'REGULAR_WATCH_NEWS_CATALYST_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { key: 'REGULAR_WATCH_POSITION_AWARENESS_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED: { key: 'REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED: { key: 'REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED: { key: 'REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED: { key: 'REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
    },
    summary: {
      master_enabled: true,
      source: 'unit-test',
      blocked_features: [],
      warnings: [],
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'regular-watch-status.json'), JSON.stringify({
    version: '2026-06-30.regular-watch-status.1',
    updated_at: '2026-06-19T15:01:00.000Z',
    enabled: true,
    regularWatchIntelligence: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-06-19T15:01:00.000Z',
      lastError: null,
      symbolsChecked: 12,
      moversFound: 3,
      blockedSymbols: 1,
      features: {
        marketConfirmation: true,
        assetValidation: false,
        haltCheck: false,
        secRiskCheck: false,
        newsCatalyst: false,
        priorityScoring: true,
        scannerRanking: false,
        positionAwareness: false,
      },
    },
    regularWatchList: [{
      symbol: 'SPCX',
      score: 78,
      status: 'watching',
      sourceStatus: [{
        source: 'wallstreetbets',
        tier: 'tier_1',
        status: 'active',
        lastScanAt: '2026-06-19T15:01:00.000Z',
        lastError: null,
        symbolsDetected: 4,
        blockedReason: null,
      }],
    }],
    regularWatchMovers: [{
      symbol: 'SPCX',
      score: 78,
      status: 'watching',
      sourceStatus: [{
        source: 'wallstreetbets',
        tier: 'tier_1',
        status: 'active',
        lastScanAt: '2026-06-19T15:01:00.000Z',
        lastError: null,
        symbolsDetected: 4,
        blockedReason: null,
      }],
    }],
    summary: {
      master_enabled: true,
      source: 'unit-test',
      blocked_features: [],
      warnings: [],
    },
    generatedAt: '2026-06-19T15:01:00.000Z',
    stale: false,
    status: 'active',
    lastRunAt: '2026-06-19T15:01:00.000Z',
    lastError: null,
  }, null, 2));
  const dynamicHotExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const hotHotExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  fs.writeFileSync(path.join(dataDir, 'runtime', 'dynamic-hot-list.json'), JSON.stringify({
    generatedAt: '2026-06-19T15:02:00.000Z',
    lastScoredAt: '2026-06-19T15:02:00.000Z',
    mode: 'shadow',
    source: 'meme-monitor',
    status: 'shadow',
    enabled: true,
    stale: false,
    dynamicHotList: [{
      symbol: 'AMO',
      memeHeatScore: 84,
      marketConfirmationScore: null,
      marketConfirmationDetails: null,
      status: 'dynamic_watch',
      lastDecision: 'dynamic_watch',
      reasonCodes: ['multi_source_confirmation', 'market_confirmation_unavailable'],
      riskWarnings: ['social_signal_only'],
      expiresAt: dynamicHotExpiresAt,
      mentions15m: 12,
      mentions30m: 18,
      mentions60m: 24,
      uniqueUsers: 9,
      topSources: ['reddit:wallstreetbets'],
      sourceProfile: {
        sourceCount: 2,
        dominantTier: 'tier_1',
        tierCounts: { tier_1: 2, tier_2: 1 },
        sources: [
          { source: 'wallstreetbets', tier: 'tier_1', count: 2, weight: 1.35 },
          { source: 'stocks', tier: 'tier_2', count: 1, weight: 1.0 },
        ],
      },
      sourceConfirmations: { reddit: true, alpacaMarket: false, alpacaAssets: false, nasdaqHalts: false, secEdgar: false },
      phaseB: {
        socialConfirmation: { reddit: 84, stocktwits: 67, score: 79, reasonCodes: ['cross_source_social_confirmation'] },
        marketConfirmation: { alpaca: 81, polygon: 85, alphaVantage: 70, score: 82, reasonCodes: ['cross_source_market_confirmation'] },
        riskConfirmation: { nasdaqHalts: 'not_halted', alpacaAssets: 'tradable', secEdgar: 'no_blocking_filing', score: 92 },
        finalMemeScore: 89,
        status: 'hot_candidate',
        reasonCodes: ['cross_source_social_confirmation', 'cross_source_market_confirmation'],
        riskWarnings: [],
        crossSourceConfirmation: true,
        phaseBConfirmation: true,
        borderlineUpgrade: true,
      },
      scannerWatched: true,
    }],
    hotHotList: [{
      symbol: 'SOUN',
      memeHeatScore: 92,
      marketConfirmationScore: 88,
      marketConfirmationDetails: {
        currentPrice: 23.24,
        previousClose: 21.1,
        volume: 2400000,
        averageVolume: 1200000,
        spreadPct: 0.24,
        tradable: true,
        halted: false,
      },
      status: 'hot_hot',
      priorityOverrideEligible: false,
      rotationEligible: false,
      reasonCodes: ['market_confirmation_passed'],
      riskWarnings: [],
      expiresAt: hotHotExpiresAt,
      lastDecision: 'hot_hot',
      sourceProfile: {
        sourceCount: 1,
        dominantTier: 'tier_1',
        tierCounts: { tier_1: 3 },
        sources: [
          { source: 'wallstreetbets', tier: 'tier_1', count: 3, weight: 1.35 },
        ],
      },
      sourceConfirmations: { reddit: true, alpacaMarket: true, alpacaAssets: false, nasdaqHalts: true, secEdgar: true },
      phaseB: {
        socialConfirmation: { reddit: 92, stocktwits: 78, score: 86, reasonCodes: ['cross_source_social_confirmation'] },
        marketConfirmation: { alpaca: 88, polygon: 86, alphaVantage: 72, score: 85, reasonCodes: ['cross_source_market_confirmation'] },
        riskConfirmation: { nasdaqHalts: 'not_halted', alpacaAssets: 'tradable', secEdgar: 'no_blocking_filing', score: 94 },
        finalMemeScore: 91,
        status: 'hot_hot',
        reasonCodes: ['cross_source_social_confirmation', 'cross_source_market_confirmation'],
        riskWarnings: [],
        crossSourceConfirmation: true,
        phaseBConfirmation: true,
        borderlineUpgrade: false,
      },
    }],
    expired: [],
    rejected: [],
  }, null, 2));

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 0, blocked_count: 0, approved_count: 0, paper_pnl: 0, execution_drag: 0, drawdown: 0, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { tuning: { status: 'ok' } },
      '/policy-effectiveness': { policy_effectiveness: { status: 'ok' } },
      '/overnight-status': { status: 'ok', mode: 'minimal-v1', report_date: '2026-06-19', timestamp: '2026-06-19T15:00:00.000Z' },
    };
    const payload = payloads[req.url] || { status: 'ok' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;
  const snapshot = await buildDashboardSnapshot({
    env: {
      ALPACA_API_KEY_ID: '',
      ALPACA_API_SECRET_KEY: '',
      STOCK_SCANNER_SYMBOLS: 'MU,IBM,SPCX',
      MEME_MONITOR_ENABLED: 'true',
      MEME_REDDIT_SCANNER_ENABLED: 'true',
      MEME_HOT_LIST_ENABLED: 'true',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'true',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
    },
    repoRoot: tempDir,
    dataDir,
    fetchImpl: global.fetch,
    traderBaseUrl: baseUrl,
  }, {
    dataDir,
  }, {
    dashboardPort: 1111,
  });

  await new Promise((resolve) => trader.close(resolve));

  assert.equal(snapshot.watch.regularWatchList.length > 0, true);
  assert.equal(snapshot.watch.regularWatchMovers.some((entry) => Number.isFinite(Number(entry.dailyMovePct))), true);
  assert.equal(snapshot.watch.dynamicHotList.enabled, true);
  assert.equal(snapshot.watch.dynamicHotList.symbols.some((entry) => entry.symbol === 'AMO'), true);
  assert.equal(snapshot.watch.dynamicHotList.symbols.find((entry) => entry.symbol === 'AMO').scannerWatched, true);
  assert.equal(snapshot.watch.dynamicHotList.symbols.find((entry) => entry.symbol === 'AMO').dynamicWatchlistMember, true);
  assert.equal(snapshot.watch.dynamicHotList.symbols.find((entry) => entry.symbol === 'AMO').sources.includes('wallstreetbets (tier_1)'), true);
  assert.equal(snapshot.watch.dynamicHotList.symbols.find((entry) => entry.symbol === 'AMO').sourceDetails[0].source.includes('wallstreetbets'), true);
  assert.equal(snapshot.watch.dynamicHotList.symbols.find((entry) => entry.symbol === 'AMO').sourceConfirmations.reddit, true);
  assert.equal(snapshot.watch.dynamicHotList.symbols.find((entry) => entry.symbol === 'AMO').phaseB.borderlineUpgrade, true);
  assert.equal(snapshot.watch.hotHotList.enabled, true);
  assert.equal(snapshot.watch.hotHotList.symbols.some((entry) => entry.symbol === 'SOUN'), true);
  assert.equal(snapshot.watch.hotHotList.symbols.find((entry) => entry.symbol === 'SOUN').tradableStatus, 'tradable');
  assert.equal(snapshot.watch.hotHotList.symbols.find((entry) => entry.symbol === 'SOUN').rotationEligible, true);
  assert.equal(snapshot.watch.hotHotList.symbols.find((entry) => entry.symbol === 'SOUN').evictionCandidate, 'MARA');
  assert.equal(snapshot.watch.hotHotList.symbols.find((entry) => entry.symbol === 'SOUN').lastRotationDecision, 'rotation_complete');
  assert.equal(snapshot.watch.hotHotList.symbols.find((entry) => entry.symbol === 'SOUN').sources.includes('wallstreetbets (tier_1)'), true);
  assert.equal(snapshot.watch.hotHotList.symbols.find((entry) => entry.symbol === 'SOUN').phaseB.finalMemeScore, 91);
  assert.equal(snapshot.watch.hotHotList.symbols.find((entry) => entry.symbol === 'SOUN').sourceConfirmations.secEdgar, true);
  assert.equal(snapshot.watch.hotSlotRotation.lastDecision, 'rotation_complete');
  assert.equal(snapshot.memeMonitor.hotSlotRotation.lastDecision, 'rotation_complete');
  assert.equal(snapshot.phaseB.status, 'active');
  assert.equal(snapshot.memeMonitor.phaseA.status, 'active');
  assert.equal(snapshot.memeMonitor.phaseA.sources.reddit.status, 'active');
  assert.equal(snapshot.memeMonitor.phaseB.status, 'active');
  assert.equal(snapshot.memeMonitor.phaseB.sources.stocktwits.status, 'active');
  assert.equal(snapshot.regularWatchIntelligence.enabled, true);
  assert.equal(snapshot.regularWatchIntelligence.status, 'active');
  assert.equal(snapshot.regularWatchIntelligence.features.marketConfirmation, true);
  assert.equal(snapshot.regularWatchIntelligence.scannerRanking.status, 'off');
  assert.equal(snapshot.regularWatchIntelligence.positionAwareness.status, 'off');
  assert.equal(Array.isArray(snapshot.regularWatchIntelligence.candidateComparison), true);
  assert.equal(snapshot.regularWatchIntelligence.candidateComparison[0].symbol, 'SPCX');
  assert.equal(snapshot.regularWatchIntelligence.candidateComparison[0].regularWatchStatus, 'watching');
  assert.equal(snapshot.watch.regularWatchIntelligence.status, 'active');
  assert.equal(snapshot.watch.phaseB.status, 'active');
  assert.equal(snapshot.watch.memeMonitor.dynamicWatchlist.status, 'shadow');
  assert.equal(snapshot.watch.memeMonitor.priorityOverride.status, 'off');
  assert.equal(snapshot.watch.actionsState.some(([label, status]) => label === 'Regular Watch Intelligence' && status === 'active'), true);
  assert.equal(snapshot.watch.featureState.master_enabled, true);
});

test('dashboard snapshot surfaces regular watch position awareness tags', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-position-awareness-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({ status: 'ok', mode: 'minimal-v1', report_date: '2026-06-19', timestamp: '2026-06-19T15:00:00.000Z' }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'state', 'scanner-runtime.json'), JSON.stringify({
    scanner: 'stock-scanner',
    mode: 'live-market',
    last_scan_time: '2026-06-19T15:01:00.000Z',
    last_scan_duration_ms: 42,
    candidate_rank_details: [{
      symbol: 'AAA',
      rank_score: 72,
      adjusted_rank_score: 72,
      current_price: 9.9,
      previous_close: 9.5,
      move_pct: 4.21,
      spread_pct: 0.22,
      volume: 1_200_000,
      average_volume: 800_000,
      volume_multiple: 1.5,
      tradable_status: 'tradable',
      halt_status: 'not_halted',
      position_awareness_tags: ['strong_runner'],
      source_status: [{
        source: 'wallstreetbets',
        tier: 'tier_1',
        status: 'active',
        lastScanAt: '2026-06-19T15:01:00.000Z',
        lastError: null,
        symbolsDetected: 4,
        blockedReason: null,
      }],
    }],
    recent_skips: [],
    hot_slot_rotation: { enabled: false, status: 'off', lastDecision: 'rotation_off' },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'state', 'regular-watch-state.json'), JSON.stringify({
    version: '2026-06-30.regular-watch-state.1',
    updated_at: '2026-06-19T15:00:00.000Z',
    source: 'unit-test',
    features: {
      REGULAR_WATCH_INTELLIGENCE_ENABLED: { key: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', runtime: true, effective: true, status: 'active', changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: { key: 'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED', runtime: true, effective: true, status: 'active', changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { key: 'REGULAR_WATCH_PRIORITY_SCORING_ENABLED', runtime: true, effective: true, status: 'active', changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      REGULAR_WATCH_SCANNER_RANKING_ENABLED: { key: 'REGULAR_WATCH_SCANNER_RANKING_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { key: 'REGULAR_WATCH_POSITION_AWARENESS_ENABLED', runtime: true, effective: true, status: 'active', changed_at: '2026-06-19T15:00:00.000Z', changed_by: 'test', source: 'unit-test' },
      REGULAR_WATCH_ASSET_VALIDATION_ENABLED: { key: 'REGULAR_WATCH_ASSET_VALIDATION_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_HALT_CHECK_ENABLED: { key: 'REGULAR_WATCH_HALT_CHECK_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_SEC_RISK_CHECK_ENABLED: { key: 'REGULAR_WATCH_SEC_RISK_CHECK_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_NEWS_CATALYST_ENABLED: { key: 'REGULAR_WATCH_NEWS_CATALYST_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED: { key: 'REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED: { key: 'REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED: { key: 'REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
      REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED: { key: 'REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED', runtime: false, effective: false, status: 'off', changed_at: null, changed_by: null, source: null },
    },
    summary: {
      master_enabled: true,
      source: 'unit-test',
      blocked_features: [],
      warnings: [],
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'runtime', 'regular-watch-status.json'), JSON.stringify({
    version: '2026-06-30.regular-watch-status.2',
    updated_at: '2026-06-19T15:01:00.000Z',
    enabled: true,
    regularWatchIntelligence: {
      enabled: true,
      status: 'active',
      lastRunAt: '2026-06-19T15:01:00.000Z',
      lastError: null,
      symbolsChecked: 1,
      moversFound: 1,
      blockedSymbols: 0,
      features: {
        marketConfirmation: true,
        assetValidation: false,
        haltCheck: false,
        secRiskCheck: false,
        newsCatalyst: false,
        priorityScoring: true,
        scannerRanking: false,
        positionAwareness: true,
      },
    },
    scannerRanking: { enabled: false, status: 'off', lastRunAt: '2026-06-19T15:01:00.000Z', lastError: null },
    positionAwareness: { enabled: true, status: 'active', lastRunAt: '2026-06-19T15:01:00.000Z', lastError: null },
    regularWatchList: [{
      symbol: 'AAA',
      score: 88,
      status: 'watching',
      sourceStatus: [{
        source: 'wallstreetbets',
        tier: 'tier_1',
        status: 'active',
        lastScanAt: '2026-06-19T15:01:00.000Z',
        lastError: null,
        symbolsDetected: 4,
        blockedReason: null,
      }],
    }],
    regularWatchMovers: [{
      symbol: 'AAA',
      score: 88,
      status: 'watching',
      sourceStatus: [{
        source: 'wallstreetbets',
        tier: 'tier_1',
        status: 'active',
        lastScanAt: '2026-06-19T15:01:00.000Z',
        lastError: null,
        symbolsDetected: 4,
        blockedReason: null,
      }],
    }],
    summary: {
      master_enabled: true,
      source: 'unit-test',
      blocked_features: [],
      warnings: [],
    },
    generatedAt: '2026-06-19T15:01:00.000Z',
    stale: false,
    status: 'active',
    lastRunAt: '2026-06-19T15:01:00.000Z',
    lastError: null,
  }, null, 2));

  const positionsServer = http.createServer((req, res) => {
    if (req.url === '/v2/positions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([
        { symbol: 'AAA', qty: '2', avg_entry_price: '8.5', current_price: '9.9', unrealized_pl: '2.8' },
      ]));
      return;
    }
    if (req.url === '/v2/orders?status=open') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/v2/account') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ equity: '1000', buying_power: '500' }));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => positionsServer.listen(0, '127.0.0.1', resolve));
  const positionsBaseUrl = `http://127.0.0.1:${positionsServer.address().port}`;

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 0, blocked_count: 0, approved_count: 0, paper_pnl: 0, execution_drag: 0, drawdown: 0, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { tuning: { status: 'ok' } },
      '/policy-effectiveness': { policy_effectiveness: { status: 'ok' } },
      '/overnight-status': { status: 'ok', mode: 'minimal-v1', report_date: '2026-06-19', timestamp: '2026-06-19T15:00:00.000Z' },
    };
    const payload = payloads[req.url] || { status: 'ok' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;

  const snapshot = await buildDashboardSnapshot({
    env: {
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      ALPACA_API_BASE_URL: positionsBaseUrl,
      STOCK_SCANNER_SYMBOLS: 'AAA',
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      REGULAR_WATCH_INTELLIGENCE_ENABLED: 'true',
      REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: 'true',
      REGULAR_WATCH_PRIORITY_SCORING_ENABLED: 'true',
      REGULAR_WATCH_POSITION_AWARENESS_ENABLED: 'true',
    },
    repoRoot: tempDir,
    dataDir,
    fetchImpl: global.fetch,
    traderBaseUrl: baseUrl,
  }, {
    dataDir,
  }, {
    dashboardPort: 1112,
  });

  await new Promise((resolve) => trader.close(resolve));
  await new Promise((resolve) => positionsServer.close(resolve));

  assert.equal(Array.isArray(snapshot.watch.regularWatchList[0].positionTags), true);
  assert.equal(Array.isArray(snapshot.watch.regularWatchIntelligence.candidateComparison[0].positionTags), true);
});

test('dashboard snapshot prefers live alpaca positions when available', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-live-positions-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-06-19',
    timestamp: '2026-06-19T15:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'live-policy.json'), JSON.stringify({
    source: 'startup-config',
    policy: {
      minConfidenceForPaper: 72,
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), '');

  const positionsServer = http.createServer((req, res) => {
    if (req.url === '/v2/positions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([
        { symbol: 'AAPL', qty: '2' },
        { symbol: 'MSFT', qty: '1' },
      ]));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => positionsServer.listen(0, '127.0.0.1', resolve));
  const positionsBaseUrl = `http://127.0.0.1:${positionsServer.address().port}`;

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 4, blocked_count: 1, approved_count: 3, paper_pnl: 2.5, drawdown: 0.1, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { accepted: true, tuning: { recommended_tuning_notes: ['Keep the floor tight.'] } },
      '/policy-effectiveness': { accepted: true, policy_effectiveness: { intervals: [] } },
      '/overnight-status': { accepted: true, status: 'ok', mode: 'minimal-v1' },
    };
    const payload = payloads[req.url];
    res.setHeader('content-type', 'application/json');
    if (!payload) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;

  const snapshot = await buildDashboardSnapshot({
    traderBaseUrl: baseUrl,
    port: 1111,
    dataDir,
    env: {
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      ALPACA_API_BASE_URL: positionsBaseUrl,
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    fetchImpl: global.fetch,
  }, {
    dataDir,
  }, {});

  await new Promise((resolve) => trader.close(resolve));
  await new Promise((resolve) => positionsServer.close(resolve));

  assert.equal(snapshot.summary.open_positions_count, 2);
  assert.equal(snapshot.summary.live_open_positions_count, 2);
  assert.equal(snapshot.summary.open_positions_count_source, 'alpaca');
});

test('dashboard snapshot prefers Alpaca daily account change when available', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-account-test-'));
  const dataDir = path.join(tempDir, 'data');
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'logs', 'overnight-status.json'), JSON.stringify({
    status: 'ok',
    mode: 'minimal-v1',
    report_date: '2026-06-19',
    timestamp: '2026-06-19T15:00:00.000Z',
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'live-policy.json'), JSON.stringify({
    source: 'startup-config',
    policy: {
      minConfidenceForPaper: 72,
      maxOpenPositions: 9,
      positionSizeMultiplier: 1,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dataDir, 'performance-history.jsonl'), '');
  fs.writeFileSync(path.join(dataDir, 'policy-history.jsonl'), '');

  const brokerServer = http.createServer((req, res) => {
    if (req.url === '/v2/account') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        equity: '283.70',
        last_equity: '300.61',
        cash: '272.79',
        portfolio_value: '283.70',
      }));
      return;
    }
    if (req.url === '/v2/positions') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([]));
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve) => brokerServer.listen(0, '127.0.0.1', resolve));
  const brokerBaseUrl = `http://127.0.0.1:${brokerServer.address().port}`;

  const trader = http.createServer((req, res) => {
    const payloads = {
      '/status': { status: 'ok', mode: 'minimal-v1', uptime_minutes: 12, heartbeat_count: 3, last_request_at: '2026-06-19T15:00:00.000Z', timestamp: '2026-06-19T15:00:01.000Z' },
      '/daily-live-results': { date: '2026-06-19', signal_count: 4, blocked_count: 1, approved_count: 3, paper_pnl: 2.5, execution_drag: 0, drawdown: 0.1, top_block_reasons: [] },
      '/risk-policy': { accepted: true, policy_snapshot: { source: 'startup-config', policy: { minConfidenceForPaper: 72, maxOpenPositions: 9, positionSizeMultiplier: 1 } } },
      '/performance/tuning': { accepted: true, tuning: { recommended_tuning_notes: ['Keep the floor tight.'] } },
      '/policy-effectiveness': { accepted: true, policy_effectiveness: { intervals: [] } },
      '/overnight-status': { accepted: true, status: 'ok', mode: 'minimal-v1' },
    };
    const payload = payloads[req.url];
    res.setHeader('content-type', 'application/json');
    if (!payload) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => trader.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${trader.address().port}`;

  const snapshot = await buildDashboardSnapshot({
    traderBaseUrl: baseUrl,
    port: 1111,
    dataDir,
    env: {
      ALPACA_API_KEY_ID: 'key',
      ALPACA_API_SECRET_KEY: 'secret',
      ALPACA_API_BASE_URL: brokerBaseUrl,
      MEME_MONITOR_ENABLED: 'false',
      MEME_REDDIT_SCANNER_ENABLED: 'false',
      MEME_HOT_LIST_ENABLED: 'false',
      MEME_DYNAMIC_WATCHLIST_ENABLED: 'false',
      MEME_PRIORITY_OVERRIDE_ENABLED: 'false',
      MEME_HOT_SLOT_ROTATION_ENABLED: 'false',
      MEME_AUTO_ACTION_ENABLED: 'false',
    },
    fetchImpl: global.fetch,
  }, {
    dataDir,
  }, {});

  await new Promise((resolve) => trader.close(resolve));
  await new Promise((resolve) => brokerServer.close(resolve));

  assert.equal(snapshot.summary.daily_change, -16.91);
  assert.equal(snapshot.summary.daily_change_source, 'alpaca');
  assert.equal(snapshot.summary.account_cash, 272.79);
});

test('dashboard server serves local assets and api health', async () => {
  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    dataDir: path.resolve(process.cwd(), 'data'),
    fetchImpl: global.fetch,
    traderBaseUrl: 'http://127.0.0.1:65535',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());

  await new Promise((resolve) => server.close(resolve));

  assert.equal(health.status, 'ok');
  assert(health.runtime_version);
  assert(Number.isFinite(health.pid));
  assert(html.includes('Live Market'));
});

test('dashboard server serves the new Home, Status, and Policy tabs', async () => {
  const server = createDashboardServer({
    port: 0,
    dashboardDir: path.resolve(process.cwd(), 'dashboard'),
    dataDir: path.resolve(process.cwd(), 'data'),
    fetchImpl: global.fetch,
    traderBaseUrl: 'http://127.0.0.1:65535',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const home = await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text());
  const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.text());
  const policy = await fetch(`http://127.0.0.1:${port}/policy`).then((response) => response.text());
  const exitRules = await fetch(`http://127.0.0.1:${port}/exit-rules`).then((response) => response.text());
  const alerts = await fetch(`http://127.0.0.1:${port}/alerts`).then((response) => response.text());
  const watch = await fetch(`http://127.0.0.1:${port}/watch`).then((response) => response.text());
  const control = await fetch(`http://127.0.0.1:${port}/control`).then((response) => response.text());

  await new Promise((resolve) => server.close(resolve));

  assert(home.includes('Home'));
  assert(home.includes('Daily Change'));
  assert(home.includes('Last 5 trades'));
  assert(status.includes('Status'));
  assert(policy.includes('Policy'));
  assert(exitRules.includes('Exit Rules'));
  assert(alerts.includes('Alerts'));
  assert(watch.includes('Watch'));
  assert(watch.includes('Regular Watch List'));
  assert(watch.includes('Regular Watch Movers List'));
  assert(watch.includes('Dynamic Hot List From Alerts'));
  assert(watch.includes('Hot Hot List'));
  assert.equal((watch.match(/class="panel watch-panel"/g) || []).length, 4);
  assert(watch.includes('Rotation eligible'));
  assert(watch.includes('Eviction candidate'));
  assert(watch.includes('Last rotation decision'));
  assert.equal(watch.includes('data-action='), false);
  assert(control.includes('Home'));
  assert(control.includes('Status'));
  assert(control.includes('Policy'));
  assert(control.includes('Exit Rules'));
  assert(control.includes('Alerts'));
  assert(control.includes('Watch'));
});

test('dashboard launcher auto-open can be disabled explicitly', () => {
  assert.equal(shouldAutoOpenBrowser({ DASHBOARD_OPEN_BROWSER: 'false' }), false);
  assert.equal(shouldAutoOpenBrowser({ DASHBOARD_OPEN_BROWSER: '0' }), false);
  assert.equal(shouldAutoOpenBrowser({ DASHBOARD_OPEN_BROWSER: 'true' }), true);
});

test('dashboard port prefers TRADER_DASHBOARD_PORT over DASHBOARD_PORT', () => {
  assert.equal(resolveDashboardPort({ TRADER_DASHBOARD_PORT: '2222', DASHBOARD_PORT: '3333' }), 2222);
  assert.equal(resolveDashboardPort({ DASHBOARD_PORT: '3333' }), 3333);
  assert.equal(resolveDashboardPort({ TRADER_DASHBOARD_PORT: 'not-a-port' }), 1111);
});

test('dashboard server serves mobile shell assets and manifest', async () => {
  const server = createDashboardServer({ dashboardDir: path.join(process.cwd(), 'dashboard') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    const mobile = await fetch(`http://127.0.0.1:${port}/mobile.js`);
    assert.equal(manifest.ok, true);
    assert.equal(mobile.ok, true);
    assert.match(manifest.headers.get('content-type') || '', /manifest\+json/);
    assert.match(mobile.headers.get('content-type') || '', /javascript/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
