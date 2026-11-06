/* Khair Mart — opening the app with the phone's own fingerprint or face (v77, owner 2026-11-06: «هل يمكن ان يتم الفتح ببصمة او
   بالوجه», his choice «أ»: the phone's own lock — fingerprint, face unlock, Face ID, Windows Hello — for the owner, the manager, the
   accountant and the sales reps, each on his own phone; the cashiers' shared device keeps its PIN).
   A passkey (WebAuthn): the phone makes a key pair whose private half never leaves its secure hardware and is used only after the
   fingerprint / face check; the server keeps the public half and checks each login's signature. No fingerprint or face ever leaves
   the phone, nothing usable is stored in the app, and the PIN stays as the way in without internet or on a new phone.
   One file for three places: the owner app and Khair Sales (window.KPasskey, the browser half) and the Worker (worker/build.js
   turns it into src/generated/passkey.gen.js; the checks only). The checks are pure — WebCrypto, no storage, no network.
     KPasskey.b64u(bytes) / unb64u(text)          base64url without padding ⇄ Uint8Array (null when not base64url)
     KPasskey.makeChallenge(secret, uid, nowMs)     a login challenge for user `uid`, signed by the server (HMAC): no row is written
     KPasskey.readChallenge(secret, token, nowMs)   → { uid, t } when the server made it less than 3 minutes ago, else null
     KPasskey.challengeOf(clientData)               the challenge a signed login answers (from its client data), '' when unreadable
     KPasskey.verifyAssertion(key, a, expect)       a login's signature: { ok, sign_count } or { ok: false, error }
     KPasskey.checkCreate(r, expect)                a new passkey: { ok } or { ok: false, error }
     KPasskey.available() / register(o) / sign(o)   the browser: can this device do it; make one; sign a login (fingerprint / face) */
var KPasskey = (function () {
  'use strict';
  var ALGS = { '-7': 'ES256', '-257': 'RS256' }; // what platform authenticators make (phones: ES256; Windows Hello: RS256)
  var CHALLENGE_MS = 3 * 60000;
  var enc = function (s) { return new TextEncoder().encode(String(s)); };
  var dec = function (b) { try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { return null; } };
  var C = function () { return typeof crypto !== 'undefined' ? crypto : null; };

  var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64u(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), out = '', i;
    for (i = 0; i + 2 < b.length; i += 3) { var n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]; out += A[n >> 18 & 63] + A[n >> 12 & 63] + A[n >> 6 & 63] + A[n & 63]; }
    if (b.length - i === 1) { var m = b[i] << 16; out += A[m >> 18 & 63] + A[m >> 12 & 63]; }
    else if (b.length - i === 2) { var k = (b[i] << 16) | (b[i + 1] << 8); out += A[k >> 18 & 63] + A[k >> 12 & 63] + A[k >> 6 & 63]; }
    return out;
  }
  function unb64u(s) {
    s = String(s == null ? '' : s).replace(/=+$/, '');
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
    var out = new Uint8Array(Math.floor(s.length * 3 / 4)), o = 0, acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      acc = (acc << 6) | A.indexOf(s[i]); bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
    }
    return out;
  }
  function same(a, b) { // equal bytes, in a time that does not depend on where they differ
    if (!a || !b || a.length !== b.length) return false;
    var d = 0; for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  async function sha256(bytes) { return new Uint8Array(await C().subtle.digest('SHA-256', bytes)); }
  async function hmac(secret, text) {
    var k = await C().subtle.importKey('raw', enc('khair-passkey:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64u(new Uint8Array(await C().subtle.sign('HMAC', k, enc(text))));
  }

  /* The login challenge: 'k1.<uid>.<ms>.<random>.<hmac>' — the server's own signature, so nothing is written to make or keep it.
     The phone signs these bytes; a challenge is good for 3 minutes, and the server keeps, per passkey, the time of the last one used
     (a challenge not newer than that is refused, so a signed login can never be sent again). */
  async function makeChallenge(secret, uid, nowMs) {
    var r = new Uint8Array(16); C().getRandomValues(r);
    var body = ['k1', String(uid), String(Math.floor(nowMs)), b64u(r)].join('.');
    return body + '.' + await hmac(secret, body);
  }
  async function readChallenge(secret, token, nowMs) {
    var p = String(token || '').split('.');
    if (p.length !== 5 || p[0] !== 'k1' || !/^\d{1,12}$/.test(p[1]) || !/^\d{1,15}$/.test(p[2])) return null;
    var body = p.slice(0, 4).join('.'), mac = unb64u(p[4]), want = unb64u(await hmac(secret, body));
    if (!same(mac, want)) return null;
    var t = Number(p[2]);
    if (!(t <= nowMs + 30000 && nowMs - t <= CHALLENGE_MS)) return null; // a little clock slack ahead, 3 minutes behind
    return { uid: Number(p[1]), t: t };
  }
  function clientDataOf(b64) {
    var raw = unb64u(b64), text = raw && dec(raw);
    if (!text) return null;
    try { var c = JSON.parse(text); return c && typeof c === 'object' ? c : null; } catch (e) { return null; }
  }
  function challengeOf(b64) {
    var c = clientDataOf(b64), ch = c && unb64u(c.challenge);
    return (ch && dec(ch)) || '';
  }

  // ECDSA signatures come DER-encoded (SEQUENCE of two INTEGERs); WebCrypto wants r ‖ s, 32 bytes each
  function derToRaw(sig) {
    if (sig.length === 64) return sig;
    var i = 0, out = new Uint8Array(64);
    if (sig[i++] !== 0x30) return null;
    var len = sig[i++];
    if (len & 0x80) { var n = len & 0x7f; len = 0; while (n--) len = (len << 8) | sig[i++]; }
    if (i + len !== sig.length) return null;
    for (var part = 0; part < 2; part++) {
      if (sig[i++] !== 0x02) return null;
      var l = sig[i++], v = sig.subarray(i, i + l); i += l;
      if (v.length !== l) return null;
      while (v.length > 32 && v[0] === 0) v = v.subarray(1);
      if (v.length > 32) return null;
      out.set(v, part * 32 + (32 - v.length));
    }
    return i === sig.length ? out : null;
  }
  async function importKey(spki, alg) {
    var a = String(alg);
    if (a === '-7') return C().subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (a === '-257') return C().subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    throw new Error('alg');
  }
  async function verifySig(key, sig, data) {
    var spki = unb64u(key && key.public_key);
    if (!spki || !ALGS[String(key.alg)]) return false;
    try {
      var k = await importKey(spki, key.alg);
      if (String(key.alg) === '-7') { var raw = derToRaw(sig); return !!raw && await C().subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, raw, data); }
      return await C().subtle.verify('RSASSA-PKCS1-v1_5', k, sig, data);
    } catch (e) { return false; }
  }
  // the page that asked must be one of ours; the passkey is bound to its host name (the "relying party")
  function originOk(c, origins) { return !!c && typeof c.origin === 'string' && (origins || []).indexOf(c.origin) >= 0 && c.crossOrigin !== true; }
  async function rpOk(ad, origin) {
    var host; try { host = new URL(origin).hostname; } catch (e) { return false; }
    return same(ad.subarray(0, 32), await sha256(enc(host)));
  }
  var bad = function (error) { return { ok: false, error: error }; };

  /** A login: the passkey { public_key, alg }; the phone's answer { authenticator_data, client_data, signature } (base64url);
   *  expect { challenge (the token string), origins }. The phone must have checked the person (fingerprint / face / screen lock). */
  async function verifyAssertion(key, a, expect) {
    a = a || {}; expect = expect || {};
    var ad = unb64u(a.authenticator_data), cdRaw = unb64u(a.client_data), sig = unb64u(a.signature), c = clientDataOf(a.client_data);
    if (!ad || ad.length < 37 || !cdRaw || !sig || !sig.length || !c) return bad('FORMAT');
    if (c.type !== 'webauthn.get') return bad('TYPE');
    if (!expect.challenge || challengeOf(a.client_data) !== expect.challenge) return bad('CHALLENGE');
    if (!originOk(c, expect.origins)) return bad('ORIGIN');
    if (!await rpOk(ad, c.origin)) return bad('RP');
    if (!(ad[32] & 0x01)) return bad('PRESENCE');
    if (!(ad[32] & 0x04)) return bad('VERIFY'); // user verification: the fingerprint / face / screen lock was checked
    var count = ((ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36]) >>> 0;
    if (!await verifySig(key, sig, concat(ad, await sha256(cdRaw)))) return bad('SIGNATURE');
    return { ok: true, sign_count: count };
  }

  /** A new passkey made on this person's phone: { cred_id, public_key (SPKI), alg, client_data, authenticator_data } (base64url).
   *  Made inside a session opened with the person's own PIN; its client data, host, user check and key id are checked here. */
  async function checkCreate(r, expect) {
    r = r || {}; expect = expect || {};
    var id = unb64u(r.cred_id), spki = unb64u(r.public_key), ad = unb64u(r.authenticator_data), c = clientDataOf(r.client_data);
    if (!id || id.length < 16 || id.length > 1023 || !spki || spki.length < 32 || spki.length > 2048 || !ad || ad.length < 55 || !c) return bad('FORMAT');
    if (!ALGS[String(r.alg)]) return bad('ALG');
    if (c.type !== 'webauthn.create') return bad('TYPE');
    if (!originOk(c, expect.origins)) return bad('ORIGIN');
    if (!await rpOk(ad, c.origin)) return bad('RP');
    if (!(ad[32] & 0x01) || !(ad[32] & 0x04)) return bad('VERIFY');
    if (!(ad[32] & 0x40)) return bad('FORMAT'); // the new key's data must be there
    var idLen = (ad[53] << 8) | ad[54];
    if (idLen !== id.length || !same(ad.subarray(55, 55 + idLen), id)) return bad('ID');
    try { await importKey(spki, r.alg); } catch (e) { return bad('KEY'); }
    return { ok: true };
  }

  /* ---- the browser half (owner app, Khair Sales) ---- */
  function supported() {
    return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!window.isSecureContext &&
      typeof navigator !== 'undefined' && !!navigator.credentials && typeof navigator.credentials.create === 'function';
  }
  /** true when this device has its own fingerprint / face / screen-lock check for passkeys. */
  async function available() {
    if (!supported()) return false;
    try { return !!(await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch (e) { return false; }
  }
  function err(code, cause) { var e = new Error(code); e.code = code; e.cause = cause; return e; }
  // what went wrong in the browser: CANCEL (closed, refused, no match, timed out), EXISTS, NOT_SUPPORTED or FAILED
  function why(e) {
    var n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'AbortError') return 'CANCEL';
    if (n === 'InvalidStateError') return 'EXISTS';
    if (n === 'NotSupportedError' || n === 'SecurityError') return 'NOT_SUPPORTED';
    return (e && e.code) || 'FAILED';
  }
  /** Makes a passkey for `o.user` on this device (the fingerprint / face is asked). → what passkey_add needs. */
  async function register(o) {
    if (!supported()) throw err('NOT_SUPPORTED');
    var uid = (await sha256(enc('khair-passkey-user:' + String(o.user || '').toLowerCase()))).slice(0, 16); // no personal data, stable
    var ch = new Uint8Array(32); C().getRandomValues(ch);
    var cred;
    try {
      cred = await navigator.credentials.create({
        publicKey: {
          challenge: ch, rp: { name: o.rp_name || 'Khair Mart' },
          user: { id: uid, name: o.label || o.user, displayName: o.label || o.user },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred', requireResidentKey: false },
          attestation: 'none', timeout: 120000,
        },
      });
    } catch (e) { throw err(why(e), e); }
    var res = cred && cred.response;
    if (!res || typeof res.getPublicKey !== 'function' || typeof res.getAuthenticatorData !== 'function') throw err('NOT_SUPPORTED');
    var spki = res.getPublicKey();
    if (!spki) throw err('NOT_SUPPORTED');
    return {
      cred_id: b64u(new Uint8Array(cred.rawId)), public_key: b64u(new Uint8Array(spki)), alg: res.getPublicKeyAlgorithm(),
      client_data: b64u(new Uint8Array(res.clientDataJSON)), authenticator_data: b64u(new Uint8Array(res.getAuthenticatorData())),
    };
  }
  /** Signs the server's challenge with one of `o.allow` (passkey ids) on THIS device — the phone asks for the fingerprint / face. */
  async function sign(o) {
    if (!supported()) throw err('NOT_SUPPORTED');
    var cred;
    try {
      cred = await navigator.credentials.get({
        publicKey: {
          challenge: enc(o.challenge), userVerification: 'required', timeout: 120000,
          allowCredentials: (o.allow || []).map(function (id) { return { type: 'public-key', id: unb64u(id), transports: ['internal'] }; }),
        },
      });
    } catch (e) { throw err(why(e), e); }
    var res = cred && cred.response;
    if (!res) throw err('FAILED');
    return {
      cred_id: b64u(new Uint8Array(cred.rawId)), authenticator_data: b64u(new Uint8Array(res.authenticatorData)),
      client_data: b64u(new Uint8Array(res.clientDataJSON)), signature: b64u(new Uint8Array(res.signature)),
    };
  }

  return {
    ALGS: ALGS, CHALLENGE_MS: CHALLENGE_MS, b64u: b64u, unb64u: unb64u, derToRaw: derToRaw,
    makeChallenge: makeChallenge, readChallenge: readChallenge, challengeOf: challengeOf,
    verifyAssertion: verifyAssertion, checkCreate: checkCreate,
    supported: supported, available: available, register: register, sign: sign, why: why,
  };
})();
if (typeof window !== 'undefined') window.KPasskey = KPasskey;
