/* Khair Mart POS — chat demo backend (?mock=1). Loaded only in demo mode, together with
   backend/chat/chat-core.js. Runs the SAME core as the server (KChat.core) against the app's
   local mock DB (kmock.db), so the demo behaves like the real Chat workflow. */
(function () {
  'use strict';
  var ACTIONS = ['chat_bootstrap', 'chat_poll', 'chat_send', 'chat_set_retention'];

  function back(iso, sec) { return new Date(Date.parse(iso) - sec * 1000).toISOString(); }

  function ensureSeed(db, nowIso) {
    if (!Array.isArray(db.chat)) {
      db._chatSeeded = true;
      db.chat = [
        { id: 1, channel: 'general', cid: 'seed1', from_user: 'Siti', from_name: 'Siti', from_role: 'kasir', body: 'Selamat pagi semua 🌿', image: '', created_at: back(nowIso, 7200), deleted: false },
        { id: 2, channel: 'general', cid: 'seed2', from_user: 'zied salah', from_name: 'zied salah', from_role: 'owner', body: 'Pagi, semangat! Stok gula hampir habis ya.', image: '', created_at: back(nowIso, 5400), deleted: false },
        { id: 3, channel: 'owner_mgr', cid: 'seed3', from_user: 'zied salah', from_name: 'zied salah', from_role: 'owner', body: 'Tolong kirim laporan kas sore ini.', image: '', created_at: back(nowIso, 3600), deleted: false }
      ];
    }
    if (typeof db.chat_seq !== 'number') db.chat_seq = db.chat.reduce(function (m, x) { return Math.max(m, Number(x.id) || 0); }, 0);
  }

  function settingsRows(db) {
    var s = db.settings || {}, rows = [];
    rows.push({ id: 'la', skey: 'locked_accounts', svalue: typeof s.locked_accounts === 'string' ? s.locked_accounts : JSON.stringify(s.locked_accounts || []) });
    rows.push({ id: 'ret', skey: 'chat_retention_days', svalue: String(s.chat_retention_days || 0) });
    return rows;
  }

  window.KChatMock = {
    actions: ACTIONS,
    handle: function (db, body, mkErr) {
      if (!window.KChat || typeof window.KChat.core !== 'function') throw mkErr('SERVER', 'Chat core (backend/chat/chat-core.js) not loaded');
      var nowIso = new Date().toISOString();
      ensureSeed(db, nowIso);
      var seeded = db._chatSeeded === true; delete db._chatSeeded;
      var state = { key_ok: true, users: db.users || [], settings: settingsRows(db), chat: db.chat };
      var r = window.KChat.core(state, { action: body.action, user: body.user, pin_hash: body.pin_hash, data: body.data || {} }, nowIso);
      if (!r.response || r.response.ok !== true) throw mkErr(r.response ? r.response.error : 'SERVER', r.response ? r.response.message : 'error');
      (r.writes || []).forEach(function (w) {
        var row = Object.assign({}, w.row); delete row._id;
        if (w.table === 'chat') {
          row.id = ++db.chat_seq; db.chat.push(row);
          if (r.response.message && r.response.message.cid === row.cid) r.response.message.id = row.id;
        } else if (w.table === 'settings') {
          db.settings = db.settings || {};
          db.settings[row.skey] = row.skey === 'chat_retention_days' ? (Number(row.svalue) || 0) : row.svalue;
        }
      });
      // persist only when something actually changed (seed or a write) — reads must not trigger a save that could clobber state
      if (seeded || (r.writes && r.writes.length)) db._dirty = true;
      return r.response;
    }
  };
})();
