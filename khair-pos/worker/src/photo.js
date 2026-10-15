// Photo API — replaces the n8n "Khair Mart POS – Foto" workflow (POST .../khair-pos-photo).
// Reads supplier notes / exit receipts / payment slips with AI and matches them to products
// and recorded sale items.
//
// The pipeline mirrors n8n: Parse → load → Auth&Route (builds the prompt, or responds for
// list/errors) → AI image read → Match (parses AI, matches, builds the photo row) → save
// pos_photos (+ update pos_sales for an exit scan). The AI call is the only external piece:
// it goes directly to the Anthropic API when ANTHROPIC_API_KEY is set, and OTHERWISE (or on
// any failure) degrades to a saved photo with match_status 'perlu_cek' — exactly what the
// n8n workflow did when its AI node failed. So scanning works with no key (manual check) and
// gains automatic reading the moment the owner adds a key.
// v36 (owner 2026-10-08: "فعّل حفظ الصور عبر Google Drive") — the photo itself is now kept in Cloudflare R2 (binding
// PHOTOS) instead of Google Drive: same Worker, no extra login, separate from the POS database (photos can never fill D1
// and stop sales), free up to 10 GB. When the binding is absent (bucket not created yet) everything works as before
// (drive_url stays empty). The stored image is served only to owner / manager / accountant by handlePhotoFile (GET).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { runPhotoAuth } from './generated/photo-auth.gen.js';
import { runPhotoMatch } from './generated/photo-match.gen.js';

const AI_MODEL = 'claude-sonnet-5'; // same model id the n8n "Read Photo AI" node used
// v50 (owner 2026-10-15: «التطبيق لم يستطع قراءة ولا دراسة الفاتورة»): the model thinks before it answers, and that counts in
// max_tokens — 3000 could cut a long note's answer off (nothing read). Room for both; effort 'medium' keeps a note well inside
// the apps' 60-second wait (only the tokens used are paid).
const AI_MAX_TOKENS = 16000;
const AI_EFFORT = 'medium';

// Port of the live "Parse Photo" code node.
export function parsePhoto(body) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const action = String(body.action || '');
  let img = typeof data.image_base64 === 'string' ? data.image_base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '') : '';
  const tooBig = img.length > 8000000;
  if (tooBig) img = '';
  return {
    action,
    key: String(body.key || ''),
    user: String(body.user || ''),
    pin_hash: String(body.pin_hash || ''),
    img,
    too_big: tooBig,
    mime: /^image\/(jpeg|png|webp)$/.test(String(data.mime || '')) ? data.mime : 'image/jpeg',
    invoice_no: action === 'scan_exit' && data.invoice_no ? String(data.invoice_no) : '__none__',
    purchase_no: action === 'scan_supplier_return' && /^[A-Z0-9][A-Z0-9 /.-]{0,39}$/.test(String(data.purchase_no || '').trim().toUpperCase()) ? String(data.purchase_no).trim().toUpperCase() : '',
    from: action === 'list_photos' && isDate(data.from) ? data.from : '9999-12-31',
    to: action === 'list_photos' && isDate(data.to) ? data.to : '0000-01-01',
  };
}

export async function loadPhotoNodes(adapter, req) {
  const nodes = await execSpecs(adapter, {
    'Get Users': Q.all('pos_users'),
    'Get Products': Q.all('pos_products'),
    'Get Sale': Q.eq('pos_sales', 'invoice_no', req.invoice_no),
    'Get Sale Items': Q.eq('pos_sale_items', 'invoice_no', req.invoice_no),
    'Get Photos Range': Q.range('pos_photos', 'photo_date', req.from, req.to),
  });
  nodes['Parse Photo'] = [req];
  return nodes;
}

// Direct Anthropic image analysis. Returns an object Match understands: the API response
// ({content:[{type:'text',text}]}) on success, or {error} to trigger the graceful fallback.
async function callAI(env, auth) {
  const apiKey = env && env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'AI_DISABLED' }; // no key → manual check, same as n8n AI failure
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: AI_MAX_TOKENS,
        output_config: { effort: AI_EFFORT },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: auth.mime, data: auth.img } },
            { type: 'text', text: auth.prompt },
          ],
        }],
      }),
    });
    if (!r.ok) return { error: 'AI HTTP ' + r.status };
    const j = await r.json();
    if (j && j.stop_reason === 'max_tokens') return { error: 'AI_CUT_OFF' }; // the answer did not fit: say so, never half a list
    if (j && j.stop_reason === 'refusal') return { error: 'AI_REFUSED' };
    return j;
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

// ---- v36: keep the original image in R2 -------------------------------------------------------------------------
export const PHOTO_VIEW_ROLES = ['owner', 'manager', 'akuntan'];
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Stable object key: photos/YYYY-MM/<photo_id>.<ext> (one object per photo, never overwritten).
export function photoKey(photoId, photoDate, mime) {
  const ym = /^\d{4}-\d{2}/.test(String(photoDate || '')) ? String(photoDate).slice(0, 7) : 'undated';
  return 'photos/' + ym + '/' + photoId + '.' + (PHOTO_EXT[mime] || 'jpg');
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// Store the image as the app uploaded it (already compressed there). Never throws: a storage problem must not lose the
// scan itself — the photo row is saved either way, only without a link.
async function storeOriginal(env, photo, auth, base) {
  const bucket = env && env.PHOTOS;
  if (!bucket || typeof bucket.put !== 'function' || !auth.img) return null;
  try {
    const key = photoKey(photo.photo_id, photo.photo_date, auth.mime);
    await bucket.put(key, b64ToBytes(auth.img), {
      httpMetadata: { contentType: auth.mime || 'image/jpeg' },
      customMetadata: { photo_id: String(photo.photo_id), kind: String(photo.kind || ''), user: String(photo.user || ''), ref: String(photo.ref || '') },
    });
    return { key, url: String(base || '/webhook/khair-pos-photo').replace(/\/+$/, '') + '/file/' + encodeURIComponent(photo.photo_id) };
  } catch (e) {
    return null;
  }
}

export async function handlePhoto(adapter, body, headers, STORE_KEY, env, opts = {}) {
  const req = parsePhoto(body);
  const nodes = await loadPhotoNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const auth = runPhotoAuth($, STORE_KEY)[0].json;
  if (auth.mode === 'respond') return auth.response; // list_photos or an auth/validation error

  // scan: read the image with AI (optional), then Match (pure).
  const aiOut = await callAI(env, auth);
  nodes['Auth & Route'] = [auth];
  const $2 = makeAccessor(nodes);
  const $input = { first: () => ({ json: aiOut }) };
  const m = runPhotoMatch($2, $input)[0].json; // { photo, sale_update, has_sale_update, response }
  // v50: say WHY nothing was read — 'off' = no AI key in the Worker (the owner adds ANTHROPIC_API_KEY), 'error' = the AI call failed
  // (ai_error: HTTP status / cut off) — instead of an empty result nobody can explain.
  if (m.response && typeof m.response === 'object') {
    m.response.ai = !aiOut || !aiOut.error ? 'ok' : aiOut.error === 'AI_DISABLED' ? 'off' : 'error';
    if (aiOut && aiOut.error && aiOut.error !== 'AI_DISABLED') m.response.ai_error = String(aiOut.error).slice(0, 80);
  }
  const stored = await storeOriginal(env, m.photo, auth, opts.base); // v36: keep the image (R2), when the bucket is bound
  if (stored) {
    m.photo.drive_file_id = 'r2:' + stored.key;
    m.photo.drive_url = stored.url;
    m.response.drive_url = stored.url;
  }

  await applyOps(adapter, { photos: [{ ...m.photo, _id: -1 }] }, { photos: 'pos_photos' });
  if (m.has_sale_update && m.sale_update) {
    await applyOps(adapter, { sales: [{ _id: m.sale_update.id, exit_photo: m.sale_update.exit_photo, exit_match: m.sale_update.exit_match }] }, { sales: 'pos_sales' });
  }
  return m.response;
}

// ---- v36: GET <photo endpoint>/file/<photo_id> — the stored image, for owner / manager / accountant only -------------
// Same credentials as every other call (store key + user + PIN hash, or the owner's master code), sent as headers so they
// never appear in a URL: X-Khair-Key, X-Khair-User (URI-encoded), X-Khair-Pin. Returns { status, json } on an error, or
// { status: 200, object } with the R2 object to stream.
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
export async function handlePhotoFile(adapter, photoId, headers, STORE_KEY, env) {
  const fail = (status, error, message) => ({ status, json: { ok: false, error, message } });
  if (str(headers['x-khair-key']) !== STORE_KEY) return fail(401, 'BAD_KEY', 'Kunci toko salah');
  let user = '';
  try { user = decodeURIComponent(str(headers['x-khair-user'])); } catch (e) { user = ''; }
  const pin = str(headers['x-khair-pin']);
  if (!/^[A-Za-z0-9-]{3,40}$/.test(photoId)) return fail(400, 'INVALID', 'Foto tidak valid');
  const nodes = await execSpecs(adapter, { users: Q.all('pos_users'), photo: Q.eq('pos_photos', 'photo_id', photoId) });
  const users = nodes.users.filter((u) => u.active !== false);
  const me = users.find((u) => str(u.name).toLowerCase() === user.toLowerCase());
  if (!me || !user) return fail(401, 'BAD_PIN', 'Nama atau PIN salah');
  if (Date.parse(me.locked_until) > Date.now()) return fail(401, 'LOCKED', 'Akun dikunci sementara karena PIN salah berkali-kali');
  const viaMaster = /^[a-f0-9]{64}$/.test(pin) && users.some((u) => u.role === 'owner' && u.master_hash && u.master_hash === pin);
  if (me.pin_hash !== pin && !viaMaster) return fail(401, 'BAD_PIN', 'Nama atau PIN salah');
  if (me.must_change === true && !viaMaster) return fail(403, 'PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
  if (PHOTO_VIEW_ROLES.indexOf(me.role) < 0) return fail(403, 'FORBIDDEN', 'Hanya pemilik, manajer, atau akuntan');
  const row = nodes.photo.find((p) => p.photo_id === photoId);
  const fileId = row ? str(row.drive_file_id) : '';
  if (!row || fileId.indexOf('r2:') !== 0) return fail(404, 'NOT_FOUND', 'Foto tidak disimpan');
  const bucket = env && env.PHOTOS;
  if (!bucket || typeof bucket.get !== 'function') return fail(404, 'NOT_FOUND', 'Penyimpanan foto belum aktif');
  const object = await bucket.get(fileId.slice(3));
  if (!object) return fail(404, 'NOT_FOUND', 'Foto tidak ditemukan');
  return { status: 200, object };
}
