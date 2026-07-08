const fs = require('fs');
const path = require('path');
const { isRegularUsMarketHours } = require('./market-hours');
const { nowIso, resolveRepoRoot } = require('./util');
const { resolveScannerDecisionRecordsPath } = require('./scanner-outcome-shadow');

const OUTCOME_WINDOWS = [
  { window: '1m', minutes: 1 },
  { window: '5m', minutes: 5 },
  { window: '15m', minutes: 15 },
  { window: '30m', minutes: 30 },
  { window: '60m', minutes: 60 },
  { window: 'eod', eod: true },
];

function resolveScannerCandidateOutcomesPath({ env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  return path.resolve(env.SCANNER_CANDIDATE_OUTCOMES_PATH || path.join(repoRoot, 'data', 'runtime', 'scanner-candidate-outcomes.jsonl'));
}

async function updateScannerCandidateOutcomes({
  decisionFilePath = null,
  outcomeFilePath = null,
  fetchImpl = globalThis.fetch,
  env = process.env,
  repoRoot = resolveRepoRoot(),
  now = nowIso(),
  marketDataBaseUrl = env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets',
  apiKeyId = env.ALPACA_API_KEY_ID || '',
  apiSecretKey = env.ALPACA_API_SECRET_KEY || '',
  barProvider = null,
} = {}) {
  const decisionsPath = decisionFilePath || resolveScannerDecisionRecordsPath({ env, repoRoot });
  const outcomesPath = outcomeFilePath || resolveScannerCandidateOutcomesPath({ env, repoRoot });
  const decisions = readJsonl(decisionsPath);
  const existing = readJsonl(outcomesPath);
  const existingKeys = new Set(existing.map((record) => outcomeKey(record.candidate_id, record.window)).filter(Boolean));
  const newRecords = [];
  for (const decision of decisions) {
    for (const candidate of Array.isArray(decision.candidates) ? decision.candidates : []) {
      for (const windowDef of OUTCOME_WINDOWS) {
        const key = outcomeKey(candidate.candidate_id, windowDef.window);
        if (!candidate.candidate_id || existingKeys.has(key)) continue;
        const outcome = await buildOutcomeRecord({
          decision,
          candidate,
          windowDef,
          fetchImpl,
          now,
          marketDataBaseUrl,
          apiKeyId,
          apiSecretKey,
          barProvider,
        });
        if (outcome.status === 'pending') continue;
        newRecords.push(outcome);
        existingKeys.add(key);
      }
    }
  }
  if (newRecords.length) {
    fs.mkdirSync(path.dirname(outcomesPath), { recursive: true });
    fs.appendFileSync(outcomesPath, `${newRecords.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  }
  return { read_decisions: decisions.length, existing_outcomes: existing.length, written_outcomes: newRecords.length, path: outcomesPath };
}

async function buildOutcomeRecord({
  decision,
  candidate,
  windowDef,
  fetchImpl,
  now,
  marketDataBaseUrl,
  apiKeyId,
  apiSecretKey,
  barProvider = null,
}) {
  const decisionAt = decision.decision_at;
  const targetAt = resolveTargetAt(decisionAt, windowDef);
  const base = {
    schema_version: '2026-07-07.scanner-candidate-outcome.1',
    recorded_at: nowIso(),
    decision_id: decision.decision_id || null,
    candidate_id: candidate.candidate_id || null,
    candidate_key: candidate.candidate_key || null,
    symbol: candidate.symbol || null,
    decision_at: decisionAt || null,
    window: windowDef.window,
    target_at: targetAt,
    entry_reference_price: toNumber(candidate.current_price),
    provider: 'alpaca',
    status: 'unavailable',
    reason_codes: [],
  };
  if (!Number.isFinite(base.entry_reference_price) || base.entry_reference_price <= 0) {
    return unavailable(base, 'OUTCOME_INVALID_DECISION_PRICE');
  }
  if (!targetAt) return unavailable(base, 'OUTCOME_MARKET_CLOSED');
  if (new Date(targetAt).getTime() > new Date(now).getTime()) return { ...base, status: 'pending', reason_codes: ['OUTCOME_WINDOW_NOT_REACHED'] };
  if (!isRegularUsMarketHours(new Date(decisionAt)) && !windowDef.eod) return unavailable(base, 'OUTCOME_MARKET_CLOSED');
  let bars;
  try {
    bars = barProvider
      ? await barProvider({ symbol: candidate.symbol, decisionAt, targetAt, window: windowDef.window })
      : await fetchAlpacaBars({ fetchImpl, marketDataBaseUrl, apiKeyId, apiSecretKey, symbol: candidate.symbol, start: decisionAt, end: targetAt });
  } catch (error) {
    return unavailable(base, 'OUTCOME_PROVIDER_UNAVAILABLE', { provider_error: error.message });
  }
  const normalizedBars = normalizeBars(bars).filter((bar) => {
    const t = new Date(bar.t).getTime();
    return Number.isFinite(t) && t >= new Date(decisionAt).getTime() && t <= new Date(targetAt).getTime() + 90_000;
  });
  if (!normalizedBars.length) return unavailable(base, 'OUTCOME_BAR_UNAVAILABLE');
  const observed = normalizedBars.find((bar) => new Date(bar.t).getTime() >= new Date(targetAt).getTime()) || normalizedBars[normalizedBars.length - 1];
  if (new Date(observed.t).getTime() < new Date(targetAt).getTime()) return unavailable(base, 'OUTCOME_BAR_UNAVAILABLE');
  const observedPrice = toNumber(observed.c);
  if (!Number.isFinite(observedPrice)) return unavailable(base, 'OUTCOME_BAR_UNAVAILABLE');
  const highs = normalizedBars.map((bar) => toNumber(bar.h)).filter(Number.isFinite);
  const lows = normalizedBars.map((bar) => toNumber(bar.l)).filter(Number.isFinite);
  const maxFavPrice = Math.max(...highs, base.entry_reference_price);
  const maxAdvPrice = Math.min(...lows, base.entry_reference_price);
  const stopPrice = toNumber(candidate.structure_stop?.stop_price);
  const targetPrice = toNumber(candidate.structure_stop?.target_price ?? (Number.isFinite(stopPrice) ? base.entry_reference_price + Math.abs(base.entry_reference_price - stopPrice) * 1.8 : null));
  const threshold = evaluateThresholds({ bars: normalizedBars, stopPrice, targetPrice });
  const rawReturn = pctReturn(base.entry_reference_price, observedPrice);
  return {
    ...base,
    observed_at: observed.t,
    observed_price: observedPrice,
    raw_return_pct: round(rawReturn),
    spread_adjusted_return_pct: round(rawReturn - Math.max(0, toNumber(candidate.spread_pct) || 0)),
    estimated_slippage_adjusted_return_pct: round(rawReturn - Math.max(0, toNumber(candidate.spread_pct) || 0) / 2),
    maximum_favorable_excursion_pct: round(pctReturn(base.entry_reference_price, maxFavPrice)),
    maximum_adverse_excursion_pct: round(pctReturn(base.entry_reference_price, maxAdvPrice)),
    maximum_favorable_price: round(maxFavPrice),
    maximum_adverse_price: round(maxAdvPrice),
    bar_count: normalizedBars.length,
    status: 'complete',
    reason_codes: [],
    stop_price: Number.isFinite(stopPrice) ? stopPrice : null,
    target_price: Number.isFinite(targetPrice) ? targetPrice : null,
    ...threshold,
    simulated_trade_result: threshold.first_threshold_touched || (rawReturn > 0 ? 'WINDOW_POSITIVE' : rawReturn < 0 ? 'WINDOW_NEGATIVE' : 'FLAT'),
    simulated_net_return_pct: round(rawReturn - Math.max(0, toNumber(candidate.spread_pct) || 0) / 2),
  };
}

async function fetchAlpacaBars({ fetchImpl, marketDataBaseUrl, apiKeyId, apiSecretKey, symbol, start, end }) {
  if (!fetchImpl || !apiKeyId || !apiSecretKey) throw new Error('missing_market_data_credentials');
  const url = `${String(marketDataBaseUrl).replace(/\/$/, '')}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&feed=iex&adjustment=raw`;
  const response = await fetchImpl(url, {
    headers: {
      'APCA-API-KEY-ID': apiKeyId,
      'APCA-API-SECRET-KEY': apiSecretKey,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`market_data_${response.status}`);
  return body.bars || body[symbol]?.bars || body.data || [];
}

function normalizeBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .map((bar) => ({
      t: bar.t || bar.timestamp || bar.time,
      o: toNumber(bar.o ?? bar.open),
      h: toNumber(bar.h ?? bar.high),
      l: toNumber(bar.l ?? bar.low),
      c: toNumber(bar.c ?? bar.close),
    }))
    .filter((bar) => bar.t && Number.isFinite(bar.c))
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
}

function resolveTargetAt(decisionAt, windowDef) {
  const date = new Date(decisionAt);
  if (!Number.isFinite(date.getTime())) return null;
  if (windowDef.eod) {
    const eod = new Date(date);
    eod.setUTCHours(20, 0, 0, 0);
    if (date.getTime() >= eod.getTime()) return null;
    return eod.toISOString();
  }
  date.setMinutes(date.getMinutes() + windowDef.minutes);
  return date.toISOString();
}

function evaluateThresholds({ bars, stopPrice, targetPrice }) {
  let stopTouchedAt = null;
  let targetTouchedAt = null;
  let ambiguous = false;
  for (const bar of bars) {
    const low = toNumber(bar.l);
    const high = toNumber(bar.h);
    const stopTouched = Number.isFinite(stopPrice) && Number.isFinite(low) && low <= stopPrice;
    const targetTouched = Number.isFinite(targetPrice) && Number.isFinite(high) && high >= targetPrice;
    if (stopTouched && !stopTouchedAt) stopTouchedAt = bar.t;
    if (targetTouched && !targetTouchedAt) targetTouchedAt = bar.t;
    if (stopTouched && targetTouched && stopTouchedAt === bar.t && targetTouchedAt === bar.t) ambiguous = true;
    if (stopTouchedAt || targetTouchedAt) break;
  }
  const first = ambiguous
    ? 'AMBIGUOUS_SAME_BAR'
    : targetTouchedAt && (!stopTouchedAt || new Date(targetTouchedAt) < new Date(stopTouchedAt))
      ? 'TARGET_FIRST'
      : stopTouchedAt
        ? 'STOP_FIRST'
        : null;
  return {
    stop_touched: Boolean(stopTouchedAt),
    target_touched: Boolean(targetTouchedAt),
    stop_touched_at: stopTouchedAt,
    target_touched_at: targetTouchedAt,
    first_threshold_touched: first,
  };
}

function unavailable(base, reason, extra = {}) {
  return { ...base, ...extra, status: 'unavailable', reason_codes: [reason] };
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function outcomeKey(candidateId, window) {
  return candidateId && window ? `${candidateId}::${window}` : null;
}

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pctReturn(entry, value) {
  return Number.isFinite(entry) && entry > 0 && Number.isFinite(value) ? ((value - entry) / entry) * 100 : null;
}

function round(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(4)) : null;
}

module.exports = {
  OUTCOME_WINDOWS,
  resolveScannerCandidateOutcomesPath,
  updateScannerCandidateOutcomes,
  buildOutcomeRecord,
  normalizeBars,
};
