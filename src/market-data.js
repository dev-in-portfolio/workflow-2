const { clamp, hashObject, nowIso, safeNumber } = require('./util');

const SYMBOL_ALIASES = {
  XBT: 'BTC',
  BTCUSD: 'BTC/USD',
  BTCUSDT: 'BTC/USDT',
  ETHUSD: 'ETH/USD',
  ETHUSDT: 'ETH/USDT',
  SPX: 'SPY',
};

function normalizeSymbol(symbol, assetType = 'stock') {
  if (!symbol) return null;
  const raw = String(symbol).trim().toUpperCase().replace(/\s+/g, '');
  if (assetType === 'crypto') {
    if (raw.includes('/')) {
      const [base, quote] = raw.split('/');
      return `${base}/${quote}`;
    }
    const alias = SYMBOL_ALIASES[raw];
    if (alias) return alias;
    if (raw.startsWith('XBT') && raw.endsWith('USD')) return `BTC/${raw.slice(-3)}`;
    if (raw.startsWith('XBT') && raw.endsWith('USDT')) return `BTC/${raw.slice(-4)}`;
    if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}/USD`;
    if (raw.endsWith('USDT') && raw.length > 4) return `${raw.slice(0, -4)}/USDT`;
    return raw;
  }
  return SYMBOL_ALIASES[raw] || raw;
}

function normalizeProviderName(provider) {
  return provider ? String(provider).trim().toLowerCase() : 'unknown';
}

function validateProviderTimestamp(timestamp, receivedAt = nowIso(), options = {}) {
  const maxFutureSkewSeconds = options.maxFutureSkewSeconds ?? 30;
  if (!timestamp) {
    return {
      valid: false,
      reason: 'MISSING_TIMESTAMP',
      parsed_at: null,
    };
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return {
      valid: false,
      reason: 'INVALID_TIMESTAMP',
      parsed_at: null,
    };
  }

  const received = new Date(receivedAt);
  if (!Number.isNaN(received.getTime()) && parsed.getTime() - received.getTime() > maxFutureSkewSeconds * 1000) {
    return {
      valid: false,
      reason: 'FUTURE_TIMESTAMP',
      parsed_at: parsed.toISOString(),
    };
  }

  return {
    valid: true,
    reason: null,
    parsed_at: parsed.toISOString(),
  };
}

function estimateLatencyMs(timestamp, receivedAt) {
  if (!timestamp || !receivedAt) return null;
  return Math.max(0, new Date(receivedAt).getTime() - new Date(timestamp).getTime());
}

function normalizeMarketData(raw, options = {}) {
  const provider = normalizeProviderName(raw.provider || raw.provider_name);
  const assetType = String(raw.asset_type || raw.assetType || 'stock').toLowerCase();
  const kind = String(raw.kind || raw.data_kind || 'quote').toLowerCase();
  const symbol = normalizeSymbol(raw.symbol || raw.ticker, assetType);
  const timestamp = raw.timestamp || raw.ts || raw.published_at || raw.captured_at || null;
  const receivedAt = raw.received_at || options.receivedAt || nowIso();
  const rawPayloadRef = raw.raw_payload_ref || `sha256:${hashObject(raw.raw_payload || raw)}`;
  const stalenessSeconds = safeNumber(raw.staleness_seconds, options.maxStalenessSeconds ?? 60);
  const price = safeNumber(raw.price ?? raw.last ?? raw.close);
  const previousClose = safeNumber(raw.previous_close ?? raw.prev_close);
  const volume = safeNumber(raw.volume);
  const confidence = clamp(safeNumber(raw.confidence, 50), 0, 100);
  const reliability = clamp(safeNumber(raw.reliability, 50), 0, 100);
  const latencyMs = estimateLatencyMs(timestamp, receivedAt);
  const timestampValidation = validateProviderTimestamp(timestamp, receivedAt, options);
  const ageMs = timestampValidation.valid ? Math.max(0, new Date(receivedAt).getTime() - new Date(timestamp).getTime()) : null;
  const stale = !timestampValidation.valid || (ageMs !== null ? ageMs > stalenessSeconds * 1000 : true);
  const issues = [];

  if (!provider || provider === 'unknown') issues.push('MISSING_PROVIDER');
  if (!symbol) issues.push('MISSING_SYMBOL');
  if (!timestampValidation.valid) issues.push(timestampValidation.reason);
  if (kind !== 'news' && volume === 0) issues.push('SUSPICIOUS_ZERO_VOLUME');

  let requiresConfirmation = false;
  if (Number.isFinite(price) && Number.isFinite(previousClose) && previousClose > 0) {
    const jumpPct = Math.abs((price - previousClose) / previousClose) * 100;
    if (jumpPct >= (options.priceJumpConfirmationPct ?? 15)) {
      requiresConfirmation = true;
      issues.push('PRICE_JUMP_REQUIRES_CONFIRMATION');
    }
  }
  if (stale) issues.push('STALE_DATA');

  return {
    asset_type: assetType,
    symbol,
    provider_name: provider,
    kind,
    timestamp,
    received_at: receivedAt,
    latency_ms: latencyMs,
    stale,
    stale_threshold_seconds: stalenessSeconds,
    confidence_score: confidence,
    reliability_score: reliability,
    provider_timestamp_valid: timestampValidation.valid,
    provider_timestamp_reason: timestampValidation.reason,
    requires_confirmation: requiresConfirmation,
    raw_payload_ref: rawPayloadRef,
    price: Number.isFinite(price) ? price : null,
    previous_close: Number.isFinite(previousClose) ? previousClose : null,
    volume: Number.isFinite(volume) ? volume : null,
    exchange: raw.exchange || raw.market || null,
    provider_asset_id: raw.provider_asset_id || null,
    provider_symbol: raw.provider_symbol || raw.symbol || null,
    raw_payload: raw.raw_payload || raw,
    freshness_issues: issues,
    fresh: issues.length === 0,
    normalized_at: nowIso(),
  };
}

function validateNormalizedMarketData(record) {
  const reasonCodes = [];
  if (!record.symbol) reasonCodes.push('MISSING_SYMBOL');
  if (!record.provider_name || record.provider_name === 'unknown') reasonCodes.push('MISSING_PROVIDER');
  if (!record.timestamp) reasonCodes.push('MISSING_TIMESTAMP');
  if (record.provider_timestamp_valid === false) reasonCodes.push(record.provider_timestamp_reason || 'INVALID_TIMESTAMP');
  if (record.stale) reasonCodes.push('STALE_DATA');
  if (record.kind !== 'news' && record.volume === 0) reasonCodes.push('SUSPICIOUS_ZERO_VOLUME');
  return {
    pass: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

function confirmAlpacaTwelveData(alpacaRecord, twelveDataRecord, options = {}) {
  const alpaca = normalizeProviderName(alpacaRecord?.provider_name || alpacaRecord?.provider);
  const twelve = normalizeProviderName(twelveDataRecord?.provider_name || twelveDataRecord?.provider);
  return confirmMarketPair(alpacaRecord, twelveDataRecord, {
    ...options,
    expectedPrimaryProvider: alpaca === 'alpaca' ? 'alpaca' : null,
    expectedSecondaryProvider: ['twelvedata', 'twelve_data'].includes(twelve) ? twelve : null,
  });
}

function buildProviderConfirmationFromContext(marketContext = {}, options = {}) {
  const tradeSide = normalizeTradeSideHint(
    options.trade_side || options.tradeSide || marketContext.trade_side || marketContext.tradeSide || '',
  );
  const assetType = resolveMarketAssetType(marketContext, options);
  const confirmationOptions = {
    ...(options.confirmation_options || {}),
  };
  if (assetType === 'crypto') {
    const baseMaxPriceDiffPct = safeNumber(confirmationOptions.maxPriceDiffPct, 0.75);
    confirmationOptions.maxPriceDiffPct = Math.max(
      baseMaxPriceDiffPct,
      safeNumber(options.cryptoMaxPriceDiffPct ?? options.crypto_max_price_diff_pct ?? 1.25, 1.25),
    );
    const baseMaxTimeSkewSeconds = safeNumber(confirmationOptions.maxTimeSkewSeconds, 60);
    confirmationOptions.maxTimeSkewSeconds = Math.max(
      baseMaxTimeSkewSeconds,
      safeNumber(options.cryptoMaxTimeSkewSeconds ?? options.crypto_max_time_skew_seconds ?? 120, 120),
    );
  }
  if (tradeSide === 'sell') {
    const baseMaxPriceDiffPct = safeNumber(confirmationOptions.maxPriceDiffPct, 0.5);
    confirmationOptions.maxPriceDiffPct = Math.max(
      baseMaxPriceDiffPct,
      safeNumber(options.sellMaxPriceDiffPct ?? options.sell_max_price_diff_pct, 0.75),
    );
  }
  const alpacaRecord = marketContext.alpaca_quote
    || marketContext.alpacaQuote
    || marketContext.alpaca_data
    || marketContext.alpaca
    || marketContext.primary_quote
    || null;
  const twelveDataRecord = marketContext.twelve_data_quote
    || marketContext.twelveDataQuote
    || marketContext.twelve_data
    || marketContext.twelve
    || marketContext.secondary_quote
    || null;

  if (!alpacaRecord || !twelveDataRecord) {
    const secondaryRecord = marketContext.secondary_quote
      || marketContext.secondaryQuote
      || marketContext.alternate_quote
      || marketContext.alternateQuote
      || null;

    if (!alpacaRecord || !secondaryRecord) {
      return null;
    }

    const alpacaNormalized = isNormalizedMarketRecord(alpacaRecord)
      ? alpacaRecord
      : normalizeMarketData({ provider: 'alpaca', ...alpacaRecord }, options.alpaca_options || {});
    const secondaryNormalized = isNormalizedMarketRecord(secondaryRecord)
      ? secondaryRecord
      : normalizeMarketData({ provider: secondaryRecord.provider || secondaryRecord.provider_name || 'secondary', ...secondaryRecord }, options.secondary_options || {});

    return confirmMarketPair(alpacaNormalized, secondaryNormalized, confirmationOptions);
  }

  const alpacaNormalized = isNormalizedMarketRecord(alpacaRecord)
    ? alpacaRecord
    : normalizeMarketData({ provider: 'alpaca', ...alpacaRecord }, options.alpaca_options || {});
  const twelveNormalized = isNormalizedMarketRecord(twelveDataRecord)
    ? twelveDataRecord
    : normalizeMarketData({ provider: 'twelvedata', ...twelveDataRecord }, options.twelve_options || {});

  return confirmAlpacaTwelveData(alpacaNormalized, twelveNormalized, confirmationOptions);
}

function resolveMarketAssetType(marketContext = {}, options = {}) {
  return String(
    options.asset_type
      || options.assetType
      || marketContext.asset_type
      || marketContext.assetType
      || marketContext.alpaca_quote?.asset_type
      || marketContext.primary_quote?.asset_type
      || marketContext.secondary_quote?.asset_type
      || marketContext.twelve_data_quote?.asset_type
      || 'stock',
  ).trim().toLowerCase();
}

function normalizeTradeSideHint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['buy', 'paper_buy', 'bullish', 'long'].includes(normalized)) return 'buy';
  if (['sell', 'paper_sell', 'bearish', 'short'].includes(normalized)) return 'sell';
  return normalized;
}

function confirmMarketPair(primaryRecord, secondaryRecord, options = {}) {
  const maxPriceDiffPct = options.maxPriceDiffPct ?? 0.5;
  const maxTimeSkewSeconds = options.maxTimeSkewSeconds ?? 60;
  const primaryProvider = normalizeProviderName(primaryRecord?.provider_name || primaryRecord?.provider);
  const secondaryProvider = normalizeProviderName(secondaryRecord?.provider_name || secondaryRecord?.provider);
  const reasons = [];

  if (!primaryProvider || primaryProvider === 'unknown') reasons.push('PRIMARY_PROVIDER_REQUIRED');
  if (!secondaryProvider || secondaryProvider === 'unknown') reasons.push('SECONDARY_PROVIDER_REQUIRED');
  if (providerFamily(primaryProvider) === providerFamily(secondaryProvider)) reasons.push('INDEPENDENT_PROVIDER_REQUIRED');
  if (options.expectedPrimaryProvider && primaryProvider !== options.expectedPrimaryProvider) reasons.push('PRIMARY_PROVIDER_MISMATCH');
  if (options.expectedSecondaryProvider && secondaryProvider !== options.expectedSecondaryProvider) reasons.push('SECONDARY_PROVIDER_MISMATCH');
  if (primaryRecord?.symbol !== secondaryRecord?.symbol) reasons.push('SYMBOL_MISMATCH');

  const priceA = safeNumber(primaryRecord?.price);
  const priceB = safeNumber(secondaryRecord?.price);
  if (!Number.isFinite(priceA) || !Number.isFinite(priceB) || priceA <= 0 || priceB <= 0) {
    reasons.push('MISSING_PRICE');
  }

  const priceDiffPct = Number.isFinite(priceA) && Number.isFinite(priceB)
    ? Math.abs(priceA - priceB) / ((priceA + priceB) / 2) * 100
    : null;

  if (priceDiffPct !== null && priceDiffPct > maxPriceDiffPct) {
    reasons.push('PRICE_DISAGREEMENT');
  }

  if (primaryRecord?.provider_timestamp_valid === false || secondaryRecord?.provider_timestamp_valid === false) {
    reasons.push(primaryRecord?.provider_timestamp_reason === 'INVALID_TIMESTAMP' || secondaryRecord?.provider_timestamp_reason === 'INVALID_TIMESTAMP'
      ? 'INVALID_TIMESTAMP'
      : 'STALE_DATA');
  }
  if (primaryRecord?.stale || secondaryRecord?.stale) {
    reasons.push('STALE_DATA');
  }

  const timeDiffSeconds = (primaryRecord?.timestamp && secondaryRecord?.timestamp)
    ? Math.abs(new Date(primaryRecord.timestamp).getTime() - new Date(secondaryRecord.timestamp).getTime()) / 1000
    : null;
  if (timeDiffSeconds !== null && timeDiffSeconds > maxTimeSkewSeconds) {
    reasons.push('TIMESTAMP_SKEW');
  }

  return {
    confirmed: reasons.length === 0,
    provider_pair: [primaryProvider, secondaryProvider],
    price_diff_pct: priceDiffPct,
    timestamp_skew_seconds: timeDiffSeconds,
    discrepancy_score: clamp((priceDiffPct || 0) * 10 + (timeDiffSeconds || 0) / 2, 0, 100),
    reason_codes: reasons,
  };
}

function providerFamily(provider) {
  const normalized = normalizeProviderName(provider);
  if (normalized.startsWith('alpaca')) return 'alpaca';
  if (normalized === 'twelve_data') return 'twelvedata';
  return normalized;
}

function isNormalizedMarketRecord(record) {
  return Boolean(record)
    && (
      Object.prototype.hasOwnProperty.call(record, 'provider_timestamp_valid')
      || Object.prototype.hasOwnProperty.call(record, 'stale')
      || Object.prototype.hasOwnProperty.call(record, 'raw_payload_ref')
      || Object.prototype.hasOwnProperty.call(record, 'normalized_at')
    );
}

function buildProviderChain(assetType, kind, registry) {
  const normalizedAssetType = String(assetType || 'stock').toLowerCase();
  const normalizedKind = String(kind || 'quote').toLowerCase();
  const mapping = registry?.[normalizedAssetType] || registry?.stock || {};
  const chain = mapping[normalizedKind] || mapping.quote || [];
  return chain.slice(0, 3);
}

module.exports = {
  buildProviderChain,
  confirmAlpacaTwelveData,
  buildProviderConfirmationFromContext,
  confirmMarketPair,
  normalizeMarketData,
  normalizeProviderName,
  normalizeSymbol,
  resolveMarketAssetType,
  validateNormalizedMarketData,
  validateProviderTimestamp,
};
