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
function d1Adapter(DB) {
  return {
    async all(sql, params) {
      const r = await DB.prepare(sql).bind(...params).all();
      return r.results || [];
    },
    async run(sql, params) {
      const r = await DB.prepare(sql).bind(...params).run();
      const meta = r.meta || {};
      return { lastInsertRowid: meta.last_row_id, changes: meta.changes };
    },
  };
}

export default {
  async fetch(request, env) {
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
      }
      return json(response, 200); // business errors (ok:false) are 200, as n8n returned them
    } catch (e) {
      // Only true server faults reach here. Keep the message generic (the apps map it to
      // "مشكلة في الخادم. حاول بعد قليل.").
      return json({ ok: false, error: 'SERVER', message: 'Server error' }, 500);
    }
  },
};
