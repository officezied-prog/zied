// v61 (owner 2026-10-18: «ابدأ المرحلة الثانية: إرسال الواتساب تلقائيًا») — the official WhatsApp Cloud API (Meta), for Khair Order
// Brad. Reliability first: an unofficial gateway can get the number banned and stop everything; this is Meta's own API, with
// no monthly wall of ours — and when it is not set up, over the monthly cap, or refused, the app sends by hand (wa.me) as in
// stage 1. Secrets (set by the owner in the Cloudflare dashboard, never in the repo or the apps):
//   WA_TOKEN        a permanent System User token (whatsapp_business_messaging + whatsapp_business_management)
//   WA_PHONE_ID     the business number's Phone Number ID
//   WA_WABA_ID      the WhatsApp Business Account ID (templates)
//   WA_APP_SECRET   the Meta app's secret: every webhook POST is signed with it (X-Hub-Signature-256)
//   WA_VERIFY_TOKEN any long random text, typed again in Meta's webhook settings (the GET handshake)
//   WA_GRAPH_VERSION optional, e.g. v24.0
export const GRAPH = 'https://graph.facebook.com';
export function graphVersion(env) { return /^v\d{2}\.\d$/.test(String((env && env.WA_GRAPH_VERSION) || '')) ? env.WA_GRAPH_VERSION : 'v24.0'; }
export function waReady(env) { return !!(env && env.WA_TOKEN && env.WA_PHONE_ID); }

/** One template message: { kind, to, template, lang, params[], payloads[] } → { ok, wamid } or { ok:false, error }. */
export async function sendTemplate(env, m, fetchImpl = fetch) {
  const components = [];
  if (m.params && m.params.length) components.push({ type: 'body', parameters: m.params.map((t) => ({ type: 'text', text: String(t) })) });
  (m.payloads || []).forEach((p, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: String(p) }] }));
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to: String(m.to), type: 'template', template: { name: m.template, language: { code: m.lang || 'id' }, components } };
  const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetchImpl(`${GRAPH}/${graphVersion(env)}/${encodeURIComponent(env.WA_PHONE_ID)}/messages`, {
      method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.WA_TOKEN }, body: JSON.stringify(body),
    });
    const js = await r.json().catch(() => ({}));
    const id = js && js.messages && js.messages[0] && js.messages[0].id;
    if (r.ok && id) return { ok: true, wamid: String(id) };
    const e = (js && js.error) || {};
    return { ok: false, error: ('WA ' + r.status + (e.code ? ' #' + e.code : '') + (e.message ? ': ' + e.message : '')).replace(/[<>\u0000-\u001F]/g, ' ').slice(0, 160) };
  } catch (e) {
    return { ok: false, error: 'WA ' + String((e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || e).slice(0, 80) };
  } finally { clearTimeout(tm); }
}

/** Register the app's templates (owner's button; Meta reviews them, usually within a day). Existing names are skipped. */
export async function createTemplates(env, defs, fetchImpl = fetch) {
  if (!env || !env.WA_TOKEN || !env.WA_WABA_ID) return { ok: false, error: 'WA_OFF' };
  const have = await listTemplates(env, fetchImpl), names = new Set(((have && have.templates) || []).map((t) => t.name + '|' + t.language));
  const out = [];
  for (const d of defs) {
    if (names.has(d.name + '|' + d.language)) { out.push({ name: d.name, status: 'EXISTS' }); continue; }
    const r = await fetchImpl(`${GRAPH}/${graphVersion(env)}/${encodeURIComponent(env.WA_WABA_ID)}/message_templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.WA_TOKEN }, body: JSON.stringify(d),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: { message: String(e && e.message || e) } }) }));
    const js = await r.json().catch(() => ({}));
    out.push(r.ok ? { name: d.name, status: String(js.status || 'PENDING') } : { name: d.name, status: 'ERROR', error: String((js.error && js.error.message) || r.status).slice(0, 160) });
  }
  return { ok: true, templates: out };
}
/** The account's templates and their review status (APPROVED / PENDING / REJECTED / PAUSED / DISABLED). */
export async function listTemplates(env, fetchImpl = fetch) {
  if (!env || !env.WA_TOKEN || !env.WA_WABA_ID) return { ok: false, error: 'WA_OFF', templates: [] };
  try {
    const r = await fetchImpl(`${GRAPH}/${graphVersion(env)}/${encodeURIComponent(env.WA_WABA_ID)}/message_templates?fields=name,status,language,category&limit=100`, { headers: { Authorization: 'Bearer ' + env.WA_TOKEN } });
    const js = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: String((js.error && js.error.message) || r.status).slice(0, 160), templates: [] };
    return { ok: true, templates: (js.data || []).map((t) => ({ name: String(t.name), status: String(t.status), language: String(t.language || ''), category: String(t.category || '') })) };
  } catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 80), templates: [] }; }
}

/** X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256(app secret, the raw body), compared in constant time. */
export async function signatureOk(secret, raw, header) {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ''));
  if (!secret || !m) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const want = m[1].toLowerCase(), got = Array.from(mac).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
  let diff = 0; for (let i = 0; i < 64; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// The month's sends, in pos_api_usage (api 'wa_send', month YYYY-MM, Jakarta time) — the same table as the Google meter.
let usageReady = false;
async function ensureUsage(adapter) {
  if (usageReady) return;
  try { await adapter.run('CREATE TABLE IF NOT EXISTS pos_api_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, api TEXT, month TEXT, n INTEGER NOT NULL DEFAULT 0, updated_at TEXT)', []); } catch (e) { /* exists */ }
  usageReady = true;
}
export const waMonth = (now = new Date()) => new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 7);
export async function waCount(adapter, now = new Date()) {
  await ensureUsage(adapter);
  const rows = await adapter.all("SELECT n FROM pos_api_usage WHERE api = 'wa_send' AND month = ?", [waMonth(now)]);
  return rows && rows[0] ? Number(rows[0].n) || 0 : 0;
}
export async function waAddCount(adapter, n, now = new Date()) {
  await ensureUsage(adapter);
  const at = now.toISOString(), month = waMonth(now);
  const u = await adapter.run("UPDATE pos_api_usage SET n = n + ?, updated_at = ? WHERE api = 'wa_send' AND month = ?", [n, at, month]);
  if (!(u && (u.changes > 0 || (u.meta && u.meta.changes > 0)))) await adapter.run("INSERT INTO pos_api_usage (api, month, n, updated_at) VALUES ('wa_send', ?, ?, ?)", [month, n, at]);
}
