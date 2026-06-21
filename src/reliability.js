const { nowIso } = require('./util');

async function retryWithBackoff(fn, options = {}) {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 1000;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      await sleep(delay);
    }
  }
  throw lastError;
}

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30000;
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureAt = null;
  }

  canExecute(now = Date.now()) {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && this.lastFailureAt && now - this.lastFailureAt >= this.cooldownMs) {
      this.state = 'half_open';
      return true;
    }
    return this.state === 'half_open';
  }

  recordSuccess() {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureAt = null;
  }

  recordFailure(now = Date.now()) {
    this.failureCount += 1;
    this.lastFailureAt = now;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}

class ProviderStatusTracker {
  constructor() {
    this.providers = new Map();
  }

  markHealthy(provider, metadata = {}) {
    this.providers.set(provider, {
      provider,
      status: 'healthy',
      degraded: false,
      updated_at: nowIso(),
      metadata,
    });
  }

  markDegraded(provider, reason, metadata = {}) {
    this.providers.set(provider, {
      provider,
      status: 'degraded',
      degraded: true,
      reason,
      updated_at: nowIso(),
      metadata,
    });
  }

  getStatus(provider) {
    return this.providers.get(provider) || {
      provider,
      status: 'unknown',
      degraded: true,
      updated_at: null,
    };
  }
}

function createDeadLetterRecord(event, reason) {
  return {
    dead_letter_id: `dlq_${Date.now()}`,
    created_at: nowIso(),
    reason,
    event,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  CircuitBreaker,
  ProviderStatusTracker,
  createDeadLetterRecord,
  retryWithBackoff,
};
