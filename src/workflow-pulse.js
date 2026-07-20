const fs = require('fs');
const path = require('path');
const { nowIso, resolveRepoRoot, safeNumber } = require('./util');

const PULSE_SCHEMA_VERSION = '2026-07-16.workflow-pulse.2';

function resolveWorkflowPulsePath({ repoRoot = resolveRepoRoot(), env = process.env } = {}) {
  return path.resolve(env.WORKFLOW_PULSE_PATH || path.join(repoRoot, 'data', 'runtime', 'workflow-pulse.json'));
}

function buildWorkflowPulse(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || resolveRepoRoot());
  const dataDir = options.dataDir || path.join(repoRoot, 'data');
  const generatedAt = options.now || nowIso();
  const scanner = options.scannerRuntime || readJson(path.join(dataDir, 'state', 'scanner-runtime.json'));
  const supervisor = options.supervisor || readJson(path.join(dataDir, 'runtime', 'workflow-supervisor.json'));
  const regular = options.regularWatch || readJson(path.join(dataDir, 'runtime', 'regular-watch-status.json'));
  const reconciliation = options.reconciliation || readJson(path.join(dataDir, 'runtime', 'broker-local-reconciliation-latest.json'));
  const priorPulse = options.priorPulse || readJson(resolveWorkflowPulsePath({ repoRoot, env: options.env || process.env }));
  const policyHistory = options.policyHistoryRows || readJsonlTail(path.join(dataDir, 'policy-history.jsonl'), 25);
  const shadowOutcomes = options.shadowOutcomeRows || readJsonlTail(path.join(dataDir, 'runtime', 'scanner-selection-shadow-outcomes.jsonl'), 100);
  const performanceRead = options.performanceRows
    ? { rows: options.performanceRows, cursor: null, full: true }
    : readJsonlIncremental(
      path.join(dataDir, 'performance-history.jsonl'),
      priorPulse.activity?.session?.complete_from_start_of_day === true
        && Array.isArray(priorPulse.activity?.session_executions)
        && priorPulse.activity.session_executions.every((entry) => entry.side !== 'sell' || Object.prototype.hasOwnProperty.call(entry, 'accounting_correction_applied'))
        ? priorPulse.activity?.performance_cursor_bytes
        : undefined,
    );
  const activity = buildActivity(performanceRead.rows, priorPulse.activity, generatedAt, performanceRead);
  const sourceHealth = summarizeSources(scanner.sources, regular.sources);
  const positions = buildPositions(scanner, reconciliation, generatedAt, activity);
  const reconciliationAgeSeconds = ageSeconds(reconciliation.checked_at, generatedAt);
  const pulse = {
    schema_version: PULSE_SCHEMA_VERSION,
    generated_at: generatedAt,
    purpose: 'Compact local diagnostic source of truth; contains no credentials or raw provider payloads.',
    overall_status: 'healthy',
    alerts: [],
    freshness: {
      scanner_seconds: ageSeconds(scanner.updated_at || scanner.last_scan_time, generatedAt),
      regular_watch_seconds: ageSeconds(regular.updated_at || regular.lastRunAt, generatedAt),
      supervisor_seconds: ageSeconds(supervisor.updated_at, generatedAt),
      broker_reconciliation_seconds: ageSeconds(reconciliation.checked_at, generatedAt),
    },
    workflow: {
      status: supervisor.status || 'unknown',
      supervisor_pid: supervisor.supervisor_pid || null,
      scanner_profile: supervisor.scanner_profile || scanner.mode || null,
      services: supervisor.services || {},
      failed_component: supervisor.failed_component || null,
      last_failure: supervisor.last_failure || null,
      recovery_attempts: supervisor.recovery_attempts || 0,
    },
    broker: {
      source_of_truth: 'alpaca',
      reconciliation: {
        status: reconciliation.status || (scanner.broker_state?.available ? 'scanner_broker_ok' : 'unknown'),
        checked_at: reconciliation.checked_at || scanner.broker_truth?.checked_at || null,
        age_seconds: reconciliationAgeSeconds,
        stale: reconciliationAgeSeconds === null || reconciliationAgeSeconds > 60,
        mismatch_count: Array.isArray(reconciliation.mismatches) ? reconciliation.mismatches.length : 0,
        warning_count: Array.isArray(reconciliation.warnings) ? reconciliation.warnings.length : 0,
        critical_count: Array.isArray(reconciliation.critical_failures) ? reconciliation.critical_failures.length : 0,
        recommended_actions: reconciliation.recommended_actions || [],
      },
      account: {
        cash: nullableNumber(scanner.portfolio?.cash),
        buying_power: nullableNumber(scanner.portfolio?.buying_power),
        open_positions: nullableNumber(scanner.portfolio?.open_positions_count),
        remaining_slots: nullableNumber(scanner.portfolio?.remaining_position_slots),
        open_buy_orders: nullableNumber(scanner.portfolio?.open_buy_order_count),
        partial_buy_orders: nullableNumber(scanner.portfolio?.partial_buy_order_count),
        partial_reserved_notional: nullableNumber(scanner.portfolio?.partial_reserved_buy_notional),
        equity: nullableNumber(scanner.account_truth?.equity),
        previous_equity: nullableNumber(scanner.account_truth?.previous_equity),
        portfolio_value: nullableNumber(scanner.account_truth?.portfolio_value),
        long_market_value: nullableNumber(scanner.account_truth?.long_market_value),
        broker_daily_change: difference(scanner.account_truth?.equity, scanner.account_truth?.previous_equity),
        local_realized_pnl: activity.session.realized_pnl,
        local_unrealized_pnl: round(positions.reduce((sum, item) => sum + safeNumber(item.unrealized_pnl, 0), 0)),
      },
      state: scanner.broker_state || null,
      positions,
      open_orders: (reconciliation.alpaca_open_orders || []).slice(0, 20).map(summarizeOrder),
    },
    scanner: {
      mode: scanner.mode || scanner.loaded_mode || null,
      updated_at: scanner.updated_at || null,
      last_scan_at: scanner.last_scan_time || null,
      last_scan_duration_ms: nullableNumber(scanner.last_scan_duration_ms),
      last_error: scanner.last_scan_error || null,
      candidate_count: nullableNumber(scanner.candidate_count),
      posted_count: nullableNumber(scanner.posted_count),
      approved_count: nullableNumber(scanner.approved_count),
      rejected_count: nullableNumber(scanner.rejected_count),
      waiting_for_buy: scanner.waiting_for_buy || null,
      dominant_gates: sortCounts(scanner.skip_summary).slice(0, 15),
      recent_skips: (scanner.recent_skips || []).slice(-25),
      momentum_entry: scanner.momentum_entry || null,
      rank_floor: scanner.rank_floor || null,
      exit_rules: scanner.exit_rules || null,
      intraday_regime: scanner.intraday_regime || scanner.session_guards?.intraday_regime || null,
      session_guards: compactGuard(scanner.session_guards),
      allocation: scanner.allocation || null,
      top_candidates: (scanner.candidate_rank_details || []).slice(0, 15).map(summarizeCandidate),
      lifecycle: compactLifecycle(scanner.candidate_lifecycle_summary || scanner.candidate_lifecycle),
      hot_slot_rotation: scanner.hot_slot_rotation || null,
      symbol_universe: compactUniverse(scanner.symbol_universe, scanner.source_counts),
      partial_fills: compactPartialFills(scanner.partial_fill_state),
      execution_quality: compactExecutionQuality(scanner.execution_quality_summary),
      position_exit_state: (scanner.position_exit_state || []).slice(0, 20),
    },
    regular_watch: {
      status: regular.status || 'unknown',
      stale: Boolean(regular.stale),
      updated_at: regular.updated_at || regular.lastRunAt || null,
      symbols_checked: nullableNumber(regular.regularWatchIntelligence?.symbolsChecked),
      movers_found: nullableNumber(regular.regularWatchIntelligence?.moversFound),
      universe: compactUniverse(regular.universe),
      top_movers: (regular.regularWatchMovers || regular.regularWatchList || []).slice(0, 20).map(summarizeMover),
    },
    activity,
    source_health: sourceHealth,
    effective_settings: {
      execution_mode: activity.latest_execution_mode || scanner.mode || null,
      max_positions: sumNullable(scanner.portfolio?.open_positions_count, scanner.portfolio?.remaining_position_slots),
      momentum: scanner.momentum_entry || null,
      selection_v2: scanner.scanner_selection_v2?.config || null,
      rank_floor: scanner.rank_floor || null,
      exits: scanner.exit_rules || null,
      position_sizing: scanner.position_sizing ? omit(scanner.position_sizing, ['latest_candidates']) : null,
      risk_budget: scanner.risk_budget_sizing ? omit(scanner.risk_budget_sizing, ['latest_candidates']) : null,
    },
  };
  pulse.diagnostics = buildDiagnostics({ pulse, scanner, regular, policyHistory, shadowOutcomes, generatedAt });
  pulse.alerts = buildAlerts(pulse);
  pulse.overall_status = pulse.alerts.some((item) => item.severity === 'critical')
    ? 'critical'
    : pulse.alerts.some((item) => item.severity === 'warning') ? 'degraded' : 'healthy';
  return pulse;
}

function writeWorkflowPulse(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || resolveRepoRoot());
  const filePath = options.filePath || resolveWorkflowPulsePath({ repoRoot, env: options.env || process.env });
  const pulse = buildWorkflowPulse({ ...options, repoRoot });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(pulse, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, filePath);
  return pulse;
}

function refreshWorkflowPulseIfDue(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || resolveRepoRoot());
  const filePath = options.filePath || resolveWorkflowPulsePath({ repoRoot, env: options.env || process.env });
  const intervalSeconds = Math.max(5, safeNumber(options.intervalSeconds ?? options.env?.WORKFLOW_PULSE_INTERVAL_SECONDS ?? process.env.WORKFLOW_PULSE_INTERVAL_SECONDS, 20));
  try {
    if (Date.now() - fs.statSync(filePath).mtimeMs < intervalSeconds * 1000) return null;
  } catch { /* first pulse */ }
  try { return writeWorkflowPulse({ ...options, repoRoot, filePath }); } catch { return null; }
}

function buildActivity(rows, prior = {}, now, performanceRead = {}) {
  const executions = rows.filter((row) => row?.entry_type === 'execution_outcome').map((row) => normalizeExecution(row.record)).filter(Boolean);
  const decisions = rows.filter((row) => row?.entry_type === 'risk_decision').map((row) => normalizeDecision(row.record)).filter(Boolean);
  const today = etDate(now);
  const continueSession = performanceRead.full !== true && prior?.trading_date === today;
  const sessionExecutions = mergeUnique([
    ...(continueSession ? prior?.session_executions || [] : []),
    ...executions.filter((entry) => etDate(entry.at) === today),
  ], executionKey).slice(-400);
  const mergedExecutions = mergeUnique([...(prior?.recent_executions || []), ...executions], executionKey).slice(-50);
  const mergedDecisions = mergeUnique([...(prior?.recent_risk_decisions || []), ...decisions], decisionKey).slice(-30);
  const newTodaysExecutions = executions.filter((entry) => etDate(entry.at) === today);
  const newExits = newTodaysExecutions.filter((entry) => entry.side === 'sell' && Number.isFinite(entry.adjusted_pnl));
  const newBuys = newTodaysExecutions.filter((entry) => entry.side === 'buy');
  const newWins = newExits.filter((entry) => entry.adjusted_pnl > 0);
  const newLosses = newExits.filter((entry) => entry.adjusted_pnl < 0);
  const baseSession = continueSession ? prior.session || {} : {};
  const winTotal = safeNumber(baseSession.win_total, 0) + newWins.reduce((sum, entry) => sum + entry.adjusted_pnl, 0);
  const lossTotal = safeNumber(baseSession.loss_total, 0) + newLosses.reduce((sum, entry) => sum + entry.adjusted_pnl, 0);
  const buyCount = safeNumber(baseSession.buy_count, 0) + newBuys.length;
  const exitCount = safeNumber(baseSession.exit_count, 0) + newExits.length;
  const winCount = safeNumber(baseSession.win_count, 0) + newWins.length;
  const lossCount = safeNumber(baseSession.loss_count, 0) + newLosses.length;
  const flatCount = safeNumber(baseSession.flat_count, 0) + newExits.length - newWins.length - newLosses.length;
  const lastTrade = mergedExecutions.at(-1) || null;
  const lastBuy = [...mergedExecutions].reverse().find((entry) => entry.side === 'buy') || null;
  const lastSell = [...mergedExecutions].reverse().find((entry) => entry.side === 'sell') || null;
  const roundTrips = buildRoundTrips(sessionExecutions);
  return {
    trading_date: today,
    performance_cursor_bytes: performanceRead.cursor ?? prior?.performance_cursor_bytes ?? null,
    latest_execution_mode: lastTrade?.execution_mode || null,
    last_trade_at: lastTrade?.at || null,
    last_trade_age_seconds: ageSeconds(lastTrade?.at, now),
    last_buy_at: lastBuy?.at || null,
    last_buy_age_seconds: ageSeconds(lastBuy?.at, now),
    last_sell_at: lastSell?.at || null,
    last_sell_age_seconds: ageSeconds(lastSell?.at, now),
    session: {
      buy_count: buyCount,
      exit_count: exitCount,
      realized_pnl: round(winTotal + lossTotal),
      win_count: winCount,
      loss_count: lossCount,
      flat_count: flatCount,
      win_rate: exitCount ? round(winCount / exitCount) : null,
      average_win: winCount ? round(winTotal / winCount) : null,
      average_loss: lossCount ? round(lossTotal / lossCount) : null,
      win_total: round(winTotal),
      loss_total: round(lossTotal),
      profit_factor: lossTotal < 0 ? round(winTotal / Math.abs(lossTotal)) : null,
      expectancy_per_exit: exitCount ? round((winTotal + lossTotal) / exitCount) : null,
      complete_from_start_of_day: performanceRead.full === true || baseSession.complete_from_start_of_day === true,
    },
    risk_decision_counts: countBy(mergedDecisions, (entry) => entry.decision),
    risk_reason_counts: countValues(mergedDecisions.flatMap((entry) => entry.reason_codes || [])),
    session_executions: sessionExecutions,
    recent_executions: mergedExecutions,
    recent_round_trips: roundTrips.slice(-20),
    entry_quality_cohorts: buildEntryCohorts(roundTrips),
    exit_quality: buildExitQuality(roundTrips),
    decision_timing: buildDecisionTiming(roundTrips),
    recent_risk_decisions: mergedDecisions,
  };
}

function normalizeExecution(record = {}) {
  const signal = record.original_signal || {};
  const scanner = signal.market_context?.scanner || {};
  const selection = scanner.selection_v2 || {};
  const features = selection.features || {};
  const market = signal.market_context || {};
  const lifecycle = signal.candidate_lifecycle || {};
  const quote = market.alpaca_quote || {};
  const finalQuote = scanner.final_quote_check || {};
  const exitState = record.exit_state || market.exit_state || scanner.exit_state || {};
  const quality = record.execution_quality || {};
  const fill = record.paper_result || {};
  const grossPnl = nullableNumber(record.gross_pnl);
  const fees = nullableNumber(record.fees ?? fill.estimated_fees);
  const legacyDoubleCounted = record.accounting_version === '2026-07-13.broker-fill.1' && Number.isFinite(grossPnl);
  const realizedPnl = legacyDoubleCounted ? grossPnl - safeNumber(fees, 0) : nullableNumber(record.adjusted_pnl ?? record.net_pnl ?? record.pnl);
  const at = record.recorded_at || record.timestamp;
  if (!at || !record.symbol) return null;
  return {
    at,
    symbol: record.symbol,
    side: signal.side || record.side || null,
    execution_mode: record.execution_mode || null,
    status: record.status || null,
    quantity: nullableNumber(record.quantity ?? signal.quantity),
    entry_price: nullableNumber(record.entry_price ?? signal.entry_price),
    exit_price: nullableNumber(record.exit_price),
    adjusted_pnl: realizedPnl,
    reported_adjusted_pnl: nullableNumber(record.adjusted_pnl),
    accounting_version: record.accounting_version || null,
    accounting_correction_applied: legacyDoubleCounted,
    gross_pnl: grossPnl,
    net_pnl: nullableNumber(record.net_pnl),
    fees,
    execution_drag: nullableNumber(record.execution_drag),
    entry_slippage: nullableNumber(record.entry_slippage),
    exit_slippage: nullableNumber(record.exit_slippage),
    fill_latency_ms: nullableNumber(quality.latency_ms),
    fill_price: nullableNumber(fill.average_fill_price),
    session_move_pct: nullableNumber(features.signed_move_pct ?? scanner.move_pct),
    one_minute_return_pct: nullableNumber(features.one_minute_return_pct),
    relative_volume: nullableNumber(features.relative_volume),
    close_location_pct: nullableNumber(features.minute_close_location_pct),
    opportunity_score: nullableNumber(selection.final_opportunity_score),
    setup: selection.setup_classification || null,
    spread_pct: nullableNumber(scanner.spread_pct ?? market.spread_slippage_pct),
    price: nullableNumber(scanner.current_price ?? signal.price),
    discovery_at: lifecycle.first_seen_at || null,
    eligible_at: lifecycle.eligible_at || null,
    confirmation_path: lifecycle.confirmation_path || scanner.adaptive_confirmation?.path || null,
    confirmation_seconds_required: nullableNumber(lifecycle.confirmation_seconds_required),
    quote_timestamp: quote.timestamp || null,
    quote_received_at: quote.received_at || null,
    quote_latency_ms: nullableNumber(quote.latency_ms),
    quote_age_at_decision_seconds: ageSeconds(quote.timestamp, at),
    final_quote_checked_at: finalQuote.checked_at || finalQuote.timestamp || null,
    stop_price: nullableNumber(signal.structure_stop?.stop_price ?? signal.stop_loss),
    stop_distance: nullableNumber(signal.structure_stop?.stop_distance),
    provider_evidence: summarizeProviderEvidence(market, scanner),
    exit_reason: record.exit_reason || exitState.reason_code || exitState.exit_reason || null,
    holding_period_seconds: nullableNumber(record.holding_period_seconds ?? record.trade_duration_seconds),
    hard_stop_price: nullableNumber(exitState.hard_stop_price),
    stop_loss_dollars: nullableNumber(exitState.stop_loss_dollars),
    stop_loss_per_share: nullableNumber(exitState.stop_loss_per_share),
    peak_unrealized_pnl: nullableNumber(record.max_favorable_excursion ?? exitState.trailing_peak_unrealized_pl),
    maximum_adverse_excursion: nullableNumber(record.max_adverse_excursion ?? exitState.minimum_unrealized_pl),
    exit_state_pnl: nullableNumber(exitState.current_unrealized_pl),
  };
}

function normalizeDecision(record = {}) {
  const at = record.recorded_at || record.timestamp;
  if (!at || !record.decision) return null;
  return { at, symbol: record.symbol || null, decision: record.decision, reason_codes: record.reason_codes || [], warnings: record.warnings || [] };
}

function buildPositions(scanner, reconciliation, now, activity = {}) {
  const trailing = scanner.trailing_state?.positions || {};
  const reconciliationAge = ageSeconds(reconciliation.checked_at, now);
  const useReconciliationPositions = Object.keys(trailing).length === 0 || (reconciliationAge !== null && reconciliationAge <= 60);
  const brokerPositions = new Map((useReconciliationPositions ? reconciliation.alpaca_positions || [] : []).map((item) => [String(item.symbol || '').toUpperCase(), item]));
  const latestBuys = new Map((activity.recent_executions || []).filter((item) => item.side === 'buy').map((item) => [String(item.symbol || '').toUpperCase(), item]));
  const symbols = new Set([...brokerPositions.keys(), ...Object.keys(trailing)]);
  return [...symbols].map((symbol) => {
    const broker = brokerPositions.get(symbol) || {};
    const trail = trailing[symbol] || {};
    const entry = latestBuys.get(symbol) || {};
    const quantity = nullableNumber(broker.qty ?? entry.quantity);
    const entryPrice = nullableNumber(broker.avg_entry_price ?? entry.entry_price);
    const unrealizedPnl = nullableNumber(broker.unrealized_pl ?? trail.current_unrealized_pl);
    const derivedCurrentPrice = Number.isFinite(entryPrice) && Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unrealizedPnl)
      ? entryPrice + (unrealizedPnl / quantity)
      : null;
    const currentPrice = nullableNumber(broker.current_price) ?? derivedCurrentPrice;
    return {
      symbol,
      quantity,
      entry_price: entryPrice,
      current_price: currentPrice,
      market_value: nullableNumber(broker.market_value) ?? (Number.isFinite(currentPrice) && Number.isFinite(quantity) ? currentPrice * quantity : null),
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_pct: nullableNumber(broker.unrealized_plpc) ?? (Number.isFinite(unrealizedPnl) && Number.isFinite(entryPrice) && Number.isFinite(quantity) && entryPrice * quantity > 0 ? unrealizedPnl / (entryPrice * quantity) : null),
      opened_at: trail.opened_at || null,
      age_seconds: ageSeconds(trail.opened_at, now),
      peak_unrealized_pnl: nullableNumber(trail.peak_unrealized_pl),
      trailing_active: Boolean(trail.trailing_active),
      trailing_floor_pnl: nullableNumber(trail.sell_if_unrealized_pl_at_or_below),
    };
  });
}

function summarizeMover(item = {}) { return pick(item, ['symbol', 'status', 'score', 'regularWatchScore', 'marketConfirmationScore', 'currentPrice', 'previousClose', 'movePct', 'relativeVolume', 'spreadPct', 'ageSeconds', 'stale', 'tradableStatus', 'haltStatus', 'reasonCodes', 'riskWarnings', 'fastLaneStreak']); }
function summarizeCandidate(item = {}) { return pick(item, ['symbol', 'rank_score', 'adjusted_rank_score', 'move_pct', 'spread_pct', 'opportunity_score', 'momentum_score', 'relative_volume_score', 'selection_v2', 'candidate_lifecycle_status', 'candidate_lifecycle_reason_codes']); }
function summarizeOrder(item = {}) { return pick(item, ['id', 'client_order_id', 'symbol', 'side', 'type', 'status', 'qty', 'filled_qty', 'notional', 'created_at', 'submitted_at']); }
function compactGuard(value = {}) { return pick(value, ['status', 'buy_blocked', 'sells_allowed', 'manage_only', 'active_guards', 'reason_codes', 'expires_at', 'explanation', 'metrics', 'intraday_regime']); }
function compactLifecycle(value = {}) { return pick(value, ['status', 'scanner_mode', 'selected_symbol', 'selected_rank', 'watched_count', 'eligible_count', 'selected_count', 'entered_count', 'expired_count', 'blocked_count', 'total_count', 'reason_codes', 'rotation_decision', 'last_reconciled_at']); }
function compactUniverse(value = {}, sourceCounts = {}) { return { ...pick(value || {}, ['source', 'full_eligible_count', 'current_batch_size', 'rotation_batch_size', 'fast_lane_enabled', 'fast_lane_candidate_count', 'fast_lane_limit', 'merged_scan_size', 'displayed_top_limit', 'scanned_today_count', 'fresh_data_count', 'warning', 'rotation']), source_counts: sourceCounts || undefined }; }
function compactPartialFills(value = {}) { return pick(value, ['count', 'partial_buys', 'partial_sells', 'stale_partials', 'blocked_symbols', 'reserved_buy_notional', 'warnings', 'last_reconciled_at', 'average_fill_percentage']); }
function compactExecutionQuality(value = {}) { return pick(value, ['status', 'updated_at', 'total_trades', 'average_quality_score', 'average_slippage', 'average_execution_drag', 'partial_fill_rate', 'rejection_rate', 'cancellation_rate', 'duplicate_risk_rate', 'recent_bad_fills', 'warnings']); }

function summarizeSources(...lists) {
  const output = new Map();
  for (const item of lists.flat().filter(Boolean)) {
    const name = String(item.provider || item.source || '').trim();
    if (!name) continue;
    output.set(name, { ...output.get(name), ...pick(item, ['provider', 'source', 'enabled', 'configured', 'available', 'status', 'healthy', 'lastRunAt', 'lastScanAt', 'lastError', 'blockedReason', 'lastReasonCode', 'latencyMs', 'cacheHits', 'cacheMisses', 'requestsInWindow', 'estimatedDailyUsage', 'estimatedRemainingAllowance', 'cooldownUntil', 'circuitState', 'authenticationStatus', 'entitlementClassification', 'freshnessClassification']) });
  }
  return [...output.values()];
}

function buildAlerts(pulse) {
  const alerts = [];
  const add = (severity, code, message, details = null) => alerts.push({ severity, code, message, ...(details ? { details } : {}) });
  if (pulse.workflow.status !== 'healthy') add('critical', 'WORKFLOW_NOT_HEALTHY', `Workflow status is ${pulse.workflow.status}.`);
  if (pulse.freshness.scanner_seconds === null || pulse.freshness.scanner_seconds > 30) add('critical', 'SCANNER_PULSE_STALE', 'Scanner runtime is stale.', { age_seconds: pulse.freshness.scanner_seconds });
  if (pulse.broker.state?.available === false || pulse.broker.state?.strict_buy_blocked) add('critical', 'BROKER_STATE_UNAVAILABLE', 'Broker truth is unavailable or buy-blocked.', pulse.broker.state);
  if (pulse.broker.reconciliation.critical_count > 0) add('critical', 'BROKER_RECONCILIATION_CRITICAL', 'Broker reconciliation has critical failures.');
  if (!pulse.broker.reconciliation.stale && pulse.broker.reconciliation.mismatch_count > 0) add('warning', 'BROKER_RECONCILIATION_MISMATCH', 'Broker and local state disagree.', { mismatch_count: pulse.broker.reconciliation.mismatch_count });
  if (pulse.scanner.last_error) add('warning', 'SCANNER_LAST_RUN_ERROR', pulse.scanner.last_error);
  if (pulse.scanner.session_guards?.buy_blocked) add('warning', 'BUY_GUARD_ACTIVE', pulse.scanner.session_guards.explanation || 'A session guard is blocking buys.');
  if (pulse.activity.session.exit_count >= 5 && pulse.activity.session.realized_pnl < 0) add('warning', 'NEGATIVE_SESSION_PERFORMANCE', 'Realized session performance is negative.', { realized_pnl: pulse.activity.session.realized_pnl, exits: pulse.activity.session.exit_count, win_rate: pulse.activity.session.win_rate });
  if (pulse.activity.session.loss_count >= 3 && Math.abs(safeNumber(pulse.activity.session.average_loss, 0)) > safeNumber(pulse.activity.session.average_win, 0)) add('warning', 'LOSS_SIZE_EXCEEDS_WIN_SIZE', 'Average loss is larger than average win.', { average_win: pulse.activity.session.average_win, average_loss: pulse.activity.session.average_loss, profit_factor: pulse.activity.session.profit_factor });
  if (safeNumber(pulse.scanner.session_guards?.metrics?.consecutive_losses, 0) >= 3) add('warning', 'RECENT_LOSS_STREAK', 'Recent exits contain a loss streak.', { consecutive_losses: pulse.scanner.session_guards.metrics.consecutive_losses });
  if (pulse.broker.account?.remaining_slots > 0 && pulse.scanner.candidate_count === 0) add('info', 'NO_ELIGIBLE_CANDIDATE', pulse.scanner.waiting_for_buy?.message || 'No candidate currently passes every entry gate.');
  const recentPaper = pulse.activity.recent_risk_decisions.filter((entry) => entry.decision === 'APPROVED_FOR_PAPER' && ageSeconds(entry.at, pulse.generated_at) <= 3600);
  if (pulse.activity.latest_execution_mode === 'live' && recentPaper.length) add('critical', 'PAPER_DECISION_IN_LIVE_WINDOW', 'A paper-only decision appeared during the recent live window.', { count: recentPaper.length });
  for (const source of pulse.source_health) {
    if (source.enabled === true && ['failed', 'unavailable', 'error'].includes(String(source.status || '').toLowerCase())) add('warning', 'SOURCE_UNHEALTHY', `${source.provider || source.source} is ${source.status}.`);
  }
  return alerts;
}

function buildDiagnostics({ pulse, scanner, regular, policyHistory, shadowOutcomes, generatedAt }) {
  const funnel = {
    universe_eligible: nullableNumber(scanner.symbol_universe?.full_eligible_count ?? regular.universe?.full_eligible_count),
    scanned_this_batch: nullableNumber(scanner.symbol_universe?.merged_scan_size ?? scanner.symbol_universe?.current_batch_size),
    fresh_market_data: nullableNumber(scanner.symbol_universe?.fresh_data_count),
    regular_watch_movers: nullableNumber(regular.regularWatchIntelligence?.moversFound),
    scanner_candidates: nullableNumber(scanner.candidate_count),
    posted_to_risk: nullableNumber(scanner.posted_count),
    approved_by_risk: nullableNumber(scanner.approved_count),
    rejected_by_risk: nullableNumber(scanner.rejected_count),
    dominant_rejection_reasons: sortCounts(scanner.skip_summary).slice(0, 20),
    closest_recent_rejects: (scanner.recent_skips || []).slice(-20).map((item) => pick(item, ['symbol', 'stage', 'reason', 'reason_code', 'rank_score', 'adjusted_rank_score', 'opportunity_score', 'move_pct', 'relative_volume', 'spread_pct', 'at'])),
  };
  const providerEvidence = summarizeProviderSession(pulse.activity.session_executions || []);
  const opportunityCost = buildOpportunityCost({ pulse, scanner, shadowOutcomes, generatedAt });
  const exposure = buildExposure(pulse.broker.positions, scanner);
  const configuration = buildConfigLedger(policyHistory, pulse.activity.session_executions || []);
  const diagnosis = buildAutomaticDiagnosis({ pulse, funnel, opportunityCost, exposure, providerEvidence });
  return {
    automatic_diagnosis: diagnosis,
    candidate_funnel: funnel,
    live_account_truth: {
      ...pulse.broker.account,
      pnl_difference_broker_vs_local: difference(pulse.broker.account?.broker_daily_change, sumNullable(pulse.broker.account?.local_realized_pnl, pulse.broker.account?.local_unrealized_pnl)),
      broker_account_timestamp: scanner.account_truth?.checked_at || scanner.broker_truth?.checked_at || null,
      reconciliation_status: pulse.broker.reconciliation.status,
    },
    opportunity_cost: opportunityCost,
    exposure,
    provider_evidence: providerEvidence,
    configuration_change_ledger: configuration,
    collection_coverage: {
      exact_exit_trigger: 'available',
      favorable_excursion: 'available_when_trailing_state_recorded',
      adverse_excursion: 'not_historically_recorded',
      post_exit_1_3_5_minute_price: 'not_historically_recorded',
      rejected_candidate_future_returns: opportunityCost.observed_shadow_outcomes ? 'partially_available' : 'not_available',
      sector_and_industry: exposure.classification_coverage,
      direct_broker_account_values: scanner.account_truth ? 'available' : 'awaiting_next_scanner_snapshot',
    },
  };
}

function buildOpportunityCost({ pulse, scanner, shadowOutcomes, generatedAt }) {
  const observations = (shadowOutcomes || []).filter((item) => etDate(item.recorded_at || item.timestamp || item.at) === etDate(generatedAt));
  const completed = observations.filter((item) => item.observed === true || item.outcome || item.observations);
  const buyingPower = safeNumber(pulse.broker.account?.buying_power, 0);
  const idleSeconds = pulse.broker.account?.open_positions === 0 ? pulse.activity.last_sell_age_seconds : 0;
  return {
    idle_capital: { buying_power: buyingPower, seconds_with_no_position: idleSeconds, estimated_dollar_seconds: Number.isFinite(idleSeconds) ? round(buyingPower * idleSeconds, 2) : null },
    queued_shadow_observations: observations.length,
    observed_shadow_outcomes: completed.length,
    shadow_summary: summarizeShadowOutcomes(completed),
    recently_rejected_candidates: (scanner.recent_skips || []).slice(-20).map((item) => pick(item, ['symbol', 'reason', 'reason_code', 'stage', 'opportunity_score', 'move_pct', 'relative_volume', 'at'])),
    exited_symbol_follow_up: { status: 'future_price_observations_not_historically_collected' },
    selected_vs_alternatives: { status: completed.length ? 'see_shadow_summary' : 'no_completed_comparable_shadow_observations' },
  };
}

function summarizeShadowOutcomes(rows) {
  const values = rows.map((row) => row.outcome || row.record || row).filter(Boolean);
  const numericKeys = ['return_1m_pct', 'return_3m_pct', 'return_5m_pct', 'realized_pnl', 'pnl'];
  return Object.fromEntries(numericKeys.map((key) => [key, summarizeNumbers(values.map((item) => nullableNumber(item[key]))) ]));
}

function buildExposure(positions = [], scanner = {}) {
  const positionRisk = positions.map((position) => {
    const exit = (scanner.position_exit_state || []).find((item) => String(item.symbol).toUpperCase() === position.symbol) || {};
    const dollarsAtRisk = nullableNumber(exit.stop_loss_dollars) ?? nullableNumber(scanner.exit_rules?.position_stop_loss_dollars);
    return {
      symbol: position.symbol,
      market_value: position.market_value,
      unrealized_pnl: position.unrealized_pnl,
      dollars_at_risk_to_stop: dollarsAtRisk,
      price_bucket: bucket(position.current_price, [5, 20, 50], ['under_5', '5_to_20', '20_to_50', 'above_50']),
      volatility_classification: exit.volatility_classification || null,
      sector: exit.sector || null,
      industry: exit.industry || null,
    };
  });
  const classified = positionRisk.filter((item) => item.sector || item.industry).length;
  const measuredRisk = positionRisk.map((item) => item.dollars_at_risk_to_stop).filter(Number.isFinite);
  return {
    positions: positionRisk,
    total_market_value: round(positionRisk.reduce((sum, item) => sum + safeNumber(item.market_value, 0), 0)),
    total_dollars_at_risk_to_stops: measuredRisk.length === positionRisk.length ? round(measuredRisk.reduce((sum, value) => sum + value, 0)) : null,
    worst_case_all_stops_pnl: measuredRisk.length === positionRisk.length ? round(-measuredRisk.reduce((sum, value) => sum + value, 0)) : null,
    same_sector_counts: countBy(positionRisk, (item) => item.sector),
    correlated_position_check: classified === positions.length && positions.length > 0 ? 'measured_from_classifications' : 'insufficient_sector_classification',
    classification_coverage: `${classified}/${positions.length}`,
  };
}

function summarizeProviderEvidence(market = {}, scanner = {}) {
  const alpaca = market.alpaca_quote || {};
  const external = Array.isArray(market.external_provider_confirmations) ? market.external_provider_confirmations : [];
  return {
    alpaca: { provider: alpaca.provider_name || 'alpaca', timestamp: alpaca.timestamp || null, stale: alpaca.stale ?? null, fresh: alpaca.fresh ?? null, latency_ms: nullableNumber(alpaca.latency_ms), confidence_score: nullableNumber(alpaca.confidence_score) },
    external: external.map((item) => pick(item, ['provider', 'status', 'reason_code', 'freshness', 'age_seconds', 'price_difference_pct', 'entitlement', 'confirmed'])),
    secondary_available: Boolean(scanner.secondary_confirmation_available),
    secondary_source: scanner.secondary_confirmation_source || null,
    comparison: scanner.regular_watch_comparison ? pick(scanner.regular_watch_comparison, ['status', 'score', 'reason_codes', 'sourceContributors', 'price_difference_pct']) : null,
  };
}

function summarizeProviderSession(executions) {
  const buys = executions.filter((item) => item.side === 'buy');
  const providers = {};
  let disagreements = 0;
  for (const buy of buys) {
    const evidence = buy.provider_evidence || {};
    const alpaca = evidence.alpaca || {};
    providers[alpaca.provider || 'alpaca'] = (providers[alpaca.provider || 'alpaca'] || 0) + 1;
    for (const item of evidence.external || []) providers[item.provider || 'unknown'] = (providers[item.provider || 'unknown'] || 0) + 1;
    if ((evidence.comparison?.reason_codes || []).some((code) => /MISMATCH|DISAGREE|STALE|DELAYED/.test(String(code)))) disagreements += 1;
  }
  return {
    buy_count: buys.length,
    contributing_provider_counts: providers,
    external_confirmation_available_count: buys.filter((item) => item.provider_evidence?.secondary_available).length,
    disagreement_count: disagreements,
    latest_buy_evidence: buys.at(-1)?.provider_evidence || null,
  };
}

function buildConfigLedger(rows = [], executions = []) {
  const safeKeys = ['executionMode', 'maxOpenPositions', 'positionSizeMultiplier', 'buyNotionalTarget', 'positionStopLossDollars', 'trailingProfitStartDollars', 'trailingProfitGivebackDollars', 'stalePositionMaxHoldMinutes', 'minProviderConfirmationScore', 'minMovePct', 'minRecentMovePct', 'minRecentRangePct', 'minRecentCloseLocationPct', 'minAdjustedRankScore', 'blockBuys'];
  const normalized = rows.map((row) => ({ at: row.captured_at || row.timestamp || null, source: row.source || null, reason_codes: row.reason_codes || [], settings: pick(row.policy || {}, safeKeys) })).filter((item) => item.at);
  const changes = normalized.map((item, index) => ({ ...item, changed: index ? diffObjects(normalized[index - 1].settings, item.settings) : {} })).filter((item, index) => index === 0 || Object.keys(item.changed).length).slice(-15);
  return {
    active: normalized.at(-1) || null,
    changes,
    session_trade_count: executions.filter((item) => item.side === 'sell').length,
    performance_by_configuration: { status: 'future_execution_records_do_not_yet_carry_policy_version' },
  };
}

function buildAutomaticDiagnosis({ pulse, funnel, opportunityCost, exposure }) {
  const issues = [];
  const session = pulse.activity.session;
  if (session.exit_count >= 5 && safeNumber(session.profit_factor, 0) < 1) issues.push({ issue: 'trade_selection_and_exit_economics', evidence: { profit_factor: session.profit_factor, expectancy: session.expectancy_per_exit, average_win: session.average_win, average_loss: session.average_loss }, target: 'raise profit factor above 1 by separating losing entry cohorts and reducing peak-to-exit giveback', confidence: 'high' });
  if (pulse.activity.exit_quality?.average_peak_to_exit_giveback > Math.abs(safeNumber(session.average_loss, 0))) issues.push({ issue: 'profit_giveback', evidence: { average_peak_to_exit_giveback: pulse.activity.exit_quality.average_peak_to_exit_giveback }, target: 'align trailing activation and giveback with actually achieved MFE', confidence: 'medium' });
  if (funnel.scanner_candidates === 0 && funnel.regular_watch_movers > 0 && safeNumber(pulse.broker.account?.remaining_slots, 0) > 0) issues.push({ issue: 'candidate_funnel_filters', evidence: { movers: funnel.regular_watch_movers, dominant_rejections: funnel.dominant_rejection_reasons.slice(0, 5) }, target: 'inspect the dominant measured rejection stage; do not add a blind cooldown', confidence: 'high' });
  if (safeNumber(pulse.activity.decision_timing?.discovery_over_one_hour_count, 0) > 0) issues.push({ issue: 'candidate_lifecycle_timestamps_span_multiple_sessions', evidence: { over_one_hour_count: pulse.activity.decision_timing.discovery_over_one_hour_count, discovery_timing: pulse.activity.decision_timing.discovery_to_entry_seconds }, target: 'verify lifecycle reset boundaries before using discovery-to-entry timing as a selection signal', confidence: 'high' });
  if (opportunityCost.idle_capital.seconds_with_no_position > 900 && pulse.broker.account?.remaining_slots > 0) issues.push({ issue: 'idle_buying_power', evidence: opportunityCost.idle_capital, target: 'use funnel rejects and shadow outcomes to distinguish no opportunity from an overrestrictive gate', confidence: 'high' });
  if (exposure.total_dollars_at_risk_to_stops > safeNumber(pulse.broker.account?.buying_power, Infinity)) issues.push({ issue: 'stop_risk_concentration', evidence: { total_dollars_at_risk: exposure.total_dollars_at_risk_to_stops }, target: 'reduce simultaneous stop risk', confidence: 'medium' });
  return { primary: issues[0] || { issue: 'no_single_dominant_issue', target: 'continue collecting measured evidence', confidence: 'low' }, secondary: issues.slice(1, 4), generated_from: 'deterministic pulse rules' };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function readJsonlTail(file, limit = 50) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function buildRoundTrips(executions = []) {
  const openBuys = new Map();
  const trips = [];
  for (const item of executions) {
    const symbol = String(item.symbol || '').toUpperCase();
    if (!symbol) continue;
    if (item.side === 'buy') openBuys.set(symbol, item);
    if (item.side !== 'sell') continue;
    const buy = openBuys.get(symbol);
    if (!buy) continue;
    trips.push({
      symbol,
      bought_at: buy.at,
      sold_at: item.at,
      hold_seconds: ageSeconds(buy.at, item.at),
      adjusted_pnl: item.adjusted_pnl,
      entry_session_move_pct: buy.session_move_pct,
      entry_one_minute_return_pct: buy.one_minute_return_pct,
      entry_relative_volume: buy.relative_volume,
      entry_close_location_pct: buy.close_location_pct,
      entry_opportunity_score: buy.opportunity_score,
      entry_setup: buy.setup,
      entry_price: buy.fill_price ?? buy.entry_price ?? buy.price,
      exit_price: item.fill_price ?? item.exit_price,
      entry_spread_pct: buy.spread_pct,
      entry_quote_age_seconds: buy.quote_age_at_decision_seconds,
      discovery_to_entry_seconds: ageSeconds(buy.discovery_at, buy.at),
      eligible_to_entry_seconds: ageSeconds(buy.eligible_at, buy.at),
      confirmation_path: buy.confirmation_path,
      confirmation_seconds_required: buy.confirmation_seconds_required,
      entry_fill_latency_ms: buy.fill_latency_ms,
      exit_fill_latency_ms: item.fill_latency_ms,
      entry_stop_price: buy.stop_price,
      entry_stop_distance: buy.stop_distance,
      exit_hard_stop_price: item.hard_stop_price,
      configured_stop_loss_dollars: item.stop_loss_dollars,
      configured_stop_loss_per_share: item.stop_loss_per_share,
      maximum_favorable_excursion: item.peak_unrealized_pnl,
      maximum_adverse_excursion: item.maximum_adverse_excursion,
      profit_capture_dollars: Number.isFinite(item.adjusted_pnl) && Number.isFinite(item.peak_unrealized_pnl)
        ? round(item.adjusted_pnl - item.peak_unrealized_pnl)
        : null,
      peak_profit_capture_ratio: Number.isFinite(item.adjusted_pnl) && item.adjusted_pnl > 0 && Number.isFinite(item.peak_unrealized_pnl) && item.peak_unrealized_pnl > 0
        ? round(item.adjusted_pnl / item.peak_unrealized_pnl)
        : null,
      gross_pnl: item.gross_pnl,
      net_pnl: item.net_pnl,
      fees: item.fees,
      entry_slippage: buy.entry_slippage,
      exit_slippage: item.exit_slippage,
      exit_one_minute_return_pct: item.one_minute_return_pct,
      execution_drag: item.execution_drag,
      exit_reason: item.exit_reason,
      provider_evidence: buy.provider_evidence,
      post_exit_price_change: { one_minute_pct: null, three_minute_pct: null, five_minute_pct: null, status: 'not_recorded_by_current_history' },
    });
    openBuys.delete(symbol);
  }
  return trips;
}

function buildEntryCohorts(trips = []) {
  const dimensions = {
    setup: (trade) => trade.entry_setup || 'unknown',
    one_minute_momentum: (trade) => bucket(trade.entry_one_minute_return_pct, [-0.05, 0.05, 0.15, 0.3], ['negative', 'flat', 'weak_positive', 'positive', 'strong']),
    relative_volume: (trade) => bucket(trade.entry_relative_volume, [1, 2, 4], ['below_1x', '1_to_2x', '2_to_4x', 'above_4x']),
    opportunity_score: (trade) => bucket(trade.entry_opportunity_score, [70, 80, 90], ['below_70', '70s', '80s', '90_plus']),
    price: (trade) => bucket(trade.entry_price, [5, 20, 50], ['under_5', '5_to_20', '20_to_50', 'above_50']),
    spread: (trade) => bucket(trade.entry_spread_pct, [0.05, 0.15, 0.3], ['tight', 'normal', 'wide', 'very_wide']),
    time_of_day_et: (trade) => timeBucket(trade.bought_at),
  };
  return Object.fromEntries(Object.entries(dimensions).map(([name, resolver]) => [name, summarizeCohorts(trips, resolver)]));
}

function summarizeCohorts(trips, resolver) {
  const groups = new Map();
  for (const trade of trips) {
    const key = resolver(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return [...groups.entries()].map(([cohort, values]) => {
    const pnls = values.map((item) => item.adjusted_pnl).filter(Number.isFinite);
    const wins = pnls.filter((value) => value > 0);
    return { cohort, trades: pnls.length, wins: wins.length, win_rate: pnls.length ? round(wins.length / pnls.length) : null, realized_pnl: round(pnls.reduce((sum, value) => sum + value, 0)), expectancy: pnls.length ? round(pnls.reduce((sum, value) => sum + value, 0) / pnls.length) : null };
  }).sort((a, b) => b.trades - a.trades || String(a.cohort).localeCompare(String(b.cohort)));
}

function buildExitQuality(trips = []) {
  const measured = trips.filter((trade) => Number.isFinite(trade.adjusted_pnl));
  const withPeak = measured.filter((trade) => Number.isFinite(trade.maximum_favorable_excursion));
  return {
    trigger_counts: countBy(measured, (trade) => trade.exit_reason || 'UNKNOWN'),
    trades_measured: measured.length,
    average_holding_seconds: average(measured.map((trade) => trade.hold_seconds)),
    average_execution_drag: average(measured.map((trade) => trade.execution_drag)),
    average_peak_unrealized_pnl: average(withPeak.map((trade) => trade.maximum_favorable_excursion)),
    average_peak_to_exit_giveback: average(withPeak.map((trade) => Number.isFinite(trade.adjusted_pnl) ? trade.maximum_favorable_excursion - trade.adjusted_pnl : null)),
    stop_distance_vs_actual_loss: measured.map((trade) => ({ symbol: trade.symbol, exit_reason: trade.exit_reason, configured_stop_loss_dollars: trade.configured_stop_loss_dollars, actual_pnl: trade.adjusted_pnl, loss_beyond_configured_stop: Number.isFinite(trade.configured_stop_loss_dollars) && Number.isFinite(trade.adjusted_pnl) && trade.adjusted_pnl < 0 ? round(Math.max(0, Math.abs(trade.adjusted_pnl) - trade.configured_stop_loss_dollars)) : null })).slice(-20),
    coverage: {
      favorable_excursion: `${withPeak.length}/${measured.length}`,
      adverse_excursion: `${measured.filter((trade) => Number.isFinite(trade.maximum_adverse_excursion)).length}/${measured.length}`,
      post_exit_1_3_5_minute: 'collection_not_previously_available',
    },
  };
}

function buildDecisionTiming(trips = []) {
  return {
    discovery_to_entry_seconds: summarizeNumbers(trips.map((trade) => trade.discovery_to_entry_seconds)),
    eligible_to_entry_seconds: summarizeNumbers(trips.map((trade) => trade.eligible_to_entry_seconds)),
    entry_quote_age_seconds: summarizeNumbers(trips.map((trade) => trade.entry_quote_age_seconds)),
    entry_fill_latency_ms: summarizeNumbers(trips.map((trade) => trade.entry_fill_latency_ms)),
    exit_fill_latency_ms: summarizeNumbers(trips.map((trade) => trade.exit_fill_latency_ms)),
    confirmation_paths: countBy(trips, (trade) => trade.confirmation_path || 'unknown'),
    discovery_over_one_hour_count: trips.filter((trade) => safeNumber(trade.discovery_to_entry_seconds, 0) > 3600).length,
    momentum_change_during_confirmation: { status: 'not_recorded_as_two_distinct_observations' },
  };
}
function readJsonlIncremental(file, previousCursor) {
  try {
    const size = fs.statSync(file).size;
    const prior = Number(previousCursor);
    const full = !Number.isFinite(prior) || prior < 0 || prior > size;
    const offset = full ? 0 : prior;
    const length = size - offset;
    if (length === 0) return { rows: [], cursor: size, full: false };
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    fs.closeSync(fd);
    const rows = buffer.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return { rows, cursor: size, full };
  } catch { return { rows: [], cursor: Number.isFinite(Number(previousCursor)) ? Number(previousCursor) : null, full: false }; }
}
function ageSeconds(value, now = nowIso()) { const at = new Date(value || '').getTime(); const current = new Date(now).getTime(); return Number.isFinite(at) && Number.isFinite(current) ? Math.max(0, round((current - at) / 1000)) : null; }
function etDate(value) { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)); } catch { return null; } }
function nullableNumber(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value, digits = 4) { return Number(Number(value).toFixed(digits)); }
function average(values) { const measured = values.filter(Number.isFinite); return measured.length ? round(measured.reduce((sum, value) => sum + value, 0) / measured.length) : null; }
function summarizeNumbers(values) { const measured = values.filter(Number.isFinite).sort((a, b) => a - b); return { measured: measured.length, average: average(measured), minimum: measured.at(0) ?? null, median: measured.length ? measured[Math.floor(measured.length / 2)] : null, maximum: measured.at(-1) ?? null }; }
function bucket(value, thresholds, labels) { const number = nullableNumber(value); if (!Number.isFinite(number)) return 'unknown'; const index = thresholds.findIndex((threshold) => number < threshold); return labels[index < 0 ? labels.length - 1 : index]; }
function timeBucket(value) { const date = new Date(value || ''); if (!Number.isFinite(date.getTime())) return 'unknown'; const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date); const hour = Number(parts.find((item) => item.type === 'hour')?.value); const minute = Number(parts.find((item) => item.type === 'minute')?.value); const total = hour * 60 + minute; if (total < 600) return 'open_0930_1000'; if (total < 660) return 'morning_1000_1100'; if (total < 780) return 'midday_1100_1300'; if (total < 900) return 'afternoon_1300_1500'; return 'close_1500_1600'; }
function difference(a, b) { const left = nullableNumber(a); const right = nullableNumber(b); return Number.isFinite(left) && Number.isFinite(right) ? round(left - right) : null; }
function diffObjects(before = {}, after = {}) { const output = {}; for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) output[key] = { before: before[key] ?? null, after: after[key] ?? null }; return output; }
function pick(value, keys) { return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]])); }
function omit(value, keys) { const blocked = new Set(keys); return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !blocked.has(key))); }
function sortCounts(value = {}) { return Object.entries(value || {}).map(([code, count]) => ({ code, count: Number(count) || 0 })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)); }
function countBy(values, fn) { const output = {}; for (const value of values) { const key = fn(value); if (key) output[key] = (output[key] || 0) + 1; } return output; }
function countValues(values) { return countBy(values, (value) => value); }
function mergeUnique(values, keyFn) { const output = new Map(); for (const value of values) output.set(keyFn(value), value); return [...output.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))); }
function executionKey(value) { return `${value.at}|${value.symbol}|${value.side}`; }
function decisionKey(value) { return `${value.at}|${value.symbol || ''}|${value.decision}`; }
function sumNullable(a, b) { return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) + Number(b) : null; }

module.exports = { PULSE_SCHEMA_VERSION, buildWorkflowPulse, refreshWorkflowPulseIfDue, resolveWorkflowPulsePath, writeWorkflowPulse };
