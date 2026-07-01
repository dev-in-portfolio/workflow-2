const fs = require('fs');
const path = require('path');
const { resolveRepoRoot, nowIso } = require('../util');

function resolveMemeMonitorStatusPath(input = {}) {
  if (typeof input === 'string') return path.resolve(input);
  if (input?.filePath) return path.resolve(input.filePath);
  if (input?.path) return path.resolve(input.path);
  if (input?.dataDir) return path.resolve(input.dataDir, 'runtime', 'meme-monitor-status.json');
  if (input?.repoRoot) return path.resolve(input.repoRoot, 'data', 'runtime', 'meme-monitor-status.json');
  return path.resolve(resolveRepoRoot(), 'data', 'runtime', 'meme-monitor-status.json');
}

function defaultMemeMonitorStatus() {
  return {
    version: '2026-06-30.meme-monitor-status.1',
    updated_at: null,
    enabled: false,
    redditScanner: {
      enabled: false,
      status: 'off',
      lastRunAt: null,
      lastError: null,
      sources: [],
      symbolsDetected: 0,
      rejectedTokens: 0,
      mode: 'shadow',
    },
    hotList: {
      enabled: false,
      status: 'off',
      dynamicCount: 0,
      hotHotCount: 0,
      lastScoredAt: null,
      stale: true,
      lastError: null,
    },
    hotHotScoring: {
      enabled: false,
      status: 'off',
      lastScoredAt: null,
      lastError: null,
      stale: true,
    },
    phaseA: {
      enabled: false,
      status: 'off',
      lastRunAt: null,
      lastError: null,
      sources: {},
      symbols: [],
    },
    phaseB: {
      enabled: false,
      status: 'off',
      lastRunAt: null,
      lastError: null,
      sources: {},
      symbols: [],
    },
  };
}

function normalizeMemeMonitorStatus(status = {}) {
  const base = defaultMemeMonitorStatus();
  base.version = status.version || base.version;
  base.updated_at = status.updated_at || null;
  base.enabled = Boolean(status.enabled);
  const scanner = status.redditScanner || status.reddit_scanner || {};
  const hotList = status.hotList || status.hot_list || {};
  const hotHotScoring = status.hotHotScoring || status.hot_hot_scoring || {};
  const phaseA = status.phaseA || status.phase_a || {};
  const phaseB = status.phaseB || status.phase_b || {};
  base.redditScanner = {
    enabled: Boolean(scanner.enabled),
    status: String(scanner.status || 'off').toLowerCase(),
    lastRunAt: scanner.lastRunAt || scanner.last_run_at || null,
    lastError: scanner.lastError || scanner.last_error || null,
    sources: normalizeSourceStatuses(scanner.sources || scanner.sourceStatuses || scanner.source_statuses),
    symbolsDetected: Number.isFinite(Number(scanner.symbolsDetected ?? scanner.symbols_detected))
      ? Number(scanner.symbolsDetected ?? scanner.symbols_detected)
      : 0,
    rejectedTokens: Number.isFinite(Number(scanner.rejectedTokens ?? scanner.rejected_tokens))
      ? Number(scanner.rejectedTokens ?? scanner.rejected_tokens)
      : 0,
    mode: String(scanner.mode || 'shadow').toLowerCase(),
  };
  base.hotList = {
    enabled: Boolean(hotList.enabled),
    status: String(hotList.status || 'off').toLowerCase(),
    dynamicCount: Number.isFinite(Number(hotList.dynamicCount ?? hotList.dynamic_count)) ? Number(hotList.dynamicCount ?? hotList.dynamic_count) : 0,
    hotHotCount: Number.isFinite(Number(hotList.hotHotCount ?? hotList.hot_hot_count)) ? Number(hotList.hotHotCount ?? hotList.hot_hot_count) : 0,
    lastScoredAt: hotList.lastScoredAt || hotList.last_scored_at || null,
    stale: Boolean(hotList.stale ?? true),
    lastError: hotList.lastError || hotList.last_error || null,
  };
  base.hotHotScoring = {
    enabled: Boolean(hotHotScoring.enabled),
    status: String(hotHotScoring.status || 'off').toLowerCase(),
    lastScoredAt: hotHotScoring.lastScoredAt || hotHotScoring.last_scored_at || null,
    lastError: hotHotScoring.lastError || hotHotScoring.last_error || null,
    stale: Boolean(hotHotScoring.stale ?? true),
  };
  base.phaseA = {
    enabled: Boolean(phaseA.enabled),
    status: String(phaseA.status || 'off').toLowerCase(),
    lastRunAt: phaseA.lastRunAt || phaseA.last_run_at || null,
    lastError: phaseA.lastError || phaseA.last_error || null,
    sources: phaseA.sources && typeof phaseA.sources === 'object' ? phaseA.sources : {},
    symbols: Array.isArray(phaseA.symbols) ? phaseA.symbols.slice() : [],
  };
  base.phaseB = {
    enabled: Boolean(phaseB.enabled),
    status: String(phaseB.status || 'off').toLowerCase(),
    lastRunAt: phaseB.lastRunAt || phaseB.last_run_at || null,
    lastError: phaseB.lastError || phaseB.last_error || null,
    sources: phaseB.sources && typeof phaseB.sources === 'object' ? phaseB.sources : {},
    symbols: Array.isArray(phaseB.symbols) ? phaseB.symbols.slice() : [],
  };
  return base;
}

function loadMemeMonitorStatus(input = {}) {
  const filePath = resolveMemeMonitorStatusPath(input);
  if (!fs.existsSync(filePath)) return defaultMemeMonitorStatus();
  try {
    return normalizeMemeMonitorStatus(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return defaultMemeMonitorStatus();
  }
}

function saveMemeMonitorStatus(status, input = {}) {
  const filePath = resolveMemeMonitorStatusPath(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeMemeMonitorStatus(status);
  normalized.updated_at = normalized.updated_at || nowIso();
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function normalizeSourceStatuses(value = []) {
  return (Array.isArray(value) ? value : []).map((entry) => ({
    source: entry?.source || null,
    tier: entry?.tier || null,
    status: String(entry?.status || 'inactive').toLowerCase(),
    blockedReason: entry?.blockedReason || entry?.blocked_reason || null,
    lastScanAt: entry?.lastScanAt || entry?.last_scan_at || null,
    lastError: entry?.lastError || entry?.last_error || null,
    symbolsDetected: Number.isFinite(Number(entry?.symbolsDetected ?? entry?.symbols_detected))
      ? Number(entry?.symbolsDetected ?? entry?.symbols_detected)
      : 0,
    rejectedTokens: Number.isFinite(Number(entry?.rejectedTokens ?? entry?.rejected_tokens))
      ? Number(entry?.rejectedTokens ?? entry?.rejected_tokens)
      : 0,
    tierWeight: Number.isFinite(Number(entry?.tierWeight)) ? Number(entry.tierWeight) : 1,
  }));
}

module.exports = {
  defaultMemeMonitorStatus,
  loadMemeMonitorStatus,
  normalizeMemeMonitorStatus,
  resolveMemeMonitorStatusPath,
  saveMemeMonitorStatus,
};
