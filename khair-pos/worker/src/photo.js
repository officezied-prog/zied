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
// gains automatic reading the moment the owner adds a key. Google Drive upload is skipped
// (drive_url stays empty, same as the current unconnected n8n state).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { runPhotoAuth } from './generated/photo-auth.gen.js';
import { runPhotoMatch } from './generated/photo-match.gen.js';

const AI_MODEL = 'claude-sonnet-5'; // same model id the n8n "Read Photo AI" node used
const AI_MAX_TOKENS = 3000;

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
    return await r.json();
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

export async function handlePhoto(adapter, body, headers, STORE_KEY, env) {
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

  await applyOps(adapter, { photos: [{ ...m.photo, _id: -1 }] }, { photos: 'pos_photos' });
  if (m.has_sale_update && m.sale_update) {
    await applyOps(adapter, { sales: [{ _id: m.sale_update.id, exit_photo: m.sale_update.exit_photo, exit_match: m.sale_update.exit_match }] }, { sales: 'pos_sales' });
  }
  return m.response;
}
