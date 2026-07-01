const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { URL } = require('url');
const { loadRuntimeEnv } = require('./runtime-env');
const { isRegularUsMarketHours, resolveMarketRegime } = require('./market-hours');
const { nowIso, safeNumber, resolveRepoRoot, resolveDataPath } = require('./util');
const { APPROVED_LIVE_MARKET_SYMBOLS } = require('./volatile-stock-universe');
const { createLocalProcessController } = require('./local-process-controller');
const { classifyExitProtection } = require('./exit-protection');
const { readOperatorTimelineTail } = require('./operator-timeline');
const { calculateEffectiveStopLossDollars } = require('./stock-scanner');
const { resolveLiveMarketAutomationSchedule } = require('./live-market-schedule');
const { evaluatePolicyHealth } = require('./policy-health');
const { summarizePartialFillState } = require('./partial-fill-state');
const { summarizeCandidateLifecycleState } = require('./candidate-lifecycle-state');
const { loadAntiChurnState, summarizeAntiChurnState } = require('./anti-churn-engine');
const { loadSetupFatigueState, summarizeSetupFatigueState } = require('./setup-fatigue');
const { summarizeSessionGuards } = require('./session-guards');
const { loadExecutionQualityState, summarizeExecutionQualityState } = require('./execution-quality-state');
const { loadMemeMonitorState, updateMemeMonitorFeatureState, resolveMemeMonitorStatePath } = require('./meme-monitor-state');
const { createMemeMonitorLoop } = require('./meme-monitor/meme-monitor-loop');
const { loadMemeMonitorStatus, resolveMemeMonitorStatusPath } = require('./meme-monitor/meme-monitor-status');
const { loadDynamicHotList, resolveDynamicHotListPath } = require('./meme-monitor/hot-list-store');
const { summarizeHotSlotRotationRuntime } = require('./hot-slot-rotation');
const { loadRegularWatchState, updateRegularWatchFeatureState, resolveRegularWatchStatePath } = require('./regular-watch/regular-watch-feature-state');
const {
  buildRegularWatchStatusSnapshot,
  clearRegularWatchErrors,
  loadRegularWatchStatus,
  resolveRegularWatchStatusPath,
  resetRegularWatchRuntimeState,
  saveRegularWatchStatus,
} = require('./regular-watch/regular-watch-status');
const { runRegularWatchSources } = require('./regular-watch/regular-watch-source-runner');

const DEFAULT_DASHBOARD_PORT = 1111;
const DEFAULT_TRADER_CONTROL_PORT = 3001;
const DEFAULT_TRADER_PORTS = [3001, 3000, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010];
const DEFAULT_REFRESH_MAX_AGE_MS = 2_000;
const DEFAULT_RECENT_ENTRY_LIMIT = 12;
const DEFAULT_LOG_LINE_LIMIT = 20;
const DASHBOARD_RUNTIME_VERSION = '2026-06-21.live-market-simplified.1';
const execFileAsync = (file, args, options = {}) => {
  if (process.platform === 'win32') {
    const tempDir = process.env.TEMP || 'C:\\Windows\\Temp';
    const rand = Math.random().toString(36).substring(2, 15);
    const vbsPath = path.join(tempDir, `run-${rand}.vbs`);
    const outPath = path.join(tempDir, `out-${rand}.txt`);

    const formattedCmd = [file, ...args].map((arg) => {
      if (/[ "()&^|<>]/g.test(arg) || arg === '') {
        return '"' + arg.replace(/"/g, '""') + '"';
      }
      return arg;
    }).join(' ');

    const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\ncode = WshShell.Run("cmd.exe /c ${formattedCmd.replace(/"/g, '""')} > ""${outPath}""", 0, True)\nWScript.Quit code\n`;

    return fs.promises.writeFile(vbsPath, vbsContent, 'utf8')
      .then(() => promisify(execFile)('wscript.exe', [vbsPath], { windowsHide: true }))
      .then(() => {
        if (fs.existsSync(outPath)) {
          return fs.promises.readFile(outPath, 'utf8').then(stdout => ({ stdout, stderr: '' }));
        }
        return { stdout: '', stderr: '' };
      })
      .finally(() => {
        try { if (fs.existsSync(vbsPath)) fs.unlinkSync(vbsPath); } catch (_) { /* ignore */ }
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
      });
  }
  return promisify(execFile)(file, args, options);
};

function createDashboardServer(options = {}) {
  const state = {
    startedAt: options.startedAt || nowIso(),
    cache: null,
    cacheAtMs: 0,
    dashboardPort: options.port || DEFAULT_DASHBOARD_PORT,
  };
  const dashboardDir = resolveDashboardDir(options.dashboardDir);
  const dataDir = resolveDataDir(options.dataDir);
  const controlManager = options.controlManager || createLocalProcessController({
    repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
    env: options.env || process.env,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    traderPort: Number(options.traderPort || DEFAULT_TRADER_CONTROL_PORT),
  });
  const memeMonitor = options.memeMonitor || createMemeMonitorLoop({
    repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
    dataDir,
    env: options.env || process.env,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    refreshIntervalMs: options.memeRefreshIntervalMs || 5 * 60_000,
  });
  const assetIndex = {
    '/': path.join(dashboardDir, 'index.html'),
    '/index.html': path.join(dashboardDir, 'index.html'),
    '/status': path.join(dashboardDir, 'status.html'),
    '/status.html': path.join(dashboardDir, 'status.html'),
    '/policy': path.join(dashboardDir, 'policy.html'),
    '/policy.html': path.join(dashboardDir, 'policy.html'),
    '/exit-rules': path.join(dashboardDir, 'exit-rules.html'),
    '/exit-rules.html': path.join(dashboardDir, 'exit-rules.html'),
    '/alerts': path.join(dashboardDir, 'alerts.html'),
    '/alerts.html': path.join(dashboardDir, 'alerts.html'),
    '/watch': path.join(dashboardDir, 'watch.html'),
    '/watch.html': path.join(dashboardDir, 'watch.html'),
    '/control': path.join(dashboardDir, 'control.html'),
    '/control.html': path.join(dashboardDir, 'control.html'),
    '/app.js': path.join(dashboardDir, 'app.js'),
    '/status.js': path.join(dashboardDir, 'status.js'),
    '/policy.js': path.join(dashboardDir, 'policy.js'),
    '/exit-rules.js': path.join(dashboardDir, 'exit-rules.js'),
    '/alerts.js': path.join(dashboardDir, 'alerts.js'),
    '/watch.js': path.join(dashboardDir, 'watch.js'),
    '/control.js': path.join(dashboardDir, 'control.js'),
    '/styles.css': path.join(dashboardDir, 'styles.css'),
    '/mobile.js': path.join(dashboardDir, 'mobile.js'),
    '/sw.js': path.join(dashboardDir, 'sw.js'),
    '/manifest.webmanifest': path.join(dashboardDir, 'manifest.webmanifest'),
    '/icons/icon-192.png': path.join(dashboardDir, 'icons', 'icon-192.png'),
    '/icons/icon-512.png': path.join(dashboardDir, 'icons', 'icon-512.png'),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        status: 'ok',
        dashboard: 'local-only',
        dashboard_port: state.dashboardPort,
        runtime_version: DASHBOARD_RUNTIME_VERSION,
        pid: process.pid,
        timestamp: nowIso(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/snapshot') {
      try {
        const snapshot = await getCachedSnapshot(state, options, { dashboardDir, dataDir, controlManager, memeMonitor });
        return sendJson(res, 200, snapshot);
      } catch (error) {
        return sendJson(res, 500, {
          status: 'error',
          error: 'snapshot_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/control/state') {
      try {
        if (controlManager?.refresh) {
          await controlManager.refresh();
        }
        return sendJson(res, 200, {
          status: 'ok',
          timestamp: nowIso(),
          control: controlManager?.getState?.() || null,
        });
      } catch (error) {
        return sendJson(res, 500, {
          status: 'error',
          error: 'control_state_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/control/action') {
      try {
        const body = await readJsonBody(req);
        const beforeState = controlManager?.getState?.() || null;
        const result = await handleControlAction(controlManager, body, { env: options.env || process.env, repoRoot: options.repoRoot || path.resolve(__dirname, '..'), controlManager });
        if (controlManager?.refresh) {
          await controlManager.refresh();
        }
        const afterState = controlManager?.getState?.() || null;
        return sendJson(res, result.ok ? 200 : 400, {
          status: result.ok ? 'ok' : 'error',
          timestamp: nowIso(),
          requested_action: body.action || null,
          before_state: beforeState,
          after_state: afterState,
          verified: Boolean(result.ok && afterState),
          ...result,
        });
      } catch (error) {
        return sendJson(res, 500, {
          status: 'error',
          error: 'control_action_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/meme/status') {
      try {
        return sendJson(res, 200, getMemeMonitorRuntimeSnapshot({
          dataDir,
          memeMonitor,
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
        }));
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'meme_status_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/meme/features') {
      try {
        const features = loadMemeMonitorState({
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
        });
        return sendJson(res, 200, {
          ok: true,
          status: 'ok',
          timestamp: nowIso(),
          source: features.source || 'env + runtime state',
          updated_at: features.updated_at || null,
          summary: features.summary,
          blocked_features: features.blocked_features || [],
          warnings: features.warnings || [],
          features: features.features,
        });
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'meme_feature_state_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/meme/features') {
      try {
        const body = await readJsonBody(req);
        const result = updateMemeMonitorFeatureState({
          featureKey: body.featureKey || body.key || body.feature || null,
          enabled: body.enabled,
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
          filePath: resolveMemeMonitorStatePath({ dataDir }),
          changedBy: body.changedBy || body.changed_by || body.user || 'dashboard',
          source: body.source || 'dashboard-control',
          reason: body.reason || body.message || null,
        });
        return sendJson(res, result.ok ? 200 : 400, {
          ok: Boolean(result.ok),
          status: result.ok ? 'ok' : 'blocked',
          timestamp: nowIso(),
          ...result,
          features: result.state?.features || null,
          summary: result.state?.summary || null,
          blocked_features: result.state?.blocked_features || [],
          warnings: result.state?.warnings || [],
        });
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'meme_feature_update_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/meme/action') {
      try {
        const body = await readJsonBody(req);
        const result = await handleMemeAction(memeMonitor, body, {
          dataDir,
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
        });
        return sendJson(res, result.ok ? 200 : 400, {
          ok: Boolean(result.ok),
          status: result.status || (result.ok ? 'ok' : 'error'),
          timestamp: nowIso(),
          ...result,
          memeMonitor: getMemeMonitorRuntimeSnapshot({
            dataDir,
            memeMonitor,
            env: options.env || process.env,
            repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
          }).memeMonitor,
        });
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'meme_action_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/regular-watch/features') {
      try {
        const features = loadRegularWatchState({
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
          filePath: resolveRegularWatchStatePath({ dataDir }),
        });
        return sendJson(res, 200, {
          ok: true,
          status: 'ok',
          timestamp: nowIso(),
          source: features.source || 'env + runtime state',
          updated_at: features.updated_at || null,
          summary: features.summary,
          blocked_features: features.blocked_features || [],
          warnings: features.warnings || [],
          features: features.features,
        });
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'regular_watch_feature_state_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/regular-watch/features') {
      try {
        const body = await readJsonBody(req);
        const result = updateRegularWatchFeatureState({
          featureKey: body.featureKey || body.key || body.feature || null,
          enabled: body.enabled,
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
          filePath: resolveRegularWatchStatePath({ dataDir }),
          changedBy: body.changedBy || body.changed_by || body.user || 'dashboard',
          source: body.source || 'dashboard-control',
          reason: body.reason || body.message || null,
        });
        return sendJson(res, result.ok ? 200 : 400, {
          ok: Boolean(result.ok),
          status: result.ok ? 'ok' : 'blocked',
          timestamp: nowIso(),
          ...result,
          features: result.state?.features || null,
          summary: result.state?.summary || null,
          blocked_features: result.state?.blocked_features || [],
          warnings: result.state?.warnings || [],
        });
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'regular_watch_feature_update_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/regular-watch/status') {
      try {
        const featureState = loadRegularWatchState({
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
          filePath: resolveRegularWatchStatePath({ dataDir }),
        });
        const statusSnapshot = buildRegularWatchStatusSnapshot({
          featureState,
          status: loadRegularWatchStatus({ dataDir, filePath: resolveRegularWatchStatusPath({ dataDir }) }),
        });
        return sendJson(res, 200, statusSnapshot);
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'regular_watch_status_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/regular-watch/action') {
      try {
        const body = await readJsonBody(req);
        const result = await handleRegularWatchAction(body, {
          dataDir,
          env: options.env || process.env,
          repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
        });
        return sendJson(res, result.ok ? 200 : 400, {
          ok: Boolean(result.ok),
          status: result.status || (result.ok ? 'ok' : 'error'),
          timestamp: nowIso(),
          ...result,
          regularWatchIntelligence: buildRegularWatchIntelligenceSnapshot({
            regularWatchState: loadRegularWatchState({
              env: options.env || process.env,
              repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
              filePath: resolveRegularWatchStatePath({ dataDir }),
            }),
            regularWatchStatus: loadRegularWatchStatus({ dataDir, filePath: resolveRegularWatchStatusPath({ dataDir }) }),
          }),
        });
      } catch (error) {
        return sendJson(res, 500, {
          ok: false,
          status: 'error',
          error: 'regular_watch_action_failed',
          message: error.message,
          timestamp: nowIso(),
        });
      }
    }

    if (req.method === 'GET' && assetIndex[url.pathname]) {
      return sendFile(res, assetIndex[url.pathname], getContentType(assetIndex[url.pathname]));
    }

    return sendJson(res, 404, {
      status: 'error',
      error: 'not_found',
      timestamp: nowIso(),
    });
  });
  server.dashboardState = state;

  return server;
}

async function getCachedSnapshot(state, options, context) {
  const nowMs = Date.now();
  if (state.cache && (nowMs - state.cacheAtMs) < (options.cacheMaxAgeMs || DEFAULT_REFRESH_MAX_AGE_MS)) {
    return state.cache;
  }
  const snapshot = await buildDashboardSnapshot(options, context, state);
  state.cache = snapshot;
  state.cacheAtMs = nowMs;
  return snapshot;
}

async function buildDashboardSnapshot(options = {}, context = {}, state = {}) {
  const env = options.env || process.env;
  const runtimeEnv = options.runtimeEnv || loadRuntimeEnv(env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('Dashboard requires fetch support');
  }

  const dataDir = context.dataDir || options.dataDir || path.resolve(resolveRepoRoot(), 'data');
  const nowProvider = options.nowProvider || (() => new Date());
  const currentDate = nowProvider();
  const now = nowIso();
  const dashboardPort = options.port || state.dashboardPort || DEFAULT_DASHBOARD_PORT;
  const traderDiscovery = await resolveTraderBaseUrl({
    env: runtimeEnv,
    fetchImpl,
    preferredBaseUrl: options.traderBaseUrl || runtimeEnv.DASHBOARD_TRADER_BASE_URL || runtimeEnv.TRADER_BASE_URL || null,
    candidatePorts: parsePortList(runtimeEnv.DASHBOARD_TRADER_PORTS, DEFAULT_TRADER_PORTS),
  });
  const processDiscovery = await discoverRepoProcesses();

  const traderBaseUrl = traderDiscovery.baseUrl;
  const liveAccount = await fetchBrokerAccount({
    fetchImpl,
    env: runtimeEnv,
  });
  const livePositions = await fetchBrokerPositions({
    fetchImpl,
    env: runtimeEnv,
  });
  const liveOpenOrders = await fetchBrokerOpenOrders({
    fetchImpl,
    env: runtimeEnv,
  });
  const liveStatus = await fetchEndpointJson(fetchImpl, traderBaseUrl, '/status');
  const dailyLiveResults = await fetchEndpointJson(fetchImpl, traderBaseUrl, '/daily-live-results');
  const riskPolicy = await fetchEndpointJson(fetchImpl, traderBaseUrl, '/risk-policy');
  const performanceTuning = await fetchEndpointJson(fetchImpl, traderBaseUrl, '/performance/tuning');
  const policyEffectiveness = await fetchEndpointJson(fetchImpl, traderBaseUrl, '/policy-effectiveness');
  const overnightStatus = await fetchEndpointJson(fetchImpl, traderBaseUrl, '/overnight-status');

  const overnightStatusFilePath = path.join(dataDir, 'logs', 'overnight-status.json');
  const overnightStatusFile = readJsonFileIfPresent(overnightStatusFilePath);
  const overnightStatusFileMeta = fileMeta(overnightStatusFilePath, overnightStatusFile);
  const scannerRuntimeStatePath = path.join(dataDir, 'state', 'scanner-runtime.json');
  const scannerRuntimeFile = readJsonFileIfPresent(scannerRuntimeStatePath);
  const scannerRuntimeFileMeta = fileMeta(scannerRuntimeStatePath, scannerRuntimeFile);
  const preflightLatestPath = path.join(dataDir, 'runtime', 'live-preflight-latest.json');
  const preflightLatest = readJsonFileIfPresent(preflightLatestPath);
  const brokerLocalReconciliationPath = path.join(dataDir, 'runtime', 'broker-local-reconciliation-latest.json');
  const brokerLocalReconciliation = readJsonFileIfPresent(brokerLocalReconciliationPath);
  const partialFillStatePath = path.join(dataDir, 'runtime', 'partial-fill-state.json');
  const partialFillState = readJsonFileIfPresent(partialFillStatePath);
  const executionQualityStatePath = path.join(dataDir, 'runtime', 'execution-quality-state.json');
  const executionQualityState = readJsonFileIfPresent(executionQualityStatePath) || loadExecutionQualityState(executionQualityStatePath);
  const memeMonitorStatePath = resolveMemeMonitorStatePath({ dataDir });
  const memeMonitorState = loadMemeMonitorState({ env: runtimeEnv, filePath: memeMonitorStatePath });
  const memeMonitorStatusPath = resolveMemeMonitorStatusPath({ dataDir });
  const memeMonitorStatus = loadMemeMonitorStatus({ dataDir, filePath: memeMonitorStatusPath });
  const regularWatchStatePath = resolveRegularWatchStatePath({ dataDir });
  const regularWatchState = loadRegularWatchState({ env: runtimeEnv, filePath: regularWatchStatePath });
  const regularWatchStatusPath = resolveRegularWatchStatusPath({ dataDir });
  const regularWatchStatus = loadRegularWatchStatus({ dataDir, filePath: regularWatchStatusPath });
  const dynamicHotListPath = resolveDynamicHotListPath({ dataDir });
  const dynamicHotList = loadDynamicHotList({ dataDir, filePath: dynamicHotListPath });
  const candidateLifecycleStatePath = path.join(dataDir, 'runtime', 'candidate-lifecycle-state.json');
  const candidateLifecycleState = readJsonFileIfPresent(candidateLifecycleStatePath);
  const setupFatigueStatePath = path.join(dataDir, 'runtime', 'setup-fatigue-state.json');
  const setupFatigueState = readJsonFileIfPresent(setupFatigueStatePath) || loadSetupFatigueState(setupFatigueStatePath);
  const antiChurnStatePath = path.join(dataDir, 'runtime', 'anti-churn-state.json');
  const antiChurnState = readJsonFileIfPresent(antiChurnStatePath) || loadAntiChurnState(antiChurnStatePath);
  const antiChurnSummary = summarizeAntiChurnState(antiChurnState || {});
  const partialFillSummary = summarizePartialFillState(partialFillState || {});
  const executionQualitySummary = summarizeExecutionQualityState(executionQualityState || {});
  const candidateLifecycleSummary = summarizeCandidateLifecycleState(candidateLifecycleState || {});
  const setupFatigueSummary = summarizeSetupFatigueState(setupFatigueState || {});
  const hotSlotRotationState = summarizeHotSlotRotationRuntime(scannerRuntimeFile?.hot_slot_rotation || null, memeMonitorState?.features?.MEME_HOT_SLOT_ROTATION_ENABLED);
  const sessionGuards = summarizeSessionGuards(scannerRuntimeFile?.session_guards || null) || null;
  const livePolicyFile = readJsonFileIfPresent(path.join(dataDir, 'live-policy.json'));
  const performanceHistory = readJsonlTail(path.join(dataDir, 'performance-history.jsonl'), 512);
  const policyHistory = readJsonlTail(path.join(dataDir, 'policy-history.jsonl'), DEFAULT_RECENT_ENTRY_LIMIT);
  const operatorTimeline = readOperatorTimelineTail({ filePath: path.join(dataDir, 'logs', 'operator-timeline.jsonl'), limit: 50 });
  const recentLogLines = readRelevantLogLines(dataDir, DEFAULT_LOG_LINE_LIMIT);

  const regime = resolveMarketRegime(currentDate);
  const activePolicySnapshot = unwrapPolicySnapshot(riskPolicy.data) || unwrapPolicySnapshot(overnightStatus.data?.policy_snapshot) || livePolicyFile || null;
  const liveMarketRules = resolveLiveMarketRules(runtimeEnv, activePolicySnapshot);
  const liveMarketSchedule = resolveLiveMarketAutomationSchedule(currentDate);
  const configDrift = buildConfigDrift(activePolicySnapshot, runtimeEnv);
  const envLocalMetaForPolicy = getFileStat(path.resolve(options.repoRoot || path.resolve(__dirname, '..'), '.env.local'));
  const policyHealth = preflightLatest?.policy?.health || evaluatePolicyHealth({
    policySnapshot: activePolicySnapshot,
    runtimeEnv,
    envLocalMtimeMs: envLocalMetaForPolicy.mtime_ms,
    now,
  });
  const report = unwrapReport(dailyLiveResults.data) || unwrapReport(overnightStatus.data) || unwrapReport(overnightStatusFile) || null;
  const status = unwrapStatus(liveStatus.data) || unwrapStatus(overnightStatus.data) || unwrapStatus(overnightStatusFile) || null;

  const recentEntries = summarizeRecentEntries(performanceHistory.entries);
  const timeline = buildOperatorTimeline(operatorTimeline, recentEntries, scannerRuntimeFile);
  const recentPolicyChanges = summarizePolicyHistory(policyHistory.entries);
  const livePositionSummary = normalizeLivePositions(livePositions);
  const controlState = context.controlManager?.refresh
    ? await context.controlManager.refresh()
    : context.controlManager?.getState?.() || null;
  const exitProtection = classifyExitProtection({
    positions: livePositionSummary.positions,
    openOrders: liveOpenOrders.orders,
    scannerRuntime: scannerRuntimeFile,
    now: currentDate,
  });
  const envLocalWarning = buildEnvLocalChangedAfterStartWarning({
    repoRoot: options.repoRoot || path.resolve(__dirname, '..'),
    startedAt: state.startedAt,
  });
  const exitManagement = buildExitManagementState({
    scannerRuntime: scannerRuntimeFile,
    control: controlState,
    livePositionSummary,
    runtimeEnv,
    liveMarketRules,
  });
  const sourceHealth = buildSourceHealth([
    liveStatus,
    dailyLiveResults,
    riskPolicy,
    performanceTuning,
    overnightStatus,
  ], {
    overnightStatusFile: overnightStatusFileMeta,
    performanceHistory,
    policyHistory,
    recentLogLines,
  });

  const alerts = buildAlerts({
    sourceHealth,
    recentLogLines,
    report,
    status,
    traderDiscovery,
    overnightStatusFile,
    scannerRuntimeFile,
    control: controlState,
    runtimeEnv,
    livePositions: livePositionSummary,
    recentEntries,
    configDrift,
    processDiscovery,
    exitManagement,
    exitProtection,
    envLocalWarning,
    preflight: preflightLatest,
    policyHealth,
    brokerLocalReconciliation,
    partialFillSummary,
    candidateLifecycleSummary,
    setupFatigueSummary,
    sessionGuards,
    memeMonitorState,
    memeMonitorStatus,
    regularWatchState,
    regularWatchStatus,
  });
  const dashboardSummary = buildSummary({
    status,
    report,
    activePolicySnapshot,
    regime,
    liveMarketRules,
    recentEntries,
    livePositions: livePositionSummary,
    liveAccount,
    control: controlState,
    preflight: preflightLatest,
    brokerLocalReconciliation,
    partialFillSummary,
    executionQualitySummary,
    candidateLifecycleSummary,
    antiChurnSummary,
    setupFatigueSummary,
    sessionGuards,
    memeMonitorState,
    memeMonitorStatus,
    regularWatchState,
    regularWatchStatus,
    scannerRuntime: scannerRuntimeFile,
  });
  const regularWatchIntelligence = buildRegularWatchIntelligenceSnapshot({
    regularWatchState,
    regularWatchStatus,
    scannerRuntime: scannerRuntimeFile,
    livePositions: livePositionSummary,
    liveOpenOrders,
    partialFillSummary,
  });

  return {
    status: 'ok',
    generated_at: now,
    dashboard: {
      port: dashboardPort,
      base_url: `http://127.0.0.1:${dashboardPort}`,
      trader_base_url: traderBaseUrl,
      trader_discovery: traderDiscovery,
      runtime_version: DASHBOARD_RUNTIME_VERSION,
      frontend_version: DASHBOARD_RUNTIME_VERSION,
      pid: process.pid,
      process_discovery: processDiscovery,
      refresh_max_age_ms: options.cacheMaxAgeMs || DEFAULT_REFRESH_MAX_AGE_MS,
    },
    memeMonitor: {
      enabled: Boolean(memeMonitorState?.summary?.master_enabled),
      source: memeMonitorState?.summary?.source || memeMonitorState?.source || 'env + runtime state',
      redditScanner: {
        enabled: Boolean(memeMonitorStatus?.enabled),
        status: memeMonitorStatus?.redditScanner?.status || 'off',
        lastRunAt: memeMonitorStatus?.redditScanner?.lastRunAt || null,
        lastError: memeMonitorStatus?.redditScanner?.lastError || null,
        sources: memeMonitorStatus?.redditScanner?.sources || [],
        symbolsDetected: Number(memeMonitorStatus?.redditScanner?.symbolsDetected || 0),
        rejectedTokens: Number(memeMonitorStatus?.redditScanner?.rejectedTokens || 0),
        mode: memeMonitorStatus?.redditScanner?.mode || 'shadow',
      },
      phaseA: memeMonitorStatus?.phaseA || {
        enabled: false,
        status: 'off',
        lastRunAt: null,
        lastError: null,
        sources: [],
        symbols: [],
      },
      phaseB: memeMonitorStatus?.phaseB || {
        enabled: false,
        status: 'off',
        lastRunAt: null,
        lastError: null,
        sources: [],
        symbols: [],
      },
      hotList: memeMonitorStatus?.hotList || dynamicHotList?.summary || null,
      hotHotScoring: memeMonitorStatus?.hotHotScoring || null,
      dynamicWatchlist: summarizeMemeRuntimeFeature({
        feature: memeMonitorState?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED,
        status: memeMonitorStatus?.hotList,
        count: dynamicHotList?.summary?.dynamicCount || dynamicHotList?.dynamicHotList?.length || 0,
        active: Boolean(memeMonitorState?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED?.effective),
        label: 'Dynamic Watchlist',
      }),
      priorityOverride: summarizeMemeRuntimeFeature({
        feature: memeMonitorState?.features?.MEME_PRIORITY_OVERRIDE_ENABLED,
        status: memeMonitorStatus?.hotHotScoring,
        count: dynamicHotList?.summary?.hotHotCount || dynamicHotList?.hotHotList?.length || 0,
        active: Boolean(memeMonitorState?.features?.MEME_PRIORITY_OVERRIDE_ENABLED?.effective),
        label: 'Priority Override',
      }),
      hotSlotRotation: hotSlotRotationState,
      hotListPayload: dynamicHotList || null,
    },
    regularWatchIntelligence,
    phaseB: memeMonitorStatus?.phaseB || null,
    watch: buildWatchSnapshot({
      regime: liveMarketRules,
      live: {
        scannerRuntime: scannerRuntimeFile,
        memeMonitorState,
        memeMonitorStatus,
        regularWatchState,
        regularWatchStatus,
      },
      summary: dashboardSummary,
      memeMonitorState,
      memeMonitorStatus,
      regularWatchState,
      regularWatchStatus,
      scannerRuntime: scannerRuntimeFile,
      dynamicHotList,
      hotSlotRotationState,
      livePositions: livePositionSummary,
      liveOpenOrders: liveOpenOrders,
      partialFillSummary,
      approvedSymbols: liveMarketRules.approved_symbols,
      currentDate,
    }),
    control: controlState,
    regime: {
      active: regime,
      market_open: isRegularUsMarketHours(currentDate),
      workflow: 'Live Market',
      approved_symbols: liveMarketRules.approved_symbols,
      max_open_positions: liveMarketRules.max_open_positions,
      buy_notional_target: liveMarketRules.buy_notional_target,
      min_buy_notional: liveMarketRules.min_buy_notional,
      stop_loss_dollars: liveMarketRules.stop_loss_dollars,
      stop_loss_notional_pct: liveMarketRules.stop_loss_notional_pct,
      stop_loss_max_dollars: liveMarketRules.stop_loss_max_dollars,
      trailing_profit_start_dollars: liveMarketRules.trailing_profit_start_dollars,
      trailing_profit_giveback_dollars: liveMarketRules.trailing_profit_giveback_dollars,
      sell_profit_threshold_pct: liveMarketRules.sell_profit_threshold_pct,
      sell_net_profit_floor_dollars: liveMarketRules.sell_net_profit_floor_dollars,
      risk_budget_sizing: liveMarketRules.risk_budget_sizing,
    },
    live: {
      status,
      report,
      account: liveAccount.data || null,
      positions: livePositions.data || livePositions.positions || null,
      positions_summary: livePositionSummary,
      open_orders: liveOpenOrders,
      policy: activePolicySnapshot,
      tuning: unwrapTuningSummary(performanceTuning.data),
      policy_effectiveness: unwrapPolicyEffectiveness(policyEffectiveness.data),
      overnight_status: overnightStatus.data || overnightStatusFile || null,
      scanner_runtime: scannerRuntimeFile || null,
      config_drift: configDrift,
      preflight: preflightLatest || null,
      policy_health: policyHealth,
      broker_local_reconciliation: brokerLocalReconciliation || null,
      reconciliation_summary: summarizeBrokerLocalReconciliation(brokerLocalReconciliation),
      partial_fill_state: partialFillState || null,
      partial_fill_summary: partialFillSummary,
      execution_quality_state: executionQualityState || null,
      execution_quality_summary: executionQualitySummary,
      meme_monitor_state: memeMonitorState || null,
      regular_watch_state: regularWatchState || null,
      meme_monitor_runtime: {
        ...memeMonitorStatus,
        phaseA: memeMonitorStatus?.phaseA || {
          enabled: false,
          status: 'off',
          lastRunAt: null,
          lastError: null,
          sources: [],
          symbols: [],
        },
        phaseB: memeMonitorStatus?.phaseB || {
          enabled: false,
          status: 'off',
          lastRunAt: null,
          lastError: null,
          sources: [],
          symbols: [],
        },
        dynamicWatchlist: summarizeMemeRuntimeFeature({
          feature: memeMonitorState?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED,
          status: memeMonitorStatus?.hotList,
          count: dynamicHotList?.summary?.dynamicCount || dynamicHotList?.dynamicHotList?.length || 0,
          active: Boolean(memeMonitorState?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED?.effective),
          label: 'Dynamic Watchlist',
        }),
        priorityOverride: summarizeMemeRuntimeFeature({
          feature: memeMonitorState?.features?.MEME_PRIORITY_OVERRIDE_ENABLED,
          status: memeMonitorStatus?.hotHotScoring,
          count: dynamicHotList?.summary?.hotHotCount || dynamicHotList?.hotHotList?.length || 0,
          active: Boolean(memeMonitorState?.features?.MEME_PRIORITY_OVERRIDE_ENABLED?.effective),
          label: 'Priority Override',
        }),
        hotSlotRotation: hotSlotRotationState,
      },
      regular_watch_intelligence: regularWatchIntelligence,
      regular_watch_runtime: regularWatchStatus,
      meme_monitor_hot_list: dynamicHotList || null,
      candidate_lifecycle_state: candidateLifecycleState || null,
      candidate_lifecycle_summary: candidateLifecycleSummary,
      anti_churn_state: antiChurnState || null,
      anti_churn_summary: antiChurnSummary,
      setup_fatigue_state: setupFatigueState || null,
      setup_fatigue_summary: setupFatigueSummary,
      session_guards: sessionGuards,
      risk_budget_sizing: {
        config: liveMarketRules.risk_budget_sizing,
        runtime: scannerRuntimeFile?.risk_budget_sizing || null,
        latest_candidates: scannerRuntimeFile?.risk_budget_sizing?.latest_candidates || scannerRuntimeFile?.candidate_rank_details || [],
      },
      exit_management: exitManagement,
      exit_protection: exitProtection,
      broker_state_availability: {
        account_available: Boolean(liveAccount.available),
        positions_available: Boolean(livePositions.available),
        open_orders_available: Boolean(liveOpenOrders.available),
        reason_codes: [
          liveAccount.available ? null : 'BROKER_ACCOUNT_UNAVAILABLE',
          livePositions.available ? null : 'BROKER_POSITIONS_UNAVAILABLE',
          liveOpenOrders.available ? null : 'BROKER_OPEN_ORDERS_UNAVAILABLE',
        ].filter(Boolean),
      },
      env_changed_after_start: envLocalWarning,
    },
    automation: {
      live_market: liveMarketSchedule,
    },
    recent_activity: {
      paper_outcomes: recentEntries.paperOutcomes,
      paperOutcomes: recentEntries.paperOutcomes,
      orders: recentEntries.orders,
      risk_decisions: recentEntries.riskDecisions,
      riskDecisions: recentEntries.riskDecisions,
      signals: recentEntries.signals,
      policy_changes: recentPolicyChanges,
      policyChanges: recentPolicyChanges,
      logs: recentLogLines,
      operator_timeline: timeline,
      operatorTimeline: timeline,
      open_positions: livePositionSummary.available ? livePositionSummary.positions : recentEntries.openPositions,
      openPositions: livePositionSummary.available ? livePositionSummary.positions : recentEntries.openPositions,
      derived_open_positions: recentEntries.openPositions,
      last_trade_at: recentEntries.lastTradeAt || recentEntries.lastSellAt || recentEntries.lastBuyAt || null,
    },
    file_snapshots: {
      overnight_status: overnightStatusFileMeta,
      scanner_runtime: scannerRuntimeFileMeta,
      operator_timeline: fileMeta(path.join(dataDir, 'logs', 'operator-timeline.jsonl'), { entries: operatorTimeline }),
      performance_history: fileMeta(path.join(dataDir, 'performance-history.jsonl'), performanceHistory.meta),
      policy_history: fileMeta(path.join(dataDir, 'policy-history.jsonl'), policyHistory.meta),
      live_policy: fileMeta(path.join(dataDir, 'live-policy.json'), livePolicyFile),
      live_preflight: fileMeta(preflightLatestPath, preflightLatest),
      broker_local_reconciliation: fileMeta(brokerLocalReconciliationPath, brokerLocalReconciliation),
      partial_fill_state: fileMeta(partialFillStatePath, partialFillState),
      execution_quality_state: fileMeta(executionQualityStatePath, executionQualityState),
      meme_monitor_state: fileMeta(memeMonitorStatePath, memeMonitorState),
      meme_monitor_runtime: fileMeta(memeMonitorStatusPath, memeMonitorStatus),
      regular_watch_state: fileMeta(regularWatchStatePath, regularWatchState),
      regular_watch_runtime: fileMeta(regularWatchStatusPath, regularWatchStatus),
      dynamic_hot_list: fileMeta(dynamicHotListPath, dynamicHotList),
      candidate_lifecycle_state: fileMeta(candidateLifecycleStatePath, candidateLifecycleState),
      anti_churn_state: fileMeta(antiChurnStatePath, antiChurnState),
      setup_fatigue_state: fileMeta(setupFatigueStatePath, setupFatigueState),
    },
    source_health: sourceHealth,
    alerts,
    summary: dashboardSummary,
    timestamp: now,
  };
}

async function fetchBrokerAccount({ fetchImpl, env }) {
  const apiKeyId = String(env?.ALPACA_API_KEY_ID || '').trim();
  const apiSecretKey = String(env?.ALPACA_API_SECRET_KEY || '').trim();
  const baseUrl = String(env?.ALPACA_API_BASE_URL || '').trim() || 'https://paper-api.alpaca.markets';
  if (!apiKeyId || !apiSecretKey) {
    return { available: false, data: null, source: 'alpaca', reason: 'credentials_missing' };
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, `${trimTrailingSlash(baseUrl)}/v2/account`, {
      timeoutMs: 2500,
      headers: {
        'APCA-API-KEY-ID': apiKeyId,
        'APCA-API-SECRET-KEY': apiSecretKey,
        'content-type': 'application/json',
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      return { available: false, data: null, source: 'alpaca', reason: `http_${response.status}` };
    }
    return { available: true, data: body, source: 'alpaca', reason: null };
  } catch (error) {
    return { available: false, data: null, source: 'alpaca', reason: error.message };
  }
}

async function fetchBrokerPositions({ fetchImpl, env }) {
  const apiKeyId = String(env?.ALPACA_API_KEY_ID || '').trim();
  const apiSecretKey = String(env?.ALPACA_API_SECRET_KEY || '').trim();
  const baseUrl = String(env?.ALPACA_API_BASE_URL || '').trim() || 'https://paper-api.alpaca.markets';
  if (!apiKeyId || !apiSecretKey) {
    return { available: false, count: null, positions: [], source: 'alpaca', reason: 'credentials_missing' };
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, `${trimTrailingSlash(baseUrl)}/v2/positions`, {
      timeoutMs: 2500,
      headers: {
        'APCA-API-KEY-ID': apiKeyId,
        'APCA-API-SECRET-KEY': apiSecretKey,
        'content-type': 'application/json',
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      return {
        available: false,
        count: null,
        positions: [],
        source: 'alpaca',
        reason: `http_${response.status}`,
      };
    }
    const positions = Array.isArray(body) ? body : body?.positions || body?.data || [];
    return {
      available: true,
      count: positions.length,
      positions,
      source: 'alpaca',
      reason: null,
    };
  } catch (error) {
    return {
      available: false,
      count: null,
      positions: [],
      source: 'alpaca',
      reason: error.message,
    };
  }
}

async function fetchBrokerOpenOrders({ fetchImpl, env }) {
  const apiKeyId = String(env?.ALPACA_API_KEY_ID || '').trim();
  const apiSecretKey = String(env?.ALPACA_API_SECRET_KEY || '').trim();
  const baseUrl = String(env?.ALPACA_API_BASE_URL || '').trim() || 'https://paper-api.alpaca.markets';
  if (!apiKeyId || !apiSecretKey) {
    return { available: false, count: null, orders: [], source: 'alpaca', reason: 'credentials_missing' };
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, `${trimTrailingSlash(baseUrl)}/v2/orders?status=open&limit=500`, {
      timeoutMs: 2500,
      headers: {
        'APCA-API-KEY-ID': apiKeyId,
        'APCA-API-SECRET-KEY': apiSecretKey,
        'content-type': 'application/json',
      },
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      return {
        available: false,
        count: null,
        orders: [],
        source: 'alpaca',
        reason: `http_${response.status}`,
      };
    }
    const orders = Array.isArray(body) ? body : body?.orders || body?.data || [];
    return {
      available: true,
      count: orders.length,
      orders,
      source: 'alpaca',
      reason: null,
    };
  } catch (error) {
    return {
      available: false,
      count: null,
      orders: [],
      source: 'alpaca',
      reason: error.message,
    };
  }
}

function buildEnvLocalChangedAfterStartWarning({ repoRoot = resolveRepoRoot(), startedAt = null } = {}) {
  const envLocalPath = path.resolve(repoRoot, '.env.local');
  let stat = null;
  try {
    stat = fs.statSync(envLocalPath);
  } catch {
    return {
      changed_after_start: false,
      reason_code: null,
      path: envLocalPath,
      mtime: null,
      started_at: startedAt,
    };
  }
  const startedMs = new Date(startedAt || 0).getTime();
  const changedAfterStart = Number.isFinite(startedMs) && stat.mtimeMs > startedMs;
  return {
    changed_after_start: changedAfterStart,
    reason_code: changedAfterStart ? 'ENV_CHANGED_AFTER_START_RESTART_REQUIRED' : null,
    path: envLocalPath,
    mtime: stat.mtime.toISOString(),
    started_at: startedAt,
  };
}

async function resolveTraderBaseUrl({ env, fetchImpl, preferredBaseUrl, candidatePorts }) {
  const probeCandidates = [];
  if (preferredBaseUrl) probeCandidates.push(String(preferredBaseUrl).trim());
  for (const port of candidatePorts) {
    probeCandidates.push(`http://127.0.0.1:${port}`);
  }

  const tried = [];
  for (const candidate of [...new Set(probeCandidates.filter(Boolean))]) {
    const probe = await probeTrader(candidate, fetchImpl);
    tried.push(probe);
    if (probe.ok) {
      return {
        baseUrl: candidate,
        selected: candidate,
        candidates: tried,
      };
    }
  }

  return {
    baseUrl: probeCandidates[0] || null,
    selected: null,
    candidates: tried,
  };
}

async function probeTrader(baseUrl, fetchImpl) {
  try {
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/status`, { timeoutMs: 1500 });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return {
      baseUrl,
      ok: response.ok,
      status: response.status,
      mode: body?.mode || null,
      trader_status: body?.status || null,
      timestamp: body?.timestamp || null,
    };
  } catch (error) {
    return {
      baseUrl,
      ok: false,
      error: error.message,
    };
  }
}

async function fetchEndpointJson(fetchImpl, baseUrl, pathname) {
  if (!baseUrl) {
    return {
      ok: false,
      source: pathname,
      error: 'TRADER_BASE_URL_NOT_RESOLVED',
      data: null,
    };
  }

  try {
    const response = await fetchWithTimeout(fetchImpl, `${baseUrl}${pathname}`, { timeoutMs: 2500 });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      source: pathname,
      data,
      error: response.ok ? null : data?.error || data?.message || `HTTP_${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      source: pathname,
      data: null,
      error: error.message,
    };
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

async function handleControlAction(controlManager, body = {}, context = {}) {
  if (!controlManager) {
    return { ok: false, action: null, error: 'control_manager_unavailable', message: 'Control manager is not available' };
  }
  const action = String(body.action || '').trim();
  const profile = body.profile ?? body.mode ?? body.target ?? null;
  switch (action) {
    case 'restart-dashboard':
    case 'launch-replacement-dashboard':
      return await launchReplacementDashboard(context);
    case 'refresh':
      if (controlManager.refresh) {
        await controlManager.refresh();
      }
      return { ok: true, action, message: 'Control state refreshed', state: controlManager.getState?.() || null };
    case 'start-trader':
      return await controlManager.startTrader();
    case 'stop-trader':
      return await controlManager.stopTrader();
    case 'restart-trader':
      return await (controlManager.restartWorkflow || controlManager.restartTrader)(profile);
    case 'start-workflow':
      return await controlManager.startWorkflow(profile);
    case 'stop-workflow':
      return await controlManager.stopWorkflow();
    case 'restart-workflow':
      return await controlManager.restartWorkflow(profile);
    case 'start-scanner':
      return await controlManager.startScanner('live-market');
    case 'start-live-market':
      return await controlManager.startScanner('live-market');
    case 'start-overnight-crypto':
    case 'start-crypto-only':
    case 'start-market-aware-auto':
      return unsupportedLegacyScannerAction(action);
    case 'stop-scanner':
      return await controlManager.stopScanner();
    case 'restart-scanner':
      return await controlManager.restartScanner('live-market');
    case 'restart-live-market':
      return await controlManager.restartScanner('live-market');
    case 'restart-overnight-crypto':
    case 'restart-crypto-only':
    case 'restart-market-aware-auto':
      return unsupportedLegacyScannerAction(action);
    case 'switch-scanner':
      return await controlManager.switchScannerProfile('live-market');
    case 'switch-live-market':
      return await controlManager.switchScannerProfile('live-market');
    case 'switch-overnight-crypto':
    case 'switch-crypto-only':
    case 'switch-market-aware-auto':
      return unsupportedLegacyScannerAction(action);
    default:
      return {
        ok: false,
        action,
        error: 'unknown_action',
        message: `Unsupported control action: ${action || '(missing)'}`,
      };
  }
}

function unsupportedLegacyScannerAction(action) {
  return {
    ok: false,
    action,
    error: 'legacy_scanner_profile_hidden',
    message: 'Only the Live Market stock workflow is operator-facing now.',
  };
}

async function launchReplacementDashboard(context = {}) {
  const env = context.env || process.env;
  const repoRoot = context.repoRoot || path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'dashboard-cli.js')], {
    cwd: repoRoot,
    env: {
      ...env,
      DASHBOARD_OPEN_BROWSER: 'false',
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref?.();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const processes = await discoverRepoProcesses();
  const dashboardPids = processes.dashboards.map((item) => item.pid);
  return {
    ok: true,
    action: 'launch-replacement-dashboard',
    message: 'Replacement dashboard launched locally. If port 1111 was occupied, the launcher will use the next available port.',
    replacement_pid: child.pid,
    dashboard_pids: dashboardPids,
    state: controlManagerSafeState(context.controlManager),
  };
}

function controlManagerSafeState(controlManager) {
  try {
    return controlManager?.getState?.() || null;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetchImpl, url, { timeoutMs = 2500, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

async function discoverRepoProcesses() {
  if (process.platform !== 'win32') {
    return { current_pid: process.pid, dashboards: [], traders: [], scanners: [] };
  }
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$items = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dashboard-cli\\.js|trader-cli\\.js|minimal-cli\\.js|start-(stock|crypto|overnight)-scanner\\.js' } | Select-Object ProcessId,CommandLine; $items | ConvertTo-Json -Compress`,
    ]);
    const raw = String(stdout || '').trim();
    if (!raw) return { current_pid: process.pid, dashboards: [], traders: [], scanners: [] };
    const parsed = JSON.parse(raw);
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      command_line: String(row.CommandLine || ''),
    })).filter((row) => Number.isFinite(row.pid));
    return {
      current_pid: process.pid,
      dashboards: rows.filter((row) => /dashboard-cli\.js/i.test(row.command_line)).map((row) => ({ ...row, current: row.pid === process.pid })),
      traders: rows.filter((row) => /trader-cli\.js|minimal-cli\.js/i.test(row.command_line)),
      scanners: rows.filter((row) => /start-(stock|crypto|overnight)-scanner\.js/i.test(row.command_line)),
    };
  } catch {
    return { current_pid: process.pid, dashboards: [], traders: [], scanners: [] };
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function resolveDashboardDir(dashboardDir) {
  return dashboardDir ? path.resolve(dashboardDir) : path.resolve(__dirname, '..', 'dashboard');
}

function resolveDataDir(dataDir) {
  return dataDir ? path.resolve(dataDir) : path.resolve(resolveRepoRoot(), 'data');
}

function parsePortList(raw, fallback) {
  if (!raw) return fallback.slice();
  const values = String(raw)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part > 0);
  return values.length ? [...new Set(values)] : fallback.slice();
}

function readJsonFileIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readJsonlTail(filePath, limit = DEFAULT_RECENT_ENTRY_LIMIT) {
  const meta = fileMeta(filePath);
  if (!meta.exists) {
    return { entries: [], meta };
  }
  const text = readTailText(filePath, Math.max(256 * 1024, limit * 32 * 1024));
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Ignore malformed tail fragments.
    }
  }
  return {
    entries: entries.slice(-limit),
    meta,
  };
}

function readTailText(filePath, maxBytes = 64 * 1024) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stats = fs.fstatSync(fd);
    if (stats.size === 0) return '';
    const target = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(target);
    const offset = stats.size - target;
    fs.readSync(fd, buffer, 0, target, offset);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readRelevantLogLines(dataDir, limit = DEFAULT_LOG_LINE_LIMIT) {
  const logFiles = collectLogFiles(dataDir);
  const lines = [];
  for (const filePath of logFiles) {
    const tail = readTailText(filePath, 16 * 1024).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of tail) {
      if (/error|warn|fail|eaddrinuse|stale|blocked|reject/i.test(line)) {
        lines.push({
          file: path.relative(resolveRepoRoot(), filePath),
          line,
        });
      }
    }
  }
  return lines.slice(-limit);
}

function collectLogFiles(dataDir) {
  const roots = [path.join(dataDir, 'logs'), dataDir];
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.log') || entry.name.endsWith('.err') || entry.name.endsWith('.out') || entry.name.endsWith('.json')) {
        files.push(path.join(root, entry.name));
      }
    }
  }
  return files;
}

function summarizeRecentEntries(entries = []) {
  const paperOutcomes = [];
  const riskDecisions = [];
  const signals = [];
  const orders = [];
  const positionLedger = new Map();
  let lastTradeAt = null;
  let lastBuyAt = null;
  let lastSellAt = null;
  for (const entry of entries) {
    if (entry.entry_type === 'paper_outcome') {
      const recordedAt = entry.record?.recorded_at || null;
      const side = String(entry.record?.paper_result?.side || entry.record?.side || '').toLowerCase();
      const orderAt = entry.record?.paper_result?.filled_at || entry.record?.paper_result?.paper_order_request?.created_at || recordedAt || null;
      const quantity = safeNumber(
        entry.record?.paper_result?.filled_quantity
          ?? entry.record?.paper_order_request?.quantity
          ?? entry.record?.quantity
          ?? 0,
        0,
      );
      const symbol = entry.record?.symbol || entry.record?.paper_result?.symbol || null;
      if (recordedAt) {
        if (side === 'buy') lastBuyAt = lastBuyAt && new Date(lastBuyAt) > new Date(recordedAt) ? lastBuyAt : recordedAt;
        if (side === 'sell') lastSellAt = lastSellAt && new Date(lastSellAt) > new Date(recordedAt) ? lastSellAt : recordedAt;
      }
      if (orderAt && (!lastTradeAt || new Date(orderAt) > new Date(lastTradeAt))) {
        lastTradeAt = orderAt;
      }
      if (symbol && Number.isFinite(quantity) && quantity > 0) {
        const key = symbol;
        const current = positionLedger.get(key) || {
          symbol,
          net_quantity: 0,
          last_trade_at: null,
          last_side: null,
          last_price: null,
        };
        const signedQuantity = side === 'sell' ? -quantity : quantity;
        current.net_quantity += signedQuantity;
        current.last_trade_at = orderAt || current.last_trade_at;
        current.last_side = side || current.last_side;
        current.last_price = safeNumber(entry.record?.paper_result?.average_fill_price ?? entry.record?.paper_order_request?.entry_price ?? entry.record?.entry_price ?? null, current.last_price);
        positionLedger.set(key, current);
      }
      orders.push({
        order_id: entry.record?.paper_result?.order_id || entry.record?.paper_order_request?.request_id || entry.record?.signal_id || null,
        recorded_at: orderAt || recordedAt,
        symbol,
        side,
        status: entry.record?.status || entry.record?.paper_result?.status || null,
        quantity,
        pnl: safeNumber(entry.record?.pnl, 0),
        adjusted_pnl: safeNumber(entry.record?.adjusted_pnl, 0),
        confidence_bucket: entry.record?.calibration_bucket || 'unknown',
      });
      paperOutcomes.push({
        recorded_at: recordedAt,
        symbol,
        side,
        status: entry.record?.status || null,
        pnl: safeNumber(entry.record?.pnl, 0),
        adjusted_pnl: safeNumber(entry.record?.adjusted_pnl, 0),
        execution_drag: safeNumber(entry.record?.execution_drag, 0),
        win_loss: entry.record?.win_loss || 'unknown',
        confidence_bucket: entry.record?.calibration_bucket || 'unknown',
      });
    }
    if (entry.entry_type === 'risk_decision') {
      riskDecisions.push({
        recorded_at: entry.record?.recorded_at || null,
        decision: entry.record?.decision || null,
        reasons: entry.record?.reason_codes || [],
        symbol: entry.record?.signal_id || null,
        confidence_bucket: entry.record?.confidence_bucket || null,
      });
    }
    if (entry.entry_type === 'signal') {
      signals.push({
        recorded_at: entry.record?.recorded_at || null,
        symbol: entry.record?.symbol || null,
        side: entry.record?.side || null,
        confidence: safeNumber(entry.record?.confidence_score, null),
        provider_confirmation: safeNumber(entry.record?.provider_confirmation_score, null),
        risk: safeNumber(entry.record?.risk_score, null),
        action_candidate: entry.record?.action_candidate || null,
      });
    }
  }

  return {
    paperOutcomes: paperOutcomes.slice(-6).reverse(),
    orders: orders.slice(-5).reverse(),
    openPositions: [...positionLedger.values()]
      .filter((position) => Math.abs(position.net_quantity) > 1e-12)
      .sort((a, b) => new Date(b.last_trade_at || 0) - new Date(a.last_trade_at || 0))
      .slice(0, 10)
      .map((position) => ({
        symbol: position.symbol,
        net_quantity: position.net_quantity,
        direction: position.net_quantity > 0 ? 'long' : 'short',
        last_trade_at: position.last_trade_at,
        last_side: position.last_side,
        last_price: position.last_price,
      })),
    riskDecisions: riskDecisions.slice(-6).reverse(),
    signals: signals.slice(-6).reverse(),
    lastTradeAt,
    lastBuyAt,
    lastSellAt,
  };
}

function buildOperatorTimeline(operatorEvents = [], recentEntries = {}, scannerRuntime = null) {
  const items = [];
  for (const event of Array.isArray(operatorEvents) ? operatorEvents : []) {
    items.push({
      timestamp: event.timestamp || event.at || null,
      type: event.event_type || 'operator_event',
      title: event.title || event.event_type || 'Operator event',
      message: event.message || '',
      severity: event.severity || 'info',
      source: event.source || 'operator',
      details: event.details || {},
    });
  }
  if (scannerRuntime?.last_scan_time) {
    items.push({
      timestamp: scannerRuntime.last_scan_time,
      type: 'scanner.latest_scan',
      title: `${scannerRuntime.mode || scannerRuntime.loaded_mode || 'Scanner'} latest scan`,
      message: scannerRuntime.last_scan_error
        ? `Scan error: ${scannerRuntime.last_scan_error}`
        : `Posted ${scannerRuntime.posted_count ?? 0}, approved ${scannerRuntime.approved_count ?? 0}, rejected ${scannerRuntime.rejected_count ?? 0}`,
      severity: scannerRuntime.last_scan_error ? 'warning' : 'info',
      source: scannerRuntime.scanner || 'scanner-runtime',
      details: {
        candidate_count: scannerRuntime.candidate_count ?? null,
        allocation: scannerRuntime.allocation || null,
        portfolio: scannerRuntime.portfolio || null,
      },
    });
  }
  for (const order of recentEntries.orders || []) {
    items.push({
      timestamp: order.recorded_at,
      type: 'trade.fill',
      title: `${String(order.side || 'trade').toUpperCase()} ${order.symbol || ''}`.trim(),
      message: `${order.status || 'order'} ${formatSignedNumber(order.pnl || 0)}`,
      severity: Number(order.pnl || 0) < 0 ? 'warning' : 'info',
      source: 'performance-history',
      details: order,
    });
  }
  for (const decision of recentEntries.riskDecisions || []) {
    items.push({
      timestamp: decision.recorded_at,
      type: 'risk.decision',
      title: decision.decision || 'Risk decision',
      message: Array.isArray(decision.reasons) && decision.reasons.length ? decision.reasons.join(', ') : 'No reasons',
      severity: decision.decision === 'APPROVED_FOR_PAPER' ? 'info' : 'warning',
      source: 'performance-history',
      details: decision,
    });
  }
  for (const signal of recentEntries.signals || []) {
    items.push({
      timestamp: signal.recorded_at,
      type: 'scanner.signal',
      title: `${signal.action_candidate || 'signal'} ${signal.symbol || ''}`.trim(),
      message: Number.isFinite(signal.confidence) ? `Confidence ${formatNumber(signal.confidence, 0)}` : 'Signal recorded',
      severity: 'info',
      source: 'performance-history',
      details: signal,
    });
  }
  return items
    .filter((item) => item.timestamp)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .slice(0, 30);
}

function normalizeLivePositions(livePositions = {}) {
  const positions = Array.isArray(livePositions?.positions) ? livePositions.positions : [];
  const liveCount = safeNumber(livePositions?.count, null);
  if (!Number.isFinite(liveCount) && !positions.length) {
    return {
      available: false,
      count: null,
      positions: [],
    };
  }

  const normalized = positions
    .map((position) => {
      const rawQty = safeNumber(position.qty ?? position.quantity ?? position.qty_available ?? 0, 0);
      const side = String(position.side || '').trim().toLowerCase();
      const signedQty = side === 'short' ? -Math.abs(rawQty) : Math.abs(rawQty);
      return {
        symbol: position.symbol || null,
        net_quantity: signedQty,
        qty: rawQty,
        direction: signedQty > 0 ? 'long' : signedQty < 0 ? 'short' : 'flat',
        last_trade_at: position.updated_at || position.created_at || null,
        last_side: side || null,
        avg_entry_price: safeNumber(position.avg_entry_price ?? position.avgEntryPrice ?? null, null),
        current_price: safeNumber(position.current_price ?? position.currentPrice ?? null, null),
        market_value: safeNumber(position.market_value ?? position.marketValue ?? null, null),
        cost_basis: safeNumber(position.cost_basis ?? position.costBasis ?? null, null),
        unrealized_pl: safeNumber(position.unrealized_pl ?? position.unrealizedPnl ?? position.unrealized_intraday_pl ?? null, null),
        last_price: safeNumber(position.current_price ?? position.avg_entry_price ?? position.market_value ?? null, null),
      };
    })
    .filter((position) => position.symbol && Math.abs(position.net_quantity) > 0);

  return {
    available: true,
    count: Number.isFinite(liveCount) ? liveCount : normalized.length,
    positions: normalized,
  };
}

function summarizePolicyHistory(entries = []) {
  return entries
    .map((entry) => ({
      source: entry.source || null,
      captured_at: entry.captured_at || null,
      max_open_positions: safeNumber(entry.policy?.maxOpenPositions, null),
      position_size_multiplier: safeNumber(entry.policy?.positionSizeMultiplier, null),
      min_confidence_for_paper: safeNumber(entry.policy?.minConfidenceForPaper, null),
      min_provider_confirmation_score: safeNumber(entry.policy?.minProviderConfirmationScore, null),
    }))
    .slice(-5)
    .reverse();
}

function buildSourceHealth(endpointResults, fileResults) {
  const sources = endpointResults.map((result) => ({
    source: result.source,
    ok: result.ok,
    status: result.status || null,
    error: result.error || null,
    kind: 'endpoint',
  }));
  sources.push({
    source: 'data/logs/overnight-status.json',
    ok: Boolean(fileResults.overnightStatusFile?.exists),
    status: fileResults.overnightStatusFile?.exists ? 'read' : 'missing',
    error: null,
    kind: 'file',
  });
  sources.push({
    source: 'data/performance-history.jsonl',
    ok: Boolean(fileResults.performanceHistory?.meta?.exists),
    status: fileResults.performanceHistory?.meta?.exists ? 'read' : 'missing',
    error: null,
    kind: 'file',
  });
  sources.push({
    source: 'data/policy-history.jsonl',
    ok: Boolean(fileResults.policyHistory?.meta?.exists),
    status: fileResults.policyHistory?.meta?.exists ? 'read' : 'missing',
    error: null,
    kind: 'file',
  });
  sources.push({
    source: 'data/logs/*.log',
    ok: true,
    status: `scanned_${fileResults.recentLogLines.length}_matches`,
    error: null,
    kind: 'file',
  });
  return sources;
}

function buildAlerts({ sourceHealth, recentLogLines, report, status, traderDiscovery, overnightStatusFile, scannerRuntimeFile, control, runtimeEnv, livePositions, recentEntries, configDrift, processDiscovery, exitManagement, exitProtection = [], envLocalWarning = null, preflight = null, policyHealth = null, brokerLocalReconciliation = null, partialFillSummary = null, candidateLifecycleSummary = null, setupFatigueSummary = null, sessionGuards = null, memeMonitorState = null, memeMonitorStatus = null }) {
  const alerts = [];
  const workflow = control?.workflow || {};
  const scanner = control?.scanner || {};
  const trader = control?.trader || {};
  if (scanner.multiple_running) {
    alerts.push({
      kind: 'critical',
      title: 'Multiple scanners running',
      message: `Detected scanner PIDs: ${(scanner.pids || []).join(', ') || 'unknown'}. Stop workflow should clear all repo scanners.`,
    });
  }
  if (trader.status === 'running' && scanner.status === 'stopped') {
    alerts.push({
      kind: 'warning',
      title: 'Trader running without scanner',
      message: 'The trader endpoint is up, but no repo scanner process is running.',
    });
  }
  if (trader.status !== 'running' && scanner.status === 'running') {
    alerts.push({
      kind: 'critical',
      title: 'Scanner running while trader is stopped',
      message: 'Signals may fail because the scanner is running without a healthy local trader endpoint.',
    });
  }
  if (Array.isArray(workflow.issues) && workflow.issues.length) {
    alerts.push({
      kind: workflow.issues.includes('MULTIPLE_SCANNERS_RUNNING') ? 'critical' : 'warning',
      title: 'Workflow state needs attention',
      message: workflow.issues.join(', '),
    });
  }
  const dashboardProcesses = processDiscovery?.dashboards || [];
  if (dashboardProcesses.length > 1) {
    alerts.push({
      kind: 'warning',
      title: 'Multiple dashboard processes',
      message: `Detected dashboard PIDs: ${dashboardProcesses.map((item) => item.pid).join(', ')}. Use the newest local URL if 1111 is locked.`,
    });
  }
  if (String(runtimeEnv?.TRADING_MODE || '').toLowerCase() === 'live' || String(runtimeEnv?.ALPACA_EXECUTION_ENABLED || '').toLowerCase() === 'true') {
    alerts.push({
      kind: 'critical',
      title: 'Alpaca execution mode is enabled',
      message: 'This local config can submit Alpaca orders through the trader. Dashboard buttons only control local processes.',
    });
  }
  if (configDrift?.has_drift) {
    alerts.push({
      kind: 'critical',
      title: 'Policy/config drift detected',
      message: configDrift.items.map((item) => `${item.field}: active ${item.active_display}, local ${item.expected_display}`).join('; '),
    });
  }
  if (envLocalWarning?.changed_after_start) {
    alerts.push({
      severity: 'warning',
      code: 'ENV_CHANGED_AFTER_START_RESTART_REQUIRED',
      title: '.env.local changed after start',
      message: 'Restart the workflow so the running trader and scanner pick up the latest local environment.',
    });
  }
  if (preflight?.status === 'NO_GO') {
    alerts.push({
      severity: 'critical',
      code: 'PREFLIGHT_NO_GO',
      title: 'Live preflight is NO-GO',
      message: (preflight.critical_failures || []).join(', ') || 'Preflight reported critical failures.',
    });
  } else if (preflight?.status === 'WARN') {
    alerts.push({
      severity: 'warning',
      code: 'PREFLIGHT_WARN',
      title: 'Live preflight has warnings',
      message: (preflight.warnings || []).slice(0, 3).join(', ') || 'Preflight reported warnings.',
    });
  }
  if (policyHealth && (policyHealth.warnings?.length || policyHealth.critical_failures?.length)) {
    alerts.push({
      severity: policyHealth.critical_failures?.length ? 'critical' : 'warning',
      code: 'POLICY_HEALTH_WARNING',
      title: 'Policy health needs review',
      message: [...(policyHealth.critical_failures || []), ...(policyHealth.warnings || [])].slice(0, 4).join(', '),
    });
  }
  if (brokerLocalReconciliation?.status === 'CRITICAL') {
    alerts.push({
      severity: 'critical',
      code: 'BROKER_LOCAL_RECONCILIATION_CRITICAL',
      title: 'Broker/local state mismatch',
      message: (brokerLocalReconciliation.critical_failures || []).slice(0, 4).join(', ') || 'Reconciliation reported critical mismatches.',
    });
  } else if (brokerLocalReconciliation?.status === 'WARN') {
    alerts.push({
      severity: 'warning',
      code: 'BROKER_LOCAL_RECONCILIATION_WARN',
      title: 'Broker/local reconciliation warning',
      message: (brokerLocalReconciliation.warnings || []).slice(0, 4).join(', ') || 'Reconciliation reported warnings.',
    });
  }
  if (partialFillSummary?.count > 0) {
    alerts.push({
      severity: partialFillSummary.stale_partials?.length ? 'warning' : 'info',
      code: 'PARTIAL_FILL_PENDING',
      title: 'Partial fills need tracking',
      message: `${partialFillSummary.count} active partial fill(s); blocked symbols: ${(partialFillSummary.blocked_symbols || []).join(', ') || 'none'}.`,
    });
  }
  if (candidateLifecycleSummary?.blocked_count > 0 || candidateLifecycleSummary?.expired_count > 0) {
    alerts.push({
      severity: 'info',
      code: 'CANDIDATE_LIFECYCLE_ACTIVE',
      title: 'Candidate lifecycle is active',
      message: `${candidateLifecycleSummary.blocked_count || 0} blocked and ${candidateLifecycleSummary.expired_count || 0} expired candidate(s).`,
    });
  }
  if (sessionGuards?.buy_blocked) {
    alerts.push({
      severity: 'warning',
      code: 'SESSION_GUARDS_ACTIVE',
      title: 'Session guard is active',
      message: `${(sessionGuards.reason_codes || []).slice(0, 4).join(', ') || 'A session guard is blocking buys.'}`,
    });
  }
  if (setupFatigueSummary?.active_setup_count > 0) {
    alerts.push({
      severity: 'warning',
      code: 'SETUP_FATIGUE_ACTIVE',
      title: 'Setup fatigue is active',
      message: `${setupFatigueSummary.active_setup_count} setup(s) are paused for fatigue.`,
    });
  }
  if (memeMonitorState?.summary) {
    const memeSummary = memeMonitorState.summary;
    if (memeSummary.master_enabled) {
      alerts.push({
        severity: 'info',
        code: 'MEME_FEATURES_ENABLED',
        title: 'Meme Monitor is staged',
        message: `Meme feature state source: ${memeSummary.source || 'env + runtime state'}. Blocked features: ${(memeSummary.blocked_features || []).join(', ') || 'none'}.`,
      });
    } else if ((memeSummary.blocked_features || []).length) {
      alerts.push({
        severity: 'warning',
        code: 'MEME_FEATURES_BLOCKED',
        title: 'Meme features are blocked',
        message: `Blocked features: ${(memeSummary.blocked_features || []).join(', ')}.`,
      });
    }
  }
  if (memeMonitorStatus?.redditScanner?.status === 'missing_credentials') {
    alerts.push({
      severity: 'warning',
      code: 'MEME_REDDIT_MISSING_CREDENTIALS',
      title: 'Reddit scanner is missing credentials',
      message: 'The Meme Monitor can stay loaded, but Reddit collection remains disabled until credentials are provided.',
    });
  }
  if (memeMonitorStatus?.hotList?.stale && String(memeMonitorStatus?.hotList?.status || '').toLowerCase() !== 'off') {
    alerts.push({
      severity: 'warning',
      code: 'MEME_HOT_LIST_STALE',
      title: 'Meme hot list is stale',
      message: 'Hot list entries have expired or scoring has not refreshed recently.',
    });
  }
  const unprotectedPositions = (Array.isArray(exitProtection) ? exitProtection : []).filter((item) => item.classification === 'none');
  if (unprotectedPositions.length) {
    alerts.push({
      severity: 'critical',
      code: 'EXIT_MANAGER_REQUIRED',
      title: 'Open position lacks confirmed exit protection',
      message: `${unprotectedPositions.map((item) => item.symbol).join(', ')} has no broker-native protective order or fresh scanner exit manager record.`,
    });
  }
  if (livePositions?.available && Number(livePositions.count) === 0 && Array.isArray(recentEntries?.openPositions) && recentEntries.openPositions.length > 0) {
    alerts.push({
      kind: 'warning',
      title: 'Live positions disagree with local history',
      message: 'Alpaca currently reports zero positions, so Home uses zero. Historical local positions are stale until new fills arrive.',
    });
  }
  if (exitManagement && !exitManagement.managed && Array.isArray(exitManagement.positions) && exitManagement.positions.length > 0) {
    alerts.push({
      kind: 'critical',
      title: 'Exits are not actively managed',
      message: `Exit manager is ${exitManagement.state}. Reasons: ${exitManagement.reasons.join(', ') || 'unknown'}.`,
    });
  }
  if (traderDiscovery?.selected === null) {
    alerts.push({
      kind: 'warning',
      title: 'Trader endpoint not detected',
      message: 'The dashboard could not confirm a live trader base URL. File-based snapshots are still available.',
    });
  }
  for (const item of sourceHealth) {
    if (!item.ok) {
      alerts.push({
        kind: 'warning',
        title: `Source unavailable: ${item.source}`,
        message: item.error || 'No fresh data from this source yet.',
      });
    }
  }
  if (report && Number.isFinite(report.paper_pnl) && report.paper_pnl < 0) {
    alerts.push({
      kind: 'critical',
      title: 'Local history PnL is negative',
      message: `Today’s local-history PnL is ${formatSignedNumber(report.paper_pnl)}.`,
    });
  }
  if (status && Number.isFinite(status.uptime_minutes) && status.uptime_minutes < 10) {
    alerts.push({
      kind: 'info',
      title: 'Fresh startup',
      message: `The trader has only been up for ${formatNumber(status.uptime_minutes, 1)} minutes.`,
    });
  }
  if (overnightStatusFile && isSnapshotStale(overnightStatusFile.timestamp || overnightStatusFile.payload?.timestamp || overnightStatusFile.started_at, 20)) {
    alerts.push({
      kind: 'warning',
      title: 'Legacy snapshot looks stale',
      message: 'A legacy snapshot has not been refreshed recently.',
    });
  }
  if (scannerRuntimeFile && isSnapshotStale(scannerRuntimeFile.last_scan_time || scannerRuntimeFile.updated_at, 5)) {
    alerts.push({
      kind: 'warning',
      title: 'Scanner scan is stale',
      message: 'The scanner runtime snapshot has not recorded a fresh scan in the last few minutes.',
    });
  }
  if (recentLogLines.length) {
    alerts.push({
      kind: 'info',
      title: 'Recent log signals',
      message: recentLogLines[0].line.slice(0, 180),
    });
  }
  return alerts.slice(0, 8);
}

function buildSummary({ status, report, activePolicySnapshot, regime, liveMarketRules, recentEntries, livePositions, liveAccount, control, preflight = null, brokerLocalReconciliation = null, partialFillSummary = null, executionQualitySummary = null, candidateLifecycleSummary = null, antiChurnSummary = null, setupFatigueSummary = null, sessionGuards = null, memeMonitorState = null, memeMonitorStatus = null, scannerRuntime = null }) {
  const totalTradesToday = safeNumber(report?.paper_fills ?? report?.paper_orders ?? recentEntries.paperOutcomes.length, null);
  const uptimeHours = Number.isFinite(Number(status?.uptime_minutes)) ? Number(status.uptime_minutes) / 60 : null;
  const derivedOpenPositions = recentEntries.openPositions.length;
  const liveOpenPositionsCount = livePositions?.available && Number.isFinite(Number(livePositions?.count))
    ? Number(livePositions.count)
    : null;
  const accountEquity = safeNumber(liveAccount?.data?.equity ?? liveAccount?.data?.portfolio_value ?? null, null);
  const accountLastEquity = safeNumber(liveAccount?.data?.last_equity ?? null, null);
  const accountChangeToday = Number.isFinite(accountEquity) && Number.isFinite(accountLastEquity)
    ? Math.round((accountEquity - accountLastEquity) * 100) / 100
    : safeNumber(report?.paper_pnl, null);
  const accountCash = safeNumber(liveAccount?.data?.cash ?? null, null);
  return {
    trader_status: control?.trader?.status || status?.status || 'unknown',
    preflight_status: preflight?.status || null,
    preflight_checked_at: preflight?.checked_at || null,
    reconciliation_status: brokerLocalReconciliation?.status || null,
    reconciliation_checked_at: brokerLocalReconciliation?.checked_at || null,
    reconciliation_mismatch_count: Array.isArray(brokerLocalReconciliation?.mismatches) ? brokerLocalReconciliation.mismatches.length : null,
    reconciliation_critical_count: Array.isArray(brokerLocalReconciliation?.critical_failures) ? brokerLocalReconciliation.critical_failures.length : null,
    partial_fill_count: safeNumber(partialFillSummary?.count, 0),
    partial_fill_blocked_symbols: partialFillSummary?.blocked_symbols || [],
    partial_fill_reserved_buy_notional: safeNumber(partialFillSummary?.reserved_buy_notional, 0),
    execution_quality_recent_bad_symbols: Array.isArray(executionQualitySummary?.recent_bad_fills)
      ? executionQualitySummary.recent_bad_fills.map((item) => item.symbol).filter(Boolean).slice(0, 5)
      : [],
    execution_quality_top_symbols: Array.isArray(executionQualitySummary?.by_symbol)
      ? executionQualitySummary.by_symbol.slice(0, 5)
      : [],
    execution_quality_top_setups: Array.isArray(executionQualitySummary?.by_setup)
      ? executionQualitySummary.by_setup.slice(0, 5)
      : [],
    execution_quality_total_trades: safeNumber(executionQualitySummary?.total_trades, 0),
    execution_quality_average_score: safeNumber(executionQualitySummary?.average_quality_score, 0),
    execution_quality_partial_fill_rate: safeNumber(executionQualitySummary?.partial_fill_rate, 0),
    execution_quality_rejection_rate: safeNumber(executionQualitySummary?.rejection_rate, 0),
    execution_quality_cancellation_rate: safeNumber(executionQualitySummary?.cancellation_rate, 0),
    execution_quality_duplicate_risk_rate: safeNumber(executionQualitySummary?.duplicate_risk_rate, 0),
    execution_quality_recent_bad_count: Array.isArray(executionQualitySummary?.recent_bad_fills) ? executionQualitySummary.recent_bad_fills.length : 0,
    candidate_lifecycle_mode: candidateLifecycleSummary?.scanner_mode || null,
    candidate_lifecycle_queue_enabled: Boolean(candidateLifecycleSummary?.queue_enabled),
    candidate_lifecycle_selected_symbol: candidateLifecycleSummary?.selected_symbol || null,
    candidate_lifecycle_watched_count: safeNumber(candidateLifecycleSummary?.watched_count, 0),
    candidate_lifecycle_eligible_count: safeNumber(candidateLifecycleSummary?.eligible_count, 0),
    candidate_lifecycle_blocked_count: safeNumber(candidateLifecycleSummary?.blocked_count, 0),
    candidate_lifecycle_expired_count: safeNumber(candidateLifecycleSummary?.expired_count, 0),
    candidate_lifecycle_reason_codes: candidateLifecycleSummary?.reason_codes || [],
    anti_churn_active: Boolean(antiChurnSummary?.active_churn_guard),
    anti_churn_penalty_points: safeNumber(antiChurnSummary?.penalty_points, 0),
    anti_churn_symbol_cooldown_count: safeNumber(antiChurnSummary?.symbol_cooldown_count, 0),
    anti_churn_setup_cooldown_count: safeNumber(antiChurnSummary?.setup_cooldown_count, 0),
    anti_churn_recent_exit_count: safeNumber(antiChurnSummary?.recent_exit_count, 0),
    anti_churn_reason_codes: antiChurnSummary?.reason_codes || [],
    setup_fatigue_active_count: safeNumber(setupFatigueSummary?.active_setup_count, 0),
    setup_fatigue_paused_count: safeNumber(setupFatigueSummary?.paused_setup_count, 0),
    setup_fatigue_total_count: safeNumber(setupFatigueSummary?.setup_count, 0),
    session_guard_active_count: safeNumber(sessionGuards?.active_guard_count, 0),
    session_guard_buy_blocked: Boolean(sessionGuards?.buy_blocked),
    session_guard_manage_only: Boolean(sessionGuards?.manage_only),
    session_guard_reason_codes: sessionGuards?.reason_codes || [],
    meme_monitor_enabled: Boolean(memeMonitorState?.summary?.master_enabled),
    meme_monitor_source: memeMonitorState?.summary?.source || memeMonitorState?.source || 'env + runtime state',
    meme_monitor_blocked_features: memeMonitorState?.summary?.blocked_features || [],
    meme_monitor_warning_count: Array.isArray(memeMonitorState?.warnings) ? memeMonitorState.warnings.length : 0,
    meme_monitor_reddit_status: memeMonitorStatus?.redditScanner?.status || 'off',
    meme_monitor_reddit_last_run_at: memeMonitorStatus?.redditScanner?.lastRunAt || null,
    meme_monitor_reddit_symbols_detected: safeNumber(memeMonitorStatus?.redditScanner?.symbolsDetected, 0),
    meme_monitor_hot_list_status: memeMonitorStatus?.hotList?.status || 'off',
    meme_monitor_hot_list_dynamic_count: safeNumber(memeMonitorStatus?.hotList?.dynamicCount, 0),
    meme_monitor_hot_list_hot_hot_count: safeNumber(memeMonitorStatus?.hotList?.hotHotCount, 0),
    meme_monitor_hot_list_stale: Boolean(memeMonitorStatus?.hotList?.stale),
    risk_budget_sizing_enabled: Boolean(liveMarketRules.risk_budget_sizing?.enabled),
    risk_budget_latest_candidate_count: Array.isArray(scannerRuntime?.risk_budget_sizing?.latest_candidates) ? scannerRuntime.risk_budget_sizing.latest_candidates.length : 0,
    workflow_state: control?.workflow?.status || 'unknown',
    scanner_profile: control?.scanner?.profile || control?.workflow?.desired_scanner_profile || null,
    trader_mode: status?.mode || null,
    regime: liveMarketRules?.workflow || 'Live Market',
    uptime_minutes: safeNumber(status?.uptime_minutes, null),
    paper_pnl: safeNumber(report?.paper_pnl, null),
    blocked_count: safeNumber(report?.blocked_count, null),
    approved_count: safeNumber(report?.approved_count, null),
    false_positives: safeNumber(report?.false_positives, null),
    max_open_positions: safeNumber(activePolicySnapshot?.policy?.maxOpenPositions, null),
    live_market_max_positions: liveMarketRules.max_open_positions,
    buy_notional_target: liveMarketRules.buy_notional_target,
    min_buy_notional: liveMarketRules.min_buy_notional,
    stop_loss_dollars: liveMarketRules.stop_loss_dollars,
    stop_loss_notional_pct: liveMarketRules.stop_loss_notional_pct,
    stop_loss_max_dollars: liveMarketRules.stop_loss_max_dollars,
    trailing_profit_start_dollars: liveMarketRules.trailing_profit_start_dollars,
    trailing_profit_giveback_dollars: liveMarketRules.trailing_profit_giveback_dollars,
    sell_profit_threshold_pct: liveMarketRules.sell_profit_threshold_pct,
    sell_net_profit_floor_dollars: liveMarketRules.sell_net_profit_floor_dollars,
    risk_budget_sizing: liveMarketRules.risk_budget_sizing,
    approved_symbols: liveMarketRules.approved_symbols,
    position_size_multiplier: safeNumber(activePolicySnapshot?.policy?.positionSizeMultiplier, null),
    recent_activity_count: recentEntries.paperOutcomes.length + recentEntries.riskDecisions.length + recentEntries.signals.length,
    total_trades_today: totalTradesToday,
    average_trades_per_hour: Number.isFinite(totalTradesToday) && Number.isFinite(uptimeHours) && uptimeHours > 0 ? totalTradesToday / uptimeHours : null,
    open_positions_count: liveOpenPositionsCount ?? derivedOpenPositions,
    live_open_positions_count: liveOpenPositionsCount,
    open_positions_count_source: liveOpenPositionsCount !== null ? 'alpaca' : 'derived',
    derived_open_positions_count: derivedOpenPositions,
    daily_change: accountChangeToday,
    daily_change_source: Number.isFinite(accountEquity) && Number.isFinite(accountLastEquity) ? 'alpaca' : 'report',
    account_equity: accountEquity,
    account_last_equity: accountLastEquity,
    account_cash: accountCash,
    account_buying_power: safeNumber(liveAccount?.data?.buying_power ?? null, null),
    last_trade_at: recentEntries.lastTradeAt || recentEntries.lastSellAt || recentEntries.lastBuyAt || null,
    last_buy_at: recentEntries.lastBuyAt || null,
    last_sell_at: recentEntries.lastSellAt || null,
  };
}

function buildWatchSnapshot({
  regime = {},
  live = {},
  summary = {},
  memeMonitorState = null,
  memeMonitorStatus = null,
  regularWatchState = null,
  regularWatchStatus = null,
  scannerRuntime = null,
  dynamicHotList = null,
  hotSlotRotationState = null,
  livePositions = null,
  liveOpenOrders = null,
  partialFillSummary = null,
  approvedSymbols = [],
  currentDate = new Date(),
} = {}) {
  const approved = (Array.isArray(approvedSymbols) ? approvedSymbols : [])
    .map((symbol) => normalizeWatchSymbol(symbol))
    .filter(Boolean);
  const approvedSet = new Set(approved);
  const runtime = scannerRuntime || live?.scannerRuntime || null;
  const candidateDetails = Array.isArray(runtime?.candidate_rank_details) ? runtime.candidate_rank_details : [];
  const recentSkips = Array.isArray(runtime?.recent_skips) ? runtime.recent_skips : [];
  const candidateBySymbol = new Map();
  for (const entry of candidateDetails) {
    const symbol = normalizeWatchSymbol(entry?.symbol);
    if (!symbol || candidateBySymbol.has(symbol)) continue;
    candidateBySymbol.set(symbol, entry);
  }
  const regularWatchStatusEntries = Array.isArray(regularWatchStatus?.regularWatchList)
    ? regularWatchStatus.regularWatchList
    : [];
  const regularWatchEntryBySymbol = new Map();
  for (const entry of regularWatchStatusEntries) {
    const symbol = normalizeWatchSymbol(entry?.symbol);
    if (!symbol || regularWatchEntryBySymbol.has(symbol)) continue;
    regularWatchEntryBySymbol.set(symbol, entry);
  }
  const recentSkipBySymbol = new Map();
  for (const entry of recentSkips) {
    const symbol = normalizeWatchSymbol(entry?.symbol);
    if (!symbol || recentSkipBySymbol.has(symbol)) continue;
    recentSkipBySymbol.set(symbol, entry);
  }
  const livePositionMap = buildLivePositionMap(livePositions);
  const liveOrderMap = buildLiveOpenOrderMap(liveOpenOrders);

  const regularWatchList = approved.map((symbol) => buildRegularWatchEntry(symbol, {
    candidate: candidateBySymbol.get(symbol) || null,
    recentSkip: recentSkipBySymbol.get(symbol) || null,
    regularWatchEntry: regularWatchEntryBySymbol.get(symbol) || null,
    livePosition: livePositionMap.get(symbol) || null,
    liveOpenOrders: liveOrderMap.get(symbol) || [],
    partialFillSummary,
    currentDate,
  }));

  const regularWatchMovers = regularWatchList
    .filter((entry) => Number.isFinite(Number(entry.dailyMovePct)) || Number.isFinite(Number(entry.lastPrice)) || Number.isFinite(Number(entry.scannerScore)))
    .slice()
    .sort((a, b) => {
      const scoreDelta = Number(b.regularWatchScore || b.scannerScore || 0) - Number(a.regularWatchScore || a.scannerScore || 0);
      if (Math.abs(scoreDelta) > 1e-9) return scoreDelta;
      const moveDelta = Math.abs(Number(b.dailyMovePct || 0)) - Math.abs(Number(a.dailyMovePct || 0));
      if (Math.abs(moveDelta) > 1e-9) return moveDelta;
      return String(a.symbol).localeCompare(String(b.symbol));
    });

  const dynamicPayload = dynamicHotList || live?.memeMonitorStatus?.hotListPayload || live?.memeMonitorRuntime?.hotListPayload || null;
  const dynamicEnabled = Boolean(memeMonitorStatus?.hotList?.enabled);
  const hotHotEnabled = Boolean(memeMonitorStatus?.hotHotScoring?.enabled);
  const watchedSymbols = new Set(approvedSet);
  for (const entry of [...(dynamicPayload?.dynamicHotList || []), ...(dynamicPayload?.hotHotList || [])]) {
    const symbol = normalizeWatchSymbol(entry?.symbol);
    if (symbol) watchedSymbols.add(symbol);
  }
  const dynamicSymbols = buildMemeWatchSymbols({
    entries: dynamicPayload?.dynamicHotList || dynamicPayload?.symbols || [],
    approvedSet,
    currentDate,
    watchedSymbols,
  });
  const hotHotSymbols = buildMemeWatchSymbols({
    entries: dynamicPayload?.hotHotList || [],
    approvedSet,
    currentDate,
    watchedSymbols,
    hotHot: true,
    rotationState: hotSlotRotationState || summarizeHotSlotRotationRuntime(runtime?.hot_slot_rotation || null, memeMonitorState?.features?.MEME_HOT_SLOT_ROTATION_ENABLED),
  });
  const hotSlotRotation = hotSlotRotationState || summarizeHotSlotRotationRuntime(runtime?.hot_slot_rotation || null, memeMonitorState?.features?.MEME_HOT_SLOT_ROTATION_ENABLED);

  return {
    regularWatchList,
    regularWatchMovers,
    dynamicHotList: {
      enabled: dynamicEnabled,
      status: dynamicEnabled ? (memeMonitorStatus?.hotList?.status || 'shadow') : 'disabled',
      stale: Boolean(memeMonitorStatus?.hotList?.stale),
      lastScoredAt: memeMonitorStatus?.hotList?.lastScoredAt || dynamicPayload?.lastScoredAt || dynamicPayload?.generatedAt || null,
      lastError: memeMonitorStatus?.hotList?.lastError || null,
      symbols: dynamicSymbols,
    },
    hotHotList: {
      enabled: hotHotEnabled,
      status: hotHotEnabled ? (memeMonitorStatus?.hotHotScoring?.status || 'shadow') : 'disabled',
      stale: Boolean(memeMonitorStatus?.hotHotScoring?.stale ?? memeMonitorStatus?.hotList?.stale),
      lastScoredAt: memeMonitorStatus?.hotHotScoring?.lastScoredAt || memeMonitorStatus?.hotList?.lastScoredAt || dynamicPayload?.lastScoredAt || null,
      lastError: memeMonitorStatus?.hotHotScoring?.lastError || memeMonitorStatus?.hotList?.lastError || null,
      symbols: hotHotSymbols,
    },
    regularWatchIntelligence: buildRegularWatchIntelligenceSnapshot({
      regularWatchState,
      regularWatchStatus,
      scannerRuntime,
      livePositions,
      liveOpenOrders,
      partialFillSummary,
    }),
    memeMonitor: {
      dynamicWatchlist: summarizeMemeRuntimeFeature({
        feature: memeMonitorState?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED,
        status: memeMonitorStatus?.hotList,
        count: dynamicSymbols.length,
        active: dynamicEnabled,
        label: 'Dynamic Watchlist',
      }),
      priorityOverride: summarizeMemeRuntimeFeature({
        feature: memeMonitorState?.features?.MEME_PRIORITY_OVERRIDE_ENABLED,
        status: memeMonitorStatus?.hotHotScoring,
        count: hotHotSymbols.length,
        active: hotHotEnabled,
        label: 'Priority Override',
      }),
      hotSlotRotation,
      phaseA: memeMonitorStatus?.phaseA || null,
      phaseB: memeMonitorStatus?.phaseB || null,
    },
    phaseB: memeMonitorStatus?.phaseB || null,
    hotSlotRotation,
    featureState: summarizeMemeFeatureState(memeMonitorState),
    actionsState: [
      ...summarizeMemeActionsState(memeMonitorState),
      ...summarizeRegularWatchActionsState(regularWatchState),
    ],
  };
}

function buildRegularWatchIntelligenceSnapshot({
  regularWatchState = null,
  regularWatchStatus = null,
  scannerRuntime = null,
  livePositions = null,
  liveOpenOrders = null,
  partialFillSummary = null,
} = {}) {
  const featureState = summarizeRegularWatchFeatureState(regularWatchState);
  const status = regularWatchStatus || loadRegularWatchStatus();
  const runtime = buildRegularWatchStatusSnapshot({
    featureState: regularWatchState,
    status,
  });
  return {
    enabled: Boolean(featureState.master_enabled),
    status: runtime.regularWatchIntelligence.status || 'off',
    lastRunAt: runtime.regularWatchIntelligence.lastRunAt || null,
    lastError: runtime.regularWatchIntelligence.lastError || null,
    symbolsChecked: Number(runtime.regularWatchIntelligence.symbolsChecked || 0),
    moversFound: Number(runtime.regularWatchIntelligence.moversFound || 0),
    blockedSymbols: Number(runtime.regularWatchIntelligence.blockedSymbols || 0),
    features: runtime.regularWatchIntelligence.features,
    scannerRanking: {
      enabled: Boolean(runtime.regularWatchIntelligence.features.scannerRanking),
      status: runtime.regularWatchIntelligence.features.scannerRanking
        ? runtime.regularWatchIntelligence.status
        : 'off',
      lastRunAt: runtime.regularWatchIntelligence.lastRunAt || null,
      lastError: runtime.regularWatchIntelligence.lastError || null,
    },
    positionAwareness: {
      enabled: Boolean(runtime.regularWatchIntelligence.features.positionAwareness),
      status: runtime.regularWatchIntelligence.features.positionAwareness
        ? runtime.regularWatchIntelligence.status
        : 'off',
      lastRunAt: runtime.regularWatchIntelligence.lastRunAt || null,
      lastError: runtime.regularWatchIntelligence.lastError || null,
    },
    candidateComparison: buildRegularWatchCandidateComparisons({
      regularWatchList: Array.isArray(runtime.regularWatchList) ? runtime.regularWatchList : [],
      scannerRuntime,
      livePositions,
      liveOpenOrders,
      partialFillSummary,
    }),
    featureState,
    regularWatchList: Array.isArray(runtime.regularWatchList) ? runtime.regularWatchList.slice() : [],
    regularWatchMovers: Array.isArray(runtime.regularWatchMovers) ? runtime.regularWatchMovers.slice() : [],
    sources: Array.isArray(runtime.sources) ? runtime.sources.slice() : [],
    generatedAt: runtime.generatedAt || null,
    stale: Boolean(runtime.stale),
    runtime,
  };
}

function buildRegularWatchCandidateComparisons({ regularWatchList = [], scannerRuntime = null, livePositions = null, liveOpenOrders = null, partialFillSummary = null } = {}) {
  const scanBySymbol = new Map();
  for (const entry of Array.isArray(scannerRuntime?.candidate_rank_details) ? scannerRuntime.candidate_rank_details : []) {
    const symbol = normalizeWatchSymbol(entry?.symbol);
    if (!symbol || scanBySymbol.has(symbol)) continue;
    scanBySymbol.set(symbol, entry);
  }
  const livePositionMap = buildLivePositionMap(livePositions);
  const liveOrderMap = buildLiveOpenOrderMap(liveOpenOrders);
  return (Array.isArray(regularWatchList) ? regularWatchList : []).map((entry) => {
    const symbol = normalizeWatchSymbol(entry?.symbol);
    if (!symbol) return null;
    const scannerEntry = scanBySymbol.get(symbol) || null;
    const livePosition = livePositionMap.get(symbol) || null;
    return buildRegularWatchCandidateComparison({
      scannerEntry,
      regularWatchEntry: entry,
      livePosition,
      liveOpenOrders: liveOrderMap.get(symbol) || [],
      partialFillSummary,
    });
  }).filter(Boolean);
}

function buildRegularWatchEntry(symbol, { candidate = null, recentSkip = null, regularWatchEntry = null, livePosition = null, liveOpenOrders = [], partialFillSummary = null, currentDate = null } = {}) {
  const hasCandidate = Boolean(candidate && typeof candidate === 'object');
  const skipReason = normalizeWatchReason(recentSkip?.reason || recentSkip?.skip_reason || null);
  const status = hasCandidate
    ? 'watching'
    : skipReason === 'excluded'
      ? 'excluded'
      : skipReason === 'blocked'
        ? 'blocked'
        : 'stale';
  const reasonCodes = [];
  if (hasCandidate) {
    reasonCodes.push(...normalizeReasonList(candidate.reason_codes));
    reasonCodes.push(...normalizeReasonList(candidate.candidate_lifecycle_reason_codes));
    if (candidate.setup_fatigue_active) reasonCodes.push('setup_fatigue_active');
    if (candidate.anti_churn_recent_winner_protected) reasonCodes.push('anti_churn_recent_winner_protected');
    if (candidate.session_guard_blocked) reasonCodes.push('session_guard_blocked');
  } else if (recentSkip?.reason) {
    reasonCodes.push(String(recentSkip.reason));
    if (recentSkip.stage) reasonCodes.push(String(recentSkip.stage));
  } else {
    reasonCodes.push('market_data_unavailable');
  }

  const volumeMultiple = Number.isFinite(Number(candidate?.volume_multiple))
    ? Number(candidate.volume_multiple)
    : computeVolumeMultiple(candidate?.volume, candidate?.average_volume);
  const freshness = hasCandidate ? 'fresh' : (candidate?.candidate_lifecycle_reason_codes?.length ? 'stale' : 'unknown');
  const regularWatchComparison = regularWatchEntry ? buildRegularWatchCandidateComparison({
    scannerEntry: candidate,
    regularWatchEntry,
    livePosition,
    liveOpenOrders,
    partialFillSummary,
  }) : null;
  const positionAwarenessTags = Array.isArray(candidate?.position_awareness_tags)
    ? candidate.position_awareness_tags.slice()
    : buildWatchPositionAwarenessTags({
      symbol,
      livePosition,
      liveOpenOrders,
      partialFillSummary,
      candidate,
    });

  return {
    symbol,
    lastPrice: safeNumber(candidate?.current_price, null),
    currentPrice: safeNumber(candidate?.current_price, null),
    previousClose: safeNumber(candidate?.previous_close, null),
    dailyMovePct: safeNumber(candidate?.move_pct, null),
    movePct: safeNumber(candidate?.move_pct, null),
    volume: safeNumber(candidate?.volume, null),
    spread: safeNumber(candidate?.spread_pct, null),
    spreadPct: safeNumber(candidate?.spread_pct, null),
    volumeMultiple,
    scannerScore: safeNumber(candidate?.adjusted_rank_score ?? candidate?.rank_score, null),
    regularWatchScore: safeNumber(regularWatchEntry?.score, null),
    status,
    reason: hasCandidate ? null : recentSkip?.reason || 'market_data_unavailable',
    reasonCodes: [...new Set(reasonCodes.filter(Boolean))],
    riskWarnings: [...new Set(normalizeReasonList(candidate?.risk_warnings))],
    freshness,
    marketDataState: hasCandidate ? 'available' : 'missing',
    scannerWatched: approvedSymbolMatch(symbol, candidate),
    tradableStatus: candidate?.tradable_status || 'unknown',
    haltStatus: candidate?.halt_status || 'unknown',
    sourceStatus: Array.isArray(regularWatchEntry?.sourceStatus)
      ? regularWatchEntry.sourceStatus.slice()
      : (Array.isArray(candidate?.source_status) ? candidate.source_status.slice() : []),
    sourceDetails: Array.isArray(regularWatchEntry?.sourceStatus)
      ? regularWatchEntry.sourceStatus.slice()
      : (Array.isArray(candidate?.source_status) ? candidate.source_status.slice() : []),
    positionStatus: resolvePositionStatus(livePosition, liveOpenOrders, partialFillSummary, candidate),
    positionTags: positionAwarenessTags,
    candidateComparison: regularWatchComparison,
    blockedReason: candidate?.blocked_reason || regularWatchEntry?.blockedReason || null,
    currentDate: currentDate ? String(currentDate) : null,
  };
}

function buildRegularWatchCandidateComparison({
  scannerEntry = null,
  regularWatchEntry = null,
  livePosition = null,
  liveOpenOrders = [],
  partialFillSummary = null,
} = {}) {
  if (!regularWatchEntry) return null;
  const scannerScore = safeNumber(scannerEntry?.adjusted_rank_score ?? scannerEntry?.rank_score, null);
  const regularWatchScore = safeNumber(regularWatchEntry?.score, null);
  const scoreDelta = Number.isFinite(scannerScore) && Number.isFinite(regularWatchScore)
    ? Number((regularWatchScore - scannerScore).toFixed(2))
    : null;
  return {
    symbol: regularWatchEntry.symbol || scannerEntry?.symbol || null,
    scannerScore,
    regularWatchScore,
    scoreDelta,
    regularWatchStatus: regularWatchEntry.status || null,
    sourceStatus: Array.isArray(regularWatchEntry.sourceStatus) ? regularWatchEntry.sourceStatus.slice() : [],
    sourceContributors: Array.isArray(scannerEntry?.sourceStatus) ? scannerEntry.sourceStatus.slice() : [],
    blockedReason: regularWatchEntry.blockedReason || null,
    positionTags: Array.isArray(scannerEntry?.position_awareness_tags) ? scannerEntry.position_awareness_tags.slice() : buildWatchPositionAwarenessTags({
      symbol: regularWatchEntry.symbol || scannerEntry?.symbol,
      livePosition,
      liveOpenOrders,
      partialFillSummary,
      candidate: scannerEntry,
    }),
  };
}

function buildWatchPositionAwarenessTags({ symbol, livePosition = null, liveOpenOrders = [], partialFillSummary = null, candidate = null } = {}) {
  const tags = new Set(Array.isArray(candidate?.position_awareness_tags) ? candidate.position_awareness_tags : []);
  const qty = safeNumber(livePosition?.qty ?? livePosition?.quantity ?? livePosition?.net_quantity ?? candidate?.position_qty_available ?? 0, 0);
  if (!Number.isFinite(qty) || Math.abs(qty) <= 0) return [...tags];
  const avgEntry = safeNumber(livePosition?.avg_entry_price ?? livePosition?.avgEntryPrice ?? candidate?.position_avg_entry_price ?? null, null);
  const currentPrice = safeNumber(candidate?.current_price ?? candidate?.currentPrice ?? null, null);
  const unrealizedPl = safeNumber(livePosition?.unrealized_pl ?? livePosition?.unrealizedPnl ?? livePosition?.unrealized_intraday_pl ?? null, null);
  const pctMove = Number.isFinite(avgEntry) && avgEntry > 0 && Number.isFinite(currentPrice)
    ? ((currentPrice - avgEntry) / avgEntry) * 100
    : null;
  const orders = Array.isArray(liveOpenOrders) ? liveOpenOrders : [];
  const hasOpenSellOrder = orders.some((order) => String(order?.symbol || '').trim().toUpperCase() === String(symbol || '').trim().toUpperCase() && String(order?.side || '').toLowerCase() === 'sell');
  const hasPartialFill = Boolean(findPendingPartialForSymbol(partialFillSummary || {}, symbol, 'sell') || findPendingPartialForSymbol(partialFillSummary || {}, symbol, 'buy'));
  if (Number.isFinite(pctMove) && pctMove >= 12) tags.add('strong_runner');
  if (Number.isFinite(pctMove) && Math.abs(pctMove) <= 1.5) tags.add('weak_flat');
  if (Number.isFinite(unrealizedPl) && Math.abs(unrealizedPl) <= 0.25) tags.add('break_even_stale');
  if (hasOpenSellOrder || hasPartialFill) tags.add('do_not_evict');
  if (candidate?.rotationEligible || candidate?.candidate_lifecycle_selected) tags.add('rotation_candidate');
  return [...tags];
}

function findPendingPartialForSymbol(summary = {}, symbol, side) {
  const list = side === 'sell' ? summary?.partial_sells : summary?.partial_buys;
  return (Array.isArray(list) ? list : []).find((order) => (
    String(order?.symbol || '').trim().toUpperCase() === String(symbol || '').trim().toUpperCase()
    && String(order?.side || '').toLowerCase() === String(side || '').toLowerCase()
  )) || null;
}

function resolvePositionStatus(livePosition = null, liveOpenOrders = [], partialFillSummary = null, candidate = null) {
  const qty = safeNumber(livePosition?.qty ?? livePosition?.quantity ?? livePosition?.net_quantity ?? candidate?.position_qty_available ?? 0, 0);
  if (!Number.isFinite(qty) || Math.abs(qty) <= 0) return 'flat';
  const tags = buildWatchPositionAwarenessTags({
    symbol: livePosition?.symbol || candidate?.symbol,
    livePosition,
    liveOpenOrders,
    partialFillSummary,
    candidate,
  });
  if (tags.includes('do_not_evict')) return 'do_not_evict';
  if (tags.includes('rotation_candidate')) return 'rotation_candidate';
  if (tags.includes('strong_runner')) return 'strong_runner';
  if (tags.includes('break_even_stale')) return 'break_even_stale';
  if (tags.includes('weak_flat')) return 'weak_flat';
  return 'positioned';
}

function buildLivePositionMap(livePositions = null) {
  const map = new Map();
  const positions = Array.isArray(livePositions?.positions) ? livePositions.positions : [];
  for (const position of positions) {
    const symbol = normalizeWatchSymbol(position?.symbol);
    if (!symbol || map.has(symbol)) continue;
    map.set(symbol, position);
  }
  return map;
}

function buildLiveOpenOrderMap(liveOpenOrders = null) {
  const map = new Map();
  const orders = Array.isArray(liveOpenOrders?.orders) ? liveOpenOrders.orders : [];
  for (const order of orders) {
    const symbol = normalizeWatchSymbol(order?.symbol);
    if (!symbol) continue;
    if (!map.has(symbol)) {
      map.set(symbol, []);
    }
    map.get(symbol).push(order);
  }
  return map;
}

function buildMemeWatchSymbols({ entries = [], approvedSet = new Set(), watchedSymbols = new Set(), currentDate = new Date(), hotHot = false, rotationState = null } = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const symbol = normalizeWatchSymbol(entry?.symbol);
      if (!symbol) return null;
      const marketDetails = entry?.marketConfirmationDetails || null;
      const currentPrice = safeNumber(marketDetails?.currentPrice ?? marketDetails?.current_price, null);
      const previousClose = safeNumber(marketDetails?.previousClose ?? marketDetails?.previous_close, null);
      const movePct = Number.isFinite(currentPrice) && Number.isFinite(previousClose) && previousClose > 0
        ? Number((((currentPrice - previousClose) / previousClose) * 100).toFixed(2))
        : null;
      const volume = safeNumber(marketDetails?.volume ?? null, null);
      const averageVolume = safeNumber(marketDetails?.averageVolume ?? marketDetails?.average_volume ?? null, null);
      const volumeMultiple = Number.isFinite(Number(entry?.volume_multiple))
        ? Number(entry.volume_multiple)
        : computeVolumeMultiple(volume, averageVolume);
      const spread = safeNumber(marketDetails?.spreadPct ?? marketDetails?.spread_pct, null);
      const tradableStatus = resolveTradableStatus(marketDetails);
      return {
        symbol,
        memeHeatScore: safeNumber(entry?.memeHeatScore, null),
        marketConfirmationScore: safeNumber(entry?.marketConfirmationScore, null),
        movePct,
        volumeMultiple,
        spread,
        tradableStatus,
        priorityOverrideEligible: Boolean(entry?.priorityOverrideEligible),
        priorityOverrideApplied: Boolean(entry?.priorityOverrideApplied),
        priorityOverrideBonus: safeNumber(entry?.priorityOverrideBonus, 0),
        priorityOverrideBlockReason: entry?.priorityOverrideBlockReason || (entry?.priorityOverrideEligible && !entry?.priorityOverrideApplied ? 'risk_gate_blocked' : null),
        rotationEligible: Boolean(rotationState?.candidate && rotationState.candidate === symbol && rotationState.rotationEligible),
        evictionCandidate: rotationState?.evictionCandidate || null,
        evictionReason: rotationState?.evictionReason || null,
        rotationBlockReason: rotationState?.blockReason || null,
        lastRotationDecision: rotationState?.lastDecision || null,
        lastRotationTime: rotationState?.lastDecisionAt || null,
        finalMemeScore: safeNumber(entry?.finalMemeScore, null),
        borderlineUpgrade: Boolean(entry?.borderlineUpgrade),
        crossSourceConfirmation: Boolean(entry?.crossSourceConfirmation),
        riskWarnings: normalizeReasonList(entry?.riskWarnings),
        reasonCodes: normalizeReasonList(entry?.reasonCodes),
        sourceConfirmations: entry?.sourceConfirmations || null,
        watchlistReason: entry?.watchlistReason || entry?.status || (hotHot ? 'hot_hot' : 'dynamic_watch'),
        rejectedBlockReason: entry?.rejectedBlockReason || (tradableStatus !== 'tradable' ? tradableStatus : null) || (normalizeReasonList(entry?.riskWarnings).length ? normalizeReasonList(entry?.riskWarnings).join(', ') : null),
        expiresAt: entry?.expiresAt || entry?.expires_at || null,
        lastDecision: entry?.lastDecision || entry?.status || (hotHot ? 'hot_hot' : 'dynamic_watch'),
        scannerWatched: watchedSymbols.has(symbol) || approvedSet.has(symbol),
        dynamicWatchlistMember: Boolean(entry?.dynamicWatchlistMember || watchedSymbols.has(symbol)),
        freshness: entry?.expired ? 'stale' : (entry?.status === 'hot_hot' ? 'fresh' : 'shadow'),
        sources: formatSourceContributors(entry?.sourceProfile || entry?.topSources || entry?.sources),
        sourceDetails: Array.isArray(entry?.sourceProfile?.sources) ? entry.sourceProfile.sources.slice() : [],
        phaseA: entry?.phaseA || null,
        phaseB: entry?.phaseB || null,
        socialConfirmation: entry?.socialConfirmation || null,
        marketConfirmation: entry?.marketConfirmation || null,
        riskConfirmation: entry?.riskConfirmation || null,
        mentions15m: safeNumber(entry?.mentions15m, null),
        mentions30m: safeNumber(entry?.mentions30m, null),
        mentions60m: safeNumber(entry?.mentions60m, null),
        uniqueUsers: safeNumber(entry?.uniqueUsers, null),
        marketConfirmationAvailable: Boolean(entry?.marketConfirmationAvailable),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aScore = Number(a.memeHeatScore || 0);
      const bScore = Number(b.memeHeatScore || 0);
      if (bScore !== aScore) return bScore - aScore;
      return String(a.symbol).localeCompare(String(b.symbol));
    });
}

function formatSourceContributors(value = null) {
  if (!value) return [];
  const sources = Array.isArray(value?.sources)
    ? value.sources
    : Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.values(value)
        : [];
  return sources.map((entry) => {
    if (!entry) return 'unknown';
    if (typeof entry === 'string') return entry;
    const tier = entry.tier ? ` (${entry.tier})` : '';
    const status = entry.status ? `:${String(entry.status).toUpperCase()}` : '';
    return `${formatDisplaySourceName(entry.source)}${tier}${status}`;
  });
}

function formatDisplaySourceName(value) {
  const source = String(value || 'unknown').trim();
  return source.startsWith('reddit:') ? source.slice(7) : source;
}

function summarizeMemeFeatureState(memeMonitorState = null) {
  const summary = memeMonitorState?.summary || {};
  const features = memeMonitorState?.features || {};
  return {
    source: summary.source || memeMonitorState?.source || 'env + runtime state',
    master_enabled: Boolean(summary.master_enabled),
    blocked_features: Array.isArray(summary.blocked_features) ? summary.blocked_features.slice() : [],
    dependency_chain: Array.isArray(summary.dependency_chain)
      ? summary.dependency_chain.map((item) => ({
        key: item.key,
        label: item.label,
        status: item.status,
        blocked_reason: item.blocked_reason || null,
      }))
      : [],
    features: Object.fromEntries(Object.entries(features).map(([key, value]) => [key, {
      key,
      label: value?.label || key,
      status: value?.status || 'off',
      effective: Boolean(value?.effective),
      configured: Boolean(value?.configured),
      runtime: Boolean(value?.runtime),
      blocked_reason: value?.blocked_reason || null,
    }])),
  };
}

function summarizeRegularWatchFeatureState(regularWatchState = null) {
  const summary = regularWatchState?.summary || {};
  const features = regularWatchState?.features || {};
  return {
    source: summary.source || regularWatchState?.source || 'env + runtime state',
    master_enabled: Boolean(summary.master_enabled),
    blocked_features: Array.isArray(summary.blocked_features) ? summary.blocked_features.slice() : [],
    dependency_chain: Array.isArray(summary.dependency_chain)
      ? summary.dependency_chain.map((item) => ({
        key: item.key,
        label: item.label,
        status: item.status,
        blocked_reason: item.blocked_reason || null,
      }))
      : [],
    features: Object.fromEntries(Object.entries(features).map(([key, value]) => [key, {
      key,
      label: value?.label || key,
      status: value?.status || 'off',
      effective: Boolean(value?.effective),
      configured: Boolean(value?.configured),
      runtime: Boolean(value?.runtime),
      blocked_reason: value?.blocked_reason || null,
      locked: Boolean(value?.locked),
    }])),
  };
}

function summarizeMemeActionsState(memeMonitorState = null) {
  const features = memeMonitorState?.features || {};
  const getStatus = (key) => features[key]?.status || 'off';
  return [
    ['Meme Monitor', getStatus('MEME_MONITOR_ENABLED')],
    ['Reddit Scanner', getStatus('MEME_REDDIT_SCANNER_ENABLED')],
    ['Hot List', getStatus('MEME_HOT_LIST_ENABLED')],
    ['Dynamic Watchlist', getStatus('MEME_DYNAMIC_WATCHLIST_ENABLED')],
    ['Priority Override', getStatus('MEME_PRIORITY_OVERRIDE_ENABLED')],
    ['Hot Slot Rotation', getStatus('MEME_HOT_SLOT_ROTATION_ENABLED')],
    ['Reddit API', getStatus('MEME_SOURCE_REDDIT_ENABLED')],
    ['Alpaca Market', getStatus('MEME_SOURCE_ALPACA_MARKET_ENABLED')],
    ['Alpaca Tradability', getStatus('MEME_SOURCE_ALPACA_ASSETS_ENABLED')],
    ['Nasdaq Halts', getStatus('MEME_SOURCE_NASDAQ_HALTS_ENABLED')],
    ['SEC EDGAR', getStatus('MEME_SOURCE_SEC_EDGAR_ENABLED')],
    ['Stocktwits', getStatus('MEME_SOURCE_STOCKTWITS_ENABLED')],
    ['Polygon', getStatus('MEME_SOURCE_POLYGON_ENABLED')],
    ['Alpha Vantage', getStatus('MEME_SOURCE_ALPHA_VANTAGE_ENABLED')],
  ];
}

function summarizeRegularWatchActionsState(regularWatchState = null) {
  const features = regularWatchState?.features || {};
  const getStatus = (key) => features[key]?.status || 'off';
  return [
    ['Regular Watch Intelligence', getStatus('REGULAR_WATCH_INTELLIGENCE_ENABLED')],
    ['Market Confirmation', getStatus('REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED')],
    ['Asset Validation', getStatus('REGULAR_WATCH_ASSET_VALIDATION_ENABLED')],
    ['Halt Check', getStatus('REGULAR_WATCH_HALT_CHECK_ENABLED')],
    ['SEC Risk Check', getStatus('REGULAR_WATCH_SEC_RISK_CHECK_ENABLED')],
    ['News/Catalyst Check', getStatus('REGULAR_WATCH_NEWS_CATALYST_ENABLED')],
    ['Priority Scoring', getStatus('REGULAR_WATCH_PRIORITY_SCORING_ENABLED')],
    ['Scanner Ranking', getStatus('REGULAR_WATCH_SCANNER_RANKING_ENABLED')],
    ['Position Awareness', getStatus('REGULAR_WATCH_POSITION_AWARENESS_ENABLED')],
  ];
}

function summarizeMemeRuntimeFeature({ feature = null, status = null, count = 0, active = false, label = '' } = {}) {
  const effective = Boolean(feature?.effective ?? active);
  const configured = Boolean(feature?.configured);
  const runtime = Boolean(feature?.runtime);
  const blockedReason = feature?.blocked_reason || null;
  const runtimeStatus = blockedReason
    ? 'blocked'
    : effective
      ? String(status?.status || status?.mode || 'active').toLowerCase()
      : (configured || runtime ? 'shadow' : 'off');
  return {
    label: label || feature?.label || 'Feature',
    configured,
    runtime,
    effective,
    status: runtimeStatus,
    blocked_reason: blockedReason,
    lastRunAt: status?.lastRunAt || status?.lastScoredAt || null,
    lastScoredAt: status?.lastScoredAt || status?.lastRunAt || null,
    lastError: status?.lastError || null,
    stale: Boolean(status?.stale),
    count: Number(count || 0),
  };
}

function normalizeWatchSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeReasonList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [String(value)].filter(Boolean);
}

function normalizeWatchReason(reason) {
  const value = String(reason || '').toUpperCase();
  if (!value) return 'stale';
  if (value.includes('EXCLUDED')) return 'excluded';
  if (value.includes('BLOCK')) return 'blocked';
  return 'blocked';
}

function computeVolumeMultiple(volume, averageVolume) {
  const vol = Number(volume);
  const avg = Number(averageVolume);
  if (!Number.isFinite(vol) || !Number.isFinite(avg) || avg <= 0) return null;
  return Number((vol / avg).toFixed(2));
}

function resolveTradableStatus(details = null) {
  if (!details) return 'unavailable';
  if (details.excluded) return 'excluded';
  if (details.halted) return 'halted';
  if (details.tradable === false) return 'blocked';
  if (details.tradable === true) return 'tradable';
  return 'unknown';
}

function approvedSymbolMatch(symbol, candidate) {
  if (!symbol || !candidate) return false;
  return normalizeWatchSymbol(candidate.symbol) === symbol;
}

function buildConfigDrift(activePolicySnapshot, runtimeEnv = {}) {
  const policy = activePolicySnapshot?.policy || {};
  const expected = {
    maxOpenPositions: safeNumber(runtimeEnv.MAX_OPEN_POSITIONS, null),
    buyNotionalTarget: safeNumber(runtimeEnv.BUY_NOTIONAL_TARGET, null),
    minBuyNotional: safeNumber(runtimeEnv.MIN_BUY_NOTIONAL, null),
    approvedSymbols: parseCsvForDrift(runtimeEnv.STOCK_SCANNER_SYMBOLS || APPROVED_LIVE_MARKET_SYMBOLS.join(',')),
    positionStopLossDollars: safeNumber(runtimeEnv.POSITION_STOP_LOSS_DOLLARS, null),
    positionStopLossNotionalPct: safeNumber(runtimeEnv.POSITION_STOP_LOSS_NOTIONAL_PCT, null),
    positionStopLossMaxDollars: safeNumber(runtimeEnv.POSITION_STOP_LOSS_MAX_DOLLARS, null),
    trailingProfitStartDollars: safeNumber(runtimeEnv.TRAILING_PROFIT_START_DOLLARS, null),
    trailingProfitGivebackDollars: safeNumber(runtimeEnv.TRAILING_PROFIT_GIVEBACK_DOLLARS, null),
    blockedBuyCalibrationBuckets: parseCsvForDrift(runtimeEnv.BLOCKED_BUY_CALIBRATION_BUCKETS),
    blockBuys: parseBoolForDrift(runtimeEnv.BLOCK_BUYS),
  };
  const comparisons = [
    ['maxOpenPositions', policy.maxOpenPositions, expected.maxOpenPositions],
    ['buyNotionalTarget', policy.buyNotionalTarget, expected.buyNotionalTarget],
    ['minBuyNotional', policy.minBuyNotional, expected.minBuyNotional],
    ['approvedSymbols', policy.approvedSymbols, expected.approvedSymbols],
    ['positionStopLossDollars', policy.positionStopLossDollars, expected.positionStopLossDollars],
    ['positionStopLossNotionalPct', policy.positionStopLossNotionalPct, expected.positionStopLossNotionalPct],
    ['positionStopLossMaxDollars', policy.positionStopLossMaxDollars, expected.positionStopLossMaxDollars],
    ['trailingProfitStartDollars', policy.trailingProfitStartDollars, expected.trailingProfitStartDollars],
    ['trailingProfitGivebackDollars', policy.trailingProfitGivebackDollars, expected.trailingProfitGivebackDollars],
    ['blockedBuyCalibrationBuckets', policy.blockedBuyCalibrationBuckets, expected.blockedBuyCalibrationBuckets],
    ['blockBuys', policy.blockBuys, expected.blockBuys],
  ];
  const items = comparisons
    .filter(([, active, expectedValue]) => expectedValue !== null && expectedValue !== undefined && !driftValuesEqual(active, expectedValue))
    .map(([field, active, expectedValue]) => ({
      field,
      active,
      expected: expectedValue,
      active_display: displayDriftValue(active),
      expected_display: displayDriftValue(expectedValue),
    }));
  return {
    has_drift: items.length > 0,
    source: activePolicySnapshot?.source || null,
    captured_at: activePolicySnapshot?.captured_at || null,
    expected,
    items,
  };
}

function buildExitManagementState({ scannerRuntime, control, livePositionSummary, runtimeEnv = {}, liveMarketRules = null }) {
  const scannerStatus = control?.scanner?.status || 'unknown';
  const scannerProfile = control?.scanner?.profile || control?.workflow?.desired_scanner_profile || null;
  const lastScanAt = scannerRuntime?.last_scan_time || null;
  const stale = !lastScanAt || isSnapshotStale(lastScanAt, 5);
  const positionsAvailable = Boolean(livePositionSummary?.available);
  const positions = Array.isArray(livePositionSummary?.positions) ? livePositionSummary.positions : [];
  const rules = liveMarketRules || resolveLiveMarketRules(runtimeEnv);
  const runtimeExitStates = Array.isArray(scannerRuntime?.position_exit_state) ? scannerRuntime.position_exit_state : [];
  const runtimeBySymbol = new Map(runtimeExitStates.map((item) => [String(item.symbol || '').toUpperCase(), item]));
  const reasons = [];
  if (scannerStatus !== 'running') reasons.push('SCANNER_NOT_RUNNING');
  if (stale) reasons.push('SCANNER_SCAN_STALE');
  if (!positionsAvailable) reasons.push('LIVE_POSITIONS_UNAVAILABLE');
  const managed = scannerStatus === 'running' && !stale && positionsAvailable;
  return {
    state: managed ? 'managed' : (scannerStatus === 'running' ? 'stale' : 'unmanaged'),
    managed,
    scanner_status: scannerStatus,
    scanner_profile: scannerProfile,
    last_scan_at: lastScanAt,
    reasons,
    rule: {
      stop_loss_dollars: rules.stop_loss_dollars,
      stop_loss_notional_pct: rules.stop_loss_notional_pct,
      stop_loss_max_dollars: rules.stop_loss_max_dollars,
      trailing_profit_start_dollars: rules.trailing_profit_start_dollars,
      trailing_profit_giveback_dollars: rules.trailing_profit_giveback_dollars,
      sell_profit_threshold_pct: rules.sell_profit_threshold_pct,
      sell_net_profit_floor_dollars: rules.sell_net_profit_floor_dollars,
    },
    positions: positions.map((position) => {
      const marketValue = safeNumber(position.market_value ?? position.marketValue, null);
      const unrealized = safeNumber(position.unrealized_pl ?? position.unrealizedPnl ?? position.unrealized_intraday_pl, null);
      const runtimeState = runtimeBySymbol.get(String(position.symbol || '').toUpperCase()) || {};
      const effectiveStopLoss = safeNumber(runtimeState.stop_loss_dollars, calculateEffectiveStopLossDollars({
        baseStopLossDollars: rules.stop_loss_dollars,
        stopLossNotionalPct: rules.stop_loss_notional_pct,
        stopLossMaxDollars: rules.stop_loss_max_dollars,
        positionMarketValue: marketValue,
      }));
      const distanceToStop = Number.isFinite(unrealized) ? unrealized + effectiveStopLoss : null;
      const trailingPeak = safeNumber(runtimeState.trailing_peak_unrealized_pl ?? scannerRuntime?.trailing_state?.positions?.[position.symbol]?.peak_unrealized_pl, null);
      const trailingActive = Boolean(runtimeState.trailing_active ?? (Number.isFinite(trailingPeak) && trailingPeak >= rules.trailing_profit_start_dollars));
      const trailingSellAt = trailingActive
        ? safeNumber(runtimeState.trailing_sell_if_unrealized_pl_at_or_below, Number.isFinite(trailingPeak) ? trailingPeak - rules.trailing_profit_giveback_dollars : null)
        : null;
      return {
        symbol: position.symbol || null,
        market_value: marketValue,
        quantity: safeNumber(position.net_quantity ?? position.qty ?? null, null),
        avg_entry_price: safeNumber(position.avg_entry_price, null),
        current_price: safeNumber(position.current_price, null),
        unrealized_pl: unrealized,
        stop_loss_dollars: effectiveStopLoss,
        effective_stop_loss_dollars: effectiveStopLoss,
        base_stop_loss_dollars: rules.stop_loss_dollars,
        stop_loss_notional_pct: rules.stop_loss_notional_pct,
        stop_loss_max_dollars: rules.stop_loss_max_dollars,
        distance_to_stop_dollars: Number.isFinite(distanceToStop) ? Number(distanceToStop.toFixed(4)) : null,
        trailing_active: trailingActive,
        trailing_peak_unrealized_pl: Number.isFinite(trailingPeak) ? trailingPeak : null,
        trailing_sell_if_unrealized_pl_at_or_below: Number.isFinite(trailingSellAt) ? trailingSellAt : null,
        eligible_for_exit: Boolean(runtimeState.exit_reason),
        reason: Number.isFinite(unrealized)
          ? (runtimeState.exit_reason || (unrealized <= -effectiveStopLoss ? 'STOP_LOSS_READY' : trailingActive ? 'TRAILING_ACTIVE' : 'HOLD'))
          : 'UNREALIZED_PL_UNAVAILABLE',
      };
    }),
  };
}

function driftValuesEqual(active, expected) {
  if (Array.isArray(expected) || Array.isArray(active)) {
    const activeList = Array.isArray(active) ? active.map(String).filter(Boolean).sort() : parseCsvForDrift(active).sort();
    const expectedList = Array.isArray(expected) ? expected.map(String).filter(Boolean).sort() : parseCsvForDrift(expected).sort();
    return JSON.stringify(activeList) === JSON.stringify(expectedList);
  }
  if (typeof expected === 'boolean' || typeof active === 'boolean') {
    return Boolean(active) === Boolean(expected);
  }
  const activeNumber = Number(active);
  const expectedNumber = Number(expected);
  if (Number.isFinite(activeNumber) && Number.isFinite(expectedNumber)) {
    return Math.abs(activeNumber - expectedNumber) < 1e-9;
  }
  return String(active ?? '') === String(expected ?? '');
}

function parseCsvForDrift(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseBoolForDrift(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
  return null;
}

function displayDriftValue(value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : '(empty)';
  if (value === undefined || value === null || value === '') return '(empty)';
  return String(value);
}

function unwrapReport(payload) {
  if (!payload) return null;
  if (payload.date || payload.signal_count !== undefined || payload.paper_pnl !== undefined) {
    return payload;
  }
  if (payload.report) return payload.report;
  if (payload.payload) return unwrapReport(payload.payload);
  return payload;
}

function unwrapStatus(payload) {
  if (!payload) return null;
  if (payload.status || payload.mode || payload.uptime_minutes !== undefined) return payload;
  if (payload.payload) return unwrapStatus(payload.payload);
  return payload;
}

function unwrapPolicySnapshot(payload) {
  if (!payload) return null;
  if (payload.policy) return payload;
  if (payload.policy_snapshot) return payload.policy_snapshot;
  if (payload.payload) return unwrapPolicySnapshot(payload.payload);
  return payload;
}

function unwrapTuningSummary(payload) {
  if (!payload) return null;
  if (payload.tuning) return payload.tuning;
  return payload;
}

function unwrapPolicyEffectiveness(payload) {
  if (!payload) return null;
  if (payload.policy_effectiveness) return payload.policy_effectiveness;
  return payload;
}

function resolveLiveMarketRules(env = {}, policySnapshot = null) {
  const policy = policySnapshot?.policy || {};
  return {
    workflow: 'Live Market',
    approved_symbols: Array.isArray(policy.approvedSymbols) && policy.approvedSymbols.length
      ? policy.approvedSymbols
      : APPROVED_LIVE_MARKET_SYMBOLS.slice(),
    excluded_buy_symbols: parseCsvForDrift(env.STOCK_SCANNER_EXCLUDED_BUY_SYMBOLS || ''),
    max_open_positions: safeNumber(policy.maxOpenPositions, safeNumber(env.MAX_OPEN_POSITIONS, 2)),
    buy_notional_target: safeNumber(policy.buyNotionalTarget, safeNumber(env.BUY_NOTIONAL_TARGET, 150)),
    min_buy_notional: safeNumber(policy.minBuyNotional, safeNumber(env.MIN_BUY_NOTIONAL, 25)),
    stop_loss_dollars: safeNumber(policy.positionStopLossDollars, safeNumber(env.POSITION_STOP_LOSS_DOLLARS, 1)),
    stop_loss_notional_pct: safeNumber(policy.positionStopLossNotionalPct, safeNumber(env.POSITION_STOP_LOSS_NOTIONAL_PCT, 0.75)),
    stop_loss_max_dollars: safeNumber(policy.positionStopLossMaxDollars, safeNumber(env.POSITION_STOP_LOSS_MAX_DOLLARS, 2.5)),
    trailing_profit_start_dollars: safeNumber(policy.trailingProfitStartDollars, safeNumber(env.TRAILING_PROFIT_START_DOLLARS, 0.5)),
    trailing_profit_giveback_dollars: safeNumber(policy.trailingProfitGivebackDollars, safeNumber(env.TRAILING_PROFIT_GIVEBACK_DOLLARS, 0.3)),
    sell_profit_threshold_pct: safeNumber(policy.sellProfitThresholdPct, resolveProfitExitThresholdPct(env, 'stocks')),
    sell_net_profit_floor_dollars: resolveProfitExitFloorDollars(policySnapshot, env),
    risk_budget_sizing: {
      enabled: parseBoolForDrift(env.RISK_BUDGET_SIZING_ENABLED),
      max_risk_per_trade_dollars: safeNumber(env.MAX_RISK_PER_TRADE_DOLLARS, 0),
      max_risk_per_trade_pct_equity: safeNumber(env.MAX_RISK_PER_TRADE_PCT_EQUITY, 0),
      max_trade_notional: safeNumber(env.MAX_TRADE_NOTIONAL, 0),
      min_stop_distance_dollars: safeNumber(env.MIN_STOP_DISTANCE_DOLLARS, 0.01),
      max_stop_distance_dollars: safeNumber(env.MAX_STOP_DISTANCE_DOLLARS, 0),
      allow_fractional_shares: parseBoolForDrift(env.ALLOW_RISK_BUDGET_FRACTIONAL_SHARES),
      require_broker_equity: env.RISK_BUDGET_REQUIRE_BROKER_EQUITY === undefined ? true : parseBoolForDrift(env.RISK_BUDGET_REQUIRE_BROKER_EQUITY),
    },
  };
}

function resolveProfitExitThresholdPct(env, regime) {
  const policyValue = safeNumber(env?.ACTIVE_POLICY_SELL_PROFIT_THRESHOLD_PCT, NaN);
  if (Number.isFinite(policyValue)) return policyValue;
  const stockValue = safeNumber(env.STOCK_SCANNER_SELL_PROFIT_THRESHOLD_PCT, NaN);
  const overnightValue = safeNumber(env.OVERNIGHT_SCANNER_SELL_PROFIT_THRESHOLD_PCT, NaN);
  const current = regime === 'stocks' ? stockValue : overnightValue;
  if (Number.isFinite(current)) return current;
  return 5.0;
}

function resolveLossExitThresholdPct(env, regime) {
  const raw = safeNumber(env.OVERNIGHT_SCANNER_SELL_LOSS_EXIT_THRESHOLD_PCT, NaN);
  if (Number.isFinite(raw)) return raw;
  return regime === 'stocks' ? 0.75 : 0.75;
}

function resolveProfitExitFloorDollars(policySnapshot, env) {
  const policyFloor = safeNumber(policySnapshot?.policy?.sellNetProfitFloorDollars, NaN);
  if (Number.isFinite(policyFloor)) return policyFloor;
  const overnightFloor = safeNumber(env.SELL_NET_PROFIT_FLOOR_DOLLARS ?? env.OVERNIGHT_SCANNER_SELL_NET_PROFIT_FLOOR_DOLLARS, NaN);
  if (Number.isFinite(overnightFloor)) return overnightFloor;
  return 1.0;
}

function isSnapshotStale(timestamp, maxAgeMinutes = 20) {
  if (!timestamp) return true;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return true;
  return (Date.now() - parsed.getTime()) > maxAgeMinutes * 60_000;
}

function fileMeta(filePath, payload = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        path: filePath,
        exists: false,
        size: 0,
        modified_at: null,
        age_minutes: null,
      };
    }
    const stats = fs.statSync(filePath);
    const modifiedAt = stats.mtime.toISOString();
    return {
      path: filePath,
      exists: true,
      size: stats.size,
      modified_at: modifiedAt,
      age_minutes: Math.max(0, (Date.now() - stats.mtimeMs) / 60000),
      payload_type: payload ? typeof payload : null,
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      size: 0,
      modified_at: null,
      age_minutes: null,
    };
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendFile(res, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    res.statusCode = 200;
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  } catch {
    sendJson(res, 404, { status: 'error', error: 'asset_not_found', filePath });
  }
}

function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatSignedNumber(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return '—';
  const formatted = formatNumber(Math.abs(Number(value)), decimals);
  return Number(value) >= 0 ? `+${formatted}` : `-${formatted}`;
}

function resolveTraderBaseUrlFromEnv(env = process.env) {
  return String(env.DASHBOARD_TRADER_BASE_URL || env.TRADER_BASE_URL || '').trim() || null;
}

function resolvePreferredDashboardPort(env = process.env) {
  const raw = Number(env.TRADER_DASHBOARD_PORT || env.DASHBOARD_PORT || DEFAULT_DASHBOARD_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DASHBOARD_PORT;
}

function resolveDashboardSnapshotPath() {
  return path.resolve(resolveRepoRoot(), 'data', 'logs', 'overnight-status.json');
}

function summarizeBrokerLocalReconciliation(reconciliation = null) {
  if (!reconciliation) return null;
  return {
    status: reconciliation.status || null,
    checked_at: reconciliation.checked_at || null,
    mismatch_count: Array.isArray(reconciliation.mismatches) ? reconciliation.mismatches.length : 0,
    critical_mismatch_count: Array.isArray(reconciliation.critical_failures) ? reconciliation.critical_failures.length : 0,
    local_phantom_positions: reconciliation.local_phantom_positions || [],
    broker_positions_missing_locally: reconciliation.broker_positions_missing_locally || [],
    quantity_mismatches: reconciliation.quantity_mismatches || [],
    open_order_mismatches: reconciliation.open_order_mismatches || [],
    stale_trailing_state: (reconciliation.trailing_state_mismatches || []).filter((item) => item.type === 'STALE_TRAILING_STATE'),
    pnl_mismatches: reconciliation.pnl_mismatches || [],
    recommended_actions: reconciliation.recommended_actions || [],
  };
}

function getFileStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      mtime: stat.mtime.toISOString(),
      mtime_ms: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      mtime: null,
      mtime_ms: null,
      size: 0,
    };
  }
}

function getMemeMonitorRuntimeSnapshot({ dataDir, memeMonitor, env = process.env, repoRoot = resolveRepoRoot() } = {}) {
  const status = memeMonitor?.getStatus?.() || loadMemeMonitorStatus({ dataDir, filePath: resolveMemeMonitorStatusPath({ dataDir }) });
  const hotList = loadDynamicHotList({ dataDir, filePath: resolveDynamicHotListPath({ dataDir }) });
  const memeState = loadMemeMonitorState({ env, repoRoot, filePath: resolveMemeMonitorStatePath({ dataDir }) });
  const scannerRuntime = readJsonFileIfPresent(path.join(dataDir, 'state', 'scanner-runtime.json'));
  const hotSlotRotation = summarizeHotSlotRotationRuntime(scannerRuntime?.hot_slot_rotation || null, memeState?.features?.MEME_HOT_SLOT_ROTATION_ENABLED);
  return {
    ok: true,
    status: 'ok',
    timestamp: nowIso(),
    memeMonitor: {
      enabled: Boolean(memeState?.summary?.master_enabled),
      source: memeState?.summary?.source || memeState?.source || 'env + runtime state',
      redditScanner: {
        enabled: Boolean(status?.enabled),
        status: status?.redditScanner?.status || 'off',
        lastRunAt: status?.redditScanner?.lastRunAt || null,
        lastError: status?.redditScanner?.lastError || null,
        sources: status?.redditScanner?.sources || [],
        symbolsDetected: Number(status?.redditScanner?.symbolsDetected || 0),
        rejectedTokens: Number(status?.redditScanner?.rejectedTokens || 0),
        mode: status?.redditScanner?.mode || 'shadow',
      },
      hotList: status?.hotList || hotList?.summary || {
        enabled: false,
        status: 'off',
        dynamicCount: 0,
        hotHotCount: 0,
        lastScoredAt: null,
        stale: true,
        lastError: null,
      },
      hotHotScoring: status?.hotHotScoring || {
        enabled: false,
        status: 'off',
        lastScoredAt: null,
        lastError: null,
        stale: true,
      },
      dynamicWatchlist: summarizeMemeRuntimeFeature({
        feature: memeState?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED,
        status: status?.hotList,
        count: hotList?.summary?.dynamicCount || hotList?.dynamicHotList?.length || 0,
        active: Boolean(memeState?.features?.MEME_DYNAMIC_WATCHLIST_ENABLED?.effective),
        label: 'Dynamic Watchlist',
      }),
      priorityOverride: summarizeMemeRuntimeFeature({
        feature: memeState?.features?.MEME_PRIORITY_OVERRIDE_ENABLED,
        status: status?.hotHotScoring,
        count: hotList?.summary?.hotHotCount || hotList?.hotHotList?.length || 0,
        active: Boolean(memeState?.features?.MEME_PRIORITY_OVERRIDE_ENABLED?.effective),
        label: 'Priority Override',
      }),
      hotSlotRotation,
      phaseA: status?.phaseA || {
        enabled: false,
        status: 'off',
        lastRunAt: null,
        lastError: null,
        sources: {},
        symbols: [],
      },
      phaseB: status?.phaseB || {
        enabled: false,
        status: 'off',
        lastRunAt: null,
        lastError: null,
        sources: {},
        symbols: [],
      },
      hotListPayload: hotList,
    },
  };
}

async function handleMemeAction(memeMonitor, body = {}, context = {}) {
  const action = String(body.action || body.type || '').trim().toLowerCase();
  if (!action) {
    return { ok: false, status: 'error', error: 'missing_action', message: 'Missing meme action' };
  }

  if (action === 'start-shadow-scan' || action === 'start' || action === 'shadow-start') {
    const result = await memeMonitor.start();
    const started = result?.redditScanner?.status === 'shadow';
    return {
      ok: started,
      status: started ? 'ok' : 'blocked',
      action: 'start-shadow-scan',
      message: started ? 'Meme Monitor shadow scan started' : 'Meme Monitor could not start shadow scan',
      result,
    };
  }

  if (action === 'stop-meme-monitor' || action === 'stop') {
    const result = await memeMonitor.stop();
    return {
      ok: true,
      status: 'ok',
      action: 'stop-meme-monitor',
      message: 'Meme Monitor stopped',
      result,
    };
  }

  if (action === 'refresh-hot-scores-now' || action === 'refresh-hot-list-now' || action === 'refresh-hot-list' || action === 'refresh') {
    const result = await memeMonitor.refresh({ forceWrite: true });
    const refreshed = result?.redditScanner?.status === 'shadow';
    return {
      ok: refreshed,
      status: refreshed ? 'ok' : 'blocked',
      action: 'refresh-hot-scores-now',
      message: refreshed ? 'Hot list refreshed' : 'Hot list refresh skipped',
      result,
    };
  }

  if (action === 'clear-expired-hot-symbols' || action === 'clear-meme-monitor-error' || action === 'clear-error') {
    if (action === 'clear-expired-hot-symbols' && typeof memeMonitor.clearExpiredHotSymbols === 'function') {
      const result = await memeMonitor.clearExpiredHotSymbols();
      return {
        ok: true,
        status: 'ok',
        action: 'clear-expired-hot-symbols',
        message: 'Expired hot symbols cleared',
        result,
      };
    }
    const result = await memeMonitor.clearError();
    return {
      ok: true,
      status: 'ok',
      action: 'clear-meme-monitor-error',
      message: 'Meme Monitor error cleared',
      result,
    };
  }

  if (action === 'reset-meme-scores' || action === 'reset-scores') {
    const result = typeof memeMonitor.resetScores === 'function'
      ? await memeMonitor.resetScores()
      : await memeMonitor.clearError();
    return {
      ok: true,
      status: 'ok',
      action: 'reset-meme-scores',
      message: 'Meme scores reset',
      result,
    };
  }

  if (action === 'refresh-all-phase-b-sources-now' || action === 'refresh-phase-b-sources-now') {
    const result = typeof memeMonitor.refreshPhaseB === 'function'
      ? await memeMonitor.refreshPhaseB({ candidateSymbols: [] })
      : await memeMonitor.refresh({ forceWrite: true });
    return {
      ok: true,
      status: 'ok',
      action: 'refresh-all-phase-b-sources-now',
      message: 'Phase B sources refreshed',
      result,
    };
  }

  if (action === 'refresh-stocktwits-source-now' || action === 'refresh-polygon-source-now' || action === 'refresh-alpha-vantage-source-now') {
    const result = typeof memeMonitor.refreshPhaseB === 'function'
      ? await memeMonitor.refreshPhaseB({ candidateSymbols: [] })
      : await memeMonitor.refresh({ forceWrite: true });
    return {
      ok: true,
      status: 'ok',
      action,
      message: `${action.replace(/-/g, ' ')} completed`,
      result,
    };
  }

  return {
    ok: false,
    status: 'error',
    error: 'unknown_action',
    message: `Unknown meme action: ${action}`,
  };
}

async function handleRegularWatchAction(body = {}, context = {}) {
  const action = String(body.action || body.type || '').trim().toLowerCase();
  if (!action) {
    return { ok: false, status: 'error', error: 'missing_action', message: 'Missing regular watch action' };
  }

  const featureState = loadRegularWatchState({
    env: context.env || process.env,
    repoRoot: context.repoRoot || path.resolve(__dirname, '..'),
    filePath: resolveRegularWatchStatePath({ dataDir: context.dataDir }),
  });
  const currentStatus = loadRegularWatchStatus({
    dataDir: context.dataDir,
    filePath: resolveRegularWatchStatusPath({ dataDir: context.dataDir }),
  });

  if (action === 'refresh-regular-watch-status' || action === 'refresh-regular-watch-status-now' || action === 'refresh') {
    const refreshed = await runRegularWatchSources({
      env: context.env || process.env,
      repoRoot: context.repoRoot || path.resolve(__dirname, '..'),
      dataDir: context.dataDir,
      runtimeState: featureState,
      status: currentStatus,
    });
    return {
      ok: true,
      status: 'ok',
      action: 'refresh-regular-watch-status',
      message: 'Regular Watch status refreshed',
      result: refreshed,
    };
  }

  if (action === 'clear-regular-watch-errors' || action === 'clear-errors' || action === 'clear-error') {
    const cleared = clearRegularWatchErrors(currentStatus);
    saveRegularWatchStatus(cleared, { dataDir: context.dataDir });
    return {
      ok: true,
      status: 'ok',
      action: 'clear-regular-watch-errors',
      message: 'Regular Watch errors cleared',
      result: cleared,
    };
  }

  if (action === 'reset-regular-watch-runtime-state' || action === 'reset-runtime-state' || action === 'reset') {
    const reset = resetRegularWatchRuntimeState();
    saveRegularWatchStatus(reset, { dataDir: context.dataDir });
    return {
      ok: true,
      status: 'ok',
      action: 'reset-regular-watch-runtime-state',
      message: 'Regular Watch runtime state reset',
      result: reset,
    };
  }

  return {
    ok: false,
    status: 'error',
    error: 'unknown_action',
    message: `Unknown regular watch action: ${action}`,
  };
}

module.exports = {
  DEFAULT_DASHBOARD_PORT,
  buildDashboardSnapshot,
  createDashboardServer,
  fetchEndpointJson,
  fetchWithTimeout,
  fileMeta,
  formatNumber,
  formatSignedNumber,
  getCachedSnapshot,
  getContentType,
  isSnapshotStale,
  parsePortList,
  readJsonFileIfPresent,
  readJsonlTail,
  readRelevantLogLines,
  readTailText,
  resolveDashboardDir,
  resolveDashboardSnapshotPath,
  resolveDashboardPort: resolvePreferredDashboardPort,
  resolveLossExitThresholdPct,
  resolveProfitExitThresholdPct,
  resolveTraderBaseUrl,
  resolveTraderBaseUrlFromEnv,
};
