// v80 (owner 2026-11-24: «أريده منك عندما أقول لك أرسل هذا على تطبيق إلى المدير، ترسله مباشرة من هنا وتضعه في التطبيق ويصل إلى المدير»):
// the owner's Claude assistant writes into the app's chat as "Asisten Khair" — to one person's private room ('as:<uid>', see
// backend/chat/chat-core.js) or to Umum — and reads the replies. No account and no PIN: one key the owner makes in the chat panel
// (Obrolan → Tim → "Asisten Claude"), shown to him once; only its SHA-256 is kept (setting `assistant_key_hash`). "Matikan" clears
// it and the key stops at once. POST /webhook/khair-assistant, header `Authorization: Bearer <key>`, body {action, data}:
//   as_team                      → the active accounts (name, role)
//   as_send {to, body, cid?}     → to = a name, or 'general' (Umum); at most 300 a day
//   as_read {after?}             → the messages of the assistant's rooms + Umum after that time (default: 3 days)
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_CHAT } from '../tables.js';
import { runProcessChat } from './generated/process-chat.gen.js';
import { ensureChatSchema } from './chat.js';
import { safeEqual } from './authgate.js';

export const ASSISTANT_KEY_ACTIONS = ['assistant_key_status', 'assistant_key_new', 'assistant_key_off'];
const SKEY = 'assistant_key_hash', SKEY_AT = 'assistant_key_at';
const ASSIST_ACTIONS = ['as_team', 'as_send', 'as_read'];
const str = (v) => (v === undefined || v === null ? '' : String(v));

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function newKey() {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return 'kma_' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function settingRow(adapter, skey) {
  return (await adapter.all('SELECT id, skey, svalue FROM pos_settings WHERE skey = ?', [skey]))[0] || null;
}
async function writeSettings(adapter, pairs) {
  const rows = [];
  for (const [skey, svalue] of pairs) {
    const old = await settingRow(adapter, skey);
    rows.push(old ? { skey, svalue, _id: old.id } : { skey, svalue });
  }
  await applyOps(adapter, { settings: rows }, OPS_TABLE_CHAT);
}

/** The owner's key actions (chat route; the auth gate already checked the store key and the PIN). */
export async function assistantKeyAction(adapter, req) {
  const me = (await adapter.all('SELECT name, role, active FROM pos_users WHERE lower(name) = ?', [str(req.user).trim().toLowerCase()]))[0];
  if (!me || str(me.role) !== 'owner') return { ok: false, error: 'FORBIDDEN', message: 'Hanya pemilik' };
  if (req.action === 'assistant_key_new') {
    const key = newKey(), at = new Date().toISOString();
    await writeSettings(adapter, [[SKEY, await sha256hex(key)], [SKEY_AT, at]]);
    return { ok: true, on: true, key, at }; // shown once; never stored in clear
  }
  if (req.action === 'assistant_key_off') {
    await writeSettings(adapter, [[SKEY, ''], [SKEY_AT, '']]);
    return { ok: true, on: false };
  }
  const h = await settingRow(adapter, SKEY), at = await settingRow(adapter, SKEY_AT);
  return { ok: true, on: !!(h && /^[a-f0-9]{64}$/.test(str(h.svalue))), at: at ? str(at.svalue) : '' };
}

/** POST /webhook/khair-assistant — refused before any table but pos_settings is read. */
export async function handleAssistant(adapter, text, headers) {
  const auth = str(headers.authorization), m = /^Bearer\s+(kma_[A-Za-z0-9_-]{20,100})$/.exec(auth.trim());
  if (!m) return { ok: false, error: 'BAD_KEY', message: 'Kunci asisten salah' };
  const row = await settingRow(adapter, SKEY), want = row ? str(row.svalue) : '';
  if (!/^[a-f0-9]{64}$/.test(want) || !safeEqual(await sha256hex(m[1]), want)) return { ok: false, error: 'BAD_KEY', message: 'Kunci asisten salah' };
  let body = {}; try { body = JSON.parse(text); } catch (e) { body = {}; }
  if (!body || typeof body !== 'object') body = {};
  const action = str(body.action).slice(0, 40);
  if (!ASSIST_ACTIONS.includes(action)) return { ok: false, error: 'UNKNOWN', message: 'Aksi tidak dikenal: ' + action };
  adapter.req = { route: 'chat', action }; // the quota guard treats it like the chat (src/tablecache.js)
  await ensureChatSchema(adapter);
  const nodes = await execSpecs(adapter, { 'Get Users': Q.all('pos_users'), 'Get Settings': Q.all('pos_settings'), 'Get Chat': Q.all('pos_chat') });
  // the system flag rides only on this route; the public chat parser never copies it
  nodes['Parse Chat'] = [{ action, key: '', user: '', pin_hash: '', data: body.data && typeof body.data === 'object' ? body.data : {}, __sys: 'assistant' }];
  const out = runProcessChat(makeAccessor(nodes), '')[0].json;
  await applyOps(adapter, out.ops || {}, OPS_TABLE_CHAT);
  return out.response;
}
