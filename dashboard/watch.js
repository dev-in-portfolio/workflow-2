const state = {
  snapshot: null,
  error: null,
};

const $ = (id) => document.getElementById(id);
const dashboardRequest = createDashboardRequest();
const bootstrapSnapshot = getDashboardSnapshotForPage('watch');

if (bootstrapSnapshot) {
  state.snapshot = bootstrapSnapshot;
  state.error = null;
}

function createDashboardRequest() {
  if (typeof fetch !== 'function' && typeof XMLHttpRequest === 'undefined') {
    return null;
  }
  return async function request(url, options = {}) {
    if (typeof fetch === 'function') {
      return fetch(url, options);
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(options.method || 'GET', url, true);
      if (options.headers) {
        for (const [key, value] of Object.entries(options.headers)) {
          xhr.setRequestHeader(key, value);
        }
      }
      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) return;
        resolve({
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status || 0,
          async json() {
            return JSON.parse(xhr.responseText || 'null');
          },
          async text() {
            return xhr.responseText || '';
          },
        });
      };
      xhr.onerror = () => reject(new Error(`Request failed for ${url}`));
      xhr.send(options.body || null);
    });
  };
}

async function refreshSnapshot() {
  if (!dashboardRequest) {
    if (state.snapshot) {
      render(state.snapshot);
    }
    return;
  }
  try {
    const response = await dashboardRequest('/api/watch-snapshot', { cache: 'no-store' });
    const snapshot = await response.json();
    if (!response.ok) {
      throw new Error(snapshot?.message || snapshot?.error || `HTTP ${response.status}`);
    }
    state.snapshot = snapshot;
    state.error = null;
    render(snapshot);
  } catch (error) {
    state.error = error.message;
    render(state.snapshot || bootstrapSnapshot || {});
  }
}

function render(snapshot) {
  const watch = snapshot?.watch || {};
  const live = snapshot?.live || {};
  const memeState = live?.meme_monitor_state || {};
  const regularWatchList = Array.isArray(watch.regularWatchList) ? watch.regularWatchList : [];
  const regularWatchMovers = Array.isArray(watch.regularWatchMovers) ? watch.regularWatchMovers : [];
  const dynamicHotList = Array.isArray(watch.dynamicHotList?.symbols) ? watch.dynamicHotList.symbols : [];
  const hotHotList = Array.isArray(watch.hotHotList?.symbols) ? watch.hotHotList.symbols : [];
  const memeMonitor = watch.memeMonitor || {};
  const regularWatchIntelligence = watch.regularWatchIntelligence || snapshot?.regularWatchIntelligence || {};
  const scannerPreview = watch.scannerPreview || regularWatchIntelligence?.scannerPreview || snapshot?.scannerPreview || {};
  const hotSlotRotation = watch.hotSlotRotation || memeMonitor?.hotSlotRotation || {};
  const featureRows = Array.isArray(watch.actionsState) && watch.actionsState.length
    ? watch.actionsState
    : buildFeatureRows(memeState, regularWatchIntelligence);

  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('watchStateValue').textContent = resolveWatchState(watch);
  $('watchPill').textContent = resolveWatchPill(watch, state.error);
  $('watchPill').className = `pill ${resolveWatchPillTone(watch, state.error)}`;
  $('watchSummary').textContent = buildSummaryLine(snapshot, watch, scannerPreview, featureRows, state.error);
  $('watchRegularCount').textContent = formatCount(regularWatchList.length);
  $('watchMoverCount').textContent = formatCount(regularWatchMovers.length);
  $('watchDynamicCount').textContent = formatCount(dynamicHotList.length);
  $('watchHotHotCount').textContent = formatCount(hotHotList.length);
  $('regularWatchMeta').textContent = `Approved symbols: ${formatCount(regularWatchList.length)}`;
  $('regularWatchMoversMeta').textContent = regularWatchMovers.length ? 'Sorted by opportunity score' : 'No movement data';
  $('dynamicHotListMeta').textContent = resolveColumnMeta(watch.dynamicHotList, 'Dynamic hot list');
  $('hotHotListMeta').textContent = `${resolveColumnMeta(watch.hotHotList, 'Hot hot list')} | rotation ${formatHotSlotRotationStatus(hotSlotRotation)}`;
  $('watchFeatureRail').innerHTML = featureRows.map(([label, status]) => renderFeatureChip(label, status)).join('');

  renderRegularWatchList(regularWatchList);
  renderMovers(regularWatchMovers, snapshot);
  renderDynamicHotList(watch.dynamicHotList, dynamicHotList, regularWatchList, hotSlotRotation);
  renderHotHotList(watch.hotHotList, hotHotList, hotSlotRotation);
  if ($('watchSummary') && memeMonitor?.priorityOverride?.effective) {
    $('watchSummary').textContent += ` Priority override is active and still subject to risk checks.`;
  }
  if ($('watchSummary') && hotSlotRotation?.enabled) {
    $('watchSummary').textContent += ` Hot slot rotation: ${formatHotSlotRotationStatus(hotSlotRotation)} (${hotSlotRotation.lastDecision || 'none'}).`;
  }
}

function buildSummaryLine(snapshot, watch, scannerPreview, featureRows, error) {
  if (error) {
    return `Snapshot error: ${error}`;
  }
  const regularWatchStatus = String(watch.regularWatchIntelligence?.status || 'off').toUpperCase();
  const memeMonitorStatus = String(watch.memeMonitor?.dynamicWatchlist?.status || watch.memeMonitor?.priorityOverride?.status || watch.memeMonitor?.hotSlotRotation?.status || 'off').toUpperCase();
  const hotSlotRotationStatus = formatHotSlotRotationStatus(watch.hotSlotRotation || watch.memeMonitor?.hotSlotRotation || {});
  const lastScanAt = watch.regularWatchIntelligence?.lastRunAt || watch.regularWatchIntelligence?.generatedAt || snapshot?.timestamp || null;
  const sourceWarnings = [
    watch.regularWatchIntelligence?.lastError ? `Regular Watch: ${watch.regularWatchIntelligence.lastError}` : null,
    watch.dynamicHotList?.lastError ? `Dynamic Hot List: ${watch.dynamicHotList.lastError}` : null,
    watch.hotHotList?.lastError ? `Hot Hot List: ${watch.hotHotList.lastError}` : null,
  ].filter(Boolean);
  const statusText = `${formatCount(watch.regularWatchList?.length || 0)} approved symbols, ${formatCount(watch.regularWatchMovers?.length || 0)} movers, ${formatCount(watch.dynamicHotList?.symbols?.length || 0)} dynamic alerts, ${formatCount(watch.hotHotList?.symbols?.length || 0)} hot hot symbols.`;
  const scannerSource = watch.scannerSource || {};
  const featureText = featureRows.map(([label, status]) => `${label}: ${String(status || 'off').toUpperCase()}`).join(' | ');
  const summaryBits = [
    `Regular Watch ${regularWatchStatus}`,
    `Meme Monitor ${memeMonitorStatus}`,
    `Hot Slot Rotation ${hotSlotRotationStatus}`,
    `Scanner Source ${String(scannerSource.mode || 'approved').toUpperCase()}${scannerSource.dynamicSourceEmpty ? ' (dynamic source empty)' : ''}`,
    `Scanner Source Counts approved ${formatCount(scannerSource.approvedSourceCount || 0)}, regular watch ${formatCount(scannerSource.regularWatchSourceCount || 0)}, movers ${formatCount(scannerSource.regularWatchMoversSourceCount || 0)}, dynamic hot ${formatCount(scannerSource.dynamicHotSourceCount || 0)}, hot hot ${formatCount(scannerSource.hotHotSourceCount || 0)}`,
    `Last scan ${formatClock(lastScanAt)}`,
    `Source warnings ${sourceWarnings.length ? sourceWarnings.join(' | ') : 'none'}`,
  ];
  const previewText = scannerPreview?.previewCandidateCount
    ? `Scanner preview ${formatCount(scannerPreview.previewCandidateCount)} candidate${scannerPreview.previewCandidateCount === 1 ? '' : 's'} while market closed${Array.isArray(scannerPreview.topPreviewCandidates) && scannerPreview.topPreviewCandidates.length ? `; top symbols ${scannerPreview.topPreviewCandidates.slice(0, 3).map((entry) => `${entry?.symbol}${entry?.source_list ? ` (${entry.source_list})` : ''}`).filter(Boolean).join(', ')}` : ''}.`
    : null;
  const waitingText = scannerPreview?.waitingForBuy?.message
    ? ` Waiting on: ${scannerPreview.waitingForBuy.message}${scannerPreview.waitingForBuy.candidate_symbol ? ` Top symbol ${scannerPreview.waitingForBuy.candidate_symbol}.` : ''}`
    : '';
  const brokerTruthText = scannerPreview?.brokerTruth?.freshness
    ? ` Broker truth ${String(scannerPreview.brokerTruth.freshness).replace(/_/g, ' ')}.`
    : '';
  return `${statusText} ${summaryBits.join(' | ')}.${previewText ? ` ${previewText}` : ''}${waitingText}${brokerTruthText} Actions tab state: ${featureText}.`;
}

function renderRegularWatchList(items) {
  renderList('regularWatchList', items, 'No approved watch symbols are available yet.', (item) => `
    <article class="watch-card">
      <div class="watch-card-top">
        <strong><code>${escapeHtml(item.symbol || '-')}</code></strong>
        <span class="tag ${watchTone(item.status)}">${escapeHtml(String(item.status || 'stale').toUpperCase())}</span>
      </div>
      <div class="watch-card-grid">
        <span><b>Last price</b> ${escapeHtml(formatCurrency(item.lastPrice ?? item.currentPrice))}</span>
        <span><b>Daily move</b> ${escapeHtml(formatSignedPercent(item.dailyMovePct ?? item.movePct))}</span>
        <span><b>Volume</b> ${escapeHtml(formatCount(item.volume))}</span>
        <span><b>Spread</b> ${escapeHtml(formatPercent(item.spread ?? item.spreadPct))}</span>
        <span><b>Tradable</b> ${escapeHtml(item.tradableStatus || 'unknown')}</span>
        <span><b>Halt status</b> ${escapeHtml(item.haltStatus || 'unknown')}</span>
        <span><b>Market data</b> ${escapeHtml(item.marketDataState || 'unknown')}</span>
        <span><b>Displayed rank</b> ${escapeHtml(formatNumber(item.displayedRankScore ?? item.scannerScore ?? item.regularWatchScore ?? item.score))}</span>
        <span><b>Execution score</b> ${Number.isFinite(Number(item.scannerScore)) ? escapeHtml(formatNumber(item.scannerScore)) : 'Not qualified yet'}</span>
        <span><b>Discovery score</b> ${escapeHtml(formatNumber(item.regularWatchScore ?? item.candidateComparison?.regularWatchScore))}</span>
        <span><b>Execution status</b> ${escapeHtml(item.executionStatus || 'watching')}</span>
        <span><b>Comparison</b> ${escapeHtml(formatCandidateComparison(item.candidateComparison))}</span>
        <span><b>Sources</b> ${escapeHtml(formatSources(item.sourceStatus || item.sourceDetails || item.sourceContributors || item.sources))}</span>
        <span><b>Position</b> ${escapeHtml(item.positionStatus || formatTagList(item.positionTags))}</span>
        <span><b>Position tags</b> ${escapeHtml(formatTagList(item.positionTags))}</span>
        <span><b>Waiting on</b> ${escapeHtml(item.waitingReason || item.reason || (Array.isArray(item.reasonCodes) ? item.reasonCodes.join(', ') : 'none'))}</span>
        <span><b>Risk</b> ${escapeHtml(formatReasonList(item.riskWarnings || item.reasonCodes))}</span>
      </div>
    </article>
  `);
}

function renderMovers(items, snapshot) {
  const hasData = Array.isArray(items) && items.length > 0;
  renderList('regularWatchMovers', items, hasData
    ? 'No movement data found for the approved symbols.'
    : 'Movement data is stale or unavailable for the approved list.', (item) => `
    <article class="watch-card watch-card-moving">
      <div class="watch-card-top">
        <strong><code>${escapeHtml(item.symbol || '-')}</code></strong>
        <span class="tag ${watchTone(item.status)}">${escapeHtml(String(item.status || 'moving').toUpperCase())}</span>
      </div>
      <div class="watch-card-grid">
        <span><b>Move</b> ${escapeHtml(formatSignedPercent(item.dailyMovePct ?? item.movePct))}</span>
        <span><b>Volume multiple</b> ${escapeHtml(formatNumber(item.volumeMultiple))}</span>
        <span><b>Spread</b> ${escapeHtml(formatPercent(item.spread ?? item.spreadPct))}</span>
        <span><b>Displayed rank</b> ${escapeHtml(formatNumber(item.displayedRankScore ?? item.scannerScore ?? item.regularWatchScore ?? item.score))}</span>
        <span><b>Execution score</b> ${Number.isFinite(Number(item.scannerScore)) ? escapeHtml(formatNumber(item.scannerScore)) : 'Not qualified yet'}</span>
        <span><b>Discovery score</b> ${escapeHtml(formatNumber(item.regularWatchScore ?? item.candidateComparison?.regularWatchScore))}</span>
        <span><b>Execution status</b> ${escapeHtml(item.executionStatus || 'watching')}</span>
        <span><b>Comparison</b> ${escapeHtml(formatCandidateComparison(item.candidateComparison))}</span>
        <span><b>Sources</b> ${escapeHtml(formatSources(item.sourceStatus || item.sourceDetails || item.sourceContributors || item.sources))}</span>
        <span><b>Position</b> ${escapeHtml(item.positionStatus || formatTagList(item.positionTags))}</span>
        <span><b>Position tags</b> ${escapeHtml(formatTagList(item.positionTags))}</span>
        <span><b>Waiting on</b> ${escapeHtml(item.waitingReason || item.status || 'moving')}</span>
        <span><b>Reason codes</b> ${escapeHtml(formatReasonList(item.reasonCodes))}</span>
        <span><b>Risk</b> ${escapeHtml(formatReasonList(item.riskWarnings || item.reasonCodes))}</span>
      </div>
    </article>
  `);
}

function renderDynamicHotList(section, items, regularWatchList, hotSlotRotation) {
  if (!section || section.status === 'disabled' || section.enabled === false) {
    $('dynamicHotList').innerHTML = `
      <div class="empty-state">
        Dynamic Hot List From Alerts: disabled.
        Enable Meme Monitor / Hot List from Actions tab to view alert-generated symbols.
      </div>
    `;
    return;
  }
  if (section.stale) {
    renderList('dynamicHotList', items, 'Dynamic hot list data is stale.', renderDynamicHotCard);
    return;
  }
  renderList('dynamicHotList', items, 'No alert-driven symbols are available yet.', renderDynamicHotCard);

  function renderDynamicHotCard(item) {
    return `
      <article class="watch-card watch-card-alert">
        <div class="watch-card-top">
          <strong><code>${escapeHtml(item.symbol || '-')}</code></strong>
          <span class="tag ${watchTone(item.status)}">${escapeHtml(String(item.status || 'shadow').toUpperCase())}</span>
        </div>
        <div class="watch-card-grid">
          <span><b>Meme heat</b> ${escapeHtml(formatNumber(item.memeHeatScore))}</span>
          <span><b>Mentions 15m</b> ${escapeHtml(formatCount(item.mentions15m))}</span>
          <span><b>Mentions 30m/60m</b> ${escapeHtml(formatCount(item.mentions30m ?? item.mentions60m))}</span>
          <span><b>Unique users</b> ${escapeHtml(formatCount(item.uniqueUsers))}</span>
          <span><b>Contributing sources</b> ${escapeHtml(formatSources(item.sources))}</span>
          <span><b>Phase A status</b> ${escapeHtml(formatSourceConfirmations(item.sourceConfirmations))}</span>
          <span><b>Phase B</b> ${escapeHtml(formatPhaseBSummary(item.phaseB))}</span>
          <span><b>Freshness</b> ${escapeHtml(formatFreshness(item.freshness, item.lastDecision))}</span>
          <span><b>Scanner watched</b> ${escapeHtml(item.scannerWatched ? 'yes' : 'no')}</span>
          <span><b>Dynamic watchlist reason</b> ${escapeHtml(item.watchlistReason || formatReasonList(item.reasonCodes))}</span>
          <span><b>Rejected/block reason</b> ${escapeHtml(item.rejectedBlockReason || item.priorityOverrideBlockReason || 'none')}</span>
          <span><b>Status</b> ${escapeHtml(item.status || 'shadow')}</span>
          <span><b>Expires at</b> ${escapeHtml(formatClock(item.expiresAt))}</span>
          <span><b>Reason codes</b> ${escapeHtml(formatReasonList(item.reasonCodes))}</span>
        </div>
      </article>
    `;
  }
}

function renderHotHotList(section, items, hotSlotRotation) {
  if (!section || section.status === 'disabled' || section.enabled === false) {
    $('hotHotList').innerHTML = `
      <div class="empty-state">
        Hot Hot List: disabled.
        Enable Hot List and Hot Hot scoring from Actions tab to view confirmed symbols.
      </div>
    `;
    return;
  }
  if (section.stale) {
    renderList('hotHotList', items, 'Hot hot list data is stale.', renderHotHotCard);
    return;
  }
  renderList('hotHotList', items, 'No hot hot symbols are available yet.', renderHotHotCard);

  function renderHotHotCard(item) {
    return `
      <article class="watch-card watch-card-hot">
        <div class="watch-card-top">
          <strong><code>${escapeHtml(item.symbol || '-')}</code></strong>
          <span class="tag ${watchTone(item.lastDecision || item.status)}">${escapeHtml(String(item.lastDecision || item.status || 'hot_hot').toUpperCase())}</span>
        </div>
        <div class="watch-card-grid">
          <span><b>Meme heat</b> ${escapeHtml(formatNumber(item.memeHeatScore))}</span>
          <span><b>Market confirmation</b> ${escapeHtml(formatNumber(item.marketConfirmationScore))}</span>
          <span><b>Move</b> ${escapeHtml(formatSignedPercent(item.movePct))}</span>
          <span><b>Volume multiple</b> ${escapeHtml(formatNumber(item.volumeMultiple))}</span>
          <span><b>Spread</b> ${escapeHtml(formatPercent(item.spread))}</span>
          <span><b>Tradable status</b> ${escapeHtml(item.tradableStatus || 'unknown')}</span>
          <span><b>Contributing sources</b> ${escapeHtml(formatSources(item.sources))}</span>
          <span><b>Phase A status</b> ${escapeHtml(formatSourceConfirmations(item.sourceConfirmations))}</span>
          <span><b>Final Meme Score</b> ${escapeHtml(formatNumber(item.phaseB?.finalMemeScore ?? item.finalMemeScore))}</span>
          <span><b>Social Confirmation</b> ${escapeHtml(formatProviderScore(item.phaseB?.socialConfirmation || item.socialConfirmation))}</span>
          <span><b>Market Confirmation</b> ${escapeHtml(formatProviderScore(item.phaseB?.marketConfirmation || item.marketConfirmation))}</span>
          <span><b>Risk Confirmation</b> ${escapeHtml(formatRiskConfirmation(item.phaseB?.riskConfirmation || item.riskConfirmation))}</span>
          <span><b>Cross-source Confirmation</b> ${escapeHtml((item.phaseB?.crossSourceConfirmation ?? item.crossSourceConfirmation) ? 'yes' : 'no')}</span>
          <span><b>Phase B Confirmation</b> ${escapeHtml((item.phaseB?.phaseBConfirmation ?? item.phaseB?.crossSourceConfirmation ?? item.phaseBConfirmation) ? 'yes' : 'no')}</span>
          <span><b>Borderline Upgrade</b> ${escapeHtml((item.phaseB?.borderlineUpgrade ?? item.borderlineUpgrade) ? 'yes' : 'no')}</span>
          <span><b>Priority override eligible</b> ${escapeHtml(item.priorityOverrideEligible ? 'yes' : 'no')}</span>
          <span><b>Priority override applied</b> ${escapeHtml(item.priorityOverrideApplied ? 'yes' : 'no')}</span>
          <span><b>Priority override block reason</b> ${escapeHtml(item.priorityOverrideBlockReason || 'none')}</span>
          <span><b>Rotation eligible</b> ${escapeHtml(item.rotationEligible ? 'yes' : 'no')}</span>
          <span><b>Eviction candidate</b> ${escapeHtml(item.evictionCandidate || 'none')}</span>
          <span><b>Eviction reason</b> ${escapeHtml(item.evictionReason || 'none')}</span>
          <span><b>Rotation block reason</b> ${escapeHtml(item.rotationBlockReason || 'none')}</span>
          <span><b>Last rotation decision</b> ${escapeHtml(item.lastRotationDecision || hotSlotRotation?.lastDecision || 'none')}</span>
          <span><b>Last rotation time</b> ${escapeHtml(formatClock(item.lastRotationTime || hotSlotRotation?.lastDecisionAt || null))}</span>
          <span><b>Risk warnings</b> ${escapeHtml(formatReasonList(item.riskWarnings))}</span>
          <span><b>Reason codes</b> ${escapeHtml(formatReasonList(item.reasonCodes))}</span>
          <span><b>Expires at</b> ${escapeHtml(formatClock(item.expiresAt))}</span>
          <span><b>Last decision</b> ${escapeHtml(item.lastDecision || 'hot_hot')}</span>
        </div>
      </article>
    `;
  }
}

function renderList(targetId, items, emptyMessage, renderer) {
  const target = $(targetId);
  if (!target) return;
  if (!Array.isArray(items) || !items.length) {
    target.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  target.innerHTML = items.map((item) => renderer(item)).join('');
}

function buildFeatureRows(memeState, regularWatchIntelligence) {
  const features = memeState?.features || {};
  const regularWatchFeatures = regularWatchIntelligence?.featureState?.features || regularWatchIntelligence?.featureState || {};
  return [
    ['Meme Monitor', features.MEME_MONITOR_ENABLED?.status || 'off'],
    ['Reddit Scanner', features.MEME_REDDIT_SCANNER_ENABLED?.status || 'off'],
    ['Hot List', features.MEME_HOT_LIST_ENABLED?.status || 'off'],
    ['Dynamic Watchlist', features.MEME_DYNAMIC_WATCHLIST_ENABLED?.status || 'off'],
    ['Priority Override', features.MEME_PRIORITY_OVERRIDE_ENABLED?.status || 'off'],
    ['Hot Slot Rotation', features.MEME_HOT_SLOT_ROTATION_ENABLED?.status || 'off'],
    ['Reddit API', features.MEME_SOURCE_REDDIT_ENABLED?.status || 'off'],
    ['Alpaca Market', features.MEME_SOURCE_ALPACA_MARKET_ENABLED?.status || 'off'],
    ['Alpaca Tradability', features.MEME_SOURCE_ALPACA_ASSETS_ENABLED?.status || 'off'],
    ['Nasdaq Halts', features.MEME_SOURCE_NASDAQ_HALTS_ENABLED?.status || 'off'],
    ['SEC EDGAR', features.MEME_SOURCE_SEC_EDGAR_ENABLED?.status || 'off'],
    ['Stocktwits Source', features.MEME_SOURCE_STOCKTWITS_ENABLED?.status || 'off'],
    ['Polygon Source', features.MEME_SOURCE_POLYGON_ENABLED?.status || 'off'],
    ['Alpha Vantage Source', features.MEME_SOURCE_ALPHA_VANTAGE_ENABLED?.status || 'off'],
    ['Regular Watch', regularWatchFeatures.REGULAR_WATCH_INTELLIGENCE_ENABLED?.status || regularWatchIntelligence?.status || 'off'],
    ['Regular Priority Scoring', regularWatchFeatures.REGULAR_WATCH_PRIORITY_SCORING_ENABLED?.status || 'off'],
    ['Regular Scanner Ranking', regularWatchFeatures.REGULAR_WATCH_SCANNER_RANKING_ENABLED?.status || 'off'],
    ['Regular Position Awareness', regularWatchFeatures.REGULAR_WATCH_POSITION_AWARENESS_ENABLED?.status || 'off'],
  ];
}

function resolveWatchState(watch) {
  if ((watch.dynamicHotList?.status || '') === 'disabled' && (watch.hotHotList?.status || '') === 'disabled') {
    return 'DISABLED';
  }
  if (watch.hotHotList?.enabled) return String(watch.hotHotList.status || 'HOT HOT').toUpperCase();
  if (watch.dynamicHotList?.enabled) return String(watch.dynamicHotList.status || 'SHADOW').toUpperCase();
  return 'WATCHING';
}

function resolveWatchPill(watch, error) {
  if (error) return 'ERROR';
  if ((watch.dynamicHotList?.status || '') === 'disabled' && (watch.hotHotList?.status || '') === 'disabled') return 'DISABLED';
  if (watch.hotHotList?.stale || watch.dynamicHotList?.stale) return 'STALE';
  return 'LIVE';
}

function resolveWatchPillTone(watch, error) {
  if (error) return 'critical';
  if ((watch.dynamicHotList?.status || '') === 'disabled' && (watch.hotHotList?.status || '') === 'disabled') return 'warn';
  if (watch.hotHotList?.stale || watch.dynamicHotList?.stale) return 'warn';
  return 'ok';
}

function resolveColumnMeta(section, label) {
  if (!section || section.status === 'disabled' || section.enabled === false) return `${label} disabled`;
  if (section.stale) return `${label} stale`;
  const count = Array.isArray(section.symbols) ? section.symbols.length : 0;
  return `${label}: ${formatCount(count)}`;
}

function renderFeatureChip(label, status) {
  const tone = featureTone(status);
  return `<span class="tag ${tone}">${escapeHtml(label)}: ${escapeHtml(String(status || 'off').toUpperCase())}</span>`;
}

function formatHotSlotRotationStatus(rotation) {
  if (rotation?.waitingForBrokerReconciliation) {
    return 'WAITING FOR BROKER RECONCILIATION';
  }
  const status = String(rotation?.status || 'off').toLowerCase();
  const blockReason = String(rotation?.blockReason || '').toLowerCase();
  const rotationEligible = Boolean(rotation?.rotationEligible);
  if (rotation?.enabled && status === 'active' && !rotationEligible && blockReason === 'rotation_blocked_no_eligible_position') {
    return 'ACTIVE, WAITING FOR ELIGIBLE POSITION';
  }
  if (rotation?.enabled && status === 'active' && !rotationEligible && blockReason) {
    return `ACTIVE, WAITING (${blockReason.replace(/_/g, ' ')})`;
  }
  return formatMemeRuntimeStatus(status || 'off');
}

function formatMemeRuntimeStatus(value) {
  const normalized = String(value || 'off').toLowerCase();
  if (normalized === 'blocked') return 'BLOCKED';
  if (normalized === 'missing_credentials') return 'MISSING CREDENTIALS';
  if (normalized === 'dynamic_watch') return 'SHADOW';
  if (normalized === 'waiting_for_broker_reconciliation') return 'WAITING FOR BROKER RECONCILIATION';
  return normalized.toUpperCase();
}

function watchTone(status) {
  const value = String(status || '').toLowerCase();
  if (['watching', 'moving', 'tradable', 'hot_hot', 'shadow', 'live', 'enabled', 'active'].includes(value)) return 'green';
  if (['blocked', 'excluded', 'stale', 'disabled', 'halted'].includes(value)) return 'amber';
  if (['error', 'critical'].includes(value)) return 'red';
  return 'cyan';
}

function featureTone(status) {
  const value = String(status || '').toLowerCase();
  if (['enabled', 'active', 'shadow', 'live'].includes(value)) return 'green';
  if (['blocked', 'locked', 'off', 'disabled', 'stale'].includes(value)) return 'amber';
  if (['error', 'critical'].includes(value)) return 'red';
  return 'cyan';
}

function formatReasonList(value) {
  const items = Array.isArray(value) ? value : (value ? [value] : []);
  return items.length ? items.map((item) => String(item)).join(', ') : 'none';
}

function formatTagList(value) {
  const items = Array.isArray(value) ? value : (value ? [value] : []);
  return items.length ? items.map((item) => String(item)).join(', ') : 'none';
}

function formatSources(value) {
  if (Array.isArray(value)) {
    if (!value.length) return 'none';
    return value.map((item) => {
      if (item && typeof item === 'object') {
        const tier = item.tier ? ` (${item.tier})` : '';
        const status = item.status ? `:${String(item.status).toUpperCase()}` : '';
        return `${formatSourceName(item.source)}${tier}${status}`;
      }
      return String(item);
    }).join(', ');
  }
  return value ? String(value) : 'none';
}

function formatCandidateComparison(value) {
  if (!value || typeof value !== 'object') return 'none';
  const formatSigned = (number) => `${Number(number) >= 0 ? '+' : '-'}${formatNumber(Math.abs(Number(number)))}`;
  const parts = [
    Number.isFinite(Number(value.scannerScore)) ? `scanner ${formatNumber(value.scannerScore)}` : null,
    Number.isFinite(Number(value.regularWatchScore)) ? `regular ${formatNumber(value.regularWatchScore)}` : null,
    Number.isFinite(Number(value.scoreDelta)) ? `delta ${formatSigned(value.scoreDelta)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : 'none';
}

function formatSourceConfirmations(value) {
  if (!value || typeof value !== 'object') return 'none';
  const order = [
    ['reddit', 'Reddit'],
    ['stocktwits', 'Stocktwits'],
    ['alpacaMarket', 'Alpaca Market'],
    ['polygon', 'Polygon'],
    ['alphaVantage', 'Alpha Vantage'],
    ['alpacaAssets', 'Alpaca Tradability'],
    ['nasdaqHalts', 'Nasdaq Halts'],
    ['secEdgar', 'SEC EDGAR'],
  ];
  const items = order.map(([key, label]) => `${label}:${value[key] ? 'yes' : 'no'}`);
  return items.join(', ');
}

function formatPhaseBSummary(value) {
  if (!value || typeof value !== 'object') return 'none';
  const pieces = [];
  if (Number.isFinite(Number(value.finalMemeScore))) pieces.push(`score ${formatNumber(value.finalMemeScore)}`);
  if (Number.isFinite(Number(value.socialConfirmation?.score))) pieces.push(`social ${formatNumber(value.socialConfirmation.score)}`);
  if (Number.isFinite(Number(value.marketConfirmation?.score))) pieces.push(`market ${formatNumber(value.marketConfirmation.score)}`);
  if (Number.isFinite(Number(value.riskConfirmation?.score))) pieces.push(`risk ${formatNumber(value.riskConfirmation.score)}`);
  pieces.push(`upgrade ${value.borderlineUpgrade ? 'yes' : 'no'}`);
  return pieces.join(' | ') || 'none';
}

function formatProviderScore(value) {
  if (!value || typeof value !== 'object') return 'none';
  const parts = [];
  if (Number.isFinite(Number(value.reddit))) parts.push(`Reddit ${formatNumber(value.reddit)}`);
  if (Number.isFinite(Number(value.stocktwits))) parts.push(`Stocktwits ${formatNumber(value.stocktwits)}`);
  if (Number.isFinite(Number(value.alpaca))) parts.push(`Alpaca ${formatNumber(value.alpaca)}`);
  if (Number.isFinite(Number(value.polygon))) parts.push(`Polygon ${formatNumber(value.polygon)}`);
  if (Number.isFinite(Number(value.alphaVantage))) parts.push(`Alpha Vantage ${formatNumber(value.alphaVantage)}`);
  if (Number.isFinite(Number(value.score))) parts.push(`Score ${formatNumber(value.score)}`);
  return parts.join(' / ') || 'none';
}

function formatRiskConfirmation(value) {
  if (!value || typeof value !== 'object') return 'none';
  const parts = [
    value.alpacaAssets ? `Tradable ${value.alpacaAssets}` : null,
    value.nasdaqHalts ? `Halts ${value.nasdaqHalts}` : null,
    value.secEdgar ? `SEC ${value.secEdgar}` : null,
    Number.isFinite(Number(value.score)) ? `Score ${formatNumber(value.score)}` : null,
  ].filter(Boolean);
  return parts.join(' / ') || 'none';
}

function formatSourceName(value) {
  const source = String(value || 'unknown').trim();
  return source.startsWith('reddit:') ? source.slice(7) : source;
}

function formatFreshness(freshness, lastDecision) {
  if (!freshness) return lastDecision || 'unknown';
  return String(freshness).toUpperCase();
}

function formatSignedPercent(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (!Number.isFinite(Number(value))) return '-';
  const abs = Math.abs(Number(value));
  return `${Number(value) >= 0 ? '+' : '-'}${formatPercent(abs)}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toFixed(2)}%`;
}

function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(Number(value));
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value));
}

function formatCount(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value));
}

function formatClock(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

render(state.snapshot || bootstrapSnapshot || {});
if (dashboardRequest) {
  refreshSnapshot();
  setInterval(refreshSnapshot, 5000);
}
