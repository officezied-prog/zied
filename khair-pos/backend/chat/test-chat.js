/* node test-chat.js — exercises KChat.core (the Chat server logic) with fake rows, no n8n needed.
   Every check prints PASS/FAIL; a non-zero exit means something failed. */
const KChat = require('./chat-core.js');
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + name); } }
function eq(name, a, b) { ok(name + ' (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }

const H = x => x.repeat(64).slice(0, 64);
const PIN = { owner: H('a'), budi: H('b'), siti: H('c'), wahyu: H('d'), master: H('e') };
function baseUsers() {
  return [
    { id: 1, name: 'zied salah', role: 'owner', pin_hash: PIN.owner, master_hash: PIN.master, active: true },
    { id: 2, name: 'Budi', role: 'manager', pin_hash: PIN.budi, active: true },
    { id: 3, name: 'Siti', role: 'kasir', pin_hash: PIN.siti, active: true },
    { id: 4, name: 'Wahyu', role: 'sales', pin_hash: PIN.wahyu, active: true }
  ];
}
function state(extra) {
  return Object.assign({ key_ok: true, users: baseUsers(), settings: [], chat: [] }, extra || {});
}
let seq = 100;
function apply(st, writes, nowIso) { // mimic the data-table upsert back into state
  (writes || []).forEach(w => {
    const row = Object.assign({}, w.row);
    if (w.table === 'chat') { row.id = ++seq; delete row._id; st.chat.push(row); }
    if (w.table === 'settings') {
      delete row._id;
      const ex = st.settings.find(s => s.skey === row.skey);
      if (ex) ex.svalue = row.svalue; else st.settings.push(Object.assign({ id: ++seq }, row));
    }
  });
}
const NOW = '2026-10-07T10:00:00.000Z';
const req = (action, who, data) => ({ action, user: who ? who.name : '', pin_hash: who ? who.pin : '', data: data || {} });
const WHO = { owner: { name: 'zied salah', pin: PIN.owner }, budi: { name: 'Budi', pin: PIN.budi }, siti: { name: 'Siti', pin: PIN.siti }, wahyu: { name: 'Wahyu', pin: PIN.wahyu } };

console.log('— auth —');
eq('bad key', KChat.core(state({ key_ok: false }), req('chat_bootstrap', WHO.owner), NOW).response.error, 'BAD_KEY');
eq('unknown user', KChat.core(state(), req('chat_bootstrap', { name: 'Ghost', pin: PIN.owner }), NOW).response.error, 'BAD_PIN');
eq('wrong pin', KChat.core(state(), req('chat_bootstrap', { name: 'Siti', pin: PIN.wahyu }), NOW).response.error, 'BAD_PIN');
eq('non-hash pin', KChat.core(state(), req('chat_bootstrap', { name: 'Siti', pin: '1234' }), NOW).response.error, 'BAD_PIN');
eq('locked_until', KChat.core(state({ users: baseUsers().map(u => u.name === 'Siti' ? Object.assign(u, { locked_until: '2999-01-01T00:00:00Z' }) : u) }), req('chat_bootstrap', WHO.siti), NOW).response.error, 'LOCKED');
eq('must_change blocks', KChat.core(state({ users: baseUsers().map(u => u.name === 'Siti' ? Object.assign(u, { must_change: true }) : u) }), req('chat_bootstrap', WHO.siti), NOW).response.error, 'PIN_CHANGE_REQUIRED');
eq('master code opens', KChat.core(state(), req('chat_bootstrap', { name: 'Budi', pin: PIN.master }), NOW).response.ok, true);
eq('tamper locked kasir', KChat.core(state({ settings: [{ id: 9, skey: 'locked_accounts', svalue: JSON.stringify(['siti']) }] }), req('chat_bootstrap', WHO.siti), NOW).response.error, 'TAMPER_LOCKED');
eq('owner never tamper-locked', KChat.core(state({ settings: [{ id: 9, skey: 'locked_accounts', svalue: JSON.stringify(['zied salah']) }] }), req('chat_bootstrap', WHO.owner), NOW).response.ok, true);

console.log('— channels —');
eq('owner sees 2 channels', KChat.core(state(), req('chat_bootstrap', WHO.owner), NOW).response.channels.length, 2);
eq('manager sees 2 channels', KChat.core(state(), req('chat_bootstrap', WHO.budi), NOW).response.channels.length, 2);
eq('kasir sees 1 channel', KChat.core(state(), req('chat_bootstrap', WHO.siti), NOW).response.channels.join(','), 'general');
eq('sales sees 1 channel', KChat.core(state(), req('chat_bootstrap', WHO.wahyu), NOW).response.channels.join(','), 'general');

console.log('— send + authorization —');
let st = state();
let r = KChat.core(st, req('chat_send', WHO.siti, { channel: 'owner_mgr', body: 'hi' }), NOW);
eq('kasir cannot post to private', r.response.error, 'FORBIDDEN');
r = KChat.core(st, req('chat_send', WHO.siti, { channel: 'general', body: '  Halo semua  ', cid: 'm1' }), NOW);
eq('kasir posts to general ok', r.response.ok, true);
eq('body trimmed', r.response.message.body, 'Halo semua');
ok('one chat write', r.writes.length === 1 && r.writes[0].table === 'chat');
apply(st, r.writes, NOW);
r = KChat.core(st, req('chat_send', WHO.owner, { channel: 'owner_mgr', body: 'rahasia', cid: 'm2' }), '2026-10-07T10:00:01.000Z');
eq('owner posts to private ok', r.response.ok, true);
apply(st, r.writes, '2026-10-07T10:00:01.000Z');
r = KChat.core(st, req('chat_send', WHO.siti, { channel: 'general', body: '', image: '' }), NOW);
eq('empty message rejected', r.response.error, 'INVALID');
r = KChat.core(st, req('chat_send', WHO.siti, { channel: 'general', body: 'x', cid: 'm1' }), NOW);
eq('duplicate cid is idempotent', r.response.dup, true);
ok('duplicate cid writes nothing', r.writes.length === 0);

console.log('— private channel is hidden from kasir —');
let boot = KChat.core(st, req('chat_bootstrap', WHO.siti), NOW).response;
ok('kasir bootstrap has general only', boot.messages.general && !boot.messages.owner_mgr);
eq('kasir sees the general message', boot.messages.general.length, 1);
let bootM = KChat.core(st, req('chat_bootstrap', WHO.budi), NOW).response;
eq('manager sees private message', bootM.messages.owner_mgr.length, 1);
eq('private message body', bootM.messages.owner_mgr[0].body, 'rahasia');

console.log('— images —');
const img = 'data:image/jpeg;base64,' + 'A'.repeat(100);
r = KChat.core(state(), req('chat_send', WHO.siti, { channel: 'general', image: img, cid: 'i1' }), NOW);
eq('valid small image ok', r.response.ok, true);
r = KChat.core(state(), req('chat_send', WHO.siti, { channel: 'general', image: 'data:image/jpeg;base64,' + 'A'.repeat(200000), cid: 'i2' }), NOW);
eq('oversized image rejected', r.response.error, 'INVALID');
r = KChat.core(state(), req('chat_send', WHO.siti, { channel: 'general', image: 'javascript:alert(1)', cid: 'i3' }), NOW);
eq('non-image rejected', r.response.error, 'INVALID');

console.log('— poll cursor —');
st = state();
apply(st, KChat.core(st, req('chat_send', WHO.siti, { channel: 'general', body: 'one', cid: 'p1' }), '2026-10-07T10:00:00.000Z').writes, '2026-10-07T10:00:00.000Z');
apply(st, KChat.core(st, req('chat_send', WHO.siti, { channel: 'general', body: 'two', cid: 'p2' }), '2026-10-07T10:00:05.000Z').writes, '2026-10-07T10:00:05.000Z');
let poll = KChat.core(st, req('chat_poll', WHO.siti, { cursors: { general: '2026-10-07T10:00:00.000Z' } }), NOW).response;
eq('poll returns only newer', poll.messages.general.length, 1);
eq('poll newer is "two"', poll.messages.general[0].body, 'two');

console.log('— retention —');
r = KChat.core(state(), req('chat_set_retention', WHO.siti, { days: 30 }), NOW);
eq('non-owner cannot set retention', r.response.error, 'FORBIDDEN');
st = state();
r = KChat.core(st, req('chat_set_retention', WHO.owner, { days: 30 }), NOW);
eq('owner sets retention ok', r.response.retention_days, 30);
apply(st, r.writes, NOW);
eq('retention persisted', KChat.core(st, req('chat_bootstrap', WHO.owner), NOW).response.retention_days, 30);
st.chat.push({ id: 500, channel: 'general', cid: 'old', from_name: 'Siti', body: 'old', created_at: '2026-01-01T00:00:00.000Z' });
st.chat.push({ id: 501, channel: 'general', cid: 'new', from_name: 'Siti', body: 'new', created_at: NOW });
let after = KChat.core(st, req('chat_bootstrap', WHO.owner), NOW).response;
eq('old message hidden by retention', after.messages.general.length, 1);
eq('retained message is the new one', after.messages.general[0].body, 'new');
eq('retention 0 keeps all', (() => { const s2 = state({ settings: [], chat: st.chat.slice() }); return KChat.core(s2, req('chat_bootstrap', WHO.owner), NOW).response.messages.general.length; })(), 2);

console.log('— unknown action —');
eq('unknown action', KChat.core(state(), req('chat_nope', WHO.owner), NOW).response.error, 'UNKNOWN');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
