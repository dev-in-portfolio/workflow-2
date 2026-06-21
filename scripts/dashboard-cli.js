const path = require('path');
const { spawn } = require('child_process');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { createDashboardServer, DEFAULT_DASHBOARD_PORT, resolveDashboardPort } = require('../src/dashboard-server');
const { nowIso } = require('../src/util');

function listenWithFallback(server, preferredPort, options = {}) {
  const hostname = options.hostname || '127.0.0.1';
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 25) || 25);
  let attempts = 0;
  let currentPort = preferredPort;
  let listening = false;

  const onListening = () => {
    listening = true;
    server.off('error', onError);
  };

  const onError = (error) => {
    if (!listening && error && error.code === 'EADDRINUSE' && attempts < maxAttempts - 1) {
      attempts += 1;
      currentPort += 1;
      server.listen(currentPort, hostname);
      return;
    }
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  };

  server.on('listening', onListening);
  server.on('error', onError);
  server.listen(currentPort, hostname);
  return server;
}

function main(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const dashboardPort = resolveDashboardPort(runtimeEnv) || DEFAULT_DASHBOARD_PORT;
  const server = createDashboardServer({
    env: runtimeEnv,
    runtimeEnv,
    port: dashboardPort,
    dashboardDir: path.join(process.cwd(), 'dashboard'),
    dataDir: path.join(process.cwd(), 'data'),
    cacheMaxAgeMs: 2_000,
  });

  listenWithFallback(server, dashboardPort, { hostname: '127.0.0.1' });

  server.on('listening', () => {
    const address = server.address();
    const resolvedPort = typeof address === 'object' && address ? address.port : dashboardPort;
    const baseUrl = `http://127.0.0.1:${resolvedPort}`;
    if (server.dashboardState) {
      server.dashboardState.dashboardPort = resolvedPort;
    }
    process.stdout.write(`${JSON.stringify({
      status: 'listening',
      service: 'local-dashboard',
      dashboard_base_url: baseUrl,
      trader_base_url: runtimeEnv.DASHBOARD_TRADER_BASE_URL || runtimeEnv.TRADER_BASE_URL || null,
      preferred_port: dashboardPort,
      timestamp: nowIso(),
    }, null, 2)}\n`);

    if (shouldAutoOpenBrowser(runtimeEnv)) {
      openInDefaultBrowser(baseUrl);
    }
  });

  return server;
}

function shouldAutoOpenBrowser(env = process.env) {
  const raw = String(env.DASHBOARD_OPEN_BROWSER ?? 'true').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function openInDefaultBrowser(url) {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    const child = spawn('cmd', ['/c', 'start', '""', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Opening the browser is best-effort only.
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  openInDefaultBrowser,
  listenWithFallback,
  main,
  shouldAutoOpenBrowser,
};
