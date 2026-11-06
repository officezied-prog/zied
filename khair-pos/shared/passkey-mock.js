/* Khair Mart — demo twin of the Worker's fingerprint / face login (v77, worker/src/passkey.js), used by the owner app's and Khair
   Sales' demo backends (?mock=1; the demo data kmock.db is shared by the demo apps of this site). The same checks (shared/passkey.js):
   the demo store's key 'demo' signs the challenges, the page's own address is the accepted origin. A kasir account never gets one.
     KPasskeyMock.is(action)                  a passkey action?
     KPasskeyMock.handle(db, body, E)         → { res } (the answer; db changed when .dirty) or { login, pin_hash } (a verified
                                                passkey: the caller runs `login` as an ordinary login and adds pin_hash / via_passkey)
     KPasskeyMock.drop(db, name)              a new PIN / an account switched off: that account's passkeys go */
window.KPasskeyMock = (function () {
  'use strict';
  var ROLES = ['owner', 'manager', 'akuntan', 'sales'], OPEN = ['passkey_begin', 'passkey_login'], ACTS = ['passkey_add', 'passkey_list', 'passkey_remove'];
  var lc = function (v) { return String(v == null ? '' : v).trim().toLowerCase(); };
  var on = function (u) { return u && u.active !== false; };
  function idOf(db, u) { return db.users.indexOf(u) + 1; } // demo accounts are never deleted
  function log(db, u, summary) {
    db.activity = db.activity || [];
    var now = new Date(), act = { id: db.activity.reduce(function (m, x) { return Math.max(m, Number(x.id) || 0); }, 0) + 1, act_id: 'AC' + Math.random().toString(36).slice(2, 10).toUpperCase(), at: now.toISOString(), act_date: new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10), user: u.name, role: u.role, kind: 'keamanan', summary: summary, ref: u.name, amount: 0, level: 'warn' };
    db.activity.push(act);
  }
  function is(action) { return OPEN.indexOf(action) >= 0 || ACTS.indexOf(action) >= 0; }
  function drop(db, name) {
    var before = (db.passkeys || []).length;
    db.passkeys = (db.passkeys || []).filter(function (p) { return p.user !== lc(name); });
    return before - db.passkeys.length;
  }
  async function handle(db, body, E) {
    var a = body.action, d = body.data && typeof body.data === 'object' ? body.data : {}, now = Date.now(), origins = [location.origin];
    if (body.key !== 'demo') throw E('BAD_KEY', 'Store key not found');
    db.passkeys = db.passkeys || [];
    var u = (db.users || []).find(function (x) { return on(x) && lc(x.name) === lc(body.user); });
    if (OPEN.indexOf(a) >= 0) {
      if (!u || ROLES.indexOf(u.role) < 0) throw E('NO_PASSKEY', 'Sidik jari / wajah belum aktif untuk akun ini. Masuk dengan PIN.');
      if (Date.parse(u.locked_until) > now) throw E('LOCKED', 'Terlalu banyak PIN salah.', { locked_until: u.locked_until });
      var mine = db.passkeys.filter(function (p) { return p.user === lc(u.name); });
      if (a === 'passkey_begin') {
        if (!mine.length) throw E('NO_PASSKEY', 'Sidik jari / wajah belum aktif untuk akun ini. Masuk dengan PIN.');
        return { res: { challenge: await KPasskey.makeChallenge('demo', idOf(db, u), now), allow: mine.map(function (p) { return p.cred_id; }) } };
      }
      var row = mine.find(function (p) { return p.cred_id === String(d.cred_id || ''); });
      if (!row) throw E('PASSKEY_GONE', 'Sidik jari / wajah di perangkat ini sudah tidak berlaku.');
      var token = KPasskey.challengeOf(d.client_data), ch = await KPasskey.readChallenge('demo', token, now);
      if (!ch || ch.uid !== idOf(db, u)) throw E('PASSKEY_EXPIRED', 'Waktu habis. Coba lagi.');
      var v = ch.t > (row.last_t || 0) ? await KPasskey.verifyAssertion(row, d, { challenge: token, origins: origins }) : { ok: false };
      if (!v.ok || (row.sign_count > 0 && v.sign_count <= row.sign_count)) throw E('PASSKEY_FAIL', 'Sidik jari / wajah ditolak. Masuk dengan PIN.');
      Object.assign(row, { sign_count: v.sign_count, last_t: ch.t, last_used_at: new Date(now).toISOString() });
      return { login: { action: 'login', key: 'demo', user: u.name, pin_hash: u.pin_hash, data: d.device ? { device: d.device } : {} }, pin_hash: u.pin_hash, dirty: true };
    }
    if (!u) throw E('BAD_PIN', 'Nama atau PIN salah');
    if (u.pin_hash !== body.pin_hash) throw E('FORBIDDEN', 'Hanya dengan PIN sendiri');
    if (u.must_change === true) throw E('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
    if (a === 'passkey_add') {
      if (ROLES.indexOf(u.role) < 0) throw E('FORBIDDEN', 'Akun kasir tetap memakai PIN (perangkat kasir dipakai bersama)');
      var c = await KPasskey.checkCreate(d, { origins: origins });
      if (!c.ok) throw E('INVALID', 'Sidik jari / wajah tidak bisa diaktifkan (' + c.error + ')');
      var label = String(d.label || '').replace(/[^\p{L}\p{N} ._,·:/()+-]/gu, '').slice(0, 80) || 'Perangkat', at = new Date(now).toISOString();
      db.passkeys = db.passkeys.filter(function (p) { return p.cred_id !== d.cred_id; });
      db.passkeys.push({ cred_id: String(d.cred_id), user: lc(u.name), user_name: u.name, public_key: String(d.public_key), alg: Number(d.alg), sign_count: 0, last_t: 0, device: label, created_at: at, last_used_at: '' });
      var own = db.passkeys.filter(function (p) { return p.user === lc(u.name); });
      if (own.length > 10) db.passkeys = db.passkeys.filter(function (p) { return own.slice(0, own.length - 10).indexOf(p) < 0; });
      log(db, u, 'Masuk dengan sidik jari / wajah diaktifkan untuk akun ' + u.name + ' di ' + label);
      return { res: { passkey: { cred_id: String(d.cred_id), device: label, created_at: at } }, dirty: true };
    }
    var owner = u.role === 'owner';
    if (a === 'passkey_list') {
      var rows = db.passkeys.filter(function (p) { return owner || p.user === lc(u.name); }).slice().reverse();
      return { res: { passkeys: rows.map(function (p) { return { cred_id: p.cred_id, user: p.user_name, mine: p.user === lc(u.name), device: p.device, created_at: p.created_at, last_used_at: p.last_used_at }; }) } };
    }
    if (a === 'passkey_remove') {
      var r = db.passkeys.find(function (p) { return p.cred_id === String(d.cred_id || ''); });
      if (!r) return { res: { removed: 0 } };
      if (r.user !== lc(u.name) && !owner) throw E('FORBIDDEN', 'Hanya pemilik');
      db.passkeys = db.passkeys.filter(function (p) { return p !== r; });
      log(db, u, 'Masuk dengan sidik jari / wajah dimatikan untuk akun ' + r.user_name + ' di ' + r.device + (r.user !== lc(u.name) ? ' (oleh ' + u.name + ')' : ''));
      return { res: { removed: 1 }, dirty: true };
    }
    throw E('INVALID', 'Aksi tidak dikenal');
  }
  return { is: is, handle: handle, drop: drop, ROLES: ROLES };
})();
