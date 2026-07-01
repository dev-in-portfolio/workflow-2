const { parseBool } = require('../config');

const DEFAULT_MEME_REDDIT_SOURCE_TIERS = {
  tier_1: [
    'wallstreetbets',
    'wallstreetbets2',
    'wallstreetbetsnew',
    'wallstreetbetselite',
    'shortsqueeze',
    'SqueezePlays',
    'pennystocks',
    'smallstreetbets',
  ],
  tier_2: [
    'stocks',
    'StockMarket',
    'options',
    'daytrading',
    'swingtrading',
    'RobinHood',
    'Webull',
  ],
  tier_3: [
    'investing',
    'ValueInvesting',
    'SecurityAnalysis',
    'SPACs',
  ],
  ticker_specific: [
    'Superstonk',
    'GME',
    'amcstock',
    'BBBY',
    'BBBYQ',
  ],
  optional_high_noise: [
    'CryptoCurrency',
    'wallstreetbetscrypto',
  ],
};

const DEFAULT_TIER_WEIGHTS = {
  tier_1: 1.35,
  tier_2: 1.0,
  tier_3: 0.55,
  ticker_specific: 0.9,
  optional_high_noise: 0.45,
};

function parseCsvList(value, fallback = []) {
  if (value === undefined || value === null || value === '') {
    return Array.isArray(fallback) ? fallback.slice() : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function normalizeSourceName(value) {
  return String(value || '').trim();
}

function resolveMemeSocialSourceConfig(env = process.env, runtimeState = null) {
  const optionalHighNoiseEnabled = parseBool(env.MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE_ENABLED, false);
  const redditListings = parseCsvList(env.MEME_REDDIT_LISTINGS, ['hot', 'rising'])
    .map((listing) => String(listing || '').trim().toLowerCase())
    .filter(Boolean);
  const legacySources = parseCsvList(env.MEME_REDDIT_SOURCES, []);
  const hasTierOverrides = [
    env.MEME_REDDIT_SOURCES_TIER_1,
    env.MEME_REDDIT_SOURCES_TIER_2,
    env.MEME_REDDIT_SOURCES_TIER_3,
    env.MEME_REDDIT_SOURCES_TICKER_SPECIFIC,
    env.MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE,
  ].some(Boolean);
  const tierConfig = {
    tier_1: parseCsvList(env.MEME_REDDIT_SOURCES_TIER_1, DEFAULT_MEME_REDDIT_SOURCE_TIERS.tier_1),
    tier_2: parseCsvList(env.MEME_REDDIT_SOURCES_TIER_2, DEFAULT_MEME_REDDIT_SOURCE_TIERS.tier_2),
    tier_3: parseCsvList(env.MEME_REDDIT_SOURCES_TIER_3, DEFAULT_MEME_REDDIT_SOURCE_TIERS.tier_3),
    ticker_specific: parseCsvList(env.MEME_REDDIT_SOURCES_TICKER_SPECIFIC, DEFAULT_MEME_REDDIT_SOURCE_TIERS.ticker_specific),
    optional_high_noise: parseCsvList(env.MEME_REDDIT_SOURCES_OPTIONAL_HIGH_NOISE, DEFAULT_MEME_REDDIT_SOURCE_TIERS.optional_high_noise),
  };
  if (legacySources.length && !hasTierOverrides) {
    tierConfig.tier_2 = legacySources;
  }

  const runtimeBySource = new Map();
  const runtimeSources = Array.isArray(runtimeState?.redditScanner?.sources)
    ? runtimeState.redditScanner.sources
    : Array.isArray(runtimeState?.sources)
      ? runtimeState.sources
      : [];
  for (const entry of runtimeSources) {
    const source = normalizeSourceName(entry?.source);
    if (!source) continue;
    runtimeBySource.set(source.toLowerCase(), entry);
  }

  const sourceDefinitionsByName = new Map();
  for (const tier of Object.keys(tierConfig)) {
    const enabledByDefault = tier !== 'optional_high_noise' || optionalHighNoiseEnabled;
    for (const source of tierConfig[tier]) {
      const normalizedSource = normalizeSourceName(source);
      if (!normalizedSource) continue;
      const runtime = runtimeBySource.get(normalizedSource.toLowerCase()) || null;
      const status = runtime?.status || (enabledByDefault ? 'pending' : 'disabled');
      const active = Boolean(enabledByDefault && !['inactive', 'error', 'disabled'].includes(String(status).toLowerCase()));
      sourceDefinitionsByName.set(normalizedSource.toLowerCase(), {
        source: normalizedSource,
        tier,
        tierWeight: DEFAULT_TIER_WEIGHTS[tier] ?? 1,
        enabled: enabledByDefault,
        active,
        status,
        blockedReason: runtime?.blockedReason || runtime?.blocked_reason || null,
        lastScanAt: runtime?.lastScanAt || runtime?.last_scan_at || null,
        lastError: runtime?.lastError || runtime?.last_error || null,
        symbolsDetected: Number(runtime?.symbolsDetected || runtime?.symbols_detected || 0),
        rejectedTokens: Number(runtime?.rejectedTokens || runtime?.rejected_tokens || 0),
      });
    }
  }
  const sourceDefinitions = [...sourceDefinitionsByName.values()];

  const activeSources = sourceDefinitions.filter((entry) => entry.enabled && entry.status !== 'disabled');
  return {
    redditClientId: env.REDDIT_CLIENT_ID || '',
    redditClientSecret: env.REDDIT_CLIENT_SECRET || '',
    redditUserAgent: env.REDDIT_USER_AGENT || 'workflow-2-meme-monitor',
    redditListings: redditListings.length ? redditListings : ['hot', 'rising'],
    sources: activeSources.slice(),
    sourceDefinitions,
    tierConfig,
    optionalHighNoiseEnabled,
    tierWeights: { ...DEFAULT_TIER_WEIGHTS },
    sourceNames: sourceDefinitions.map((entry) => entry.source),
    sourceLookup: new Map(sourceDefinitions.map((entry) => [entry.source.toLowerCase(), entry])),
  };
}

function resolveSourceWeight(sourceOrTier, tierWeights = DEFAULT_TIER_WEIGHTS) {
  const tier = String(sourceOrTier || '').trim().toLowerCase();
  return Number(tierWeights[tier] ?? 1);
}

function resolveSourceLabel(source) {
  return normalizeSourceName(source);
}

module.exports = {
  DEFAULT_MEME_REDDIT_SOURCE_TIERS,
  DEFAULT_TIER_WEIGHTS,
  parseCsvList,
  resolveMemeSocialSourceConfig,
  resolveSourceLabel,
  resolveSourceWeight,
};
