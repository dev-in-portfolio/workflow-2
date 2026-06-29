const fs = require('fs');
const path = require('path');

class JsonFileStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  resolve(name) {
    if (path.isAbsolute(name)) return name;
    return path.join(this.root, name);
  }

  read(name) {
    const filePath = this.resolve(name);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  }

  readLines(name) {
    const filePath = this.resolve(name);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return [];
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  readTailLines(name, maxBytes = 512 * 1024) {
    const filePath = this.resolve(name);
    if (!fs.existsSync(filePath)) return [];
    const stats = fs.statSync(filePath);
    if (stats.size === 0) return [];
    const readSize = Math.min(maxBytes, stats.size);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);
    const tail = buffer.toString('utf8').split('\n').filter(Boolean);
    return tail.map((line) => JSON.parse(line));
  }

  write(name, data) {
    const filePath = this.resolve(name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return data;
  }

  append(name, line) {
    const filePath = this.resolve(name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(line)}\n`, 'utf8');
    return line;
  }

  exists(name) {
    return fs.existsSync(this.resolve(name));
  }
}

module.exports = { JsonFileStore };
