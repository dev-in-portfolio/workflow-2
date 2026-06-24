const { buildPortfolioSnapshot } = require('./portfolio-allocation');
const { nowIso, safeNumber } = require('./util');

const BrokerReconciliationReason = {
  BROKER_RECONCILIATION_UNAVAILABLE: 'BROKER_RECONCILIATION_UNAVAILABLE',
  BROKER_ACCOUNT_UNAVAILABLE: 'BROKER_ACCOUNT_UNAVAILABLE',
  BROKER_POSITIONS_UNAVAILABLE: 'BROKER_POSITIONS_UNAVAILABLE',
  BROKER_OPEN_ORDERS_UNAVAILABLE: 'BROKER_OPEN_ORDERS_UNAVAILABLE',
  BROKER_RECONCILIATION_FAILED: 'BROKER_RECONCILIATION_FAILED',
  BROKER_STATE_REQUIRED_FOR_BUY: 'BROKER_STATE_REQUIRED_FOR_BUY',
  BUYING_POWER_UNAVAILABLE: 'BUYING_POWER_UNAVAILABLE',
};

function isBrokerBackedExecutionAdapter(adapter) {
  if (!adapter) return false;
  if (adapter.requiresBrokerReconciliation === true) return true;
  if (adapter.requiresBrokerReconciliation === false) return false;
  return adapter.constructor?.name === 'AlpacaTradeAdapter';
}

async function reconcileBrokerPortfolio({
  executionAdapter = null,
  requestPortfolio = {},
  policy = {},
  signal = {},
} = {}) {
  const side = String(signal.side || signal.direction || '').trim().toLowerCase();
  const buySide = ['buy', 'bullish', 'paper_buy', 'long'].includes(side);
  const strict = isBrokerBackedExecutionAdapter(executionAdapter);
  const result = {
    available: !strict,
    source: strict ? 'broker' : 'request',
    strict,
    account_available: false,
    positions_available: false,
    open_orders_available: false,
    requested_portfolio_snapshot: requestPortfolio || {},
    broker_reconciled_portfolio: strict ? null : (requestPortfolio || {}),
    reason_codes: strict ? [] : [BrokerReconciliationReason.BROKER_RECONCILIATION_UNAVAILABLE],
    warnings: [],
    reconciled_at: nowIso(),
  };

  if (!strict) {
    return result;
  }

  const missingMethods = [];
  if (typeof executionAdapter.getAccount !== 'function') missingMethods.push(BrokerReconciliationReason.BROKER_ACCOUNT_UNAVAILABLE);
  if (typeof executionAdapter.getPositions !== 'function') missingMethods.push(BrokerReconciliationReason.BROKER_POSITIONS_UNAVAILABLE);
  if (typeof executionAdapter.getOpenOrders !== 'function') missingMethods.push(BrokerReconciliationReason.BROKER_OPEN_ORDERS_UNAVAILABLE);
  if (missingMethods.length) {
    result.reason_codes.push(...missingMethods, BrokerReconciliationReason.BROKER_RECONCILIATION_UNAVAILABLE);
    if (buySide) result.reason_codes.push(BrokerReconciliationReason.BROKER_STATE_REQUIRED_FOR_BUY);
    return finishUnavailable(result);
  }

  const [accountState, positionsState, openOrdersState] = await Promise.all([
    readBrokerState(() => executionAdapter.getAccount(), BrokerReconciliationReason.BROKER_ACCOUNT_UNAVAILABLE),
    readBrokerState(() => executionAdapter.getPositions(), BrokerReconciliationReason.BROKER_POSITIONS_UNAVAILABLE),
    readBrokerState(() => executionAdapter.getOpenOrders(), BrokerReconciliationReason.BROKER_OPEN_ORDERS_UNAVAILABLE),
  ]);

  result.account_available = accountState.available;
  result.positions_available = positionsState.available;
  result.open_orders_available = openOrdersState.available;

  for (const state of [accountState, positionsState, openOrdersState]) {
    if (!state.available) {
      result.reason_codes.push(state.reason_code);
      if (state.error) result.warnings.push(`${state.reason_code}: ${state.error}`);
    }
  }

  if (!accountState.available || !positionsState.available || !openOrdersState.available) {
    result.reason_codes.push(BrokerReconciliationReason.BROKER_RECONCILIATION_FAILED);
    if (buySide) result.reason_codes.push(BrokerReconciliationReason.BROKER_STATE_REQUIRED_FOR_BUY);
    return finishUnavailable(result);
  }

  const snapshot = buildPortfolioSnapshot({
    account: accountState.data,
    positions: positionsState.data,
    openOrders: openOrdersState.data,
    maxOpenPositions: policy.maxOpenPositions,
  });
  const buyingPower = safeNumber(snapshot.buying_power ?? snapshot.cash, null);
  if (buySide && !Number.isFinite(buyingPower)) {
    result.reason_codes.push(
      BrokerReconciliationReason.BUYING_POWER_UNAVAILABLE,
      BrokerReconciliationReason.BROKER_STATE_REQUIRED_FOR_BUY,
    );
    result.broker_reconciled_portfolio = {
      ...snapshot,
      available: false,
      reason_codes: result.reason_codes.slice(),
    };
    return finishUnavailable(result);
  }

  result.available = true;
  result.broker_reconciled_portfolio = {
    ...snapshot,
    available: true,
    source: 'broker-reconciled',
    broker_reconciliation_reason_codes: result.reason_codes.slice(),
  };
  return result;
}

async function readBrokerState(readFn, reasonCode) {
  try {
    const data = await readFn();
    if (data === null || data === undefined) {
      return { available: false, data: null, reason_code: reasonCode, error: 'empty response' };
    }
    return { available: true, data, reason_code: null, error: null };
  } catch (error) {
    return {
      available: false,
      data: null,
      reason_code: reasonCode,
      error: error?.message || String(error),
    };
  }
}

function finishUnavailable(result) {
  result.available = false;
  result.reason_codes = [...new Set(result.reason_codes.filter(Boolean))];
  result.broker_reconciled_portfolio = {
    ...(result.requested_portfolio_snapshot || {}),
    available: false,
    source: 'broker-reconciliation-unavailable',
    reason_codes: result.reason_codes.slice(),
    broker_reconciliation_reason_codes: result.reason_codes.slice(),
  };
  return result;
}

module.exports = {
  BrokerReconciliationReason,
  isBrokerBackedExecutionAdapter,
  reconcileBrokerPortfolio,
};
