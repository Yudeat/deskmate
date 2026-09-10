'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function memoryPath(p) {
  if (!p) return path.join(os.homedir(), '.deskmate', 'memory.jsonl');
  return p.includes('~') ? path.join(os.homedir(), p.replace(/^~\/?/, '')) : p;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// Best-effort: never throws. Memory is a convenience, not a dependency.
async function append(p, entry) {
  try {
    const file = memoryPath(p);
    ensureDir(file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    await fs.promises.appendFile(file, line, { flag: 'a' });
  } catch (e) {
    console.error('memory append failed:', e.message);
  }
}

async function tail(p, n) {
  try {
    const file = memoryPath(p);
    if (!fs.existsSync(file)) return [];
    const raw = await fs.promises.readFile(file, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    console.error('memory tail failed:', e.message);
    return [];
  }
}

module.exports = { append, tail, memoryPath };