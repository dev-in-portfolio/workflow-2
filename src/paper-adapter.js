const { hashObject, nowIso, safeNumber } = require('./util');
const { computePaperOutcome } = require('./paper-outcomes');

const ORDER_STATES = [
  'proposed',
  'risk_checked',
  'approval_required',
  'approved',
  'submitted_to_paper',
  'accepted',
  'partially_filled',
  'filled',
  'rejected',
  'cancelled',
  'expired',
  'reconciled',
  'failed',
];

const ALLOWED_TRANSITIONS = {
  proposed: ['risk_checked', 'rejected', 'failed'],
  risk_checked: ['approval_required', 'approved', 'rejected', 'failed'],
  approval_required: ['approved', 'rejected', 'failed'],
  approved: ['submitted_to_paper', 'cancelled', 'failed'],
  submitted_to_paper: ['accepted', 'rejected', 'failed'],
  accepted: ['partially_filled', 'filled', 'cancelled', 'expired', 'failed'],
  partially_filled: ['filled', 'cancelled', 'expired', 'failed'],
  filled: ['reconciled'],
  rejected: ['reconciled'],
  cancelled: ['reconciled'],
  expired: ['reconciled'],
  failed: ['reconciled'],
  reconciled: [],
};

class PaperTradeAdapter {
  constructor(options = {}) {
    this.orders = new Map();
    this.idempotencyIndex = new Map();
    this.transitions = [];
    this.positions = new Map();
    this.audit = options.audit || null;
    this.simulateSlippagePct = options.simulateSlippagePct ?? 0.05;
    this.simulateFee = options.simulateFee ?? 0.0;
    this.dryRun = options.dryRun ?? true;
  }

  proposeOrder(request) {
    const order = this.#buildOrder(request, 'proposed');
    this.#persistOrder(order);
    this.#recordTransition(order, null, 'proposed', 'order proposed');
    return order;
  }

  submitOrder(request, context = {}) {
    const requestKey = request.request_id || request.idempotency_key || hashObject(request);
    if (this.idempotencyIndex.has(requestKey)) {
      return this.orders.get(this.idempotencyIndex.get(requestKey));
    }
    const order = this.#buildOrder(request, 'proposed');
    order.idempotency_key = requestKey;
    this.#persistOrder(order);
    this.#recordTransition(order, null, 'proposed', 'order proposed');

    this.transitionOrder(order.order_id, 'risk_checked', { reason: 'risk gate passed' });
    if (context.requireHumanApproval || request.human_approval_id === undefined) {
      this.transitionOrder(order.order_id, 'approval_required', { reason: 'human approval requested' });
      if (context.autoApprove === false) return this.orders.get(order.order_id);
    }
    this.transitionOrder(order.order_id, 'approved', { reason: 'approved for paper' });
    this.transitionOrder(order.order_id, 'submitted_to_paper', { reason: 'paper submission' });
    this.transitionOrder(order.order_id, 'accepted', { reason: 'paper adapter accepted' });
    const fillResult = this.simulateFill(order.order_id, context.market);
    if (fillResult.status === 'partially_filled') {
      this.transitionOrder(order.order_id, 'partially_filled', { fill: fillResult });
    } else if (fillResult.status === 'filled') {
      this.transitionOrder(order.order_id, 'filled', { fill: fillResult });
    } else if (fillResult.status === 'rejected') {
      this.transitionOrder(order.order_id, 'rejected', { fill: fillResult });
    }
    return this.orders.get(order.order_id);
  }

  transitionOrder(orderId, nextState, meta = {}) {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Unknown order ${orderId}`);
    }
    const allowed = ALLOWED_TRANSITIONS[order.status] || [];
    if (!allowed.includes(nextState)) {
      throw new Error(`Invalid state transition ${order.status} -> ${nextState}`);
    }
    const previousState = order.status;
    order.status = nextState;
    order.updated_at = nowIso();
    order.state_history.push({ from: previousState, to: nextState, at: order.updated_at, meta });
    this.transitions.push({ order_id: orderId, from: previousState, to: nextState, at: order.updated_at, meta });
    this.#audit('order_state_change', orderId, { order, transition: this.transitions[this.transitions.length - 1] });
    if (nextState === 'filled' || nextState === 'partially_filled') {
      this.#applyFill(order, meta.fill || meta);
    }
    return order;
  }

  simulateFill(orderId, market = {}) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Unknown order ${orderId}`);
    const marketPrice = safeNumber(market.price ?? market.last ?? order.limit_price ?? order.request.limit_price ?? order.request.entry_price);
    if (!Number.isFinite(marketPrice)) {
      return { status: 'accepted', reason: 'no_fill_price' };
    }
    const sideMultiplier = order.side === 'buy' ? 1 : -1;
    const slippage = marketPrice * this.simulateSlippagePct / 100;
    const fillPrice = marketPrice + (sideMultiplier * slippage);
    const quantity = safeNumber(order.quantity, 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { status: 'rejected', reason: 'invalid_quantity' };
    }
    if (order.order_type === 'limit' && order.limit_price !== null) {
      const canFill = order.side === 'buy' ? marketPrice <= order.limit_price : marketPrice >= order.limit_price;
      if (!canFill) {
        return { status: 'accepted', reason: 'limit_not_crossed' };
      }
    }
    const fillQuantity = order.order_type === 'market' ? quantity : Math.max(0, quantity * 0.5);
    const status = fillQuantity >= quantity ? 'filled' : 'partially_filled';
    return {
      status,
      filled_quantity: fillQuantity,
      average_fill_price: fillPrice,
      estimated_fees: Math.abs(fillPrice * fillQuantity) * this.simulateFee,
    };
  }

  reconcile() {
    const openOrders = [...this.orders.values()].filter((order) => ['accepted', 'partially_filled', 'submitted_to_paper', 'approved'].includes(order.status));
    const reconciled = [];
    for (const order of openOrders) {
      if (order.status === 'approved') {
        this.transitionOrder(order.order_id, 'submitted_to_paper', { reason: 'reconcile submission' });
      }
      if (order.status === 'submitted_to_paper') {
        this.transitionOrder(order.order_id, 'accepted', { reason: 'reconcile accept' });
      }
      if (order.status === 'accepted' || order.status === 'partially_filled') {
        const fill = this.simulateFill(order.order_id, {});
        if (fill.status === 'filled') {
          this.transitionOrder(order.order_id, 'filled', { fill });
        }
      }
      this.transitionOrder(order.order_id, 'reconciled', { reason: 'reconciled' });
      reconciled.push(this.orders.get(order.order_id));
    }
    return reconciled;
  }

  recordOutcome(orderId, exitSnapshot) {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`Unknown order ${orderId}`);
    }
    const outcome = computePaperOutcome({
      original_signal: order.request.original_signal || order.request.signal || order.request,
      paper_result: {
        order_id: orderId,
        filled_at: order.fill?.at || order.updated_at,
        average_fill_price: order.fill?.average_fill_price ?? order.limit_price ?? order.request.limit_price ?? order.request.entry_price ?? null,
        estimated_fees: order.fill?.estimated_fees ?? 0,
      },
      entry_price: exitSnapshot.entry_price ?? order.fill?.average_fill_price ?? order.limit_price ?? order.request.limit_price ?? order.request.entry_price,
      exit_price: exitSnapshot.exit_price,
      high_price: exitSnapshot.high_price,
      low_price: exitSnapshot.low_price,
      quantity: exitSnapshot.quantity ?? order.fill?.filled_quantity ?? order.quantity,
      side: order.side,
      false_positive: exitSnapshot.false_positive,
    });
    order.paper_outcome = outcome;
    order.updated_at = nowIso();
    this.#audit('paper_outcome_recorded', orderId, { order, outcome });
    return outcome;
  }

  listOrders() {
    return [...this.orders.values()];
  }

  getOpenOrders() {
    return this.listOrders().filter((order) => ['proposed', 'risk_checked', 'approval_required', 'approved', 'submitted_to_paper', 'accepted', 'partially_filled'].includes(order.status));
  }

  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  #buildOrder(request, status) {
    if (!request.request_id && !request.signal_id) {
      throw new Error('Order request requires request_id or signal_id');
    }
    const orderId = request.request_id || `ord_${hashObject(request).slice(0, 12)}`;
    const entryPrice = safeNumber(request.entry_price ?? request.limit_price ?? request.request?.entry_price ?? request.request?.limit_price ?? null);
    const quantity = safeNumber(request.quantity, null);
    const notional = safeNumber(request.notional, null);
    const normalizedQuantity = Number.isFinite(quantity) && quantity > 0
      ? quantity
      : (Number.isFinite(notional) && notional > 0 && Number.isFinite(entryPrice) && entryPrice > 0
        ? notional / entryPrice
        : 0);
    return {
      order_id: orderId,
      request_id: request.request_id || orderId,
      signal_id: request.signal_id || null,
      asset_id: request.asset_id || null,
      symbol: request.symbol,
      side: request.side,
      order_type: request.order_type || 'market',
      quantity: normalizedQuantity,
      notional: notional,
      limit_price: request.limit_price ?? null,
      stop_loss: request.stop_loss ?? null,
      take_profit: request.take_profit ?? null,
      entry_price: request.entry_price ?? null,
      time_in_force: request.time_in_force || 'day',
      strategy_name: request.strategy_name || 'unknown',
      confidence_score: safeNumber(request.confidence_score, 0),
      risk_decision_id: request.risk_decision_id || null,
      human_approval_id: request.human_approval_id || null,
      created_by: request.created_by || 'system',
      created_at: request.created_at || nowIso(),
      updated_at: nowIso(),
      status,
      state_history: [],
      request: { ...request },
    };
  }

  #persistOrder(order) {
    this.orders.set(order.order_id, order);
    this.idempotencyIndex.set(order.idempotency_key || order.request_id, order.order_id);
    this.#audit('paper_order_request', order.order_id, order);
  }

  #applyFill(order, fill) {
    const quantity = safeNumber(fill?.filled_quantity, safeNumber(order.quantity, 0));
    const price = safeNumber(fill?.average_fill_price, safeNumber(order.limit_price ?? order.request.limit_price ?? order.request.entry_price, 0));
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price)) return;
    const signedQty = order.side === 'buy' ? quantity : -quantity;
    const position = this.positions.get(order.symbol) || { symbol: order.symbol, quantity: 0, average_price: 0, realized_pnl: 0 };
    const newQuantity = position.quantity + signedQty;
    const weightedCost = position.quantity * position.average_price + signedQty * price;
    position.quantity = newQuantity;
    position.average_price = newQuantity === 0 ? 0 : Math.abs(weightedCost / newQuantity);
    position.last_fill_price = price;
    position.updated_at = nowIso();
    position.estimated_fees = (position.estimated_fees || 0) + safeNumber(fill?.estimated_fees, 0);
    this.positions.set(order.symbol, position);
    order.fill = { ...fill, at: nowIso() };
    this.#audit('paper_fill_event', order.order_id, { order, fill: order.fill });
  }

  #recordTransition(order, from, to, reason) {
    const at = nowIso();
    this.transitions.push({ order_id: order.order_id, from, to, at, meta: { reason } });
  }

  #audit(eventType, relatedEntityId, payload) {
    if (!this.audit) return;
    if (typeof this.audit.writeEvent === 'function') {
      this.audit.writeEvent({
        event_type: eventType,
        related_entity_id: relatedEntityId,
        payload,
        source: 'paper-adapter',
        severity: 'info',
      });
    }
  }
}

function examplePaperOrderWebhookPayload() {
  return {
    request_id: 'req_abc123',
    signal_id: 'sig_abc123',
    asset_id: 'asset_aapl',
    symbol: 'AAPL',
    side: 'buy',
    order_type: 'market',
    quantity: 5,
    stop_loss: 190,
    take_profit: 220,
    time_in_force: 'day',
    strategy_name: 'opening-breakout',
    confidence_score: 84,
    risk_decision_id: 'risk_abc123',
    human_approval_id: 'human_abc123',
    created_by: 'system',
    created_at: nowIso(),
  };
}

module.exports = {
  ORDER_STATES,
  PaperTradeAdapter,
  examplePaperOrderWebhookPayload,
};
