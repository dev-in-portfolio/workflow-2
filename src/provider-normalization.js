function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampInfo(value, maxStalenessSeconds = 90, now = Date.now()) {
  let timestamp = finiteNumber(value);
  if (timestamp !== null) {
    if (timestamp > 1e17) timestamp /= 1e6;
    else if (timestamp > 1e14) timestamp /= 1e3;
    else if (timestamp < 1e11) timestamp *= 1000;
  } else {
    timestamp = new Date(value || 0).getTime();
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return { providerTimestamp: null, ageSeconds: null, freshness: 'unknown' };
  const ageSeconds = Math.max(0, (now - timestamp) / 1000);
  return {
    providerTimestamp: new Date(timestamp).toISOString(), ageSeconds,
    freshness: ageSeconds <= maxStalenessSeconds ? 'real_time' : 'stale',
  };
}

function comparePrice(primaryPrice, secondaryPrice, tolerancePct = 0.5) {
  const primary = finiteNumber(primaryPrice);
  const secondary = finiteNumber(secondaryPrice);
  if (!(primary > 0) || !(secondary > 0)) return { pass: false, differencePct: null };
  const differencePct = Math.abs(secondary - primary) / primary * 100;
  return { pass: differencePct <= tolerancePct, differencePct };
}

module.exports = { comparePrice, finiteNumber, timestampInfo };
