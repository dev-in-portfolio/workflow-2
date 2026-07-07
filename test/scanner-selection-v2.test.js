const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SetupClassification,
  ReasonCode,
  buildSelectionV2Score,
  buildBoundedPriorityOverrideBonus,
  buildBoundedRegularWatchBonus,
} = require('../src/scanner-selection-v2');
const { recordScannerSelectionShadow } = require('../src/scanner-outcome-shadow');

function snapshot({ price = 11, previousClose = 10, open = 10.1, high = 11.1, low = 9.95, minuteOpen = 10.8, minuteLow = 10.75, minuteHigh = 11.1, minuteVolume = 50_000, volume = 1_000_000, averageVolume = 2_000_000 } = {}) {
  return {
    averageVolume,
    latestTrade: { p: price, t: '2026-07-07T14:30:00.000Z' },
    latestQuote: { bp: price - 0.01, ap: price + 0.01, t: '2026-07-07T14:30:00.000Z' },
    minuteBar: { o: minuteOpen, h: minuteHigh, l: minuteLow, c: price, v: minuteVolume, vw: (minuteOpen + price) / 2, t: '2026-07-07T14:30:00.000Z' },
    dailyBar: { o: open, h: high, l: low, c: price, v: volume, vw: 10.6 },
    prevDailyBar: { c: previousClose, v: averageVolume },
  };
}

test('selection v2 positive momentum outranks equal negative collapse for continuation', () => {
  const up = buildSelectionV2Score({
    symbol: 'UP',
    snapshot: snapshot({ price: 11, previousClose: 10 }),
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });
  const down = buildSelectionV2Score({
    symbol: 'DOWN',
    snapshot: snapshot({ price: 9, previousClose: 10, open: 9.8, high: 10, low: 8.8, minuteOpen: 9.2, minuteHigh: 9.25, minuteLow: 8.9 }),
    currentPrice: 9,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert.equal(up.setup_classification, SetupClassification.BREAKOUT_CONTINUATION);
  assert(up.final_opportunity_score > down.final_opportunity_score);
});

test('selection v2 reversal requires stabilization', () => {
  const stabilizing = buildSelectionV2Score({
    symbol: 'REV',
    snapshot: snapshot({ price: 9.4, previousClose: 10, open: 9.8, high: 10, low: 9, minuteOpen: 9.1, minuteHigh: 9.45, minuteLow: 9.05 }),
    currentPrice: 9.4,
    previousClose: 10,
    spreadPct: 0.3,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });
  const falling = buildSelectionV2Score({
    symbol: 'FALL',
    snapshot: snapshot({ price: 9.1, previousClose: 10, open: 9.8, high: 10, low: 9, minuteOpen: 9.4, minuteHigh: 9.45, minuteLow: 9.05 }),
    currentPrice: 9.1,
    previousClose: 10,
    spreadPct: 0.3,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert.equal(stabilizing.setup_classification, SetupClassification.MEAN_REVERSION);
  assert.notEqual(falling.setup_classification, SetupClassification.MEAN_REVERSION);
});

test('selection v2 relative volume beats raw high volume without unusual activity', () => {
  const relative = buildSelectionV2Score({
    symbol: 'RVOL',
    snapshot: snapshot({ volume: 250_000, averageVolume: 300_000 }),
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });
  const raw = buildSelectionV2Score({
    symbol: 'RAW',
    snapshot: snapshot({ volume: 5_000_000, averageVolume: 25_000_000 }),
    currentPrice: 11,
    previousClose: 10,
    spreadPct: 0.2,
    receivedAt: '2026-07-07T14:30:00.000Z',
  });

  assert(relative.components.relative_volume_score > raw.components.relative_volume_score);
});

test('selection v2 stale watch data and priority override are bounded', () => {
  const staleBonus = buildBoundedRegularWatchBonus({ score: 100, ageSeconds: 600 }, { selectionV2RegularWatchMaxAgeSeconds: 180 });
  const freshBonus = buildBoundedRegularWatchBonus({ score: 100, ageSeconds: 30 }, { selectionV2RegularWatchMaxBonus: 12 });
  const priorityBonus = buildBoundedPriorityOverrideBonus({
    priorityOverride: { eligible: true, legacy_applied: true },
    features: { spread_pct: 0.2, relative_volume: 1.2 },
    setup: { setup_classification: SetupClassification.MOMENTUM_CONTINUATION },
    options: { selectionV2PriorityOverrideMaxBonus: 15 },
  });

  assert.equal(staleBonus.bonus, 0);
  assert.equal(freshBonus.bonus, 12);
  assert.equal(priorityBonus.bonus, 15);
});

test('selection v2 flags wide spread, failed breakout, and overextension', () => {
  const scored = buildSelectionV2Score({
    symbol: 'WIDE',
    snapshot: {
      ...snapshot({ price: 12, previousClose: 10, high: 13, low: 10, minuteOpen: 12.5, minuteHigh: 12.6, minuteLow: 11.9 }),
      minuteBar: { o: 12.5, h: 12.6, l: 11.9, c: 12, v: 50_000, vw: 10.5, t: '2026-07-07T14:30:00.000Z' },
      dailyBar: { o: 10.1, h: 13, l: 10, c: 12, v: 1_000_000, vw: 10.5 },
    },
    currentPrice: 12,
    previousClose: 10,
    spreadPct: 6,
    receivedAt: '2026-07-07T14:30:00.000Z',
    options: { selectionV2MaxVwapExtensionPct: 3 },
  });

  assert.equal(scored.qualified, false);
  assert(scored.reason_codes.includes(ReasonCode.SPREAD_TOO_WIDE_FOR_EXPECTED_GAIN));
  assert(scored.reason_codes.includes(ReasonCode.ENTRY_OVEREXTENDED_FROM_VWAP));
  assert(scored.reason_codes.includes(ReasonCode.MOMENTUM_DECELERATING));
});

test('shadow outcome tracker records candidates without order side effects', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-v2-shadow-'));
  const filePath = path.join(tempDir, 'outcomes.jsonl');
  const result = recordScannerSelectionShadow({
    filePath,
    receivedAt: '2026-07-07T14:30:00.000Z',
    candidates: [{
      symbol: 'AAA',
      rankScore: 88,
      payload: {
        side: 'buy',
        entry_price: 10,
        market_context: {
          scanner: {
            current_price: 10,
            selection_v2: {
              final_opportunity_score: 72,
              qualified: true,
              setup_classification: SetupClassification.MOMENTUM_CONTINUATION,
              reason_codes: [],
            },
          },
        },
      },
    }],
  });
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const record = JSON.parse(lines[0]);

  assert.equal(result.recorded, 1);
  assert.equal(record.symbol, 'AAA');
  assert.equal(record.observed, false);
  assert.equal(record.horizons.length, 6);
});
