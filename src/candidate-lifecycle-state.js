const path = require('path');
const { nowIso, safeNumber, clamp, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');

const CandidateLifecycleReason = {
  CANDIDATE_QUEUE_WATCHING: 'CANDIDATE_QUEUE_WATCHING',
  CANDIDATE_QUEUE_ELIGIBLE: 'CANDIDATE_QUEUE_ELIGIBLE',
  CANDIDATE_QUEUE_BLOCKED: 'CANDIDATE_QUEUE_BLOCKED',
  CANDIDATE_QUEUE_EXPIRED: 'CANDIDATE_QUEUE_EXPIRED',
  CANDIDATE_QUEUE_CONFIRMED: 'CANDIDATE_QUEUE_CONFIRMED',
  CANDIDATE_CONFIRMATION_REQUIRED: 'CANDIDATE_CONFIRMATION_REQUIRED',
  CANDIDATE_MAX_AGE_EXCEEDED: 'CANDIDATE_MAX_AGE_EXCEEDED',
  CANDIDATE_RANK_BELOW_FLOOR: 'CANDIDATE_RANK_BELOW_FLOOR',
  HUNT_TO_MONITOR_LATCH_ACTIVE: 'HUNT_TO_MONITOR_LATCH_ACTIVE',
  MANAGE_ONLY_MODE_ACTIVE: 'MANAGE_ONLY_MODE_ACTIVE',
  MONITOR_MODE_NEW_BUYS_BLOCKED: 'MONITOR_MODE_NEW_BUYS_BLOCKED',
  MICRO_ROTATION_GUARD_ACTIVE: 'MICRO_ROTATION_GUARD_ACTIVE',
  RANK_CONFIDENCE_DECAYED: 'RANK_CONFIDENCE_DECAYED',
};

function defaultCandidateLifecycleStatePath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return path.resolve(env.CANDIDATE_LIFECYCLE_STATE_PATH || path.join(repoRoot, 'data', 'state', 'candidate-lifecycle-state.json'));
}

function loadCandidateLifecycleState(filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultCandidateLifecycleStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  try {
    const data = store.read(name);
    return data ? normalizeCandidateLifecycleState(data) : normalizeCandidateLifecycleState({});
  } catch {
    return normalizeCandidateLifecycleState({});
  }
}

function saveCandidateLifecycleState(state, filePathOrOptions = {}) {
  const filePath = typeof filePathOrOptions === 'string'
    ? filePathOrOptions
    : defaultCandidateLifecycleStatePath(filePathOrOptions);
  const store = new JsonFileStore(path.dirname(filePath));
  const payload = normalizeCandidateLifecycleState(state);
  payload.updated_at = nowIso();
  store.write(path.basename(filePath), payload);
  return payload;
}

function normalizeCandidateLifecycleState(state = {}) {
  const candidates = state.candidates && typeof state.candidates === 'object'
    ? state.candidates
    : state.candidate_queue && typeof state.candidate_queue === 'object'
      ? state.candidate_queue
      : {};
  return {
    version: state.version || '2026-06-25.candidate-lifecycle-state.1',
    updated_at: state.updated_at || null,
    last_reconciled_at: state.last_reconciled_at || null,
    mode: normalizeMode(state.mode || state.scanner_mode || 'hunt'),
    queue_enabled: Boolean(state.queue_enabled),
    selected_key: normalizeText(state.selected_key || null) || null,
    selection_state: normalizeSelectionState(state.selection_state || state.rotation_state || {}),
    queue_state: normalizeQueueState(state.queue_state || {}),
    candidates: normalizeCandidateMap(candidates),
  };
}

function normalizeQueueState(queueState = {}) {
  if (!queueState || typeof queueState !== 'object') {
    return {
      soft_band_points: 0,
      hard_band_points: 0,
      min_hold_scans: 0,
      rank_floor: 0,
      last_rotation_at: null,
      last_rotation_reason_codes: [],
    };
  }
  return {
    soft_band_points: Math.max(0, safeNumber(queueState.soft_band_points, 0)),
    hard_band_points: Math.max(0, safeNumber(queueState.hard_band_points, 0)),
    min_hold_scans: Math.max(0, Math.floor(safeNumber(queueState.min_hold_scans, 0))),
    rank_floor: safeNumber(queueState.rank_floor, 0),
    last_rotation_at: normalizeIso(queueState.last_rotation_at || null),
    last_rotation_reason_codes: normalizeReasonCodes(queueState.last_rotation_reason_codes),
  };
}

function normalizeSelectionState(selectionState = {}) {
  if (!selectionState || typeof selectionState !== 'object') {
    return {
      selected_key: null,
      selected_symbol: null,
      selected_rank: null,
      selected_decayed_rank: null,
      selected_at: null,
      hold_scans: 0,
    };
  }
  return {
    selected_key: normalizeText(selectionState.selected_key || null) || null,
    selected_symbol: normalizeSymbol(selectionState.selected_symbol || null),
    selected_rank: safeNumber(selectionState.selected_rank, null),
    selected_decayed_rank: safeNumber(selectionState.selected_decayed_rank, null),
    selected_at: normalizeIso(selectionState.selected_at || null),
    hold_scans: Math.max(0, Math.floor(safeNumber(selectionState.hold_scans, 0))),
  };
}

function normalizeCandidateMap(source = {}) {
  const map = {};
  for (const [key, value] of Object.entries(source || {})) {
    const normalized = normalizeCandidateEntry(value, key);
    if (normalized) map[normalized.candidate_key] = normalized;
  }
  return map;
}

function normalizeCandidateEntry(entry = {}, fallbackKey = null) {
  if (!entry || typeof entry !== 'object') return null;
  const setupKey = normalizeText(entry.setup_key || entry.setupKey || null) || null;
  const symbol = normalizeSymbol(entry.symbol || fallbackKey?.split('::')?.[0] || null);
  const candidateKey = normalizeCandidateKey(symbol, setupKey || fallbackKey?.split('::')?.[1] || null);
  if (!candidateKey) return null;
  const history = Array.isArray(entry.rank_history) ? entry.rank_history.slice(-24).map(normalizeRankHistoryEntry).filter(Boolean) : [];
  return {
    candidate_key: candidateKey,
    symbol,
    setup_key: setupKey,
    first_seen_at: normalizeIso(entry.first_seen_at || null),
    last_seen_at: normalizeIso(entry.last_seen_at || null),
    scans_seen: Math.max(0, Math.floor(safeNumber(entry.scans_seen, 0))),
    latest_rank: safeNumber(entry.latest_rank, 0),
    peak_rank: safeNumber(entry.peak_rank, 0),
    decayed_rank: safeNumber(entry.decayed_rank, 0),
    rank_history: history,
    status: normalizeStatus(entry.status || 'watching'),
    expires_at: normalizeIso(entry.expires_at || null),
    reason_codes: normalizeReasonCodes(entry.reason_codes),
    updated_at: normalizeIso(entry.updated_at || null),
    entered_at: normalizeIso(entry.entered_at || null),
    blocked_at: normalizeIso(entry.blocked_at || null),
    eligible_at: normalizeIso(entry.eligible_at || null),
    expired_at: normalizeIso(entry.expired_at || null),
    last_rank_change_at: normalizeIso(entry.last_rank_change_at || null),
    decay_factor: clamp(safeNumber(entry.decay_factor, 1), 0, 1),
    age_seconds: Math.max(0, Math.floor(safeNumber(entry.age_seconds, 0))),
    stale_seconds: Math.max(0, Math.floor(safeNumber(entry.stale_seconds, 0))),
    confirmation_scans_required: Math.max(0, Math.floor(safeNumber(entry.confirmation_scans_required, 0))),
    confirmation_seconds_required: Math.max(0, Math.floor(safeNumber(entry.confirmation_seconds_required, 0))),
    queue_reason: normalizeText(entry.queue_reason || null) || null,
    scanner_mode: normalizeMode(entry.scanner_mode || 'hunt'),
  };
}

function normalizeRankHistoryEntry(entry = {}) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    at: normalizeIso(entry.at || entry.timestamp || null),
    raw_rank: safeNumber(entry.raw_rank, null),
    decayed_rank: safeNumber(entry.decayed_rank, null),
    status: normalizeStatus(entry.status || null) || null,
    reason_codes: normalizeReasonCodes(entry.reason_codes),
  };
}

function normalizeReasonCodes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['watching', 'eligible', 'entered', 'expired', 'blocked'].includes(normalized)) return normalized;
  return 'watching';
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['hunt', 'monitor', 'manage_only', 'paused'].includes(normalized)) return normalized;
  return 'hunt';
}

function normalizeIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return symbol || null;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeCandidateKey(symbol, setupKey = null) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return null;
  const normalizedSetup = normalizeText(setupKey || '').toLowerCase();
  return normalizedSetup ? `${normalizedSymbol}::${normalizedSetup}` : normalizedSymbol;
}

function decayCandidateRank({
  rawRank = 0,
  firstSeenAt = null,
  lastSeenAt = null,
  now = nowIso(),
  enabled = false,
  halfLifeSeconds = 300,
  maxStaleSeconds = 900,
} = {}) {
  const rank = safeNumber(rawRank, 0);
  const firstMs = new Date(firstSeenAt || now).getTime();
  const lastMs = new Date(lastSeenAt || now).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(rank) || !Number.isFinite(firstMs) || !Number.isFinite(lastMs) || !Number.isFinite(nowMs)) {
    return {
      raw_rank: roundScore(rank),
      age_seconds: 0,
      stale_seconds: 0,
      decay_factor: 1,
      decayed_rank: roundScore(rank),
      reason_codes: [],
    };
  }
  const ageSeconds = Math.max(0, Math.round((nowMs - firstMs) / 1000));
  const staleSeconds = Math.max(0, Math.round((nowMs - lastMs) / 1000));
  if (!enabled) {
    return {
      raw_rank: roundScore(rank),
      age_seconds: ageSeconds,
      stale_seconds: staleSeconds,
      decay_factor: 1,
      decayed_rank: roundScore(rank),
      reason_codes: [],
    };
  }
  const halfLife = Math.max(1, safeNumber(halfLifeSeconds, 300));
  const maxStale = Math.max(0, safeNumber(maxStaleSeconds, 900));
  if (maxStale > 0 && staleSeconds >= maxStale) {
    return {
      raw_rank: roundScore(rank),
      age_seconds: ageSeconds,
      stale_seconds: staleSeconds,
      decay_factor: 0,
      decayed_rank: 0,
      reason_codes: [CandidateLifecycleReason.RANK_CONFIDENCE_DECAYED],
    };
  }
  const decayFactor = Math.pow(0.5, Math.max(0, staleSeconds) / halfLife);
  const decayedRank = roundScore(rank * decayFactor);
  return {
    raw_rank: roundScore(rank),
    age_seconds: ageSeconds,
    stale_seconds: staleSeconds,
    decay_factor: roundScore(decayFactor, 6),
    decayed_rank: decayedRank,
    reason_codes: decayFactor < 1 ? [CandidateLifecycleReason.RANK_CONFIDENCE_DECAYED] : [],
  };
}

function reconcileCandidateLifecycleState({
  previousState = {},
  candidates = [],
  now = nowIso(),
  queueEnabled = false,
  minScansBeforeEntry = 2,
  minSecondsBeforeEntry = 30,
  maxAgeSeconds = 600,
  confirmationRequired = true,
  queueMaxSize = 12,
  rankFloor = 0,
  decayEnabled = false,
  halfLifeSeconds = 300,
  maxStaleSeconds = 900,
  huntToMonitorLatchEnabled = true,
  monitorModeAllowsNewBuys = false,
  manageOnlyBlocksBuys = true,
  scannerMode = 'hunt',
  sessionGuards = null,
  portfolio = null,
  openOrders = null,
  selectedKey = null,
  selectionState = null,
  softBandPoints = 4,
  hardBandPoints = 12,
  minHoldScans = 1,
} = {}) {
  const state = normalizeCandidateLifecycleState(previousState);
  const currentMode = resolveScannerMode({
    scannerMode,
    sessionGuards,
    portfolio,
    openOrders,
    huntToMonitorLatchEnabled,
    manageOnlyBlocksBuys,
  });
  const queueActive = Boolean(queueEnabled);
  const minScans = Math.max(1, Math.floor(safeNumber(minScansBeforeEntry, 1)));
  const minSeconds = Math.max(0, Math.floor(safeNumber(minSecondsBeforeEntry, 0)));
  const maxAge = Math.max(1, Math.floor(safeNumber(maxAgeSeconds, 600)));
  const floor = safeNumber(rankFloor, 0);
  const prevMap = new Map(Object.values(state.candidates || {}).map((entry) => [entry.candidate_key, entry]));
  const nextMap = new Map();
  const seenKeys = new Set();
  const candidateDetails = [];

  const queueLimitedCandidates = [...candidates]
    .filter(Boolean)
    .slice(0, Math.max(1, Math.floor(safeNumber(queueMaxSize, 12))));

  for (const candidate of queueLimitedCandidates) {
    const symbol = normalizeSymbol(candidate.symbol);
    const setupKey = normalizeText(candidate.setupKey || candidate.setup_key || candidate.payload?.market_context?.setup_key || null) || null;
    const candidateKey = normalizeCandidateKey(symbol, setupKey);
    if (!candidateKey) continue;
    seenKeys.add(candidateKey);
    const previous = prevMap.get(candidateKey) || {};
    const latestRank = roundScore(safeNumber(
      candidate.rankScore
        ?? candidate.adjustedRankScore
        ?? candidate.payload?.market_context?.scanner?.rank_score
        ?? candidate.payload?.market_context?.scanner?.adjusted_rank_score
        ?? 0,
      0,
    ));
    const firstSeenAt = normalizeIso(previous.first_seen_at || now);
    const history = Array.isArray(previous.rank_history) ? previous.rank_history.slice(-23) : [];
    const decay = decayCandidateRank({
      rawRank: latestRank,
      firstSeenAt,
      lastSeenAt: now,
      now,
      enabled: decayEnabled,
      halfLifeSeconds,
      maxStaleSeconds,
    });
    const scansSeen = Math.max(0, Math.floor(safeNumber(previous.scans_seen, 0))) + 1;
    const peakRank = Math.max(safeNumber(previous.peak_rank, latestRank), latestRank);
    const decayedRank = roundScore(decay.decayed_rank);
    const ageSeconds = decay.age_seconds;
    const staleSeconds = decay.stale_seconds;
    const expired = maxAge > 0 && ageSeconds >= maxAge;
    const aboveFloor = decayedRank >= floor;
    const persistedAboveFloor = !confirmationRequired || history.filter((entry) => safeNumber(entry.decayed_rank, 0) >= floor).length + 1 >= minScans;
    const persistenceSatisfied = scansSeen >= minScans && ageSeconds >= minSeconds && aboveFloor && persistedAboveFloor;
    const previousStatus = normalizeStatus(previous.status || 'watching');
    const reasonCodes = new Set([
      ...(normalizeReasonCodes(previous.reason_codes)),
      ...(decay.reason_codes || []),
    ]);
    let status = previousStatus || 'watching';
    let queueReason = previous.queue_reason || null;
    let blockedAt = normalizeIso(previous.blocked_at || null);
    let eligibleAt = normalizeIso(previous.eligible_at || null);
    let expiredAt = normalizeIso(previous.expired_at || null);
    const enteredAt = normalizeIso(previous.entered_at || null);

    if (expired) {
      status = 'expired';
      queueReason = CandidateLifecycleReason.CANDIDATE_MAX_AGE_EXCEEDED;
      expiredAt = now;
      reasonCodes.add(CandidateLifecycleReason.CANDIDATE_QUEUE_EXPIRED);
      reasonCodes.add(CandidateLifecycleReason.CANDIDATE_MAX_AGE_EXCEEDED);
    } else if (currentMode === 'manage_only' && manageOnlyBlocksBuys) {
      status = 'blocked';
      queueReason = CandidateLifecycleReason.MANAGE_ONLY_MODE_ACTIVE;
      blockedAt = now;
      reasonCodes.add(CandidateLifecycleReason.MANAGE_ONLY_MODE_ACTIVE);
      reasonCodes.add(CandidateLifecycleReason.HUNT_TO_MONITOR_LATCH_ACTIVE);
    } else if (currentMode === 'monitor' && !monitorModeAllowsNewBuys) {
      status = 'blocked';
      queueReason = CandidateLifecycleReason.MONITOR_MODE_NEW_BUYS_BLOCKED;
      blockedAt = now;
      reasonCodes.add(CandidateLifecycleReason.MONITOR_MODE_NEW_BUYS_BLOCKED);
      reasonCodes.add(CandidateLifecycleReason.HUNT_TO_MONITOR_LATCH_ACTIVE);
    } else if (!aboveFloor) {
      status = 'blocked';
      queueReason = CandidateLifecycleReason.CANDIDATE_RANK_BELOW_FLOOR;
      blockedAt = now;
      reasonCodes.add(CandidateLifecycleReason.CANDIDATE_RANK_BELOW_FLOOR);
    } else if (queueActive) {
      if (persistenceSatisfied) {
        status = 'eligible';
        queueReason = CandidateLifecycleReason.CANDIDATE_QUEUE_ELIGIBLE;
        eligibleAt = eligibleAt || now;
        reasonCodes.add(CandidateLifecycleReason.CANDIDATE_QUEUE_ELIGIBLE);
        if (confirmationRequired) reasonCodes.add(CandidateLifecycleReason.CANDIDATE_CONFIRMATION_REQUIRED);
      } else {
        status = 'watching';
        queueReason = CandidateLifecycleReason.CANDIDATE_QUEUE_WATCHING;
        reasonCodes.add(CandidateLifecycleReason.CANDIDATE_QUEUE_WATCHING);
        if (confirmationRequired && (!scansSeen || scansSeen < minScans || ageSeconds < minSeconds || !persistedAboveFloor)) {
          reasonCodes.add(CandidateLifecycleReason.CANDIDATE_CONFIRMATION_REQUIRED);
        }
      }
    } else {
      status = aboveFloor ? 'eligible' : 'watching';
      queueReason = status === 'eligible'
        ? CandidateLifecycleReason.CANDIDATE_QUEUE_ELIGIBLE
        : CandidateLifecycleReason.CANDIDATE_QUEUE_WATCHING;
      reasonCodes.add(queueReason);
    }

    const next = {
      candidate_key: candidateKey,
      symbol,
      setup_key: setupKey,
      first_seen_at: firstSeenAt || now,
      last_seen_at: now,
      scans_seen: scansSeen,
      latest_rank: latestRank,
      peak_rank: roundScore(peakRank),
      decayed_rank: decayedRank,
      rank_history: [...history, {
        at: now,
        raw_rank: latestRank,
        decayed_rank: decayedRank,
        status,
        reason_codes: [...reasonCodes],
      }].slice(-24),
      status,
      expires_at: expired ? now : normalizeIso(previous.expires_at || null),
      reason_codes: [...reasonCodes],
      updated_at: now,
      entered_at: status === 'entered' ? (enteredAt || now) : enteredAt,
      blocked_at: status === 'blocked' ? (blockedAt || now) : blockedAt,
      eligible_at: status === 'eligible' ? (eligibleAt || now) : eligibleAt,
      expired_at: status === 'expired' ? (expiredAt || now) : expiredAt,
      last_rank_change_at: previous.latest_rank !== latestRank ? now : normalizeIso(previous.last_rank_change_at || null),
      decay_factor: decay.decay_factor,
      age_seconds: ageSeconds,
      stale_seconds: staleSeconds,
      confirmation_scans_required: minScans,
      confirmation_seconds_required: minSeconds,
      queue_reason: queueReason,
      scanner_mode: currentMode,
    };
    nextMap.set(candidateKey, next);
    candidateDetails.push({ candidate, entry: next, previous, queueActive, queueReason, aboveFloor, persistenceSatisfied, expired });
  }

  for (const [candidateKey, previous] of prevMap.entries()) {
    if (nextMap.has(candidateKey)) continue;
    const ageSeconds = Math.max(0, Math.round((new Date(now).getTime() - new Date(previous.last_seen_at || previous.first_seen_at || now).getTime()) / 1000));
    const expired = maxAge > 0 && ageSeconds >= maxAge;
    const status = expired ? 'expired' : previous.status || 'watching';
    nextMap.set(candidateKey, {
      ...previous,
      status,
      reason_codes: expired
        ? [...new Set([...(previous.reason_codes || []), CandidateLifecycleReason.CANDIDATE_QUEUE_EXPIRED, CandidateLifecycleReason.CANDIDATE_MAX_AGE_EXCEEDED])]
        : [...(previous.reason_codes || [])],
      queue_reason: expired ? CandidateLifecycleReason.CANDIDATE_MAX_AGE_EXCEEDED : previous.queue_reason || CandidateLifecycleReason.CANDIDATE_QUEUE_WATCHING,
      expired_at: expired ? now : normalizeIso(previous.expired_at || null),
      updated_at: now,
      last_reconciled_at: now,
      age_seconds: ageSeconds,
      stale_seconds: ageSeconds,
      scanner_mode: currentMode,
    });
  }

  const rankedEligible = candidateDetails
    .filter(({ entry }) => entry.status === 'eligible')
    .sort((a, b) => compareCandidateEntries(a.entry, b.entry));
  const currentSelectedEntry = state.selection_state?.selected_key
    ? nextMap.get(state.selection_state.selected_key) || null
    : null;
  const nextSelection = chooseSelection({
    currentSelectedEntry,
    topEligibleEntry: rankedEligible[0]?.entry || null,
    queueActive,
    queueEnabled,
    softBandPoints,
    hardBandPoints,
    minHoldScans,
    now,
    currentMode,
  });

  if (nextSelection?.selected_key && nextMap.has(nextSelection.selected_key)) {
    const selected = nextMap.get(nextSelection.selected_key);
    selected.status = queueActive ? 'entered' : selected.status;
    selected.entered_at = selected.entered_at || now;
    selected.reason_codes = [...new Set([...(selected.reason_codes || []), CandidateLifecycleReason.CANDIDATE_QUEUE_CONFIRMED])];
    nextMap.set(nextSelection.selected_key, selected);
  }

  const nextState = normalizeCandidateLifecycleState({
    version: state.version,
    updated_at: now,
    last_reconciled_at: now,
    mode: currentMode,
    queue_enabled: queueActive,
    selected_key: nextSelection?.selected_key || null,
    selection_state: nextSelection?.selection_state || normalizeSelectionState({}),
    queue_state: {
      soft_band_points: softBandPoints,
      hard_band_points: hardBandPoints,
      min_hold_scans: minHoldScans,
      rank_floor: floor,
      last_rotation_at: nextSelection?.rotation_at || null,
      last_rotation_reason_codes: nextSelection?.reason_codes || [],
    },
    candidates: Object.fromEntries(nextMap.entries()),
  });

  return {
    state: nextState,
    summary: summarizeCandidateLifecycleState(nextState),
    selection: nextSelection,
    current_mode: currentMode,
    candidate_details: candidateDetails.map(({ candidate, entry, queueReason }) => ({
      symbol: candidate.symbol,
      setup_key: entry.setup_key,
      candidate_key: entry.candidate_key,
      status: entry.status,
      queue_reason: queueReason,
      reason_codes: entry.reason_codes,
      latest_rank: entry.latest_rank,
      peak_rank: entry.peak_rank,
      decayed_rank: entry.decayed_rank,
      age_seconds: entry.age_seconds,
      stale_seconds: entry.stale_seconds,
      scans_seen: entry.scans_seen,
      first_seen_at: entry.first_seen_at,
      last_seen_at: entry.last_seen_at,
      expired_at: entry.expired_at,
      entered_at: entry.entered_at,
      blocked_at: entry.blocked_at,
      eligible_at: entry.eligible_at,
      decay_factor: entry.decay_factor,
    })),
  };
}

function chooseSelection({
  currentSelectedEntry = null,
  topEligibleEntry = null,
  queueActive = false,
  queueEnabled = false,
  softBandPoints = 4,
  hardBandPoints = 12,
  minHoldScans = 1,
  now = nowIso(),
  currentMode = 'hunt',
} = {}) {
  if (!queueEnabled || !topEligibleEntry) {
    return {
      selected_key: queueEnabled ? null : topEligibleEntry?.candidate_key || currentSelectedEntry?.candidate_key || null,
      selection_state: normalizeSelectionState(currentSelectedEntry ? {
        selected_key: currentSelectedEntry.candidate_key,
        selected_symbol: currentSelectedEntry.symbol,
        selected_rank: currentSelectedEntry.latest_rank,
        selected_decayed_rank: currentSelectedEntry.decayed_rank,
        selected_at: currentSelectedEntry.entered_at || currentSelectedEntry.first_seen_at || now,
        hold_scans: Math.max(0, safeNumber(currentSelectedEntry.scans_seen, 0)),
      } : {}),
      reason_codes: [],
      rotation_at: null,
    };
  }
  const selected = currentSelectedEntry?.status === 'entered' || currentSelectedEntry?.status === 'eligible'
    ? currentSelectedEntry
    : null;
  if (!selected) {
    return {
      selected_key: topEligibleEntry.candidate_key,
      selection_state: normalizeSelectionState({
        selected_key: topEligibleEntry.candidate_key,
        selected_symbol: topEligibleEntry.symbol,
        selected_rank: topEligibleEntry.latest_rank,
        selected_decayed_rank: topEligibleEntry.decayed_rank,
        selected_at: now,
        hold_scans: 1,
      }),
      reason_codes: [CandidateLifecycleReason.CANDIDATE_QUEUE_CONFIRMED],
      rotation_at: now,
    };
  }
  const selectedRank = safeNumber(selected.decayed_rank, selected.latest_rank);
  const topRank = safeNumber(topEligibleEntry.decayed_rank, topEligibleEntry.latest_rank);
  const delta = roundScore(topRank - selectedRank);
  const holdScans = Math.max(0, safeNumber(selected.scans_seen, 0));
  if (topEligibleEntry.candidate_key === selected.candidate_key) {
    return {
      selected_key: selected.candidate_key,
      selection_state: normalizeSelectionState({
        selected_key: selected.candidate_key,
        selected_symbol: selected.symbol,
        selected_rank: selected.latest_rank,
        selected_decayed_rank: selected.decayed_rank,
        selected_at: selected.entered_at || selected.first_seen_at || now,
        hold_scans: holdScans,
      }),
      reason_codes: [],
      rotation_at: null,
    };
  }
  const microRotationGuard = delta < softBandPoints || holdScans < minHoldScans && delta < hardBandPoints;
  if (microRotationGuard) {
    return {
      selected_key: selected.candidate_key,
      selection_state: normalizeSelectionState({
        selected_key: selected.candidate_key,
        selected_symbol: selected.symbol,
        selected_rank: selected.latest_rank,
        selected_decayed_rank: selected.decayed_rank,
        selected_at: selected.entered_at || selected.first_seen_at || now,
        hold_scans: holdScans + 1,
      }),
      reason_codes: [CandidateLifecycleReason.MICRO_ROTATION_GUARD_ACTIVE],
      rotation_at: null,
    };
  }
  if (delta >= hardBandPoints || (delta >= softBandPoints && holdScans >= minHoldScans)) {
    return {
      selected_key: topEligibleEntry.candidate_key,
      selection_state: normalizeSelectionState({
        selected_key: topEligibleEntry.candidate_key,
        selected_symbol: topEligibleEntry.symbol,
        selected_rank: topEligibleEntry.latest_rank,
        selected_decayed_rank: topEligibleEntry.decayed_rank,
        selected_at: now,
        hold_scans: 1,
      }),
      reason_codes: [CandidateLifecycleReason.CANDIDATE_QUEUE_CONFIRMED],
      rotation_at: now,
    };
  }
  return {
    selected_key: selected.candidate_key,
    selection_state: normalizeSelectionState({
      selected_key: selected.candidate_key,
      selected_symbol: selected.symbol,
      selected_rank: selected.latest_rank,
      selected_decayed_rank: selected.decayed_rank,
      selected_at: selected.entered_at || selected.first_seen_at || now,
      hold_scans: holdScans + 1,
    }),
    reason_codes: [CandidateLifecycleReason.MICRO_ROTATION_GUARD_ACTIVE],
    rotation_at: null,
  };
}

function resolveScannerMode({
  scannerMode = 'hunt',
  sessionGuards = null,
  portfolio = null,
  openOrders = null,
  huntToMonitorLatchEnabled = true,
  manageOnlyBlocksBuys = true,
} = {}) {
  const requested = normalizeMode(scannerMode);
  if (!huntToMonitorLatchEnabled) return requested;
  if (sessionGuards?.manage_only && manageOnlyBlocksBuys) return 'manage_only';
  if (sessionGuards?.buy_blocked && manageOnlyBlocksBuys) return 'manage_only';
  const hasOpenPositions = Number(safeNumber(portfolio?.open_positions_count, 0)) > 0;
  const hasOpenBuyOrders = Number(safeNumber(portfolio?.open_buy_order_count, 0)) > 0;
  const hasPartialBuys = Number(safeNumber(portfolio?.partial_buy_order_count, 0)) > 0;
  const hasProtectiveOrders = Boolean(openOrders?.length) && Array.isArray(openOrders) && openOrders.some((order) => String(order?.side || '').toLowerCase() === 'sell');
  if (hasOpenPositions || hasOpenBuyOrders || hasPartialBuys || hasProtectiveOrders) {
    return 'monitor';
  }
  if (requested === 'paused') return 'paused';
  return 'hunt';
}

function summarizeCandidateLifecycleState(state = {}) {
  const normalized = normalizeCandidateLifecycleState(state);
  const candidates = Object.values(normalized.candidates || {});
  const watchedCandidates = candidates.filter((entry) => entry.status === 'watching');
  const eligibleCandidates = candidates.filter((entry) => entry.status === 'eligible');
  const enteredCandidates = candidates.filter((entry) => entry.status === 'entered');
  const expiredCandidates = candidates.filter((entry) => entry.status === 'expired');
  const blockedCandidates = candidates.filter((entry) => entry.status === 'blocked');
  const reasonCodes = [...new Set(candidates.flatMap((entry) => entry.reason_codes || []))];
  return {
    status: normalized.mode === 'paused' ? 'PAUSED' : 'ACTIVE',
    queue_enabled: Boolean(normalized.queue_enabled),
    scanner_mode: normalized.mode,
    selected_key: normalized.selected_key || normalized.selection_state?.selected_key || null,
    selected_symbol: normalized.selection_state?.selected_symbol || null,
    selected_rank: safeNumber(normalized.selection_state?.selected_rank, null),
    selected_decayed_rank: safeNumber(normalized.selection_state?.selected_decayed_rank, null),
    watched_count: watchedCandidates.length,
    eligible_count: eligibleCandidates.length,
    entered_count: enteredCandidates.length,
    expired_count: expiredCandidates.length,
    blocked_count: blockedCandidates.length,
    total_count: candidates.length,
    watched_candidates: watchedCandidates,
    eligible_candidates: eligibleCandidates,
    entered_candidates: enteredCandidates,
    expired_candidates: expiredCandidates,
    blocked_candidates: blockedCandidates,
    rank_floor: safeNumber(normalized.queue_state?.rank_floor, null),
    queue_state: normalized.queue_state || {},
    selection_state: normalized.selection_state || null,
    rotation_decision: {
      selected_key: normalized.selected_key || null,
      last_rotation_at: normalized.queue_state?.last_rotation_at || null,
      last_rotation_reason_codes: normalized.queue_state?.last_rotation_reason_codes || [],
    },
    reason_codes: reasonCodes,
    warnings: [
      ...(blockedCandidates.length ? ['BLOCKED_CANDIDATES_PRESENT'] : []),
      ...(expiredCandidates.length ? ['EXPIRED_CANDIDATES_PRESENT'] : []),
    ],
    recommended_actions: [
      ...(blockedCandidates.length ? ['Review blocked candidates and lift the blocker if the setup should be allowed.'] : []),
      ...(expiredCandidates.length ? ['Refresh stale setups or raise the candidate max age if the watch window is too short.'] : []),
    ],
    last_reconciled_at: normalized.last_reconciled_at || null,
  };
}

function compareCandidateEntries(a = {}, b = {}) {
  const rankA = safeNumber(a.decayed_rank, safeNumber(a.latest_rank, 0));
  const rankB = safeNumber(b.decayed_rank, safeNumber(b.latest_rank, 0));
  if (rankA !== rankB) return rankB - rankA;
  const lastSeenA = new Date(a.last_seen_at || a.first_seen_at || 0).getTime();
  const lastSeenB = new Date(b.last_seen_at || b.first_seen_at || 0).getTime();
  if (lastSeenA !== lastSeenB) return lastSeenB - lastSeenA;
  return String(a.candidate_key || '').localeCompare(String(b.candidate_key || ''));
}

function roundScore(value, digits = 3) {
  const numeric = safeNumber(value, 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(digits));
}

module.exports = {
  CandidateLifecycleReason,
  defaultCandidateLifecycleStatePath,
  loadCandidateLifecycleState,
  saveCandidateLifecycleState,
  normalizeCandidateLifecycleState,
  reconcileCandidateLifecycleState,
  resolveScannerMode,
  summarizeCandidateLifecycleState,
  decayCandidateRank,
  normalizeCandidateKey,
};
