const fs = require('fs');
const crypto = require('crypto');
const { hashObject, nowIso } = require('./util');

class InMemoryAuditStore {
  constructor() {
    this.events = [];
  }

  writeEvent(event) {
    const record = normalizeAuditEvent(event);
    this.events.push(record);
    return record;
  }

  findByEntity(entityId) {
    return this.events.filter((event) => event.related_entity_id === entityId);
  }

  findByType(eventType) {
    return this.events.filter((event) => event.event_type === eventType);
  }
}

class JsonlAuditWriter {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(require('path').dirname(filePath), { recursive: true });
  }

  writeEvent(event) {
    const record = normalizeAuditEvent(event);
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }
}

function normalizeAuditEvent(event) {
  const payload = event.payload ?? {};
  return {
    event_id: event.event_id || crypto.randomUUID(),
    event_type: event.event_type,
    related_entity_id: event.related_entity_id || null,
    payload,
    payload_hash: event.payload_hash || hashObject(payload),
    created_at: event.created_at || nowIso(),
    source: event.source || 'system',
    version: event.version || '2026-06-14.paper-first.1',
    severity: event.severity || 'info',
    trace_id: event.trace_id || crypto.randomUUID(),
  };
}

module.exports = {
  InMemoryAuditStore,
  JsonlAuditWriter,
  normalizeAuditEvent,
};
