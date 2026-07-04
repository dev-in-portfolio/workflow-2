const state = {
  snapshot: null,
  error: null,
};

const $ = (id) => document.getElementById(id);
const dashboardRequest = createDashboardRequest();
const bootstrapSnapshot = getDashboardSnapshotForPage('status');

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

const numberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

async function refreshSnapshot() {
  if (!dashboardRequest) {
    if (state.snapshot) {
      render(state.snapshot);
    }
    return;
  }
  try {
    const response = await dashboardRequest('/api/snapshot', { cache: 'no-store' });
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
  const summary = snapshot?.summary || {};
  const live = snapshot?.live || {};
  const status = live?.status || {};
  const scannerRuntime = live?.scanner_runtime || {};
  const exitManagement = live?.exit_management || {};
  const regime = snapshot?.regime || {};
  const freshness = evaluateFreshness(snapshot?.timestamp || status?.timestamp);
  const heartbeat = evaluateFreshness(status?.last_request_at || snapshot?.timestamp || null, { staleSeconds: 30, criticalSeconds: 120 });

  $('dashboardPort').textContent = snapshot?.dashboard?.port ? String(snapshot.dashboard.port) : '-';
  $('traderBaseUrl').textContent = snapshot?.dashboard?.trader_base_url || 'unresolved';
  $('regimeValue').textContent = regime.active || '-';
  $('freshnessValue').textContent = freshness.label;
  $('freshnessValue').className = `freshness-${freshness.state}`;
  $('statusPill').textContent = statusLabel({ freshness, status, summary });
  $('statusPill').className = `pill ${statusPillTone({ freshness, status, summary })}`;
  $('traderStateValue').textContent = status?.status || summary.trader_status || '-';
  $('modeValue').textContent = summary.trader_mode || '-';
  $('regimeValue').textContent = regime.active || '-';
  $('uptimeValue').textContent = formatMinutes(summary.uptime_minutes);
  $('heartbeatValue').textContent = formatHeartbeat(status?.heartbeat_count, status?.last_request_at, snapshot?.timestamp, heartbeat);
  $('marketOpenValue').textContent = regime.market_open ? 'Yes' : 'No';
  $('scannerScanValue').textContent = scannerRuntime.last_scan_time ? msAgo(scannerRuntime.last_scan_time) : '-';
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

function evaluateFreshness(value, { staleSeconds = 30, criticalSeconds = 120 } = {}) {
  const seconds = ageSeconds(value);
  if (!Number.isFinite(seconds)) return { label: 'WAITING', state: 'unknown' };
  if (seconds >= criticalSeconds) return { label: `CRITICAL ${shortAge(seconds)}`, state: 'critical' };
  if (seconds >= staleSeconds) return { label: `STALE ${shortAge(seconds)}`, state: 'warn' };
  return { label: `LIVE ${shortAge(seconds)}`, state: 'fresh' };
}

function ageSeconds(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, (Date.now() - date.getTime()) / 1000);
}

function shortAge(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)}m`;
}

function msAgo(value) {
  const seconds = ageSeconds(value);
  if (!Number.isFinite(seconds)) return null;
  return shortAge(seconds) + ' ago';
}

function statusLabel({ freshness, status, summary }) {
  if (freshness.state === 'critical') return 'CRITICAL';
  if (freshness.state === 'warn') return 'STALE';
  if (status?.status) return String(status.status).toUpperCase();
  if (summary?.trader_status) return String(summary.trader_status).toUpperCase();
  return 'UNKNOWN';
}

function statusPillTone({ freshness, status }) {
  if (freshness.state === 'critical') return 'critical';
  if (freshness.state === 'warn') return 'warn';
  if (status?.status === 'ok') return 'ok';
  if (status?.status) return 'warn';
  return freshness.state === 'unknown' ? 'warn' : 'ok';
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
