const { safeNumber } = require('./util');

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeAlpacaBaseUrl(value, fallback) {
  const baseUrl = trimTrailingSlash(value || fallback);
  return baseUrl || 'https://paper-api.alpaca.markets';
}

function buildAlpacaOrderPayload(request) {
  const assetType = String(request.asset_type || request.assetType || '').trim().toLowerCase();
  const symbol = String(request.symbol || '').trim().toUpperCase();
  const isCryptoOrder = assetType === 'crypto' || symbol.includes('/');
  const payload = {
    client_order_id: request.request_id || request.signal_id || undefined,
    symbol: request.symbol,
    side: request.side,
    type: request.order_type || 'market',
    time_in_force: request.time_in_force || 'day',
  };

  const quantity = safeNumber(request.quantity, null);
  const notional = safeNumber(request.notional, null);
  if (Number.isFinite(quantity) && quantity > 0) {
    payload.qty = String(quantity);
  } else if (Number.isFinite(notional) && notional > 0) {
    payload.notional = String(notional);
  } else {
    throw new Error('Alpaca order requires quantity or notional');
  }

  if (request.limit_price !== undefined && request.limit_price !== null) {
    payload.limit_price = String(request.limit_price);
  }

  const hasStopLoss = request.stop_loss !== undefined && request.stop_loss !== null;
  const hasTakeProfit = request.take_profit !== undefined && request.take_profit !== null;
  if (!isCryptoOrder) {
    if (hasStopLoss && hasTakeProfit) {
      payload.order_class = 'bracket';
      payload.take_profit = { limit_price: String(request.take_profit) };
      payload.stop_loss = { stop_price: String(request.stop_loss) };
    } else if (hasStopLoss || hasTakeProfit) {
      throw new Error('Alpaca bracket orders require both stop_loss and take_profit');
    }
  }

  if (request.extended_hours !== undefined) {
    payload.extended_hours = Boolean(request.extended_hours);
  }

  return payload;
}

class AlpacaTradeAdapter {
  constructor(options = {}) {
    this.apiKeyId = options.apiKeyId || process.env.ALPACA_API_KEY_ID || '';
    this.apiSecretKey = options.apiSecretKey || process.env.ALPACA_API_SECRET_KEY || '';
    this.paperTrading = options.paperTrading ?? true;
    this.baseUrl = normalizeAlpacaBaseUrl(
      options.baseUrl || process.env.ALPACA_API_BASE_URL,
      options.paperTrading === false || String(process.env.ALPACA_PAPER_TRADING || '').toLowerCase() === 'false'
        ? 'https://api.alpaca.markets'
        : 'https://paper-api.alpaca.markets',
    );
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.dryRun = options.dryRun ?? false;
    this.userAgent = options.userAgent || 'trading-automation-control-plane/0.1.0';
  }

  async submitOrder(request) {
    if (this.dryRun) {
      return {
        order_id: request.request_id || request.signal_id || `alpaca_dry_${Date.now()}`,
        status: 'dry_run',
        request,
        submitted_to: this.baseUrl,
      };
    }

    this.#ensureConfigured();
    const isCryptoOrder = String(request.asset_type || request.assetType || '').trim().toLowerCase() === 'crypto'
      || String(request.symbol || '').includes('/');
    const executionRequest = this.paperTrading && request.allow_bracket !== true
      ? { ...request, stop_loss: null, take_profit: null }
      : isCryptoOrder
        ? { ...request, stop_loss: null, take_profit: null }
        : request;
    const payload = buildAlpacaOrderPayload(executionRequest);
    const response = await this.fetchImpl(`${this.baseUrl}/v2/orders`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(payload),
    });
    const bodyText = await response.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { raw: bodyText };
    }
    if (!response.ok) {
      const brokerMessage = body?.message || body?.error || body?.detail || body?.raw || bodyText || 'unknown error';
      const error = new Error(`Alpaca order rejected (${response.status}): ${brokerMessage}`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return {
      order_id: body.id || body.order_id || request.request_id || request.signal_id || null,
      status: body.status || 'accepted',
      submitted_to: this.baseUrl,
      external_order: body,
      request,
    };
  }

  async getAccount() {
    this.#ensureConfigured();
    const response = await this.fetchImpl(`${this.baseUrl}/v2/account`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const bodyText = await response.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { raw: bodyText };
    }
    if (!response.ok) {
      const error = new Error(`Alpaca account request failed (${response.status})`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return body;
  }

  async getOrder(orderId) {
    this.#ensureConfigured();
    if (!orderId) {
      throw new Error('Alpaca order lookup requires an order id');
    }
    const response = await this.fetchImpl(`${this.baseUrl}/v2/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const bodyText = await response.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { raw: bodyText };
    }
    if (!response.ok) {
      const error = new Error(`Alpaca order lookup failed (${response.status})`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return body;
  }

  async getOpenOrders() {
    this.#ensureConfigured();
    const response = await this.fetchImpl(`${this.baseUrl}/v2/orders?status=open&limit=500`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const bodyText = await response.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { raw: bodyText };
    }
    if (!response.ok) {
      const error = new Error(`Alpaca open orders request failed (${response.status})`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return Array.isArray(body) ? body : body?.orders || body?.data || [];
  }

  #headers() {
    return {
      'APCA-API-KEY-ID': this.apiKeyId,
      'APCA-API-SECRET-KEY': this.apiSecretKey,
      'content-type': 'application/json',
      'user-agent': this.userAgent,
    };
  }

  #ensureConfigured() {
    if (!this.apiKeyId || !this.apiSecretKey) {
      throw new Error('Alpaca execution requires API key and secret');
    }
    if (!this.fetchImpl) {
      throw new Error('Alpaca execution requires a fetch implementation');
    }
  }
}

module.exports = {
  AlpacaTradeAdapter,
  buildAlpacaOrderPayload,
  normalizeAlpacaBaseUrl,
};
