class TradingError extends Error {
  constructor(message, { reasonCodes = [], stage = null, symbol = null, data = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.reasonCodes = Array.isArray(reasonCodes) ? reasonCodes : [reasonCodes].filter(Boolean);
    this.stage = stage;
    this.symbol = symbol;
    this.data = data;
  }
}

class ConfigError extends TradingError {
  constructor(message, opts = {}) {
    super(message, { ...opts, stage: opts.stage || 'config' });
  }
}

class BrokerError extends TradingError {
  constructor(message, opts = {}) {
    super(message, { ...opts, stage: opts.stage || 'broker' });
  }
}

class RiskGateError extends TradingError {
  constructor(message, opts = {}) {
    super(message, { ...opts, stage: opts.stage || 'risk' });
  }
}

class ScannerError extends TradingError {
  constructor(message, opts = {}) {
    super(message, { ...opts, stage: opts.stage || 'scanner' });
  }
}

module.exports = {
  TradingError,
  ConfigError,
  BrokerError,
  RiskGateError,
  ScannerError,
};
