const state = {
  snapshot: null,
  error: null,
};

const $ = (id) => document.getElementById(id);

const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

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
  const live = snapshot?.live || {};
  const policy = live?.policy?.policy || live?.policy || {};
  const configDrift = live?.config_drift || {};
  const effectiveness = live?.policy_effectiveness || {};
  const totalDecisions = Number(summary.approved_count || 0) + Number(summary.blocked_count || 0);
  const approvalRatio = totalDecisions > 0 ? Number(summary.approved_count || 0) / totalDecisions : NaN;
  const policySource = live?.policy?.source || snapshot?.file_snapshots?.live_policy?.payload_type || '-';
  const freshness = msAgo(snapshot?.timestamp);

  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('policySourceValue').textContent = String(policySource || '-');
  $('policyPill').textContent = effectLabel(effectiveness);
  $('policyPill').className = `pill ${snapshot?.alerts?.some((item) => /policy/i.test(item?.title || '')) ? 'warn' : 'ok'}`;
  $('profitExitValue').textContent = 'Live Market';
  $('profitFloorValue').textContent = formatCurrency(snapshot?.regime?.buy_notional_target ?? summary?.buy_notional_target ?? 150);
  $('lossExitValue').textContent = formatCurrency(snapshot?.regime?.stop_loss_dollars ?? summary?.stop_loss_dollars ?? 10);
  $('snapshotAgeValue').textContent = freshness || 'stale';
  $('pnlValue').textContent = formatSignedCurrency(summary.daily_change);
  $('approvedCountValue').textContent = formatCount(summary.approved_count);
  $('blockedCountValue').textContent = formatCount(summary.blocked_count);
  $('approvalRatioValue').textContent = Number.isFinite(approvalRatio) ? `${formatNumber(approvalRatio * 100, 1)}%` : '-';
  $('approvedBar').style.width = `${clamp(Number(summary.approved_count || 0), 0, 100)}%`;
  $('blockedBar').style.width = `${clamp(Number(summary.blocked_count || 0), 0, 100)}%`;
  $('approvedText').textContent = `${formatCount(summary.approved_count)} approvals`;
  $('blockedText').textContent = `${formatCount(summary.blocked_count)} blocks`;

  renderPolicyGrid(policy, configDrift);
  renderAlerts(snapshot?.alerts || [], state.error);
}

function renderPolicyGrid(policy, configDrift = {}) {
  const target = $('policyGrid');
  const rows = [
    ['Mode', 'Live Market'],
    ['Max open positions', formatCount(state.snapshot?.regime?.max_open_positions ?? policy?.maxOpenPositions)],
    ['Approved symbols', formatList(state.snapshot?.regime?.approved_symbols)],
    ['Buy cap', formatCurrency(state.snapshot?.regime?.buy_notional_target)],
    ['Min buy guard', formatCurrency(state.snapshot?.regime?.min_buy_notional)],
    ['Position stop', formatCurrency(state.snapshot?.regime?.stop_loss_dollars)],
    ['Trailing starts', formatCurrency(state.snapshot?.regime?.trailing_profit_start_dollars)],
    ['Trailing giveback', formatCurrency(state.snapshot?.regime?.trailing_profit_giveback_dollars)],
  ];
  const driftRows = Array.isArray(configDrift.items) && configDrift.items.length
    ? configDrift.items.map((item) => `
      <div class="policy-item drift-item">
        <span>Drift: ${escapeHtml(item.field)}</span>
        <strong>${escapeHtml(item.active_display)} -> ${escapeHtml(item.expected_display)}</strong>
      </div>
    `).join('')
    : `
      <div class="policy-item">
        <span>Config drift</span>
        <strong>None detected</strong>
      </div>
    `;
  target.innerHTML = rows.map(([label, value]) => `
    <div class="policy-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join('') + driftRows;
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
    target.innerHTML = `<div class="empty-state">No active warnings. The current policy snapshot is readable.</div>`;
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

function effectLabel(effectiveness) {
  const summary = effectiveness?.summary || effectiveness;
  if (!summary) return 'No data';
  if (summary?.warning || summary?.status === 'warning') return 'Warning';
  if (summary?.status === 'ok' || summary?.healthy) return 'Healthy';
  return 'Ready';
}

function formatCount(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return numberFormatter.format(Number(value));
}

function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return '-';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatSignedCurrency(value) {
  if (!Number.isFinite(Number(value))) return '-';
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(Math.abs(Number(value)));
  return Number(value) >= 0 ? `+${formatted}` : `-${formatted}`;
}

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatList(value) {
  if (!Array.isArray(value)) return value ? String(value) : '(empty)';
  return value.length ? value.join(', ') : '(empty)';
}

function formatPercent(value, decimals = 1) {
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(value) / 100);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function msAgo(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`;
  return `${Math.max(0, Math.round(diff / 60_000))}m ago`;
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
