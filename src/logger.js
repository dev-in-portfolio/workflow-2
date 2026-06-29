const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function createLogger(level = 'info') {
  const minLevel = LEVELS[level] ?? LEVELS.info;

  function write(lvl, event, message, extra = {}) {
    if (LEVELS[lvl] < minLevel) return;
    const entry = { level: lvl, event, message, timestamp: new Date().toISOString(), ...extra };
    const line = JSON.stringify(entry);
    (lvl === 'error' ? process.stderr : process.stdout).write(line + '\n');
  }

  const logger = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    write(entry.level || 'info', entry.event || 'unknown', entry.message || '', entry);
  };

  logger.debug = (event, message, extra) => write('debug', event, message, extra);
  logger.info = (event, message, extra) => write('info', event, message, extra);
  logger.warn = (event, message, extra) => write('warn', event, message, extra);
  logger.error = (event, message, extra) => write('error', event, message, extra);
  logger.log = (msg) => {
    if (typeof msg === 'string') {
      write('info', 'log', msg);
    } else if (msg && typeof msg === 'object') {
      write(msg.level || 'info', msg.event || 'unknown', msg.message || '', msg);
    }
  };

  return logger;
}

module.exports = { createLogger };
