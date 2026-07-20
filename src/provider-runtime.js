const fs = require('fs');
const path = require('path');

class ProviderRuntime {
  constructor(options = {}) {
    this.provider = options.provider;
    this.windowMs = Math.max(1000, Number(options.windowMs || 60000));
    this.maxRequests = Math.max(1, Number(options.maxRequests || 60));
    this.dailyMax = Number.isFinite(Number(options.dailyMax)) ? Math.max(0, Number(options.dailyMax)) : null;
    this.dailyReserve = Math.max(0, Number(options.dailyReserve || 0));
    this.statePath = options.statePath || null;
    this.clock = options.clock || (() => new Date());
    this.cooldownMs = Math.max(1000, Number(options.cooldownMs || 60000));
    this.circuitFailureThreshold = Math.max(1, Number(options.circuitFailureThreshold || 3));
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.cache = new Map();
    this.inflight = new Map();
    this.requests = [];
    this.daily = this.loadDaily();
    this.health = {
      provider: this.provider, lastAttemptedRequest: null, lastSuccessfulRequest: null,
      lastFailure: null, lastReasonCode: null, latencyMs: null, cacheHits: 0, cacheMisses: 0,
      cooldownUntil: null, circuitState: 'closed', authenticationStatus: 'unknown', capabilities: {},
      consecutiveFailures: 0, entitlementClassification: 'unknown', freshnessClassification: 'unknown',
      lastResponseTimestamp: null, lastResponseAge: null, status: 'unavailable',
    };
  }

  async run(key, request, options = {}) {
    const ttlMs = Math.max(0, Number(options.cacheSeconds || 0) * 1000);
    const cached = this.cache.get(key);
    if (cached && this.nowMs() - cached.storedAt <= ttlMs) {
      this.health.cacheHits += 1;
      this.log('debug', 'provider_cache_hit', { cache_key: key });
      return { ...cached.value, cached: true, cacheAgeSeconds: (this.nowMs() - cached.storedAt) / 1000 };
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    this.health.cacheMisses += 1;
    const promise = this.execute(key, request).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    const value = await promise;
    if (value?.ok) this.cache.set(key, { storedAt: this.nowMs(), value });
    return value;
  }

  async execute(_key, request) {
    this.resetDailyIfNeeded();
    const now = this.nowMs();
    this.requests = this.requests.filter((at) => now - at < this.windowMs);
    if (this.health.cooldownUntil && new Date(this.health.cooldownUntil).getTime() > now) {
      this.log('warn', 'provider_cooldown_active', { cooldown_until: this.health.cooldownUntil, circuit_state: this.health.circuitState });
      return this.failure(`${this.provider.toUpperCase()}_${this.health.circuitState === 'open' ? 'CIRCUIT_OPEN' : 'COOLDOWN_ACTIVE'}`, { countFailure: false });
    }
    if (this.health.circuitState === 'open') this.health.circuitState = 'half_open';
    if (this.requests.length >= this.maxRequests) {
      this.log('warn', 'provider_rate_limit_protection', { requests_in_window: this.requests.length, request_limit: this.maxRequests });
      return this.failure(`${this.provider.toUpperCase()}_RATE_LIMITED`);
    }
    if (this.dailyMax !== null && this.daily.used >= Math.max(0, this.dailyMax - this.dailyReserve)) {
      this.log('warn', 'provider_daily_reserve_protection', { estimated_daily_usage: this.daily.used, daily_limit: this.dailyMax, reserve: this.dailyReserve });
      return this.failure(`${this.provider.toUpperCase()}_DAILY_RESERVE_REACHED`);
    }
    this.requests.push(now);
    this.daily.used += 1;
    this.persistDaily();
    this.health.lastAttemptedRequest = this.nowIso();
    const started = this.nowMs();
    try {
      const result = await request();
      this.health.latencyMs = this.nowMs() - started;
      if (result?.ok) {
        this.health.lastSuccessfulRequest = this.nowIso();
        this.health.lastFailure = null;
        this.health.lastReasonCode = null;
        this.health.consecutiveFailures = 0;
        this.health.cooldownUntil = null;
        this.health.circuitState = 'closed';
        this.health.status = 'healthy';
        if (this.health.authenticationStatus === 'unknown') this.health.authenticationStatus = 'authenticated';
        this.health.entitlementClassification = result.entitlement || this.health.entitlementClassification;
        this.health.freshnessClassification = result.freshness || this.health.freshnessClassification;
        this.health.lastResponseTimestamp = result.providerTimestamp || result.receivedAt || this.nowIso();
        this.log('info', 'provider_request_success', { latency_ms: this.health.latencyMs, freshness: result.freshness || null, data_type: result.dataType || null });
      } else {
        this.recordFailure(result?.reasonCode || `${this.provider.toUpperCase()}_PROVIDER_FAILURE`);
      }
      return result;
    } catch (error) {
      const reasonCode = error?.name === 'AbortError' ? `${this.provider.toUpperCase()}_TIMEOUT` : `${this.provider.toUpperCase()}_PROVIDER_FAILURE`;
      return this.failure(reasonCode);
    }
  }

  failure(reasonCode, options = {}) {
    if (options.countFailure === false) {
      this.health.lastFailure = this.nowIso();
      this.health.lastReasonCode = reasonCode;
    } else {
      this.recordFailure(reasonCode);
    }
    return { ok: false, provider: this.provider, reasonCode, cached: false };
  }

  recordFailure(reasonCode) {
    const normalized = String(reasonCode || `${this.provider.toUpperCase()}_PROVIDER_FAILURE`);
    this.health.lastFailure = this.nowIso();
    this.health.lastReasonCode = normalized;
    this.health.status = 'degraded';
    this.health.consecutiveFailures += 1;
    if (/AUTH_FAILED|KEY_MISSING|USER_AGENT_MISSING/.test(normalized)) this.health.authenticationStatus = /MISSING/.test(normalized) ? 'missing' : 'failed';
    if (/ENTITLEMENT/.test(normalized)) this.health.entitlementClassification = 'unavailable';
    if (/STALE|DELAYED|EOD|UNKNOWN/.test(normalized)) this.health.freshnessClassification = normalized.includes('STALE') ? 'stale' : normalized.includes('EOD') ? 'end_of_day' : normalized.includes('DELAYED') ? 'delayed' : 'unknown';
    if (/RATE_LIMITED|COOLDOWN|DAILY_RESERVE|DAILY_BUDGET|QUOTA/.test(normalized)) {
      this.health.cooldownUntil = new Date(this.nowMs() + this.cooldownMs).toISOString();
    }
    if (this.health.consecutiveFailures >= this.circuitFailureThreshold && !/AUTH_FAILED|KEY_MISSING|USER_AGENT_MISSING/.test(normalized)) {
      this.health.circuitState = 'open';
      this.health.cooldownUntil = new Date(this.nowMs() + this.cooldownMs).toISOString();
    }
    this.log('warn', 'provider_request_failure', { reason_code: normalized, consecutive_failures: this.health.consecutiveFailures, circuit_state: this.health.circuitState, cooldown_until: this.health.cooldownUntil });
  }

  snapshot(extra = {}) {
    this.resetDailyIfNeeded();
    return {
      ...this.health, source: this.provider, ...extra,
      requestsInWindow: this.requests.filter((at) => this.nowMs() - at < this.windowMs).length,
      estimatedDailyUsage: this.daily.used,
      estimatedRemainingAllowance: this.dailyMax === null ? null : Math.max(0, this.dailyMax - this.daily.used),
      reserve: this.dailyReserve,
      lastResponseAge: this.health.lastResponseTimestamp
        ? Math.max(0, (this.nowMs() - new Date(this.health.lastResponseTimestamp).getTime()) / 1000)
        : null,
    };
  }

  resetDailyIfNeeded() {
    const day = this.nowIso().slice(0, 10);
    if (this.daily.day !== day) {
      this.daily = { day, used: 0 };
      this.persistDaily();
    }
  }

  loadDaily() {
    try {
      const value = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return value && typeof value === 'object' ? value : { day: this.nowIso().slice(0, 10), used: 0 };
    } catch {
      return { day: this.nowIso().slice(0, 10), used: 0 };
    }
  }

  persistDaily() {
    if (!this.statePath) return;
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.daily, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.statePath);
  }

  nowMs() { return new Date(this.clock()).getTime(); }

  nowIso() { return new Date(this.clock()).toISOString(); }

  log(level, event, fields = {}) {
    if (!this.logger) return;
    this.logger({ level, event, provider: this.provider, timestamp: this.nowIso(), ...fields });
  }
}

module.exports = { ProviderRuntime };
