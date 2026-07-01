const path = require('path');
const { JsonFileStore } = require('../storage');
const { nowIso, resolveRepoRoot } = require('../util');

const REGULAR_WATCH_FEATURE_STATE_VERSION = '2026-06-30.regular-watch-state.1';
const FEATURE_KEYS = [
  'REGULAR_WATCH_INTELLIGENCE_ENABLED',
  'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED',
  'REGULAR_WATCH_ASSET_VALIDATION_ENABLED',
  'REGULAR_WATCH_HALT_CHECK_ENABLED',
  'REGULAR_WATCH_SEC_RISK_CHECK_ENABLED',
  'REGULAR_WATCH_NEWS_CATALYST_ENABLED',
  'REGULAR_WATCH_PRIORITY_SCORING_ENABLED',
  'REGULAR_WATCH_SCANNER_RANKING_ENABLED',
  'REGULAR_WATCH_POSITION_AWARENESS_ENABLED',
  'REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED',
  'REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED',
  'REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED',
  'REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED',
];

const FEATURE_META = {
  REGULAR_WATCH_INTELLIGENCE_ENABLED: { label: 'Regular Watch Intelligence', parent: null, category: 'display_runtime_toggle' },
  REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED: { label: 'Market Confirmation', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_ASSET_VALIDATION_ENABLED: { label: 'Asset Validation', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_HALT_CHECK_ENABLED: { label: 'Halt Check', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_SEC_RISK_CHECK_ENABLED: { label: 'SEC Risk Check', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_NEWS_CATALYST_ENABLED: { label: 'News/Catalyst Check', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_PRIORITY_SCORING_ENABLED: { label: 'Priority Scoring', parent: 'REGULAR_WATCH_MARKET_CONFIRMATION_ENABLED', category: 'two_key_runtime_toggle' },
  REGULAR_WATCH_SCANNER_RANKING_ENABLED: { label: 'Scanner Ranking', parent: 'REGULAR_WATCH_PRIORITY_SCORING_ENABLED', category: 'two_key_runtime_toggle' },
  REGULAR_WATCH_POSITION_AWARENESS_ENABLED: { label: 'Position Awareness', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'two_key_runtime_toggle' },
  REGULAR_WATCH_POLYGON_CONFIRMATION_ENABLED: { label: 'Polygon Confirmation', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_ALPHA_VANTAGE_CONFIRMATION_ENABLED: { label: 'Alpha Vantage Confirmation', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_SOCIAL_CONTEXT_ENABLED: { label: 'Social Context', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
  REGULAR_WATCH_OPTIONS_CONTEXT_ENABLED: { label: 'Options Context', parent: 'REGULAR_WATCH_INTELLIGENCE_ENABLED', category: 'display_runtime_toggle' },
};

function resolveRegularWatchStatePath(input = {}) {
  if (typeof input === 'string') return path.resolve(input);
  if (input?.filePath) return path.resolve(input.filePath);
  if (input?.path) return path.resolve(input.path);
  if (input?.dataDir) return path.resolve(input.dataDir, 'state', 'regular-watch-state.json');
  if (input?.repoRoot) return path.resolve(input.repoRoot, 'data', 'state', 'regular-watch-state.json');
  return path.resolve(resolveRepoRoot(), 'data', 'state', 'regular-watch-state.json');
}

function defaultRegularWatchState() {
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
    version: REGULAR_WATCH_FEATURE_STATE_VERSION,
    updated_at: null,
    source: 'env + runtime state',
    features,
  };
}

function resolveRegularWatchFeatureStatus(meta, { configured = false, runtime = false, parentEffective = true } = {}) {
  if (!parentEffective) {
    return {
      status: configured || runtime ? 'blocked' : 'off',
      effective: false,
      blockedReason: `${meta.parent || 'parent'} is off`,
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

  if (runtime) {
    return { status: 'active', effective: true, blockedReason: null };
  }
  if (configured) {
    return { status: 'shadow', effective: false, blockedReason: null };
  }
  return { status: 'off', effective: false, blockedReason: null };
}

function loadRegularWatchState(input = {}) {
  const filePath = resolveRegularWatchStatePath(input);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  let state = defaultRegularWatchState();
  try {
    if (store.exists(name)) {
      const raw = store.read(name);
      if (raw) state = normalizeRegularWatchState(raw);
    }
  } catch {
    state = defaultRegularWatchState();
  }
  return evaluateRegularWatchState(state, { env: input.env || process.env });
}

function saveRegularWatchState(state, input = {}) {
  const filePath = resolveRegularWatchStatePath(input);
  const store = new JsonFileStore(path.dirname(filePath));
  const normalized = normalizeRegularWatchState(state);
  store.write(path.basename(filePath), normalized);
  return evaluateRegularWatchState(normalized, { env: input.env || process.env });
}

function normalizeRegularWatchState(state = {}) {
  const normalized = defaultRegularWatchState();
  normalized.version = state.version || REGULAR_WATCH_FEATURE_STATE_VERSION;
  normalized.updated_at = state.updated_at || null;
  normalized.source = state.source || 'env + runtime state';
  const sourceFeatures = state.features && typeof state.features === 'object' ? state.features : {};
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

function evaluateRegularWatchState(state = {}, options = {}) {
  const normalized = normalizeRegularWatchState(state);
  const env = options.env || process.env;
  const evaluated = defaultRegularWatchState();
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
    const parentBlockedReason = parent?.blocked_reason || null;
    const dependencyBlocked = Boolean(parentKey && !parentEffective);
    const configConflict = runtime && !configured && meta.category === 'two_key_runtime_toggle';

    if (configConflict) {
      warnings.push(`${key} runtime toggle is on but config is off`);
    }

    const resolved = resolveRegularWatchFeatureStatus(meta, {
      configured,
      runtime,
      parentEffective,
    });
    const status = dependencyBlocked
      ? (configured || runtime ? 'blocked' : 'off')
      : resolved.status;
    const blockedReason = dependencyBlocked
      ? (parentBlockedReason || `${parentKey} is off`)
      : resolved.blockedReason || null;
    const effective = dependencyBlocked ? false : Boolean(resolved.effective);

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

    if (status === 'blocked') {
      blockedFeatures.push(meta.label);
    }

    if (!dependencyBlocked && !configured && !runtime) {
      computed.status = 'off';
      computed.blocked_reason = null;
    }

    featureEntries[key] = computed;
  }

  const counts = {
    off: 0,
    active: 0,
    shadow: 0,
    blocked: 0,
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
    master_enabled: Boolean(featureEntries.REGULAR_WATCH_INTELLIGENCE_ENABLED?.effective),
    feature_categories: {
      display_runtime_toggle: FEATURE_KEYS.filter((key) => FEATURE_META[key].category === 'display_runtime_toggle'),
      two_key_runtime_toggle: FEATURE_KEYS.filter((key) => FEATURE_META[key].category === 'two_key_runtime_toggle'),
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

function updateRegularWatchFeatureState({
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
      message: 'Unknown regular watch feature key',
    };
  }
  const current = loadRawRegularWatchState({ env, repoRoot, filePath });
  const evaluated = evaluateRegularWatchState(current, { env, filePath });
  const nextState = normalizeRegularWatchState(current);
  const desired = parseBoolish(enabled, false);
  const meta = FEATURE_META[key];
  const ancestry = resolveFeatureAncestry(evaluated.features, key);

  if (!desired) {
    nextState.features[key].runtime = false;
    nextState.features[key].changed_at = nowIso();
    nextState.features[key].changed_by = changedBy;
    nextState.features[key].source = source;
    nextState.features[key].reason = reason || 'disabled-by-operator';
    if (key === 'REGULAR_WATCH_INTELLIGENCE_ENABLED') {
      for (const descendantKey of FEATURE_KEYS.slice(1)) {
        nextState.features[descendantKey].runtime = false;
        nextState.features[descendantKey].changed_at = nowIso();
        nextState.features[descendantKey].changed_by = changedBy;
        nextState.features[descendantKey].source = source;
        nextState.features[descendantKey].reason = `disabled because ${meta.label} was disabled`;
      }
    }
    nextState.updated_at = nowIso();
    const saved = saveRegularWatchState(nextState, { env, filePath });
    return {
      ok: true,
      action: 'disable',
      featureKey: key,
      message: `${meta.label} disabled`,
      state: saved,
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
  const saved = saveRegularWatchState(nextState, { env, filePath });
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

function loadRawRegularWatchState(input = {}) {
  const filePath = resolveRegularWatchStatePath(input);
  const store = new JsonFileStore(path.dirname(filePath));
  const name = path.basename(filePath);
  if (!store.exists(name)) return defaultRegularWatchState();
  try {
    return normalizeRegularWatchState(store.read(name) || {});
  } catch {
    return defaultRegularWatchState();
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
  REGULAR_WATCH_FEATURE_STATE_VERSION,
  defaultRegularWatchState,
  evaluateRegularWatchState,
  loadRawRegularWatchState,
  loadRegularWatchState,
  normalizeFeatureKey,
  normalizeRegularWatchState,
  resolveFeatureAncestry,
  resolveRegularWatchStatePath,
  saveRegularWatchState,
  updateRegularWatchFeatureState,
};
