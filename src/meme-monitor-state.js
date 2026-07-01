const path = require('path');
const { JsonFileStore } = require('./storage');
const { nowIso, resolveRepoRoot } = require('./util');

const MEME_FEATURE_STATE_VERSION = '2026-06-30.meme-monitor-state.1';
const FEATURE_KEYS = [
  'MEME_MONITOR_ENABLED',
  'MEME_REDDIT_SCANNER_ENABLED',
  'MEME_HOT_LIST_ENABLED',
  'MEME_DYNAMIC_WATCHLIST_ENABLED',
  'MEME_PRIORITY_OVERRIDE_ENABLED',
  'MEME_HOT_SLOT_ROTATION_ENABLED',
  'MEME_AUTO_ACTION_ENABLED',
  'MEME_SOURCE_REDDIT_ENABLED',
  'MEME_SOURCE_ALPACA_MARKET_ENABLED',
  'MEME_SOURCE_ALPACA_ASSETS_ENABLED',
  'MEME_SOURCE_NASDAQ_HALTS_ENABLED',
  'MEME_SOURCE_SEC_EDGAR_ENABLED',
  'MEME_SOURCE_STOCKTWITS_ENABLED',
  'MEME_SOURCE_POLYGON_ENABLED',
  'MEME_SOURCE_ALPHA_VANTAGE_ENABLED',
];

const FEATURE_META = {
  MEME_MONITOR_ENABLED: { label: 'Meme Monitor', parent: null, category: 'display_runtime_toggle' },
  MEME_REDDIT_SCANNER_ENABLED: { label: 'Reddit Scanner', parent: 'MEME_MONITOR_ENABLED', category: 'display_runtime_toggle' },
  MEME_HOT_LIST_ENABLED: { label: 'Hot List', parent: 'MEME_REDDIT_SCANNER_ENABLED', category: 'display_runtime_toggle' },
  MEME_DYNAMIC_WATCHLIST_ENABLED: { label: 'Dynamic Watchlist', parent: 'MEME_HOT_LIST_ENABLED', category: 'two_key_runtime_toggle' },
  MEME_PRIORITY_OVERRIDE_ENABLED: { label: 'Priority Override', parent: 'MEME_DYNAMIC_WATCHLIST_ENABLED', category: 'two_key_runtime_toggle' },
  MEME_HOT_SLOT_ROTATION_ENABLED: { label: 'Hot Slot Rotation', parent: 'MEME_PRIORITY_OVERRIDE_ENABLED', category: 'two_key_runtime_toggle' },
  MEME_AUTO_ACTION_ENABLED: { label: 'Auto Action', parent: 'MEME_HOT_SLOT_ROTATION_ENABLED', category: 'locked' },
  MEME_SOURCE_REDDIT_ENABLED: { label: 'Reddit Source', parent: null, category: 'source_runtime_toggle' },
  MEME_SOURCE_ALPACA_MARKET_ENABLED: { label: 'Alpaca Market Source', parent: null, category: 'source_runtime_toggle' },
  MEME_SOURCE_ALPACA_ASSETS_ENABLED: { label: 'Alpaca Asset Source', parent: null, category: 'source_runtime_toggle' },
  MEME_SOURCE_NASDAQ_HALTS_ENABLED: { label: 'Nasdaq Halt Source', parent: null, category: 'source_runtime_toggle' },
  MEME_SOURCE_SEC_EDGAR_ENABLED: { label: 'SEC EDGAR Source', parent: null, category: 'source_runtime_toggle' },
  MEME_SOURCE_STOCKTWITS_ENABLED: { label: 'Stocktwits Source', parent: null, category: 'source_runtime_toggle' },
  MEME_SOURCE_POLYGON_ENABLED: { label: 'Polygon Source', parent: null, category: 'source_runtime_toggle' },
  MEME_SOURCE_ALPHA_VANTAGE_ENABLED: { label: 'Alpha Vantage Source', parent: null, category: 'source_runtime_toggle' },
};

const SOURCE_CREDENTIALS = {
  MEME_SOURCE_REDDIT_ENABLED: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  MEME_SOURCE_ALPACA_MARKET_ENABLED: ['ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY'],
  MEME_SOURCE_ALPACA_ASSETS_ENABLED: ['ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY'],
  MEME_SOURCE_STOCKTWITS_ENABLED: ['STOCKTWITS_API_KEY'],
  MEME_SOURCE_POLYGON_ENABLED: ['POLYGON_API_KEY'],
  MEME_SOURCE_ALPHA_VANTAGE_ENABLED: ['ALPHA_VANTAGE_API_KEY'],
};

const SOURCE_STATUS_PRIORITY = new Set([
  'missing_credentials',
  'blocked',
  'error',
  'rate_limited',
  'private',
  'banned',
  'quarantined',
  'inaccessible',
  'source_not_found_or_inaccessible',
  'source_private_or_banned',
]);

function resolveMemeMonitorStatePath(input = {}) {
  if (typeof input === 'string') return path.resolve(input);
  if (input?.filePath) return path.resolve(input.filePath);
  if (input?.path) return path.resolve(input.path);
  if (input?.memeMonitorStatePath) return path.resolve(input.memeMonitorStatePath);
  if (input?.dataDir) return path.resolve(input.dataDir, 'state', 'meme-monitor-state.json');
  if (input?.repoRoot) return path.resolve(input.repoRoot, 'data', 'state', 'meme-monitor-state.json');
  return path.resolve(resolveRepoRoot(), 'data', 'state', 'meme-monitor-state.json');
}

function defaultMemeMonitorState() {
  const features = {};
  for (const key of FEATURE_KEYS) {
    features[key] = {
      key,
      runtime: false,
      changed_at: null,
      changed_by: null,
      source: null,
      reason: null,
    };
  }
  return {
    version: MEME_FEATURE_STATE_VERSION,
    updated_at: null,
    source: 'env + runtime state',
    features,
  };
}

function resolveSourceFeatureStatus(key, { configured = false, runtime = false, env = process.env, parentEffective = true, current = {} } = {}) {
  if (!parentEffective) {
    return {
      status: configured || runtime ? 'blocked' : 'off',
      effective: false,
      blockedReason: `${FEATURE_META[key]?.parent || 'parent'} is off`,
    };
  }

  if (!runtime) {
    return {
      status: configured ? 'shadow' : 'off',
      effective: false,
      blockedReason: null,
    };
  }

  const credentialNames = SOURCE_CREDENTIALS[key] || [];
  const missingCredentials = credentialNames.length
    && credentialNames.some((name) => !String(env?.[name] || '').trim());
  if (missingCredentials) {
    return {
      status: 'missing_credentials',
      effective: false,
      blockedReason: 'missing_credentials',
    };
  }

  const persistedStatus = normalizeSourceStatusValue(current.status || current.reason || current.blocked_reason || null);
  if (SOURCE_STATUS_PRIORITY.has(persistedStatus) && persistedStatus !== 'missing_credentials') {
    return {
      status: persistedStatus,
      effective: false,
      blockedReason: current.blocked_reason || current.reason || persistedStatus,
    };
  }

  return {
    status: 'active',
    effective: true,
    blockedReason: null,
  };
}

function resolveSourceStatusValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'inactive') return 'blocked';
  if (normalized === 'enabled') return 'active';
  return normalized;
}

function normalizeSourceStatusValue(value) {
  return resolveSourceStatusValue(value);
}

function resolveFeatureStatus(meta, { configured = false, runtime = false, env = process.env, parentEffective = true, current = {} } = {}) {
  if (!parentEffective) {
    return {
      status: configured || runtime ? 'blocked' : 'off',
      effective: false,
      blockedReason: `${meta.parent || 'parent'} is off`,
    };
  }

  if (meta.category === 'locked') {
    return {
      status: 'locked',
      effective: false,
      blockedReason: 'locked',
    };
  }

  if (meta.category === 'display_runtime_toggle') {
    if (runtime) {
      return { status: 'active', effective: true, blockedReason: null };
    }
    if (configured) {
      return { status: 'shadow', effective: false, blockedReason: null };
    }
    return { status: 'off', effective: false, blockedReason: null };
  }

  if (meta.category === 'two_key_runtime_toggle') {
    if (configured && runtime) {
      return { status: 'active', effective: true, blockedReason: null };
    }
    if (runtime && !configured) {
      return {
        status: 'blocked',
        effective: false,
        blockedReason: `${meta.label} requires config allowment`,
      };
    }
    if (configured) {
      return { status: 'shadow', effective: false, blockedReason: null };
    }
    return { status: 'off', effective: false, blockedReason: null };
  }

  if (meta.category === 'source_runtime_toggle') {
    return resolveSourceFeatureStatus(current.key || '', {
      configured,
      runtime,
      env,
      parentEffective,
      current,
    });
  }

  if (runtime) {
    return { status: 'active', effective: true, blockedReason: null };
  }
  if (configured) {
    return { status: 'shadow', effective: false, blockedReason: null };
  }
  return { status: 'off', effective: false, blockedReason: null };
}

function loadMemeMonitorState(input = {}) {
  const filePath = resolveMemeMonitorStatePath(input);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  let state = defaultMemeMonitorState();
  try {
    if (store.exists(name)) {
      const raw = store.read(name);
      if (raw) {
        state = normalizeMemeMonitorState(raw);
      }
    }
  } catch {
    state = defaultMemeMonitorState();
  }
  return evaluateMemeMonitorState(state, { env: input.env || process.env, filePath });
}

function saveMemeMonitorState(state, input = {}) {
  const filePath = resolveMemeMonitorStatePath(input);
  const store = new JsonFileStore(path.dirname(filePath));
  const normalized = normalizeMemeMonitorState(state);
  store.write(path.basename(filePath), normalized);
  return evaluateMemeMonitorState(normalized, { env: input.env || process.env, filePath });
}

function normalizeMemeMonitorState(state = {}) {
  const normalized = defaultMemeMonitorState();
  normalized.version = state.version || MEME_FEATURE_STATE_VERSION;
  normalized.updated_at = state.updated_at || null;
  normalized.source = state.source || 'env + runtime state';
  const sourceFeatures = state.features && typeof state.features === 'object'
    ? state.features
    : {};
  for (const key of FEATURE_KEYS) {
    const entry = sourceFeatures[key] || sourceFeatures[key.toLowerCase()] || {};
    normalized.features[key] = {
      key,
      runtime: parseBoolish(entry.runtime ?? entry.enabled ?? false, false),
      changed_at: entry.changed_at || entry.changedAt || null,
      changed_by: entry.changed_by || entry.changedBy || null,
      source: entry.source || null,
      reason: entry.reason || null,
    };
  }
  return normalized;
}

function evaluateMemeMonitorState(state = {}, options = {}) {
  const normalized = normalizeMemeMonitorState(state);
  const env = options.env || process.env;
  const evaluated = defaultMemeMonitorState();
  evaluated.version = normalized.version;
  evaluated.updated_at = normalized.updated_at || null;
  evaluated.source = normalized.source || 'env + runtime state';

  const warnings = [];
  const blockedFeatures = [];
  const featureEntries = {};

  for (const key of FEATURE_KEYS) {
    const meta = FEATURE_META[key];
    const configured = parseBoolish(env?.[key], false);
    const runtime = Boolean(normalized.features[key]?.runtime);
    const parentKey = meta.parent;
    const parent = parentKey ? featureEntries[parentKey] : null;
    const parentEffective = parent ? parent.effective : true;
    const dependencyBlocked = Boolean(parentKey && !parentEffective);
    const resolved = resolveFeatureStatus(meta, {
      configured,
      runtime,
      env,
      parentEffective,
      current: { ...normalized.features[key], key },
    });
    const blockedReason = dependencyBlocked
      ? (parent?.blocked_reason || `${parentKey} is off`)
      : resolved.blockedReason || null;
    const effective = dependencyBlocked ? false : Boolean(resolved.effective);
    const status = dependencyBlocked
      ? (configured || runtime ? 'blocked' : 'off')
      : resolved.status;

    if (runtime && !configured && meta.category === 'two_key_runtime_toggle') {
      warnings.push(`${key} runtime toggle is on but config is off`);
    }
    if (meta.category === 'source_runtime_toggle') {
      const issueStatus = resolveSourceStatusValue(status);
      if (issueStatus && issueStatus !== 'active' && issueStatus !== 'shadow' && issueStatus !== 'off') {
        warnings.push(`${key} source is ${issueStatus}`);
      }
    }

    const computed = {
      key,
      label: meta.label,
      parent: parentKey,
      configured,
      runtime,
      effective,
      status,
      blocked_reason: blockedReason,
      changed_at: normalized.features[key]?.changed_at || null,
      changed_by: normalized.features[key]?.changed_by || null,
      source: normalized.features[key]?.source || null,
      reason: normalized.features[key]?.reason || null,
      category: meta.category,
    };

    if (status === 'blocked' || status === 'missing_credentials' || status === 'error') {
      blockedFeatures.push(meta.label);
    }

    featureEntries[key] = computed;
  }

  const counts = {
    off: 0,
    shadow: 0,
    active: 0,
    blocked: 0,
    locked: 0,
    missing_credentials: 0,
    error: 0,
  };
  for (const feature of Object.values(featureEntries)) {
    counts[feature.status] = (counts[feature.status] || 0) + 1;
  }

  evaluated.features = featureEntries;
  evaluated.summary = {
    source: evaluated.source,
    updated_at: evaluated.updated_at,
    counts,
    blocked_features: blockedFeatures,
    warnings: [...new Set(warnings)],
    master_enabled: Boolean(featureEntries.MEME_MONITOR_ENABLED?.effective),
    feature_categories: {
      display_runtime_toggle: FEATURE_KEYS.filter((key) => FEATURE_META[key].category === 'display_runtime_toggle'),
      two_key_runtime_toggle: FEATURE_KEYS.filter((key) => FEATURE_META[key].category === 'two_key_runtime_toggle'),
      source_runtime_toggle: FEATURE_KEYS.filter((key) => FEATURE_META[key].category === 'source_runtime_toggle'),
      locked: FEATURE_KEYS.filter((key) => FEATURE_META[key].category === 'locked'),
    },
    dependency_chain: FEATURE_KEYS.map((key) => ({
      key,
      label: FEATURE_META[key].label,
      status: featureEntries[key]?.status || 'error',
      blocked_reason: featureEntries[key]?.blocked_reason || null,
    })),
  };
  evaluated.blocked_features = [...new Set(blockedFeatures)];
  evaluated.warnings = [...new Set(warnings)];
  return evaluated;
}

function updateMemeMonitorFeatureState({
  featureKey,
  enabled,
  env = process.env,
  repoRoot = resolveRepoRoot(),
  filePath,
  changedBy = 'dashboard',
  source = 'dashboard-control',
  reason = null,
} = {}) {
  const key = normalizeFeatureKey(featureKey);
  if (!key) {
    return {
      ok: false,
      error: 'unknown_feature',
      message: 'Unknown meme feature key',
    };
  }
  const current = loadRawMemeMonitorState({ env, repoRoot, filePath });
  const evaluated = evaluateMemeMonitorState(current, { env, filePath });
  const nextState = normalizeMemeMonitorState(current);
  const desired = parseBoolish(enabled, false);
  const meta = FEATURE_META[key];
  const ancestry = resolveFeatureAncestry(evaluated.features, key);

  if (!desired) {
    nextState.features[key].runtime = false;
    nextState.features[key].changed_at = nowIso();
    nextState.features[key].changed_by = changedBy;
    nextState.features[key].source = source;
    nextState.features[key].reason = reason || 'disabled-by-operator';
    if (key === 'MEME_MONITOR_ENABLED') {
      for (const descendantKey of FEATURE_KEYS.slice(1)) {
        nextState.features[descendantKey].runtime = false;
        nextState.features[descendantKey].changed_at = nowIso();
        nextState.features[descendantKey].changed_by = changedBy;
        nextState.features[descendantKey].source = source;
        nextState.features[descendantKey].reason = `disabled because ${meta.label} was disabled`;
      }
    }
    nextState.updated_at = nowIso();
    const saved = saveMemeMonitorState(nextState, { env, filePath });
    return {
      ok: true,
      action: 'disable',
      featureKey: key,
      message: `${meta.label} disabled`,
      state: saved,
    };
  }

  if (meta.category === 'locked') {
    return {
      ok: false,
      error: 'feature_locked',
      action: 'enable',
      featureKey: key,
      message: `${meta.label} is locked and not implemented yet`,
      blocked_reason: 'MEME_AUTO_ACTION_ENABLED is locked and not implemented',
      state: evaluated,
    };
  }

  if (meta.category === 'two_key_runtime_toggle' && !parseBoolish(env?.[key], false)) {
    return {
      ok: false,
      error: 'feature_disabled_in_config',
      action: 'enable',
      featureKey: key,
      message: `${meta.label} is disabled in config`,
      blocked_reason: `${key} is disabled in config`,
      state: evaluated,
    };
  }

  const ancestor = ancestry.find((entry) => entry.key !== key && !entry.effective);
  if (ancestor) {
    return {
      ok: false,
      error: 'dependency_blocked',
      action: 'enable',
      featureKey: key,
      message: `${meta.label} cannot be enabled while ${ancestor.label} is off`,
      blocked_reason: `${ancestor.key} is off`,
      state: evaluated,
    };
  }

  nextState.features[key].runtime = true;
  nextState.features[key].changed_at = nowIso();
  nextState.features[key].changed_by = changedBy;
  nextState.features[key].source = source;
  nextState.features[key].reason = reason || 'enabled-by-operator';
  nextState.updated_at = nowIso();
  const saved = saveMemeMonitorState(nextState, { env, filePath });
  return {
    ok: true,
    action: 'enable',
    featureKey: key,
    message: `${meta.label} enabled`,
    state: saved,
  };
}

function resolveFeatureAncestry(features = {}, featureKey = null) {
  const ancestry = [];
  let currentKey = normalizeFeatureKey(featureKey);
  while (currentKey) {
    const meta = FEATURE_META[currentKey];
    if (!meta) break;
    ancestry.unshift({
      key: currentKey,
      label: meta.label,
      effective: Boolean(features[currentKey]?.effective),
      category: meta.category || null,
    });
    currentKey = meta.parent;
  }
  return ancestry;
}

function loadRawMemeMonitorState(input = {}) {
  const filePath = resolveMemeMonitorStatePath(input);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  if (!store.exists(name)) return defaultMemeMonitorState();
  try {
    return normalizeMemeMonitorState(store.read(name) || {});
  } catch {
    return defaultMemeMonitorState();
  }
}

function normalizeFeatureKey(featureKey) {
  const key = String(featureKey || '').trim().toUpperCase();
  return FEATURE_KEYS.includes(key) ? key : null;
}

function parseBoolish(value, fallback = false) {
  if (value === undefined || value === null || value === '') return Boolean(fallback);
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(fallback);
}

module.exports = {
  FEATURE_KEYS,
  FEATURE_META,
  MEME_FEATURE_STATE_VERSION,
  defaultMemeMonitorState,
  evaluateMemeMonitorState,
  loadMemeMonitorState,
  loadRawMemeMonitorState,
  normalizeFeatureKey,
  normalizeMemeMonitorState,
  resolveFeatureAncestry,
  resolveMemeMonitorStatePath,
  saveMemeMonitorState,
  updateMemeMonitorFeatureState,
};
