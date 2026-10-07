/* Khair Mart POS — Chat core (Phase 3 / v1). One source for two places:
   - the n8n workflow "Khair Mart POS – Chat" (Code node "Process Chat" = this file + process-chat.js), and
   - the demo mode of the apps (?mock=1, via shared/chat-mock.js + shared/chat-ui.js).
   Pure: no network, no storage, no clock. KChat.core(state, req, nowIso) -> { response, writes }.
     state   = { key_ok:boolean, users:[rows], settings:[{skey,svalue,id} rows], chat:[rows] }
     writes  = [{ table:'chat'|'settings', row }]  (a row with no id is inserted; with _id it updates)
   Messages are append-only (always inserted). Two channels:
     'general'   — everyone who holds the app (owner, manager, kasir, sales, akuntan)
     'owner_mgr' — private, only the owner and the manager
   Names only: the app shows the sender's name, never a role word. Auth mirrors the POS exactly
   (store key, active user, temporary PIN lock, owner master code, must-change-PIN, tamper lock). */
var KChat = (function () {
  'use strict';
  var CHANNELS = ['general', 'owner_mgr'];
  var ALL_ROLES = ['owner', 'manager', 'kasir', 'sales', 'akuntan'];
  var PRIV_ROLES = ['owner', 'manager'];
  var MSG_MAX = 2000;      // characters of text in one message
  var IMG_MAX = 180000;    // characters of the image data URL (~130 KB image, downscaled on the client)
  var PAGE = 80;           // messages returned per channel per call (most recent)

  function str(v) { return v === undefined || v === null ? '' : String(v); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function bool(v) { return v === true || v === 'true' || v === 1; }
  function norm(s) { return str(s).trim().toLowerCase(); }
  function isHash(x) { return /^[a-f0-9]{64}$/.test(str(x)); }
  /* strip control + bidi-override characters (same spirit as the POS input cleaner), keep newlines */
  function cleanText(v, max) {
    return str(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/[‪-‮⁦-⁩]/g, '').slice(0, max || MSG_MAX);
  }
  function channelsFor(role) { return PRIV_ROLES.indexOf(role) >= 0 ? ['general', 'owner_mgr'] : ['general']; }
  function canSee(role, ch) { return channelsFor(role).indexOf(ch) >= 0; }

  function settingsMap(rows) { var m = {}; (rows || []).forEach(function (r) { if (r && r.skey !== undefined && r.skey !== null) m[r.skey] = r.svalue; }); return m; }
  function lockedList(rows) {
    var a = []; try { a = JSON.parse(settingsMap(rows).locked_accounts || '[]'); } catch (e) { a = []; }
    return Array.isArray(a) ? a.map(function (x) { return norm(x); }) : [];
  }
  function retentionDays(state) { var n = num(settingsMap(state.settings).chat_retention_days); return n > 0 ? Math.floor(n) : 0; }

  function fail(code, msg) { return { response: { ok: false, error: code, message: msg }, writes: [] }; }

  /* Auth — same rules as the POS server (process.js). Returns { role, name } or an error. */
  function auth(state, req, nowMs) {
    if (state.key_ok !== true) return { err: fail('BAD_KEY', 'Kode toko salah') };
    var ph = str(req.pin_hash);
    if (!isHash(ph)) return { err: fail('BAD_PIN', 'Nama atau PIN salah') };
    var users = (state.users || []).filter(function (u) { return u && u.active !== false && u.active !== 'false'; });
    var me = users.find(function (u) { return norm(u.name) === norm(req.user); });
    if (!me) return { err: fail('BAD_PIN', 'Nama atau PIN salah') };
    if (Date.parse(me.locked_until) > nowMs) return { err: fail('LOCKED', 'Akun dikunci sementara') };
    var viaMaster = me.pin_hash !== ph && users.some(function (u) { return u.role === 'owner' && isHash(u.master_hash) && u.master_hash === ph; });
    if (me.pin_hash !== ph && !viaMaster) return { err: fail('BAD_PIN', 'Nama atau PIN salah') };
    var role = str(me.role);
    if (ALL_ROLES.indexOf(role) < 0) return { err: fail('FORBIDDEN', 'Peran tidak dikenal') };
    if (bool(me.must_change) && !viaMaster) return { err: fail('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu di aplikasi Khair Mart') };
    if (role !== 'owner' && lockedList(state.settings).indexOf(norm(me.name)) >= 0) return { err: fail('TAMPER_LOCKED', 'Akun dikunci. Hanya pemilik yang membuka.') };
    return { role: role, name: str(me.name) };
  }

  function activeMsgs(state, nowMs) {
    var ret = retentionDays(state), cut = ret > 0 ? nowMs - ret * 86400000 : -Infinity;
    return (state.chat || []).filter(function (m) {
      if (!m || !m.channel) return false;
      if (bool(m.deleted)) return false;
      if (ret > 0 && Date.parse(m.created_at) < cut) return false;
      return true;
    });
  }
  function out(m) {
    return { id: m.id !== undefined ? m.id : null, channel: str(m.channel), cid: str(m.cid), from_name: str(m.from_name || m.from_user),
      body: str(m.body), image: str(m.image), created_at: str(m.created_at) };
  }
  function sortMsgs(a) {
    return a.slice().sort(function (x, y) { return str(x.created_at).localeCompare(str(y.created_at)) || (num(x.id) - num(y.id)); });
  }
  function channelMessages(msgs, ch, after) {
    var r = sortMsgs(msgs.filter(function (m) { return str(m.channel) === ch && (!after || str(m.created_at) > after); }));
    if (r.length > PAGE) r = r.slice(r.length - PAGE);
    return r.map(out);
  }

  function core(state, req, nowIso) {
    var nowMs = Date.parse(nowIso); if (!isFinite(nowMs)) nowMs = Date.now();
    var a = auth(state, req, nowMs);
    if (a.err) return a.err;
    var role = a.role, name = a.name, data = (req.data && typeof req.data === 'object') ? req.data : {};
    var chans = channelsFor(role), action = str(req.action);

    if (action === 'chat_bootstrap' || action === 'chat_poll') {
      var msgs = activeMsgs(state, nowMs);
      var cursors = (action === 'chat_poll' && data.cursors && typeof data.cursors === 'object') ? data.cursors : {};
      var messages = {};
      chans.forEach(function (ch) {
        var after = action === 'chat_poll' ? (typeof cursors[ch] === 'string' ? cursors[ch] : '') : '';
        messages[ch] = channelMessages(msgs, ch, after);
      });
      return { response: { ok: true, me: { name: name, role: role }, channels: chans, retention_days: retentionDays(state), messages: messages, now: nowIso }, writes: [] };
    }

    if (action === 'chat_send') {
      var ch = str(data.channel) || 'general';
      if (CHANNELS.indexOf(ch) < 0) return fail('INVALID', 'Saluran tidak dikenal');
      if (!canSee(role, ch)) return fail('FORBIDDEN', 'Anda tidak boleh di saluran ini');
      var body = cleanText(data.body, MSG_MAX).replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n').trim();
      var image = str(data.image).trim();
      if (image) {
        if (image.length > IMG_MAX) return fail('INVALID', 'Gambar terlalu besar');
        if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(image)) return fail('INVALID', 'Gambar tidak valid');
      }
      if (!body && !image) return fail('INVALID', 'Pesan kosong');
      var cid = cleanText(data.cid, 40).replace(/[^A-Za-z0-9_.\-]/g, '') || ('c' + nowMs + '-' + Math.floor(Math.random() * 1e9).toString(36));
      var dup = (state.chat || []).find(function (m) { return str(m.cid) === cid; });
      if (dup) return { response: { ok: true, message: out(dup), dup: true }, writes: [] };
      var row = { channel: ch, cid: cid, from_user: name, from_name: name, from_role: role, body: body, image: image, created_at: nowIso, deleted: false };
      return { response: { ok: true, message: out(row) }, writes: [{ table: 'chat', row: row }] };
    }

    if (action === 'chat_set_retention') {
      if (role !== 'owner') return fail('FORBIDDEN', 'Hanya pemilik yang mengubah masa simpan');
      var days = Math.max(0, Math.floor(num(data.days)));
      var rowS = (state.settings || []).find(function (r) { return r && r.skey === 'chat_retention_days'; });
      var w = { skey: 'chat_retention_days', svalue: String(days) };
      if (rowS && rowS.id !== undefined && rowS.id !== null) w._id = rowS.id;
      return { response: { ok: true, retention_days: days }, writes: [{ table: 'settings', row: w }] };
    }

    return fail('UNKNOWN', 'Aksi tidak dikenal: ' + action);
  }

  return { core: core, channelsFor: channelsFor, CHANNELS: CHANNELS, MSG_MAX: MSG_MAX, IMG_MAX: IMG_MAX, PAGE: PAGE };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = KChat;
