/* global document */
const state = {
  snapshot: null,
  control: null,
  loading: true,
  error: null,
  actionMessage: null,
  actionKind: null,
  pendingAction: null,
  meme: null,
  memeStatus: null,
  memeError: null,
  memeActionMessage: null,
  memeActionKind: null,
  pendingMemeAction: null,
  regularWatch: null,
  regularWatchStatus: null,
  regularWatchError: null,
  regularWatchActionMessage: null,
  regularWatchActionKind: null,
  pendingRegularWatchAction: null,
};

const $ = (id) => document.getElementById(id);

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
});

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

async function refreshAll() {
  state.loading = true;
  render();
  const [snapshotResult, controlResult, memeResult, memeStatusResult, regularWatchResult, regularWatchStatusResult] = await Promise.allSettled([
    fetch('/api/snapshot', { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      return payload;
    }),
    fetch('/api/control/state', { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      return payload.control;
    }),
    fetch('/api/meme/features', { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      return payload;
    }),
    fetch('/api/meme/status', { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      return payload;
    }),
    fetch('/api/regular-watch/features', { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      return payload;
    }),
    fetch('/api/regular-watch/status', { cache: 'no-store' }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
      return payload;
    }),
  ]);

  state.snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  state.control = controlResult.status === 'fulfilled' ? controlResult.value : null;
  state.meme = memeResult.status === 'fulfilled' ? memeResult.value : null;
  state.memeStatus = memeStatusResult.status === 'fulfilled' ? memeStatusResult.value : null;
  state.regularWatch = regularWatchResult.status === 'fulfilled' ? regularWatchResult.value : null;
  state.regularWatchStatus = regularWatchStatusResult.status === 'fulfilled' ? regularWatchStatusResult.value : null;
  state.memeError = memeResult.status === 'rejected'
    ? memeResult.reason?.message || 'Meme feature state unavailable'
    : null;
  state.regularWatchError = regularWatchResult.status === 'rejected'
    ? regularWatchResult.reason?.message || 'Regular watch feature state unavailable'
    : (regularWatchStatusResult.status === 'rejected'
      ? regularWatchStatusResult.reason?.message || 'Regular watch status unavailable'
      : null);
  state.error = snapshotResult.status === 'rejected'
    ? snapshotResult.reason?.message || 'Snapshot unavailable'
    : (controlResult.status === 'rejected'
      ? controlResult.reason?.message || 'Control state unavailable'
      : null);
  state.loading = false;
  render();
}

async function runAction(action, profile) {
  const label = profile ? `${action}:${profile}` : action;
  state.pendingAction = label;
  state.actionMessage = 'Working...';
  state.actionKind = 'pending';
  render();
  try {
    const response = await fetch('/api/control/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, profile }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    }
    state.actionMessage = `${payload.message || payload.action || 'Action complete'}${payload.verified ? ' Verified.' : ''}`;
    state.actionKind = payload.ok ? 'ok' : 'warn';
    await refreshAll();
  } catch (error) {
    state.actionMessage = error.message;
    state.actionKind = 'error';
    render();
  } finally {
    state.pendingAction = null;
    render();
  }
}

async function runMemeAction(featureKey, enabled) {
  const label = `${featureKey}:${enabled}`;
  state.pendingMemeAction = label;
  state.memeActionMessage = 'Working...';
  state.memeActionKind = 'pending';
  render();
  try {
    const response = await fetch('/api/meme/features', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        featureKey,
        enabled,
        changedBy: 'dashboard',
        source: 'dashboard-control',
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    }
    state.memeActionMessage = `${payload.message || payload.action || 'Meme feature updated'}${payload.blocked_reason ? ` (${payload.blocked_reason})` : ''}`;
    state.memeActionKind = payload.ok ? 'ok' : 'warn';
    await refreshAll();
  } catch (error) {
    state.memeActionMessage = error.message;
    state.memeActionKind = 'error';
    render();
  } finally {
    state.pendingMemeAction = null;
    render();
  }
}

async function runMemeRuntimeAction(action) {
  state.pendingMemeAction = action;
  state.memeActionMessage = 'Working...';
  state.memeActionKind = 'pending';
  render();
  try {
    const response = await fetch('/api/meme/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        changedBy: 'dashboard',
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    }
    state.memeActionMessage = payload.message || 'Meme monitor action complete';
    state.memeActionKind = payload.ok ? 'ok' : 'warn';
    await refreshAll();
  } catch (error) {
    state.memeActionMessage = error.message;
    state.memeActionKind = 'error';
    render();
  } finally {
    state.pendingMemeAction = null;
    render();
  }
}

async function runRegularWatchFeatureAction(featureKey, enabled) {
  const label = `${featureKey}:${enabled}`;
  state.pendingRegularWatchAction = label;
  state.regularWatchActionMessage = 'Working...';
  state.regularWatchActionKind = 'pending';
  render();
  try {
    const response = await fetch('/api/regular-watch/features', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        featureKey,
        enabled,
        changedBy: 'dashboard',
        source: 'dashboard-control',
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    }
    state.regularWatchActionMessage = `${payload.message || payload.action || 'Regular watch feature updated'}${payload.blocked_reason ? ` (${payload.blocked_reason})` : ''}`;
    state.regularWatchActionKind = payload.ok ? 'ok' : 'warn';
    await refreshAll();
  } catch (error) {
    state.regularWatchActionMessage = error.message;
    state.regularWatchActionKind = 'error';
    render();
  } finally {
    state.pendingRegularWatchAction = null;
    render();
  }
}

async function runRegularWatchRuntimeAction(action) {
  state.pendingRegularWatchAction = action;
  state.regularWatchActionMessage = 'Working...';
  state.regularWatchActionKind = 'pending';
  render();
  try {
    const response = await fetch('/api/regular-watch/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action,
        changedBy: 'dashboard',
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
    }
    state.regularWatchActionMessage = payload.message || 'Regular watch action complete';
    state.regularWatchActionKind = payload.ok ? 'ok' : 'warn';
    await refreshAll();
  } catch (error) {
    state.regularWatchActionMessage = error.message;
    state.regularWatchActionKind = 'error';
    render();
  } finally {
    state.pendingRegularWatchAction = null;
    render();
  }
}

function render() {
  const snapshot = state.snapshot || {};
  const control = state.control || {};
  const summary = snapshot.summary || {};
  const live = snapshot.live || {};
  const scannerRuntime = live.scanner_runtime || {};
  const regime = snapshot.regime || {};
  const automation = snapshot.automation?.live_market || {};
  const trader = control.trader || {};
  const scanner = control.scanner || {};
  const workflow = control.workflow || {};
  const meme = state.meme || snapshot?.live?.meme_monitor_state || {};
  const memeStatus = state.memeStatus || snapshot?.memeMonitor || snapshot?.live?.meme_monitor_runtime || {};
  const regularWatch = state.regularWatch || snapshot?.regularWatchIntelligence || snapshot?.live?.regular_watch_intelligence || {};
  const regularWatchStatus = state.regularWatchStatus || snapshot?.regularWatchStatus || snapshot?.live?.regular_watch_runtime || {};
  const memeHotList = memeStatus?.memeMonitor?.hotList || memeStatus?.hotList || {};
  const memeHotHotScoring = memeStatus?.memeMonitor?.hotHotScoring || memeStatus?.hotHotScoring || {};
  const memeDynamicWatchlist = memeStatus?.memeMonitor?.dynamicWatchlist || memeStatus?.dynamicWatchlist || {};
  const memePriorityOverride = memeStatus?.memeMonitor?.priorityOverride || memeStatus?.priorityOverride || {};
  const memeHotSlotRotation = memeStatus?.memeMonitor?.hotSlotRotation || memeStatus?.hotSlotRotation || {};
  const memeRedditSources = memeStatus?.memeMonitor?.redditScanner?.sources || memeStatus?.redditScanner?.sources || [];
  const memePhaseASources = memeStatus?.phaseA?.sources || memeStatus?.memeMonitor?.phaseA?.sources || memeStatus?.meme_monitor_runtime?.phaseA?.sources || [];
  const memePhaseBSources = memeStatus?.phaseB?.sources || memeStatus?.memeMonitor?.phaseB?.sources || memeStatus?.meme_monitor_runtime?.phaseB?.sources || [];
  const regularWatchFeatureState = regularWatch?.featureState || regularWatch?.regularWatchIntelligence?.featureState || regularWatch?.feature_state || regularWatch;
  const regularWatchFeatureDetails = regularWatchFeatureState?.features || regularWatch?.features || {};
  const memeSummary = meme.summary || {};
  const memeFeatures = meme.features || {};
  const buttons = Array.from(document.querySelectorAll('[data-action]'));
  const memeButtons = Array.from(document.querySelectorAll('[data-meme-feature]'));
  const memeRuntimeButtons = Array.from(document.querySelectorAll('[data-meme-action]'));
  const regularWatchButtons = Array.from(document.querySelectorAll('[data-regular-watch-feature]'));
  const regularWatchRuntimeButtons = Array.from(document.querySelectorAll('[data-regular-watch-action]'));

  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('snapshotStamp').textContent = snapshot?.timestamp ? `updated ${formatTime(snapshot.timestamp)}` : '-';
  $('modeValue').textContent = 'Live Market';
  $('regimeValue').textContent = Array.isArray(regime.approved_symbols) ? regime.approved_symbols.join(', ') : '-';
  $('pnlValue').textContent = formatSignedCurrency(summary.daily_change);
  $('profitExitValue').textContent = `${formatCurrency(regime.stop_loss_dollars)} stop / ${formatCurrency(regime.trailing_profit_giveback_dollars)} trail`;
  $('scannerProfile').textContent = scanner.status === 'running' ? 'running' : 'not running';
  $('scheduleBadge').textContent = formatScheduleBadge(automation);
  $('scheduleBadge').className = `tag ${formatScheduleBadgeKind(automation)}`;
  $('scheduleHint').textContent = automation.note || 'Upcoming schedule';
  $('traderStatusPill').textContent = statusLabel(workflow.status || trader.status || summary.trader_status || (state.error ? 'degraded' : 'unknown'));
  $('traderStatusPill').className = `pill ${state.error || workflow.status === 'degraded' ? 'critical' : workflow.status === 'running' ? 'ok' : workflow.status === 'starting' ? 'warn' : 'warn'}`;
  $('actionStatus').innerHTML = state.actionMessage
    ? `<span class="tag ${state.actionKind === 'ok' ? 'green' : state.actionKind === 'error' ? 'red' : 'amber'}">${escapeHtml(state.actionKind || 'info')}</span> ${escapeHtml(state.actionMessage)}`
    : 'No action yet.';

  $('traderState').innerHTML = renderStateRows([
    ['workflow', workflow.status || '-'],
    ['workflow type', 'Live Market'],
    ['issues', Array.isArray(workflow.issues) && workflow.issues.length ? workflow.issues.join(', ') : 'none'],
    ['status', trader.status || '-'],
    ['pid', trader.pid || '-'],
    ['port', trader.port || '-'],
    ['managed', boolLabel(trader.managed)],
    ['last action', formatTime(trader.last_action_at)],
    ['started', formatTime(trader.started_at)],
  ]);

  $('automationSchedule').innerHTML = renderStateRows([
    ['next start', automation.start?.label || '-'],
    ['next stop', automation.stop?.label || '-'],
    ['market day', boolLabel(automation.current?.market_day)],
    ['holiday', boolLabel(automation.current?.holiday)],
    ['timezone', automation.timezone || 'America/New_York'],
  ]);

  $('scannerState').innerHTML = renderStateRows([
    ['status', scanner.status || '-'],
    ['scope', 'approved stocks only'],
    ['pid', scanner.pid || '-'],
    ['all pids', Array.isArray(scanner.pids) && scanner.pids.length ? scanner.pids.join(', ') : '-'],
    ['script', scanner.script || '-'],
    ['managed', boolLabel(scanner.managed)],
    ['multiple running', boolLabel(scanner.multiple_running)],
    ['last scan', formatTime(scannerRuntime.last_scan_time)],
    ['posted / approved', scannerRuntime.posted_count !== undefined ? `${formatCount(scannerRuntime.posted_count)} / ${formatCount(scannerRuntime.approved_count)}` : '-'],
    ['scan error', scannerRuntime.last_scan_error || 'none'],
    ['last action', formatTime(scanner.last_action_at)],
  ]);

  $('memeMonitorPill').textContent = statusLabel(memeFeatures.MEME_MONITOR_ENABLED?.status || 'off');
  $('memeMonitorPill').className = `pill ${memeFeatures.MEME_MONITOR_ENABLED?.status === 'blocked' ? 'critical' : memeFeatures.MEME_MONITOR_ENABLED?.status === 'enabled' || memeFeatures.MEME_MONITOR_ENABLED?.status === 'shadow' ? 'ok' : memeFeatures.MEME_MONITOR_ENABLED?.status === 'locked' ? 'warn' : 'warn'}`;
  $('memeMonitorSource').textContent = `Meme feature state source: ${memeSummary.source || meme.source || 'env + runtime state'}`;
  $('memeMonitorHint').textContent = memeSummary.blocked_features?.length
    ? `Blocked features: ${memeSummary.blocked_features.join(', ')}`
    : (state.memeError
      ? state.memeError
      : (memeSummary.warnings?.length ? memeSummary.warnings.join(' | ') : 'Disabled by default'));
  $('memeFeatureState').innerHTML = renderStateRows([
    renderMemeStateRow('Meme Monitor', memeFeatures.MEME_MONITOR_ENABLED),
    renderMemeStateRow('Reddit Scanner', memeFeatures.MEME_REDDIT_SCANNER_ENABLED),
    renderMemeStateRow('Hot List', memeFeatures.MEME_HOT_LIST_ENABLED),
    renderMemeStateRow('Dynamic Watchlist', memeFeatures.MEME_DYNAMIC_WATCHLIST_ENABLED),
    renderMemeStateRow('Priority Override', memeFeatures.MEME_PRIORITY_OVERRIDE_ENABLED),
    renderMemeStateRow('Hot Slot Rotation', memeFeatures.MEME_HOT_SLOT_ROTATION_ENABLED),
    renderMemeStateRow('Reddit API', memeFeatures.MEME_SOURCE_REDDIT_ENABLED),
    renderMemeStateRow('Alpaca Market', memeFeatures.MEME_SOURCE_ALPACA_MARKET_ENABLED),
    renderMemeStateRow('Alpaca Tradability', memeFeatures.MEME_SOURCE_ALPACA_ASSETS_ENABLED),
    renderMemeStateRow('Nasdaq Halts', memeFeatures.MEME_SOURCE_NASDAQ_HALTS_ENABLED),
    renderMemeStateRow('SEC EDGAR', memeFeatures.MEME_SOURCE_SEC_EDGAR_ENABLED),
    renderMemeStateRow('Stocktwits Source', memeFeatures.MEME_SOURCE_STOCKTWITS_ENABLED),
    renderMemeStateRow('Polygon Source', memeFeatures.MEME_SOURCE_POLYGON_ENABLED),
    renderMemeStateRow('Alpha Vantage Source', memeFeatures.MEME_SOURCE_ALPHA_VANTAGE_ENABLED),
  ]);
  $('memeRuntimeState').innerHTML = renderStateRows([
    ['Reddit Scanner', formatMemeRuntimeStatus(memeStatus?.memeMonitor?.redditScanner?.status || memeStatus?.redditScanner?.status || 'off')],
    ['Reddit sources', formatSourceStatusList(memeRedditSources)],
    ['Phase A sources', formatSourceStatusList(memePhaseASources)],
    ['Phase A status', formatMemeRuntimeStatus(memeStatus?.phaseA?.status || memeStatus?.memeMonitor?.phaseA?.status || 'off')],
    ['Phase A symbols', formatCount(Array.isArray(memeStatus?.phaseA?.symbols || memeStatus?.memeMonitor?.phaseA?.symbols) ? (memeStatus?.phaseA?.symbols || memeStatus?.memeMonitor?.phaseA?.symbols).length : 0)],
    ['Phase A last run', formatTime(memeStatus?.phaseA?.lastRunAt || memeStatus?.memeMonitor?.phaseA?.lastRunAt)],
    ['Phase A last error', memeStatus?.phaseA?.lastError || memeStatus?.memeMonitor?.phaseA?.lastError || 'none'],
    ['Phase B sources', formatSourceStatusList(memePhaseBSources)],
    ['Phase B status', formatMemeRuntimeStatus(memeStatus?.phaseB?.status || memeStatus?.memeMonitor?.phaseB?.status || 'off')],
    ['Phase B symbols', formatCount(Array.isArray(memeStatus?.phaseB?.symbols || memeStatus?.memeMonitor?.phaseB?.symbols) ? (memeStatus?.phaseB?.symbols || memeStatus?.memeMonitor?.phaseB?.symbols).length : 0)],
    ['Phase B last run', formatTime(memeStatus?.phaseB?.lastRunAt || memeStatus?.memeMonitor?.phaseB?.lastRunAt)],
    ['Phase B last error', memeStatus?.phaseB?.lastError || memeStatus?.memeMonitor?.phaseB?.lastError || 'none'],
    ['Hot List', formatMemeRuntimeStatus(memeHotList.status || 'off')],
    ['Hot Hot Scoring', formatMemeRuntimeStatus(memeHotHotScoring.status || 'off')],
    ['Dynamic Watchlist', formatMemeRuntimeStatus(memeDynamicWatchlist.status || memeFeatures.MEME_DYNAMIC_WATCHLIST_ENABLED?.status || 'off')],
    ['Priority Override', formatMemeRuntimeStatus(memePriorityOverride.status || memeFeatures.MEME_PRIORITY_OVERRIDE_ENABLED?.status || 'off')],
    ['Hot Slot Rotation', formatMemeRuntimeStatus(memeHotSlotRotation.status || memeFeatures.MEME_HOT_SLOT_ROTATION_ENABLED?.status || 'off')],
    ['Dynamic symbols', formatCount(memeHotList.dynamicCount || memeHotList.dynamic_count || 0)],
    ['Hot Hot symbols', formatCount(memeHotList.hotHotCount || memeHotList.hot_hot_count || 0)],
    ['Expired symbols', formatCount(Array.isArray(memeStatus?.memeMonitor?.hotListPayload?.expired || memeStatus?.hotListPayload?.expired) ? (memeStatus?.memeMonitor?.hotListPayload?.expired || memeStatus?.hotListPayload?.expired).length : 0)],
    ['Last score run', formatTime(memeHotList.lastScoredAt || memeHotList.last_scored_at || memeStatus?.memeMonitor?.redditScanner?.lastRunAt || memeStatus?.redditScanner?.lastRunAt)],
    ['Last error', memeHotList.lastError || memeHotHotScoring.lastError || memeStatus?.memeMonitor?.redditScanner?.lastError || memeStatus?.redditScanner?.lastError || 'none'],
  ]);
  $('memeSourceState').innerHTML = renderStateRows(buildPhaseASourceRows(memePhaseASources));
  $('memePhaseBState').innerHTML = renderStateRows(buildPhaseBSourceRows(memePhaseBSources));
  $('memeAutoActionState').innerHTML = renderStateRows([
    renderMemeStateRow('Auto Action', memeFeatures.MEME_AUTO_ACTION_ENABLED),
  ]);
  $('memeActionStatus').innerHTML = state.memeActionMessage
    ? `<span class="tag ${state.memeActionKind === 'ok' ? 'green' : state.memeActionKind === 'error' ? 'red' : 'amber'}">${escapeHtml(state.memeActionKind || 'info')}</span> ${escapeHtml(state.memeActionMessage)}`
    : 'No meme action yet.';
  $('memeAutoActionNote').textContent = memeFeatures.MEME_AUTO_ACTION_ENABLED?.status === 'locked'
    ? 'Auto Action is locked until the repo has a safe implementation path.'
    : 'Auto Action remains disabled unless a safe implementation path exists.';

  $('regularWatchPill').textContent = statusLabel(regularWatchStatus?.regularWatchIntelligence?.status || regularWatch?.status || 'off');
  $('regularWatchPill').className = `pill ${regularWatchStatus?.regularWatchIntelligence?.status === 'blocked' ? 'critical' : regularWatchStatus?.regularWatchIntelligence?.status === 'active' ? 'ok' : regularWatchStatus?.regularWatchIntelligence?.status === 'locked' ? 'warn' : 'warn'}`;
  $('regularWatchSource').textContent = `Regular Watch feature state source: ${regularWatchFeatureState?.source || regularWatch?.source || 'env + runtime state'}`;
  $('regularWatchHint').textContent = regularWatchFeatureState?.blocked_features?.length
    ? `Blocked features: ${regularWatchFeatureState.blocked_features.join(', ')}`
    : (state.regularWatchError
      ? state.regularWatchError
      : (regularWatchFeatureState?.warnings?.length ? regularWatchFeatureState.warnings.join(' | ') : 'Disabled by default'));
  $('regularWatchFeatureState').innerHTML = renderStateRows([
    renderRegularWatchStateRow('Regular Watch Intelligence', regularWatchFeatureDetails.REGULAR_WATCH_INTELLIGENCE_ENABLED),
    renderRegularWatchStateRow('Market Confirmation', regularWatchFeatureDetails.REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED),
    renderRegularWatchStateRow('Asset Validation', regularWatchFeatureDetails.REGULAR_WATCH_ASSET_VALIDATION_ENABLED),
    renderRegularWatchStateRow('Halt Check', regularWatchFeatureDetails.REGULAR_WATCH_HALT_CHECK_ENABLED),
    renderRegularWatchStateRow('SEC Risk Check', regularWatchFeatureDetails.REGULAR_WATCH_SEC_RISK_CHECK_ENABLED),
    renderRegularWatchStateRow('News/Catalyst Check', regularWatchFeatureDetails.REGULAR_WATCH_NEWS_CATALYST_ENABLED),
    renderRegularWatchStateRow('Priority Scoring', regularWatchFeatureDetails.REGULAR_WATCH_PRIORITY_SCORING_ENABLED),
    renderRegularWatchStateRow('Scanner Ranking', regularWatchFeatureDetails.REGULAR_WATCH_SCANNER_RANKING_ENABLED),
    renderRegularWatchStateRow('Position Awareness', regularWatchFeatureDetails.REGULAR_WATCH_POSITION_AWARENESS_ENABLED),
  ]);
  $('regularWatchSourceState').innerHTML = renderStateRows(buildRegularWatchSourceRows(
    regularWatchStatus?.sources || regularWatchStatus?.regularWatchIntelligence?.sources || regularWatch?.sources || [],
  ));
  $('regularWatchRuntimeState').innerHTML = renderStateRows([
    ['Status', statusLabel(regularWatchStatus?.regularWatchIntelligence?.status || regularWatch?.status || 'off')],
    ['Scanner ranking', statusLabel(regularWatchStatus?.scannerRanking?.status || (regularWatchStatus?.regularWatchIntelligence?.features?.scannerRanking ? regularWatchStatus?.regularWatchIntelligence?.status || 'active' : 'off'))],
    ['Position awareness', statusLabel(regularWatchStatus?.positionAwareness?.status || (regularWatchStatus?.regularWatchIntelligence?.features?.positionAwareness ? regularWatchStatus?.regularWatchIntelligence?.status || 'active' : 'off'))],
    ['Sources', formatSourceStatusList(regularWatchStatus?.sources || regularWatchStatus?.regularWatchIntelligence?.sources || regularWatch?.sources || [])],
    ['Last run', formatTime(regularWatchStatus?.regularWatchIntelligence?.lastRunAt || regularWatch?.lastRunAt)],
    ['Last error', regularWatchStatus?.regularWatchIntelligence?.lastError || regularWatch?.lastError || 'none'],
    ['Symbols checked', formatCount(regularWatchStatus?.regularWatchIntelligence?.symbolsChecked ?? regularWatch?.symbolsChecked ?? 0)],
    ['Movers found', formatCount(regularWatchStatus?.regularWatchIntelligence?.moversFound ?? regularWatch?.moversFound ?? 0)],
    ['Blocked symbols', formatCount(regularWatchStatus?.regularWatchIntelligence?.blockedSymbols ?? regularWatch?.blockedSymbols ?? 0)],
    ['Market confirmation', boolLabel(regularWatchStatus?.regularWatchIntelligence?.features?.marketConfirmation)],
    ['Priority scoring', boolLabel(regularWatchStatus?.regularWatchIntelligence?.features?.priorityScoring)],
  ]);
  $('regularWatchActionStatus').innerHTML = state.regularWatchActionMessage
    ? `<span class="tag ${state.regularWatchActionKind === 'ok' ? 'green' : state.regularWatchActionKind === 'error' ? 'red' : 'amber'}">${escapeHtml(state.regularWatchActionKind || 'info')}</span> ${escapeHtml(state.regularWatchActionMessage)}`
    : 'No regular watch action yet.';

  $('policyState').innerHTML = renderStateRows([
    ['Daily Change', formatSignedCurrency(summary.daily_change)],
    ['blocked', formatCount(summary.blocked_count)],
    ['approved', formatCount(summary.approved_count)],
    ['heartbeat', formatHeartbeat(live?.status?.heartbeat_count, live?.status?.last_request_at, snapshot?.timestamp)],
    ['position stop', formatCurrency(regime.stop_loss_dollars)],
    ['trailing rule', `${formatCurrency(regime.trailing_profit_start_dollars)} start / ${formatCurrency(regime.trailing_profit_giveback_dollars)} giveback`],
  ]);

  $('warnings').innerHTML = renderWarnings(snapshot?.alerts || [], state.error);

  for (const button of buttons) {
    const action = button.dataset.action;
    const profile = button.dataset.profile;
    const busy = state.pendingAction && state.pendingAction === `${action}:${profile || ''}`.replace(/:$/, '');
    button.disabled = Boolean(state.pendingAction) && !busy;
    button.textContent = button.dataset.action === 'refresh'
      ? 'Refresh'
      : button.textContent;
    if (busy) {
      button.dataset.originalText = button.dataset.originalText || button.textContent;
      button.textContent = 'Working...';
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }

  for (const button of memeButtons) {
    const featureKey = button.dataset.memeFeature;
    const busy = state.pendingMemeAction === `${featureKey}:${button.dataset.memeEnabled}`;
    button.disabled = Boolean(state.pendingMemeAction) && !busy;
    if (busy) {
      button.dataset.originalText = button.dataset.originalText || button.textContent;
      button.textContent = 'Working...';
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }

  for (const button of memeRuntimeButtons) {
    const action = button.dataset.memeAction;
    const busy = state.pendingMemeAction === action;
    button.disabled = Boolean(state.pendingMemeAction) && !busy;
    if (busy) {
      button.dataset.originalText = button.dataset.originalText || button.textContent;
      button.textContent = 'Working...';
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }

  for (const button of regularWatchButtons) {
    const featureKey = button.dataset.regularWatchFeature;
    const busy = state.pendingRegularWatchAction === `${featureKey}:${button.dataset.regularWatchEnabled}`;
    button.disabled = Boolean(state.pendingRegularWatchAction) && !busy;
    if (busy) {
      button.dataset.originalText = button.dataset.originalText || button.textContent;
      button.textContent = 'Working...';
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }

  for (const button of regularWatchRuntimeButtons) {
    const action = button.dataset.regularWatchAction;
    const busy = state.pendingRegularWatchAction === action;
    button.disabled = Boolean(state.pendingRegularWatchAction) && !busy;
    if (busy) {
      button.dataset.originalText = button.dataset.originalText || button.textContent;
      button.textContent = 'Working...';
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function renderStateRows(rows) {
  return rows.map(([label, value]) => `
    <div class="state-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? '-')}</strong>
    </div>
  `).join('');
}

function formatSourceStatusList(value) {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : [];
  if (!list.length) return 'none';
  return list.map((entry) => {
    const source = entry?.source || 'unknown';
    const tier = entry?.tier ? `/${entry.tier}` : '';
    const status = String(entry?.status || 'inactive').toUpperCase();
    const reason = entry?.blockedReason ? ` (${entry.blockedReason})` : '';
    const lastScanAt = entry?.lastScanAt ? ` @ ${formatTime(entry.lastScanAt)}` : '';
    return `${source}${tier}:${status}${reason}${lastScanAt}`;
  }).join(', ');
}

function buildRegularWatchSourceRows(value) {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : [];
  if (!list.length) {
    return [['Sources', 'none']];
  }
  return list.map((entry) => {
    const label = `${entry?.source || 'unknown'}${entry?.tier ? ` (${entry.tier})` : ''}`;
    const status = statusLabel(entry?.status || 'inactive');
    const detailBits = [
      entry?.blockedReason ? `blocked: ${entry.blockedReason}` : null,
      entry?.lastError ? `error: ${entry.lastError}` : null,
      entry?.lastScanAt ? `scanned: ${formatTime(entry.lastScanAt)}` : null,
      Number.isFinite(Number(entry?.symbolsDetected)) ? `symbols: ${formatCount(entry.symbolsDetected)}` : null,
    ].filter(Boolean);
    return [label, [status, ...detailBits].join(' | ')];
  });
}

function renderMemeStateRow(label, feature) {
  if (!feature) {
    return [label, 'OFF'];
  }
  const status = String(feature.status || 'off').toUpperCase();
  const details = [
    feature.configured ? 'config on' : 'config off',
    feature.runtime ? 'runtime on' : 'runtime off',
    feature.effective ? 'effective' : 'inactive',
  ].join(' / ');
  const blocked = feature.blocked_reason ? ` | ${feature.blocked_reason}` : '';
  return [label, `${status} | ${details}${blocked}`];
}

function renderRegularWatchStateRow(label, feature) {
  if (!feature) {
    return [label, 'OFF'];
  }
  const status = String(feature.status || 'off').toUpperCase();
  const details = [
    feature.configured ? 'config on' : 'config off',
    feature.runtime ? 'runtime on' : 'runtime off',
    feature.effective ? 'effective' : 'inactive',
    feature.locked ? 'locked' : 'unlocked',
  ].join(' / ');
  const blocked = feature.blocked_reason ? ` | ${feature.blocked_reason}` : '';
  return [label, `${status} | ${details}${blocked}`];
}

function buildPhaseASourceRows(sources) {
  const list = Array.isArray(sources)
    ? sources
    : sources && typeof sources === 'object'
      ? Object.values(sources)
      : [];
  if (!list.length) {
    return [['Phase A sources', 'No source status available yet']];
  }
  return list.map((entry) => {
    const label = `${entry?.source || 'unknown'}${entry?.tier ? ` (${entry.tier})` : ''}`;
    const details = [
      String(entry?.status || 'inactive').toUpperCase(),
      entry?.blockedReason ? `blocked: ${entry.blockedReason}` : null,
      entry?.lastError ? `error: ${entry.lastError}` : null,
      entry?.lastScanAt ? `scanned: ${formatTime(entry.lastScanAt)}` : null,
      Number.isFinite(Number(entry?.symbolsDetected)) ? `symbols: ${formatCount(entry.symbolsDetected)}` : null,
    ].filter(Boolean).join(' | ');
    return [label, details || 'UNKNOWN'];
  });
}

function buildPhaseBSourceRows(sources) {
  const list = Array.isArray(sources)
    ? sources
    : sources && typeof sources === 'object'
      ? Object.values(sources)
      : [];
  if (!list.length) {
    return [['Phase B sources', 'No source status available yet']];
  }
  return list.map((entry) => {
    const label = `${entry?.source || 'unknown'}${entry?.tier ? ` (${entry.tier})` : ''}`;
    const details = [
      String(entry?.status || 'inactive').toUpperCase(),
      entry?.blockedReason ? `blocked: ${entry.blockedReason}` : null,
      entry?.lastError ? `error: ${entry.lastError}` : null,
      entry?.lastScanAt ? `scanned: ${formatTime(entry.lastScanAt)}` : null,
      Number.isFinite(Number(entry?.symbolsConfirmed)) ? `confirmed: ${formatCount(entry.symbolsConfirmed)}` : null,
      Number.isFinite(Number(entry?.newsItemsMatched)) ? `news: ${formatCount(entry.newsItemsMatched)}` : null,
    ].filter(Boolean).join(' | ');
    return [label, details || 'UNKNOWN'];
  });
}

function formatMemeRuntimeStatus(value) {
  const normalized = String(value || 'off').toLowerCase();
  if (normalized === 'blocked') return 'BLOCKED';
  if (normalized === 'missing_credentials') return 'MISSING CREDENTIALS';
  if (normalized === 'dynamic_watch') return 'SHADOW';
  return normalized.toUpperCase();
}

function renderWarnings(alerts, error) {
  const items = [];
  if (error) {
    items.push({
      kind: 'critical',
      title: 'Control view issue',
      message: error,
    });
  }
  for (const alert of alerts.slice(0, 4)) {
    items.push(alert);
  }
  if (!items.length) {
    return `<div class="empty-state">No active warnings. The local snapshot is fresh enough for control use.</div>`;
  }
  return items.map((item) => `
    <div class="alert-card">
      <strong>${escapeHtml(item.title || 'Notice')}</strong>
      <small>${escapeHtml(item.message || item.text || 'No details')}</small>
      <div style="margin-top:8px"><span class="tag ${item.kind === 'critical' ? 'red' : item.kind === 'warning' ? 'amber' : 'cyan'}">${escapeHtml(item.kind || 'info')}</span></div>
    </div>
  `).join('');
}

function boolLabel(value) {
  return value ? 'enabled' : 'disabled';
}

function formatCount(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return numberFormatter.format(Number(value));
}

function formatSignedCurrency(value) {
  if (!Number.isFinite(Number(value))) return '-';
  const abs = currencyFormatter.format(Math.abs(Number(value)));
  return Number(value) >= 0 ? `+${abs}` : `-${abs}`;
}

function formatPercent(value, decimals = 1) {
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(value) / 100);
}

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatHeartbeat(count, lastRequestAt, snapshotTimestamp) {
  const parts = [];
  if (Number.isFinite(Number(count))) {
    parts.push(`${numberFormatter.format(Number(count))} beats`);
  }
  const freshness = msAgo(lastRequestAt || snapshotTimestamp);
  if (freshness !== null) {
    parts.push(`fresh ${freshness}`);
  }
  return parts.length ? parts.join(' | ') : '-';
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatScheduleBadge(automation) {
  if (!automation || !automation.current) return 'Schedule unavailable';
  if (automation.current.holiday) return 'Holiday';
  if (!automation.current.market_day) return 'Closed';
  if (automation.start?.today && automation.stop?.today) {
    return 'Queued for today';
  }
  if (automation.start?.today) {
    return 'Starting today';
  }
  if (automation.stop?.today) {
    return 'Stopping today';
  }
  return 'Next market day';
}

function formatScheduleBadgeKind(automation) {
  if (!automation || !automation.current) return 'cyan';
  if (automation.current.holiday) return 'red';
  if (!automation.current.market_day) return 'amber';
  if (automation.start?.today && automation.stop?.today) return 'green';
  if (automation.start?.today) return 'cyan';
  if (automation.stop?.today) return 'amber';
  return 'cyan';
}

function msAgo(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`;
  return `${Math.max(0, Math.round(diff / 60_000))}m ago`;
}

function statusLabel(value) {
  if (!value) return 'UNKNOWN';
  return String(value).toUpperCase();
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    const profile = button.dataset.profile || undefined;
    runAction(action, profile);
  });
});

document.querySelectorAll('[data-meme-feature]').forEach((button) => {
  button.addEventListener('click', () => {
    const featureKey = button.dataset.memeFeature;
    const enabled = String(button.dataset.memeEnabled).toLowerCase() === 'true';
    runMemeAction(featureKey, enabled);
  });
});

document.querySelectorAll('[data-meme-action]').forEach((button) => {
  button.addEventListener('click', () => {
    runMemeRuntimeAction(button.dataset.memeAction);
  });
});

document.querySelectorAll('[data-regular-watch-feature]').forEach((button) => {
  button.addEventListener('click', () => {
    runRegularWatchFeatureAction(button.dataset.regularWatchFeature, button.dataset.regularWatchEnabled);
  });
});

document.querySelectorAll('[data-regular-watch-action]').forEach((button) => {
  button.addEventListener('click', () => {
    runRegularWatchRuntimeAction(button.dataset.regularWatchAction);
  });
});

refreshAll();
setInterval(refreshAll, 5000);
