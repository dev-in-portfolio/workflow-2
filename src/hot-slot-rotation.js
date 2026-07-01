const { parseBool } = require('./config');
const { safeNumber, nowIso, roundCurrency, roundScore } = require('./util');

function resolveHotSlotRotationConfig(env = process.env) {
  return {
    enabled: parseBool(env.MEME_HOT_SLOT_ROTATION_ENABLED, false),
    minHeatScore: Math.max(0, safeNumber(env.MEME_HOT_SLOT_ROTATION_MIN_HEAT_SCORE, 90)),
    minMarketScore: Math.max(0, safeNumber(env.MEME_HOT_SLOT_ROTATION_MIN_MARKET_SCORE, 75)),
    requireBreakevenOrBetter: parseBool(env.MEME_ROTATION_REQUIRE_BREAKEVEN_OR_BETTER, true),
    allowTinyLoss: parseBool(env.MEME_ROTATION_ALLOW_TINY_LOSS, false),
    maxAllowedLossDollars: Math.max(0, safeNumber(env.MEME_ROTATION_MAX_ALLOWED_LOSS_DOLLARS, 0)),
    protectStrongRunners: parseBool(env.MEME_ROTATION_PROTECT_STRONG_RUNNERS, true),
    recheckAfterExit: parseBool(env.MEME_ROTATION_RECHECK_AFTER_EXIT, true),
    exitTimeoutSeconds: Math.max(1, Math.floor(safeNumber(env.MEME_ROTATION_EXIT_TIMEOUT_SECONDS, 30))),
    entryRecheckMaxAgeSeconds: Math.max(1, Math.floor(safeNumber(env.MEME_ROTATION_ENTRY_RECHECK_MAX_AGE_SECONDS, 30))),
  };
}

function evaluateHotSlotRotationPlan({
  featureState = null,
  config = resolveHotSlotRotationConfig(),
  buyCandidates = [],
  hotHotEntries = [],
  portfolio = {},
  positions = [],
  openOrders = [],
  partialFillSummary = null,
  trailingState = null,
  snapshots = {},
  runtimeCandidates = [],
  currentDate = nowIso(),
  brokerState = null,
} = {}) {
  const timestamp = nowIso();
  const base = {
    requested: Boolean(config.enabled),
    enabled: Boolean(config.enabled),
    status: 'off',
    lastDecision: 'rotation_blocked_feature_disabled',
    lastDecisionAt: timestamp,
    candidate: null,
    candidateHeatScore: null,
    candidateMarketScore: null,
    accountFull: false,
    evictionCandidate: null,
    evictionReason: null,
    expectedExitPnl: null,
    decision: 'rotation_blocked_feature_disabled',
    reasonCodes: ['rotation_blocked_feature_disabled'],
    rotationEligible: false,
    blockReason: 'rotation_blocked_feature_disabled',
    selectedCandidate: null,
    selectedEviction: null,
    feature: featureState || null,
    config,
  };

  if (!config.enabled) return base;

  const featureStatus = String(featureState?.status || '').toLowerCase();
  if (featureStatus === 'blocked' || featureState?.blocked_reason) {
    return {
      ...base,
      enabled: false,
      status: 'blocked',
      lastDecision: 'rotation_blocked_dependency_disabled',
      decision: 'rotation_blocked_dependency_disabled',
      reasonCodes: ['rotation_blocked_dependency_disabled'],
      blockReason: featureState?.blocked_reason || 'rotation_blocked_dependency_disabled',
    };
  }

  const brokerUnavailable = Boolean(brokerState && (
    brokerState.account_available === false
      || brokerState.positions_available === false
      || brokerState.open_orders_available === false
      || brokerState.available === false
  ));
  if (brokerUnavailable) {
    return {
      ...base,
      enabled: true,
      status: 'error',
      lastDecision: 'rotation_blocked_broker_reconciliation_failed',
      decision: 'rotation_blocked_broker_reconciliation_failed',
      reasonCodes: ['rotation_blocked_broker_reconciliation_failed'],
      blockReason: 'rotation_blocked_broker_reconciliation_failed',
    };
  }

  const accountFull = isAccountFull(portfolio);
  const selectedHotHot = selectHotHotRotationCandidate({
    buyCandidates,
    hotHotEntries,
    config,
  });

  if (!accountFull) {
    return {
      ...base,
      enabled: true,
      status: 'active',
      lastDecision: 'rotation_blocked_account_not_full',
      decision: 'rotation_blocked_account_not_full',
      reasonCodes: ['rotation_blocked_account_not_full'],
      accountFull: false,
      candidate: selectedHotHot?.candidate?.symbol || null,
      candidateHeatScore: selectedHotHot?.heatScore ?? null,
      candidateMarketScore: selectedHotHot?.marketScore ?? null,
      blockReason: 'rotation_blocked_account_not_full',
      selectedCandidate: selectedHotHot?.candidate || null,
    };
  }

  if (!selectedHotHot) {
    return {
      ...base,
      enabled: true,
      status: 'active',
      lastDecision: 'rotation_blocked_no_eligible_position',
      decision: 'rotation_blocked_no_eligible_position',
      reasonCodes: ['rotation_blocked_no_eligible_position'],
      accountFull: true,
      blockReason: 'rotation_blocked_no_eligible_position',
    };
  }

  const runtimeBySymbol = new Map((Array.isArray(runtimeCandidates) ? runtimeCandidates : []).map((entry) => [normalizeSymbol(entry?.symbol), entry]));
  const selectedEviction = selectRotationEvictionCandidate({
    positions,
    openOrders,
    partialFillSummary,
    trailingState,
    snapshots,
    hotHotCandidate: selectedHotHot,
    runtimeBySymbol,
    config,
    currentDate,
  });

  if (!selectedEviction?.candidate) {
    return {
      ...base,
      enabled: true,
      status: 'active',
      lastDecision: selectedEviction?.decision || 'rotation_blocked_no_eligible_position',
      decision: selectedEviction?.decision || 'rotation_blocked_no_eligible_position',
      reasonCodes: selectedEviction?.reasonCodes || ['rotation_blocked_no_eligible_position'],
      accountFull: true,
      candidate: selectedHotHot.candidate.symbol,
      candidateHeatScore: selectedHotHot.heatScore,
      candidateMarketScore: selectedHotHot.marketScore,
      blockReason: selectedEviction?.blockReason || 'rotation_blocked_no_eligible_position',
      selectedCandidate: selectedHotHot.candidate,
    };
  }

  return {
    ...base,
    enabled: true,
    status: 'active',
    lastDecision: 'rotation_eviction_candidate_selected',
    decision: 'rotation_eviction_candidate_selected',
    reasonCodes: ['hot_slot_rotation_requested', 'rotation_eviction_candidate_selected'],
    accountFull: true,
    candidate: selectedHotHot.candidate.symbol,
    candidateHeatScore: selectedHotHot.heatScore,
    candidateMarketScore: selectedHotHot.marketScore,
    evictionCandidate: selectedEviction.candidate.symbol,
    evictionReason: selectedEviction.reason,
    expectedExitPnl: selectedEviction.netPnl,
    rotationEligible: true,
    blockReason: null,
    selectedCandidate: selectedHotHot.candidate,
    selectedEviction: selectedEviction.candidate,
  };
}

function selectHotHotRotationCandidate({
  buyCandidates = [],
  hotHotEntries = [],
  config = resolveHotSlotRotationConfig(),
} = {}) {
  const hotHotMap = new Map();
  for (const entry of Array.isArray(hotHotEntries) ? hotHotEntries : []) {
    const symbol = normalizeSymbol(entry?.symbol);
    if (!symbol) continue;
    hotHotMap.set(symbol, entry);
  }

  const eligible = [];
  for (const candidate of Array.isArray(buyCandidates) ? buyCandidates : []) {
    const symbol = normalizeSymbol(candidate?.symbol);
    if (!symbol) continue;
    const hotHotEntry = hotHotMap.get(symbol);
    if (!hotHotEntry) continue;
    if (String(hotHotEntry.status || '').toLowerCase() !== 'hot_hot') continue;
    if (hotHotEntry.expired) continue;
    const heatScore = safeNumber(hotHotEntry.memeHeatScore, null);
    const marketScore = safeNumber(hotHotEntry.marketConfirmationScore, null);
    const safety = resolveRotationSafety(hotHotEntry);
    if (!Number.isFinite(heatScore) || heatScore < config.minHeatScore) continue;
    if (!Number.isFinite(marketScore) || marketScore < config.minMarketScore) continue;
    if (safety.blocked) continue;
    eligible.push({
      candidate,
      hotHotEntry,
      heatScore,
      marketScore,
      sortScore: Number(candidate.priorityOverrideSortScore ?? candidate.rankScore ?? 0),
      compositeScore: heatScore + marketScore,
    });
  }

  if (!eligible.length) return null;
  eligible.sort((a, b) => {
    const sortDelta = b.sortScore - a.sortScore;
    if (Math.abs(sortDelta) > 1e-9) return sortDelta;
    const compositeDelta = b.compositeScore - a.compositeScore;
    if (Math.abs(compositeDelta) > 1e-9) return compositeDelta;
    return normalizeSymbol(a.candidate.symbol).localeCompare(normalizeSymbol(b.candidate.symbol));
  });
  return eligible[0];
}

function selectRotationEvictionCandidate({
  positions = [],
  openOrders = [],
  partialFillSummary = null,
  trailingState = null,
  snapshots = {},
  hotHotCandidate = null,
  runtimeBySymbol = new Map(),
  config = resolveHotSlotRotationConfig(),
  currentDate = nowIso(),
} = {}) {
  const activeOrders = Array.isArray(openOrders) ? openOrders : [];
  const activePartials = Array.isArray(partialFillSummary?.partial_sells) ? partialFillSummary.partial_sells : [];
  const eligible = [];
  const rejections = [];

  for (const position of Array.isArray(positions) ? positions : []) {
    const evaluation = evaluateRotationPositionCandidate(position, {
      activeOrders,
      activePartials,
      trailingState,
      snapshots,
      runtimeCandidate: runtimeBySymbol.get(normalizeSymbol(position?.symbol)) || null,
      hotHotCandidate,
      config,
      currentDate,
    });
    if (evaluation.eligible) eligible.push(evaluation);
    else rejections.push(evaluation);
  }

  if (!eligible.length) {
    const reason = rejections.find((item) => item.blockReason)?.blockReason || 'rotation_blocked_no_eligible_position';
    return {
      candidate: null,
      blockedReason: reason,
      reasonCodes: [reason],
      decision: reason,
      rejections,
    };
  }

  eligible.sort((a, b) => {
    const pnlDelta = safeNumber(a.netPnl, 0) - safeNumber(b.netPnl, 0);
    if (Math.abs(pnlDelta) > 1e-9) return pnlDelta;
    const momentumDelta = safeNumber(a.momentumPct, 0) - safeNumber(b.momentumPct, 0);
    if (Math.abs(momentumDelta) > 1e-9) return momentumDelta;
    const opportunityDelta = safeNumber(b.opportunityGap, -Infinity) - safeNumber(a.opportunityGap, -Infinity);
    if (Math.abs(opportunityDelta) > 1e-9) return opportunityDelta;
    const scannerDelta = safeNumber(a.scannerScore, Infinity) - safeNumber(b.scannerScore, Infinity);
    if (Math.abs(scannerDelta) > 1e-9) return scannerDelta;
    return normalizeSymbol(a.symbol).localeCompare(normalizeSymbol(b.symbol));
  });

  return {
    candidate: eligible[0].position,
    reason: eligible[0].reason,
    reasonCodes: eligible[0].reasonCodes,
    netPnl: eligible[0].netPnl,
    momentumPct: eligible[0].momentumPct,
    scannerScore: eligible[0].scannerScore,
    opportunityGap: eligible[0].opportunityGap,
    eligible,
    rejections,
  };
}

function evaluateRotationPositionCandidate(position = {}, {
  activeOrders = [],
  openOrders = [],
  activePartials = [],
  partialFillSummary = null,
  trailingState = null,
  snapshots = {},
  runtimeCandidate = null,
  hotHotCandidate = null,
  config = resolveHotSlotRotationConfig(),
  currentDate = nowIso(),
} = {}) {
  const symbol = normalizeSymbol(position.symbol);
  const qty = Math.abs(safeNumber(position.qty ?? position.quantity ?? position.qty_available, 0));
  const entryPrice = safeNumber(position.avg_entry_price ?? position.avgEntryPrice, null);
  const snapshot = snapshots[symbol] || {};
  const currentPrice = resolveCurrentPrice(snapshot, position);
  const previousClose = safeNumber(snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.c ?? position.previous_close ?? null, null);
  const spreadPct = resolveSpreadPct(snapshot, currentPrice);
  const volume = safeNumber(snapshot.latestQuote?.v ?? snapshot.latestTrade?.v ?? snapshot.minuteBar?.v ?? snapshot.prevDailyBar?.v ?? null, null);
  const averageVolume = safeNumber(snapshot.prevDailyBar?.v ?? snapshot.dailyBar?.v ?? position.average_volume ?? null, null);
  const partials = [
    ...(Array.isArray(activePartials) ? activePartials : []),
    ...(Array.isArray(partialFillSummary?.partial_sells) ? partialFillSummary.partial_sells : []),
  ];
  const orders = [
    ...(Array.isArray(activeOrders) ? activeOrders : []),
    ...(Array.isArray(openOrders) ? openOrders : []),
  ];
  const volumeMultiple = Number.isFinite(volume) && Number.isFinite(averageVolume) && averageVolume > 0
    ? Number((volume / averageVolume).toFixed(2))
    : null;
  const momentumPct = Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(currentPrice)
    ? Number((((currentPrice - entryPrice) / entryPrice) * 100).toFixed(2))
    : null;
  const grossPnl = Number.isFinite(entryPrice) && Number.isFinite(currentPrice)
    ? roundCurrency((currentPrice - entryPrice) * qty)
    : safeNumber(position.unrealized_pl ?? position.unrealizedPnl ?? position.unrealized_intraday_pl, null);
  const estimatedExitDrag = Number.isFinite(currentPrice)
    ? roundCurrency(Math.max(0, currentPrice * qty * ((Math.max(0, safeNumber(spreadPct, 0)) / 100) + 0.001)))
    : 0;
  const netPnl = Number.isFinite(grossPnl) ? roundCurrency(grossPnl - estimatedExitDrag) : null;
  const trailingRecord = trailingState?.positions?.[symbol] || {};
  const trailingActive = Boolean(trailingRecord.trailing_active);
  const protectiveOrder = orders.find((order) => {
    const orderSymbol = normalizeSymbol(order?.symbol);
    const side = String(order?.side || '').trim().toLowerCase();
    const type = String(order?.type || order?.order_type || order?.order_class || '').trim().toLowerCase();
    return orderSymbol === symbol
      && side === 'sell'
      && (type.includes('stop') || type.includes('trailing') || order.stop_price || order.trail_price || order.trail_percent);
  }) || null;
  const openOrderConflict = orders.find((order) => {
    const orderSymbol = normalizeSymbol(order?.symbol);
    const status = String(order?.status || '').trim().toLowerCase();
    return orderSymbol === symbol && isOpenOrderStatusActive(status);
  }) || null;
  const partialFillConflict = partials.find((order) => normalizeSymbol(order?.symbol) === symbol && safeNumber(order?.remaining_qty, 0) > 0) || null;
  const scannerScore = Number.isFinite(Number(runtimeCandidate?.adjusted_rank_score ?? runtimeCandidate?.rank_score))
    ? Number(runtimeCandidate.adjusted_rank_score ?? runtimeCandidate.rank_score)
    : fallbackScannerScore({ currentPrice, previousClose, spreadPct, momentumPct });
  const hotHotCompositeScore = hotHotCandidate
    ? safeNumber(hotHotCandidate.heatScore, 0) + safeNumber(hotHotCandidate.marketScore, 0)
    : 0;
  const opportunityGap = Number.isFinite(scannerScore) ? roundScore(hotHotCompositeScore - scannerScore) : null;
  const strongRunner = Boolean(
    config.protectStrongRunners && (
      trailingActive
      || (Number.isFinite(netPnl) && netPnl >= Math.max(2, Math.abs(entryPrice || 0) * qty * 0.03))
      || (Number.isFinite(momentumPct) && momentumPct >= 3 && Number.isFinite(volumeMultiple) && volumeMultiple >= 1.25)
    ),
  );
  const accelerated = Boolean(Number.isFinite(momentumPct) && momentumPct >= 2 && Number.isFinite(volumeMultiple) && volumeMultiple >= 1.1);
  const protective = Boolean(protectiveOrder || trailingActive);

  if (!symbol || !Number.isFinite(qty) || qty <= 0) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_no_eligible_position'], blockReason: 'rotation_blocked_no_eligible_position' };
  }
  if (partialFillConflict) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_partial_fill_state'], blockReason: 'rotation_blocked_partial_fill_state' };
  }
  if (openOrderConflict) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_open_order_conflict'], blockReason: 'rotation_blocked_open_order_conflict' };
  }
  if (protective) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_open_order_conflict'], blockReason: 'rotation_blocked_open_order_conflict' };
  }
  if (strongRunner || accelerated) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_strong_runner'], blockReason: 'rotation_blocked_strong_runner' };
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(currentPrice)) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_no_eligible_position'], blockReason: 'rotation_blocked_no_eligible_position' };
  }
  if (config.requireBreakevenOrBetter && Number.isFinite(netPnl) && netPnl < 0) {
    if (!config.allowTinyLoss || Math.abs(netPnl) > config.maxAllowedLossDollars) {
      return { eligible: false, symbol, reasonCodes: ['rotation_blocked_eviction_not_breakeven'], blockReason: 'rotation_blocked_eviction_not_breakeven' };
    }
  }
  if (!config.requireBreakevenOrBetter && Number.isFinite(netPnl) && netPnl < -Math.abs(config.maxAllowedLossDollars || 0)) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_eviction_not_breakeven'], blockReason: 'rotation_blocked_eviction_not_breakeven' };
  }
  if (Number.isFinite(grossPnl) && grossPnl >= 0 && Number.isFinite(netPnl) && netPnl < 0) {
    return { eligible: false, symbol, reasonCodes: ['rotation_blocked_eviction_spread_slippage'], blockReason: 'rotation_blocked_eviction_spread_slippage' };
  }

  const reason = determineEvictionReason({ netPnl, momentumPct, volumeMultiple, opportunityGap, scannerScore });
  return {
    eligible: true,
    position,
    symbol,
    currentPrice,
    previousClose,
    spreadPct,
    volume,
    averageVolume,
    volumeMultiple,
    entryPrice,
    grossPnl,
    estimatedExitDrag,
    netPnl,
    momentumPct,
    scannerScore,
    opportunityGap,
    reason,
    reasonCodes: ['rotation_eviction_candidate_selected'],
    blockReason: null,
    currentDate,
  };
}

function summarizeHotSlotRotationRuntime(rotationState = {}, featureState = null) {
  const status = String(rotationState?.status || 'off').toLowerCase();
  const enabled = Boolean(featureState?.effective ?? rotationState?.enabled ?? false);
  return {
    enabled,
    status: rotationState?.status || (enabled ? 'active' : 'off'),
    lastDecision: rotationState?.lastDecision || rotationState?.decision || null,
    lastDecisionAt: rotationState?.lastDecisionAt || null,
    candidate: rotationState?.candidate || null,
    candidateHeatScore: safeNumber(rotationState?.candidateHeatScore, null),
    candidateMarketScore: safeNumber(rotationState?.candidateMarketScore, null),
    accountFull: Boolean(rotationState?.accountFull),
    evictionCandidate: rotationState?.evictionCandidate || null,
    evictionReason: rotationState?.evictionReason || null,
    expectedExitPnl: safeNumber(rotationState?.expectedExitPnl, null),
    reasonCodes: Array.isArray(rotationState?.reasonCodes) ? rotationState.reasonCodes.slice() : [],
    rotationEligible: Boolean(rotationState?.rotationEligible),
    blockReason: rotationState?.blockReason || null,
    requested: Boolean(rotationState?.requested),
    enabled_effective: enabled,
    raw_status: status,
  };
}

function isAccountFull(portfolio = {}) {
  const remainingSlots = safeNumber(portfolio.remaining_position_slots, null);
  if (Number.isFinite(remainingSlots)) return remainingSlots <= 0;
  const maxOpen = safeNumber(portfolio.max_open_positions, null);
  const openPositions = safeNumber(portfolio.open_positions_count, 0);
  return Number.isFinite(maxOpen) ? openPositions >= maxOpen : false;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function resolveTradableStatus(details = null) {
  if (!details) return 'unknown';
  if (details.excluded) return 'excluded';
  if (details.halted) return 'halted';
  if (details.tradable === false) return 'blocked';
  if (details.tradable === true) return 'tradable';
  return 'unknown';
}

function resolveRotationSafety(hotHotEntry = {}) {
  const marketDetails = hotHotEntry.marketConfirmationDetails || {};
  const phaseA = hotHotEntry.phaseA || {};
  const sourceConfirmations = hotHotEntry.sourceConfirmations || {};
  const phaseASourceConfirmations = phaseA.sourceConfirmations || {};
  const phaseATradable = String(phaseA.tradableStatus || phaseA.tradable_status || '').toLowerCase();
  const phaseAHalt = String(phaseA.haltStatus || phaseA.halt_status || '').toLowerCase();
  const marketTradableStatus = resolveTradableStatus(marketDetails);
  const tradableEvidence = [
    marketDetails.tradable === true,
    phaseATradable === 'tradable',
    phaseA.tradable === true,
    sourceConfirmations.alpacaAssets === true,
    phaseASourceConfirmations.alpacaAssets === true,
  ];
  const blockedTradableEvidence = [
    marketDetails.tradable === false,
    ['blocked', 'not_found', 'excluded', 'halted'].includes(marketTradableStatus),
    phaseATradable === 'blocked',
    phaseATradable === 'not_found',
  ];
  const haltEvidence = [
    marketDetails.halted === true,
    phaseAHalt === 'halted',
  ];
  const notHaltEvidence = [
    marketDetails.halted === false,
    phaseAHalt === 'not_halted',
    phaseAHalt === 'open',
    sourceConfirmations.nasdaqHalts === true,
    phaseASourceConfirmations.nasdaqHalts === true,
  ];
  const hasTradableEvidence = tradableEvidence.some(Boolean);
  const hasBlockedEvidence = blockedTradableEvidence.some(Boolean);
  const hasHaltEvidence = haltEvidence.some(Boolean);
  const hasNotHaltedEvidence = notHaltEvidence.some(Boolean);
  const unknownTradable = !hasTradableEvidence && !hasBlockedEvidence && marketTradableStatus === 'unknown' && !['tradable', 'blocked', 'not_found'].includes(phaseATradable);
  const unknownHalt = !hasHaltEvidence && !hasNotHaltedEvidence && !['halted', 'not_halted', 'open'].includes(phaseAHalt) && marketDetails.halted !== false;
  const blocked = Boolean(
    marketDetails.excluded
    || marketDetails.halted
    || hasBlockedEvidence
    || hasHaltEvidence
    || unknownTradable
    || unknownHalt,
  );

  return {
    blocked,
    tradableStatus: blocked
      ? (marketDetails.excluded ? 'excluded' : marketDetails.halted ? 'halted' : phaseATradable || marketTradableStatus || 'unknown')
      : (phaseATradable || marketTradableStatus || 'tradable'),
    haltStatus: phaseAHalt || (marketDetails.halted ? 'halted' : hasNotHaltedEvidence ? 'not_halted' : 'unknown'),
  };
}

function resolveCurrentPrice(snapshot = {}, position = {}) {
  return safeNumber(
    snapshot.latestQuote?.p
      ?? snapshot.latestTrade?.p
      ?? snapshot.minuteBar?.c
      ?? snapshot.dailyBar?.c
      ?? position.current_price
      ?? position.market_price
      ?? null,
    null,
  );
}

function resolveSpreadPct(snapshot = {}, currentPrice = null) {
  const bid = safeNumber(snapshot.latestQuote?.bp ?? snapshot.latestQuote?.bid_price ?? snapshot.latestQuote?.bid, null);
  const ask = safeNumber(snapshot.latestQuote?.ap ?? snapshot.latestQuote?.ask_price ?? snapshot.latestQuote?.ask, null);
  if (Number.isFinite(bid) && Number.isFinite(ask) && Number.isFinite(currentPrice) && currentPrice > 0) {
    return roundScore(((ask - bid) / currentPrice) * 100);
  }
  return safeNumber(snapshot.spread_pct ?? snapshot.spreadPct, 0);
}

function isOpenOrderStatusActive(status) {
  return new Set([
    'new',
    'accepted',
    'pending_new',
    'partially_filled',
    'submitted_to_paper',
    'approved',
    'proposal',
    'proposed',
    'approval_required',
    'risk_checked',
    'open',
  ]).has(String(status || '').trim().toLowerCase());
}

function fallbackScannerScore({ currentPrice, previousClose, spreadPct, momentumPct }) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousClose) || previousClose <= 0) {
    return 0;
  }
  const moveScore = Number.isFinite(momentumPct) ? Math.max(0, 100 - Math.abs(momentumPct) * 8) : 40;
  const spreadPenalty = Math.max(0, safeNumber(spreadPct, 0) * 4);
  return roundScore(Math.max(0, moveScore - spreadPenalty));
}

function determineEvictionReason({
  netPnl = null,
  momentumPct = null,
  volumeMultiple = null,
  opportunityGap = null,
  scannerScore = null,
} = {}) {
  if (Number.isFinite(netPnl) && netPnl <= 0.25 && Number.isFinite(momentumPct) && momentumPct <= 0.5) {
    return 'small_profit_weak_momentum';
  }
  if (Number.isFinite(netPnl) && Math.abs(netPnl) <= 0.25 && Number.isFinite(momentumPct) && Math.abs(momentumPct) <= 0.5) {
    return 'break_even_flat_momentum';
  }
  if (Number.isFinite(netPnl) && netPnl > 0.25 && (Number.isFinite(momentumPct) && momentumPct <= 1 || Number.isFinite(volumeMultiple) && volumeMultiple <= 1.2)) {
    return 'slightly_profitable_but_stale_low_momentum';
  }
  if (Number.isFinite(opportunityGap) && opportunityGap > 0) {
    return 'lowest_opportunity_score';
  }
  if (Number.isFinite(scannerScore)) {
    return 'worst_current_scanner_score';
  }
  return 'small_profit_weak_momentum';
}

module.exports = {
  determineEvictionReason,
  evaluateHotSlotRotationPlan,
  evaluateRotationPositionCandidate,
  resolveHotSlotRotationConfig,
  selectHotHotRotationCandidate,
  selectRotationEvictionCandidate,
  summarizeHotSlotRotationRuntime,
};
