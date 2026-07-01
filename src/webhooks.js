const { safeNumber } = require('./util');

const TRADE_ACTIONS = new Set(['paper_buy', 'paper_sell', 'buy', 'sell']);
const NON_TRADE_ACTIONS = new Set(['hold', 'no_signal', 'no-signal', 'neutral', 'watch', 'alert', 'ignore']);
const DEFAULT_BUY_NOTIONAL_TARGET = 150;

function normalizeTradeSide(value) {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  if (['buy', 'paper_buy'].includes(normalized)) return 'buy';
  if (['sell', 'paper_sell'].includes(normalized)) return 'sell';
  return null;
}

function buildPaperOrderRequestFromSignal(signal, options = {}) {
  const action = String(signal.action_candidate || signal.action || '').trim().toLowerCase();
  if (NON_TRADE_ACTIONS.has(action) || !TRADE_ACTIONS.has(action)) {
    return null;
  }
  const side = normalizeTradeSide(action);
  if (!side) return null;
  const sizeMultiplier = clampSizeMultiplier(
    options.positionSizeMultiplier
      ?? options.policy?.positionSizeMultiplier
      ?? signal.position_size_multiplier
      ?? signal.size_multiplier
      ?? signal.policy_position_size_multiplier,
  );
  if (side === 'buy') {
    const sizing = resolveBuyOrderSizing(signal, options);
    if (!sizing.pass) {
      return null;
    }
    const timeInForce = 'day';
    return {
      request_id: signal.request_id || signal.signal_id || null,
      signal_id: signal.signal_id || null,
      asset_id: signal.asset_id || null,
      asset_type: signal.asset_type || signal.assetType || null,
      symbol: signal.symbol,
      side,
      order_type: signal.order_type || 'market',
      quantity: sizing.quantity,
      notional: sizing.notional,
      supports_fractional_shares: Boolean(sizing.supports_fractional_shares),
      limit_price: signal.limit_price ?? null,
      stop_loss: signal.stop_loss ?? null,
      take_profit: signal.take_profit ?? null,
      entry_price: signal.entry_price ?? signal.price ?? null,
      sizing_method: signal.sizing_method ?? signal.sizing_mode ?? null,
      risk_budget: signal.risk_budget ?? signal.risk_budget_sizing ?? null,
      risk_budget_sizing: signal.risk_budget_sizing ?? signal.risk_budget ?? null,
      structure_stop: signal.structure_stop ?? null,
      allow_scale_in: Boolean(signal.allow_scale_in || signal.allowScaleIn || options.allow_scale_in || options.allowScaleIn),
      time_in_force: timeInForce,
      strategy_name: signal.strategy_name || 'unknown',
      confidence_score: signal.confidence_score ?? null,
      risk_decision_id: signal.risk_decision_id || null,
      human_approval_id: signal.human_approval_id || null,
      created_by: signal.created_by || 'system',
      created_at: signal.created_at || new Date().toISOString(),
    };
  }
  const quantity = safeNumber(signal.quantity, null);
  const notional = safeNumber(signal.notional, null);
  const hasQuantity = Number.isFinite(quantity) && quantity > 0;
  const hasNotional = Number.isFinite(notional) && notional > 0;
  return {
    request_id: signal.request_id || signal.signal_id || null,
    signal_id: signal.signal_id || null,
    asset_id: signal.asset_id || null,
    asset_type: signal.asset_type || signal.assetType || null,
    symbol: signal.symbol,
    side,
    order_type: signal.order_type || 'market',
    quantity: hasQuantity ? Number((quantity * sizeMultiplier).toFixed(6)) : null,
    notional: hasNotional ? Number((notional * sizeMultiplier).toFixed(2)) : null,
    limit_price: signal.limit_price ?? null,
    stop_loss: signal.stop_loss ?? null,
    take_profit: signal.take_profit ?? null,
    entry_price: signal.entry_price ?? signal.price ?? null,
    sizing_method: signal.sizing_method ?? signal.sizing_mode ?? null,
    risk_budget: signal.risk_budget ?? signal.risk_budget_sizing ?? null,
    risk_budget_sizing: signal.risk_budget_sizing ?? signal.risk_budget ?? null,
    structure_stop: signal.structure_stop ?? null,
    allow_scale_in: Boolean(signal.allow_scale_in || signal.allowScaleIn || options.allow_scale_in || options.allowScaleIn),
    time_in_force: signal.time_in_force || 'day',
    strategy_name: signal.strategy_name || 'unknown',
    confidence_score: signal.confidence_score ?? null,
    risk_decision_id: signal.risk_decision_id || null,
    human_approval_id: signal.human_approval_id || null,
    created_by: signal.created_by || 'system',
    created_at: signal.created_at || new Date().toISOString(),
  };
}

function resolveBuyOrderSizing(signal, options = {}) {
  const targetNotional = Math.max(
    1,
    safeNumber(
      options.buyNotionalTarget
        ?? options.policy?.buyNotionalTarget
        ?? signal.buy_notional_target
        ?? signal.notional_target
        ?? DEFAULT_BUY_NOTIONAL_TARGET,
      DEFAULT_BUY_NOTIONAL_TARGET,
    ),
  );
  const price = safeNumber(
    signal.entry_price
      ?? signal.price
      ?? signal.market_data?.price
      ?? signal.market_context?.alpaca_quote?.price
      ?? signal.market_context?.primary_quote?.price
      ?? null,
    null,
  );
  const assetType = String(signal.asset_type || signal.assetType || '').trim().toLowerCase();
  const symbol = String(signal.symbol || '').trim().toUpperCase();
  const supportsFractionalShares = options.supportsFractionalShares
    ?? signal.supports_fractional_shares
    ?? signal.fractional_shares
    ?? (assetType === 'crypto' || symbol.includes('/'));

  if (!Number.isFinite(price) || price <= 0) {
    return {
      pass: true,
      quantity: null,
      notional: targetNotional,
      target_notional: targetNotional,
      price: null,
      supports_fractional_shares: Boolean(supportsFractionalShares),
      sizing_mode: 'notional_fallback',
      reason_codes: ['PRICE_UNAVAILABLE'],
    };
  }

  if (supportsFractionalShares) {
    const rawQuantity = targetNotional / price;
    const quantity = floorToDecimals(rawQuantity, 6);
    if (!(quantity > 0)) {
      return {
        pass: false,
        reason_codes: ['BUY_BUDGET_TOO_SMALL'],
        target_notional: targetNotional,
        price,
        supports_fractional_shares: true,
        sizing_mode: 'fractional_qty',
      };
    }
    return {
      pass: true,
      quantity,
      notional: Number((quantity * price).toFixed(2)),
      target_notional: targetNotional,
      price,
      supports_fractional_shares: true,
      sizing_mode: 'fractional_qty',
      reason_codes: [],
    };
  }

  const quantity = Math.floor(targetNotional / price);
  if (!(quantity >= 1)) {
    return {
      pass: false,
      reason_codes: ['BUY_BUDGET_TOO_SMALL_FOR_WHOLE_SHARES'],
      target_notional: targetNotional,
      price,
      supports_fractional_shares: false,
      sizing_mode: 'whole_share_qty',
    };
  }

  return {
    pass: true,
    quantity,
    notional: Number((quantity * price).toFixed(2)),
    target_notional: targetNotional,
    price,
    supports_fractional_shares: false,
    sizing_mode: 'whole_share_qty',
    reason_codes: [],
  };
}

function clampSizeMultiplier(value) {
  const multiplier = safeNumber(value, 1);
  return Math.max(0.5, Math.min(1.35, multiplier));
}

function floorToDecimals(value, decimals) {
  const factor = 10 ** Math.max(0, Math.floor(decimals || 0));
  return Math.floor(Number(value) * factor) / factor;
}

function validatePaperOrderWebhookPayload(payload) {
  const side = normalizeTradeSide(payload.side);
  const action = String(payload.action_candidate || payload.action || '').trim().toLowerCase();
  const quantity = safeNumber(payload.quantity, null);
  const notional = safeNumber(payload.notional, null);
  if (!side) {
    return {
      pass: false,
      reason_codes: ['INVALID_SIDE'],
    };
  }
  if (NON_TRADE_ACTIONS.has(action)) {
    return {
      pass: false,
      reason_codes: ['NON_TRADE_DECISION'],
    };
  }
  if (!((Number.isFinite(quantity) && quantity > 0) || (Number.isFinite(notional) && notional > 0))) {
    return {
      pass: false,
      reason_codes: ['MISSING_ORDER_SIZE'],
    };
  }
  return { pass: true, reason_codes: [] };
}

module.exports = {
  buildPaperOrderRequestFromSignal,
  normalizeTradeSide,
  resolveBuyOrderSizing,
  validatePaperOrderWebhookPayload,
};
