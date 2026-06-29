const fs = require('fs');
const path = require('path');
const { nowIso, safeNumber, resolveRepoRoot } = require('../util');

function calculateSpreadRankPenalty(spreadPct, { thresholdPct = 0.75, penaltyPerPct = 25, cap = 80 } = {}) {
  const spread = Math.max(0, safeNumber(spreadPct, 0));
  const threshold = Math.max(0, safeNumber(thresholdPct, 0.75));
  const rate = Math.max(0, safeNumber(penaltyPerPct, 25));
  const maxPenalty = Math.max(0, safeNumber(cap, 80));
  const excess = Math.max(0, spread - threshold);
  return Math.min(maxPenalty, excess * rate);
}

function loadRecentTradePenalties({ env = process.env, repoRoot = resolveRepoRoot(), now = nowIso(), windowMinutes = 5, penalty = 8, lossWindowMinutes = 10, lossPenalty = 60, stopWindowMinutes = 30, stopPenalty = 80, overrides = null } = {}) {
  if ((!windowMinutes || !penalty) && (!lossWindowMinutes || !lossPenalty) && (!stopWindowMinutes || !stopPenalty)) return new Map();
  if (overrides) return normalizeRecentTradePenaltyMap(overrides, { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty, stopWindowMinutes, stopPenalty });
  const historyPath = resolvePerformanceHistoryPath(env, repoRoot);
  const lines = readTailLines(historyPath, 512 * 1024);
  return normalizeRecentTradePenaltyMap(lines.map(parseJsonLine).filter(Boolean), { now, windowMinutes, penalty, lossWindowMinutes, lossPenalty, stopWindowMinutes, stopPenalty });
}

function resolvePerformanceHistoryPath(env = process.env, repoRoot = resolveRepoRoot()) {
  const configured = String(env.PERFORMANCE_HISTORY_PATH || '').trim();
  return path.resolve(repoRoot, configured || path.join('data', 'performance-history.jsonl'));
}

function readTailLines(filePath, maxBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeRecentTradePenaltyMap(source, { now = nowIso(), windowMinutes = 15, penalty = 20, lossWindowMinutes = 10, lossPenalty = 60, stopWindowMinutes = 30, stopPenalty = 80 } = {}) {
  const map = new Map();
  const nowMs = new Date(now).getTime();
  const windowMs = Math.max(0, safeNumber(windowMinutes, 15)) * 60_000;
  const lossWindowMs = Math.max(0, safeNumber(lossWindowMinutes, 10)) * 60_000;
  const stopWindowMs = Math.max(0, safeNumber(stopWindowMinutes, 30)) * 60_000;
  if (!Number.isFinite(nowMs)) return map;
  const records = source instanceof Map
    ? [...source.values()]
    : Array.isArray(source)
      ? source
      : Object.values(source || {});
  for (const item of records) {
    const record = item?.record || item;
    const trade = extractFilledTrade(record);
    if (!trade.symbol || !trade.traded_at) continue;
    const tradedAtMs = new Date(trade.traded_at).getTime();
    if (!Number.isFinite(tradedAtMs)) continue;
    const ageMs = nowMs - tradedAtMs;
    if (ageMs < 0) continue;
    const isLossExit = trade.side === 'sell' && trade.loss_exit;
    const isStopExit = trade.side === 'sell' && trade.stop_exit;
    if (trade.side !== 'sell') continue;
    const components = [];
    if (windowMs > 0 && penalty > 0 && ageMs <= windowMs) {
      components.push(buildPenaltyComponent({
        trade,
        tradedAtMs,
        nowMs,
        windowMs,
        penalty,
        reason: 'recent_sell',
      }));
    }
    if (isLossExit && lossWindowMs > 0 && lossPenalty > 0 && ageMs <= lossWindowMs) {
      components.push(buildPenaltyComponent({
        trade,
        tradedAtMs,
        nowMs,
        windowMs: lossWindowMs,
        penalty: lossPenalty,
        reason: 'recent_loss_exit',
      }));
    }
    if (isStopExit && stopWindowMs > 0 && stopPenalty > 0 && ageMs <= stopWindowMs) {
      components.push(buildPenaltyComponent({
        trade,
        tradedAtMs,
        nowMs,
        windowMs: stopWindowMs,
        penalty: stopPenalty,
        reason: 'recent_stop_exit',
      }));
    }
    if (!components.length) continue;
    const existing = map.get(trade.symbol) || {
      symbol: trade.symbol,
      last_traded_at: trade.traded_at,
      components: [],
    };
    existing.components.push(...components);
    existing.components.sort((a, b) => new Date(b.traded_at).getTime() - new Date(a.traded_at).getTime());
    existing.penalty = existing.components.reduce((sum, component) => sum + safeNumber(component.penalty, 0), 0);
    existing.last_traded_at = existing.components[0]?.traded_at || trade.traded_at;
    existing.age_seconds = existing.components.length
      ? Math.min(...existing.components.map((component) => safeNumber(component.age_seconds, 0)))
      : Math.round(ageMs / 1000);
    existing.window_seconds = existing.components.length
      ? Math.max(...existing.components.map((component) => safeNumber(component.window_seconds, 0)))
      : 0;
    existing.remaining_seconds = existing.components.length
      ? Math.max(...existing.components.map((component) => safeNumber(component.remaining_seconds, 0)))
      : 0;
    existing.reason = summarizePenaltyReason(existing.components);
    existing.loss_exit = existing.components.some((component) => component.loss_exit);
    existing.stop_exit = existing.components.some((component) => component.stop_exit);
    existing.exit_reason = existing.components.find((component) => component.exit_reason)?.exit_reason || null;
    map.set(trade.symbol, existing);
  }
  return map;
}

function buildPenaltyComponent({ trade, tradedAtMs, nowMs, windowMs, penalty, reason }) {
  const expiresAtMs = tradedAtMs + windowMs;
  return {
    reason,
    traded_at: trade.traded_at,
    expires_at: new Date(expiresAtMs).toISOString(),
    age_seconds: Math.max(0, Math.round((nowMs - tradedAtMs) / 1000)),
    remaining_seconds: Math.max(0, Math.round((expiresAtMs - nowMs) / 1000)),
    window_seconds: Math.round(windowMs / 1000),
    penalty,
    side: trade.side,
    loss_exit: Boolean(trade.loss_exit),
    stop_exit: Boolean(trade.stop_exit),
    exit_reason: trade.exit_reason || null,
  };
}

function summarizePenaltyReason(components = []) {
  const reasons = new Set(components.map((component) => component.reason).filter(Boolean));
  if (reasons.has('recent_stop_exit') && reasons.has('recent_loss_exit')) return 'compound_recent_sell_loss_and_stop';
  if (reasons.has('recent_stop_exit')) return 'compound_recent_sell_and_stop';
  if (reasons.has('recent_loss_exit')) return 'compound_recent_sell_and_loss';
  return 'compound_recent_sell';
}

function extractFilledTrade(record = {}) {
  const paperResult = record.paper_result || record.paperResult || {};
  const status = String(paperResult.status || record.status || '').trim().toLowerCase();
  const hasOrder = Boolean(paperResult.order_id || paperResult.filled_at || paperResult.filledAt || record.paper_result);
  if (status && !['filled', 'accepted', 'new'].includes(status)) return {};
  if (!hasOrder && record.entry_type !== 'paper_outcome') return {};
  const symbol = String(record.symbol || paperResult.symbol || record.original_signal?.symbol || paperResult.original_signal?.symbol || '').trim().toUpperCase();
  const tradedAt = paperResult.filled_at
    || paperResult.filledAt
    || record.recorded_at
    || record.created_at
    || record.timestamp
    || null;
  const side = String(record.side || record.paper_order_request?.side || record.original_signal?.side || paperResult.side || '').trim().toLowerCase();
  const exitState = record.original_signal?.market_context?.exit_state
    || record.market_context?.exit_state
    || record.exit_state
    || {};
  const exitReason = String(exitState.exit_reason || record.exit_reason || '').trim();
  const pnlValues = [
    record.net_pnl,
    record.adjusted_pnl,
    record.pnl,
    record.gross_pnl,
    exitState.net_pnl,
    exitState.gross_pnl,
    exitState.unrealized_pl,
  ].map((value) => safeNumber(value, null)).filter(Number.isFinite);
  const lossExit = side === 'sell' && (
    pnlValues.some((value) => value < 0)
    || /STOP_LOSS|LOSS/i.test(exitReason)
  );
  const stopExit = side === 'sell' && /STOP/i.test(exitReason);
  return {
    symbol,
    traded_at: tradedAt,
    side,
    loss_exit: lossExit,
    stop_exit: stopExit,
    exit_reason: exitReason || null,
  };
}

function getRecentTradePenalty(penalties, symbol) {
  if (!penalties) return null;
  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return null;
  if (penalties instanceof Map) return penalties.get(normalized) || null;
  return penalties[normalized] || null;
}

function summarizeRecentTradePenalties(penalties) {
  if (!penalties) return [];
  const values = penalties instanceof Map ? [...penalties.values()] : Object.values(penalties);
  return values.map((entry) => ({
    symbol: entry.symbol,
    last_traded_at: entry.last_traded_at,
    age_seconds: entry.age_seconds,
    window_seconds: entry.window_seconds,
    remaining_seconds: entry.remaining_seconds,
    penalty: entry.penalty,
    reason: entry.reason || 'compound_recent_sell',
    loss_exit: Boolean(entry.loss_exit),
    stop_exit: Boolean(entry.stop_exit),
    exit_reason: entry.exit_reason || null,
    components: Array.isArray(entry.components) ? entry.components : [],
  }));
}

function getStopoutClusterBlock(recentPenalty, { blockMinutes = 30, blockCount = 2 } = {}) {
  const requiredCount = Math.max(0, Math.floor(safeNumber(blockCount, 2)));
  const blockWindowSeconds = Math.max(0, safeNumber(blockMinutes, 30)) * 60;
  if (!recentPenalty || requiredCount <= 0 || blockWindowSeconds <= 0) {
    return { blocked: false, stop_exit_count: 0, required_count: requiredCount };
  }
  const stopComponents = (Array.isArray(recentPenalty.components) ? recentPenalty.components : [])
    .filter((component) => component?.reason === 'recent_stop_exit' || component?.reason === 'hard_stopout' || component?.reason === 'execution_bad_loss' || component?.reason === 'churn_exit' || component?.classification === 'hard_stopout' || component?.classification === 'execution_bad_loss' || component?.classification === 'churn_exit')
    .filter((component) => safeNumber(component.remaining_seconds, 0) > 0)
    .filter((component) => {
      const ageSeconds = safeNumber(component.age_seconds, 0);
      return ageSeconds <= blockWindowSeconds;
    });
  if (stopComponents.length < requiredCount) {
    return {
      blocked: false,
      stop_exit_count: stopComponents.length,
      required_count: requiredCount,
    };
  }
  const componentsByRemaining = [...stopComponents].sort((a, b) => safeNumber(a.remaining_seconds, 0) - safeNumber(b.remaining_seconds, 0));
  const unblockComponent = componentsByRemaining[Math.max(0, stopComponents.length - requiredCount)];
  return {
    blocked: true,
    stop_exit_count: stopComponents.length,
    required_count: requiredCount,
    remaining_seconds: safeNumber(unblockComponent?.remaining_seconds, 0),
    expires_at: unblockComponent?.expires_at || null,
  };
}

module.exports = {
  calculateSpreadRankPenalty,
  loadRecentTradePenalties,
  normalizeRecentTradePenaltyMap,
  getRecentTradePenalty,
  summarizeRecentTradePenalties,
  getStopoutClusterBlock,
  buildPenaltyComponent,
  summarizePenaltyReason,
  extractFilledTrade,
  resolvePerformanceHistoryPath,
  readTailLines,
  parseJsonLine,
};
