// Parity tests for the Chat API: the build-time wrap (chat-core.js + process-chat.js)
// preserves behaviour, and messages/retention persist to pos_chat / pos_settings. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleChat, parseChat, loadChatNodes } from '../src/chat.js';
import { makeAccessor } from '../src/db.js';
import { runProcessChat } from '../src/generated/process-chat.gen.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const core = readFileSync(new URL('../../backend/chat/chat-core.js', import.meta.url), 'utf8');
const wrap = readFileSync(new URL('../../backend/chat/process-chat.js', import.meta.url), 'utf8');
const origChatFn = new Function('$', (core + '\n' + wrap).replace("'__STORE_KEY__'", JSON.stringify(KEY)));

const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  return db;
}

function frozen(fn) {
  const RealDate = Date;
  const FIXED = RealDate.parse('2026-10-06T03:00:00.000Z');
  const oR = Math.random; let s = 7;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  class FrozenDate extends RealDate { constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); } static now() { return FIXED; } }
  globalThis.Date = FrozenDate;
  try { return fn(); } finally { globalThis.Date = RealDate; Math.random = oR; }
}

test('chat: generated runProcessChat == original (chat-core + process-chat)', async () => {
  const cases = [
    base('chat_bootstrap', 'Siti', '1111'),
    base('chat_send', 'Siti', '1111', { channel: 'general', body: 'Halo tim', cid: 'fixed-cid-1' }),
    base('chat_send', 'Siti', '1111', { channel: 'owner_mgr', body: 'secret', cid: 'x' }), // kasir forbidden in owner_mgr
    base('chat_set_retention', 'Pemilik', '1234', { days: 30 }),
    base('chat_set_retention', 'Siti', '1111', { days: 30 }), // kasir forbidden
    base('chat_send', 'Siti', '1111', { channel: 'dm:2.siti|3.jihan', body: 'pribadi', cid: 'dm-fixed' }), // v36 private room
    base('chat_poll', 'Jihan', '2222', { cursors: { 'dm:2.siti|3.jihan': '' }, seen: { general: '' } }),
    { action: 'chat_bootstrap', key: 'WRONG', user: 'Siti', pin_hash: h('Siti', '1111'), data: {} },
  ];
  for (const body of cases) {
    const nodes = await loadChatNodes(sqliteAdapter(seed()), parseChat(body));
    const $ = makeAccessor(nodes);
    const gen = frozen(() => runProcessChat($, KEY)[0].json);
    const orig = frozen(() => origChatFn($)[0].json);
    assert.deepEqual(gen, orig, 'mismatch for chat action ' + body.action);
  }
});

test('chat: send persists a message that bootstrap then returns', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const sent = await handleChat(a, base('chat_send', 'Siti', '1111', { channel: 'general', body: 'Halo tim', cid: 'c-1' }), {}, KEY);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const rows = a.all('SELECT * FROM pos_chat', []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'Halo tim');
  assert.equal(rows[0].channel, 'general');
  assert.equal(rows[0].deleted, 0); // boolean stored as 0
  const boot = await handleChat(a, base('chat_bootstrap', 'Jihan', '2222'), {}, KEY);
  assert.ok(boot.messages.general.find((m) => m.body === 'Halo tim'));
});

test('chat: duplicate cid is not inserted twice', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  await handleChat(a, base('chat_send', 'Siti', '1111', { channel: 'general', body: 'one', cid: 'dup' }), {}, KEY);
  const second = await handleChat(a, base('chat_send', 'Siti', '1111', { channel: 'general', body: 'one again', cid: 'dup' }), {}, KEY);
  assert.equal(second.ok, true);
  assert.equal(second.dup, true);
  assert.equal(a.all('SELECT COUNT(*) n FROM pos_chat', [])[0].n, 1);
});

test('chat: owner sets retention (writes pos_settings)', async () => {
  const db = seed();
  const a = sqliteAdapter(db);
  const r = await handleChat(a, base('chat_set_retention', 'Pemilik', '1234', { days: 30 }), {}, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = a.all("SELECT svalue FROM pos_settings WHERE skey = 'chat_retention_days'", []);
  assert.equal(s.length, 1);
  assert.equal(s[0].svalue, '30');
});

// v36 (owner 2026-10-11: «أريد الدردشة مع كل الفريق المسجل وكل من له يحمل هذا التطبيق»)
test('chat v36: a private room with any team member — stored in pos_chat, visible only to its two members, unread in the same poll', async () => {
  const db = seed();
  insert(db, 'pos_users', { id: 4, name: 'Wahyu', role: 'sales', pin_hash: h('Wahyu', '4444'), active: true });
  const a = sqliteAdapter(db);
  const boot = await handleChat(a, base('chat_bootstrap', 'Siti', '1111'), {}, KEY);
  assert.equal(boot.ok, true, JSON.stringify(boot));
  assert.deepEqual(boot.team.map((t) => t.name), ['Jihan', 'Pemilik', 'Wahyu']);
  const room = boot.team.find((t) => t.name === 'Wahyu').channel;
  assert.equal(room, 'dm:2.siti|4.wahyu');
  const sent = await handleChat(a, base('chat_send', 'Siti', '1111', { channel: room, body: 'rahasia kecil', cid: 'dm-1' }), {}, KEY);
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(a.all('SELECT channel FROM pos_chat WHERE cid = ?', ['dm-1'])[0].channel, room);
  // Wahyu: unread without opening it, then the message when he opens it
  const p1 = await handleChat(a, base('chat_poll', 'Wahyu', '4444', { cursors: { general: '' }, seen: {} }), {}, KEY);
  assert.equal(p1.unread[room], 1);
  assert.equal(p1.messages[room], undefined);
  const p2 = await handleChat(a, base('chat_poll', 'Wahyu', '4444', { cursors: { [room]: '' } }), {}, KEY);
  assert.equal(p2.messages[room][0].body, 'rahasia kecil');
  // the owner and the manager never see it, even when asking for it
  for (const [u, p] of [['Pemilik', '1234'], ['Jihan', '2222']]) {
    const po = await handleChat(a, base('chat_poll', u, p, { cursors: { [room]: '' } }), {}, KEY);
    assert.equal(po.ok, true);
    assert.ok(!JSON.stringify(po).includes('rahasia kecil'), u + ' must not receive the private room');
    const no = await handleChat(a, base('chat_send', u, p, { channel: room, body: 'x', cid: 'dm-x-' + u }), {}, KEY);
    assert.equal(no.error, 'FORBIDDEN');
  }
});
