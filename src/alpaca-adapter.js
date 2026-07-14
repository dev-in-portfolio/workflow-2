const { safeNumber } = require('./util');

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeAlpacaBaseUrl(value, fallback) {
  const baseUrl = trimTrailingSlash(value || fallback);
  return baseUrl || 'https://paper-api.alpaca.markets';
}

function roundEquityPrice(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return value;
  const decimals = Math.abs(numericValue) >= 1 ? 2 : 4;
  return Number(numericValue.toFixed(decimals));
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
    payload.limit_price = String(isCryptoOrder ? request.limit_price : roundEquityPrice(request.limit_price));
  }

  const hasStopLoss = request.stop_loss !== undefined && request.stop_loss !== null;
  const hasTakeProfit = request.take_profit !== undefined && request.take_profit !== null;
  if (!isCryptoOrder) {
    if (hasStopLoss && hasTakeProfit) {
      payload.order_class = 'bracket';
      payload.take_profit = { limit_price: String(roundEquityPrice(request.take_profit)) };
      payload.stop_loss = { stop_price: String(roundEquityPrice(request.stop_loss)) };
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
    this.requestTimeoutMs = Math.max(1, Number(options.requestTimeoutMs ?? 10_000) || 10_000);
    this.dryRun = options.dryRun ?? false;
    this.userAgent = options.userAgent || 'trading-automation-control-plane/0.1.0';
    this.requiresBrokerReconciliation = true;
    this.supportsIdempotency = true;
  }

  async submitOrder(request) {
    const idempotencyKey = deriveClientOrderId(request);
    const executionMode = this.paperTrading ? 'paper' : 'live';
    if (this.dryRun) {
      return {
        order_id: request.request_id || request.signal_id || `alpaca_dry_${Date.now()}`,
        status: 'dry_run',
        execution_mode: executionMode,
        request,
        submitted_to: this.baseUrl,
        idempotency_key: idempotencyKey,
        idempotency_status: idempotencyKey ? 'dry_run_checked' : 'not_requested',
        existing_order_reused: false,
        idempotency_checked: Boolean(idempotencyKey),
      };
    }

    this.#ensureConfigured();
    const isCryptoOrder = String(request.asset_type || request.assetType || '').trim().toLowerCase() === 'crypto'
      || String(request.symbol || '').includes('/');
    const quantity = safeNumber(request.quantity, null);
    const isFractionalStockOrder = !isCryptoOrder
      && (request.supports_fractional_shares === true
        || (Number.isFinite(quantity) && quantity > 0 && !Number.isInteger(quantity)));
    const executionRequest = request.allow_bracket === false
      ? { ...request, stop_loss: null, take_profit: null }
      : this.paperTrading && request.allow_bracket !== true
      ? { ...request, stop_loss: null, take_profit: null }
      : isCryptoOrder || isFractionalStockOrder
        ? { ...request, stop_loss: null, take_profit: null }
        : request;
    const payload = buildAlpacaOrderPayload(executionRequest);
    if (idempotencyKey) {
      try {
        const existingOrder = await this.findExistingOrderForRequest(executionRequest);
        if (existingOrder) {
          return {
            order_id: existingOrder.id || existingOrder.order_id || idempotencyKey,
            status: existingOrder.status || 'accepted',
            execution_mode: executionMode,
            submitted_to: this.baseUrl,
            external_order: existingOrder,
            request,
            idempotency_key: idempotencyKey,
            idempotency_status: 'existing_order_reused',
            existing_order_reused: true,
            idempotency_checked: true,
          };
        }
      } catch (error) {
        if (request.require_idempotency) {
          error.idempotency_key = idempotencyKey;
          error.idempotency_status = 'lookup_failed';
          throw error;
        }
      }
    }
    const response = await this.#fetchWithTimeout(`${this.baseUrl}/v2/orders`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(payload),
    });
    const { body, bodyText } = await this.#readResponseBody(response);
    if (!response.ok) {
      const brokerMessage = body?.message || body?.error || body?.detail || body?.raw || bodyText || 'unknown error';
      if (idempotencyKey && isDuplicateClientOrderError(response.status, brokerMessage)) {
        const existingOrder = await this.getOrderByClientOrderId(idempotencyKey);
        return {
          order_id: existingOrder.id || existingOrder.order_id || idempotencyKey,
          status: existingOrder.status || 'accepted',
          execution_mode: executionMode,
          submitted_to: this.baseUrl,
          external_order: existingOrder,
          request,
          idempotency_key: idempotencyKey,
          idempotency_status: 'existing_order_reused_after_duplicate',
          existing_order_reused: true,
          idempotency_checked: true,
        };
      }
      const error = new Error(`Alpaca order rejected (${response.status}): ${brokerMessage}`);
      error.status = response.status;
      error.response = body;
      error.idempotency_key = idempotencyKey;
      error.idempotency_status = idempotencyKey ? 'checked_then_rejected' : 'not_requested';
      throw error;
    }
    return {
      order_id: body.id || body.order_id || request.request_id || request.signal_id || null,
      status: body.status || 'accepted',
      execution_mode: executionMode,
      submitted_to: this.baseUrl,
      external_order: body,
      request,
      idempotency_key: idempotencyKey,
      idempotency_status: idempotencyKey ? 'new_order_submitted' : 'not_requested',
      existing_order_reused: false,
      idempotency_checked: Boolean(idempotencyKey),
    };
  }

  async getAccount() {
    this.#ensureConfigured();
    const response = await this.#fetchWithTimeout(`${this.baseUrl}/v2/account`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const { body } = await this.#readResponseBody(response);
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
    const response = await this.#fetchWithTimeout(`${this.baseUrl}/v2/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const { body } = await this.#readResponseBody(response);
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
    const response = await this.#fetchWithTimeout(`${this.baseUrl}/v2/orders?status=open&limit=500`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const { body } = await this.#readResponseBody(response);
    if (!response.ok) {
      const error = new Error(`Alpaca open orders request failed (${response.status})`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return Array.isArray(body) ? body : body?.orders || body?.data || [];
  }

  async getPositions() {
    this.#ensureConfigured();
    const response = await this.#fetchWithTimeout(`${this.baseUrl}/v2/positions`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const { body } = await this.#readResponseBody(response);
    if (!response.ok) {
      const error = new Error(`Alpaca positions request failed (${response.status})`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return Array.isArray(body) ? body : body?.positions || body?.data || [];
  }

  async getAsset(symbol) {
    this.#ensureConfigured();
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    if (!normalizedSymbol) {
      throw new Error('Alpaca asset lookup requires a symbol');
    }
    const response = await this.#fetchWithTimeout(`${this.baseUrl}/v2/assets/${encodeURIComponent(normalizedSymbol)}`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const { body } = await this.#readResponseBody(response);
    if (!response.ok) {
      const error = new Error(`Alpaca asset lookup failed (${response.status})`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return body;
  }

  async getOrderByClientOrderId(clientOrderId) {
    this.#ensureConfigured();
    if (!clientOrderId) {
      throw new Error('Alpaca client order lookup requires a client order id');
    }
    const response = await this.#fetchWithTimeout(`${this.baseUrl}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const { body } = await this.#readResponseBody(response);
    if (!response.ok) {
      const error = new Error(`Alpaca client order lookup failed (${response.status})`);
      error.status = response.status;
      error.response = body;
      throw error;
    }
    return body;
  }

  async findExistingOrderForRequest(request = {}) {
    const clientOrderId = deriveClientOrderId(request);
    if (!clientOrderId) return null;
    try {
      return await this.getOrderByClientOrderId(clientOrderId);
    } catch (error) {
      if (![404, 422].includes(Number(error.status))) throw error;
    }
    const openOrders = await this.getOpenOrders();
    return (Array.isArray(openOrders) ? openOrders : []).find((order) => {
      return String(order.client_order_id || order.request_id || '').trim() === clientOrderId;
    }) || null;
  }

  #headers() {
    return {
      'APCA-API-KEY-ID': this.apiKeyId,
      'APCA-API-SECRET-KEY': this.apiSecretKey,
      'content-type': 'application/json',
      'user-agent': this.userAgent,
    };
  }

  async #fetchWithTimeout(url, init = {}) {
    const timeoutMs = Math.max(1, Number(init.timeoutMs ?? this.requestTimeoutMs) || this.requestTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error(`Alpaca request timed out after ${timeoutMs}ms`);
        timeoutError.code = 'ALPACA_REQUEST_TIMEOUT';
        timeoutError.status = 504;
        timeoutError.timeoutMs = timeoutMs;
        timeoutError.url = url;
        timeoutError.cause = error;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #readResponseBody(response) {
    const bodyText = await response.text();
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = { raw: bodyText };
    }
    return { body, bodyText };
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

function deriveClientOrderId(request = {}) {
  return request.client_order_id || request.idempotency_key || request.request_id || request.signal_id || null;
}

function isDuplicateClientOrderError(status, message) {
  const text = String(message || '').toLowerCase();
  return [400, 403, 409, 422].includes(Number(status))
    && text.includes('client')
    && text.includes('order');
}

module.exports = {
  AlpacaTradeAdapter,
  buildAlpacaOrderPayload,
  deriveClientOrderId,
  normalizeAlpacaBaseUrl,
};
