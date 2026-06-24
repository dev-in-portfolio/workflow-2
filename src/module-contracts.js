const { safeNumber } = require('./util');

function assertSignalCandidate(candidate) {
  const errors = [];
  const symbol = String(candidate?.symbol || '').trim();
  const side = String(candidate?.side || candidate?.action || '').trim().toLowerCase();
  if (!candidate || typeof candidate !== 'object') errors.push('candidate must be an object');
  if (!symbol) errors.push('symbol is required');
  if (!['buy', 'sell'].includes(side)) errors.push('side must be buy or sell');
  if (!candidate?.signal_id && !candidate?.request_id && !candidate?.id) errors.push('signal_id, request_id, or id is required');
  if (side === 'buy') {
    const notional = safeNumber(candidate?.notional, null);
    const quantity = safeNumber(candidate?.quantity, null);
    if (!Number.isFinite(notional) && !Number.isFinite(quantity)) errors.push('buy candidate requires notional or quantity');
  }
  return assertNoErrors('Signal candidate contract failed', errors);
}

function assertRiskDecision(decision) {
  const errors = [];
  if (!decision || typeof decision !== 'object') errors.push('decision must be an object');
  if (!decision?.decision) errors.push('decision is required');
  if (decision?.reason_codes !== undefined && !Array.isArray(decision.reason_codes)) errors.push('reason_codes must be an array');
  return assertNoErrors('Risk decision contract failed', errors);
}

function assertExecutionRequest(request) {
  const errors = [];
  const symbol = String(request?.symbol || '').trim();
  const side = String(request?.side || '').trim().toLowerCase();
  if (!request || typeof request !== 'object') errors.push('request must be an object');
  if (!symbol) errors.push('symbol is required');
  if (!['buy', 'sell'].includes(side)) errors.push('side must be buy or sell');
  if (!request?.request_id && !request?.signal_id && !request?.idempotency_key) errors.push('request_id, signal_id, or idempotency_key is required');
  const quantity = safeNumber(request?.quantity, null);
  const notional = safeNumber(request?.notional, null);
  if (!Number.isFinite(quantity) && !Number.isFinite(notional)) errors.push('quantity or notional is required');
  return assertNoErrors('Execution request contract failed', errors);
}

function assertExecutionResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object') errors.push('result must be an object');
  if (!result?.order_id && !result?.id) errors.push('order_id or id is required');
  if (!result?.status) errors.push('status is required');
  return assertNoErrors('Execution result contract failed', errors);
}

function assertPerformanceRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') errors.push('record must be an object');
  if (!record?.entry_type) errors.push('entry_type is required');
  if (record?.record === undefined) errors.push('record payload is required');
  return assertNoErrors('Performance record contract failed', errors);
}

function assertBrokerPosition(position) {
  const errors = [];
  if (!position || typeof position !== 'object') errors.push('position must be an object');
  if (!String(position?.symbol || '').trim()) errors.push('symbol is required');
  if (!Number.isFinite(safeNumber(position?.qty ?? position?.quantity ?? position?.qty_available, null))) errors.push('qty is required');
  return assertNoErrors('Broker position contract failed', errors);
}

function assertBrokerOrder(order) {
  const errors = [];
  if (!order || typeof order !== 'object') errors.push('order must be an object');
  if (!order?.id && !order?.order_id && !order?.client_order_id && !order?.request_id) errors.push('order id is required');
  if (!String(order?.symbol || '').trim()) errors.push('symbol is required');
  if (!String(order?.side || '').trim()) errors.push('side is required');
  return assertNoErrors('Broker order contract failed', errors);
}

function assertNoErrors(message, errors) {
  if (errors.length) {
    const error = new Error(`${message}: ${errors.join('; ')}`);
    error.contract_errors = errors;
    throw error;
  }
  return true;
}

module.exports = {
  assertBrokerOrder,
  assertBrokerPosition,
  assertExecutionRequest,
  assertExecutionResult,
  assertPerformanceRecord,
  assertRiskDecision,
  assertSignalCandidate,
};
