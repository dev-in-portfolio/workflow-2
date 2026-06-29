const test = require('node:test');
const assert = require('node:assert/strict');
const { performScannerChecks, normalizePortfolioSymbol } = require('../../src/risk/scanner-checks');

test('normalizePortfolioSymbol returns uppercase symbol as-is', () => {
  assert.equal(normalizePortfolioSymbol('AAPL'), 'AAPL');
});

test('normalizePortfolioSymbol uppercases lowercase input', () => {
  assert.equal(normalizePortfolioSymbol('aapl'), 'AAPL');
});

test('normalizePortfolioSymbol converts USDT suffix to /USDT', () => {
  assert.equal(normalizePortfolioSymbol('BTCUSDT'), 'BTC/USDT');
});

test('normalizePortfolioSymbol converts USD suffix to /USD', () => {
  assert.equal(normalizePortfolioSymbol('EURUSD'), 'EUR/USD');
});

test('normalizePortfolioSymbol leaves / pairs unchanged', () => {
  assert.equal(normalizePortfolioSymbol('BTC/USD'), 'BTC/USD');
});

test('normalizePortfolioSymbol returns null for empty input', () => {
  assert.equal(normalizePortfolioSymbol(''), null);
});

test('normalizePortfolioSymbol returns null for undefined', () => {
  assert.equal(normalizePortfolioSymbol(undefined), null);
});

test('normalizePortfolioSymbol returns null for null', () => {
  assert.equal(normalizePortfolioSymbol(null), null);
});

test('normalizePortfolioSymbol does not convert short USD suffix (USD)', () => {
  assert.equal(normalizePortfolioSymbol('USD'), 'USD');
});

test('performScannerChecks blocks unapproved buy symbol', () => {
  const result = performScannerChecks(
    { symbol: 'NOTAPPROVED', liquidity_score: 80 },
    'buy',
    {},
    { minLiquidityScore: 30, minVolume: 1000, maxSpreadSlippagePct: 7, volatilityThresholdPct: null },
    'NOTAPPROVED',
    ['AAPL', 'MSFT'],
  );
  assert.ok(result.reasonCodes.includes('SYMBOL_NOT_APPROVED_FOR_LIVE_MARKET'));
});

test('performScannerChecks flags low liquidity', () => {
  const result = performScannerChecks(
    { symbol: 'AAPL', liquidity_score: 10 },
    'buy',
    {},
    { minLiquidityScore: 50, minVolume: 1000, maxSpreadSlippagePct: 7, volatilityThresholdPct: null },
    'AAPL',
    ['AAPL'],
  );
  assert.ok(result.reasonCodes.includes('MIN_LIQUIDITY_NOT_MET'));
});

test('performScannerChecks flags low volume', () => {
  const result = performScannerChecks(
    { symbol: 'AAPL', liquidity_score: 80 },
    'buy',
    { volume: 100 },
    { minLiquidityScore: 30, minVolume: 5000, maxSpreadSlippagePct: 7, volatilityThresholdPct: null },
    'AAPL',
    ['AAPL'],
  );
  assert.ok(result.reasonCodes.includes('MIN_VOLUME_NOT_MET'));
});

test('performScannerChecks flags excessive spread as warning', () => {
  const result = performScannerChecks(
    { symbol: 'AAPL', liquidity_score: 80 },
    'buy',
    { volume: 10000, spread_slippage_pct: 10 },
    { minLiquidityScore: 30, minVolume: 1000, maxSpreadSlippagePct: 5, volatilityThresholdPct: null },
    'AAPL',
    ['AAPL'],
  );
  assert.ok(result.warnings.includes('MAX_SPREAD_SLIPPAGE_EXCEEDED'));
});

test('performScannerChecks flags earnings blackout', () => {
  const result = performScannerChecks(
    { symbol: 'AAPL', liquidity_score: 80 },
    'buy',
    { volume: 10000, spread_slippage_pct: 1, events: [{ type: 'earnings_blackout' }] },
    { minLiquidityScore: 30, minVolume: 1000, maxSpreadSlippagePct: 5, volatilityThresholdPct: null },
    'AAPL',
    ['AAPL'],
  );
  assert.ok(result.reasonCodes.includes('EVENT_BLACKOUT'));
});

test('performScannerChecks passes healthy signal', () => {
  const result = performScannerChecks(
    { symbol: 'AAPL', liquidity_score: 80 },
    'buy',
    { volume: 10000, spread_slippage_pct: 1 },
    { minLiquidityScore: 30, minVolume: 1000, maxSpreadSlippagePct: 5, volatilityThresholdPct: null },
    'AAPL',
    ['AAPL'],
  );
  assert.equal(result.reasonCodes.length, 0);
  assert.equal(result.warnings.length, 0);
});
