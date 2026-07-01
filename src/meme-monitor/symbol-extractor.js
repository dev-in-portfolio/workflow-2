const { normalizeSymbol } = require('../market-data');

const CASHTAG_RE = /\$([A-Z]{1,5}(?:\.[A-Z]{1,2})?)(?![A-Z0-9])/g;
const UPPER_TOKEN_RE = /\b[A-Z]{2,5}(?:\.[A-Z]{1,2})?\b/g;

const COMMON_WORD_DENYLIST = new Set([
  'IT', 'ARE', 'FOR', 'ON', 'THE', 'AND', 'BUT', 'NOT', 'ALL', 'ANY', 'CEO', 'CFO', 'USD', 'USA',
  'ATH', 'IMO', 'LOL', 'FOMO', 'CPI', 'SEC', 'GDP', 'ETF', 'YOLO', 'DD', 'GAIN', 'GAINS', 'LOSS',
  'LOSSS', 'MOON', 'MOASS', 'CALL', 'CALLS', 'PUT', 'PUTS', 'BAG', 'BAGS', 'BAGHOLDER', 'IV', 'AI',
  'EOD', 'IPO', 'GMEH', 'WTF', 'WEN', 'TICKER', 'STONK', 'STONKS', 'WSB', 'WSB',
]);

const SYMBOL_NAME_ALIASES = new Map([
  ['gamestop', 'GME'],
  ['soundhound', 'SOUN'],
  ['amc entertainment', 'AMC'],
  ['amc theaters', 'AMC'],
  ['palantir', 'PLTR'],
  ['nvidia', 'NVDA'],
  ['tesla', 'TSLA'],
  ['super micro computer', 'SMCI'],
  ['supermicro', 'SMCI'],
  ['microstrategy', 'MSTR'],
  ['microsoft', 'MSFT'],
  ['apple', 'AAPL'],
  ['amazon', 'AMZN'],
  ['coinbase', 'COIN'],
]);

const PLAUSIBLE_MEME_TICKERS = new Set([
  'GME', 'AMC', 'SOUN', 'PLTR', 'TSLA', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'MSTR', 'COIN', 'SMCI', 'META',
  'RIVN', 'LCID', 'NIO', 'SOFI', 'F', 'UPST', 'AMD', 'INTC', 'NFLX', 'QQQ', 'SPY', 'QQQ', 'HOOD', 'RDDT',
]);

function extractMentionsFromText(text, options = {}) {
  const sourceText = String(text || '');
  const lowerText = sourceText.toLowerCase();
  const detected = [];
  const rejected = [];
  const seen = new Set();
  const sourceMeta = normalizeSourceMeta(options.sourceMeta);

  for (const [phrase, symbol] of SYMBOL_NAME_ALIASES.entries()) {
    if (!lowerText.includes(phrase)) continue;
    const reasonCodes = ['symbol_name_mapped'];
    const validated = validateSymbolCandidate(symbol, {
      ...options,
      token: phrase,
      tokenSource: 'alias',
      cashtag: false,
      allowPlaintext: true,
    });
    if (validated.accepted) {
      const key = `${validated.symbol}::alias`;
      if (!seen.has(key)) {
        detected.push({
          symbol: validated.symbol,
          token: phrase,
          source: options.source || null,
          sourceTier: sourceMeta.tier || null,
          sourceWeight: sourceMeta.weight,
          sourceStatus: sourceMeta.status || null,
          sourceId: options.sourceId || null,
          threadId: options.threadId || null,
          author: options.author || null,
          createdAt: options.createdAt || null,
          kind: options.kind || 'post',
          cashtag: false,
          confidence: validated.confidence,
          reasonCodes: [...reasonCodes, ...validated.reasonCodes],
        });
        seen.add(key);
      }
    } else {
      rejected.push({
        token: phrase,
        reason: validated.reason || 'not_tradable_rejected',
      });
    }
  }

  const cashtags = [...sourceText.matchAll(CASHTAG_RE)];
  for (const match of cashtags) {
    const token = match[1];
    const validated = validateSymbolCandidate(token, {
      ...options,
      token,
      tokenSource: 'cashtag',
      cashtag: true,
      allowPlaintext: true,
    });
    if (!validated.accepted) {
      rejected.push({ token, reason: validated.reason || 'not_tradable_rejected' });
      continue;
    }
    const key = `${validated.symbol}::cashtag`;
    if (seen.has(key)) continue;
    detected.push({
      symbol: validated.symbol,
      token,
      source: options.source || null,
      sourceTier: sourceMeta.tier || null,
      sourceWeight: sourceMeta.weight,
      sourceStatus: sourceMeta.status || null,
      sourceId: options.sourceId || null,
      threadId: options.threadId || null,
      author: options.author || null,
      createdAt: options.createdAt || null,
      kind: options.kind || 'post',
      cashtag: true,
      confidence: validated.confidence,
      reasonCodes: ['symbol_cashtag_detected', ...validated.reasonCodes],
    });
    seen.add(key);
  }

  const tokens = [...sourceText.matchAll(UPPER_TOKEN_RE)];
  for (const match of tokens) {
    const token = match[0];
    if (token.startsWith('$')) continue;
    const validated = validateSymbolCandidate(token, {
      ...options,
      token,
      tokenSource: 'plaintext',
      cashtag: false,
      allowPlaintext: true,
    });
    if (!validated.accepted) {
      rejected.push({ token, reason: validated.reason || 'not_tradable_rejected' });
      continue;
    }
    const key = `${validated.symbol}::plaintext`;
    if (seen.has(key)) continue;
    detected.push({
      symbol: validated.symbol,
      token,
      source: options.source || null,
      sourceTier: sourceMeta.tier || null,
      sourceWeight: sourceMeta.weight,
      sourceStatus: sourceMeta.status || null,
      sourceId: options.sourceId || null,
      threadId: options.threadId || null,
      author: options.author || null,
      createdAt: options.createdAt || null,
      kind: options.kind || 'post',
      cashtag: false,
      confidence: validated.confidence,
      reasonCodes: ['symbol_plaintext_detected', ...validated.reasonCodes],
    });
    seen.add(key);
  }

  return {
    detected,
    rejected,
  };
}

function validateSymbolCandidate(token, options = {}) {
  const normalized = normalizeSymbol(token || '');
  const upper = String(normalized || '').toUpperCase();
  if (!upper) {
    return { accepted: false, reason: 'empty_token_rejected', reasonCodes: ['empty_token_rejected'] };
  }
  if (COMMON_WORD_DENYLIST.has(upper)) {
    return { accepted: false, reason: 'common_word_rejected', reasonCodes: ['common_word_rejected'] };
  }
  if (upper.length < 1 || upper.length > 5) {
    return { accepted: false, reason: 'not_tradable_rejected', reasonCodes: ['not_tradable_rejected'] };
  }
  if (!options.cashtag && upper.length <= 2 && !PLAUSIBLE_MEME_TICKERS.has(upper)) {
    return { accepted: false, reason: 'short_token_rejected', reasonCodes: ['common_word_rejected'] };
  }
  if (!isPlausibleTickerFormat(upper)) {
    return { accepted: false, reason: 'not_tradable_rejected', reasonCodes: ['not_tradable_rejected'] };
  }

  const tradableLookup = buildTradableLookup(options);
  if (options.requireTradableMatch && tradableLookup && !tradableLookup(upper)) {
    return { accepted: false, reason: 'not_tradable_rejected', reasonCodes: ['not_tradable_rejected'] };
  }
  if (!options.cashtag && !PLAUSIBLE_MEME_TICKERS.has(upper) && !tradableLookup?.(upper)) {
    return { accepted: false, reason: 'not_tradable_rejected', reasonCodes: ['not_tradable_rejected'] };
  }

  const reasonCodes = [];
  if (options.cashtag) {
    reasonCodes.push('symbol_cashtag_detected');
  } else {
    reasonCodes.push('symbol_plaintext_detected');
  }
  if (PLAUSIBLE_MEME_TICKERS.has(upper)) {
    reasonCodes.push('tradable_symbol_hint');
  }
  if (tradableLookup && tradableLookup(upper)) {
    reasonCodes.push('tradable_symbol_confirmed');
  }

  return {
    accepted: true,
    symbol: upper,
    confidence: options.cashtag ? 95 : (PLAUSIBLE_MEME_TICKERS.has(upper) ? 82 : 68),
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function buildTradableLookup(options = {}) {
  if (typeof options.isTradableSymbol === 'function') {
    return options.isTradableSymbol;
  }
  if (options.tradableSymbols) {
    const symbolSet = new Set((Array.isArray(options.tradableSymbols) ? options.tradableSymbols : Array.from(options.tradableSymbols))
      .map((symbol) => String(symbol).toUpperCase()));
    return (symbol) => symbolSet.has(String(symbol).toUpperCase());
  }
  return null;
}

function isPlausibleTickerFormat(symbol) {
  return /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/.test(String(symbol || '').toUpperCase());
}

function extractMentionsFromRecord(record = {}, options = {}) {
  const source = String(record.source || record.subreddit || options.source || 'reddit').trim();
  const sourceMeta = normalizeSourceMeta(options.sourceMeta || record.sourceMeta || record.source_meta || null);
  const sourceId = record.source_id || record.id || record.post_id || record.comment_id || null;
  const threadId = record.thread_id || record.link_id || record.post_id || record.id || null;
  const author = record.author || record.user || record.username || null;
  const createdAt = record.created_at || record.createdAt || record.timestamp || null;
  const kind = String(record.kind || record.type || (record.comment_id ? 'comment' : 'post')).toLowerCase();
  const engagement = Number.isFinite(Number(record.engagement))
    ? Number(record.engagement)
    : Number.isFinite(Number(record.score))
      ? Number(record.score)
      : Number.isFinite(Number(record.upvotes))
        ? Number(record.upvotes)
        : Number.isFinite(Number(record.commentCount))
          ? Number(record.commentCount)
          : 0;
  const textParts = [
    record.title,
    record.body,
    record.text,
    record.selftext,
    record.comment_body,
    record.content,
  ].filter(Boolean);
  const text = textParts.join(' \n ');
  const extracted = extractMentionsFromText(text, {
    source,
    sourceMeta,
    sourceId,
    threadId,
    author,
    createdAt,
    kind,
    engagement,
    tradableSymbols: options.tradableSymbols,
    isTradableSymbol: options.isTradableSymbol,
    requireTradableMatch: options.requireTradableMatch,
  });

  return {
    mentions: extracted.detected.map((mention) => ({
      ...mention,
      engagement,
      commentCount: Number.isFinite(Number(record.commentCount))
        ? Number(record.commentCount)
        : (kind === 'comment' ? 1 : 0),
      postCount: kind === 'post' ? 1 : 0,
      threadId,
      source,
      sourceId,
      author,
      createdAt,
      kind,
      url: record.url || record.permalink || null,
      title: record.title || null,
    })),
    rejected: extracted.rejected,
  };
}

function normalizeSourceMeta(value = null) {
  if (!value || typeof value !== 'object') {
    return { source: null, tier: null, weight: 1, status: null };
  }
  const weight = Number.isFinite(Number(value.weight)) ? Number(value.weight) : Number.isFinite(Number(value.tierWeight)) ? Number(value.tierWeight) : 1;
  return {
    source: value.source || null,
    tier: value.tier || null,
    weight: weight > 0 ? weight : 1,
    status: value.status || null,
  };
}

module.exports = {
  COMMON_WORD_DENYLIST,
  PLAUSIBLE_MEME_TICKERS,
  SYMBOL_NAME_ALIASES,
  extractMentionsFromRecord,
  extractMentionsFromText,
  isPlausibleTickerFormat,
  validateSymbolCandidate,
};
