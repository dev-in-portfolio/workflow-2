const fs = require('fs');

const DEFAULT_MAX_SCAN_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_COMPLETE_RECORDS = 8;

function readCompleteJsonlTail(filePath, initialBytes = 512 * 1024, options = {}) {
  const minimumRecords = Math.max(1, Number(options.minimumRecords) || DEFAULT_MIN_COMPLETE_RECORDS);
  const maximumBytes = Math.max(initialBytes, Number(options.maximumBytes) || DEFAULT_MAX_SCAN_BYTES);
  const matches = typeof options.matches === 'function' ? options.matches : () => true;

  try {
    const stat = fs.statSync(filePath);
    let bytesToRead = Math.min(stat.size, Math.max(1, Number(initialBytes) || 1));
    let records = [];

    while (bytesToRead > 0) {
      const start = Math.max(0, stat.size - bytesToRead);
      const buffer = Buffer.alloc(stat.size - start);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buffer, 0, buffer.length, start);
      } finally {
        fs.closeSync(fd);
      }

      const lines = buffer.toString('utf8').split(/\r?\n/);
      if (start > 0) lines.shift();
      records = lines
        .filter(Boolean)
        .map(parseJsonLine)
        .filter(Boolean);

      if (records.filter(matches).length >= minimumRecords || start === 0 || bytesToRead >= maximumBytes) break;
      bytesToRead = Math.min(stat.size, maximumBytes, bytesToRead * 2);
    }

    if (options.includeArchives && records.filter(matches).length < minimumRecords) {
      const archiveRecords = readNewestArchives(filePath, initialBytes, {
        ...options,
        includeArchives: false,
        minimumRecords: minimumRecords - records.filter(matches).length,
      });
      return [...archiveRecords, ...records];
    }
    return records;
  } catch {
    return [];
  }
}

function readNewestArchives(filePath, initialBytes, options) {
  const path = require('path');
  try {
    const directory = path.dirname(filePath);
    const parsed = path.parse(filePath);
    return fs.readdirSync(directory)
      .filter((name) => name.startsWith(`${parsed.name}.`) && name.includes('.archive'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(1, Number(options.maxArchives) || 1))
      .flatMap(({ name }) => readCompleteJsonlTail(path.join(directory, name), initialBytes, options));
  } catch {
    return [];
  }
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = { readCompleteJsonlTail };
