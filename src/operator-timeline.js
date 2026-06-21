const fs = require('fs');
const path = require('path');
const { nowIso } = require('./util');

function resolveOperatorTimelinePath(env = process.env, repoRoot = process.cwd()) {
  return path.resolve(env.OPERATOR_TIMELINE_PATH || path.join(repoRoot, 'data', 'logs', 'operator-timeline.jsonl'));
}

function appendOperatorTimelineEvent(event = {}, options = {}) {
  const filePath = options.filePath || resolveOperatorTimelinePath(options.env || process.env, options.repoRoot || process.cwd());
  const record = {
    timestamp: event.timestamp || event.at || nowIso(),
    event_type: event.event_type || event.type || 'operator_event',
    source: event.source || 'local',
    title: event.title || event.event_type || 'Operator event',
    message: event.message || '',
    severity: event.severity || 'info',
    details: event.details || {},
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  } catch {
    // Timeline is operator visibility only; never block process control.
  }
  return record;
}

function readOperatorTimelineTail({ filePath, env = process.env, repoRoot = process.cwd(), limit = 50 } = {}) {
  const resolvedPath = filePath || resolveOperatorTimelinePath(env, repoRoot);
  try {
    const lines = fs.readFileSync(resolvedPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Number(limit) || 50));
    return lines.map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

module.exports = {
  appendOperatorTimelineEvent,
  readOperatorTimelineTail,
  resolveOperatorTimelinePath,
};
