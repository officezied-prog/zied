/* Khair Mart — the offline PIN check kept on a device (v71 security, owner 2026-10-21: «حماية التطبيق حتى لا يتمكن أي شخص من اختراقه
   … سرية تامة»). So that a cashier / rep can log in while the internet is down, the apps keep a CHECK of their PIN on the device (never
   the PIN, never the hash the server takes). Until v71 it was one quick SHA-256 for EVERY person who logged in on the device — the
   owner's too — and whoever held the phone could find a 4–6 digit PIN from it in seconds. Now:
   - only the people who must work offline keep one: each app says whose (Khair Kasir → kasir, Khair Sales → sales, the owner app →
     manager, who may sell there); the owner's and the accountant's are removed from every device at start;
   - it is PBKDF2-SHA-256, 150,000 rounds, with a random salt of this device — slow to guess, where it took seconds;
   - an older quick check still lets its person in (offline too) and is replaced at once by the slow one.
   The three apps share one storage ('kpos.pins'), so each app writes and accepts only its own roles and never removes another's.
     KPin.prune(store)                          — at start: drop the owner's / accountant's, upgrade a stored raw hash
     KPin.remember(store, user, hash, role, roles)
     KPin.check(store, user, hash, roles)       → Promise<{ role } | null> */
(function () {
  'use strict';
  if (window.KPin) return;
  var ITER = 150000, OFFLINE_ROLES = ['kasir', 'sales', 'manager'];
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function enc(s) { return new TextEncoder().encode(String(s)); }
  function quick(hash) { return crypto.subtle.digest('SHA-256', enc('offline:' + hash)).then(hex); } // the pre-v71 check
  function salt(store) {
    var s = String(store.get('pin_salt', '') || '');
    if (!/^[0-9a-f]{32}$/.test(s)) { var a = new Uint8Array(16); crypto.getRandomValues(a); s = hex(a.buffer); store.set('pin_salt', s); }
    return s;
  }
  function slow(store, hash) {
    return crypto.subtle.importKey('raw', enc('offline:' + hash), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) { return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt(store)), iterations: ITER }, k, 256); })
      .then(hex);
  }
  function pins(store) { var p = store.get('pins', {}); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; }
  function key(user) { return String(user || '').toLowerCase(); }

  async function prune(store) {
    var p = pins(store), changed = false;
    for (var k of Object.keys(p)) {
      var e = p[k] || {};
      if (OFFLINE_ROLES.indexOf(String(e.role || '')) < 0) { delete p[k]; changed = true; continue; }
      if (e.h) { p[k] = { v: 2, o: await slow(store, e.h), role: e.role }; changed = true; } // a raw hash from a very old version
    }
    if (changed) store.set('pins', p);
  }
  async function remember(store, user, hash, role, roles) {
    var p = pins(store), k = key(user);
    if ((roles || []).indexOf(String(role || '')) < 0 || OFFLINE_ROLES.indexOf(String(role || '')) < 0) {
      if (p[k] && (roles || []).indexOf(String(p[k].role || '')) >= 0) { delete p[k]; store.set('pins', p); } // e.g. the role changed
      return;
    }
    p[k] = { v: 2, o: await slow(store, hash), role: role };
    store.set('pins', p);
  }
  async function check(store, user, hash, roles) {
    var p = pins(store), k = key(user), e = p[k];
    if (!e || !e.o || (roles || []).indexOf(String(e.role || '')) < 0) return null;
    if (e.v === 2) return (await slow(store, hash)) === e.o ? { role: e.role } : null;
    if ((await quick(hash)) !== e.o) return null;
    await remember(store, user, hash, e.role, roles); // the old quick check: replaced by the slow one now
    return { role: e.role };
  }
  window.KPin = { prune: prune, remember: remember, check: check, ITER: ITER };
})();
