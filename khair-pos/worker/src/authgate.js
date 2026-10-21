// v71 security (owner 2026-10-21: «حماية التطبيق حتى لا يتمكن أي شخص من اختراقه … يجب أن يكون محاط بسرية تامة»): ONE gate in
// front of every app's endpoint (POS, field, chat, attendance, photo + its file GET, cold, Brad), before any table is read.
//  - the store key first, compared in constant time, with NO database read: a wrong key costs nothing (before, every request
//    read the whole products / customers / settings tables before it was refused — a flood could use up the free plan's daily
//    reads and stop every app at once, with no login at all);
//  - then the user's PIN, against pos_users only (a handful of rows). A wrong PIN is counted on EVERY endpoint (before, only the
//    POS counted, so a PIN could be tried without limit on the others) and the account is locked, longer each time:
//    5 wrong → 15 minutes, 10 → 1 hour, 15 → 6 hours, 20 and more → 24 hours (each further 5 wrong locks again). A right PIN
//    resets the count. Every lock is written to the owner's activity log (kind 'keamanan', level 'danger').
//  - the handlers keep all their own checks (roles, must_change, tamper lock …): the gate only refuses earlier and cheaper.
// The owner's master code opens every account, as in the handlers.

export const LOCK_TIERS = [[20, 24 * 60], [15, 6 * 60], [10, 60], [5, 15]]; // [wrong PINs in a row, minutes locked]

/** Minutes to lock after `fails` wrong PINs in a row: on every 5th (5, 10, 15 …), longer by tier; 0 = not now. */
export function lockMinutes(fails) {
  const n = Number(fails) || 0;
  if (n < 5 || n % 5 !== 0) return 0;
  for (const [at, min] of LOCK_TIERS) if (n >= at) return min;
  return 0;
}

/** Equal strings in a time that does not depend on where they differ (the length may show). */
export function safeEqual(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  let d = a.length ^ b.length;
  for (let i = 0, n = Math.max(a.length, b.length); i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const isHash = (h) => /^[a-f0-9]{64}$/.test(String(h || ''));
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const fail = (error, message, extra) => Object.assign({ ok: false, error, message }, extra || {});
// "14:05 WIB", or "22/10 14:05 WIB" when it is not today in Jakarta
function wib(iso, nowMs) {
  const t = new Date(Date.parse(iso) + 7 * 3600000).toISOString(), n = new Date(nowMs + 7 * 3600000).toISOString();
  return (t.slice(0, 10) === n.slice(0, 10) ? '' : t.slice(8, 10) + '/' + t.slice(5, 7) + ' ') + t.slice(11, 16) + ' WIB';
}
const lockedMsg = (until, nowMs) => fail('LOCKED', 'Terlalu banyak PIN salah. Coba lagi ' + wib(until, nowMs), { locked_until: until });

/** The credentials of a request body (JSON text, as every app sends) — anything else has no key. */
export function credsOf(text) {
  let b = null;
  if (typeof text === 'string') { try { b = JSON.parse(text); } catch (e) { b = null; } } else b = text;
  if (!b || typeof b !== 'object' || Array.isArray(b)) b = {};
  return { key: b.key, user: b.user, pin_hash: b.pin_hash, action: str(b.action) };
}

/**
 * null = let the request through to its handler; otherwise the refusal to send back.
 * creds: { key, user, pin_hash, action }; route: 'pos' | 'field' | 'chat' | 'att' | 'photo' | 'photo-file' | 'cold' | 'brad'.
 */
export async function authGate(adapter, creds, STORE_KEY, { route = 'pos', nowMs = Date.now(), ip = '' } = {}) {
  if (typeof creds.key !== 'string' || !creds.key || !safeEqual(creds.key, STORE_KEY)) return fail('BAD_KEY', 'Kunci toko salah');
  // the POS login list and the very first owner (no PIN exists yet) need only the store key, as before
  if (route === 'pos' && (creds.action === 'users' || creds.action === 'setup')) return null;
  const users = (await adapter.all('SELECT id, name, role, pin_hash, master_hash, active, fail_count, locked_until FROM pos_users', []))
    .filter((u) => u && u.active !== 0 && u.active !== false && u.active !== '0' && u.active !== 'false');
  if (!users.length) return null; // no account yet: the handler answers (NO_USERS / setup)
  const name = str(creds.user).toLowerCase(), ph = str(creds.pin_hash);
  const me = name ? users.find((u) => str(u.name).toLowerCase() === name) : null;
  if (!me || !isHash(ph)) return fail('BAD_PIN', 'Nama atau PIN salah');
  if (Date.parse(me.locked_until) > nowMs) return lockedMsg(str(me.locked_until), nowMs);
  const own = safeEqual(me.pin_hash, ph);
  const viaMaster = !own && users.some((u) => u.role === 'owner' && isHash(u.master_hash) && safeEqual(u.master_hash, ph));
  if (own || viaMaster) {
    if ((Number(me.fail_count) || 0) > 0 || str(me.locked_until)) await adapter.run('UPDATE pos_users SET fail_count = 0, locked_until = ? WHERE id = ?', ['', me.id]);
    return null;
  }
  // wrong PIN: counted in the database itself (two phones at once cannot both read the old count)
  await adapter.run('UPDATE pos_users SET fail_count = COALESCE(fail_count, 0) + 1 WHERE id = ?', [me.id]);
  const fc = Number(((await adapter.all('SELECT fail_count FROM pos_users WHERE id = ?', [me.id]))[0] || {}).fail_count) || 0;
  const mins = lockMinutes(fc);
  if (mins) {
    const until = new Date(nowMs + mins * 60000).toISOString(), at = new Date(nowMs).toISOString();
    await adapter.run('UPDATE pos_users SET locked_until = ? WHERE id = ?', [until, me.id]);
    try {
      await adapter.run('INSERT INTO pos_activity (act_id, at, act_date, user, role, kind, summary, ref, amount, level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        'AC' + Math.random().toString(36).slice(2, 10).toUpperCase(), at, new Date(nowMs + 7 * 3600000).toISOString().slice(0, 10), str(me.name), str(me.role), 'keamanan',
        'PIN salah ' + fc + ' kali berturut-turut untuk akun ' + str(me.name) + ' — dikunci ' + (mins >= 60 ? mins / 60 + ' jam' : mins + ' menit') +
        ' (sampai ' + wib(until, nowMs) + ')' + (ip ? ' · jaringan ' + str(ip).slice(0, 45) : '') + ' · aplikasi ' + route,
        str(me.name), 0, 'danger']);
    } catch (e) { /* the lock itself is what matters */ }
    return lockedMsg(until, nowMs);
  }
  const left = 5 - (fc % 5);
  return fail('BAD_PIN', 'Nama atau PIN salah' + (left <= 2 ? ' (' + left + ' kali lagi, lalu akun dikunci)' : ''));
}
