// v77 (owner 2026-11-06: «هل يمكن ان يتم الفتح ببصمة او بالوجه», his choice «أ»): the apps open with the phone's own fingerprint /
// face (passkeys). These tests play the phone: a real P-256 / RSA key pair signs exactly what a phone's authenticator signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, d1Mock, insert } from './shim.js';
import worker from '../src/index.js';
import { KPasskey } from '../src/generated/passkey.gen.js';

const KEY = 'KHAIR-TEST-0000';
const ORIGIN = 'https://officezied-prog.github.io';
const subtle = crypto.webcrypto.subtle;
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const MASTER = crypto.createHash('sha256').update(KEY + ':__master__:87654321').digest('hex');
const sha = (b) => new Uint8Array(crypto.createHash('sha256').update(b).digest());
const enc = (s) => new TextEncoder().encode(s);
const b64u = KPasskey.b64u;

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), master_hash: MASTER, active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Rani', role: 'sales', pin_hash: h('Rani', '3333'), active: true });
  insert(db, 'pos_users', { id: 5, name: 'Ayu', role: 'akuntan', pin_hash: h('Ayu', '5555'), active: true });
  return db;
}
const env = (db, extra = {}) => ({ DB: d1Mock(db), STORE_KEY: KEY, ...extra });
async function post(e, body, route = 'khair-pos') {
  e.DB.calls = 0;
  const r = await worker.fetch(new Request('https://w.test/webhook/' + route, { method: 'POST', body: JSON.stringify(body) }), e);
  return { status: r.status, body: await r.json(), calls: e.DB.calls };
}
const as = (user, pin, action, data = {}) => ({ action, key: KEY, user, pin_hash: pin.length === 64 ? pin : h(user, pin), data });
const open = (user, action, data = {}) => ({ action, key: KEY, user, data });
const row = (db, sql, ...p) => ({ ...db.prepare(sql).get(...p) });

function rawToDer(raw) { // WebCrypto signs ECDSA as r ‖ s; a phone sends it DER-encoded
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? [0, ...b] : [...b]; };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
  const body = [0x02, r.length, ...r, 0x02, s.length, ...s];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** A phone's authenticator: one key pair, the passkey id, its counter. */
async function phone({ alg = -7, origin = ORIGIN, counter = 0 } = {}) {
  const kp = alg === -7
    ? await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const id = crypto.randomBytes(32), rpHash = sha(new URL(origin).hostname);
  const P = {
    alg, id: b64u(id), counter,
    async create({ flags = 0x45, origin: o = origin, type = 'webauthn.create' } = {}) {
      const spki = new Uint8Array(await subtle.exportKey('spki', kp.publicKey));
      const ad = new Uint8Array([...rpHash, flags, 0, 0, 0, 0, ...new Uint8Array(16), id.length >> 8, id.length & 255, ...id, 0xa5, 0x01, 0x02]);
      const cd = enc(JSON.stringify({ type, challenge: b64u(crypto.randomBytes(32)), origin: o, crossOrigin: false }));
      return { cred_id: P.id, public_key: b64u(spki), alg, client_data: b64u(cd), authenticator_data: b64u(ad), label: 'Android · Chrome' };
    },
    async sign(challenge, { flags = 0x05, origin: o = origin, type = 'webauthn.get', key = kp.privateKey, count } = {}) {
      P.counter = count === undefined ? P.counter + 1 : count;
      const c = P.counter;
      const ad = new Uint8Array([...rpHash, flags, (c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]);
      const cd = enc(JSON.stringify({ type, challenge: b64u(enc(challenge)), origin: o, crossOrigin: false }));
      const data = new Uint8Array([...ad, ...sha(cd)]);
      let sig = new Uint8Array(await subtle.sign(alg === -7 ? { name: 'ECDSA', hash: 'SHA-256' } : 'RSASSA-PKCS1-v1_5', key, data));
      if (alg === -7) sig = rawToDer(sig);
      return { cred_id: P.id, authenticator_data: b64u(ad), client_data: b64u(cd), signature: b64u(sig) };
    },
  };
  return P;
}
async function enable(e, user, pin, p) {
  const r = await post(e, as(user, pin, 'passkey_add', await p.create()));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  return r;
}
async function fingerLogin(e, user, p, opts) {
  const b = await post(e, open(user, 'passkey_begin'));
  assert.equal(b.body.ok, true, JSON.stringify(b.body));
  return post(e, open(user, 'passkey_login', await p.sign(b.body.challenge, opts)));
}

test('KPasskey: base64url both ways; DER → r ‖ s; challenges are signed, tied to a user and good for 3 minutes', async () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33, 64]) { const b = crypto.randomBytes(n); assert.deepEqual([...KPasskey.unb64u(b64u(b))], [...b]); assert.equal(b64u(b), b.toString('base64url')); }
  assert.equal(KPasskey.unb64u('a+b/'), null);
  const raw = crypto.randomBytes(64); raw[0] |= 0x80; raw[32] = 0; raw[33] = 0x10;
  assert.deepEqual([...KPasskey.derToRaw(rawToDer(raw))], [...raw]);
  const now = Date.now(), t = await KPasskey.makeChallenge(KEY, 3, now);
  assert.deepEqual(await KPasskey.readChallenge(KEY, t, now + 1000), { uid: 3, t: now });
  assert.equal(await KPasskey.readChallenge(KEY, t, now + 3 * 60000 + 1), null, 'too old');
  assert.equal(await KPasskey.readChallenge('OTHER-KEY', t, now), null, 'another store key never made it');
  assert.equal(await KPasskey.readChallenge(KEY, t.replace('.3.', '.1.'), now), null, 'another user: the signature breaks');
});

test('the manager turns it on with his PIN, then opens the app with the fingerprint alone: the same login as with the PIN', async () => {
  const db = seed(), e = env(db), p = await phone();
  const add = await enable(e, 'Jihan', '2222', p);
  assert.equal(add.body.passkey.device, 'Android · Chrome');
  const k = row(db, 'SELECT user_id, user, alg, public_key FROM pos_passkeys');
  assert.equal(k.user_id, 3); assert.equal(k.user, 'Jihan'); assert.equal(k.alg, -7); assert.ok(k.public_key.length > 80, 'only the public key is kept');
  assert.match(row(db, "SELECT summary FROM pos_activity WHERE kind = 'keamanan'").summary, /diaktifkan untuk akun Jihan di Android/);

  const b = await post(e, open('Jihan', 'passkey_begin'));
  assert.equal(b.body.ok, true); assert.deepEqual(b.body.allow, [p.id]); assert.match(b.body.challenge, /^k1\.3\.\d+\./);
  const r = await post(e, open('Jihan', 'passkey_login', await p.sign(b.body.challenge)));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.user, { name: 'Jihan', role: 'manager' });
  assert.equal(r.body.via_passkey, true);
  assert.equal(r.body.pin_hash, h('Jihan', '2222'), 'the app then works exactly as after a PIN login');
  const boot = await post(e, as('Jihan', r.body.pin_hash, 'bootstrap'));
  assert.equal(boot.body.ok, true, JSON.stringify(boot.body).slice(0, 200));
  const k2 = row(db, 'SELECT sign_count, last_t, last_used_at FROM pos_passkeys');
  assert.equal(k2.sign_count, 1); assert.ok(k2.last_t > 0); assert.ok(k2.last_used_at);
  // the owner (Windows Hello: RSA) and the accountant, the sales rep — each on his own device
  for (const [u, pin, alg] of [['Pemilik', '1234', -257], ['Ayu', '5555', -7], ['Rani', '3333', -7]]) {
    const q = await phone({ alg });
    await enable(e, u, pin, q);
    const l = await fingerLogin(e, u, q);
    assert.equal(l.body.ok, true, u + ' ' + JSON.stringify(l.body)); assert.equal(l.body.pin_hash, h(u, pin));
  }
});

test('refused: a signed login sent again, another key, no fingerprint check, another site — each counted like a wrong PIN; 5 lock', async () => {
  const db = seed(), e = env(db), p = await phone(), thief = await phone();
  await enable(e, 'Jihan', '2222', p);
  const b = await post(e, open('Jihan', 'passkey_begin'));
  const signed = await p.sign(b.body.challenge);
  assert.equal((await post(e, open('Jihan', 'passkey_login', signed))).body.ok, true);
  const again = await post(e, open('Jihan', 'passkey_login', signed));
  assert.equal(again.body.error, 'PASSKEY_FAIL', 'the same signed login, sent a second time');
  assert.equal(row(db, 'SELECT fail_count FROM pos_users WHERE id = 3').fail_count, 1);
  const tries = [
    async (ch) => ({ ...(await thief.sign(ch)), cred_id: p.id }), // another phone's key under this passkey's id
    async (ch) => p.sign(ch, { flags: 0x01 }), // touched, but no fingerprint / face / screen-lock check
    async (ch) => p.sign(ch, { origin: 'https://evil.example' }), // a page that is not ours
    async (ch) => p.sign(ch, { count: 1 }), // the counter did not move on from the last login (a copied key)
  ];
  for (const t of tries) {
    const c = await post(e, open('Jihan', 'passkey_begin'));
    const r = await post(e, open('Jihan', 'passkey_login', await t(c.body.challenge)));
    assert.ok(['PASSKEY_FAIL', 'LOCKED'].includes(r.body.error), JSON.stringify(r.body));
  }
  assert.ok(Date.parse(row(db, 'SELECT locked_until FROM pos_users WHERE id = 3').locked_until) > Date.now(), '5 refused → locked');
  assert.match(row(db, "SELECT summary FROM pos_activity WHERE level = 'danger'").summary, /Sidik jari \/ wajah ditolak .* 5 kali berturut-turut untuk akun Jihan/);
  const locked = await post(e, open('Jihan', 'passkey_begin'));
  assert.equal(locked.body.error, 'LOCKED', 'a locked account opens with neither the PIN nor the fingerprint');
});

test('not counted: an expired challenge, a passkey removed meanwhile; a wrong store key costs no read at all', async () => {
  const db = seed(), e = env(db), p = await phone();
  await enable(e, 'Jihan', '2222', p);
  const old = await KPasskey.makeChallenge(KEY, 3, Date.now() - 4 * 60000);
  const r = await post(e, open('Jihan', 'passkey_login', await p.sign(old)));
  assert.equal(r.body.error, 'PASSKEY_EXPIRED');
  const forged = await KPasskey.makeChallenge('NOT-THE-STORE-KEY', 3, Date.now());
  assert.equal((await post(e, open('Jihan', 'passkey_login', await p.sign(forged)))).body.error, 'PASSKEY_EXPIRED');
  assert.equal(row(db, 'SELECT fail_count FROM pos_users WHERE id = 3').fail_count || 0, 0);
  const other = await phone();
  assert.equal((await post(e, open('Jihan', 'passkey_login', await other.sign(await KPasskey.makeChallenge(KEY, 3, Date.now()))))).body.error, 'PASSKEY_GONE');
  for (const action of ['passkey_begin', 'passkey_login']) {
    const w = await post(e, { action, key: 'WRONG', user: 'Jihan', data: {} });
    assert.equal(w.body.error, 'BAD_KEY'); assert.equal(w.calls, 0, action + ': no D1 call for a wrong key');
  }
});

test('the cashier keeps the PIN (shared device): no passkey for a kasir account; never with the master code; never under a temporary PIN', async () => {
  const db = seed(), e = env(db);
  const k = await post(e, as('Siti', '1111', 'passkey_add', await (await phone()).create()));
  assert.equal(k.body.error, 'FORBIDDEN'); assert.match(k.body.message, /kasir/);
  assert.equal((await post(e, open('Siti', 'passkey_begin'))).body.error, 'NO_PASSKEY');
  const m = await post(e, as('Jihan', MASTER, 'passkey_add', await (await phone()).create()));
  assert.equal(m.body.error, 'FORBIDDEN', 'the owner\'s master code opens an account, it never gives it a passkey');
  db.prepare('UPDATE pos_users SET must_change = 1 WHERE id = 4').run();
  assert.equal((await post(e, as('Rani', '3333', 'passkey_add', await (await phone()).create()))).body.error, 'PIN_CHANGE_REQUIRED');
  // a passkey made for another page, or without the fingerprint check, is not taken
  assert.equal((await post(e, as('Jihan', '2222', 'passkey_add', await (await phone()).create({ origin: 'https://evil.example' })))).body.error, 'INVALID');
  assert.equal((await post(e, as('Jihan', '2222', 'passkey_add', await (await phone()).create({ flags: 0x41 })))).body.error, 'INVALID');
  assert.equal(row(db, 'SELECT COUNT(*) n FROM pos_passkeys').n, 0);
  // a page added by the dashboard variable (the tests' local server) is accepted
  const local = await phone({ origin: 'http://localhost:8765' });
  assert.equal((await post(env(db, { PASSKEY_ORIGINS: 'http://localhost:8765' }), as('Jihan', '2222', 'passkey_add', await local.create()))).body.ok, true);
});

test('a new PIN or an account switched off ends its passkeys; the owner sees and removes any, the others only their own', async () => {
  const db = seed(), e = env(db), pj = await phone(), po = await phone(), pr = await phone();
  await enable(e, 'Jihan', '2222', pj); await enable(e, 'Pemilik', '1234', po); await enable(e, 'Rani', '3333', pr);
  const own = await post(e, as('Jihan', '2222', 'passkey_list'));
  assert.deepEqual(own.body.passkeys.map((x) => x.user), ['Jihan']);
  const all = await post(e, as('Pemilik', '1234', 'passkey_list'));
  assert.deepEqual(all.body.passkeys.map((x) => x.user).sort(), ['Jihan', 'Pemilik', 'Rani']);
  assert.equal(all.body.passkeys.find((x) => x.user === 'Pemilik').mine, true);
  assert.ok(!JSON.stringify(all.body).includes('public_key'), 'the keys themselves never leave the server');
  assert.equal((await post(e, as('Jihan', '2222', 'passkey_remove', { cred_id: po.id }))).body.error, 'FORBIDDEN');
  assert.equal((await post(e, as('Pemilik', '1234', 'passkey_remove', { cred_id: pr.id }))).body.removed, 1);
  assert.equal((await fingerLogin(e, 'Pemilik', po)).body.ok, true);
  // Jihan changes her PIN: her passkey goes (a PIN someone saw never leaves a way in)
  const c = await post(e, as('Jihan', '2222', 'change_pin', { new_pin_hash: h('Jihan', '9999') }));
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal((await post(e, open('Jihan', 'passkey_begin'))).body.error, 'NO_PASSKEY');
  assert.equal((await post(e, open('Jihan', 'passkey_login', await pj.sign(await KPasskey.makeChallenge(KEY, 3, Date.now()))))).body.error, 'PASSKEY_GONE');
  // the owner sets a new PIN for her (a lost phone): the new passkey goes too
  const pj2 = await phone(); await enable(e, 'Jihan', '9999', pj2);
  const s = await post(e, as('Pemilik', '1234', 'save_user', { name: 'Jihan', role: 'manager', active: true, pin_hash: h('Jihan', '4321') }));
  assert.equal(s.body.ok, true, JSON.stringify(s.body));
  assert.equal(row(db, 'SELECT COUNT(*) n FROM pos_passkeys WHERE user_id = 3').n, 0);
  assert.ok(db.prepare("SELECT summary FROM pos_activity WHERE kind = 'keamanan'").all().some((x) => /dimatikan untuk akun Jihan \(PIN diganti\)/.test(x.summary)));
  // a sales rep switched off: his passkey goes; the owner's own stays (nobody else's account is touched)
  await enable(e, 'Rani', '3333', await phone());
  const off = await post(e, as('Pemilik', '1234', 'save_user', { name: 'Rani', role: 'sales', active: false }));
  assert.equal(off.body.ok, true, JSON.stringify(off.body));
  assert.equal(row(db, 'SELECT COUNT(*) n FROM pos_passkeys WHERE user_id = 4').n, 0);
  assert.equal(row(db, 'SELECT COUNT(*) n FROM pos_passkeys WHERE user_id = 1').n, 1);
});

test('at most 10 passkeys an account (the oldest go); made again on the same phone replaces it; one fingerprint login reads only a few rows', async () => {
  const db = seed(), e = env(db), first = await phone();
  await enable(e, 'Jihan', '2222', first);
  for (let i = 0; i < 10; i++) await enable(e, 'Jihan', '2222', await phone());
  assert.equal(row(db, 'SELECT COUNT(*) n FROM pos_passkeys WHERE user_id = 3').n, 10);
  assert.equal(row(db, 'SELECT COUNT(*) n FROM pos_passkeys WHERE cred_id = ?', first.id).n, 0, 'the oldest went');
  const p = await phone(); await enable(e, 'Jihan', '2222', p); await enable(e, 'Jihan', '2222', p);
  assert.equal(row(db, 'SELECT COUNT(*) n FROM pos_passkeys WHERE cred_id = ?', p.id).n, 1);
  const b = await post(e, open('Jihan', 'passkey_begin'));
  assert.ok(b.calls <= 6, 'begin: ' + b.calls + ' D1 calls');
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM pos_passkeys WHERE cred_id = ?').all('x').map((x) => x.detail).join(' ');
  assert.match(plan, /USING (COVERING )?INDEX idx_pos_passkeys_cred_id/);
  assert.match(db.prepare('EXPLAIN QUERY PLAN SELECT cred_id FROM pos_passkeys WHERE user_id = ?').all(3).map((x) => x.detail).join(' '), /USING (COVERING )?INDEX idx_pos_passkeys_user_id/);
});
