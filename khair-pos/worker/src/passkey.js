// v77 (owner 2026-11-06: «هل يمكن ان يتم الفتح ببصمة او بالوجه», his choice «أ»): the apps open with the phone's own fingerprint or
// face (a passkey, WebAuthn) for the owner, the manager, the accountant and the sales reps, each on his own phone. The cashiers' shared
// device keeps its PIN: a phone accepts ANY fingerprint enrolled on it, so it cannot tell two cashiers apart — a kasir account can
// never get a passkey (refused here, not only hidden in the app).
//  - passkey_begin / passkey_login need only the store key (checked first, in constant time, before any read): the passkey is the
//    proof. A verified login becomes the user's own ordinary `login` (src/index.js), so the lock-outs, must_change, the tamper lock,
//    the activity log and the answer are exactly those of a PIN login; the answer also carries the account's PIN hash, which the app
//    then sends with each request as after a PIN login (nothing usable is ever stored on the phone).
//  - a refused signature counts as a wrong PIN (the same lock-out, src/authgate.js countWrong); an expired or unknown challenge and
//    a passkey that was removed do not (the app asks for the PIN).
//  - passkey_add / passkey_list / passkey_remove run behind the normal gate, with the person's OWN PIN (never the owner's master code).
//  - a PIN changed (change_pin, or save_user setting one) or an account switched off removes that account's passkeys: a phone that
//    was lost, or a PIN someone saw, never keeps a way in.
// Only the PUBLIC half of each key is kept (pos_passkeys); the checks are shared/passkey.js (KPasskey, also in the apps' demo).
import { KPasskey } from './generated/passkey.gen.js';
import { safeEqual, countWrong, lockedMsg } from './authgate.js';
import { ensurePosSchema } from './core.js';

export const PASSKEY_ROLES = ['owner', 'manager', 'akuntan', 'sales'];
export const PASSKEY_OPEN = ['passkey_begin', 'passkey_login']; // only the store key: the passkey is the proof
export const PASSKEY_ACTIONS = ['passkey_add', 'passkey_list', 'passkey_remove']; // behind the normal gate (own PIN)
// The pages a passkey may come from (the apps on GitHub Pages); more only through the dashboard variable PASSKEY_ORIGINS (comma list).
export const PASSKEY_ORIGINS = ['https://officezied-prog.github.io'];
export const MAX_PER_USER = 10;

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const fail = (error, message, extra) => Object.assign({ ok: false, error, message }, extra || {});
const isHash = (h) => /^[a-f0-9]{64}$/.test(String(h || ''));
const active = (u) => u && u.active !== 0 && u.active !== false && u.active !== '0' && u.active !== 'false';
const origins = (env) => PASSKEY_ORIGINS.concat(str(env && env.PASSKEY_ORIGINS).split(',').map(str).filter(Boolean));
const bodyOf = (text) => { try { const b = typeof text === 'string' ? JSON.parse(text) : text; return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch (e) { return {}; } };
const dataOf = (b) => (b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {});
const cleanLabel = (v) => str(v).replace(/[^\p{L}\p{N} ._,·:/()+-]/gu, '').slice(0, 80);
const NO_PASSKEY = () => fail('NO_PASSKEY', 'Sidik jari / wajah belum aktif untuk akun ini. Masuk dengan PIN.');
const GONE = () => fail('PASSKEY_GONE', 'Sidik jari / wajah di perangkat ini sudah tidak berlaku. Masuk dengan PIN, lalu aktifkan lagi.');

async function findUser(adapter, name) {
  const n = str(name).toLowerCase();
  if (!n) return null;
  const rows = await adapter.all('SELECT id, name, role, pin_hash, active, must_change, fail_count, locked_until FROM pos_users', []);
  return rows.find((u) => active(u) && str(u.name).toLowerCase() === n) || null;
}
async function logSecurity(adapter, me, summary, level, nowMs) {
  try {
    await adapter.run('INSERT INTO pos_activity (act_id, at, act_date, user, role, kind, summary, ref, amount, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      'AC' + Math.random().toString(36).slice(2, 10).toUpperCase(), new Date(nowMs).toISOString(), new Date(nowMs + 7 * 3600000).toISOString().slice(0, 10),
      str(me.name), str(me.role), 'keamanan', summary, str(me.name), 0, level || 'info']);
  } catch (e) { /* the log never stops the action */ }
}

/**
 * passkey_begin / passkey_login (route pos). → { answer } to send back as it is, or { login: { user, pin_hash, data } } — a verified
 * passkey: src/index.js runs it as the user's own login.
 */
export async function passkeyOpen(adapter, text, env, { nowMs = Date.now(), route = 'pos', ip = '' } = {}) {
  const b = bodyOf(text), d = dataOf(b);
  if (typeof b.key !== 'string' || !b.key || !safeEqual(b.key, env.STORE_KEY)) return { answer: fail('BAD_KEY', 'Kunci toko salah') };
  await ensurePosSchema(adapter);
  const me = await findUser(adapter, b.user);
  if (!me || PASSKEY_ROLES.indexOf(str(me.role)) < 0) return { answer: NO_PASSKEY() };
  if (Date.parse(me.locked_until) > nowMs) return { answer: lockedMsg(str(me.locked_until), nowMs) };

  if (str(b.action) === 'passkey_begin') {
    const rows = await adapter.all('SELECT cred_id FROM pos_passkeys WHERE user_id = ?', [me.id]);
    if (!rows.length) return { answer: NO_PASSKEY() };
    return { answer: { ok: true, challenge: await KPasskey.makeChallenge(env.STORE_KEY, me.id, nowMs), allow: rows.map((r) => str(r.cred_id)) } };
  }

  // passkey_login
  const credId = str(d.cred_id);
  const row = credId ? (await adapter.all('SELECT id, cred_id, user_id, public_key, alg, sign_count, last_t FROM pos_passkeys WHERE cred_id = ?', [credId]))[0] : null;
  if (!row || Number(row.user_id) !== Number(me.id)) return { answer: GONE() };
  const ch = await KPasskey.readChallenge(env.STORE_KEY, KPasskey.challengeOf(d.client_data), nowMs);
  if (!ch || ch.uid !== Number(me.id)) return { answer: fail('PASSKEY_EXPIRED', 'Waktu habis. Coba sentuh lagi, atau masuk dengan PIN.') };
  const refuse = async (why) => {
    const w = await countWrong(adapter, me, { nowMs, route, ip, why: 'Sidik jari / wajah ditolak (' + why + ')' });
    return { answer: w.refusal || fail('PASSKEY_FAIL', 'Sidik jari / wajah ditolak. Masuk dengan PIN.') };
  };
  if (ch.t <= (Number(row.last_t) || 0)) return refuse('dipakai ulang'); // a signed login sent a second time
  const v = await KPasskey.verifyAssertion({ public_key: row.public_key, alg: row.alg }, d,
    { challenge: KPasskey.challengeOf(d.client_data), origins: origins(env) });
  if (!v.ok) return refuse(v.error);
  const prev = Number(row.sign_count) || 0;
  if (prev > 0 && v.sign_count <= prev) return refuse('penghitung mundur'); // a copied key: its counter went back
  await adapter.run('UPDATE pos_passkeys SET sign_count = ?, last_t = ?, last_used_at = ? WHERE id = ?', [v.sign_count, ch.t, new Date(nowMs).toISOString(), row.id]);
  const keep = {}; // what an ordinary login sends besides the credentials (the device), never the passkey's answer
  if (d.device !== undefined) keep.device = d.device;
  return { login: { user: str(me.name), pin_hash: str(me.pin_hash), data: keep } };
}

/** passkey_add / passkey_list / passkey_remove — after the normal gate let the request through. */
export async function passkeyAction(adapter, text, env, { nowMs = Date.now() } = {}) {
  const b = bodyOf(text), d = dataOf(b), action = str(b.action);
  await ensurePosSchema(adapter);
  const me = await findUser(adapter, b.user);
  if (!me) return fail('BAD_PIN', 'Nama atau PIN salah');
  // the person's own PIN only: the owner's master code opens an account, it never gives it a passkey
  if (!isHash(b.pin_hash) || !safeEqual(str(me.pin_hash), str(b.pin_hash))) return fail('FORBIDDEN', 'Hanya dengan PIN sendiri');
  if (me.must_change === 1 || me.must_change === true || me.must_change === '1' || me.must_change === 'true') return fail('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
  const owner = str(me.role) === 'owner';

  if (action === 'passkey_add') {
    if (PASSKEY_ROLES.indexOf(str(me.role)) < 0) return fail('FORBIDDEN', 'Akun kasir tetap memakai PIN (perangkat kasir dipakai bersama)');
    const r = { cred_id: str(d.cred_id), public_key: str(d.public_key), alg: Number(d.alg), client_data: str(d.client_data), authenticator_data: str(d.authenticator_data) };
    const c = await KPasskey.checkCreate(r, { origins: origins(env) });
    if (!c.ok) return fail('INVALID', 'Sidik jari / wajah tidak bisa diaktifkan (' + c.error + ')');
    const same = (await adapter.all('SELECT id, user_id FROM pos_passkeys WHERE cred_id = ?', [r.cred_id]))[0];
    if (same && Number(same.user_id) !== Number(me.id)) return fail('INVALID', 'Sidik jari / wajah tidak bisa diaktifkan');
    const at = new Date(nowMs).toISOString(), device = cleanLabel(d.label) || 'Perangkat';
    if (same) await adapter.run('DELETE FROM pos_passkeys WHERE id = ?', [same.id]); // made again on the same phone: the new one counts
    const mine = await adapter.all('SELECT id FROM pos_passkeys WHERE user_id = ? ORDER BY created_at, id', [me.id]);
    for (const x of mine.slice(0, Math.max(0, mine.length - (MAX_PER_USER - 1)))) await adapter.run('DELETE FROM pos_passkeys WHERE id = ?', [x.id]); // the oldest go
    await adapter.run('INSERT INTO pos_passkeys (cred_id, user_id, user, public_key, alg, sign_count, last_t, device, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [r.cred_id, me.id, str(me.name), r.public_key, r.alg, 0, 0, device, at, '']);
    await logSecurity(adapter, me, 'Masuk dengan sidik jari / wajah diaktifkan untuk akun ' + str(me.name) + ' di ' + device, 'warn', nowMs);
    return { ok: true, passkey: { cred_id: r.cred_id, device, created_at: at } };
  }

  if (action === 'passkey_list') {
    // the owner sees every account's passkeys (to remove a lost phone's); everyone else only his own
    const rows = owner ? await adapter.all('SELECT cred_id, user_id, user, device, created_at, last_used_at FROM pos_passkeys ORDER BY created_at DESC LIMIT 200', [])
      : await adapter.all('SELECT cred_id, user_id, user, device, created_at, last_used_at FROM pos_passkeys WHERE user_id = ? ORDER BY created_at DESC', [me.id]);
    const names = owner ? new Map((await adapter.all('SELECT id, name FROM pos_users', [])).map((u) => [Number(u.id), str(u.name)])) : null;
    return {
      ok: true,
      passkeys: rows.map((x) => ({ cred_id: str(x.cred_id), user: owner ? names.get(Number(x.user_id)) || str(x.user) : str(me.name), mine: Number(x.user_id) === Number(me.id),
        device: str(x.device), created_at: str(x.created_at), last_used_at: str(x.last_used_at) })),
    };
  }

  if (action === 'passkey_remove') {
    const row = (await adapter.all('SELECT id, user_id, user, device FROM pos_passkeys WHERE cred_id = ?', [str(d.cred_id)]))[0];
    if (!row) return { ok: true, removed: 0 }; // already gone
    if (Number(row.user_id) !== Number(me.id) && !owner) return fail('FORBIDDEN', 'Hanya pemilik');
    await adapter.run('DELETE FROM pos_passkeys WHERE id = ?', [row.id]);
    await logSecurity(adapter, me, 'Masuk dengan sidik jari / wajah dimatikan untuk akun ' + str(row.user) + ' di ' + str(row.device) +
      (Number(row.user_id) !== Number(me.id) ? ' (oleh ' + str(me.name) + ')' : ''), 'warn', nowMs);
    return { ok: true, removed: 1 };
  }
  return fail('INVALID', 'Aksi tidak dikenal');
}

/** After an ok change_pin / save_user: a new PIN, or an account switched off, removes that account's passkeys. */
export async function passkeyAfterUserChange(adapter, text, nowMs = Date.now()) {
  const b = bodyOf(text), d = dataOf(b), action = str(b.action);
  let name = '';
  if (action === 'change_pin') name = str(b.user);
  else if (action === 'save_user' && (isHash(d.pin_hash) || d.active === false)) name = str(d.new_name) || str(d.name);
  if (!name) return 0;
  try {
    const u = (await adapter.all('SELECT id, name, role FROM pos_users', [])).find((x) => str(x.name).toLowerCase() === name.toLowerCase());
    if (!u) return 0;
    const r = await adapter.run('DELETE FROM pos_passkeys WHERE user_id = ?', [u.id]);
    const n = Number(r && r.changes) || 0;
    if (n) await logSecurity(adapter, u, 'Masuk dengan sidik jari / wajah dimatikan untuk akun ' + str(u.name) + ' (' + (action === 'change_pin' || isHash(d.pin_hash) ? 'PIN diganti' : 'akun nonaktif') + ')', 'info', nowMs);
    return n;
  } catch (e) { return 0; } // no pos_passkeys yet (a database before v77): nothing to remove
}
