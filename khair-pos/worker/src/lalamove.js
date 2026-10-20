// v63 (owner 2026-10-20: «ابدأ المرحلة الثالثة: طلب سيارة لالاموف تلقائيًا») — Lalamove's official Partner API v3, for Khair Order Brad:
// the car is priced, booked, followed and cancelled by the server. Reliability first: Lalamove's own API (the interface of its
// SDK @lalamove/lalamove-js 1.1.0), signed with our key; when it is not set up, refuses, is over the month's cap or does not
// answer, the app keeps the manual ways of stage 1 (Lalamove's app, our own driver, the customer's car) — nothing stops.
// Secrets (set by the owner in the Cloudflare dashboard, never in the repo or the apps):
//   LALAMOVE_KEY     the API key of the Lalamove Partner portal (the sandbox key first, then the production key)
//   LALAMOVE_SECRET  its secret
// Plain variables, optional (also in the dashboard — NOT in wrangler.toml, where every deploy would put its value back):
//   LALAMOVE_ENV     'sandbox' (default) or 'production' (live: real cars, paid from the Lalamove wallet)
//   LALAMOVE_MARKET  'ID' (default)
//   LALAMOVE_CITY    the city whose vehicles the app offers, e.g. 'ID_JKT' (default: Jakarta, else the first city listed)
export const LALA_HOSTS = { production: 'https://rest.lalamove.com', sandbox: 'https://rest.sandbox.lalamove.com' };
export const LALA_TIMEOUT_MS = 10000;
export function lalaReady(env) { return !!(env && env.LALAMOVE_KEY && env.LALAMOVE_SECRET); }
export function lalaEnv(env) { return String((env && env.LALAMOVE_ENV) || '').trim().toLowerCase() === 'production' ? 'production' : 'sandbox'; }
export function lalaMarket(env) { const m = String((env && env.LALAMOVE_MARKET) || '').trim().toUpperCase(); return /^[A-Z]{2,3}$/.test(m) ? m : 'ID'; }
export function lalaCity(env) { const c = String((env && env.LALAMOVE_CITY) || '').trim().toUpperCase(); return /^[A-Z]{2}_[A-Z]{2,5}$/.test(c) ? c : ''; }
const clip = (s, n) => String(s === undefined || s === null ? '' : s).replace(/[<>\u0000-\u001F]/g, ' ').trim().slice(0, n);

/** Lalamove's request signature: hex HMAC-SHA256(secret, ts + "\r\n" + METHOD + "\r\n" + PATH + "\r\n\r\n" + BODY). */
export async function lalaSign(secret, ts, method, path, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}\r\n${method}\r\n${path}\r\n\r\n${body}`)));
  return Array.from(mac).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
}

/** One signed call → { ok: true, status, data } or { ok: false, error: 'LALA_OFF' | 'LALA_ERROR', status, message } (Lalamove's
    own error ids and messages, e.g. "ERR_INSUFFICIENT_CREDIT"). The JSON goes wrapped as { data }; GET / DELETE send no body.
    10 s at most; never throws. */
export async function lalaCall(env, method, path, data, fetchImpl = fetch) {
  if (!lalaReady(env)) return { ok: false, error: 'LALA_OFF', status: 0, message: 'Lalamove otomatis belum aktif (LALAMOVE_KEY / LALAMOVE_SECRET)' };
  const M = String(method).toUpperCase(), body = M === 'GET' || M === 'DELETE' || data === undefined || data === null ? '' : JSON.stringify({ data });
  const ts = String(Date.now()), sig = await lalaSign(env.LALAMOVE_SECRET, ts, M, path, body);
  const headers = { Authorization: `hmac ${env.LALAMOVE_KEY}:${ts}:${sig}`, Market: lalaMarket(env), 'Content-Type': 'application/json', Accept: 'application/json', 'Request-ID': crypto.randomUUID() };
  const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), LALA_TIMEOUT_MS);
  try {
    const r = await fetchImpl(LALA_HOSTS[lalaEnv(env)] + path, { method: M, headers, ...(body ? { body } : {}), signal: ctrl.signal });
    const text = await r.text().catch(() => '');
    let js = {}; try { js = text ? JSON.parse(text) : {}; } catch (e) { js = {}; }
    if (r.ok) return { ok: true, status: r.status, data: js && js.data !== undefined ? js.data : js };
    const errs = (js && Array.isArray(js.errors) ? js.errors : []).map((e) => [clip(e && e.id, 60), clip(e && e.message, 160)].filter(Boolean).join(': ')).filter(Boolean);
    return { ok: false, error: 'LALA_ERROR', status: r.status, ids: (js && Array.isArray(js.errors) ? js.errors : []).map((e) => clip(e && e.id, 60)), message: clip('HTTP ' + r.status + (errs.length ? ' ' + errs.join('; ') : ''), 240) };
  } catch (e) {
    return { ok: false, error: 'LALA_ERROR', status: 0, message: e && e.name === 'AbortError' ? 'tidak menjawab (10 detik)' : clip((e && e.message) || e, 120) };
  } finally { clearTimeout(tm); }
}

const priceOf = (pb) => { const n = Number(pb && pb.total); return isFinite(n) && n > 0 ? Math.round(n) : 0; };
const metres = (d) => { const v = Number(d && d.value); return !isFinite(v) || v < 0 ? 0 : /^km$/i.test(String(d && d.unit)) ? Math.round(v * 1000) : Math.round(v); };
const url300 = (u) => { const s = String(u || ''); return /^https?:\/\/[^\s<>"'`]+$/i.test(s) && s.length <= 300 ? s : ''; };

/** GET /v3/cities → { ok, cities: [{ locode, name, services: [{ key, description, load: { value, unit } }] }] }. */
export async function cities(env, fetchImpl = fetch) {
  const r = await lalaCall(env, 'GET', '/v3/cities', null, fetchImpl);
  if (!r.ok) return r;
  const list = Array.isArray(r.data) ? r.data : [];
  return { ok: true, cities: list.slice(0, 60).map((c) => ({ locode: clip(c && c.locode, 20), name: clip(c && c.name, 60),
    services: (c && Array.isArray(c.services) ? c.services : []).slice(0, 40).map((s) => ({ key: clip(s && s.key, 40), description: clip(s && s.description, 80),
      load: s && s.load ? { value: clip(s.load.value, 12), unit: clip(s.load.unit, 8) } : null })) })) };
}
/** The city whose vehicles the app offers: LALAMOVE_CITY, else Jakarta, else the first. */
export function pickCity(list, env) {
  const want = lalaCity(env), L = Array.isArray(list) ? list : [];
  return L.find((c) => want && c.locode === want) || L.find((c) => c.locode === 'ID_JKT' || /jakarta/i.test(c.name)) || L[0] || null;
}
/** POST /v3/quotations (body = the core's plan.quote) → { ok, quotationId, price, currency, expiresAt, scheduleAt, distance_m, stops }. */
export async function quote(env, body, fetchImpl = fetch) {
  const r = await lalaCall(env, 'POST', '/v3/quotations', body, fetchImpl);
  if (!r.ok) return r;
  const d = r.data || {}, pb = d.priceBreakdown || {}, stops = (Array.isArray(d.stops) ? d.stops : []).map((s) => ({ stopId: clip(s && s.stopId, 40), address: clip(s && s.address, 200) }));
  const out = { ok: true, quotationId: clip(d.quotationId, 64), price: priceOf(pb), currency: clip(pb.currency, 5) || 'IDR', expiresAt: clip(d.expiresAt, 40),
    scheduleAt: clip(d.scheduleAt, 40), distance_m: metres(d.distance), stops };
  if (!out.quotationId || !(out.price > 0) || stops.length < 2 || stops.some((s) => !s.stopId)) return { ok: false, error: 'LALA_ERROR', status: r.status, message: 'Jawaban harga Lalamove tidak lengkap' };
  return out;
}
/** POST /v3/orders → { ok, orderId, shareLink, status, driverId, price }. */
export async function place(env, body, fetchImpl = fetch) {
  const r = await lalaCall(env, 'POST', '/v3/orders', body, fetchImpl);
  if (!r.ok) return r;
  const d = r.data || {};
  if (!clip(d.orderId, 64)) return { ok: false, error: 'LALA_ERROR', status: r.status, message: 'Lalamove tidak memberi nomor order' };
  return { ok: true, orderId: clip(d.orderId, 64), shareLink: url300(d.shareLink), status: clip(d.status, 30), driverId: clip(d.driverId, 40), price: priceOf(d.priceBreakdown) };
}
/** GET /v3/orders/{id} → { ok, orderId, status, driverId, shareLink, price }. */
export async function getOrder(env, id, fetchImpl = fetch) {
  const r = await lalaCall(env, 'GET', '/v3/orders/' + encodeURIComponent(String(id)), null, fetchImpl);
  if (!r.ok) return r;
  const d = r.data || {};
  return { ok: true, orderId: clip(d.orderId, 64) || String(id), status: clip(d.status, 30).toUpperCase(), driverId: clip(d.driverId, 40), shareLink: url300(d.shareLink), price: priceOf(d.priceBreakdown) };
}
/** GET /v3/orders/{id}/drivers/{driverId} → { ok, name, phone, plateNumber, photo }. */
export async function getDriver(env, orderId, driverId, fetchImpl = fetch) {
  const r = await lalaCall(env, 'GET', '/v3/orders/' + encodeURIComponent(String(orderId)) + '/drivers/' + encodeURIComponent(String(driverId)), null, fetchImpl);
  if (!r.ok) return r;
  const d = r.data || {};
  return { ok: true, name: clip(d.name, 60), phone: clip(d.phone, 24), plateNumber: clip(d.plateNumber, 16), photo: url300(d.photo) };
}
/** DELETE /v3/orders/{id} — only before the goods are picked up (Lalamove refuses after). */
export async function cancelOrder(env, id, fetchImpl = fetch) {
  const r = await lalaCall(env, 'DELETE', '/v3/orders/' + encodeURIComponent(String(id)), null, fetchImpl);
  return r.ok ? { ok: true } : r;
}
