const state = {
  snapshot: null,
  error: null,
};

const $ = (id) => document.getElementById(id);

async function refreshSnapshot() {
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    const snapshot = await response.json();
    if (!response.ok) {
      throw new Error(snapshot?.message || snapshot?.error || `HTTP ${response.status}`);
    }
    state.snapshot = snapshot;
    state.error = null;
    render(snapshot);
  } catch (error) {
    state.error = error.message;
    render(null);
  }
}

function render(snapshot) {
  const summary = snapshot?.summary || {};
  const regime = snapshot?.regime || {};
  const exitManagement = snapshot?.live?.exit_management || {};

  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('regimeValue').textContent = 'Live Market';
  $('rulePill').textContent = exitManagement.state ? String(exitManagement.state).toUpperCase() : 'No data';
  $('rulePill').className = `pill ${state.error || exitManagement.managed === false ? 'critical' : 'ok'}`;
  $('profitExitThreshold').textContent = formatPercent(regime.sell_profit_threshold_pct ?? summary.sell_profit_threshold_pct ?? 5);
  $('profitExitFloor').textContent = formatCurrency(regime.sell_net_profit_floor_dollars ?? summary.sell_net_profit_floor_dollars ?? 1);
  $('lossExitThreshold').textContent = formatCurrency(regime.stop_loss_dollars ?? summary.stop_loss_dollars ?? 10);
  $('thresholdDetails').innerHTML = `
    <div><strong>Market open</strong> ${regime.market_open ? 'Yes' : 'No'}</div>
    <div><strong>Exit manager</strong> ${escapeHtml(exitManagement.state || '-')}</div>
    <div><strong>Report date</strong> ${escapeHtml(snapshot?.live?.report?.date || snapshot?.live?.overnight_status?.report_date || '-')}</div>
  `;
  renderRuleGrid(snapshot, exitManagement);
  renderAlerts(snapshot?.alerts || [], state.error);
}

function renderRuleGrid(snapshot, exitManagement = {}) {
  const regime = snapshot?.regime || {};
  const rows = [
    ['Mode', 'Live Market'],
    ['Sell-profit threshold', formatPercent(regime.sell_profit_threshold_pct)],
    ['Sell-profit floor', formatCurrency(regime.sell_net_profit_floor_dollars)],
    ['Position stop', formatCurrency(regime.stop_loss_dollars)],
    ['Stop notional percent', formatPercent(regime.stop_loss_notional_pct)],
    ['Stop max', formatCurrency(regime.stop_loss_max_dollars)],
    ['Trailing starts', formatCurrency(regime.trailing_profit_start_dollars)],
    ['Trailing giveback', formatCurrency(regime.trailing_profit_giveback_dollars)],
    ['Approved symbols', Array.isArray(regime.approved_symbols) ? regime.approved_symbols.join(', ') : '-'],
    ['Market open', regime.market_open ? 'Yes' : 'No'],
    ['Exit manager', exitManagement.state || '-'],
    ['Exit reasons', Array.isArray(exitManagement.reasons) && exitManagement.reasons.length ? exitManagement.reasons.join(', ') : 'none'],
  ];
  const positionRows = Array.isArray(exitManagement.positions) && exitManagement.positions.length
    ? exitManagement.positions.map((position) => `
      <div class="policy-item">
        <span>${escapeHtml(position.symbol || 'position')}</span>
        <strong>${escapeHtml(position.reason || '-')}: ${escapeHtml(formatCurrency(position.unrealized_pl))}; stop distance ${escapeHtml(formatCurrency(position.distance_to_stop_dollars))}</strong>
      </div>
    `).join('')
    : `
      <div class="policy-item">
        <span>Live positions</span>
        <strong>None</strong>
      </div>
    `;
  $('ruleGrid').innerHTML = rows.map(([label, value]) => `
    <div class="policy-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join('') + positionRows;
}

function renderAlerts(alerts, error) {
  const target = $('alerts');
  const merged = [...alerts];
  if (error) {
    merged.unshift({
      kind: 'critical',
      title: 'Snapshot error',
      message: error,
    });
  }
  if (!merged.length) {
    target.innerHTML = `<div class="empty-state">No active warnings. The exit-rule snapshot is current enough to read.</div>`;
    return;
  }
  target.innerHTML = merged.slice(0, 8).map((alert) => `
    <div class="alert-card">
      <strong>${escapeHtml(alert.title || 'Notice')}</strong>
      <small>${escapeHtml(alert.message || 'No details')}</small>
      <div style="margin-top:8px"><span class="tag ${alert.kind === 'critical' ? 'red' : alert.kind === 'warning' ? 'amber' : 'cyan'}">${escapeHtml(alert.kind || 'info')}</span></div>
    </div>
  `).join('');
}

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatPercent(value, decimals = 1) {
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(value) / 100);
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

refreshSnapshot();
setInterval(refreshSnapshot, 5000);
