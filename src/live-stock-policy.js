const { safeNumber } = require('./util');

const LIVE_STOCK_POLICY_DEFAULTS = Object.freeze({
  minMovePct: 0.25,
  requireRecentMomentum: true,
  minRecentMovePct: 0.15,
  minRecentRangePct: 0.15,
  minRecentCloseLocationPct: 65,
  sellNetProfitFloorDollars: 0.35,
  trailingProfitStartDollars: 0.45,
  trailingProfitGivebackDollars: 0.1,
  stalePositionExitEnabled: true,
  stalePositionMaxHoldMinutes: 12,
  stalePositionMinPeakProfitDollars: 0.25,
  stalePositionMaxExitPnlDollars: 0.35,
  stalledWinnerExitEnabled: true,
  stalledWinnerMaxHoldMinutes: 10,
  stalledWinnerMaxMinutesSincePeak: 5,
  stalledWinnerMinProfitDollars: 0.45,
});

function normalizeLiveStockPolicy(input = {}) {
  return {
    minMovePct: Math.max(0, safeNumber(input.minMovePct, LIVE_STOCK_POLICY_DEFAULTS.minMovePct)),
    requireRecentMomentum: input.requireRecentMomentum ?? LIVE_STOCK_POLICY_DEFAULTS.requireRecentMomentum,
    minRecentMovePct: Math.max(0, safeNumber(input.minRecentMovePct, LIVE_STOCK_POLICY_DEFAULTS.minRecentMovePct)),
    minRecentRangePct: Math.max(0, safeNumber(input.minRecentRangePct, LIVE_STOCK_POLICY_DEFAULTS.minRecentRangePct)),
    minRecentCloseLocationPct: Math.max(0, Math.min(100, safeNumber(input.minRecentCloseLocationPct, LIVE_STOCK_POLICY_DEFAULTS.minRecentCloseLocationPct))),
    sellNetProfitFloorDollars: Math.max(0, safeNumber(input.sellNetProfitFloorDollars, LIVE_STOCK_POLICY_DEFAULTS.sellNetProfitFloorDollars)),
    trailingProfitStartDollars: Math.max(0.01, safeNumber(input.trailingProfitStartDollars, LIVE_STOCK_POLICY_DEFAULTS.trailingProfitStartDollars)),
    trailingProfitGivebackDollars: Math.max(0.01, safeNumber(input.trailingProfitGivebackDollars, LIVE_STOCK_POLICY_DEFAULTS.trailingProfitGivebackDollars)),
    stalePositionExitEnabled: input.stalePositionExitEnabled ?? LIVE_STOCK_POLICY_DEFAULTS.stalePositionExitEnabled,
    stalePositionMaxHoldMinutes: Math.max(1, safeNumber(input.stalePositionMaxHoldMinutes, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxHoldMinutes)),
    stalePositionMinPeakProfitDollars: Math.max(0, safeNumber(input.stalePositionMinPeakProfitDollars, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMinPeakProfitDollars)),
    stalePositionMaxExitPnlDollars: safeNumber(input.stalePositionMaxExitPnlDollars, LIVE_STOCK_POLICY_DEFAULTS.stalePositionMaxExitPnlDollars),
    stalledWinnerExitEnabled: input.stalledWinnerExitEnabled ?? LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerExitEnabled,
    stalledWinnerMaxHoldMinutes: Math.max(1, safeNumber(input.stalledWinnerMaxHoldMinutes, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxHoldMinutes)),
    stalledWinnerMaxMinutesSincePeak: Math.max(1, safeNumber(input.stalledWinnerMaxMinutesSincePeak, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMaxMinutesSincePeak)),
    stalledWinnerMinProfitDollars: Math.max(0, safeNumber(input.stalledWinnerMinProfitDollars, LIVE_STOCK_POLICY_DEFAULTS.stalledWinnerMinProfitDollars)),
  };
}

module.exports = {
  LIVE_STOCK_POLICY_DEFAULTS,
  normalizeLiveStockPolicy,
};
