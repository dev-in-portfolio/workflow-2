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
  const status = live?.status || {};
  const scannerRuntime = live?.scanner_runtime || {};
  const exitManagement = live?.exit_management || {};
  const regime = snapshot?.regime || {};
  const freshness = msAgo(snapshot?.timestamp || status?.timestamp);

  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('regimeValue').textContent = regime.active || '-';
  $('freshnessValue').textContent = freshness || 'stale';
  $('statusPill').textContent = statusLabel(summary.trader_status);
  $('statusPill').className = `pill ${status?.status === 'ok' ? 'ok' : status?.status ? 'warn' : 'critical'}`;
  $('traderStateValue').textContent = status?.status || summary.trader_status || '-';
  $('modeValue').textContent = summary.trader_mode || '-';
  $('regimeValue').textContent = regime.active || '-';
  $('uptimeValue').textContent = formatMinutes(summary.uptime_minutes);
  $('heartbeatValue').textContent = formatHeartbeat(status?.heartbeat_count, status?.last_request_at, snapshot?.timestamp);
  $('marketOpenValue').textContent = regime.market_open ? 'Yes' : 'No';
  $('scannerScanValue').textContent = scannerRuntime.last_scan_time ? `${msAgo(scannerRuntime.last_scan_time)} ago` : '-';
  $('scannerSkipValue').textContent = topSkipReason(scannerRuntime.skip_summary);
  $('exitManagementValue').textContent = String(exitManagement.state || '-').toUpperCase();
  $('dashboardUrlValue').textContent = snapshot?.dashboard?.base_url || '-';
  $('snapshotTimeValue').textContent = formatTime(snapshot?.timestamp);

  renderSourceHealth(snapshot?.source_health || []);
  renderTimeline(snapshot?.recent_activity?.operator_timeline || []);
  renderAlerts(snapshot?.alerts || [], state.error);
}

function topSkipReason(skipSummary) {
  if (!skipSummary || typeof skipSummary !== 'object') return '-';
  const entries = Object.entries(skipSummary).filter(([, count]) => Number(count) > 0);
  if (!entries.length) return 'None';
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return `${entries[0][0]} (${entries[0][1]})`;
}

function renderTimeline(items) {
  const target = $('operatorTimeline');
  if (!target) return;
  if (!items.length) {
    target.innerHTML = `<div class="empty-state">No operator timeline events yet.</div>`;
    return;
  }
  target.innerHTML = items.slice(0, 10).map((item) => `
    <div class="timeline-item">
      <strong>${escapeHtml(item.title || item.type || 'Event')}</strong>
      <small>${escapeHtml(formatTime(item.timestamp))} | ${escapeHtml(item.message || item.source || '')}</small>
    </div>
  `).join('');
}

function renderSourceHealth(items) {
  const target = $('sourceHealth');
  if (!items.length) {
    target.innerHTML = `<div class="empty-state">No source health data found yet.</div>`;
    return;
  }
  target.innerHTML = items.map((item) => `
    <div class="source-card">
      <strong>${escapeHtml(item.source || 'unknown')}</strong>
      <div class="status ${item.ok ? 'ok' : item.status === 'missing' ? 'warn' : 'bad'}">${escapeHtml(item.ok ? 'ok' : item.status || 'unknown')}</div>
      <small>${escapeHtml(item.error || item.kind || 'read-only')}</small>
    </div>
  `).join('');
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
    target.innerHTML = `<div class="empty-state">No active warnings. The status view is current enough to read.</div>`;
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

function formatMinutes(value) {
  if (!Number.isFinite(Number(value))) return '-';
  const mins = Number(value);
  if (mins < 60) return `${numberFormatter.format(mins)} min`;
  return `${numberFormatter.format(mins / 60)} h`;
}

function formatHeartbeat(count, lastRequestAt, snapshotTimestamp) {
  const parts = [];
  if (Number.isFinite(Number(count))) {
    parts.push(`${numberFormatter.format(Number(count))} beats`);
  }
  const freshness = msAgo(lastRequestAt || snapshotTimestamp);
  if (freshness) {
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
