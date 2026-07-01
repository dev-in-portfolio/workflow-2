const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractMentionsFromText,
  validateSymbolCandidate,
} = require('../src/meme-monitor/symbol-extractor');

test('symbol extractor accepts cashtags and mapped meme names', () => {
  const extracted = extractMentionsFromText('Buying $GME and watching GameStop plus SOUN calls');
  const symbols = extracted.detected.map((entry) => entry.symbol).sort();
  assert(symbols.includes('GME'));
  assert(symbols.includes('SOUN'));
});

test('symbol extractor rejects common words and trading slang', () => {
  for (const token of ['IT', 'ARE', 'FOR', 'ON', 'DD', 'YOLO']) {
    const result = validateSymbolCandidate(token);
    assert.equal(result.accepted, false, token);
    assert.match(result.reason || '', /rejected/);
  }
});

test('symbol extractor rejects uppercase words that are not plausible tickers', () => {
  const extracted = extractMentionsFromText('SEC said CEO and USA are busy, not a ticker');
  assert.equal(extracted.detected.length, 0);
});
