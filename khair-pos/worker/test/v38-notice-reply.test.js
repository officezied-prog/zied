// v38 (owner 2026-10-12: "For any notice come to me make for me I can reply" + «نعم زر رد او اغلق مباشر ما في مشكل»)
// The Chat API on an in-memory SQLite: a reply to a notice is a private message carrying the quoted notice (quote) and the
// notice id (ref); the recipient reads it in his private room with the owner and answers; "Tutup" closes notices for every
// device of that user only. The Worker adds the two pos_chat columns itself on a D1 created before v38. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleChat, _resetChatSchemaForTests, CHAT_MIGRATIONS } from '../src/chat.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const base = (action, user, pin, data = {}) => ({ action, key: KEY, user, pin_hash: pin ? h(user, pin) : '', data });
const call = (a, action, [user, pin], data) => handleChat(a, base(action, user, pin, data), {}, KEY);
const OWNER = ['Pemilik', '1234'], KASIR = ['Siti', '1111'], MGR = ['Jihan', '2222'];

function seed({ oldD1 } = {}) {
  const db = newDb();
  if (oldD1) { // the live pos_chat was created before v38: no quote / ref columns
    db.exec('DROP TABLE pos_chat');
    db.exec('CREATE TABLE pos_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, cid TEXT, from_user TEXT, from_name TEXT, from_role TEXT, body TEXT, image TEXT, created_at TEXT, deleted INTEGER)');
    db.exec("INSERT INTO pos_chat (channel, cid, from_user, from_name, from_role, body, image, created_at, deleted) VALUES ('general', 'old-1', 'Siti', 'Siti', 'kasir', 'pesan lama', '', '2026-10-01T00:00:00.000Z', 0)");
  }
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  return db;
}

test('v38: the Worker adds pos_chat.quote / pos_chat.ref on an old D1; old messages still come back unchanged', async () => {
  _resetChatSchemaForTests();
  const db = seed({ oldD1: true }), a = sqliteAdapter(db);
  const boot = await call(a, 'chat_bootstrap', OWNER);
  assert.equal(boot.ok, true, JSON.stringify(boot));
  const cols = a.all('PRAGMA table_info(pos_chat)', []).map((c) => c.name);
  for (const c of ['quote', 'ref']) assert.ok(cols.includes(c), 'missing column ' + c);
  assert.equal(CHAT_MIGRATIONS.length, 2);
  const old = boot.messages.general.find((m) => m.cid === 'old-1');
  assert.deepEqual(Object.keys(old).sort(), ['body', 'channel', 'cid', 'created_at', 'from_name', 'id', 'image']);
  assert.deepEqual(boot.notices.closed, {});
});

test('v38: owner replies to a cashier notice → quoted private message; the cashier answers; replied mark on every device', async () => {
  _resetChatSchemaForTests();
  const db = seed({ oldD1: true }), a = sqliteAdapter(db);
  const boot = await call(a, 'chat_bootstrap', OWNER);
  const room = boot.team.find((t) => t.name === 'Siti').channel;
  const quote = { text: 'Permintaan batal faktur INV-7 Rp 50.000 oleh Siti: salah input', at: '2026-10-12T02:00:00.000Z', no: 'INV-7', by: 'Siti' };
  const sent = await call(a, 'chat_send', OWNER, { channel: room, body: 'Salah input apa?', cid: 'r-1', quote, ref: 'a:AC12345678' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  assert.equal(sent.notices.replied['a:AC12345678'].to, 'Siti');
  const row = a.all('SELECT quote, ref FROM pos_chat WHERE cid = ?', ['r-1'])[0];
  assert.equal(JSON.parse(row.quote).no, 'INV-7');
  assert.equal(row.ref, 'a:AC12345678');
  // the cashier: unread in the same poll, then the quoted message, then his answer
  const p1 = await call(a, 'chat_poll', KASIR, { cursors: {}, seen: {} });
  assert.equal(p1.unread[room], 1);
  const p2 = await call(a, 'chat_poll', KASIR, { cursors: { [room]: '' } });
  assert.equal(p2.messages[room][0].quote.text, quote.text);
  assert.equal(p2.messages[room][0].body, 'Salah input apa?');
  assert.equal((await call(a, 'chat_send', KASIR, { channel: room, body: 'Barang tertukar, Pak', cid: 'r-2' })).ok, true);
  const po = await call(a, 'chat_poll', OWNER, { cursors: { [room]: '' }, seen: {}, notice_v: '' });
  assert.ok(po.messages[room].some((m) => m.body === 'Barang tertukar, Pak'));
  assert.equal(po.notices.replied['a:AC12345678'].at, sent.message.created_at); // another device of the owner learns "dibalas"
  // privacy: the manager sees neither the room nor the owner's notice state
  const pm = await call(a, 'chat_poll', MGR, { cursors: { [room]: '' }, notice_v: '' });
  assert.ok(!JSON.stringify(pm).includes('Salah input') && !JSON.stringify(pm).includes('AC12345678'));
});

test('v38: Tutup closes notices for every device of that user (persisted, append-only), never for anyone else', async () => {
  _resetChatSchemaForTests();
  const db = seed(), a = sqliteAdapter(db);
  const b0 = await call(a, 'chat_bootstrap', OWNER);
  const c = await call(a, 'notice_close', OWNER, { ids: ['a:AC1', 'att:low:3:2026-10-12'] });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(Object.keys(c.notices.closed).sort(), ['a:AC1', 'att:low:3:2026-10-12']);
  assert.equal(a.all("SELECT COUNT(*) n FROM pos_chat WHERE channel LIKE 'nt:%'", [])[0].n, 2);
  // a second device: its poll carries the old version → gets the new state; with the new version → nothing extra
  const d2 = await call(a, 'chat_poll', OWNER, { cursors: {}, notice_v: b0.notices.v });
  assert.ok(d2.notices.closed['a:AC1']);
  const d3 = await call(a, 'chat_poll', OWNER, { cursors: {}, notice_v: d2.notices.v });
  assert.equal(d3.notices, undefined);
  // the manager's own state is untouched; he can close his own
  const m = await call(a, 'chat_bootstrap', MGR);
  assert.deepEqual(m.notices.closed, {});
  assert.equal((await call(a, 'notice_close', MGR, { id: 'a:AC1' })).ok, true);
  assert.equal(Object.keys((await call(a, 'chat_bootstrap', OWNER)).notices.closed).length, 2);
  assert.equal((await call(a, 'notice_close', OWNER, { ids: [] })).error, 'INVALID');
});
