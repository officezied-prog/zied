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

console.log('— v36: private 1-to-1 rooms with every team member —');
st = state();
boot = KChat.core(st, req('chat_bootstrap', WHO.siti), NOW).response;
eq('kasir team = the 3 others', boot.team.map(t => t.name).join(','), 'Budi,Wahyu,zied salah');
const dmSW = boot.team.find(t => t.name === 'Wahyu').channel;
eq('room id from both ids + names, sorted', dmSW, 'dm:3.siti|4.wahyu');
eq('both sides compute the same room', KChat.core(st, req('chat_bootstrap', WHO.wahyu), NOW).response.team.find(t => t.name === 'Siti').channel, dmSW);
ok('fixed channels unchanged (no dm in channels)', boot.channels.join(',') === 'general');
r = KChat.core(st, req('chat_send', WHO.siti, { channel: dmSW, body: 'Wahyu, stok gula?', cid: 'd1' }), '2026-10-07T10:01:00.000Z');
eq('kasir → sales private ok', r.response.ok, true);
apply(st, r.writes);
r = KChat.core(st, req('chat_send', WHO.owner, { channel: dmSW, body: 'masuk', cid: 'd2' }), NOW);
eq('owner cannot post in a room of two others', r.response.error, 'FORBIDDEN');
r = KChat.core(st, req('chat_send', WHO.siti, { channel: 'dm:1.zied salah|4.wahyu', body: 'x', cid: 'd3' }), NOW);
eq('nobody posts in a room that is not theirs', r.response.error, 'FORBIDDEN');
r = KChat.core(st, req('chat_send', WHO.siti, { channel: 'dm:nonsense', body: 'x', cid: 'd4' }), NOW);
eq('unknown private room', r.response.error, 'FORBIDDEN');
let pw = KChat.core(st, req('chat_poll', WHO.wahyu, { cursors: { general: '' }, seen: {} }), '2026-10-07T10:02:00.000Z').response;
eq('receiver: unread for the private room without opening it', pw.unread[dmSW], 1);
ok('receiver: messages only for rooms asked for', pw.messages[dmSW] === undefined);
eq('receiver: last message time of the room', pw.last[dmSW], '2026-10-07T10:01:00.000Z');
pw = KChat.core(st, req('chat_poll', WHO.wahyu, { cursors: { [dmSW]: '' }, seen: { [dmSW]: '2026-10-07T10:01:00.000Z' } }), '2026-10-07T10:02:00.000Z').response;
eq('receiver opens the room: the message', pw.messages[dmSW].length, 1);
eq('message body', pw.messages[dmSW][0].body, 'Wahyu, stok gula?');
ok('read → no unread', !pw.unread[dmSW]);
let ps = KChat.core(st, req('chat_poll', WHO.siti, { cursors: { [dmSW]: '' } }), NOW).response;
ok('my own message is never unread for me', !ps.unread[dmSW]);
// privacy: the owner (and everyone else) never receives this room, even by asking for it
for (const who of ['owner', 'budi']) {
  const po = KChat.core(st, req('chat_poll', WHO[who], { cursors: { [dmSW]: '' }, seen: {} }), NOW).response;
  ok(who + ' never receives a room of two others', po.messages[dmSW] === undefined && po.unread[dmSW] === undefined && po.last[dmSW] === undefined);
}
let bo = KChat.core(st, req('chat_bootstrap', WHO.owner, { cursors: { [dmSW]: '' } }), NOW).response;
ok('owner bootstrap: nothing of the room', bo.messages[dmSW] === undefined && JSON.stringify(bo).indexOf('stok gula') < 0);
r = KChat.core(st, req('chat_send', WHO.owner, { channel: 'general', body: 'tebak', cid: 'd1' }), NOW);
eq('a cid of someone else\'s private message is not a duplicate', r.response.dup, undefined);
ok('…and never returns that message', JSON.stringify(r.response).indexOf('stok gula') < 0 && r.response.message.body === 'tebak' && r.response.message.cid !== 'd1');
// a renamed account (another person takes it) or a new account with the same name does not inherit the room
const st2 = state({ users: baseUsers().map(u => u.name === 'Wahyu' ? Object.assign(u, { name: 'Rudi' }) : u), chat: st.chat.slice() });
const rudi = KChat.core(st2, req('chat_poll', { name: 'Rudi', pin: PIN.wahyu }, { cursors: { [dmSW]: '' } }), NOW).response;
ok('the new person does not see the old room', rudi.messages[dmSW] === undefined && rudi.team.find(t => t.name === 'Siti').channel !== dmSW);
const st3 = state({ users: baseUsers().filter(u => u.name !== 'Wahyu').concat([{ id: 9, name: 'Wahyu', role: 'sales', pin_hash: PIN.wahyu, active: true }]), chat: st.chat.slice() });
ok('a new account with an old name does not see the old room', KChat.core(st3, req('chat_poll', WHO.wahyu, { cursors: { [dmSW]: '' } }), NOW).response.messages[dmSW] === undefined);
// inactive users leave the team list; an akuntan is in it
const st4 = state({ users: baseUsers().map(u => u.name === 'Budi' ? Object.assign(u, { active: false }) : u).concat([{ id: 5, name: 'Rina', role: 'akuntan', pin_hash: H('f'), active: true }]) });
eq('inactive left out, akuntan in', KChat.core(st4, req('chat_bootstrap', WHO.siti), NOW).response.team.map(t => t.name).join(','), 'Rina,Wahyu,zied salah');
// unread for the fixed rooms too, from the device's seen map
st = state();
apply(st, KChat.core(st, req('chat_send', WHO.owner, { channel: 'general', body: 'a', cid: 'g1' }), '2026-10-07T09:00:00.000Z').writes);
apply(st, KChat.core(st, req('chat_send', WHO.owner, { channel: 'general', body: 'b', cid: 'g2' }), '2026-10-07T09:30:00.000Z').writes);
eq('general unread after seen', KChat.core(st, req('chat_poll', WHO.siti, { cursors: {}, seen: { general: '2026-10-07T09:00:00.000Z' } }), NOW).response.unread.general, 1);
eq('general unread with no seen', KChat.core(st, req('chat_poll', WHO.siti, { cursors: {} }), NOW).response.unread.general, 2);

// v38 (owner 2026-10-12: "For any notice come to me make for me I can reply" + «نعم زر رد او اغلق مباشر ما في مشكل»)
console.log('— v38 notice reply (quote + ref) and close —');
st = state();
const dmOS = KChat.dmChannel(baseUsers()[0], baseUsers()[2]);
const q38 = { text: 'Permintaan batal faktur INV-1 oleh Siti', at: '2026-10-07T08:00:00.000Z', no: 'INV-1', by: 'Siti', junk: 'x' };
r = KChat.core(st, req('chat_send', WHO.owner, { channel: dmOS, body: 'Kenapa dibatalkan?', cid: 'q1', quote: q38, ref: 'a:ACXYZ<>1' }), '2026-10-07T09:00:00.000Z');
eq('reply ok', r.response.ok, true);
eq('quote kept (text)', r.response.message.quote.text, q38.text);
eq('quote kept (no)', r.response.message.quote.no, 'INV-1');
ok('quote: unknown fields dropped', r.response.message.quote.junk === undefined);
eq('ref cleaned', r.response.message.ref, 'a:ACXYZ1');
eq('stored quote is JSON text', typeof r.writes[0].row.quote, 'string');
eq('send returns the notice state: replied to Siti', r.response.notices.replied['a:ACXYZ1'].to, 'Siti');
apply(st, r.writes);
let sp = KChat.core(st, req('chat_poll', WHO.siti, { cursors: { [dmOS]: '' }, seen: {} }), NOW).response;
eq('recipient gets the quote', sp.messages[dmOS][0].quote.text, q38.text);
eq('recipient unread', sp.unread[dmOS], 1);
ok('recipient: no notice state on a poll without notice_v (old clients)', sp.notices === undefined);
eq('recipient: own notice state is empty', KChat.core(st, req('chat_bootstrap', WHO.siti), NOW).response.notices.v, '0|');
r = KChat.core(st, req('chat_send', WHO.siti, { channel: dmOS, body: 'Pelanggan salah beli, Pak.', cid: 'q2' }), NOW);
ok('the answer is a plain message (no quote/ref keys)', r.response.ok && r.response.message.quote === undefined && r.response.message.ref === undefined && r.response.notices === undefined);
apply(st, r.writes);
let ob = KChat.core(st, req('chat_bootstrap', WHO.owner), NOW).response;
eq('owner bootstrap: replied mark', ob.notices.replied['a:ACXYZ1'].at, '2026-10-07T09:00:00.000Z');
const v1 = ob.notices.v;
ok('poll with the same notice_v: nothing', KChat.core(st, req('chat_poll', WHO.owner, { cursors: {}, notice_v: v1 }), NOW).response.notices === undefined);
r = KChat.core(st, req('notice_close', WHO.owner, { ids: ['att:low:3:2026-10-07', 'att:low:3:2026-10-07', 'a:AC2'] }), NOW);
eq('close ok', r.response.ok, true);
eq('close: one row per distinct id', r.writes.length, 2);
ok('close rows go to the hidden channel', r.writes.every(w => w.row.channel === KChat.noticeChannel(baseUsers()[0]) && w.row.ref));
ok('close returns the state', r.response.notices.closed['a:AC2'] === NOW && r.response.notices.replied['a:ACXYZ1']);
apply(st, r.writes);
let op = KChat.core(st, req('chat_poll', WHO.owner, { cursors: {}, notice_v: v1 }), NOW).response;
ok('another device (old notice_v) gets the new state on its normal poll', op.notices && op.notices.closed['att:low:3:2026-10-07'] === NOW);
ok('close rows never count as unread or as a room', JSON.stringify(op.unread).indexOf('nt:') < 0 && Object.keys(op.messages).every(k => k.indexOf('nt:') < 0));
const bs = KChat.core(st, req('chat_bootstrap', WHO.budi), NOW).response;
ok('another user never sees my closed notices', Object.keys(bs.notices.closed).length === 0 && JSON.stringify(bs).indexOf('a:AC2') < 0);
eq('nobody can post into a notice channel', KChat.core(st, req('chat_send', WHO.owner, { channel: KChat.noticeChannel(baseUsers()[0]), body: 'x' }), NOW).response.error, 'INVALID');
eq('close with no id', KChat.core(st, req('notice_close', WHO.owner, { ids: ['<>'] }), NOW).response.error, 'INVALID');
eq('close caps at 50', KChat.core(st, req('notice_close', WHO.owner, { ids: Array.from({ length: 80 }, (_, i) => 'a:' + i) }), NOW).writes.length, 50);
eq('kasir may close his own notices too', KChat.core(st, req('notice_close', WHO.siti, { id: 'r:REQ1' }), NOW).response.ok, true);
// old rows (no quote/ref columns) still render
st = state({ chat: [{ id: 1, channel: 'general', cid: 'old', from_user: 'Siti', from_name: 'Siti', body: 'lama', image: '', created_at: '2026-10-01T00:00:00.000Z' }] });
const om = KChat.core(st, req('chat_bootstrap', WHO.owner), NOW).response.messages.general[0];
ok('old message: same shape as before', om.body === 'lama' && om.quote === undefined && om.ref === undefined);
ok('broken quote JSON ignored', KChat.core(state({ chat: [{ id: 1, channel: 'general', cid: 'b', from_user: 'Siti', body: 'x', quote: '{bad', created_at: NOW }] }), req('chat_bootstrap', WHO.owner), NOW).response.messages.general[0].quote === undefined);

console.log('— unknown action —');
eq('unknown action', KChat.core(state(), req('chat_nope', WHO.owner), NOW).response.error, 'UNKNOWN');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
