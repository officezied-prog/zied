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
  const ad = {
    calls: 0, // D1 calls this adapter made (a batch is one call, as on D1)
    all(sql, params) { ad.calls++; return db.prepare(sql).all(...(params || [])); },
    run(sql, params) {
      ad.calls++;
      const r = db.prepare(sql).run(...(params || []));
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
    },
    // like D1's batch: one call, one transaction (all or nothing), results in order
    batch(list) {
      ad.calls++;
      db.exec('BEGIN');
      try {
        const out = list.map((q) => {
          if (q.kind === 'all') return db.prepare(q.sql).all(...(q.params || []));
          const r = db.prepare(q.sql).run(...(q.params || []));
          return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes };
        });
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  return ad;
}

// A Cloudflare-D1-shaped binding over node:sqlite: prepare(sql).bind(...p).all()/.run(),
// matching the shape src/index.js's d1Adapter expects. Lets the real Worker fetch handler be
// tested end-to-end (routing, CORS, error handling) against a real in-memory SQLite.
export function d1Mock(db, opts = {}) {
  const B = {
    calls: 0, // D1 calls per the free-plan rule (a batch is one); opts.maxCalls makes the 51st call fail like D1 Free
    _count() { B.calls++; if (opts.maxCalls && B.calls > opts.maxCalls) throw new Error('Too many API requests by single worker invocation.'); },
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...params) {
          return {
            sql,
            async all() { B._count(); return { results: stmt.all(...params), meta: {} }; },
            async run() { B._count(); const r = stmt.run(...params); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
            _exec() { // inside a batch (no own call)
              if (/^\s*(select|with|pragma)\b/i.test(sql)) return { results: stmt.all(...params), meta: {} };
              const r = stmt.run(...params); return { results: [], meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
            },
          };
        },
      };
    },
    async batch(list) {
      B._count();
      db.exec('BEGIN');
      try { const out = list.map((b) => b._exec()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  return B;
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

// v36: an R2-bucket-shaped binding (put/get) kept in memory, for the stored-photo tests (env.PHOTOS).
export function r2Mock({ failPut = false } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, value, opts = {}) {
      if (failPut) throw new Error('R2 unavailable');
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { bytes, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} });
      return { key, size: bytes.length };
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { key, body: o.bytes, size: o.bytes.length, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, httpEtag: '"etag-' + o.bytes.length + '"' };
    },
  };
}
