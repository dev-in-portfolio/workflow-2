const path = require('path');
const { nowIso, safeNumber, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');

function defaultTrailingStatePath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return env.POSITION_TRAILING_STATE_PATH || path.join(repoRoot, 'data', 'state', 'position-trailing-state.json');
}

function loadTrailingState(options = {}) {
  const filePath = options.filePath || defaultTrailingStatePath(options);
  const store = new JsonFileStore(path.dirname(filePath));
  try {
    const data = store.read(path.basename(filePath));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveTrailingState(state, options = {}) {
  const filePath = options.filePath || defaultTrailingStatePath(options);
  const store = new JsonFileStore(path.dirname(filePath));
  const payload = {
    version: '2026-06-21.live-market-trailing.1',
    updated_at: nowIso(),
    positions: state?.positions || {},
  };
  store.write(path.basename(filePath), payload);
  return payload;
}

function updateTrailingSnapshot({ positions = [], startDollars = 5, givebackDollars = 3, previousState = {} } = {}) {
  const previousPositions = previousState.positions || {};
  const nextPositions = {};
  const bySymbol = {};
  for (const position of positions) {
    const symbol = String(position.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    const unrealized = safeNumber(position.unrealized_pl ?? position.unrealizedPnl ?? position.unrealized_intraday_pl, null);
    const previousPeak = safeNumber(previousPositions[symbol]?.peak_unrealized_pl, null);
    const active = Number.isFinite(unrealized) && unrealized >= startDollars;
    const peak = Number.isFinite(unrealized)
      ? Math.max(unrealized, Number.isFinite(previousPeak) ? previousPeak : -Infinity)
      : (Number.isFinite(previousPeak) ? previousPeak : null);
    const trailingActive = Number.isFinite(peak) && peak >= startDollars;
    const sellAt = trailingActive ? peak - givebackDollars : null;
    const record = {
      symbol,
      peak_unrealized_pl: Number.isFinite(peak) ? roundCurrency(peak) : null,
      current_unrealized_pl: Number.isFinite(unrealized) ? roundCurrency(unrealized) : null,
      trailing_active: trailingActive,
      trailing_started_at: previousPositions[symbol]?.trailing_started_at || (active ? nowIso() : null),
      sell_if_unrealized_pl_at_or_below: Number.isFinite(sellAt) ? roundCurrency(sellAt) : null,
      updated_at: nowIso(),
    };
    nextPositions[symbol] = record;
    bySymbol[symbol] = record;
  }
  return {
    version: previousState.version || '2026-06-21.live-market-trailing.1',
    updated_at: nowIso(),
    positions: nextPositions,
    bySymbol,
  };
}

function roundCurrency(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

module.exports = {
  defaultTrailingStatePath,
  loadTrailingState,
  saveTrailingState,
  updateTrailingSnapshot,
};
