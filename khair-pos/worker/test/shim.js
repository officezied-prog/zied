// Local test shim: a D1-compatible adapter over Node's built-in node:sqlite (no native
// deps). Same all()/run() contract src/db.js and the Worker's D1 adapter use, so the exact
// code that will deploy runs here against a real in-memory SQLite.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BOOL_COLS } from '../tables.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(HERE, '..', 'schema.sql'), 'utf8'));
  return db;
}

export function sqliteAdapter(db) {
  return {
    all(sql, params) { return db.prepare(sql).all(...(params || [])); },
    run(sql, params) {
      const r = db.prepare(sql).run(...(params || []));
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
    },
  };
}

// Seed a row (explicit id allowed) with the same boolean→0/1 / object→JSON coercion the
// writer uses, so fixtures match what the live n8n data would look like in D1.
export function insert(db, table, row) {
  const cols = Object.keys(row);
  const bset = new Set(BOOL_COLS[table] || []);
  const vals = cols.map((c) => {
    let v = row[c];
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (bset.has(c) && (v === true || v === false)) return v ? 1 : 0;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
}
