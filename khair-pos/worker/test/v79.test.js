// v79 (owner 2026-11-08: «اجعل المدير ووحيه هو من يرسل هذه الورقة الأخيرة. كل يوم إذا تم إرسالها من واحد فيهما لا يرسلها الثاني. إلى
// الواتساب يجب أن يأتي إشعار لهم بإرسالها الساعة 9 بالليل», his choice «أ»): the Audit harian is sent by the manager or the accountant —
// once a day, the first one recorded — and at the evening hour both get one WhatsApp reminder (official API) while nobody has sent it.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, d1Mock, insert } from './shim.js';
import { handleRequest } from '../src/core.js';
import worker from '../src/index.js';
import { auditReminderTick, auditWaAction, waNumber, AUDIT_TEMPLATE, _resetAuditForTests } from '../src/audit.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Wahyu: '5555' };
const WA = { WA_TOKEN: 't', WA_PHONE_ID: 'p', WA_WABA_ID: 'w' };
const call = (db, user, action, data) => handleRequest(sqliteAdapter(db), { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);
// a moment at hh:mm Jakarta time on a day
const at = (day, hm) => Date.parse(day + 'T' + hm + ':00+07:00');

function seed(numbers = true) {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Wahyu', role: 'akuntan', pin_hash: h('Wahyu', '5555'), active: true });
  if (numbers) {
    insert(db, 'pos_settings', { skey: 'wa_manager_number', svalue: JSON.stringify('0812 0000 0001') });
    insert(db, 'pos_settings', { skey: 'wa_akuntan_number', svalue: JSON.stringify('+62 812-0000-0002') });
    insert(db, 'pos_settings', { skey: 'wa_owner_number', svalue: JSON.stringify('081200000009') });
  }
  return db;
}
/** Meta's Graph API, played: every request kept; messages answer with a wamid, templates with a list. */
function meta(fail = false) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, method: init.method || 'GET' });
    if (fail) return { ok: false, status: 400, json: async () => ({ error: { code: 131026, message: 'Message undeliverable' } }) };
    if (/message_templates/.test(url) && (init.method || 'GET') === 'GET') return { ok: true, status: 200, json: async () => ({ data: [{ name: 'khair_audit_harian', status: 'APPROVED', language: 'id', category: 'UTILITY' }] }) };
    if (/message_templates/.test(url)) return { ok: true, status: 200, json: async () => ({ id: '1', status: 'PENDING' }) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.' + calls.length }] }) };
  };
  f.calls = calls;
  return f;
}
const setting = (db, k) => { const r = db.prepare('SELECT svalue FROM pos_settings WHERE skey = ?').get(k); return r ? JSON.parse(r.svalue) : undefined; };

test('the first of the manager and the accountant to send is kept for the day; the other is told; a cashier cannot mark it', async () => {
  const db = seed();
  // the app's evening check (peek): nothing written while nobody has sent it
  const pk = await call(db, 'Jihan', 'audit_mark', { date: '2026-11-08', peek: true });
  assert.equal(pk.ok, true); assert.equal(pk.audit, null); assert.equal(setting(db, 'audit_sent'), undefined);
  const a = await call(db, 'Wahyu', 'audit_mark', { date: '2026-11-08' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.audit.by, 'Wahyu'); assert.equal(a.audit.role, 'akuntan'); assert.equal(a.already, false);
  const b = await call(db, 'Jihan', 'audit_mark', { date: '2026-11-08' });
  assert.equal(b.ok, true); assert.equal(b.already, true); assert.equal(b.audit.by, 'Wahyu', 'the first sender stays');
  assert.equal((await call(db, 'Jihan', 'audit_mark', { date: '2026-11-08', peek: true })).audit.by, 'Wahyu');
  const r = await call(db, 'Jihan', 'daily_report', { date: '2026-11-08' });
  assert.equal(r.ok, true); assert.equal(r.audit.by, 'Wahyu');
  assert.equal((await call(db, 'Jihan', 'daily_report', { date: '2026-11-07' })).audit, null);
  assert.equal((await call(db, 'Siti', 'audit_mark', { date: '2026-11-08' })).error, 'FORBIDDEN');
  // a cashier's settings carry neither the log nor the accountant's number; the manager's do
  const bs = (await call(db, 'Siti', 'bootstrap', {})).settings, bm = (await call(db, 'Jihan', 'bootstrap', {})).settings;
  assert.equal(bs.audit_sent, undefined); assert.equal(bs.wa_akuntan_number, undefined);
  assert.equal(bm.audit_sent['2026-11-08'].by, 'Wahyu'); assert.equal(bm.wa_akuntan_number, '+62 812-0000-0002');
  assert.ok(db.prepare("SELECT summary FROM pos_activity WHERE kind = 'audit_harian'").get().summary.includes('dikirim oleh Wahyu'));
  // the last 40 days only
  for (let i = 1; i <= 45; i++) await call(db, 'Jihan', 'audit_mark', { date: '2026-09-' + String(i % 28 + 1).padStart(2, '0') });
  assert.ok(Object.keys(setting(db, 'audit_sent')).length <= 40);
  assert.equal(setting(db, 'audit_sent')['2026-11-08'].by, 'Wahyu');
});

test('at 21:00 both get one WhatsApp reminder while nobody has sent it; never before, never twice, never once it is sent', async () => {
  const db = seed(), ad = sqliteAdapter(db), f = meta(), env = Object.assign({ DB: null }, WA);
  _resetAuditForTests();
  assert.equal((await auditReminderTick(ad, env, at('2026-11-08', '20:58'), f)).skipped, 'TIME');
  assert.equal(f.calls.length, 0);
  const r = await auditReminderTick(ad, env, at('2026-11-08', '21:00'), f);
  assert.deepEqual(r, { sent: 2, failed: 0 });
  const sent = f.calls.filter((c) => /\/messages$/.test(c.url));
  assert.deepEqual(sent.map((c) => c.body.to).sort(), ['6281200000001', '6281200000002']);
  assert.equal(sent[0].body.template.name, 'khair_audit_harian');
  assert.deepEqual(sent.map((c) => c.body.template.components[0].parameters[0].text).sort(), ['Jihan', 'Wahyu']);
  assert.equal(sent[0].body.template.components[0].parameters[1].text, '08 November 2026');
  assert.equal(setting(db, 'audit_remind').date, '2026-11-08');
  assert.match(db.prepare("SELECT summary FROM pos_activity WHERE user = 'Sistem'").get().summary, /terkirim ke Manajer Jihan, Akuntan Wahyu/);
  // the next cron runs (and a new instance) do not send again
  await auditReminderTick(ad, env, at('2026-11-08', '21:02'), f);
  _resetAuditForTests();
  await auditReminderTick(ad, env, at('2026-11-08', '21:30'), f);
  assert.equal(f.calls.filter((c) => /\/messages$/.test(c.url)).length, 2);
  // the next day the manager sent it at 20:40: no reminder at 21:00
  await call(db, 'Jihan', 'audit_mark', { date: '2026-11-09' });
  const g = meta();
  assert.equal((await auditReminderTick(ad, env, at('2026-11-09', '21:01'), g)).skipped, 'SENT');
  assert.equal(g.calls.length, 0);
  // another hour chosen in Pengaturan
  insert(db, 'pos_settings', { skey: 'report_time', svalue: JSON.stringify('22:15') });
  _resetAuditForTests();
  const k = meta();
  assert.equal((await auditReminderTick(ad, env, at('2026-11-10', '21:30'), k)).skipped, 'TIME');
  assert.equal((await auditReminderTick(ad, env, at('2026-11-10', '22:16'), k)).sent, 2);
});

test('without the WhatsApp secrets nothing is read; a missing number or a refusal is told to the owner; the cron runs it', async () => {
  const db = seed(false), ad = sqliteAdapter(db);
  _resetAuditForTests();
  const before = ad.calls;
  assert.equal((await auditReminderTick(ad, {}, at('2026-11-08', '21:05'), meta())).skipped, 'WA_OFF');
  assert.equal(ad.calls, before, 'no D1 read without WhatsApp');
  const r = await auditReminderTick(ad, Object.assign({}, WA), at('2026-11-08', '21:05'), meta());
  assert.deepEqual(r, { sent: 0, failed: 2 });
  assert.match(db.prepare("SELECT summary, level FROM pos_activity WHERE user = 'Sistem'").get().summary, /nomor WhatsApp belum diisi/);
  const db2 = seed(), ad2 = sqliteAdapter(db2);
  _resetAuditForTests();
  assert.deepEqual(await auditReminderTick(ad2, Object.assign({}, WA), at('2026-11-08', '21:05'), meta(true)), { sent: 0, failed: 2 });
  assert.equal(db2.prepare("SELECT level FROM pos_activity WHERE user = 'Sistem'").get().level, 'warn');
  // through the Worker's own cron entry (no WhatsApp secrets: it does nothing and never throws)
  const db3 = seed();
  await worker.scheduled({}, { DB: d1Mock(db3), STORE_KEY: KEY }, null);
  assert.equal(db3.prepare("SELECT COUNT(*) n FROM pos_activity WHERE user = 'Sistem'").get().n, 0);
  assert.equal(waNumber('0812-3456-7890'), '6281234567890'); assert.equal(waNumber('812 3456 7890'), '6281234567890');
  assert.equal(waNumber('+62 812 3456 7890'), '6281234567890'); assert.equal(waNumber('12'), '');
});

test('the owner checks the reminder, registers its template and sends himself a test; nobody else can', async () => {
  const db = seed(), ad = sqliteAdapter(db), f = meta();
  const as = (u, op) => auditWaAction(ad, JSON.stringify({ action: 'audit_wa', key: KEY, user: u, pin_hash: h(u, PIN[u]), data: { op } }), WA, f);
  assert.equal((await as('Jihan', 'status')).error, 'FORBIDDEN');
  const st = await as('Pemilik', 'status');
  assert.equal(st.ok, true); assert.equal(st.on, true); assert.equal(st.template, 'APPROVED'); assert.equal(st.time, '21:00');
  assert.deepEqual(st.recipients.map((x) => [x.role, x.has_number]), [['manager', true], ['akuntan', true]]);
  const rg = await as('Pemilik', 'register');
  assert.equal(rg.ok, true); assert.deepEqual(rg.templates.map((x) => x.status), ['EXISTS']);
  const t = await as('Pemilik', 'test');
  assert.equal(t.ok, true);
  assert.equal(f.calls.filter((c) => /\/messages$/.test(c.url)).pop().body.to, '6281200000009');
  assert.deepEqual(AUDIT_TEMPLATE.components[0].example.body_text[0].length, 2);
  // without WhatsApp: the status says so, the test is refused
  const off = await auditWaAction(ad, JSON.stringify({ action: 'audit_wa', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { op: 'status' } }), {}, f);
  assert.equal(off.on, false); assert.equal(off.template, null);
  // through the Worker: the gate first (a wrong PIN never reaches it)
  const e = { DB: d1Mock(db), STORE_KEY: KEY };
  const res = await worker.fetch(new Request('https://w.test/webhook/khair-pos', { method: 'POST', body: JSON.stringify({ action: 'audit_wa', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '0000'), data: { op: 'status' } }) }), e);
  assert.equal((await res.json()).error, 'BAD_PIN');
  const ok = await worker.fetch(new Request('https://w.test/webhook/khair-pos', { method: 'POST', body: JSON.stringify({ action: 'audit_wa', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: { op: 'status' } }) }), e);
  const j = await ok.json();
  assert.equal(j.ok, true); assert.equal(j.on, false);
});
