const state = {
  snapshot: null,
  loading: true,
  error: null,
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
const DASHBOARD_FRONTEND_VERSION = '2026-06-21.live-market-simplified.1';

async function refreshSnapshot() {
  try {
    const response = await fetch('/api/home-summary', { cache: 'no-store' });
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
    render(null);
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
  const freshness = evaluateFreshness(snapshot);
  const scannerFreshness = evaluateFreshness(live?.scanner_runtime?.last_scan_time || live?.status?.last_request_at || null, { staleSeconds: 30, criticalSeconds: 120 });
  const workflowState = summary.workflow_state || snapshot?.control?.workflow?.status || 'unknown';
  const botStatus = resolveBotStatus({ freshness, workflowState, status: live?.status });
  const brokerStatus = resolveBrokerStatus(live);
  const scannerStatus = resolveScannerStatus(live, scannerFreshness);

  const openPositionCount = Number.isFinite(Number(summary.open_positions_count))
    ? summary.open_positions_count
    : summary.derived_open_positions_count;
  const lastTradeAge = summary.last_trade_at ? formatRelativeTime(summary.last_trade_at) : null;
  updateStatusRail({ freshness, botStatus, brokerStatus, scannerStatus });
  $('openPositions').textContent = formatCount(openPositionCount);
  $('openPositionsHint').textContent = summary.open_positions_count_source === 'alpaca'
    ? 'Live broker count'
    : 'Derived fallback';
  $('lastTradeAge').textContent = lastTradeAge || missingText;
  $('lastTradeHint').textContent = summary.last_trade_at ? `At ${formatClock(summary.last_trade_at)}` : 'No local fill today';
  $('workflowState').textContent = String(workflowState).toUpperCase();
  $('workflowHint').textContent = 'Live Market';
  $('todayPnl').textContent = formatSignedCurrency(dailyChange);
  $('todayPnl').className = Number.isFinite(dailyChange) && dailyChange >= 0 ? 'ok-text' : 'loss-text';
  $('buyingPower').textContent = formatCurrency(summary.account_buying_power ?? summary.account_cash);
  $('buyingPowerHint').textContent = Number.isFinite(Number(summary.account_cash)) ? `Cash ${formatCurrency(summary.account_cash)}` : 'Alpaca account';
  $('profitSummary').textContent = buildProfitNote(dailyChange, summary, snapshot);
  $('profitStatusPill').textContent = botStatus.label;
  $('profitStatusPill').className = `pill ${botStatus.pillTone}`;
  const statusCopy = Number.isFinite(dailyChange)
    ? `Daily Change is ${formatSignedCurrency(dailyChange)} from ${summary.daily_change_source || 'snapshot'}. Local history PnL is ${formatSignedCurrency(summary.paper_pnl)}.`
    : 'Waiting for live performance data.';
  const versionWarning = dashboardVersionWarning(snapshot);
  $('profitStatusCopy').textContent = versionWarning || `${statusCopy} ${freshness.message} Broker ${brokerStatus.message}. Scanner ${scannerStatus.message}.`;
  $('profitStatusCopyAlt').textContent = versionWarning || `${statusCopy} ${freshness.message} Broker ${brokerStatus.message}. Scanner ${scannerStatus.message}.`;
  $('reportDate').textContent = snapshot?.live?.report?.date || snapshot?.live?.status?.started_at || missingText;
  renderPositionCard($('positionOne'), exitPositions[0], snapshot, { primary: true, slotLabel: 'Primary position' });
  renderPositionCard($('positionTwo'), exitPositions[1], snapshot, { primary: false, slotLabel: 'Secondary position' });
  renderRecentTrades(recentTrades, summary.last_trade_at);
  renderGuards(live?.session_guards, live?.setup_fatigue_summary);
  renderCandidateLifecycle(live?.candidate_lifecycle_summary || live?.scanner_runtime?.candidate_lifecycle_summary);
  renderExecutionQuality(live?.execution_quality_summary || live?.scanner_runtime?.execution_quality_summary || live?.execution_quality_state);
  renderDynamicTopSymbols(snapshot.dynamicTopSymbols || []);
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

function resolveScannerStatus(live, scannerFreshness) {
  if (scannerFreshness.state === 'critical') {
    return { label: 'SCANNER CRITICAL', tone: 'red', message: scannerFreshness.message };
  }
  if (scannerFreshness.state === 'stale') {
    return { label: 'SCANNER STALE', tone: 'amber', message: scannerFreshness.message };
  }
  const scanTime = live?.scanner_runtime?.last_scan_time;
  if (!scanTime) return { label: 'WAITING', tone: 'amber', message: 'No scan yet.' };
  return { label: 'SCANNER OK', tone: 'green', message: scannerFreshness.message };
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

function renderDynamicTopSymbols(items) {
  const target = $('dynamicTopList');
  const meta = $('dynamicTopMeta');
  if (!target || !meta) return;
  const list = Array.isArray(items) ? items.slice(0, 10) : [];
  if (!list.length) {
    meta.textContent = 'No dynamic top symbols yet';
    target.innerHTML = '<div class="empty-state">No dynamic top symbols are available yet.</div>';
    return;
  }
  meta.textContent = `${formatCount(list.length)} dynamic top symbol${list.length === 1 ? '' : 's'} ranked from the active source system`;
  target.innerHTML = list.map((item, index) => {
    const provenance = Array.isArray(item.source_lists) ? item.source_lists : [];
    const provenanceText = provenance.length ? provenance.join(' · ') : item.source || 'unknown';
    return `
      <article class="top-symbol-card">
        <div class="top-symbol-card-head">
          <span class="top-symbol-rank">${String(index + 1).padStart(2, '0')}</span>
          <strong><code>${escapeHtml(item.symbol || missingText)}</code></strong>
          <span class="tag cyan">${escapeHtml(item.source || 'unknown')}</span>
        </div>
        <div class="top-symbol-card-grid">
          <span><b>Score</b> ${escapeHtml(formatNumber(item.score, 1))}</span>
          <span><b>Source rank</b> ${escapeHtml(formatCount(item.source_rank))}</span>
          <span class="top-symbol-provenance"><b>Provenance</b> ${escapeHtml(provenanceText)}</span>
          <span><b>Reason codes</b> ${escapeHtml(formatReasonList(item.reason_codes))}</span>
        </div>
      </article>
    `;
  }).join('');
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
  const stop = Number(snapshot?.regime?.stop_loss_dollars ?? 10);
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
      <span><b>Stop</b> ${escapeHtml(formatCurrency(-Math.abs(stop)))}</span>
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
  const stop = Number(snapshot?.regime?.stop_loss_dollars ?? 10);
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
    note = `Under water by ${formatSignedCurrency(unrealized)}. The stop remains ${formatSignedCurrency(-Math.abs(stop))}.`;
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

refreshSnapshot();
setInterval(refreshSnapshot, 5_000);
