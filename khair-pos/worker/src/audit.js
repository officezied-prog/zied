// v79 (owner 2026-11-08: «اجعل المدير ووحيه هو من يرسل هذه الورقة الأخيرة. كل يوم إذا تم إرسالها من واحد فيهما لا يرسلها الثاني. إلى
// الواتساب يجب أن يأتي إشعار لهم بإرسالها الساعة 9 بالليل», his choice «أ» = the official WhatsApp API): at the evening report hour
// (Pengaturan "report_time", 21:00 by default, Jakarta time) the manager and the accountant get ONE WhatsApp reminder to send the day's
// Audit harian — only while nobody has sent it yet (setting audit_sent, written by process.js audit_mark), once a day (setting
// audit_remind). Meta's WhatsApp Cloud API (src/wa.js, the same secrets as Khair Order Brad); the template khair_audit_harian is
// registered by the owner (Pengaturan → "Pengingat WhatsApp audit harian"). Without the secrets nothing is read and nothing is sent: the
// app's own reminder at the same hour stays. The cron (every 2 minutes, wrangler.toml) reads a few settings rows only from that hour
// until midnight, and no more once the day is done.
import { waReady, sendTemplate, createTemplates, listTemplates, waCount, waAddCount } from './wa.js';

export const AUDIT_TEMPLATE = {
  name: 'khair_audit_harian', language: 'id', category: 'UTILITY',
  components: [{
    type: 'BODY',
    text: 'Halo {{1}}, audit harian Khair Mart tanggal {{2}} belum dikirim. Buka aplikasi Khair Mart: Laporan, Harian, lalu tekan Kirim audit harian. Terima kasih.',
    example: { body_text: [['Wahyu', '08 November 2026']] },
  }],
};
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const KEYS = ['report_time', 'audit_sent', 'audit_remind', 'wa_manager_number', 'wa_akuntan_number', 'wa_owner_number', 'brad_wa_cap'];
const ROLE_KEY = { manager: 'wa_manager_number', akuntan: 'wa_akuntan_number' };
const ROLE_TXT = { manager: 'Manajer', akuntan: 'Akuntan' };

/** A WhatsApp number as the API wants it: digits only, Indonesian 08… / 8… → 628…; '' when it is not a number. */
export function waNumber(v) {
  let d = str(v).replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return /^\d{9,15}$/.test(d) ? d : '';
}
const jkt = (ms) => new Date(ms + 7 * 3600000).toISOString();
const dayText = (d) => d.slice(8, 10) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
async function readSettings(adapter) {
  const rows = await adapter.all(`SELECT id, skey, svalue FROM pos_settings WHERE skey IN (${KEYS.map(() => '?').join(', ')})`, KEYS);
  const S = {}, ids = {};
  for (const r of rows || []) { ids[r.skey] = r.id; try { S[r.skey] = JSON.parse(r.svalue); } catch (e) { S[r.skey] = r.svalue; } }
  return { S, ids };
}
async function writeSetting(adapter, ids, key, value) {
  const v = JSON.stringify(value);
  if (ids[key]) await adapter.run('UPDATE pos_settings SET svalue = ? WHERE id = ?', [v, ids[key]]);
  else await adapter.run('INSERT INTO pos_settings (skey, svalue) VALUES (?, ?)', [key, v]);
}
/** Who gets the reminder: the active manager(s) and accountant(s) with a WhatsApp number in Pengaturan (one message a number). */
async function recipients(adapter, S) {
  const users = await adapter.all('SELECT name, role, active FROM pos_users', []);
  const out = [], seen = new Set();
  for (const u of users || []) {
    if (!ROLE_KEY[u.role] || u.active === 0 || u.active === false || u.active === '0' || u.active === 'false') continue;
    const to = waNumber(S[ROLE_KEY[u.role]]);
    if (to && seen.has(to)) continue; // two accounts on one number: one message
    out.push({ name: str(u.name), role: u.role, to });
    if (to) seen.add(to);
  }
  return out;
}

let doneDay = ''; // this instance: the day already done (sent, reminded, or nothing to do) — no more reads until tomorrow
export function _resetAuditForTests() { doneDay = ''; }

/** The cron's step: → { skipped } or { sent, failed }. */
export async function auditReminderTick(adapter, env, nowMs = Date.now(), fetchImpl = fetch) {
  if (!waReady(env)) return { skipped: 'WA_OFF' };
  const iso = jkt(nowMs), day = iso.slice(0, 10), hm = iso.slice(11, 16);
  if (doneDay === day || hm < '12:00') return { skipped: 'TIME' };
  const { S, ids } = await readSettings(adapter);
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(str(S.report_time)) ? str(S.report_time) : '21:00';
  if (hm < at) return { skipped: 'TIME' };
  const sent = S.audit_sent && typeof S.audit_sent === 'object' ? S.audit_sent[day] : null;
  const prev = S.audit_remind && typeof S.audit_remind === 'object' ? S.audit_remind : {};
  if (sent || prev.date === day) { doneDay = day; return { skipped: sent ? 'SENT' : 'DONE' }; }
  // the day is claimed first: a slow send never makes the next cron run send again
  await writeSetting(adapter, ids, 'audit_remind', { date: day, at: new Date(nowMs).toISOString(), state: 'sending' });
  doneDay = day;
  const list = await recipients(adapter, S), cap = Number.isFinite(Number(S.brad_wa_cap)) && S.brad_wa_cap !== undefined ? Number(S.brad_wa_cap) : 3000;
  let count = 0; try { count = await waCount(adapter); } catch (e) { count = 0; }
  const res = [];
  for (const r of list) {
    if (!r.to) { res.push({ role: r.role, name: r.name, ok: false, error: 'NO_NUMBER' }); continue; }
    if (cap > 0 && count >= cap) { res.push({ role: r.role, name: r.name, ok: false, error: 'CAP' }); continue; }
    const s = await sendTemplate(env, { to: r.to, template: AUDIT_TEMPLATE.name, lang: AUDIT_TEMPLATE.language, params: [r.name || ROLE_TXT[r.role], dayText(day)] }, fetchImpl);
    if (s.ok) count++;
    res.push({ role: r.role, name: r.name, ok: !!s.ok, error: s.ok ? '' : s.error });
  }
  const okN = res.filter((x) => x.ok).length;
  if (okN) { try { await waAddCount(adapter, okN); } catch (e) { /* the counter only */ } }
  await writeSetting(adapter, ids, 'audit_remind', { date: day, at: new Date(nowMs).toISOString(), state: 'done', sent: okN,
    results: res.map((x) => ({ role: x.role, ok: x.ok, error: x.error })) });
  const who = (x) => (ROLE_TXT[x.role] || x.role) + ' ' + x.name;
  const failed = res.filter((x) => !x.ok);
  try {
    await adapter.run('INSERT INTO pos_activity (act_id, at, act_date, user, role, kind, summary, ref, amount, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      'AC' + Math.random().toString(36).slice(2, 10).toUpperCase(), new Date(nowMs).toISOString(), day, 'Sistem', 'system', 'audit_harian',
      ('Pengingat WhatsApp audit harian ' + dayText(day) + (okN ? ': terkirim ke ' + res.filter((x) => x.ok).map(who).join(', ') : ': tidak terkirim')
        + (failed.length ? ' · gagal: ' + failed.map((x) => who(x) + ' (' + (x.error === 'NO_NUMBER' ? 'nomor WhatsApp belum diisi' : x.error === 'CAP' ? 'batas pesan bulan ini' : x.error) + ')').join(', ') : '')
        + (list.length ? '' : ': tidak ada akun manajer / akuntan')).slice(0, 1000), day, 0, failed.length || !okN ? 'warn' : 'info']);
  } catch (e) { /* the reminder itself is what matters */ }
  return { sent: okN, failed: failed.length };
}

/** audit_wa (POS, owner only): op 'status' | 'register' (the template, reviewed by Meta) | 'test' (to the owner's own number). */
export async function auditWaAction(adapter, text, env, fetchImpl = fetch) {
  let b = {};
  try { b = typeof text === 'string' ? JSON.parse(text) : text || {}; } catch (e) { b = {}; }
  const d = b && b.data && typeof b.data === 'object' ? b.data : {};
  const me = (await adapter.all('SELECT name, role, pin_hash FROM pos_users', [])).find((u) => str(u.name).toLowerCase() === str(b.user).toLowerCase());
  if (!me || me.role !== 'owner' || str(me.pin_hash) !== str(b.pin_hash)) return { ok: false, error: 'FORBIDDEN', message: 'Hanya pemilik' };
  const { S } = await readSettings(adapter);
  const op = str(d.op);
  if (op === 'register') {
    const r = await createTemplates(env, [AUDIT_TEMPLATE], fetchImpl);
    return r.ok ? { ok: true, templates: r.templates } : { ok: false, error: 'WA_OFF', message: 'WhatsApp API belum diatur (WA_TOKEN / WA_WABA_ID)' };
  }
  if (op === 'test') {
    if (!waReady(env)) return { ok: false, error: 'WA_OFF', message: 'WhatsApp API belum diatur' };
    const to = waNumber(S.wa_owner_number);
    if (!to) return { ok: false, error: 'INVALID', message: 'Isi dulu WhatsApp pemilik di Pengaturan' };
    const s = await sendTemplate(env, { to, template: AUDIT_TEMPLATE.name, lang: AUDIT_TEMPLATE.language, params: [str(me.name) || 'Pemilik', dayText(jkt(Date.now()).slice(0, 10))] }, fetchImpl);
    if (s.ok) { try { await waAddCount(adapter, 1); } catch (e) { /* counter */ } }
    return s.ok ? { ok: true, sent: true } : { ok: false, error: 'WA_FAIL', message: s.error };
  }
  // status
  const list = await recipients(adapter, S);
  let template = null;
  if (env && env.WA_TOKEN && env.WA_WABA_ID) {
    const t = await listTemplates(env, fetchImpl);
    const mine = ((t && t.templates) || []).find((x) => x.name === AUDIT_TEMPLATE.name);
    template = mine ? mine.status : t && t.ok ? 'MISSING' : 'UNKNOWN';
  }
  return {
    ok: true, on: waReady(env), set: { token: !!(env && env.WA_TOKEN), phone: !!(env && env.WA_PHONE_ID), waba: !!(env && env.WA_WABA_ID) },
    template, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(str(S.report_time)) ? str(S.report_time) : '21:00',
    recipients: list.map((x) => ({ role: x.role, name: x.name, has_number: !!x.to })), last: S.audit_remind && typeof S.audit_remind === 'object' ? S.audit_remind : null,
  };
}
