const path = require('path');
const { createRedditCollector } = require('./reddit-collector');
const { extractMentionsFromRecord } = require('./symbol-extractor');
const { resolveMemeSocialSourceConfig } = require('./social-source-config');
const { scoreMemeHeat } = require('./meme-heat-score');
const { scoreMarketConfirmation } = require('./market-confirmation-score');
const { classifyHotHotCandidate } = require('./hot-hot-classifier');
const { resolveMemeEscalationPolicy, resolveMemeScoreMode } = require('./meme-escalation-policy');
const { loadMemeMonitorState } = require('../meme-monitor-state');
const { loadDynamicHotList, resolveDynamicHotListPath, saveDynamicHotList } = require('./hot-list-store');
const { loadMemeMonitorStatus, resolveMemeMonitorStatusPath, saveMemeMonitorStatus } = require('./meme-monitor-status');
const { runPhaseASources, resolvePhaseASourceRuntime } = require('./phase-a-source-runner');
const { runPhaseBSources, resolvePhaseBSourceRuntime } = require('./phase-b-source-runner');
const { resolveRepoRoot, nowIso } = require('../util');

function createMemeMonitorLoop(options = {}) {
  const env = options.env || process.env;
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const dataDir = options.dataDir || path.resolve(repoRoot, 'data');
  const collector = options.collector || createRedditCollector({ env, fetchImpl: options.fetchImpl });
  const refreshIntervalMs = Number.isFinite(Number(options.refreshIntervalMs))
    ? Number(options.refreshIntervalMs)
    : 5 * 60_000;
  const state = {
    running: false,
    timer: null,
    lastError: null,
    lastRunAt: null,
  };

  async function runOnce(runOptions = {}) {
    const policy = resolveMemeEscalationPolicy(env);
    const featureState = loadMemeMonitorState({ env, repoRoot, filePath: options.memeMonitorStatePath });
    const featureEnabled = Boolean(featureState.features?.MEME_MONITOR_ENABLED?.effective);
    const redditEnabled = Boolean(featureState.features?.MEME_REDDIT_SCANNER_ENABLED?.effective);
    const hotListEnabled = Boolean(featureState.features?.MEME_HOT_LIST_ENABLED?.effective);
    const dynamicWatchlistEnabled = Boolean(featureState.features?.MEME_DYNAMIC_WATCHLIST_ENABLED?.effective);
    const sourceConfig = resolveMemeSocialSourceConfig(env);
    const statusPath = resolveMemeMonitorStatusPath({ dataDir, filePath: options.statusPath });
    const hotListPath = resolveDynamicHotListPath({ dataDir, filePath: options.hotListPath });
    const currentMode = resolveMemeScoreMode({
      masterEnabled: featureEnabled,
      redditScannerEnabled: redditEnabled,
      hotListEnabled,
      dynamicWatchlistEnabled,
    });

    if (!featureEnabled) {
      return persistIdleState({
        statusPath,
        hotListPath,
        enabled: false,
        mode: 'off',
        sources: sourceConfig.sourceDefinitions,
        lastError: null,
      });
    }

    if (!redditEnabled) {
      return persistIdleState({
        statusPath,
        hotListPath,
        enabled: true,
        mode: 'off',
        sources: sourceConfig.sourceDefinitions,
        lastError: null,
      });
    }

    const collectorResult = await collector.collectSources({ env, repoRoot, dataDir, runOptions });
    if (!collectorResult.ok) {
      const payload = persistIdleState({
        statusPath,
        hotListPath,
        enabled: true,
        mode: currentMode,
        sources: collectorResult.sources || sourceConfig.sourceDefinitions,
        lastError: collectorResult.message || collectorResult.error || 'collector_failed',
        status: collectorResult.status === 'missing_credentials' ? 'missing_credentials' : 'error',
        symbolsDetected: 0,
        rejectedTokens: collectorResult.rejected?.length || 0,
        hotListEnabled,
        dynamicWatchlistEnabled,
      });
      state.lastError = runOptions.clearError ? null : payload.redditScanner.lastError;
      state.lastRunAt = payload.updated_at;
      return payload;
    }

    const mentions = [];
    const rejected = [];
    for (const record of collectorResult.records || []) {
      const extracted = extractMentionsFromRecord(record, {
        sourceMeta: record.sourceMeta || null,
        tradableSymbols: options.tradableSymbols,
        isTradableSymbol: options.isTradableSymbol,
        requireTradableMatch: options.requireTradableMatch,
      });
      mentions.push(...extracted.mentions);
      rejected.push(...extracted.rejected);
    }

    const generatedAt = nowIso();
    const heatScored = scoreMemeHeat(mentions, {
      generatedAt,
      dynamicMinScore: policy.dynamicMinScore,
      hotCandidateMinScore: policy.hotCandidateMinScore,
      hotHotMinScore: policy.hotHotMinScore,
    });
    const phaseA = await refreshPhaseA({
      env,
      repoRoot,
      dataDir,
      runOptions,
      runtimeState: featureState,
      records: collectorResult.records || [],
      mentions,
      candidateSymbols: heatScored.map((entry) => entry.symbol),
    });
    const phaseB = await refreshPhaseB({
      env,
      repoRoot,
      dataDir,
      runOptions,
      runtimeState: featureState,
      candidateSymbols: heatScored.map((entry) => entry.symbol),
      phaseASymbolsBySymbol: phaseA.symbolsBySymbol || {},
    });
    const marketContextBySymbol = await resolveMarketContextBySymbol({
      marketDataProvider: options.marketDataProvider,
      marketContextBySymbol: {
        ...(options.marketContextBySymbol || {}),
        ...(phaseA.marketContextBySymbol || {}),
      },
      hotHotList: heatScored,
      runOptions,
    });
    const classified = [];
    for (const entry of heatScored) {
      const marketContext = marketContextBySymbol.get(entry.symbol) || null;
      const marketConfirmation = scoreMarketConfirmation(entry.symbol, marketContext, {
        marketConfirmationMinScore: policy.marketConfirmationMinScore,
      });
      const classification = classifyHotHotCandidate({
        symbol: entry.symbol,
        memeHeatScore: entry.memeHeatScore,
        marketConfirmation,
        policy,
        sourceProfile: entry.sourceProfile,
        now: new Date(generatedAt),
      });
      const merged = {
        symbol: entry.symbol,
        status: classification.status,
        memeHeatScore: entry.memeHeatScore,
        marketConfirmationScore: classification.marketConfirmationScore,
        priorityOverrideEligible: false,
        rotationEligible: false,
        mentions15m: entry.mentions15m,
        mentions30m: entry.mentions30m,
        mentions60m: entry.mentions60m,
        uniqueUsers: entry.uniqueUsers,
        sourceCount: entry.sourceCount,
        topSources: entry.topSources,
        sourceProfile: entry.sourceProfile,
        sourceConfirmations: phaseA.sourceConfirmationsBySymbol?.[entry.symbol] || null,
        phaseA: phaseA.symbolsBySymbol?.[entry.symbol] || null,
        phaseB: phaseB.symbolsBySymbol?.[entry.symbol] || null,
        threadCount: entry.threadCount,
        commentCount: entry.commentCount,
        engagementScore: entry.engagementScore,
        freshnessScore: entry.freshnessScore,
        mentionVelocity: entry.mentionVelocity,
        spamConcentration: entry.spamConcentration,
        reasonCodes: unionReasonCodes(entry.reasonCodes, classification.reasonCodes, classification.marketConfirmationReasonCodes),
        riskWarnings: unionReasonCodes(entry.riskWarnings, classification.riskWarnings, marketConfirmation.riskWarnings),
        expiresAt: classification.expiresAt,
        marketConfirmationAvailable: classification.marketConfirmationAvailable,
      };
      classified.push(merged);
    }

    const expired = [];
    const dynamicHotList = [];
    const hotHotList = [];
    for (const entry of classified) {
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() <= Date.now()) {
        expired.push({ ...entry, expired: true });
        continue;
      }
      if (entry.status !== 'ignore') {
        dynamicHotList.push({
          symbol: entry.symbol,
          memeHeatScore: entry.memeHeatScore,
          marketConfirmationScore: entry.marketConfirmationScore,
          marketConfirmationDetails: entry.marketConfirmationDetails,
          status: entry.status,
          lastDecision: entry.status,
          reasonCodes: entry.reasonCodes,
          riskWarnings: entry.riskWarnings,
          expiresAt: entry.expiresAt,
          mentions15m: entry.mentions15m,
          mentions30m: entry.mentions30m,
          mentions60m: entry.mentions60m,
          uniqueUsers: entry.uniqueUsers,
          sourceCount: entry.sourceCount,
          topSources: entry.topSources,
          sourceProfile: entry.sourceProfile,
          sourceConfirmations: phaseA.sourceConfirmationsBySymbol?.[entry.symbol] || null,
          phaseA: phaseA.symbolsBySymbol?.[entry.symbol] || null,
          phaseB: phaseB.symbolsBySymbol?.[entry.symbol] || null,
          threadCount: entry.threadCount,
          commentCount: entry.commentCount,
          engagementScore: entry.engagementScore,
          freshnessScore: entry.freshnessScore,
          mentionVelocity: entry.mentionVelocity,
          spamConcentration: entry.spamConcentration,
          priorityOverrideEligible: false,
          rotationEligible: false,
          sources: formatSourceContributors(entry.sourceProfile),
        });
      }
      if (entry.status === 'hot_hot') {
        hotHotList.push({
          symbol: entry.symbol,
          memeHeatScore: entry.memeHeatScore,
          marketConfirmationScore: entry.marketConfirmationScore,
          marketConfirmationDetails: entry.marketConfirmationDetails,
          status: 'hot_hot',
          priorityOverrideEligible: false,
          rotationEligible: false,
          sources: formatSourceContributors(entry.sourceProfile),
          sourceConfirmations: phaseA.sourceConfirmationsBySymbol?.[entry.symbol] || null,
          phaseB: phaseB.symbolsBySymbol?.[entry.symbol] || null,
          reasonCodes: entry.reasonCodes,
          riskWarnings: entry.riskWarnings,
          expiresAt: entry.expiresAt,
          lastDecision: entry.status,
        });
      }
    }

    const previousHotList = loadDynamicHotList({ dataDir, filePath: hotListPath }) || {};
    const expiredList = [
      ...(Array.isArray(previousHotList.expired) ? previousHotList.expired : []),
      ...expired,
    ];
    const hotListMode = hotListEnabled
      ? (dynamicWatchlistEnabled ? 'active' : 'shadow')
      : 'off';
    const hotListPayload = saveDynamicHotList({
      generatedAt,
      lastScoredAt: generatedAt,
      mode: hotListMode,
      source: 'meme-monitor',
      enabled: hotListEnabled,
      status: hotListEnabled ? (dynamicWatchlistEnabled ? 'active' : 'shadow') : 'off',
      stale: false,
      dynamicHotList,
      hotHotList,
      expired: expiredList,
      rejected: rejected.map((item) => ({
        token: item.token || item.symbol || item.text || 'unknown',
        reason: item.reason || 'unknown',
      })),
    }, { dataDir, filePath: hotListPath, env, now: generatedAt });

    const hotListStatus = buildHotListStatus(hotListPayload, {
      enabled: hotListEnabled,
      hotHotEnabled: hotListEnabled,
      lastError: null,
    });
    const statusPayload = buildStatus({
      enabled: true,
      status: hotListEnabled ? 'shadow' : 'off',
      sources: collectorResult.sources || sourceConfig.sourceDefinitions,
      lastError: null,
      lastRunAt: generatedAt,
      symbolsDetected: mentions.length,
      rejectedTokens: rejected.length,
      mode: currentMode,
      phaseA: phaseA.phaseA || null,
      phaseB: phaseB.phaseB || null,
      hotList: hotListStatus,
      hotHotScoring: {
        enabled: Boolean(hotListEnabled && dynamicWatchlistEnabled),
        status: hotListEnabled && dynamicWatchlistEnabled ? 'active' : 'off',
        lastScoredAt: generatedAt,
        lastError: null,
        stale: false,
      },
    });
    saveMemeMonitorStatus(statusPayload, { dataDir, filePath: statusPath });
    state.lastError = null;
    state.lastRunAt = generatedAt;
    return statusPayload;
  }

function buildStatus({ enabled, status, sources, lastError, lastRunAt, symbolsDetected, rejectedTokens, mode, phaseA = null, phaseB = null, hotList = null, hotHotScoring = null }) {
    const now = nowIso();
    return {
      version: '2026-06-30.meme-monitor-status.1',
      updated_at: now,
      enabled: Boolean(enabled),
      redditScanner: {
        enabled: Boolean(enabled),
        status: String(status || 'off'),
        lastRunAt: lastRunAt || state.lastRunAt || null,
        lastError: lastError || state.lastError || null,
        sources: Array.isArray(sources) ? sources.slice() : [],
        symbolsDetected: Number(symbolsDetected || 0),
        rejectedTokens: Number(rejectedTokens || 0),
        mode: mode || 'shadow',
      },
      hotList: hotList || {
        enabled: Boolean(enabled),
        status: String(status || 'off'),
        dynamicCount: 0,
        hotHotCount: 0,
        lastScoredAt: lastRunAt || null,
        stale: true,
        lastError: lastError || null,
      },
      hotHotScoring: hotHotScoring || {
        enabled: Boolean(enabled),
        status: String(status || 'off'),
        lastScoredAt: lastRunAt || null,
        lastError: lastError || null,
        stale: true,
      },
      phaseA: phaseA || {
        enabled: false,
        status: 'off',
        lastRunAt: lastRunAt || null,
        lastError: lastError || null,
        sources: {},
        symbols: [],
      },
      phaseB: phaseB || {
        enabled: false,
        status: 'off',
        lastRunAt: lastRunAt || null,
        lastError: lastError || null,
        sources: {},
        symbols: [],
      },
    };
  }

  function buildHotListStatus(hotListPayload = {}, options = {}) {
    return {
      enabled: Boolean(options.enabled),
      status: String(hotListPayload.status || 'off'),
      dynamicCount: Array.isArray(hotListPayload.dynamicHotList) ? hotListPayload.dynamicHotList.length : 0,
      hotHotCount: Array.isArray(hotListPayload.hotHotList) ? hotListPayload.hotHotList.length : 0,
      lastScoredAt: hotListPayload.lastScoredAt || hotListPayload.generatedAt || null,
      stale: Boolean(hotListPayload.stale),
      lastError: options.lastError || null,
    };
  }

  function persistIdleState({
    statusPath,
    hotListPath,
    enabled,
    mode,
    sources,
    lastError,
    status = 'off',
    symbolsDetected = 0,
    rejectedTokens = 0,
    hotListEnabled = false,
    dynamicWatchlistEnabled = false,
  }) {
    const generatedAt = nowIso();
    const idleHotList = saveDynamicHotList({
      generatedAt,
      lastScoredAt: null,
      mode: 'off',
      source: 'meme-monitor',
      enabled: Boolean(hotListEnabled),
      status: 'off',
      stale: true,
      dynamicHotList: [],
      hotHotList: [],
      expired: [],
      rejected: [],
      summary: {
        dynamicCount: 0,
        hotHotCount: 0,
        expiredCount: 0,
      },
    }, { dataDir, filePath: hotListPath, env, now: generatedAt });
    const payload = buildStatus({
      enabled,
      status,
      sources,
      lastError,
      lastRunAt: null,
      symbolsDetected,
      rejectedTokens,
      mode,
      phaseA: loadMemeMonitorStatus({ dataDir, filePath: statusPath })?.phaseA || null,
      phaseB: loadMemeMonitorStatus({ dataDir, filePath: statusPath })?.phaseB || null,
      hotList: buildHotListStatus(idleHotList, { enabled: Boolean(hotListEnabled), lastError }),
      hotHotScoring: {
        enabled: Boolean(hotListEnabled) && Boolean(dynamicWatchlistEnabled),
        status: 'off',
        lastScoredAt: null,
        lastError,
        stale: true,
      },
    });
    saveMemeMonitorStatus(payload, { dataDir, filePath: statusPath });
    state.lastError = lastError || null;
    state.lastRunAt = null;
    return payload;
  }

  async function clearExpiredHotSymbols() {
    const statusPath = resolveMemeMonitorStatusPath({ dataDir, filePath: options.statusPath });
    const hotListPath = resolveDynamicHotListPath({ dataDir, filePath: options.hotListPath });
    const current = loadDynamicHotList({ dataDir, filePath: hotListPath }) || {};
    const sourceConfig = resolveMemeSocialSourceConfig(env);
    const currentMode = resolveMemeScoreMode({
      masterEnabled: true,
      redditScannerEnabled: true,
      hotListEnabled: true,
      dynamicWatchlistEnabled: true,
    });
    const now = Date.now();
    const activeDynamic = (Array.isArray(current.dynamicHotList) ? current.dynamicHotList : Array.isArray(current.symbols) ? current.symbols : [])
      .filter((entry) => !isExpired(entry, now));
    const activeHotHot = (Array.isArray(current.hotHotList) ? current.hotHotList : [])
      .filter((entry) => !isExpired(entry, now));
    const expired = [
      ...(Array.isArray(current.expired) ? current.expired : []),
      ...(Array.isArray(current.dynamicHotList) ? current.dynamicHotList : [])
        .filter((entry) => isExpired(entry, now))
        .map((entry) => ({ ...entry, expired: true })),
      ...(Array.isArray(current.hotHotList) ? current.hotHotList : [])
        .filter((entry) => isExpired(entry, now))
        .map((entry) => ({ ...entry, expired: true })),
    ];
    const next = saveDynamicHotList({
      ...current,
      dynamicHotList: activeDynamic,
      hotHotList: activeHotHot,
      expired,
      stale: false,
      status: current.status || 'shadow',
      lastScoredAt: current.lastScoredAt || current.generatedAt || null,
    }, { dataDir, filePath: hotListPath, env });
    const statusPayload = buildStatus({
      enabled: true,
      status: current.status || 'shadow',
      sources: sourceConfig.sourceDefinitions,
      lastRunAt: next.lastScoredAt || next.generatedAt || null,
      symbolsDetected: activeDynamic.length,
      rejectedTokens: Array.isArray(current.rejected) ? current.rejected.length : 0,
      mode: currentMode,
      phaseA: sourceConfig.sourceDefinitions ? loadMemeMonitorStatus({ dataDir, filePath: statusPath })?.phaseA || null : null,
      phaseB: loadMemeMonitorStatus({ dataDir, filePath: statusPath })?.phaseB || null,
      hotList: buildHotListStatus(next, { enabled: true }),
      hotHotScoring: {
        enabled: true,
        status: 'active',
        lastScoredAt: next.lastScoredAt || next.generatedAt || null,
        lastError: null,
        stale: false,
      },
    });
    saveMemeMonitorStatus(statusPayload, { dataDir, filePath: statusPath });
    return statusPayload;
  }

  async function resetScores() {
    const statusPath = resolveMemeMonitorStatusPath({ dataDir, filePath: options.statusPath });
    const hotListPath = resolveDynamicHotListPath({ dataDir, filePath: options.hotListPath });
    const sourceConfig = resolveMemeSocialSourceConfig(env);
    const resetPayload = saveDynamicHotList({
      generatedAt: nowIso(),
      lastScoredAt: null,
      mode: 'off',
      source: 'meme-monitor',
      enabled: false,
      status: 'off',
      stale: true,
      dynamicHotList: [],
      hotHotList: [],
      expired: [],
      rejected: [],
    }, { dataDir, filePath: hotListPath, env });
    const statusPayload = buildStatus({
      enabled: true,
      status: 'off',
      sources: sourceConfig.sourceDefinitions,
      lastRunAt: null,
      symbolsDetected: 0,
      rejectedTokens: 0,
      mode: 'off',
      phaseA: loadMemeMonitorStatus({ dataDir, filePath: statusPath })?.phaseA || null,
      phaseB: loadMemeMonitorStatus({ dataDir, filePath: statusPath })?.phaseB || null,
      hotList: buildHotListStatus(resetPayload, { enabled: false }),
      hotHotScoring: {
        enabled: false,
        status: 'off',
        lastScoredAt: null,
        lastError: null,
        stale: true,
      },
    });
    saveMemeMonitorStatus(statusPayload, { dataDir, filePath: statusPath });
    return statusPayload;
  }

  async function start() {
    const status = await refresh({ reason: 'start' });
    const canRun = status?.redditScanner?.status === 'shadow';
    state.running = canRun;
    clearTimer();
    if (canRun) {
      state.timer = setInterval(() => {
        runOnce({ reason: 'interval' }).catch((error) => {
          state.lastError = error.message;
        });
      }, refreshIntervalMs);
      if (state.timer.unref) state.timer.unref();
    }
    return status;
  }

  async function stop() {
    state.running = false;
    clearTimer();
    const current = loadMemeMonitorStatus({ dataDir, filePath: options.statusPath });
    const next = {
      ...current,
      updated_at: nowIso(),
      redditScanner: {
        ...current.redditScanner,
        status: 'off',
      },
    };
    saveMemeMonitorStatus(next, { dataDir, filePath: options.statusPath });
    return next;
  }

  async function refresh(runOptions = {}) {
    return runOnce(runOptions);
  }

  async function clearError() {
    state.lastError = null;
    const current = loadMemeMonitorStatus({ dataDir, filePath: options.statusPath });
    const next = {
      ...current,
      updated_at: nowIso(),
      redditScanner: {
        ...current.redditScanner,
        lastError: null,
      },
    };
    saveMemeMonitorStatus(next, { dataDir, filePath: options.statusPath });
    return next;
  }

  async function refreshPhaseA(runOptions = {}) {
    const featureState = loadMemeMonitorState({ env, repoRoot, filePath: options.memeMonitorStatePath });
    const sourceRuntime = resolvePhaseASourceRuntime(env, featureState);
    if (!Object.values(sourceRuntime).some(Boolean)) {
      const offPayload = {
        generatedAt: nowIso(),
        phaseA: {
          enabled: false,
          status: 'off',
          sources: {
            reddit: { enabled: false, available: false, status: 'off' },
            alpacaMarket: { enabled: false, available: false, status: 'off' },
            alpacaAssets: { enabled: false, available: false, status: 'off' },
            nasdaqHalts: { enabled: false, available: false, status: 'off' },
            secEdgar: { enabled: false, available: false, status: 'off' },
          },
          symbols: [],
        },
        symbols: [],
        sources: {
          reddit: { enabled: false, available: false, status: 'off' },
          alpacaMarket: { enabled: false, available: false, status: 'off' },
          alpacaAssets: { enabled: false, available: false, status: 'off' },
          nasdaqHalts: { enabled: false, available: false, status: 'off' },
          secEdgar: { enabled: false, available: false, status: 'off' },
        },
        marketContextBySymbol: {},
        sourceConfirmationsBySymbol: {},
        symbolsBySymbol: {},
      };
      saveMemeMonitorStatus({
        ...(loadMemeMonitorStatus({ dataDir, filePath: options.statusPath }) || {}),
        phaseA: offPayload.phaseA,
      }, { dataDir, filePath: options.statusPath });
      return offPayload;
    }
    const result = await runPhaseASources({
      env,
      fetchImpl: options.fetchImpl,
      repoRoot,
      dataDir,
      runtimeState: featureState,
      records: runOptions.records || [],
      mentions: runOptions.mentions || [],
      candidateSymbols: runOptions.candidateSymbols || [],
    });
    saveMemeMonitorStatus({
      ...(loadMemeMonitorStatus({ dataDir, filePath: options.statusPath }) || {}),
      phaseA: result.phaseA || {
        enabled: true,
        status: 'active',
        sources: result.sources || {},
        symbols: result.symbols || [],
        lastRunAt: result.generatedAt || nowIso(),
      },
    }, { dataDir, filePath: options.statusPath });
    return result;
  }

  async function refreshPhaseB(runOptions = {}) {
    const featureState = loadMemeMonitorState({ env, repoRoot, filePath: options.memeMonitorStatePath });
    const sourceRuntime = resolvePhaseBSourceRuntime(env, featureState);
    if (!Object.values(sourceRuntime).some(Boolean)) {
      const offPayload = {
        generatedAt: nowIso(),
        phaseB: {
          enabled: false,
          status: 'off',
          sources: {
            stocktwits: { enabled: false, available: false, status: 'off' },
            polygon: { enabled: false, available: false, status: 'off' },
            alphaVantage: { enabled: false, available: false, status: 'off' },
          },
          symbols: [],
        },
        symbols: [],
        sources: {
          stocktwits: { enabled: false, available: false, status: 'off' },
          polygon: { enabled: false, available: false, status: 'off' },
          alphaVantage: { enabled: false, available: false, status: 'off' },
        },
        symbolsBySymbol: {},
        sourceConfirmationsBySymbol: {},
      };
      saveMemeMonitorStatus({
        ...(loadMemeMonitorStatus({ dataDir, filePath: options.statusPath }) || {}),
        phaseB: offPayload.phaseB,
      }, { dataDir, filePath: options.statusPath });
      return offPayload;
    }
    const result = await runPhaseBSources({
      env,
      fetchImpl: options.fetchImpl,
      repoRoot,
      dataDir,
      runtimeState: featureState,
      candidateSymbols: runOptions.candidateSymbols || loadMemeMonitorStatus({ dataDir, filePath: options.statusPath })?.phaseA?.symbols || [],
      phaseASymbolsBySymbol: runOptions.phaseASymbolsBySymbol || {},
    });
    saveMemeMonitorStatus({
      ...(loadMemeMonitorStatus({ dataDir, filePath: options.statusPath }) || {}),
      phaseB: result.phaseB || {
        enabled: true,
        status: 'active',
        sources: result.sources || {},
        symbols: result.symbols || [],
        lastRunAt: result.generatedAt || nowIso(),
      },
    }, { dataDir, filePath: options.statusPath });
    return result;
  }

  function getStatus() {
    return loadMemeMonitorStatus({ dataDir, filePath: options.statusPath });
  }

  function clearTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  return {
    start,
    stop,
    refresh,
    clearExpiredHotSymbols,
    clearError,
    resetScores,
    refreshPhaseA,
    refreshPhaseB,
    getStatus,
    getState: getStatus,
    isRunning: () => state.running,
  };
}

function formatSourceContributors(sourceProfile = null) {
  const contributors = Array.isArray(sourceProfile?.sources) ? sourceProfile.sources : [];
  return contributors.map((entry) => {
    const tier = entry?.tier ? ` (${entry.tier})` : '';
    return `${formatSourceName(entry?.source)}${tier}`;
  });
}

function formatSourceName(value) {
  const source = String(value || 'reddit').trim();
  return source.startsWith('reddit:') ? source.slice(7) : source;
}

async function resolveMarketContextBySymbol({ marketDataProvider = null, marketContextBySymbol = null, hotHotList = [], runOptions = {} } = {}) {
  const lookup = new Map();
  if (marketContextBySymbol && typeof marketContextBySymbol === 'object') {
    for (const [symbol, value] of Object.entries(marketContextBySymbol)) {
      lookup.set(String(symbol).toUpperCase(), value);
    }
  }
  if (typeof marketDataProvider === 'function') {
    for (const entry of hotHotList) {
      const symbol = String(entry.symbol || '').toUpperCase();
      if (!symbol || lookup.has(symbol)) continue;
      try {
        const result = await marketDataProvider(symbol, { hotHotList, runOptions });
        if (result) lookup.set(symbol, result);
      } catch (error) {
        lookup.set(symbol, { error: error.message, stale: true });
      }
    }
  }
  return lookup;
}

function unionReasonCodes(...groups) {
  const values = [];
  for (const group of groups) {
    if (!group) continue;
    for (const item of group) {
      if (item === undefined || item === null || item === '') continue;
      values.push(String(item));
    }
  }
  return [...new Set(values)];
}

function isExpired(entry, nowMs = Date.now()) {
  const expiresAt = entry?.expiresAt || entry?.expires_at || null;
  if (!expiresAt) return false;
  const parsed = new Date(expiresAt).getTime();
  if (!Number.isFinite(parsed)) return false;
  return parsed <= nowMs;
}

module.exports = {
  createMemeMonitorLoop,
};
