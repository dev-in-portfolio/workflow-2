const fs = require('fs');
const path = require('path');
const { nowIso, resolveRepoRoot } = require('../util');
const { defaultCacheMeta, normalizeCacheMeta } = require('../source-fetch');

function resolveRegularWatchStatusPath(input = {}) {
  if (typeof input === 'string') return path.resolve(input);
  if (input?.filePath) return path.resolve(input.filePath);
  if (input?.path) return path.resolve(input.path);
  if (input?.dataDir) return path.resolve(input.dataDir, 'runtime', 'regular-watch-status.json');
  if (input?.repoRoot) return path.resolve(input.repoRoot, 'data', 'runtime', 'regular-watch-status.json');
  return path.resolve(resolveRepoRoot(), 'data', 'runtime', 'regular-watch-status.json');
}

function defaultRegularWatchStatus() {
  return {
    version: '2026-06-30.regular-watch-status.1',
    updated_at: null,
    enabled: false,
    regularWatchIntelligence: {
      enabled: false,
      status: 'off',
      lastRunAt: null,
      lastError: null,
      symbolsChecked: 0,
      moversFound: 0,
      blockedSymbols: 0,
      features: {
        marketConfirmation: false,
        assetValidation: false,
        haltCheck: false,
        secRiskCheck: false,
        newsCatalyst: false,
        priorityScoring: false,
        scannerRanking: false,
        positionAwareness: false,
      },
      sources: [],
    },
    regularWatchList: [],
    regularWatchMovers: [],
    universe: {
      source: null,
      full_eligible_count: 0,
      current_batch_size: 0,
      rotation_batch_size: 0,
      fast_lane_enabled: false,
      fast_lane_candidate_count: 0,
      fast_lane_limit: 0,
      fast_lane_sources: {},
      merged_scan_size: 0,
      displayed_top_limit: 100,
      scanned_today_count: 0,
      fresh_data_count: 0,
      rotation: null,
      warning: null,
    },
    sources: [],
    generatedAt: null,
    stale: true,
    status: 'disabled',
    lastRunAt: null,
    lastError: null,
  };
}

function normalizeRegularWatchStatus(status = {}) {
  const base = defaultRegularWatchStatus();
  base.version = status.version || base.version;
  base.updated_at = status.updated_at || null;
  base.enabled = Boolean(status.enabled);
  const intelligence = status.regularWatchIntelligence || status.regular_watch_intelligence || {};
  const sources = status.sources || status.regularWatchSources || status.regular_watch_sources || intelligence.sources || [];
  base.regularWatchIntelligence = {
    enabled: Boolean(intelligence.enabled),
    status: String(intelligence.status || 'off').toLowerCase(),
    lastRunAt: intelligence.lastRunAt || intelligence.last_run_at || null,
    lastError: intelligence.lastError || intelligence.last_error || null,
    symbolsChecked: Number.isFinite(Number(intelligence.symbolsChecked ?? intelligence.symbols_checked))
      ? Number(intelligence.symbolsChecked ?? intelligence.symbols_checked)
      : 0,
    moversFound: Number.isFinite(Number(intelligence.moversFound ?? intelligence.movers_found))
      ? Number(intelligence.moversFound ?? intelligence.movers_found)
      : 0,
    blockedSymbols: Number.isFinite(Number(intelligence.blockedSymbols ?? intelligence.blocked_symbols))
      ? Number(intelligence.blockedSymbols ?? intelligence.blocked_symbols)
      : 0,
    features: normalizeFeatureFlags(intelligence.features || intelligence.feature_flags || {}),
    sources: normalizeSourceStatuses(sources),
  };
  base.regularWatchList = Array.isArray(status.regularWatchList) ? status.regularWatchList.slice() : [];
  base.regularWatchMovers = Array.isArray(status.regularWatchMovers) ? status.regularWatchMovers.slice() : [];
  base.universe = normalizeUniverseStatus(status.universe || status.symbol_universe || {});
  base.sources = normalizeSourceStatuses(sources);
  base.generatedAt = status.generatedAt || status.generated_at || null;
  base.stale = Boolean(status.stale ?? true);
  base.status = String(status.status || (base.enabled ? 'active' : 'disabled')).toLowerCase();
  base.lastRunAt = status.lastRunAt || status.last_run_at || base.regularWatchIntelligence.lastRunAt || null;
  base.lastError = status.lastError || status.last_error || base.regularWatchIntelligence.lastError || null;
  return base;
}

function loadRegularWatchStatus(input = {}) {
  const filePath = resolveRegularWatchStatusPath(input);
  if (!fs.existsSync(filePath)) return defaultRegularWatchStatus();
  try {
    return normalizeRegularWatchStatus(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return defaultRegularWatchStatus();
  }
}

function saveRegularWatchStatus(status, input = {}) {
  const filePath = resolveRegularWatchStatusPath(input);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = normalizeRegularWatchStatus(status);
  normalized.updated_at = normalized.updated_at || nowIso();
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function buildRegularWatchStatusSnapshot({ featureState = null, status = null } = {}) {
  const evaluatedFeatures = featureState?.features || {};
  const currentStatus = normalizeRegularWatchStatus(status || defaultRegularWatchStatus());
  const featureFlags = {
    marketConfirmation: Boolean(evaluatedFeatures.REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED?.effective),
    assetValidation: Boolean(evaluatedFeatures.REGULAR_WATCH_ASSET_VALIDATION_ENABLED?.effective),
    haltCheck: Boolean(evaluatedFeatures.REGULAR_WATCH_HALT_CHECK_ENABLED?.effective),
    secRiskCheck: Boolean(evaluatedFeatures.REGULAR_WATCH_SEC_RISK_CHECK_ENABLED?.effective),
    newsCatalyst: Boolean(evaluatedFeatures.REGULAR_WATCH_NEWS_CATALYST_ENABLED?.effective),
    priorityScoring: Boolean(evaluatedFeatures.REGULAR_WATCH_PRIORITY_SCORING_ENABLED?.effective),
    scannerRanking: Boolean(evaluatedFeatures.REGULAR_WATCH_SCANNER_RANKING_ENABLED?.effective),
    positionAwareness: Boolean(evaluatedFeatures.REGULAR_WATCH_POSITION_AWARENESS_ENABLED?.effective),
  };
  const enabled = Boolean(evaluatedFeatures.REGULAR_WATCH_INTELLIGENCE_ENABLED?.effective);
  const storedStatus = String(currentStatus.regularWatchIntelligence.status || '').toLowerCase();
  const statusValue = enabled
    ? (['active', 'blocked', 'locked', 'error', 'warn', 'inactive'].includes(storedStatus) ? storedStatus : 'active')
    : (storedStatus && storedStatus !== 'disabled' ? storedStatus : 'off');
  const regularWatchIntelligence = {
    enabled,
    status: statusValue,
    lastRunAt: currentStatus.lastRunAt || currentStatus.regularWatchIntelligence.lastRunAt || null,
    lastError: currentStatus.lastError || currentStatus.regularWatchIntelligence.lastError || null,
    symbolsChecked: Number(currentStatus.regularWatchIntelligence.symbolsChecked || 0),
    moversFound: Number(currentStatus.regularWatchIntelligence.moversFound || 0),
    blockedSymbols: Number(currentStatus.regularWatchIntelligence.blockedSymbols || 0),
    features: featureFlags,
    sources: Array.isArray(currentStatus.sources) ? currentStatus.sources.slice() : [],
    featureState,
  };
  const scannerRanking = {
    enabled: Boolean(featureFlags.scannerRanking),
    status: featureFlags.scannerRanking ? regularWatchIntelligence.status : 'off',
    lastRunAt: regularWatchIntelligence.lastRunAt,
    lastError: regularWatchIntelligence.lastError,
  };
  const positionAwareness = {
    enabled: Boolean(featureFlags.positionAwareness),
    status: featureFlags.positionAwareness ? regularWatchIntelligence.status : 'off',
    lastRunAt: regularWatchIntelligence.lastRunAt,
    lastError: regularWatchIntelligence.lastError,
  };

  return {
    ok: true,
    timestamp: nowIso(),
    regularWatchIntelligence,
    scannerRanking,
    positionAwareness,
    regularWatchList: Array.isArray(currentStatus.regularWatchList) ? currentStatus.regularWatchList.slice() : [],
    regularWatchMovers: Array.isArray(currentStatus.regularWatchMovers) ? currentStatus.regularWatchMovers.slice() : [],
    universe: currentStatus.universe || defaultRegularWatchStatus().universe,
    sources: Array.isArray(currentStatus.sources) ? currentStatus.sources.slice() : [],
    generatedAt: currentStatus.generatedAt || null,
    stale: Boolean(currentStatus.stale),
    status: regularWatchIntelligence.status,
    regularWatchStatus: {
      ...currentStatus,
      status: regularWatchIntelligence.status,
    },
  };
}

function refreshRegularWatchStatus({ featureState = null, status = null, lastError = null } = {}) {
  const current = normalizeRegularWatchStatus(status || defaultRegularWatchStatus());
  current.enabled = Boolean(featureState?.summary?.master_enabled);
  current.regularWatchIntelligence.enabled = current.enabled;
  current.regularWatchIntelligence.status = current.enabled ? 'active' : 'off';
  current.regularWatchIntelligence.lastRunAt = nowIso();
  current.regularWatchIntelligence.lastError = lastError || null;
  current.regularWatchIntelligence.symbolsChecked = Number(current.regularWatchIntelligence.symbolsChecked || 0);
  current.regularWatchIntelligence.moversFound = Number(current.regularWatchIntelligence.moversFound || 0);
  current.regularWatchIntelligence.blockedSymbols = Number(current.regularWatchIntelligence.blockedSymbols || 0);
  current.regularWatchIntelligence.sources = Array.isArray(current.sources) ? current.sources.slice() : [];
  current.generatedAt = current.generatedAt || null;
  current.stale = true;
  current.status = current.enabled ? 'active' : 'disabled';
  current.lastRunAt = current.regularWatchIntelligence.lastRunAt;
  current.lastError = current.regularWatchIntelligence.lastError;
  return current;
}

function clearRegularWatchErrors(status = null) {
  const current = normalizeRegularWatchStatus(status || defaultRegularWatchStatus());
  current.lastError = null;
  current.regularWatchIntelligence.lastError = null;
  return current;
}

function resetRegularWatchRuntimeState() {
  return defaultRegularWatchStatus();
}

function normalizeFeatureFlags(value = {}) {
  return {
    marketConfirmation: Boolean(value.marketConfirmation || value.market_confirmation),
    assetValidation: Boolean(value.assetValidation || value.asset_validation),
    haltCheck: Boolean(value.haltCheck || value.halt_check),
    secRiskCheck: Boolean(value.secRiskCheck || value.sec_risk_check),
    newsCatalyst: Boolean(value.newsCatalyst || value.news_catalyst),
    priorityScoring: Boolean(value.priorityScoring || value.priority_scoring),
    scannerRanking: Boolean(value.scannerRanking || value.scanner_ranking),
    positionAwareness: Boolean(value.positionAwareness || value.position_awareness),
  };
}

function normalizeSourceStatuses(value = []) {
  return (Array.isArray(value) ? value : []).map((entry) => ({
    ...entry,
    source: entry?.source || null,
    tier: entry?.tier || null,
    enabled: Boolean(entry?.enabled),
    available: Boolean(entry?.available),
    status: String(entry?.status || 'inactive').toLowerCase(),
    lastRunAt: entry?.lastRunAt || entry?.last_run_at || null,
    lastScanAt: entry?.lastScanAt || entry?.last_scan_at || entry?.lastRunAt || entry?.last_run_at || null,
    lastError: entry?.lastError || entry?.last_error || null,
    blockedReason: entry?.blockedReason || entry?.blocked_reason || null,
    cache: normalizeCacheMeta(entry?.cache || defaultCacheMeta()),
    symbolsDetected: Number.isFinite(Number(entry?.symbolsDetected ?? entry?.symbols_detected))
      ? Number(entry?.symbolsDetected ?? entry?.symbols_detected)
      : 0,
    rejectedTokens: Number.isFinite(Number(entry?.rejectedTokens ?? entry?.rejected_tokens))
      ? Number(entry?.rejectedTokens ?? entry?.rejected_tokens)
      : 0,
    tierWeight: Number.isFinite(Number(entry?.tierWeight)) ? Number(entry.tierWeight) : 1,
  }));
}

function normalizeUniverseStatus(value = {}) {
  const base = defaultRegularWatchStatus().universe;
  return {
    ...base,
    ...value,
    source: value.source || base.source,
    full_eligible_count: Number.isFinite(Number(value.full_eligible_count ?? value.fullEligibleCount))
      ? Number(value.full_eligible_count ?? value.fullEligibleCount)
      : base.full_eligible_count,
    current_batch_size: Number.isFinite(Number(value.current_batch_size ?? value.currentBatchSize))
      ? Number(value.current_batch_size ?? value.currentBatchSize)
      : base.current_batch_size,
    rotation_batch_size: Number.isFinite(Number(value.rotation_batch_size ?? value.rotationBatchSize))
      ? Number(value.rotation_batch_size ?? value.rotationBatchSize)
      : base.rotation_batch_size,
    fast_lane_enabled: Boolean(value.fast_lane_enabled ?? value.fastLaneEnabled ?? base.fast_lane_enabled),
    fast_lane_candidate_count: Number.isFinite(Number(value.fast_lane_candidate_count ?? value.fastLaneCandidateCount))
      ? Number(value.fast_lane_candidate_count ?? value.fastLaneCandidateCount)
      : base.fast_lane_candidate_count,
    fast_lane_limit: Number.isFinite(Number(value.fast_lane_limit ?? value.fastLaneLimit))
      ? Number(value.fast_lane_limit ?? value.fastLaneLimit)
      : base.fast_lane_limit,
    fast_lane_sources: value.fast_lane_sources || value.fastLaneSources || base.fast_lane_sources,
    merged_scan_size: Number.isFinite(Number(value.merged_scan_size ?? value.mergedScanSize))
      ? Number(value.merged_scan_size ?? value.mergedScanSize)
      : base.merged_scan_size,
    displayed_top_limit: Number.isFinite(Number(value.displayed_top_limit ?? value.displayedTopLimit))
      ? Number(value.displayed_top_limit ?? value.displayedTopLimit)
      : base.displayed_top_limit,
    scanned_today_count: Number.isFinite(Number(value.scanned_today_count ?? value.scannedTodayCount))
      ? Number(value.scanned_today_count ?? value.scannedTodayCount)
      : base.scanned_today_count,
    fresh_data_count: Number.isFinite(Number(value.fresh_data_count ?? value.freshDataCount))
      ? Number(value.fresh_data_count ?? value.freshDataCount)
      : base.fresh_data_count,
    scanned_today_date: value.scanned_today_date || value.scannedTodayDate || null,
    scanned_today_symbols: Array.isArray(value.scanned_today_symbols)
      ? value.scanned_today_symbols.slice()
      : (Array.isArray(value.scannedTodaySymbols) ? value.scannedTodaySymbols.slice() : []),
    rotation: value.rotation || null,
    warning: value.warning || null,
  };
}

module.exports = {
  buildRegularWatchStatusSnapshot,
  clearRegularWatchErrors,
  defaultRegularWatchStatus,
  loadRegularWatchStatus,
  normalizeRegularWatchStatus,
  normalizeUniverseStatus,
  normalizeFeatureFlags,
  normalizeSourceStatuses,
  refreshRegularWatchStatus,
  resolveRegularWatchStatusPath,
  resetRegularWatchRuntimeState,
  saveRegularWatchStatus,
};
