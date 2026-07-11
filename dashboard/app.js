const state = {
  snapshot: null,
  loading: true,
  error: null,
  brokerSync: null,
  brokerSyncBusy: false,
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

const missingText = '-';
const DASHBOARD_FRONTEND_VERSION = '2026-07-06.broker-authoritative-positions.1';
const dashboardRequest = createDashboardRequest();
const bootstrapSnapshot = getDashboardSnapshotForPage('home');
let lastDynamicTopSignature = '';
let previousDynamicTopRows = loadStoredDynamicTopRows();

if (bootstrapSnapshot) {
  state.snapshot = bootstrapSnapshot;
  state.error = null;
  state.loading = false;
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
    const response = await dashboardRequest(`/api/home-summary?ts=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-store' },
    });
    const snapshot = await response.json();
    if (!response.ok) {
      throw new Error(snapshot?.message || snapshot?.error || `HTTP ${response.status}`);
    }
    state.snapshot = snapshot;
    state.error = null;
    state.loading = false;
    render(snapshot);
  } catch (error) {
    state.error = error.message;
    state.loading = false;
    render(state.snapshot || bootstrapSnapshot || {});
  }
}

function render(snapshot) {
  const summary = snapshot?.summary || {};
  const live = snapshot?.live || {};
  const recentActivity = snapshot?.recent_activity || {};
  const recentTrades = Array.isArray(recentActivity.orders) ? recentActivity.orders : [];
  const dailyChange = Number.isFinite(Number(summary.daily_change))
    ? Number(summary.daily_change)
    : Number(summary.paper_pnl);
  const exitPositions = Array.isArray(live?.exit_management?.positions) ? live.exit_management.positions : [];
  const snapshotAgeLabel = formatDataAge(snapshot?.generated_at || snapshot?.timestamp || null);
  const scannerAgeLabel = formatDataAge(live?.scanner_runtime?.last_scan_time || live?.scanner_runtime?.updated_at || null);
  const freshness = evaluateFreshness(snapshot?.generated_at || snapshot?.timestamp || null);
  const scannerFreshness = evaluateFreshness(live?.scanner_runtime?.last_scan_time || live?.status?.last_request_at || null, { staleSeconds: 30, criticalSeconds: 120 });
  const workflowState = snapshot?.control?.workflow?.status || summary.workflow_state || 'unknown';
  const botStatus = resolveBotStatus({ freshness, workflowState, status: live?.status });
  const brokerStatus = resolveBrokerStatus(live);
  const scannerStatus = resolveScannerStatus(live, scannerFreshness, snapshot?.control);

  const brokerAuthoritative = summary.broker_positions_authoritative || summary.open_positions_count_source === 'alpaca';
  const openPositionCount = Number.isFinite(Number(summary.open_positions_count))
    ? summary.open_positions_count
    : brokerAuthoritative
      ? 0
      : summary.derived_open_positions_count;
  const lastTradeAge = summary.last_trade_at ? formatRelativeTime(summary.last_trade_at) : null;
  updateStatusRail({ freshness, botStatus, brokerStatus, scannerStatus });
  $('openPositions').textContent = formatCount(openPositionCount);
  const staleDerivedCount = Number(summary.stale_derived_open_positions_count || 0);
  $('openPositionsHint').textContent = brokerAuthoritative
    ? staleDerivedCount > 0
      ? `Live broker count; ${formatCount(staleDerivedCount)} stale local`
      : 'Live broker count'
    : 'Derived fallback';
  renderBrokerSyncStatus();
  $('lastTradeAge').textContent = lastTradeAge || missingText;
  $('lastTradeHint').textContent = summary.last_trade_at
    ? `At ${formatClock(summary.last_trade_at)}`
    : `No live fill today. Snapshot ${snapshotAgeLabel}.`;
  $('workflowState').textContent = String(workflowState).toUpperCase();
  $('workflowHint').textContent = buildWorkflowHint(snapshot, snapshotAgeLabel, scannerAgeLabel);
  renderHotListStatus(snapshot);
  $('todayPnl').textContent = Number.isFinite(dailyChange) ? formatSignedCurrency(dailyChange) : 'No live data';
  $('todayPnl').className = Number.isFinite(dailyChange) && dailyChange >= 0 ? 'ok-text' : 'loss-text';
  $('buyingPower').textContent = formatCurrency(summary.account_buying_power ?? summary.account_cash) || 'No live account';
  $('buyingPowerHint').textContent = Number.isFinite(Number(summary.account_cash))
    ? `Cash ${formatCurrency(summary.account_cash)}`
    : `No live account data. Snapshot ${snapshotAgeLabel}.`;
  $('profitSummary').textContent = buildProfitNote(dailyChange, summary, snapshot);
  $('profitStatusPill').textContent = botStatus.label;
  $('profitStatusPill').className = `pill ${botStatus.pillTone}`;
  const statusCopy = Number.isFinite(dailyChange)
    ? `Daily Change is ${formatSignedCurrency(dailyChange)} from ${summary.daily_change_source || 'snapshot'}. Local history PnL is ${formatSignedCurrency(summary.paper_pnl)}.`
    : `Waiting for live performance data. Snapshot ${snapshotAgeLabel}.`;
  const versionWarning = dashboardVersionWarning(snapshot);
  const scannerCopy = scannerStatus.detail || `Scanner data ${scannerAgeLabel}.`;
  const waitingCopy = buildWaitingCopy(live?.scanner_runtime);
  $('profitStatusCopy').textContent = versionWarning || `${statusCopy} ${scannerCopy} ${waitingCopy} Broker ${brokerStatus.message}.`;
  $('profitStatusCopyAlt').textContent = versionWarning || `${statusCopy} ${scannerCopy} ${waitingCopy} Broker ${brokerStatus.message}.`;
  $('reportDate').textContent = snapshot?.live?.report?.date || snapshot?.live?.status?.started_at || missingText;
  renderPositionCard($('positionOne'), exitPositions[0], snapshot, { primary: true, slotLabel: 'Primary position' });
  renderPositionCard($('positionTwo'), exitPositions[1], snapshot, { primary: false, slotLabel: 'Secondary position' });
  renderRecentTrades(recentTrades, summary.last_trade_at);
  renderGuards(live?.session_guards, live?.setup_fatigue_summary);
  renderCandidateLifecycle(live?.candidate_lifecycle_summary || live?.scanner_runtime?.candidate_lifecycle_summary);
  renderExecutionQuality(live?.execution_quality_summary || live?.scanner_runtime?.execution_quality_summary || live?.execution_quality_state);
  renderDynamicTopSymbols(snapshot?.dynamicTopSymbols || [], snapshot);
}

function renderBrokerSyncStatus() {
  const button = $('syncBrokerStateButton');
  const status = $('brokerSyncStatus');
  if (!button || !status) return;
  button.disabled = state.brokerSyncBusy;
  button.textContent = state.brokerSyncBusy ? 'Syncing...' : 'Sync Broker State';
  if (state.brokerSyncBusy) {
    status.textContent = 'Syncing with Alpaca... scanner and trader stay running.';
    return;
  }
  const result = state.brokerSync;
  if (!result) {
    status.textContent = 'Re-read Alpaca without restarting scanner.';
    status.className = '';
    return;
  }
  const repaired = Array.isArray(result.repaired_local_state) ? result.repaired_local_state.length : 0;
  const slots = Number.isFinite(Number(result.available_position_slots_after))
    ? `${formatCount(result.available_position_slots_after)} slot(s)`
    : 'slots unknown';
  status.textContent = result.ok
    ? `Broker sync ${result.status || 'ok'} at ${formatClock(result.timestamp)}. Repaired ${repaired}; ${slots} after sync.`
    : `Broker sync failed: ${result.message || result.error || 'Alpaca unavailable'}`;
  status.className = result.ok ? 'sync-ok' : 'sync-error';
}

async function syncBrokerState() {
  if (!dashboardRequest || state.brokerSyncBusy) return;
  state.brokerSyncBusy = true;
  renderBrokerSyncStatus();
  try {
    const response = await dashboardRequest('/api/broker/sync', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
      body: JSON.stringify({ source: 'home-dashboard' }),
    });
    const result = await response.json();
    state.brokerSync = result;
    if (!response.ok) {
      throw new Error(result?.message || result?.error || `HTTP ${response.status}`);
    }
  } catch (error) {
    state.brokerSync = {
      ok: false,
      status: 'error',
      timestamp: new Date().toISOString(),
      message: error.message,
    };
  } finally {
    state.brokerSyncBusy = false;
    renderBrokerSyncStatus();
    await refreshSnapshot();
  }
}

function updateStatusRail({ freshness, botStatus, brokerStatus, scannerStatus }) {
  setTag($('botStatusPill'), botStatus.label, botStatus.tone);
  setTag($('dataFreshnessPill'), freshness.label, freshness.tone);
  setTag($('brokerConnectionPill'), brokerStatus.label, brokerStatus.tone);
  setTag($('scannerConnectionPill'), scannerStatus.label, scannerStatus.tone);
}

function setTag(element, label, tone) {
  if (!element) return;
  element.textContent = label;
  element.className = `tag ${tone}`;
}

function evaluateFreshness(value, { staleSeconds = 30, criticalSeconds = 120 } = {}) {
  const ageSeconds = ageInSeconds(value);
  if (!Number.isFinite(ageSeconds)) {
    return { label: 'WAITING', tone: 'amber', state: 'unknown', message: 'Freshness waiting.' };
  }
  if (ageSeconds >= criticalSeconds) {
    return { label: `CRITICAL ${formatAge(ageSeconds)}`, tone: 'red', state: 'critical', message: `Data is ${formatAge(ageSeconds)} old.` };
  }
  if (ageSeconds >= staleSeconds) {
    return { label: `STALE ${formatAge(ageSeconds)}`, tone: 'amber', state: 'stale', message: `Data is ${formatAge(ageSeconds)} old.` };
  }
  return { label: `LIVE ${formatAge(ageSeconds)}`, tone: 'green', state: 'fresh', message: `Data is ${formatAge(ageSeconds)} old.` };
}

function ageInSeconds(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, (Date.now() - date.getTime()) / 1000);
}

function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)}m`;
}

function formatDataAge(value) {
  const seconds = ageInSeconds(value);
  if (!Number.isFinite(seconds)) return 'age unknown';
  return `${formatAge(seconds)} old`;
}

function resolveBotStatus({ freshness, workflowState, status }) {
  if (freshness.state === 'critical') {
    return { label: 'CRITICAL', tone: 'red', pillTone: 'critical' };
  }
  if (freshness.state === 'stale') {
    return { label: 'STALE', tone: 'amber', pillTone: 'warn' };
  }
  if (freshness.state === 'unknown') {
    return { label: 'WAITING', tone: 'amber', pillTone: 'warn' };
  }
  const normalized = String(workflowState || status?.status || '').toLowerCase();
  if (normalized === 'running') return { label: 'LIVE', tone: 'green', pillTone: 'ok' };
  if (normalized === 'stopped' || normalized === 'paused') return { label: 'PAUSED', tone: 'amber', pillTone: 'warn' };
  if (normalized === 'error') return { label: 'ERROR', tone: 'red', pillTone: 'critical' };
  return { label: 'READY', tone: 'green', pillTone: 'ok' };
}

function resolveBrokerStatus(live) {
  const state = live?.broker_state_availability || {};
  const available = state.account_available !== false && state.positions_available !== false && state.open_orders_available !== false;
  if (available) return { label: 'BROKER OK', tone: 'green', message: 'connected' };
  const reason = Array.isArray(state.reason_codes) && state.reason_codes.length ? state.reason_codes[0] : 'BROKER DEGRADED';
  return { label: 'BROKER DEGRADED', tone: 'amber', message: reason };
}

function resolveScannerStatus(live, scannerFreshness, control = null) {
  const controlStatus = String(control?.scanner?.status || '').toLowerCase();
  if (controlStatus === 'stopped') {
    return { label: 'SCANNER STOPPED', tone: 'amber', message: 'stopped', detail: 'Scanner is stopped; Home is showing the last saved scanner data.' };
  }
  if (controlStatus === 'error') {
    return { label: 'SCANNER ERROR', tone: 'red', message: 'error', detail: 'Scanner process is reporting an error.' };
  }
  if (scannerFreshness.state === 'critical') {
    return { label: 'SCANNER CRITICAL', tone: 'red', message: scannerFreshness.message, detail: `Scanner ${scannerFreshness.message.toLowerCase()}` };
  }
  if (scannerFreshness.state === 'stale') {
    return { label: 'SCANNER STALE', tone: 'amber', message: scannerFreshness.message, detail: `Scanner ${scannerFreshness.message.toLowerCase()}` };
  }
  const scanTime = live?.scanner_runtime?.last_scan_time;
  if (!scanTime) return { label: 'WAITING', tone: 'amber', message: 'No scan yet.', detail: 'No scanner scan has been recorded yet.' };
  return { label: 'SCANNER OK', tone: 'green', message: scannerFreshness.message, detail: `Scanner ${scannerFreshness.message.toLowerCase()}` };
}

function buildWorkflowHint(snapshot, snapshotAgeLabel, scannerAgeLabel) {
  const scannerStatus = String(snapshot?.control?.scanner?.status || '').toLowerCase();
  const traderStatus = String(snapshot?.control?.trader?.status || '').toLowerCase();
  const waiting = buildWaitingCopy(snapshot?.live?.scanner_runtime);
  const parts = [`Snapshot ${snapshotAgeLabel}`];
  if (traderStatus) parts.push(`Trader ${traderStatus}`);
  if (scannerStatus) parts.push(`Scanner ${scannerStatus}`);
  if (!scannerStatus && scannerAgeLabel !== 'age unknown') parts.push(`Scanner data ${scannerAgeLabel}`);
  if (waiting) parts.push(waiting);
  return parts.join('. ');
}

function buildWaitingCopy(scannerRuntime = {}) {
  const waiting = scannerRuntime?.waiting_for_buy || {};
  const reason = String(waiting.reason_code || '').toUpperCase();
  const sizingMode = scannerRuntime?.position_sizing?.mode;
  const slotCount = scannerRuntime?.portfolio?.remaining_position_slots;
  const sizingCopy = sizingMode ? `Sizing ${sizingMode}` : null;
  if (reason === 'MAX_POSITION_SLOTS_FILLED') {
    const slotCopy = Number.isFinite(Number(slotCount)) ? `${formatCount(slotCount)} slot open` : 'slot occupied';
    return `Waiting: position slot occupied (${slotCopy}). ${sizingCopy || ''}`.trim();
  }
  if (reason) {
    return `Waiting: ${reason.replaceAll('_', ' ').toLowerCase()}. ${sizingCopy || ''}`.trim();
  }
  return sizingCopy || '';
}

function renderHotListStatus(snapshot = {}) {
  const stateTarget = $('hotListState');
  const hintTarget = $('hotListHint');
  if (!stateTarget || !hintTarget) return;
  const hotList = resolveHotListStatus(snapshot);
  stateTarget.textContent = hotList.label;
  stateTarget.className = hotList.tone;
  hintTarget.textContent = hotList.hint;
}

function resolveHotListStatus(snapshot = {}) {
  const status = snapshot?.hotListStatus || {};
  const rawStatus = String(status.status || 'off').toLowerCase();
  const label = rawStatus === 'active' || rawStatus === 'shadow' || rawStatus === 'running'
    ? 'RUNNING'
    : rawStatus === 'off' || rawStatus === 'disabled'
      ? 'OFF'
      : rawStatus.toUpperCase();
  const tone = label === 'RUNNING' && !status.stale
    ? 'ok-text'
    : label === 'OFF' || label === 'CLOSED'
      ? 'warn-text'
      : 'loss-text';
  const age = status.lastScoredAt ? formatDataAge(status.lastScoredAt) : 'not scored yet';
  const primaryCount = Number(status.primaryCount ?? status.regularWatchCount ?? status.dynamicCount ?? 0);
  const secondaryCount = Number(status.secondaryCount ?? status.moverCount ?? status.hotHotCount ?? 0);
  const primaryLabel = String(status.primaryLabel || 'approved symbols');
  const secondaryLabel = String(status.secondaryLabel || 'movers');
  const stale = status.stale && label !== 'CLOSED' ? 'Stale. ' : '';
  const error = status.lastError ? ` Error: ${status.lastError}` : '';
  return {
    label,
    tone,
    hint: `${label === 'CLOSED' ? 'Market closed. ' : ''}${stale}${formatCount(primaryCount)} ${primaryLabel}, ${formatCount(secondaryCount)} ${secondaryLabel}. ${age}.${error}`,
  };
}

function dashboardVersionWarning(snapshot) {
  const runtimeVersion = snapshot?.dashboard?.runtime_version;
  if (runtimeVersion && runtimeVersion !== DASHBOARD_FRONTEND_VERSION) {
    return `Dashboard code may be stale. Browser ${DASHBOARD_FRONTEND_VERSION}, server ${runtimeVersion}.`;
  }
  return null;
}

function renderRecentTrades(recentTrades, lastTradeAt) {
  const target = $('recentTradesList');
  const meta = $('recentTradesMeta');
  if (!target || !meta) return;
  if (!recentTrades.length) {
    meta.textContent = 'No recent trades';
    target.innerHTML = '<div class="empty-state">No recent trades are available in the snapshot.</div>';
    return;
  }
  meta.textContent = lastTradeAt ? `Last trade ${formatRelativeTime(lastTradeAt)}` : 'Recent trades available';
  target.innerHTML = recentTrades.map((trade) => `
    <article class="trade-card">
      <div class="trade-card-top">
        <strong><code>${escapeHtml(trade.symbol || missingText)}</code></strong>
        <span class="trade-pnl ${Number(trade.pnl) >= 0 ? 'ok' : 'warn'}">${escapeHtml(formatSignedCurrency(trade.pnl))}</span>
      </div>
      <div class="trade-card-grid">
        <span><b>When</b> ${escapeHtml(formatRelativeTime(trade.recorded_at) || formatClock(trade.recorded_at) || missingText)}</span>
        <span><b>Side</b> ${escapeHtml(trade.side || missingText)}</span>
        <span><b>Status</b> ${escapeHtml(trade.status || missingText)}</span>
        <span><b>Qty</b> ${escapeHtml(formatCount(trade.quantity))}</span>
      </div>
    </article>
  `).join('');
}

function renderGuards(sessionGuards, setupFatigueSummary) {
  const target = $('guardList');
  const meta = $('guardMeta');
  if (!target || !meta) return;
  const activeGuards = Array.isArray(sessionGuards?.active_guards) ? sessionGuards.active_guards : [];
  const pausedSetups = Array.isArray(setupFatigueSummary?.paused_setups) ? setupFatigueSummary.paused_setups : [];
  if (!activeGuards.length && !pausedSetups.length) {
    meta.textContent = 'No active guards';
    target.innerHTML = '<div class="empty-state">No guard state is currently active.</div>';
    return;
  }
  meta.textContent = `${activeGuards.length} guard(s), ${pausedSetups.length} paused setup(s)`;
  const guardCards = activeGuards.map((guard) => `
    <article class="trade-card guard-card">
      <div class="trade-card-top">
        <strong>${escapeHtml(guard.guard || 'guard')}</strong>
        <span class="trade-pnl warn">${escapeHtml((guard.expires_at ? `until ${formatClock(guard.expires_at)}` : 'active'))}</span>
      </div>
      <div class="trade-card-grid">
        <span><b>Reason</b> ${escapeHtml((guard.reason_codes || []).join(', ') || 'none')}</span>
        <span><b>Explan.</b> ${escapeHtml(guard.explanation || 'Active guard')}</span>
      </div>
    </article>
  `);
  const fatigueCards = pausedSetups.slice(0, 3).map((setup) => `
    <article class="trade-card guard-card">
      <div class="trade-card-top">
        <strong><code>${escapeHtml(setup.setup_key || missingText)}</code></strong>
        <span class="trade-pnl ${setup.active ? 'warn' : 'ok'}">${escapeHtml(formatSignedCurrency(setup.fatigue_score || 0))}</span>
      </div>
      <div class="trade-card-grid">
        <span><b>Pause</b> ${escapeHtml(setup.paused_until ? formatClock(setup.paused_until) : missingText)}</span>
        <span><b>Trades</b> ${escapeHtml(formatCount(setup.recent_trades))}</span>
      </div>
    </article>
  `);
  target.innerHTML = [...guardCards, ...fatigueCards].join('');
}

function renderCandidateLifecycle(summary) {
  const target = $('candidateLifecycleList');
  const meta = $('candidateLifecycleMeta');
  if (!target || !meta) return;
  const watched = Array.isArray(summary?.watched_candidates) ? summary.watched_candidates : [];
  const eligible = Array.isArray(summary?.eligible_candidates) ? summary.eligible_candidates : [];
  const blocked = Array.isArray(summary?.blocked_candidates) ? summary.blocked_candidates : [];
  const expired = Array.isArray(summary?.expired_candidates) ? summary.expired_candidates : [];
  if (!watched.length && !eligible.length && !blocked.length && !expired.length) {
    meta.textContent = 'No lifecycle state';
    target.innerHTML = '<div class="empty-state">No candidate lifecycle state is currently active.</div>';
    return;
  }
  meta.textContent = `${formatCount(summary?.eligible_count)} eligible, ${formatCount(summary?.blocked_count)} blocked`;
  const cards = [];
  const renderCandidateCard = (candidate, tone, label) => `
    <article class="trade-card guard-card lifecycle-card ${tone}">
      <div class="trade-card-top">
        <strong><code>${escapeHtml(candidate.symbol || missingText)}</code></strong>
        <span class="trade-pnl ${tone === 'good' ? 'ok' : tone === 'warn' ? 'warn' : 'neutral'}">${escapeHtml(label)}</span>
      </div>
      <div class="trade-card-grid">
        <span><b>Status</b> ${escapeHtml(candidate.status || missingText)}</span>
        <span><b>Rank</b> ${escapeHtml(formatNumber(candidate.decayed_rank ?? candidate.latest_rank ?? 0))}</span>
        <span><b>Seen</b> ${escapeHtml(formatCount(candidate.scans_seen))}</span>
        <span><b>Reason</b> ${escapeHtml((candidate.reason_codes || []).join(', ') || candidate.queue_reason || 'none')}</span>
      </div>
    </article>
  `;
  for (const candidate of eligible.slice(0, 2)) cards.push(renderCandidateCard(candidate, 'good', 'eligible'));
  for (const candidate of watched.slice(0, 2)) cards.push(renderCandidateCard(candidate, 'warn', 'watching'));
  for (const candidate of blocked.slice(0, 2)) cards.push(renderCandidateCard(candidate, 'bad', 'blocked'));
  for (const candidate of expired.slice(0, 2)) cards.push(renderCandidateCard(candidate, 'neutral', 'expired'));
  target.innerHTML = cards.join('');
}

function renderExecutionQuality(summary) {
  const target = $('executionQualityList');
  const meta = $('executionQualityMeta');
  if (!target || !meta) return;
  const recentBadFills = Array.isArray(summary?.recent_bad_fills) ? summary.recent_bad_fills : [];
  const topSymbols = Array.isArray(summary?.by_symbol) ? summary.by_symbol : [];
  const topSetups = Array.isArray(summary?.by_setup) ? summary.by_setup : [];
  if (!recentBadFills.length && !topSymbols.length && !topSetups.length) {
    meta.textContent = 'No execution quality state';
    target.innerHTML = '<div class="empty-state">No execution quality state is currently active.</div>';
    return;
  }
  meta.textContent = `${formatCount(summary?.total_trades)} trades, ${formatPercent(summary?.partial_fill_rate * 100 || 0, 0)} partial fills`;
  const cards = [];
  cards.push(`
    <article class="trade-card guard-card lifecycle-card neutral">
      <div class="trade-card-top">
        <strong>Overview</strong>
        <span class="trade-pnl neutral">${escapeHtml(formatNumber(summary?.average_quality_score ?? 0, 1))}</span>
      </div>
      <div class="trade-card-grid">
        <span><b>Avg quality</b> ${escapeHtml(formatNumber(summary?.average_quality_score ?? 0, 1))}</span>
        <span><b>Avg penalty</b> ${escapeHtml(formatNumber(summary?.average_execution_penalty_points ?? 0, 1))}</span>
        <span><b>Partial fills</b> ${escapeHtml(formatPercent(summary?.partial_fill_rate * 100 || 0, 0))}</span>
        <span><b>Reject / cancel</b> ${escapeHtml(formatPercent((summary?.rejection_rate || 0) * 100, 0))} / ${escapeHtml(formatPercent((summary?.cancellation_rate || 0) * 100, 0))}</span>
      </div>
    </article>
  `);
  const renderBucketCard = (bucket, label, tone) => `
    <article class="trade-card guard-card lifecycle-card ${tone}">
      <div class="trade-card-top">
        <strong><code>${escapeHtml(bucket.symbol || bucket.setup_key || bucket.key || missingText)}</code></strong>
        <span class="trade-pnl ${bucket.effective_penalty_points > 0 ? 'warn' : 'ok'}">${escapeHtml(formatNumber(bucket.effective_penalty_points ?? bucket.penalty_points ?? 0, 1))}</span>
      </div>
      <div class="trade-card-grid">
        <span><b>${escapeHtml(label)}</b> ${escapeHtml(bucket.trade_count || 0)}</span>
        <span><b>Quality</b> ${escapeHtml(formatNumber(bucket.average_quality_score ?? 0, 1))}</span>
        <span><b>Slip / drag</b> ${escapeHtml(formatNumber(bucket.average_slippage ?? 0, 2))} / ${escapeHtml(formatNumber(bucket.average_execution_drag ?? 0, 2))}</span>
        <span><b>Size</b> ${escapeHtml(formatPercent((bucket.effective_size_multiplier ?? bucket.size_multiplier ?? 1) * 100, 0))}</span>
      </div>
    </article>
  `;
  for (const bucket of topSymbols.slice(0, 2)) cards.push(renderBucketCard(bucket, 'Symbol', bucket.effective_penalty_points > 0 ? 'warn' : 'good'));
  for (const bucket of topSetups.slice(0, 2)) cards.push(renderBucketCard(bucket, 'Setup', bucket.effective_penalty_points > 0 ? 'warn' : 'good'));
  for (const bad of recentBadFills.slice(0, 2)) {
    cards.push(`
      <article class="trade-card guard-card lifecycle-card bad">
        <div class="trade-card-top">
          <strong><code>${escapeHtml(bad.symbol || missingText)}</code></strong>
          <span class="trade-pnl warn">${escapeHtml(bad.classification || 'unknown')}</span>
        </div>
        <div class="trade-card-grid">
          <span><b>Setup</b> ${escapeHtml(bad.setup_key || missingText)}</span>
          <span><b>Penalty</b> ${escapeHtml(formatNumber(bad.execution_penalty_points ?? 0, 1))}</span>
          <span><b>Slippage</b> ${escapeHtml(formatNumber(bad.slippage ?? 0, 2))}</span>
          <span><b>When</b> ${escapeHtml(formatRelativeTime(bad.recorded_at) || formatClock(bad.recorded_at) || missingText)}</span>
        </div>
      </article>
    `);
  }
  target.innerHTML = cards.join('');
}

function renderDynamicTopSymbols(items, snapshot = null) {
  const target = $('dynamicTopList');
  const meta = $('dynamicTopMeta');
  if (!target || !meta) return;
  const list = Array.isArray(items) ? items.slice(0, 10) : [];
  if (!list.length) {
    meta.textContent = 'No dynamic top symbols yet';
    target.innerHTML = '<div class="empty-state">No dynamic top symbols are available yet.</div>';
    return;
  }
  const signature = list.map((item) => `${item.symbol}:${item.score}:${item.source_rank}`).join('|');
  const changed = signature !== lastDynamicTopSignature;
  lastDynamicTopSignature = signature;
  const rowsWithMovement = annotateDynamicTopMovement(list, previousDynamicTopRows);
  previousDynamicTopRows = rowsWithMovement.map((item, index) => ({
    symbol: normalizeSymbolKey(item.symbol),
    rank: index + 1,
    score: Number(item.score),
  }));
  saveStoredDynamicTopRows(previousDynamicTopRows);
  const freshness = resolveDynamicTopFreshness(snapshot);
  const dataAgeLabel = formatDataAge(freshness.timestamp);
  const sourceLabel = freshness.source ? `${freshness.source} data` : 'Dynamic source data';
  meta.textContent = `${formatCount(list.length)} ranked by displayed score. ${sourceLabel} ${dataAgeLabel}.`;
  target.classList.toggle('is-updating', changed);
  if (changed) {
    window.setTimeout(() => target?.classList?.remove('is-updating'), 300);
  }
  target.innerHTML = `
      ${rowsWithMovement.map((item, index) => `
      <article class="top-symbol-card ${changed ? 'is-updating' : ''} ${escapeHtml(item.movementClass)}">
        <div class="top-symbol-card-head">
          <span class="top-symbol-rank">${String(index + 1).padStart(2, '0')}</span>
          <div class="top-symbol-main">
            <strong><code>${escapeHtml(item.symbol || missingText)}</code></strong>
            <span class="top-symbol-move">${escapeHtml(item.rankMoveLabel)}</span>
          </div>
          <div class="top-symbol-score-box">
            <span class="top-symbol-score">${escapeHtml(formatNumber(item.score, 1))}</span>
            <span class="top-symbol-delta">${escapeHtml(item.scoreDeltaLabel)}</span>
          </div>
        </div>
      </article>
    `).join('')}`;
}

function annotateDynamicTopMovement(list, previousRows) {
  const previousBySymbol = new Map((Array.isArray(previousRows) ? previousRows : [])
    .map((item) => [normalizeSymbolKey(item.symbol), item]));
  return list.map((item, index) => {
    const symbol = normalizeSymbolKey(item.symbol);
    const previous = previousBySymbol.get(symbol);
    const currentRank = index + 1;
    const currentScore = Number(item.score);
    if (!previous) {
      return {
        ...item,
        movementClass: 'movement-new',
        rankMoveLabel: 'New on list',
        scoreDeltaLabel: 'new',
      };
    }
    const previousRank = Number(previous.rank);
    const previousScore = Number(previous.score);
    const rankDelta = Number.isFinite(previousRank) ? previousRank - currentRank : 0;
    const scoreDelta = Number.isFinite(currentScore) && Number.isFinite(previousScore)
      ? currentScore - previousScore
      : 0;
    const movementClass = rankDelta > 0
      ? 'movement-up'
      : rankDelta < 0
        ? 'movement-down'
        : scoreDelta > 0
          ? 'movement-up'
          : scoreDelta < 0
            ? 'movement-down'
            : 'movement-flat';
    const rankMoveLabel = rankDelta > 0
      ? `Rank +${rankDelta}`
      : rankDelta < 0
        ? `Rank ${rankDelta}`
        : 'Rank same';
    return {
      ...item,
      movementClass,
      rankMoveLabel,
      scoreDeltaLabel: formatScoreDelta(scoreDelta),
    };
  });
}

function normalizeSymbolKey(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function formatScoreDelta(delta) {
  if (!Number.isFinite(delta)) return 'score n/a';
  if (Math.abs(delta) < 0.05) return 'score 0.0';
  return `score ${delta > 0 ? '+' : ''}${formatNumber(delta, 1)}`;
}

function loadStoredDynamicTopRows() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const parsed = JSON.parse(window.localStorage.getItem('workflow2.dynamicTop.previous') || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        symbol: normalizeSymbolKey(item?.symbol),
        rank: Number(item?.rank),
        score: Number(item?.score),
      }))
      .filter((item) => item.symbol);
  } catch (_) {
    return [];
  }
}

function saveStoredDynamicTopRows(rows) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem('workflow2.dynamicTop.previous', JSON.stringify(rows));
  } catch (_) {
    // Some embedded browsers disable storage; movement still works in memory.
  }
}

function resolveDynamicTopFreshness(snapshot = {}) {
  const freshness = snapshot?.dynamicTopFreshness || {};
  const runtime = snapshot?.live?.scanner_runtime || {};
  const timestamp = freshness.source_timestamp
    || freshness.scanner_timestamp
    || runtime.last_scan_time
    || runtime.updated_at
    || null;
  return {
    source: freshness.source || (timestamp ? 'Scanner Runtime' : null),
    timestamp,
  };
}

function formatSignedCurrency(value) {
  if (!Number.isFinite(Number(value))) return missingText;
  const abs = currencyFormatter.format(Math.abs(Number(value)));
  return Number(value) >= 0 ? `+${abs}` : `-${abs}`;
}

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return missingText;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function estimateNetAfterDrag(gross, drag) {
  if (!Number.isFinite(Number(gross))) return NaN;
  return Number(gross) - Number(drag || 0);
}

function buildProfitNote(gross, summary = {}, snapshot = {}) {
  const grossValue = Number(gross);
  if (!Number.isFinite(grossValue)) {
    return 'No live performance data yet.';
  }
  const workflow = String(summary.workflow_state || snapshot?.control?.workflow?.status || 'unknown').toLowerCase();
  const positions = Number.isFinite(Number(summary.open_positions_count)) ? Number(summary.open_positions_count) : null;
  const stop = formatCurrency(summary.stop_loss_dollars ?? snapshot?.regime?.stop_loss_dollars ?? 10);
  const start = formatCurrency(summary.trailing_profit_start_dollars ?? snapshot?.regime?.trailing_profit_start_dollars ?? 5);
  const giveback = formatCurrency(summary.trailing_profit_giveback_dollars ?? snapshot?.regime?.trailing_profit_giveback_dollars ?? 3);
  if (workflow !== 'running') {
    return `What matters now: workflow is ${workflow}; Daily Change is ${formatSignedCurrency(grossValue)} from Alpaca; open positions ${positions ?? '-'}. Stop ${stop}; trailing starts ${start}, gives back ${giveback}.`;
  }
  return `What matters now: workflow is running; Daily Change is ${formatSignedCurrency(grossValue)} from Alpaca; open positions ${positions ?? '-'}. Stop ${stop}; trailing starts ${start}, gives back ${giveback}.`;
}

function renderPositionCard(target, position, snapshot = {}, options = {}) {
  if (!target) return;
  if (!position) {
    target.className = 'position-card-large';
    target.innerHTML = '<div class="empty-state">No live position in this slot.</div>';
    return;
  }
  const visual = derivePositionVisual(position, snapshot);
  const stop = Number(position.stop_loss_total_dollars ?? position.stop_loss_dollars ?? snapshot?.regime?.stop_loss_dollars ?? 10);
  const stopPerShare = Number(position.stop_loss_per_share ?? position.base_stop_loss_dollars ?? snapshot?.regime?.stop_loss_dollars ?? NaN);
  const hardStopPrice = Number(position.hard_stop_price);
  target.className = `position-card-large ${visual.stateClass} ${options.primary ? 'is-primary' : ''}`.trim();
  target.style.setProperty('--meter-fill', `${visual.meterFill}%`);
  target.style.setProperty('--pressure-fill', `${visual.pressureFill}%`);
  target.style.setProperty('--trail-fill', `${visual.trailFill}%`);
  target.innerHTML = `
    <div class="position-hero">
      <div>
        <div class="position-status ${visual.statusTone}">${escapeHtml(options.slotLabel || 'Live position')}</div>
        <strong>${escapeHtml(position.symbol || '-')}</strong>
      </div>
      <span class="${visual.pnlTone}">${escapeHtml(formatSignedCurrency(position.unrealized_pl))}</span>
    </div>
    <div class="position-ladder">
      <div class="position-ladder-top">
        <span>Trail ribbon</span>
        <span>${escapeHtml(visual.trailLabel)}</span>
      </div>
      <div class="position-ribbon" aria-hidden="true">
        <div class="position-ribbon-fill"></div>
        <div class="position-ribbon-trail"></div>
      </div>
      <div class="position-ribbon-markers">
        <span>${escapeHtml(visual.trailStartLabel)}</span>
        <span>${escapeHtml(visual.trailPeakLabel)}</span>
        <span>${escapeHtml(visual.trailExitLabel)}</span>
      </div>
    </div>
    <div class="position-pressure">
      <div class="position-pressure-row">
        <span>Exit pressure</span>
        <span>${escapeHtml(visual.pressureLabel)}</span>
      </div>
      <div class="position-pressure-bar"><span></span></div>
    </div>
    <div class="trade-card-grid">
      <span><b>Qty</b> ${escapeHtml(formatCount(position.quantity))}</span>
      <span><b>Market value</b> ${escapeHtml(formatCurrency(position.market_value))}</span>
      <span><b>Avg price</b> ${escapeHtml(formatCurrency(position.avg_entry_price))}</span>
      <span><b>Current</b> ${escapeHtml(formatCurrency(position.current_price))}</span>
      <span><b>Stop price</b> ${escapeHtml(Number.isFinite(hardStopPrice) ? formatCurrency(hardStopPrice) : '-')}</span>
      <span><b>Stop / share</b> ${escapeHtml(Number.isFinite(stopPerShare) ? formatCurrency(stopPerShare) : '-')}</span>
      <span><b>Total stop</b> ${escapeHtml(formatCurrency(-Math.abs(stop)))}</span>
      <span><b>Distance</b> ${escapeHtml(formatSignedCurrency(position.distance_to_stop_dollars))}</span>
    </div>
    <div class="position-note">${escapeHtml(visual.note)}</div>
  `;
}

function derivePositionVisual(position, snapshot = {}) {
  const unrealized = Number(position?.unrealized_pl);
  const distanceToStop = Number(position?.distance_to_stop_dollars);
  const peak = Number(position?.trailing_peak_unrealized_pl);
  const trailTrigger = Number(position?.trailing_sell_if_unrealized_pl_at_or_below);
  const trailingActive = Boolean(position?.trailing_active);
  const trailingStart = Number(snapshot?.regime?.trailing_profit_start_dollars ?? 5);
  const stop = Number(position?.stop_loss_total_dollars ?? position?.stop_loss_dollars ?? snapshot?.regime?.stop_loss_dollars ?? 10);
  const hardStopPrice = Number(position?.hard_stop_price);
  const stopPriceText = Number.isFinite(hardStopPrice) ? ` at ${formatCurrency(hardStopPrice)}` : '';
  const distanceSafe = Number.isFinite(distanceToStop) ? distanceToStop : null;
  const trailSpan = Number.isFinite(peak) && Number.isFinite(trailTrigger) ? Math.max(0.01, peak - trailTrigger) : null;
  const currentTrailProgress = Number.isFinite(unrealized) && trailSpan !== null
    ? clamp((unrealized - trailTrigger) / trailSpan, 0, 1)
    : 0;
  const pressure = Number.isFinite(distanceSafe)
    ? clamp(1 - clamp(distanceSafe, 0, stop) / Math.max(stop, 0.01), 0, 1)
    : 0;

  let state = 'state-calm';
  let statusTone = 'ok';
  let pnlTone = Number.isFinite(unrealized) && unrealized >= 0 ? 'ok-text' : 'warn-text';
  let note = `Trailing is ${trailingActive ? 'active' : 'idle'}.`;
  if (Number.isFinite(unrealized) && unrealized < 0) {
    state = 'state-under-pressure';
    statusTone = 'critical';
    note = `Under water by ${formatSignedCurrency(unrealized)}. Position stop is ${formatSignedCurrency(-Math.abs(stop))}${stopPriceText}.`;
  } else if (trailingActive && Number.isFinite(peak) && peak >= trailingStart) {
    state = pressure > 0.72 ? 'state-near-exit' : 'state-profit-locked';
    statusTone = pressure > 0.72 ? 'warn' : 'ok';
    note = `Peak ${formatSignedCurrency(peak)} with trailing exit at ${formatSignedCurrency(trailTrigger)}.`;
  } else if (Number.isFinite(distanceSafe) && distanceSafe <= Math.max(0.25, stop * 0.15)) {
    state = 'state-near-exit';
    statusTone = 'warn';
    note = `Within ${formatSignedCurrency(distanceSafe)} of the stop.`;
  } else if (Number.isFinite(unrealized) && unrealized > 0) {
    state = 'state-active';
    statusTone = 'ok';
    note = `Positive and still building from ${formatSignedCurrency(unrealized)}.`;
  } else {
    note = trailingActive
      ? `Trailing is active with peak ${formatSignedCurrency(peak)}.`
      : `Trailing starts after ${formatSignedCurrency(trailingStart)}.`;
  }

  const trailFill = Number.isFinite(unrealized) && Number.isFinite(peak) && peak > 0
    ? clamp((unrealized / peak) * 100, 0, 100)
    : (trailingActive ? 100 : clamp((trailingStart / Math.max(trailingStart + Math.abs(distanceSafe || 0), 0.01)) * 100, 8, 88));

  return {
    stateClass: state,
    statusTone,
    pnlTone,
    note,
    pressureFill: Math.round(pressure * 100),
    pressureLabel: `${Math.round(pressure * 100)}%`,
    trailFill: Math.round(trailFill),
    meterFill: Math.round(trailFill),
    trailLabel: trailingActive ? 'Trailing live' : 'Awaiting trail',
    trailStartLabel: `Start ${formatSignedCurrency(trailingStart)}`,
    trailPeakLabel: `Peak ${formatSignedCurrency(peak)}`,
    trailExitLabel: `Exit ${formatSignedCurrency(trailTrigger)}`,
  };
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function formatPercent(value, decimals = 1) {
  if (!Number.isFinite(Number(value))) return missingText;
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(value) / 100);
}

function formatCount(value) {
  if (!Number.isFinite(Number(value))) return missingText;
  return numberFormatter.format(Number(value));
}

function formatReasonList(value) {
  if (!value) return missingText;
  const items = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items.join(', ') : missingText;
}

function formatNumber(value, decimals = 3) {
  if (!Number.isFinite(Number(value))) return missingText;
  return Number(value).toFixed(decimals);
}

function formatClock(value) {
  if (!value) return missingText;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelativeTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`;
  return `${Math.max(0, Math.round(diff / 60_000))}m ago`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

render(state.snapshot || {});
const syncBrokerStateButton = $('syncBrokerStateButton');
if (syncBrokerStateButton) {
  syncBrokerStateButton.addEventListener('click', syncBrokerState);
}
if (dashboardRequest) {
  refreshSnapshot();
  setInterval(refreshSnapshot, 5_000);
}
