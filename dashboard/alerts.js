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
  const alerts = snapshot?.alerts || [];
  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('alertCountValue').textContent = String(alerts.length);
  $('alertPill').textContent = alerts.length ? 'Attention needed' : 'Clear';
  $('alertPill').className = `pill ${state.error || alerts.length ? 'warn' : 'ok'}`;
  $('alertSummary').textContent = summarizeAlerts(alerts, state.error);
  $('runtimeSummary').textContent = summarizeRuntime(snapshot);
  renderAlerts(alerts, state.error);
  renderSourceHealth(snapshot?.source_health || []);
  renderTimeline(snapshot?.recent_activity?.operator_timeline || []);
}

function summarizeRuntime(snapshot) {
  const scanner = snapshot?.live?.scanner_runtime || {};
  const allocation = scanner.allocation || {};
  const exitState = snapshot?.live?.exit_management?.state || 'unknown';
  const topSkip = topSkipReason(scanner.skip_summary);
  if (!scanner.last_scan_time) {
    return `Scanner runtime: no fresh scan file. Exit management: ${exitState}.`;
  }
  const allocationText = allocation.accepted === false
    ? allocation.reason
    : formatCurrency(allocation.notional);
  return `Scanner ${formatAge(scanner.last_scan_time)} ago. Posted ${scanner.posted_count ?? 0}, approved ${scanner.approved_count ?? 0}. Top skip: ${topSkip}. Allocation: ${allocationText}. Exits: ${exitState}.`;
}

function topSkipReason(skipSummary) {
  if (!skipSummary || typeof skipSummary !== 'object') return 'none';
  const entries = Object.entries(skipSummary).filter(([, count]) => Number(count) > 0);
  if (!entries.length) return 'none';
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  return `${entries[0][0]} (${entries[0][1]})`;
}

function formatAge(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s`;
  return `${Math.max(0, Math.round(diff / 60_000))}m`;
}

function formatCurrency(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(value));
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
    target.innerHTML = `<div class="empty-state">No active warnings. The current snapshot looks healthy.</div>`;
    return;
  }
  target.innerHTML = merged.slice(0, 12).map((alert) => `
    <div class="alert-card">
      <strong>${escapeHtml(alert.title || 'Notice')}</strong>
      <small>${escapeHtml(alert.message || 'No details')}</small>
      <div style="margin-top:8px"><span class="tag ${alert.kind === 'critical' ? 'red' : alert.kind === 'warning' ? 'amber' : 'cyan'}">${escapeHtml(alert.kind || 'info')}</span></div>
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

function renderTimeline(items) {
  const target = $('operatorTimeline');
  if (!target) return;
  if (!items.length) {
    target.innerHTML = `<div class="empty-state">No timeline events recorded yet.</div>`;
    return;
  }
  target.innerHTML = items.slice(0, 8).map((item) => `
    <div class="timeline-item">
      <strong>${escapeHtml(item.title || item.type || 'Event')}</strong>
      <small>${escapeHtml(formatTime(item.timestamp))} | ${escapeHtml(item.message || item.source || '')}</small>
    </div>
  `).join('');
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function summarizeAlerts(alerts, error) {
  if (error) return `Snapshot failed: ${error}`;
  if (!alerts.length) return 'No active warnings detected in the read-only sources.';
  return `${alerts.length} warning${alerts.length === 1 ? '' : 's'} currently visible.`;
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
