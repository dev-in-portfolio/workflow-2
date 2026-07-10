const fs = require('fs');
const path = require('path');
const { nowIso, safeNumber, resolveRepoRoot } = require('./util');
const { JsonFileStore } = require('./storage');
const { loadTrailingState } = require('./position-trailing-state');

async function reconcileBrokerLocalState(options = {}) {
  const checkedAt = options.now || nowIso();
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const dataDir = options.dataDir || path.join(repoRoot, 'data');
  const tolerance = {
    quantity: Math.max(0, safeNumber(options.quantityTolerance, 0.000001)),
    costBasis: Math.max(0, safeNumber(options.costBasisTolerance, 0.05)),
    pnl: Math.max(0, safeNumber(options.pnlTolerance, 0.25)),
  };
  const result = {
    checked_at: checkedAt,
    source_of_truth: 'alpaca',
    status: 'OK',
    account_available: false,
    positions_available: false,
    open_orders_available: false,
    mismatches: [],
    warnings: [],
    critical_failures: [],
    alpaca_positions: [],
    alpaca_open_orders: [],
    local_position_assumptions: [],
    historical_position_assumptions: [],
    local_phantom_positions: [],
    broker_positions_missing_locally: [],
    quantity_mismatches: [],
    cost_basis_mismatches: [],
    open_order_mismatches: [],
    trailing_state_mismatches: [],
    pnl_mismatches: [],
    recommended_actions: [],
  };

  const broker = await readBrokerTruth(options.executionAdapter || options.brokerSource);
  result.account_available = broker.account.available;
  result.positions_available = broker.positions.available;
  result.open_orders_available = broker.openOrders.available;
  if (!broker.account.available) addCritical(result, 'BROKER_ACCOUNT_UNAVAILABLE', broker.account.error);
  if (!broker.positions.available) addCritical(result, 'BROKER_POSITIONS_UNAVAILABLE', broker.positions.error);
  if (!broker.openOrders.available) addCritical(result, 'BROKER_OPEN_ORDERS_UNAVAILABLE', broker.openOrders.error);
  if (result.critical_failures.length) return finalize(result, options, dataDir);

  result.alpaca_positions = broker.positions.data.map(normalizeBrokerPosition).filter(Boolean);
  result.alpaca_open_orders = broker.openOrders.data.map(normalizeBrokerOrder).filter(Boolean);
  const localState = loadLocalState({ ...options, repoRoot, dataDir });
  result.local_position_assumptions = localState.positions;
  result.historical_position_assumptions = localState.historicalPositions;

  comparePositions(result, result.alpaca_positions, localState.positions, tolerance);
  compareOpenOrders(result, result.alpaca_open_orders, localState.openOrders);
  compareTrailingState(result, result.alpaca_positions, localState.trailingPositions);
  comparePnl(result, result.alpaca_positions, localState.positions, tolerance);
  detectBrokerActionConflicts(result, result.alpaca_open_orders, localState.nextActions);
  return finalize(result, options, dataDir);
}

async function readBrokerTruth(adapter) {
  return {
    account: await readAdapterState(adapter, 'getAccount'),
    positions: await readAdapterState(adapter, 'getPositions', []),
    openOrders: await readAdapterState(adapter, 'getOpenOrders', []),
  };
}

async function readAdapterState(adapter, method, fallback = null) {
  if (!adapter || typeof adapter[method] !== 'function') {
    return { available: false, data: fallback, error: `${method} unavailable` };
  }
  try {
    const data = await adapter[method]();
    return { available: data !== null && data !== undefined, data: data ?? fallback, error: null };
  } catch (error) {
    return { available: false, data: fallback, error: error?.message || String(error) };
  }
}

function loadLocalState(options = {}) {
  const historyEntries = Array.isArray(options.localPerformanceHistory)
    ? options.localPerformanceHistory
    : readJsonl(options.performanceHistoryPath || path.join(options.dataDir, 'performance-history.jsonl'));
  const scannerRuntime = options.scannerRuntime || readJson(options.scannerRuntimePath || path.join(options.dataDir, 'state', 'scanner-runtime.json'));
  const trailingState = options.trailingState || loadTrailingState({ env: options.env || process.env, repoRoot: options.repoRoot });
  const trailingPositions = trailingState?.positions || scannerRuntime?.trailing_state?.positions || scannerRuntime?.position_trailing_state?.positions || {};
  const historicalPositions = deriveLocalPositions(historyEntries);
  const useExplicitHistory = Array.isArray(options.localPerformanceHistory);
  return {
    positions: options.localPositions
      || (useExplicitHistory ? historicalPositions : deriveRuntimePositions(trailingPositions, scannerRuntime)),
    historicalPositions,
    openOrders: options.localOpenOrders || deriveLocalOpenOrders(scannerRuntime),
    trailingPositions,
    nextActions: deriveLocalNextActions(scannerRuntime),
  };
}

function deriveRuntimePositions(trailingPositions = {}, scannerRuntime = {}) {
  const explicit = [
    ...(Array.isArray(scannerRuntime?.broker_positions) ? scannerRuntime.broker_positions : []),
    ...(Array.isArray(scannerRuntime?.live_positions) ? scannerRuntime.live_positions : []),
  ].map(normalizeBrokerPosition).filter(Boolean);
  if (explicit.length) return explicit.map((position) => ({ ...position, source: 'scanner-runtime' }));
  return Object.entries(trailingPositions || {}).map(([key, value = {}]) => ({
    symbol: normalizeSymbol(value.symbol || key),
    quantity: optionalNumber(value.quantity ?? value.qty),
    avg_entry_price: optionalNumber(value.avg_entry_price ?? value.avgEntryPrice ?? value.entry_price),
    unrealized_pl: optionalNumber(value.current_unrealized_pl ?? value.unrealized_pl),
    source: 'position-trailing-state',
  })).filter((position) => position.symbol);
}

function deriveLocalPositions(entries = []) {
  const ledger = new Map();
  for (const entry of entries) {
    const record = entry?.record || entry;
    if ((entry?.entry_type || record?.entry_type) !== 'paper_outcome' && !record?.paper_result) continue;
    const paperResult = record.paper_result || {};
    const originalSignal = record.original_signal || paperResult.original_signal || {};
    const symbol = normalizeSymbol(
      record.symbol
      || paperResult.symbol
      || originalSignal.symbol,
    );
    if (!symbol) continue;
    const side = String(
      record.side
      || paperResult.side
      || originalSignal.side
      || record.order?.side
      || paperResult.order?.side
      || '',
    ).toLowerCase();
    if (side !== 'buy' && side !== 'sell') continue;
    const quantity = Math.abs(safeNumber(paperResult.filled_quantity ?? record.quantity, 0));
    if (!quantity) continue;
    const fillPrice = safeNumber(paperResult.average_fill_price ?? paperResult.fill_price ?? record.entry_price, null);
    const current = ledger.get(symbol) || { symbol, quantity: 0, avg_entry_price: null, unrealized_pl: null, source: 'performance-history' };
    if (side === 'sell') {
      current.quantity -= quantity;
    } else {
      const currentCost = current.quantity * safeNumber(current.avg_entry_price, 0);
      current.quantity += quantity;
      if (Number.isFinite(fillPrice) && current.quantity > 0) {
        current.avg_entry_price = (currentCost + quantity * fillPrice) / current.quantity;
      }
    }
    current.unrealized_pl = safeNumber(record.unrealized_pl ?? record.pnl, current.unrealized_pl);
    ledger.set(symbol, current);
  }
  return [...ledger.values()]
    .filter((position) => Math.abs(position.quantity) > 0.000001)
    .map((position) => ({
      ...position,
      quantity: round(position.quantity),
      avg_entry_price: Number.isFinite(position.avg_entry_price) ? round(position.avg_entry_price) : null,
    }));
}

function deriveLocalOpenOrders(scannerRuntime = {}) {
  const orders = [
    ...(Array.isArray(scannerRuntime?.open_orders) ? scannerRuntime.open_orders : []),
    ...(Array.isArray(scannerRuntime?.pending_orders) ? scannerRuntime.pending_orders : []),
    ...(Array.isArray(scannerRuntime?.local_open_orders) ? scannerRuntime.local_open_orders : []),
  ];
  return orders.map(normalizeBrokerOrder).filter(Boolean);
}

function deriveLocalNextActions(scannerRuntime = {}) {
  const candidates = Array.isArray(scannerRuntime?.candidates) ? scannerRuntime.candidates : [];
  return candidates
    .map((candidate) => ({
      symbol: normalizeSymbol(candidate.symbol || candidate.payload?.symbol),
      side: String(candidate.side || candidate.payload?.side || '').toLowerCase(),
      action: candidate.action_candidate || candidate.payload?.action_candidate || null,
    }))
    .filter((item) => item.symbol && item.side);
}

function comparePositions(result, brokerPositions, localPositions, tolerance) {
  const brokerBySymbol = mapBySymbol(brokerPositions);
  const localBySymbol = mapBySymbol(localPositions);
  for (const local of localPositions) {
    const broker = brokerBySymbol.get(local.symbol);
    if (!broker) {
      pushMismatch(result, 'LOCAL_PHANTOM_POSITION', local.symbol, 'critical', { local });
      result.local_phantom_positions.push(local);
      continue;
    }
    if (Number.isFinite(local.quantity) && Number.isFinite(broker.quantity)
      && Math.abs(Math.abs(local.quantity) - Math.abs(broker.quantity)) > tolerance.quantity) {
      const mismatch = { symbol: local.symbol, local_quantity: local.quantity, broker_quantity: broker.quantity };
      pushMismatch(result, 'QUANTITY_MISMATCH', local.symbol, 'critical', mismatch);
      result.quantity_mismatches.push(mismatch);
    }
    if (Number.isFinite(local.avg_entry_price) && Number.isFinite(broker.avg_entry_price)
      && Math.abs(local.avg_entry_price - broker.avg_entry_price) > tolerance.costBasis) {
      const mismatch = { symbol: local.symbol, local_avg_entry_price: local.avg_entry_price, broker_avg_entry_price: broker.avg_entry_price };
      pushMismatch(result, 'COST_BASIS_MISMATCH', local.symbol, 'warning', mismatch);
      result.cost_basis_mismatches.push(mismatch);
    }
  }
  for (const broker of brokerPositions) {
    if (!localBySymbol.has(broker.symbol)) {
      pushMismatch(result, 'BROKER_POSITION_MISSING_LOCALLY', broker.symbol, 'critical', { broker });
      result.broker_positions_missing_locally.push(broker);
    }
  }
}

function compareOpenOrders(result, brokerOrders, localOrders) {
  const brokerById = mapOrders(brokerOrders);
  const localById = mapOrders(localOrders);
  for (const broker of brokerOrders) {
    const local = brokerByIdKey(localById, broker);
    if (!local) {
      const type = broker.side === 'sell' ? 'ALPACA_OPEN_SELL_ORDER_UNKNOWN_LOCALLY' : 'ALPACA_OPEN_BUY_ORDER_UNKNOWN_LOCALLY';
      const mismatch = { type, symbol: broker.symbol, broker_order: broker };
      pushMismatch(result, type, broker.symbol, 'warning', mismatch);
      result.open_order_mismatches.push(mismatch);
      continue;
    }
    if (broker.side && local.side && broker.side !== local.side) {
      const mismatch = { type: 'OPEN_ORDER_SIDE_MISMATCH', symbol: broker.symbol, broker_order: broker, local_order: local };
      pushMismatch(result, 'OPEN_ORDER_SIDE_MISMATCH', broker.symbol, 'critical', mismatch);
      result.open_order_mismatches.push(mismatch);
    }
  }
  for (const local of localOrders) {
    if (!brokerByIdKey(brokerById, local)) {
      const mismatch = { type: 'LOCAL_EXPECTED_OPEN_ORDER_MISSING_AT_ALPACA', symbol: local.symbol, local_order: local };
      pushMismatch(result, 'LOCAL_EXPECTED_OPEN_ORDER_MISSING_AT_ALPACA', local.symbol, 'warning', mismatch);
      result.open_order_mismatches.push(mismatch);
    }
  }
}

function compareTrailingState(result, brokerPositions, trailingPositions = {}) {
  const brokerSymbols = new Set(brokerPositions.map((position) => position.symbol));
  const trailingSymbols = Object.keys(trailingPositions || {}).map(normalizeSymbol).filter(Boolean);
  for (const symbol of trailingSymbols) {
    if (!brokerSymbols.has(symbol)) {
      const mismatch = { type: 'STALE_TRAILING_STATE', symbol, trailing_state: trailingPositions[symbol] };
      pushMismatch(result, 'STALE_TRAILING_STATE', symbol, 'warning', mismatch);
      result.trailing_state_mismatches.push(mismatch);
    }
  }
  for (const position of brokerPositions) {
    if (!trailingPositions[position.symbol]) {
      const mismatch = { type: 'BROKER_POSITION_MISSING_TRAILING_STATE', symbol: position.symbol };
      pushMismatch(result, 'BROKER_POSITION_MISSING_TRAILING_STATE', position.symbol, 'warning', mismatch);
      result.trailing_state_mismatches.push(mismatch);
    }
  }
}

function comparePnl(result, brokerPositions, localPositions, tolerance) {
  const localBySymbol = mapBySymbol(localPositions);
  for (const broker of brokerPositions) {
    const local = localBySymbol.get(broker.symbol);
    if (!local) continue;
    if (!Number.isFinite(broker.unrealized_pl) || !Number.isFinite(local.unrealized_pl)) continue;
    if (Math.abs(broker.unrealized_pl - local.unrealized_pl) > tolerance.pnl) {
      const mismatch = { symbol: broker.symbol, local_unrealized_pl: local.unrealized_pl, broker_unrealized_pl: broker.unrealized_pl };
      pushMismatch(result, 'PNL_MISMATCH', broker.symbol, 'warning', mismatch);
      result.pnl_mismatches.push(mismatch);
    }
  }
}

function detectBrokerActionConflicts(result, brokerOrders, nextActions) {
  for (const action of nextActions) {
    const conflict = brokerOrders.find((order) => order.symbol === action.symbol && order.side && action.side && order.side !== action.side);
    if (conflict) {
      pushMismatch(result, 'BROKER_OPEN_ORDER_CONFLICTS_WITH_LOCAL_ACTION', action.symbol, 'critical', { action, broker_order: conflict });
    }
  }
}

function finalize(result, options, dataDir) {
  result.critical_failures = [...new Set(result.critical_failures)];
  result.warnings = [...new Set(result.warnings)];
  result.status = result.critical_failures.length ? 'CRITICAL' : result.warnings.length || result.mismatches.length ? 'WARN' : 'OK';
  result.recommended_actions = buildRecommendedActions(result);
  if (options.writeLatest !== false) {
    writeLatestReconciliation(result, options.outputPath || path.join(dataDir, 'runtime', 'broker-local-reconciliation-latest.json'));
  }
  return result;
}

function buildRecommendedActions(result) {
  const actions = [];
  if (!result.account_available || !result.positions_available || !result.open_orders_available) actions.push('Restore Alpaca broker visibility before allowing buy-side live operation.');
  if (result.local_phantom_positions.length) actions.push('Review local performance history because it contains positions not present at Alpaca.');
  if (result.broker_positions_missing_locally.length) actions.push('Treat Alpaca positions as authoritative and refresh local runtime/trailing state.');
  if (result.open_order_mismatches.length) actions.push('Review Alpaca open orders before the next scanner cycle.');
  if (result.trailing_state_mismatches.length) actions.push('Refresh scanner/trailing runtime state so exits remain explainable.');
  return actions;
}

function addCritical(result, code, detail) {
  result.critical_failures.push(code);
  if (detail) result.warnings.push(`${code}: ${detail}`);
}

function pushMismatch(result, type, symbol, severity, details = {}) {
  const mismatch = { type, symbol, severity, ...details };
  result.mismatches.push(mismatch);
  if (severity === 'critical') result.critical_failures.push(type);
  if (severity !== 'critical') result.warnings.push(type);
}

function normalizeBrokerPosition(position) {
  const symbol = normalizeSymbol(position?.symbol);
  if (!symbol) return null;
  return {
    symbol,
    quantity: safeNumber(position.qty ?? position.quantity ?? position.qty_available, 0),
    avg_entry_price: safeNumber(position.avg_entry_price ?? position.avgEntryPrice ?? position.average_price, null),
    current_price: safeNumber(position.current_price ?? position.currentPrice, null),
    market_value: safeNumber(position.market_value ?? position.marketValue, null),
    cost_basis: safeNumber(position.cost_basis ?? position.costBasis, null),
    unrealized_pl: safeNumber(position.unrealized_pl ?? position.unrealizedPnl ?? position.unrealized_intraday_pl, null),
    raw: position,
  };
}

function normalizeBrokerOrder(order) {
  const symbol = normalizeSymbol(order?.symbol);
  if (!symbol) return null;
  return {
    id: String(order.id || order.order_id || order.client_order_id || order.request_id || '').trim() || null,
    client_order_id: order.client_order_id || order.request_id || null,
    symbol,
    side: String(order.side || '').trim().toLowerCase(),
    status: String(order.status || order.order_status || '').trim().toLowerCase() || null,
    quantity: safeNumber(order.qty ?? order.quantity, null),
    notional: safeNumber(order.notional, null),
    raw: order,
  };
}

function mapBySymbol(items) {
  return new Map(items.map((item) => [item.symbol, item]));
}

function mapOrders(orders) {
  const map = new Map();
  for (const order of orders) {
    for (const key of orderKeys(order)) map.set(key, order);
  }
  return map;
}

function brokerByIdKey(map, order) {
  for (const key of orderKeys(order)) {
    if (map.has(key)) return map.get(key);
  }
  return null;
}

function orderKeys(order) {
  return [order.id, order.client_order_id, `${order.symbol}:${order.side}`].filter(Boolean);
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('/')) return raw;
  if (raw.endsWith('USDT')) return `${raw.slice(0, -4)}/USDT`;
  if (raw.endsWith('USD') && raw.length > 3) return `${raw.slice(0, -3)}/USD`;
  return raw;
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readJsonl(filePath) {
  const store = new JsonFileStore(path.dirname(filePath));
  try {
    return store.readLines(path.basename(filePath));
  } catch {
    return [];
  }
}

function writeLatestReconciliation(result, filePath) {
  const store = new JsonFileStore(path.dirname(filePath));
  store.write(path.basename(filePath), result);
}

function round(value) {
  return Math.round(Number(value) * 1_000_000) / 1_000_000;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  reconcileBrokerLocalState,
  writeLatestReconciliation,
};
