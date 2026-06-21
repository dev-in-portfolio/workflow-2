const state = {
  snapshot: null,
  control: null,
  loading: true,
  error: null,
  actionMessage: null,
  actionKind: null,
  pendingAction: null,
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
  const [snapshotResult, controlResult] = await Promise.allSettled([
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
  ]);

  state.snapshot = snapshotResult.status === 'fulfilled' ? snapshotResult.value : null;
  state.control = controlResult.status === 'fulfilled' ? controlResult.value : null;
  state.error = snapshotResult.status === 'rejected'
    ? snapshotResult.reason?.message || 'Snapshot unavailable'
    : (controlResult.status === 'rejected' ? controlResult.reason?.message || 'Control state unavailable' : null);
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

function render() {
  const snapshot = state.snapshot || {};
  const control = state.control || {};
  const summary = snapshot.summary || {};
  const live = snapshot.live || {};
  const scannerRuntime = live.scanner_runtime || {};
  const regime = snapshot.regime || {};
  const trader = control.trader || {};
  const scanner = control.scanner || {};
  const workflow = control.workflow || {};
  const buttons = Array.from(document.querySelectorAll('[data-action]'));

  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('snapshotStamp').textContent = snapshot?.timestamp ? `updated ${formatTime(snapshot.timestamp)}` : '-';
  $('modeValue').textContent = summary.trader_mode || '-';
  $('regimeValue').textContent = regime.active || '-';
  $('pnlValue').textContent = formatSignedCurrency(summary.paper_pnl);
  $('profitExitValue').textContent = formatPercent(summary.profit_exit_threshold_pct, 1);
  $('scannerProfile').textContent = scanner.profile || workflow.desired_scanner_profile || 'not running';
  $('traderStatusPill').textContent = statusLabel(workflow.status || trader.status || summary.trader_status || (state.error ? 'degraded' : 'unknown'));
  $('traderStatusPill').className = `pill ${state.error || workflow.status === 'degraded' ? 'critical' : workflow.status === 'running' ? 'ok' : workflow.status === 'starting' ? 'warn' : 'warn'}`;
  $('actionStatus').innerHTML = state.actionMessage
    ? `<span class="tag ${state.actionKind === 'ok' ? 'green' : state.actionKind === 'error' ? 'red' : 'amber'}">${escapeHtml(state.actionKind || 'info')}</span> ${escapeHtml(state.actionMessage)}`
    : 'No action yet.';

  $('traderState').innerHTML = renderStateRows([
    ['workflow', workflow.status || '-'],
    ['desired scanner', workflow.desired_scanner_profile || '-'],
    ['issues', Array.isArray(workflow.issues) && workflow.issues.length ? workflow.issues.join(', ') : 'none'],
    ['status', trader.status || '-'],
    ['pid', trader.pid || '-'],
    ['port', trader.port || '-'],
    ['managed', boolLabel(trader.managed)],
    ['last action', formatTime(trader.last_action_at)],
    ['started', formatTime(trader.started_at)],
  ]);

  $('scannerState').innerHTML = renderStateRows([
    ['status', scanner.status || '-'],
    ['profile', scanner.profile || '-'],
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

  $('policyState').innerHTML = renderStateRows([
    ['today PnL', formatSignedCurrency(summary.paper_pnl)],
    ['blocked', formatCount(summary.blocked_count)],
    ['approved', formatCount(summary.approved_count)],
    ['heartbeat', formatHeartbeat(live?.status?.heartbeat_count, live?.status?.last_request_at, snapshot?.timestamp)],
    ['profit exit threshold', formatPercent(summary.profit_exit_threshold_pct, 1)],
    ['loss exit threshold', formatPercent(regime.loss_exit_threshold_pct, 2)],
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
}

function renderStateRows(rows) {
  return rows.map(([label, value]) => `
    <div class="state-row">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? '-')}</strong>
    </div>
  `).join('');
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

refreshAll();
setInterval(refreshAll, 5000);
