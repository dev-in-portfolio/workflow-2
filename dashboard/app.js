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
const DASHBOARD_FRONTEND_VERSION = '2026-06-20.reliability-complete.1';

async function refreshSnapshot() {
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
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
  const executionDrag = Number(live?.report?.execution_drag || 0);
  const profitFloorDollars = Number.isFinite(Number(summary.profit_exit_floor_dollars))
    ? Number(summary.profit_exit_floor_dollars)
    : Number(snapshot?.regime?.profit_exit_floor_dollars ?? 1);

  const openPositionCount = Number.isFinite(Number(summary.open_positions_count))
    ? summary.open_positions_count
    : summary.derived_open_positions_count;
  const lastTradeAge = summary.last_trade_at ? formatRelativeTime(summary.last_trade_at) : null;
  const workflowState = summary.workflow_state || snapshot?.control?.workflow?.status || 'unknown';
  $('openPositions').textContent = formatCount(openPositionCount);
  $('openPositionsHint').textContent = summary.open_positions_count_source === 'alpaca'
    ? 'Live broker count'
    : 'Derived fallback';
  $('lastTradeAge').textContent = lastTradeAge || missingText;
  $('lastTradeHint').textContent = summary.last_trade_at ? `At ${formatClock(summary.last_trade_at)}` : 'No local fill today';
  $('workflowState').textContent = String(workflowState).toUpperCase();
  $('workflowHint').textContent = snapshot?.control?.scanner?.profile
    ? `Scanner ${snapshot.control.scanner.profile}`
    : `Desired ${summary.scanner_profile || 'none'}`;
  $('todayPnl').textContent = formatSignedCurrency(dailyChange);
  $('profitSummary').textContent = buildProfitNote(dailyChange, executionDrag, summary.profit_exit_threshold_pct, profitFloorDollars, summary, snapshot);
  $('profitStatusPill').textContent = Number.isFinite(dailyChange)
    ? (dailyChange >= 0 ? 'Positive' : 'Negative')
    : 'No data';
  $('profitStatusPill').className = `pill ${Number.isFinite(dailyChange) ? (dailyChange >= 0 ? 'ok' : 'warn') : 'warn'}`;
  const statusCopy = Number.isFinite(dailyChange)
    ? `Daily Change is ${formatSignedCurrency(dailyChange)} from ${summary.daily_change_source || 'snapshot'}. Local paper PnL is ${formatSignedCurrency(summary.paper_pnl)}.`
    : 'Waiting for live performance data.';
  const versionWarning = dashboardVersionWarning(snapshot);
  $('profitStatusCopy').textContent = versionWarning || statusCopy;
  $('profitStatusCopyAlt').textContent = versionWarning || statusCopy;
  $('reportDate').textContent = snapshot?.live?.overnight_status?.report_date || snapshot?.live?.status?.started_at || missingText;
  renderRecentTrades(recentTrades, summary.last_trade_at);
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

function buildProfitNote(gross, drag, floorPct, floorDollars = 1, summary = {}, snapshot = {}) {
  const grossValue = Number(gross);
  if (!Number.isFinite(grossValue)) {
    return 'No live performance data yet.';
  }
  const floorText = Number.isFinite(Number(floorPct))
    ? `${formatPercent(floorPct, 1)} floor and ${formatCurrency(floorDollars)} net minimum`
    : 'profit floor';
  const workflow = String(summary.workflow_state || snapshot?.control?.workflow?.status || 'unknown').toLowerCase();
  const positions = Number.isFinite(Number(summary.open_positions_count)) ? Number(summary.open_positions_count) : null;
  if (workflow !== 'running') {
    return `What matters now: workflow is ${workflow}; Daily Change is ${formatSignedCurrency(grossValue)} from Alpaca; open positions ${positions ?? '-'}. Exit rule is ${floorText}.`;
  }
  return `What matters now: workflow is running; Daily Change is ${formatSignedCurrency(grossValue)} from Alpaca; open positions ${positions ?? '-'}. Exit rule is ${floorText}.`;
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
