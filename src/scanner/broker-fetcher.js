const { normalizeMarketData } = require('../market-data');
const { safeNumber, nowIso } = require('../util');

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function chunkSymbols(symbols, size) {
  const chunks = [];
  for (let index = 0; index < symbols.length; index += size) {
    chunks.push(symbols.slice(index, index + size));
  }
  return chunks;
}

function filterApprovedPositions(positions = [], approvedSymbols = []) {
  if (!Array.isArray(approvedSymbols) || !approvedSymbols.length) return Array.isArray(positions) ? positions : [];
  const approved = new Set(approvedSymbols.map((symbol) => String(symbol).toUpperCase()));
  return (Array.isArray(positions) ? positions : []).filter((position) => approved.has(String(position.symbol || '').toUpperCase()));
}

function buildPositionLookup(positions) {
  const lookup = new Map();
  for (const position of positions) {
    const symbol = String(position.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    lookup.set(symbol, position);
  }
  return lookup;
}

function buildOpenOrderLookup(openOrders = []) {
  const lookup = new Map();
  for (const order of openOrders) {
    const symbol = String(order.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    if (!lookup.has(symbol)) {
      lookup.set(symbol, []);
    }
    lookup.get(symbol).push(order);
  }
  return lookup;
}

async function fetchStockBundle({ fetchImpl, apiKeyId, apiSecretKey, baseUrl, symbols }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  const snapshots = {};
  const latestQuotes = {};
  for (const chunk of chunkSymbols(symbols, 25)) {
    const encodedSymbols = encodeURIComponent(chunk.join(','));
    const snapshotsUrl = `${baseUrl}/v2/stocks/snapshots?symbols=${encodedSymbols}&feed=iex`;
    const response = await fetchImpl(snapshotsUrl, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) continue;
    const chunkSnapshots = body?.snapshots || body || {};
    Object.assign(snapshots, chunkSnapshots);
    for (const symbol of chunk) {
      latestQuotes[symbol] = chunkSnapshots[symbol]?.latestQuote || chunkSnapshots[symbol]?.latest_quote || latestQuotes[symbol] || {};
    }
  }
  return { snapshots, latestQuotes };
}

async function fetchPositions({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  try {
    const response = await fetchImpl(`${baseUrl}/v2/positions`, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) return { available: false, data: [], reason_code: 'BROKER_POSITIONS_UNAVAILABLE', status: response.status };
    return { available: true, data: Array.isArray(body) ? body : body?.positions || body?.data || [], reason_code: null, status: response.status };
  } catch (error) {
    return { available: false, data: [], reason_code: 'BROKER_POSITIONS_UNAVAILABLE', error: error.message };
  }
}

async function fetchOpenOrders({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  try {
    const response = await fetchImpl(`${baseUrl}/v2/orders?status=open&limit=500`, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) return { available: false, data: [], reason_code: 'BROKER_OPEN_ORDERS_UNAVAILABLE', status: response.status };
    return { available: true, data: Array.isArray(body) ? body : body?.orders || body?.data || [], reason_code: null, status: response.status };
  } catch (error) {
    return { available: false, data: [], reason_code: 'BROKER_OPEN_ORDERS_UNAVAILABLE', error: error.message };
  }
}

async function fetchAccount({ fetchImpl, apiKeyId, apiSecretKey, baseUrl }) {
  const headers = {
    'APCA-API-KEY-ID': apiKeyId,
    'APCA-API-SECRET-KEY': apiSecretKey,
    'content-type': 'application/json',
  };
  try {
    const response = await fetchImpl(`${baseUrl}/v2/account`, { method: 'GET', headers });
    const body = await readJsonResponse(response);
    if (!response.ok) return { available: false, data: null, reason_code: 'BROKER_ACCOUNT_UNAVAILABLE', status: response.status };
    return { available: true, data: body, reason_code: null, status: response.status };
  } catch (error) {
    return { available: false, data: null, reason_code: 'BROKER_ACCOUNT_UNAVAILABLE', error: error.message };
  }
}

function buildScannerBrokerState({ accountState, positionsState, openOrdersState }) {
  const states = { account: accountState, positions: positionsState, open_orders: openOrdersState };
  const reasonCodes = Object.values(states)
    .filter((state) => !state?.available)
    .map((state) => state.reason_code)
    .filter(Boolean);
  const buyingPower = safeNumber(accountState?.data?.buying_power ?? accountState?.data?.cash, null);
  if (accountState?.available && !Number.isFinite(buyingPower)) {
    reasonCodes.push('BUYING_POWER_UNAVAILABLE');
  }
  const strictBuyBlocked = reasonCodes.length > 0;
  if (strictBuyBlocked && !reasonCodes.includes('BROKER_STATE_REQUIRED_FOR_BUY')) {
    reasonCodes.push('BROKER_STATE_REQUIRED_FOR_BUY');
  }
  return {
    available: !strictBuyBlocked,
    source_of_truth: 'alpaca',
    strict_buy_blocked: strictBuyBlocked,
    reason_codes: [...new Set(reasonCodes)],
    account_available: Boolean(accountState?.available),
    positions_available: Boolean(positionsState?.available),
    open_orders_available: Boolean(openOrdersState?.available),
    buying_power_available: Number.isFinite(buyingPower),
    freshness: strictBuyBlocked ? 'stale_or_unavailable' : 'fresh',
    checked_at: nowIso(),
    account_status: accountState?.status || null,
    positions_status: positionsState?.status || null,
    open_orders_status: openOrdersState?.status || null,
    errors: Object.entries(states).reduce((acc, [key, state]) => {
      if (state?.error) acc[key] = state.error;
      return acc;
    }, {}),
  };
}

async function fetchTwelveDataBundle({ fetchImpl, apiKey, baseUrl, symbols }) {
  const quotes = {};
  for (const chunk of chunkSymbols(symbols, 20)) {
    const encodedSymbols = encodeURIComponent(chunk.join(','));
    const url = `${baseUrl}/quote?symbol=${encodedSymbols}&apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetchImpl(url, { method: 'GET' });
    const body = await readJsonResponse(response);
    if (!response.ok) continue;
    Object.assign(quotes, normalizeTwelveDataQuotes(body, chunk));
  }
  return quotes;
}

function normalizeTwelveDataQuotes(body, symbols) {
  const quotes = {};
  const entries = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body)
      ? body
      : body && typeof body === 'object' && (body.symbol || body.ticker || body.code || body.instrument)
        ? [body]
        : body && typeof body === 'object'
          ? Object.values(body).filter((value) => value && typeof value === 'object')
          : [];

  for (const entry of entries) {
    const symbol = String(entry.symbol || entry.ticker || entry.code || entry.instrument || '').trim().toUpperCase();
    if (!symbol) continue;
    const receivedAt = nowIso();
    const timestamp = entry.datetime || entry.timestamp || entry.time || entry.t || entry.date || receivedAt;
    quotes[symbol] = normalizeMarketData({
      provider: 'twelvedata',
      asset_type: 'stock',
      kind: 'quote',
      symbol,
      timestamp,
      received_at: receivedAt,
      price: safeNumber(entry.price ?? entry.close ?? entry.last ?? entry.value ?? entry.mid ?? entry.c, null),
      previous_close: safeNumber(entry.previous_close ?? entry.previousClose ?? entry.close ?? null),
      volume: safeNumber(entry.volume ?? entry.v ?? null),
      confidence: 82,
      reliability: 84,
      exchange: entry.exchange || 'twelvedata',
      raw_payload: entry,
    }, { receivedAt, maxStalenessSeconds: 300 });
  }

  for (const symbol of symbols) {
    if (!quotes[symbol]) quotes[symbol] = null;
  }
  return quotes;
}

module.exports = {
  fetchStockBundle,
  fetchPositions,
  fetchOpenOrders,
  fetchAccount,
  buildScannerBrokerState,
  fetchTwelveDataBundle,
  readJsonResponse,
  normalizeTwelveDataQuotes,
  chunkSymbols,
  filterApprovedPositions,
  buildPositionLookup,
  buildOpenOrderLookup,
};
