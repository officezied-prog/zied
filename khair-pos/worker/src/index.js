// Cloudflare Worker entry for the Khair POS API. Replaces the n8n production webhook
// (POST .../webhook/khair-pos). No monthly execution cap — this is the reliability win.
//   env.DB        : D1 database binding (see wrangler.toml)
//   env.STORE_KEY : store key secret (wrangler secret put STORE_KEY) — never committed
import { handleRequest } from './core.js';
import { handleField } from './field.js';
import { handleChat } from './chat.js';
import { handleAtt } from './attendance.js';
import { handlePhoto, handlePhotoFile } from './photo.js';
import { handleCold } from './cold.js';

const CORS = {
  'Access-Control-Allow-Origin': '*', // store-key auth, no cookies → safe
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // v36: the stored-photo GET sends the usual credentials as headers (never in the URL).
  'Access-Control-Allow-Headers': 'Content-Type, X-Khair-Key, X-Khair-User, X-Khair-Pin',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

// D1 adapter matching the db.js contract (all/run). D1 bind takes primitives only — db.js
// already coerces booleans to 0/1.
// v38: `use` counts the rows this request read / wrote, from D1's own meta (rows_read / rows_written).
function d1Adapter(DB) {
  const use = { read: 0, write: 0 };
  return {
    use,
    async all(sql, params) {
      const r = await DB.prepare(sql).bind(...params).all();
      const m = r.meta || {};
      use.read += Number(m.rows_read) || (r.results || []).length; use.write += Number(m.rows_written) || 0;
      return r.results || [];
    },
    async run(sql, params) {
      const r = await DB.prepare(sql).bind(...params).run();
      const meta = r.meta || {};
      use.read += Number(meta.rows_read) || 0; use.write += Number(meta.rows_written) || Number(meta.changes) || 0;
      return { lastInsertRowid: meta.last_row_id, changes: meta.changes };
    },
    // v39: many statements in ONE D1 call (and one transaction). [{ sql, params, kind: 'all' | 'run' }] → per statement:
    // the rows ('all') or { lastInsertRowid, changes } ('run'), in order.
    async batch(list) {
      const res = await DB.batch(list.map((q) => DB.prepare(q.sql).bind(...(q.params || []))));
      return res.map((r, i) => {
        const m = (r && r.meta) || {};
        use.read += Number(m.rows_read) || (list[i].kind === 'all' ? ((r && r.results) || []).length : 0);
        use.write += Number(m.rows_written) || (list[i].kind === 'run' ? Number(m.changes) || 0 : 0);
        return list[i].kind === 'all' ? ((r && r.results) || []) : { lastInsertRowid: m.last_row_id, changes: m.changes };
      });
    },
  };
}

// v39: GET …/health/batch — 60 trivial SELECTs in ONE batch. On the free plan (50 D1 queries per request) this answers
// ok only if a batch counts as one query; the deploy smoke test prints it. No data, no auth needed.
async function batchHealth(DB) {
  const t = Date.now();
  try {
    const res = await DB.batch(Array.from({ length: 60 }, (_, i) => DB.prepare('SELECT ? AS n').bind(i)));
    return { ok: res.length === 60, batch: res.length, ms: Date.now() - t };
  } catch (e) { return { ok: false, batch: 60, error: String((e && e.message) || e).slice(0, 200) }; }
}

// v38 (owner 2026-10-12: "we start free, and pay the $5 only when the work needs it"): the D1 rows read / written today,
// kept in pos_api_usage (api 'd1_read' / 'd1_write', month = the UTC day, because the free limits — 5,000,000 reads and
// 100,000 writes a day — reset at 00:00 UTC). Written after the answer has gone out (ctx.waitUntil), never in its way;
// the owner app shows it and warns long before the limit. A failure here never touches the request.
let usageTableEnsured = false;
export async function recordUsage(DB, use, now = new Date()) {
  const day = now.toISOString().slice(0, 10), at = now.toISOString();
  const add = async (api, n) => {
    const u = await DB.prepare('UPDATE pos_api_usage SET n = n + ?, updated_at = ? WHERE api = ? AND month = ?').bind(n, at, api, day).run();
    if (!(u && u.meta && u.meta.changes > 0)) await DB.prepare('INSERT INTO pos_api_usage (api, month, n, updated_at) VALUES (?, ?, ?, ?)').bind(api, day, n, at).run();
  };
  try {
    if (!usageTableEnsured) {
      await DB.prepare('CREATE TABLE IF NOT EXISTS pos_api_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, api TEXT, month TEXT, n INTEGER NOT NULL DEFAULT 0, updated_at TEXT)').bind().run();
      usageTableEnsured = true;
    }
    if (use.read > 0) await add('d1_read', use.read);
    if (use.write > 0) await add('d1_write', use.write);
  } catch (e) { /* a lost count is better than a failed request */ }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    // v36 (owner 2026-10-08: "فعّل حفظ الصور عبر Google Drive"): GET .../khair-pos-photo/file/<photo_id> streams a photo
    // kept in R2 — owner / manager / accountant only (src/photo.js handlePhotoFile).
    const fileMatch = request.method === 'GET' && /\/khair-pos-photo\/file\/([^/]+)$/.exec(url.pathname);
    if (fileMatch) {
      if (!env || !env.DB || !env.STORE_KEY) return json({ ok: false, error: 'SERVER', message: 'Backend not configured' }, 500);
      const headers = {};
      request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      try {
        let id = '';
        try { id = decodeURIComponent(fileMatch[1]); } catch (e) { id = ''; }
        const r = await handlePhotoFile(d1Adapter(env.DB), id, headers, env.STORE_KEY, env);
        if (!r.object) return json(r.json, r.status);
        const obj = r.object;
        return new Response(obj.body, {
          status: 200,
          headers: {
            'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg',
            // A photo never changes once stored: cache it for a year, privately (per device), and only for these credentials.
            'Cache-Control': 'private, max-age=31536000, immutable',
            Vary: 'X-Khair-Key, X-Khair-User, X-Khair-Pin',
            ...(obj.httpEtag ? { ETag: obj.httpEtag } : {}),
            ...(obj.size !== undefined ? { 'Content-Length': String(obj.size) } : {}),
            'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': 'inline',
            ...CORS,
          },
        });
      } catch (e) {
        return json({ ok: false, error: 'SERVER', message: 'Server error' }, 500);
      }
    }
    if (request.method === 'GET' && /\/health\/batch$/.test(url.pathname)) {
      if (!env || !env.DB) return json({ ok: false, error: 'SERVER' }, 500);
      return json(await batchHealth(env.DB), 200);
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'METHOD', message: 'POST only' }, 405);
    }
    if (!env || !env.DB || !env.STORE_KEY) {
      return json({ ok: false, error: 'SERVER', message: 'Backend not configured' }, 500);
    }
    // Read as text and let parseRequest handle JSON/text, exactly as the n8n node did.
    const text = await request.text();
    const headers = {};
    request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    // Route by path. khair-pos-photo → Photo (needs env for the AI key), khair-field →
    // Field, khair-chat → Chat, khair-att → Attendance, everything else → POS API.
    const path = url.pathname;
    const adapter = d1Adapter(env.DB);
    try {
      let response;
      if (path.endsWith('khair-pos-photo')) {
        // v36: the base of the stored-photo links (…/webhook/khair-pos-photo) on this Worker's own host.
        response = await handlePhoto(adapter, text, headers, env.STORE_KEY, env, { base: url.origin + path });
      } else {
        const handler = path.endsWith('khair-field') ? handleField
          : path.endsWith('khair-chat') ? handleChat
            : path.endsWith('khair-att') ? handleAtt
              : path.endsWith('khair-cold') ? handleCold
                : handleRequest;
        response = await handler(adapter, text, headers, env.STORE_KEY, { env }); // env: the Google Places key (field search), when set
        // v50: the apps show whether the photo reader (AI) is on — the owner sees at once that ANTHROPIC_API_KEY is missing
        if (handler === handleRequest && response && response.ok === true && response.user && response.server_time) response.ai_reader = !!env.ANTHROPIC_API_KEY;
      }
      const counted = recordUsage(env.DB, adapter.use);
      if (ctx && ctx.waitUntil) ctx.waitUntil(counted); else await counted; // tests (no ctx) wait for it
      return json(response, 200); // business errors (ok:false) are 200, as n8n returned them
    } catch (e) {
      // Only true server faults reach here. Keep the message generic (the apps map it to
      // "مشكلة في الخادم. حاول بعد قليل.").
      return json({ ok: false, error: 'SERVER', message: 'Server error' }, 500);
    }
  },
};
