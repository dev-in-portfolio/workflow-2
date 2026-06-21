const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendOperatorTimelineEvent, readOperatorTimelineTail } = require('../src/operator-timeline');

test('operator timeline appends and reads local jsonl events', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-timeline-'));
  const filePath = path.join(tempDir, 'timeline.jsonl');
  appendOperatorTimelineEvent({
    timestamp: '2026-06-20T10:00:00.000Z',
    event_type: 'workflow.start',
    source: 'test',
    title: 'start workflow',
    message: 'Workflow started',
    severity: 'info',
  }, { filePath });
  appendOperatorTimelineEvent({
    timestamp: '2026-06-20T10:01:00.000Z',
    event_type: 'scanner.scan',
    source: 'test',
    title: 'scan',
    message: 'Posted 1',
    severity: 'info',
  }, { filePath });

  const events = readOperatorTimelineTail({ filePath, limit: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'scanner.scan');
  assert.equal(events[0].message, 'Posted 1');
});
