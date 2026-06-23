function calibrationBucketForConfidence(confidenceScore) {
  const score = Number(confidenceScore);
  if (!Number.isFinite(score)) return 'unknown';
  if (score >= 90) return '90-100';
  if (score >= 80) return '80-89';
  if (score >= 70) return '70-79';
  if (score >= 60) return '60-69';
  if (score >= 50) return '50-59';
  return '0-49';
}

function computePaperOutcome({
  original_signal,
  paper_result = {},
  entry_price,
  exit_price,
  high_price,
  low_price,
  quantity = 1,
  side = 'buy',
  position_exit = false,
  false_positive = false,
  estimated_entry_price = null,
  estimated_exit_price = null,
  estimated_fees = null,
}) {
  const entry = Number(entry_price);
  const exitNumeric = Number(exit_price);
  const exit = Number.isFinite(exitNumeric) && exitNumeric > 0 ? exitNumeric : null;
  const highNumeric = Number(high_price);
  const high = Number.isFinite(highNumeric) && highNumeric > 0 ? highNumeric : null;
  const lowNumeric = Number(low_price);
  const low = Number.isFinite(lowNumeric) && lowNumeric > 0 ? lowNumeric : null;
  const qty = Number(quantity) || 0;
  const normalizedSide = String(side).toLowerCase();
  const buySide = normalizedSide === 'buy' || Boolean(position_exit);

  const maxFavorableExcursion = Number.isFinite(entry) && Number.isFinite(high) && entry > 0
    ? buySide ? Math.max(0, high - entry) * qty : Math.max(0, entry - low) * qty
    : null;
  const maxAdverseExcursion = Number.isFinite(entry) && Number.isFinite(low) && entry > 0
    ? buySide ? Math.max(0, entry - low) * qty : Math.max(0, high - entry) * qty
    : null;
  const gross_pnl = Number.isFinite(entry) && exit !== null
    ? (buySide ? (exit - entry) : (entry - exit)) * qty
    : null;
  const normalizedEstimatedEntry = optionalNumber(estimated_entry_price, optionalNumber(paper_result?.average_fill_price, null));
  const normalizedEstimatedExit = optionalNumber(estimated_exit_price, optionalNumber(paper_result?.average_exit_price, null));
  const normalizedEstimatedFees = optionalNumber(estimated_fees, optionalNumber(paper_result?.estimated_fees, null));
  const entry_slippage = Number.isFinite(normalizedEstimatedEntry) && Number.isFinite(entry)
    ? Math.abs(normalizedEstimatedEntry - entry) * qty
    : null;
  const exit_slippage = Number.isFinite(normalizedEstimatedExit) && exit !== null
    ? Math.abs(normalizedEstimatedExit - exit) * qty
    : null;
  const fees = Number.isFinite(normalizedEstimatedFees) ? normalizedEstimatedFees : null;
  const execution_drag = [
    entry_slippage,
    exit_slippage,
    fees,
  ].filter((value) => Number.isFinite(value)).reduce((sum, value) => sum + value, 0);
  const net_pnl = Number.isFinite(gross_pnl) ? gross_pnl - execution_drag : null;
  const execution_drag_ratio = Number.isFinite(net_pnl) && net_pnl !== 0
    ? execution_drag / Math.max(1, Math.abs(net_pnl) + execution_drag)
    : null;
  const status = normalizeFillStatus(paper_result);

  return {
    original_signal: original_signal || null,
    paper_result: {
      ...paper_result,
      entry_price: Number.isFinite(entry) ? entry : null,
      exit_price: Number.isFinite(exit) ? exit : null,
      high_price: Number.isFinite(high) ? high : null,
      low_price: Number.isFinite(low) ? low : null,
      quantity: qty,
      side: normalizedSide,
      position_exit: Boolean(position_exit),
      status,
    },
    status,
    max_favorable_excursion: maxFavorableExcursion,
    max_adverse_excursion: maxAdverseExcursion,
    gross_pnl,
    pnl: gross_pnl,
    net_pnl,
    adjusted_pnl: net_pnl,
    entry_slippage,
    execution_slippage: entry_slippage,
    exit_slippage,
    fees,
    execution_drag,
    execution_drag_ratio,
    real_gain: Number.isFinite(net_pnl) ? net_pnl >= 0 : null,
    win_loss: net_pnl === null ? 'unknown' : net_pnl >= 0 ? 'win' : 'loss',
    calibration_bucket: calibrationBucketForConfidence(original_signal?.confidence_score),
    false_positive: Boolean(false_positive),
  };
}

function optionalNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFillStatus(paperResult = {}) {
  const status = String(paperResult.status || paperResult.order_status || paperResult.fill_status || '').trim().toLowerCase();
  if (status) return status;
  if (paperResult.filled_at || paperResult.filledAt || Number.isFinite(Number(paperResult.average_fill_price))) {
    return 'filled';
  }
  if (paperResult.rejected_at || paperResult.rejectedAt) return 'rejected';
  if (paperResult.canceled_at || paperResult.cancelled_at || paperResult.cancelledAt) return 'canceled';
  return 'unknown';
}

module.exports = {
  calibrationBucketForConfidence,
  computePaperOutcome,
  normalizeFillStatus,
};
