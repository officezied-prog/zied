// v80 (owner 2026-11-24): the owner reads every private room (read-only), and his Claude assistant writes into the chat through
// /webhook/khair-assistant with a key only the owner makes (src/assistant.js, backend/chat/chat-core.js). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, d1Mock, insert } from './shim.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
function env() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  return { DB: d1Mock(db), STORE_KEY: KEY };
}
const call = async (e, path, body, headers = {}) => {
  const res = await worker.fetch(new Request('https://x' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), e);
  return { status: res.status, body: await res.json() };
};
const chat = (e, user, pin, action, data = {}) => call(e, '/webhook/khair-chat', { action, key: KEY, user, pin_hash: h(user, pin), data }).then((r) => r.body);
const asst = (e, key, action, data = {}) => call(e, '/webhook/khair-assistant', { action, data }, key ? { authorization: 'Bearer ' + key } : {});

test('owner reads the others\' private rooms, read-only; staff never see them', async () => {
  const e = env();
  const dm = 'dm:2.siti|3.jihan';
  assert.equal((await chat(e, 'Siti', '1111', 'chat_send', { channel: dm, body: 'stok gula?', cid: 'a1' })).ok, true);
  const boot = await chat(e, 'Pemilik', '1234', 'chat_bootstrap');
  const w = boot.team.find((t) => t.channel === dm);
  assert.ok(w && w.readonly === true && w.role === 'pantau');
  assert.equal(w.name, 'Siti ↔ Jihan');
  assert.ok(!(dm in (boot.unread || {})), 'a watched room is never unread');
  const poll = await chat(e, 'Pemilik', '1234', 'chat_poll', { cursors: { [dm]: '' } });
  assert.equal(poll.messages[dm][0].body, 'stok gula?');
  const send = await chat(e, 'Pemilik', '1234', 'chat_send', { channel: dm, body: 'halo', cid: 'o1' });
  assert.equal(send.ok, false); assert.equal(send.error, 'FORBIDDEN');
  // the manager sees only his own rooms (no watch entries), and cannot read Siti's room with the owner
  const mgr = await chat(e, 'Jihan', '2222', 'chat_bootstrap');
  assert.ok(mgr.team.every((t) => !t.readonly));
  const sneak = await chat(e, 'Jihan', '2222', 'chat_poll', { cursors: { 'dm:1.pemilik|2.siti': '' } });
  assert.ok(!('dm:1.pemilik|2.siti' in sneak.messages));
});

test('assistant key: owner only, shown once, stored hashed; turned off it stops at once', async () => {
  const e = env();
  const st0 = await chat(e, 'Pemilik', '1234', 'assistant_key_status');
  assert.equal(st0.on, false);
  assert.equal((await chat(e, 'Jihan', '2222', 'assistant_key_new')).error, 'FORBIDDEN');
  const made = await chat(e, 'Pemilik', '1234', 'assistant_key_new');
  assert.ok(/^kma_[A-Za-z0-9_-]{40,}$/.test(made.key));
  assert.equal((await chat(e, 'Pemilik', '1234', 'assistant_key_status')).on, true);
  const stored = await e.DB.prepare('SELECT svalue FROM pos_settings WHERE skey = ?').bind('assistant_key_hash').all();
  assert.equal(stored.results[0].svalue, crypto.createHash('sha256').update(made.key).digest('hex'));
  assert.equal((await asst(e, made.key, 'as_team')).body.ok, true);
  assert.equal((await asst(e, 'kma_' + 'x'.repeat(43), 'as_team')).status, 401);
  assert.equal((await asst(e, '', 'as_team')).status, 401);
  // a store key + PIN on this route opens nothing
  assert.equal((await call(e, '/webhook/khair-assistant', { action: 'as_team', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234') })).status, 401);
  await chat(e, 'Pemilik', '1234', 'assistant_key_off');
  assert.equal((await asst(e, made.key, 'as_team')).status, 401);
});

test('assistant sends to one person privately and reads the reply; the owner can watch it', async () => {
  const e = env();
  const { key } = await chat(e, 'Pemilik', '1234', 'assistant_key_new');
  const team = (await asst(e, key, 'as_team')).body.team.map((t) => t.name);
  assert.deepEqual(team.sort(), ['Jihan', 'Pemilik', 'Siti']);
  const sent = (await asst(e, key, 'as_send', { to: 'jihan', body: 'Rencana iklan minggu ini…', cid: 'k1' })).body;
  assert.equal(sent.ok, true); assert.equal(sent.to, 'Jihan'); assert.equal(sent.message.from_name, 'Asisten Khair');
  assert.equal((await asst(e, key, 'as_send', { to: 'jihan', body: 'Rencana iklan minggu ini…', cid: 'k1' })).body.dup, true);
  assert.equal((await asst(e, key, 'as_send', { to: 'Nobody', body: 'x' })).body.error, 'NOT_FOUND');
  // Jihan sees "Asisten Khair" in her team, reads it and replies there; Siti sees nothing
  const jb = await chat(e, 'Jihan', '2222', 'chat_bootstrap');
  const room = jb.team.find((t) => t.name === 'Asisten Khair');
  assert.ok(room && room.channel === 'as:3.jihan');
  assert.equal(jb.unread['as:3.jihan'], 1);
  assert.equal((await chat(e, 'Jihan', '2222', 'chat_send', { channel: 'as:3.jihan', body: 'Siap, saya pelajari', cid: 'j1' })).ok, true);
  const sb = await chat(e, 'Siti', '1111', 'chat_bootstrap');
  assert.ok(!sb.team.some((t) => t.channel === 'as:3.jihan'));
  assert.equal((await chat(e, 'Siti', '1111', 'chat_send', { channel: 'as:3.jihan', body: 'x', cid: 's1' })).error, 'FORBIDDEN');
  const read = (await asst(e, key, 'as_read', {})).body;
  assert.deepEqual(read.messages.map((m) => [m.from_name, m.body, m.room]), [
    ['Asisten Khair', 'Rencana iklan minggu ini…', 'Asisten Khair ↔ Jihan'], ['Jihan', 'Siap, saya pelajari', 'Asisten Khair ↔ Jihan']]);
  // to Umum
  assert.equal((await asst(e, key, 'as_send', { to: 'general', body: 'Halo tim' })).body.to, 'Umum');
  // the owner watches the assistant's room with Jihan
  const ob = await chat(e, 'Pemilik', '1234', 'chat_bootstrap');
  assert.ok(ob.team.some((t) => t.channel === 'as:3.jihan' && t.readonly && t.name === 'Asisten Khair ↔ Jihan'));
});
