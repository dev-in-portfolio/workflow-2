const { safeNumber } = require('./util');

function classifyExitProtection({ positions = [], openOrders = [], scannerRuntime = null, now = new Date(), maxScannerAgeSeconds = 180 } = {}) {
  const openOrderList = Array.isArray(openOrders) ? openOrders : [];
  const runtimePositions = scannerRuntime?.trailing_state?.positions || scannerRuntime?.position_trailing_state?.positions || {};
  const lastScanAt = scannerRuntime?.last_scan_time || scannerRuntime?.updated_at || null;
  const scannerFresh = isFresh(lastScanAt, now, maxScannerAgeSeconds);
  return (Array.isArray(positions) ? positions : []).map((position) => {
    const symbol = String(position.symbol || '').trim().toUpperCase();
    const qty = safeNumber(position.qty ?? position.quantity ?? position.qty_available, 0);
    const protectiveOrder = openOrderList.find((order) => {
      const orderSymbol = String(order.symbol || '').trim().toUpperCase();
      const side = String(order.side || '').trim().toLowerCase();
      const type = String(order.type || order.order_type || order.order_class || '').trim().toLowerCase();
      return orderSymbol === symbol
        && side === 'sell'
        && (type.includes('stop') || type.includes('trailing') || order.stop_price || order.trail_price || order.trail_percent);
    }) || null;
    const scannerRecord = runtimePositions[symbol] || null;
    const classification = protectiveOrder
      ? 'broker_native'
      : scannerFresh && scannerRecord
        ? 'scanner_exit_manager'
        : 'none';
    return {
      symbol,
      quantity: Number.isFinite(qty) ? qty : null,
      classification,
      broker_native: Boolean(protectiveOrder),
      scanner_exit_manager: Boolean(scannerFresh && scannerRecord),
      scanner_fresh: scannerFresh,
      scanner_last_scan_at: lastScanAt,
      protective_order_id: protectiveOrder?.id || protectiveOrder?.order_id || null,
      warning: classification === 'none' ? 'EXIT_MANAGER_REQUIRED' : null,
    };
  });
}

function isFresh(timestamp, now = new Date(), maxAgeSeconds = 180) {
  if (!timestamp) return false;
  const then = new Date(timestamp).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return false;
  return nowMs - then <= Math.max(1, safeNumber(maxAgeSeconds, 180)) * 1000;
}

module.exports = {
  classifyExitProtection,
};
