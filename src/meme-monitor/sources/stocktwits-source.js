const { fetchWithTimeout, nowIso } = require('../../util');

async function fetchStocktwitsSignals({ env = process.env, fetchImpl = globalThis.fetch, symbols = [], timeoutMs = 5000 } = {}) {
  const apiKey = String(env?.STOCKTWITS_API_KEY || '').trim();
  if (!apiKey) {
    return {
      sourceStatus: normalizeSourceStatus({ source: 'stocktwits', enabled: true, available: false, status: 'missing_credentials', lastRunAt: null, lastError: 'STOCKTWITS_API_KEY missing', blockedReason: 'missing_credentials' }),
      symbols: [],
    };
  }
  if (!symbols.length) {
    return {
      sourceStatus: normalizeSourceStatus({ source: 'stocktwits', enabled: true, available: true, status: 'active', symbolsDetected: 0, lastRunAt: nowIso(), lastError: null }),
      symbols: [],
    };
  }
  try {
    const out = [];
    for (const symbol of symbols) {
      const response = await fetchWithTimeout(fetchImpl, `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json?access_token=${encodeURIComponent(apiKey)}`, { timeoutMs });
      const body = await readJson(response);
      if (response.status === 429) {
        return {
          sourceStatus: normalizeSourceStatus({ source: 'stocktwits', enabled: true, available: false, status: 'rate_limited', symbolsDetected: out.length, lastRunAt: null, lastError: 'rate_limited', blockedReason: 'rate_limited' }),
          symbols: out,
        };
      }
      if (!response.ok) {
        out.push(buildStocktwitsSignal(symbol, [], { unavailable: true, status: 'unavailable', error: `HTTP ${response.status}` }));
        continue;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.data) ? body.data : [];
      out.push(buildStocktwitsSignal(symbol, messages, { available: true }));
    }
    return {
      sourceStatus: normalizeSourceStatus({ source: 'stocktwits', enabled: true, available: true, status: 'active', symbolsDetected: out.length, lastRunAt: nowIso(), lastError: null }),
      symbols: out,
    };
  } catch (error) {
    return {
      sourceStatus: normalizeSourceStatus({ source: 'stocktwits', enabled: true, available: false, status: 'error', symbolsDetected: 0, lastRunAt: null, lastError: error.message, blockedReason: 'source_not_found_or_inaccessible' }),
      symbols: [],
    };
  }
}

function buildStocktwitsSignal(symbol, messages = [], options = {}) {
  const bullish = messages.filter((message) => isBullish(message)).length;
  const bearish = messages.filter((message) => isBearish(message)).length;
  const spamUsers = new Map();
  for (const message of messages) {
    const user = String(message?.user?.username || message?.user?.name || message?.username || 'unknown').toLowerCase();
    spamUsers.set(user, (spamUsers.get(user) || 0) + 1);
  }
  const spamConcentration = messages.length ? Math.max(...spamUsers.values(), 0) / messages.length : 0;
  const score = clampScore(35 + messages.length * 4 + bullish * 8 - bearish * 6 - (spamConcentration >= 0.7 ? 15 : 0));
  const reasonCodes = ['stocktwits_source_active'];
  if (messages.length >= 3) reasonCodes.push('stocktwits_cashtag_velocity_confirmed');
  if (bullish > bearish) reasonCodes.push('stocktwits_sentiment_bullish');
  else if (bullish > 0 || bearish > 0) reasonCodes.push('stocktwits_sentiment_mixed');
  if (spamConcentration >= 0.7) reasonCodes.push('stocktwits_spam_warning');
  if (score >= 60) reasonCodes.push('stocktwits_cross_platform_social_confirmation');
  return {
    symbol,
    sourceSignalType: 'social_confirmation',
    score,
    confidence: score / 100,
    reasonCodes,
    riskWarnings: spamConcentration >= 0.7 ? ['stocktwits_spam_warning'] : [],
    rawSummary: {
      messageCount: messages.length,
      bullishCount: bullish,
      bearishCount: bearish,
      spamConcentration: Number(spamConcentration.toFixed(2)),
      status: options.status || (options.unavailable ? 'unavailable' : 'active'),
    },
    available: !options.unavailable,
    status: options.unavailable ? 'unavailable' : 'active',
  };
}

function isBullish(message = {}) {
  const sentiment = String(message?.entities?.sentiment?.basic || message?.sentiment || '').toLowerCase();
  return ['bullish', 'strong_bullish', 'positive'].includes(sentiment);
}

function isBearish(message = {}) {
  const sentiment = String(message?.entities?.sentiment?.basic || message?.sentiment || '').toLowerCase();
  return ['bearish', 'strong_bearish', 'negative'].includes(sentiment);
}

function normalizeSourceStatus(entry = {}) {
  return {
    source: entry.source || 'stocktwits',
    enabled: Boolean(entry.enabled),
    available: Boolean(entry.available),
    status: String(entry.status || 'off').toLowerCase(),
    lastRunAt: entry.lastRunAt || null,
    lastScanAt: entry.lastScanAt || entry.lastRunAt || null,
    lastError: entry.lastError || null,
    symbolsDetected: Number.isFinite(Number(entry.symbolsDetected)) ? Number(entry.symbolsDetected) : 0,
    blockedReason: entry.blockedReason || null,
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function clampScore(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

module.exports = {
  fetchStocktwitsSignals,
};
