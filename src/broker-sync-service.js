const fs = require('fs');
const path = require('path');
const { reconcileBrokerLocalState } = require('./broker-local-reconciliation');
const { loadTrailingState, saveTrailingState, defaultTrailingStatePath } = require('./position-trailing-state');
const {
  loadPartialFillState,
  reconcilePartialFills,
  savePartialFillState,
  summarizePartialFillState,
} = require('./partial-fill-state');
const {
  loadCandidateLifecycleState,
  summarizeCandidateLifecycleState,
  resolveScannerMode,
} = require('./candidate-lifecycle-state');
const { loadAntiChurnState, saveAntiChurnState } = require('./anti-churn-engine');
const { resolveScannerRuntimePath } = require('./scanner-runtime-state');
const { appendOperatorTimelineEvent } = require('./operator-timeline');
const { hashObject, nowIso, resolveRepoRoot, safeNumber } = require('./util');

const ReasonCode = {
  BROKER_SYNC_OK: 'BROKER_SYNC_OK',
  BROKER_SYNC_NO_REPAIR_NEEDED: 'BROKER_SYNC_NO_REPAIR_NEEDED',
  BROKER_SYNC_POSITION_REMOVED: 'BROKER_SYNC_POSITION_REMOVED',
  BROKER_SYNC_CAPACITY_REOPENED: 'BROKER_SYNC_CAPACITY_REOPENED',
  BROKER_SYNC_RETURNED_TO_HUNT: 'BROKER_SYNC_RETURNED_TO_HUNT',
  BROKER_SYNC_BUY_BLOCKED_OPEN_ORDER: 'BROKER_SYNC_BUY_BLOCKED_OPEN_ORDER',
  BROKER_SYNC_BUY_BLOCKED_PARTIAL_FILL: 'BROKER_SYNC_BUY_BLOCKED_PARTIAL_FILL',
  BROKER_SYNC_FAILED_BROKER_UNAVAILABLE: 'BROKER_SYNC_FAILED_BROKER_UNAVAILABLE',
  EXTERNAL_BROKER_POSITION_CLOSED: 'EXTERNAL_BROKER_POSITION_CLOSED',
};

async function syncLocalStateFromBroker(options = {}) {
  const checkedAt = options.now || nowIso();
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const env = options.env || process.env;
  const executionAdapter = options.executionAdapter;
  const maxOpenPositions = Math.max(0, Math.floor(safeNumber(options.maxOpenPositions ?? env.MAX_OPEN_POSITIONS, 1)));
  const beforeProcessState = options.controlManager?.getState?.() || options.controlState || null;
  const beforeLocal = readLocalState({ env, repoRoot });
  const beforeIntegrity = buildIntegritySummary(beforeLocal);

  const diagnostic = await reconcileBrokerLocalState({
    ...options,
    env,
    repoRoot,
    executionAdapter,
    now: checkedAt,
  });

  const brokerVisible = diagnostic.account_available
    && diagnostic.positions_available
    && diagnostic.open_orders_available
    && !diagnostic.critical_failures.includes('BROKER_ACCOUNT_UNAVAILABLE')
    && !diagnostic.critical_failures.includes('BROKER_POSITIONS_UNAVAILABLE')
    && !diagnostic.critical_failures.includes('BROKER_OPEN_ORDERS_UNAVAILABLE');

  if (!brokerVisible) {
    const result = {
      ok: false,
      status: 'error',
      timestamp: checkedAt,
      reason_codes: [ReasonCode.BROKER_SYNC_FAILED_BROKER_UNAVAILABLE],
      message: 'Broker sync failed closed because Alpaca account, positions, or open orders could not all be read.',
      alpaca_visibility: {
        account_available: Boolean(diagnostic.account_available),
        positions_available: Boolean(diagnostic.positions_available),
        open_orders_available: Boolean(diagnostic.open_orders_available),
      },
      diagnostic,
      repaired_local_state: [],
      unresolved_mismatches: diagnostic.mismatches || [],
      preserved: buildPreservedFlags(beforeProcessState, beforeProcessState, beforeIntegrity, beforeIntegrity),
      scanner_pid_before: pidOf(beforeProcessState?.scanner),
      scanner_pid_after: pidOf(beforeProcessState?.scanner),
      trader_pid_before: pidOf(beforeProcessState?.trader),
      trader_pid_after: pidOf(beforeProcessState?.trader),
    };
    appendSyncTimeline(result, options);
    return result;
  }

  const brokerPositions = Array.isArray(diagnostic.alpaca_positions) ? diagnostic.alpaca_positions : [];
  const brokerOpenOrders = Array.isArray(diagnostic.alpaca_open_orders) ? diagnostic.alpaca_open_orders : [];
  const brokerPositionSymbols = new Set(brokerPositions.map((position) => normalizeSymbol(position.symbol)).filter(Boolean));
  const openSellSymbols = new Set(brokerOpenOrders
    .filter((order) => isActiveOrder(order) && String(order.side || '').toLowerCase() === 'sell')
    .map((order) => normalizeSymbol(order.symbol))
    .filter(Boolean));

  const beforeTrailingPositions = beforeLocal.trailing?.positions || {};
  const staleTrailingSymbols = Object.keys(beforeTrailingPositions)
    .map(normalizeSymbol)
    .filter((symbol) => symbol && !brokerPositionSymbols.has(symbol));
  const fullyClosedSymbols = staleTrailingSymbols.filter((symbol) => !openSellSymbols.has(symbol));
  const unsettledSymbols = staleTrailingSymbols.filter((symbol) => openSellSymbols.has(symbol));

  const repaired = [];
  const events = [];
  let nextTrailing = beforeLocal.trailing;
  if (fullyClosedSymbols.length) {
    const nextPositions = { ...(beforeTrailingPositions || {}) };
    for (const symbol of fullyClosedSymbols) {
      const previous = beforeTrailingPositions[symbol] || beforeTrailingPositions[normalizeSymbol(symbol)] || {};
      delete nextPositions[symbol];
      repaired.push({
        state: 'position_trailing_state',
        action: 'removed_stale_position',
        symbol,
        reason_codes: [ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED, ReasonCode.BROKER_SYNC_POSITION_REMOVED],
      });
      events.push({
        event_type: ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED,
        symbol,
        previous_quantity: safeNumber(previous.quantity ?? previous.qty ?? previous.filled_quantity, null),
        broker_quantity_after_sync: 0,
        detection_time: checkedAt,
        detection_source: options.source || 'dashboard_broker_sync',
        open_order_involved: false,
      });
    }
    nextTrailing = saveTrailingState({ ...beforeLocal.trailing, positions: nextPositions }, { env, repoRoot });
  }

  const beforePartial = beforeLocal.partialFill;
  const nextPartial = await reconcilePartialFills({
    executionAdapter,
    previousState: beforePartial,
    openOrders: brokerOpenOrders,
    positions: brokerPositions,
    now: checkedAt,
    options: { authoritativeOpenOrders: true },
  });
  const beforePartialHash = hashObject(beforePartial.orders || {});
  const afterPartialHash = hashObject(nextPartial.orders || {});
  if (beforePartialHash !== afterPartialHash) {
    savePartialFillState(nextPartial, { env, repoRoot });
    repaired.push({
      state: 'partial_fill_state',
      action: 'reconciled_against_broker_open_orders',
      reason_codes: ['PARTIAL_FILL_RECONCILED_FROM_BROKER_SYNC'],
    });
  }

  let antiChurnState = beforeLocal.antiChurn;
  for (const event of events) {
    antiChurnState = recordExternalExitCooldown(antiChurnState, event, checkedAt, env);
  }
  if (events.length && hashObject(antiChurnState) !== hashObject(beforeLocal.antiChurn)) {
    saveAntiChurnState(antiChurnState, { env, repoRoot });
    repaired.push({
      state: 'anti_churn_state',
      action: 'recorded_external_exit_cooldown',
      symbols: events.map((event) => event.symbol),
      reason_codes: [ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED],
    });
  }

  const afterProcessState = options.controlManager?.getState?.() || beforeProcessState;
  const afterLocal = {
    ...readLocalState({ env, repoRoot }),
    trailing: nextTrailing,
    partialFill: nextPartial,
    antiChurn: antiChurnState,
  };
  const afterIntegrity = buildIntegritySummary(afterLocal);
  const partialSummary = summarizePartialFillState(nextPartial);
  const positionsBefore = countPositionsFromTrailing(beforeTrailingPositions);
  const positionsAfter = brokerPositions.length;
  const partialBlock = partialSummary.count > 0 || partialSummary.partial_sell_remaining_exposure?.length > 0;
  const buyBlocked = unsettledSymbols.length > 0 || partialBlock;
  const beforeSlots = Math.max(0, maxOpenPositions - Math.max(positionsBefore, 0));
  const afterSlots = buyBlocked
    ? 0
    : Math.max(0, maxOpenPositions - brokerPositions.length);
  const scannerModeBefore = resolveScannerMode({
    scannerMode: beforeLocal.candidateLifecycle.mode || 'hunt',
    portfolio: {
      open_positions_count: Math.max(positionsBefore, brokerPositions.length),
      open_buy_order_count: countOpenOrders(brokerOpenOrders, 'buy'),
      partial_buy_order_count: summarizePartialFillState(beforePartial).partial_buys?.length || 0,
    },
    openOrders: brokerOpenOrders,
  });
  const scannerModeAfter = resolveScannerMode({
    scannerMode: afterLocal.candidateLifecycle.mode || 'hunt',
    portfolio: {
      open_positions_count: brokerPositions.length,
      open_buy_order_count: countOpenOrders(brokerOpenOrders, 'buy'),
      partial_buy_order_count: partialSummary.partial_buys?.length || 0,
    },
    openOrders: brokerOpenOrders,
  });

  const reasonCodes = [
    repaired.length ? ReasonCode.BROKER_SYNC_OK : ReasonCode.BROKER_SYNC_NO_REPAIR_NEEDED,
    ...(fullyClosedSymbols.length ? [ReasonCode.BROKER_SYNC_POSITION_REMOVED] : []),
    ...(afterSlots > beforeSlots ? [ReasonCode.BROKER_SYNC_CAPACITY_REOPENED] : []),
    ...(scannerModeBefore !== 'hunt' && scannerModeAfter === 'hunt' ? [ReasonCode.BROKER_SYNC_RETURNED_TO_HUNT] : []),
    ...(unsettledSymbols.length ? [ReasonCode.BROKER_SYNC_BUY_BLOCKED_OPEN_ORDER] : []),
    ...(partialBlock ? [ReasonCode.BROKER_SYNC_BUY_BLOCKED_PARTIAL_FILL] : []),
  ];

  const result = {
    ok: true,
    status: unsettledSymbols.length || partialBlock ? 'warning' : 'ok',
    timestamp: checkedAt,
    reason_codes: [...new Set(reasonCodes)],
    message: buildSyncMessage({ positionsBefore, positionsAfter, repaired, afterSlots, buyBlocked }),
    alpaca_visibility: {
      account_available: true,
      positions_available: true,
      open_orders_available: true,
    },
    account: diagnostic.account || null,
    positions_before: positionsBefore,
    positions_after: positionsAfter,
    open_orders_before: beforeLocal.openOrderCount,
    open_orders_after: brokerOpenOrders.length,
    available_position_slots_before: beforeSlots,
    available_position_slots_after: afterSlots,
    buy_capacity_released: afterSlots > beforeSlots && !buyBlocked,
    buy_blocked: buyBlocked,
    repaired_local_state: repaired,
    external_broker_events: events,
    unresolved_mismatches: [
      ...diagnostic.mismatches.filter((mismatch) => !fullyClosedSymbols.includes(normalizeSymbol(mismatch.symbol))),
      ...unsettledSymbols.map((symbol) => ({
        type: 'EXTERNAL_POSITION_CLOSE_HAS_OPEN_SELL_ORDER',
        symbol,
        severity: 'warning',
        reason_codes: [ReasonCode.BROKER_SYNC_BUY_BLOCKED_OPEN_ORDER],
      })),
    ],
    preserved: buildPreservedFlags(beforeProcessState, afterProcessState, beforeIntegrity, afterIntegrity),
    scanner_pid_before: pidOf(beforeProcessState?.scanner),
    scanner_pid_after: pidOf(afterProcessState?.scanner),
    trader_pid_before: pidOf(beforeProcessState?.trader),
    trader_pid_after: pidOf(afterProcessState?.trader),
    scanner_mode_before: scannerModeBefore,
    scanner_mode_after: scannerModeAfter,
    candidate_lifecycle_summary: summarizeCandidateLifecycleState(afterLocal.candidateLifecycle),
    partial_fill_summary: partialSummary,
    diagnostic,
  };
  appendSyncTimeline(result, options);
  return result;
}

function readLocalState({ env, repoRoot }) {
  const scannerRuntimePath = resolveScannerRuntimePath(env, repoRoot);
  const scannerRuntime = readJson(scannerRuntimePath);
  const candidateLifecycle = loadCandidateLifecycleState({ env, repoRoot });
  const trailing = loadTrailingState({ env, repoRoot });
  const partialFill = loadPartialFillState({ env, repoRoot });
  const antiChurn = loadAntiChurnState({ env, repoRoot });
  return {
    scannerRuntimePath,
    scannerRuntime,
    candidateLifecycle,
    trailingPath: defaultTrailingStatePath({ env, repoRoot }),
    trailing,
    partialFill,
    antiChurn,
    openOrderCount: Array.isArray(scannerRuntime?.open_orders) ? scannerRuntime.open_orders.length : 0,
  };
}

function buildIntegritySummary(localState = {}) {
  return {
    scanner_runtime_hash: hashObject(localState.scannerRuntime || {}),
    candidate_queue_hash: hashObject(localState.candidateLifecycle?.candidates || {}),
    candidate_selected_key: localState.candidateLifecycle?.selected_key || null,
    dynamic_hot_list_hash: hashObject(localState.scannerRuntime?.dynamic_hot_symbols || localState.scannerRuntime?.dynamic_top_symbols || []),
    regular_watch_hash: hashObject(localState.scannerRuntime?.regular_watch || localState.scannerRuntime?.regular_watch_summary || {}),
    execution_mode: localState.scannerRuntime?.execution_mode || localState.scannerRuntime?.selected_execution_mode || null,
  };
}

function buildPreservedFlags(beforeProcessState, afterProcessState, beforeIntegrity, afterIntegrity) {
  return {
    scanner_process: pidOf(beforeProcessState?.scanner) === pidOf(afterProcessState?.scanner),
    trader_process: pidOf(beforeProcessState?.trader) === pidOf(afterProcessState?.trader),
    candidate_queue: beforeIntegrity.candidate_queue_hash === afterIntegrity.candidate_queue_hash,
    dynamic_hot_list: beforeIntegrity.dynamic_hot_list_hash === afterIntegrity.dynamic_hot_list_hash,
    regular_watch_history: beforeIntegrity.regular_watch_hash === afterIntegrity.regular_watch_hash,
    execution_mode: beforeIntegrity.execution_mode === afterIntegrity.execution_mode,
  };
}

function recordExternalExitCooldown(state, event, now, env = process.env) {
  const symbol = normalizeSymbol(event.symbol);
  if (!symbol) return state;
  const seconds = Math.max(60, Math.floor(safeNumber(env.EXTERNAL_EXIT_ANTI_CHURN_SECONDS, 5 * 60)));
  const existing = state.symbol_cooldowns?.[symbol];
  if (existing?.reason_codes?.includes(ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED)) return state;
  const expiresAt = new Date(new Date(now).getTime() + seconds * 1000).toISOString();
  return {
    ...state,
    updated_at: now,
    symbol_cooldowns: {
      ...(state.symbol_cooldowns || {}),
      [symbol]: {
        symbol,
        last_traded_at: now,
        age_seconds: 0,
        window_seconds: seconds,
        remaining_seconds: seconds,
        penalty: 100,
        penalty_points: 100,
        reason: ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED,
        reason_codes: [ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED, 'ANTI_CHURN_COOLDOWN_ACTIVE'],
        loss_exit: false,
        stop_exit: false,
        exit_reason: ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED,
        classification: 'external_broker_exit',
        severity: 'medium',
        cooldown_until: expiresAt,
        expires_at: expiresAt,
        triggered_at: now,
        explanation: 'Symbol was closed outside Workflow 2; do not immediately recreate the same position.',
        components: [],
      },
    },
    recent_classifications: [
      ...(Array.isArray(state.recent_classifications) ? state.recent_classifications : []),
      {
        symbol,
        classification: 'external_broker_exit',
        penalty_points: 100,
        cooldown_seconds: seconds,
        cooldown_until: expiresAt,
        reason_codes: [ReasonCode.EXTERNAL_BROKER_POSITION_CLOSED],
        recorded_at: now,
      },
    ].slice(-100),
  };
}

function appendSyncTimeline(result, options = {}) {
  appendOperatorTimelineEvent({
    timestamp: result.timestamp,
    event_type: result.ok ? 'broker.sync' : 'broker.sync_failed',
    source: options.source || 'dashboard_broker_sync',
    title: result.ok ? 'Broker sync complete' : 'Broker sync failed',
    message: result.message,
    severity: result.ok && result.status !== 'warning' ? 'info' : 'warning',
    details: {
      reason_codes: result.reason_codes,
      positions_before: result.positions_before,
      positions_after: result.positions_after,
      repaired_local_state: result.repaired_local_state,
      scanner_pid_before: result.scanner_pid_before,
      scanner_pid_after: result.scanner_pid_after,
      preserved: result.preserved,
    },
  }, options);
}

function buildSyncMessage({ positionsBefore, positionsAfter, repaired, afterSlots, buyBlocked }) {
  if (!repaired.length) {
    return buyBlocked
      ? 'Broker sync completed with no repair, but buy-side capacity remains blocked by open order or partial-fill protection.'
      : 'Broker sync completed. Alpaca and local position-dependent state already matched.';
  }
  const repairedText = repaired.length === 1 ? 'one local state item' : `${repaired.length} local state items`;
  const slotText = buyBlocked ? 'Buy-side capacity remains protected.' : `${afterSlots} position slot(s) available.`;
  return `Broker sync complete. Alpaca positions changed from ${positionsBefore} local assumption(s) to ${positionsAfter}. Repaired ${repairedText}. ${slotText}`;
}

function countPositionsFromTrailing(positions = {}) {
  return Object.keys(positions || {}).filter(Boolean).length;
}

function countOpenOrders(orders = [], side = null) {
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    if (!isActiveOrder(order)) return false;
    return !side || String(order.side || '').toLowerCase() === side;
  }).length;
}

function isActiveOrder(order = {}) {
  const status = String(order.status || '').toLowerCase();
  return ['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'open'].includes(status);
}

function pidOf(processState = {}) {
  const pid = processState?.pid ?? processState?.process_id ?? processState?.details?.pid ?? null;
  return Number.isFinite(Number(pid)) ? Number(pid) : null;
}

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return symbol || null;
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

module.exports = {
  ReasonCode,
  syncLocalStateFromBroker,
};
