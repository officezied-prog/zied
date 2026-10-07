/* Khair Mart POS — in-app chat panel (Phase 3). Self-contained, framework-free: mounts a floating
   launcher + a slide-in panel on document.body, so the three apps (owner / kasir / sales) all use it
   the same way. The app only provides a chat API wrapper and the language.

   Usage:
     KChatUI.start({ api: (action, data) => Promise<response>, lang: 'id' | 'ar' });
     KChatUI.setLang('ar');       // when the user switches language
     KChatUI.stop();              // on logout

   `api('chat_bootstrap')` / `api('chat_poll', {cursors})` / `api('chat_send', {channel, body, image, cid})`
   mirror backend/chat/chat-core.js. Channels: 'general' (everyone) and 'owner_mgr' (owner + manager).
   Names only — the panel shows the sender's name, never a role word. */
(function () {
  'use strict';
  var IMG_MAX = 180000, MAX_DIM = 900, Q = 0.55;
  var POLL_OPEN = 4000, POLL_IDLE = 20000;

  var T = {
    id: { title: 'Obrolan', general: 'Umum', owner_mgr: 'Pemilik & Manajer', send: 'Kirim', ph: 'Tulis pesan…',
      img: 'Gambar', empty: 'Belum ada pesan.', you: 'Anda', close: 'Tutup', today: 'Hari ini', yesterday: 'Kemarin',
      sending: 'mengirim…', failed: 'gagal', big: 'Gambar terlalu besar — coba foto lebih kecil.', retry: 'Coba lagi',
      locked: 'Akun terkunci.', offline: 'Luring — pesan menunggu.' },
    ar: { title: 'المحادثة', general: 'عام', owner_mgr: 'المالك والمدير', send: 'إرسال', ph: 'اكتب رسالة…',
      img: 'صورة', empty: 'لا توجد رسائل بعد.', you: 'أنت', close: 'إغلاق', today: 'اليوم', yesterday: 'أمس',
      sending: 'يُرسل…', failed: 'فشل', big: 'الصورة كبيرة جداً — جرّب صورة أصغر.', retry: 'إعادة',
      locked: 'الحساب مقفل.', offline: 'غير متصل — الرسالة تنتظر.' }
  };

  var S = null; // state while running

  function tr(k) { var L = T[S && S.lang === 'ar' ? 'ar' : 'id']; return L[k] || k; }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function esc(s) { return String(s == null ? '' : s); }
  function uuid() { return 'c' + Date.now() + '-' + Math.floor(Math.random() * 1e9).toString(36); }
  function store(key, val) { try { if (val === undefined) { var v = localStorage.getItem('kchat.' + key); return v ? JSON.parse(v) : null; } localStorage.setItem('kchat.' + key, JSON.stringify(val)); } catch (e) { return null; } }

  function injectCss() {
    if (document.getElementById('kchat-css')) return;
    var css = document.createElement('style'); css.id = 'kchat-css';
    css.textContent = [
      '.kchat-fab{position:fixed;inset-inline-end:16px;bottom:16px;z-index:2147483000;width:52px;height:52px;border-radius:50%;',
      'border:none;background:#0a7d4b;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center}',
      '.kchat-fab:active{transform:scale(.96)}',
      '.kchat-badge{position:absolute;top:-4px;inset-inline-end:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e11d48;color:#fff;font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;line-height:20px}',
      '.kchat-wrap{position:fixed;inset:0;z-index:2147483001;display:none;background:rgba(0,0,0,.35)}',
      '.kchat-wrap.open{display:block}',
      '.kchat-panel{position:absolute;inset-block:0;inset-inline-end:0;width:min(420px,100%);background:#f6f7f9;display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.25);font-family:inherit}',
      '.kchat-head{background:#0a7d4b;color:#fff;padding:10px 12px;display:flex;align-items:center;gap:10px;flex:0 0 auto}',
      '.kchat-head b{font-size:16px;flex:1}',
      '.kchat-x{background:transparent;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:4px 8px}',
      '.kchat-tabs{display:flex;gap:6px;background:#086a40;padding:6px 10px;flex:0 0 auto}',
      '.kchat-tab{flex:1;border:none;background:rgba(255,255,255,.15);color:#fff;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;position:relative}',
      '.kchat-tab.on{background:#fff;color:#0a7d4b}',
      '.kchat-tab .dot{position:absolute;top:4px;inset-inline-end:6px;width:8px;height:8px;border-radius:50%;background:#e11d48;display:none}',
      '.kchat-list{flex:1 1 auto;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}',
      '.kchat-msg{max-width:82%;padding:7px 10px;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.08);align-self:flex-start}',
      '.kchat-msg.me{align-self:flex-end;background:#d6f3e4}',
      '.kchat-who{font-size:12px;font-weight:700;color:#0a7d4b;margin-bottom:2px}',
      '.kchat-msg.me .kchat-who{display:none}',
      '.kchat-body{font-size:14px;white-space:pre-wrap;word-break:break-word;line-height:1.35}',
      '.kchat-img{max-width:220px;max-height:220px;border-radius:8px;margin-top:4px;cursor:pointer;display:block}',
      '.kchat-img.full{max-width:100%;max-height:none}',
      '.kchat-time{font-size:10px;color:#94a3b8;margin-top:3px;text-align:end}',
      '.kchat-msg.pending{opacity:.6}',
      '.kchat-day{align-self:center;background:#e2e8f0;color:#475569;font-size:11px;padding:2px 10px;border-radius:10px;margin:4px 0}',
      '.kchat-empty{color:#94a3b8;text-align:center;margin:auto;font-size:14px}',
      '.kchat-foot{flex:0 0 auto;padding:8px;background:#fff;border-top:1px solid #e2e8f0}',
      '.kchat-prev{display:none;align-items:center;gap:8px;margin-bottom:6px}',
      '.kchat-prev img{width:44px;height:44px;object-fit:cover;border-radius:6px}',
      '.kchat-prev button{background:#e11d48;color:#fff;border:none;border-radius:6px;padding:2px 8px;cursor:pointer}',
      '.kchat-row{display:flex;gap:6px;align-items:flex-end}',
      '.kchat-ta{flex:1;resize:none;border:1px solid #cbd5e1;border-radius:10px;padding:8px 10px;font:inherit;font-size:14px;max-height:120px;min-height:38px}',
      '.kchat-ic{flex:0 0 auto;width:38px;height:38px;border-radius:50%;border:none;background:#eef2f6;cursor:pointer;font-size:18px}',
      '.kchat-ic.send{background:#0a7d4b;color:#fff}',
      '.kchat-ic:disabled{opacity:.5;cursor:default}',
      '.kchat-note{font-size:12px;color:#94a3b8;padding:0 2px 4px;text-align:center}',
      '@media (max-width:480px){.kchat-panel{width:100%}}',
      // on phones the apps put their nav in a bottom bar — float the launcher above it
      '@media (max-width:760px){.kchat-fab{bottom:calc(72px + env(safe-area-inset-bottom))}}'
    ].join('');
    document.head.appendChild(css);
  }

  function dayLabel(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var now = new Date(), a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var diff = Math.round((b - a) / 86400000);
    if (diff === 0) return tr('today'); if (diff === 1) return tr('yesterday');
    try { return d.toLocaleDateString(S.lang === 'ar' ? 'ar' : 'id', { day: 'numeric', month: 'short', year: a.getFullYear() === b.getFullYear() ? undefined : 'numeric' }); } catch (e) { return iso.slice(0, 10); }
  }
  function timeLabel(iso) { var d = new Date(iso); if (isNaN(d)) return ''; try { return d.toLocaleTimeString(S.lang === 'ar' ? 'ar' : 'id', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso.slice(11, 16); } }

  /* ---- image downscale on the client (keeps the data URL small) ---- */
  function shrinkImage(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height, scale = Math.min(1, MAX_DIM / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        var out; try { out = c.toDataURL('image/jpeg', Q); } catch (e) { out = ''; }
        cb(out && out.length <= IMG_MAX ? out : null);
      };
      img.onerror = function () { cb(null); };
      img.src = reader.result;
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
  }

  /* ---- merge polled/bootstrapped messages into state, dedupe by cid ---- */
  function ingest(ch, list) {
    if (!S.msgs[ch]) S.msgs[ch] = [];
    var byCid = {}; S.msgs[ch].forEach(function (m) { byCid[m.cid] = m; });
    (list || []).forEach(function (m) {
      if (byCid[m.cid]) { Object.assign(byCid[m.cid], m, { pending: false, failed: false }); }
      else { S.msgs[ch].push(m); byCid[m.cid] = m; }
      if (m.created_at > (S.cursors[ch] || '')) S.cursors[ch] = m.created_at;
    });
    S.msgs[ch].sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
  }

  function unreadFor(ch) {
    var seen = (S.seen && S.seen[ch]) || '';
    return (S.msgs[ch] || []).reduce(function (n, m) { return (!m.pending && m.from_name !== (S.me && S.me.name) && String(m.created_at) > seen) ? n + 1 : n; }, 0);
  }
  function totalUnread() { return (S.channels || []).reduce(function (n, ch) { return n + unreadFor(ch); }, 0); }

  function renderBadge() {
    if (!S.fab) return;
    var n = totalUnread();
    S.badge.textContent = n > 99 ? '99+' : String(n);
    S.badge.style.display = n > 0 ? 'flex' : 'none';
  }

  function markSeen(ch) {
    var arr = S.msgs[ch] || []; if (!arr.length) return;
    S.seen = S.seen || {}; S.seen[ch] = arr[arr.length - 1].created_at;
    store('seen.' + (S.me ? S.me.name : '_'), S.seen);
  }

  function renderTabs() {
    S.tabs.innerHTML = '';
    if (!S.channels || S.channels.length < 2) { S.tabs.style.display = 'none'; return; }
    S.tabs.style.display = 'flex';
    S.channels.forEach(function (ch) {
      var b = el('button', 'kchat-tab' + (ch === S.cur ? ' on' : ''), tr(ch));
      var dot = el('span', 'dot'); if (ch !== S.cur && unreadFor(ch) > 0) dot.style.display = 'block';
      b.appendChild(dot);
      b.addEventListener('click', function () { S.cur = ch; markSeen(ch); renderTabs(); renderList(); renderBadge(); });
      S.tabs.appendChild(b);
    });
  }

  function renderList(keepScroll) {
    var list = S.list, atBottom = (list.scrollTop + list.clientHeight >= list.scrollHeight - 40);
    list.innerHTML = '';
    var arr = (S.msgs[S.cur] || []);
    if (!arr.length) { list.appendChild(el('div', 'kchat-empty', tr('empty'))); return; }
    var lastDay = '';
    arr.forEach(function (m) {
      var day = dayLabel(m.created_at);
      if (day && day !== lastDay) { list.appendChild(el('div', 'kchat-day', day)); lastDay = day; }
      var mine = m.from_name === (S.me && S.me.name);
      var box = el('div', 'kchat-msg' + (mine ? ' me' : '') + (m.pending ? ' pending' : ''));
      if (!mine) box.appendChild(el('div', 'kchat-who', m.from_name));
      if (m.body) box.appendChild(el('div', 'kchat-body', m.body));
      if (m.image) { var im = el('img', 'kchat-img'); im.src = m.image; im.alt = tr('img'); im.addEventListener('click', function () { im.classList.toggle('full'); }); box.appendChild(im); }
      var tm = el('div', 'kchat-time', (m.failed ? tr('failed') + ' · ' : m.pending ? tr('sending') + ' ' : '') + timeLabel(m.created_at));
      box.appendChild(tm);
      if (m.failed) { var rb = el('button', 'kchat-ic', '↻'); rb.title = tr('retry'); rb.style.cssText = 'width:auto;height:auto;padding:1px 7px;font-size:12px;margin-top:3px'; rb.addEventListener('click', function () { doSend(m); }); box.appendChild(rb); }
      list.appendChild(box);
    });
    if (!keepScroll || atBottom) list.scrollTop = list.scrollHeight;
  }

  function note(msg) { S.note.textContent = msg || ''; S.note.style.display = msg ? 'block' : 'none'; }

  function doSend(existing) {
    var m = existing;
    if (!m) {
      var body = S.ta.value.trim(), image = S.pendingImg || '';
      if (!body && !image) return;
      m = { cid: uuid(), channel: S.cur, from_name: S.me ? S.me.name : '', body: body, image: image, created_at: new Date().toISOString(), pending: true, failed: false };
      S.msgs[S.cur] = S.msgs[S.cur] || []; S.msgs[S.cur].push(m);
      S.ta.value = ''; S.ta.style.height = 'auto'; clearImage();
    } else { m.pending = true; m.failed = false; }
    note(''); renderList();
    S.api('chat_send', { channel: m.channel, body: m.body, image: m.image, cid: m.cid }).then(function (res) {
      m.pending = false; m.failed = false;
      if (res && res.message) { m.created_at = res.message.created_at; m.from_name = res.message.from_name || m.from_name; if (m.created_at > (S.cursors[m.channel] || '')) S.cursors[m.channel] = m.created_at; }
      markSeen(m.channel); renderList(); renderBadge();
    }).catch(function (e) {
      m.pending = false;
      if (e && (e.code === 'INVALID')) { m.failed = false; S.msgs[m.channel] = S.msgs[m.channel].filter(function (x) { return x !== m; }); note(tr('big')); }
      else if (e && (e.code === 'TAMPER_LOCKED' || e.code === 'LOCKED')) { note(tr('locked')); }
      else { m.failed = true; note(''); }
      renderList();
    });
  }

  function clearImage() { S.pendingImg = ''; S.prev.style.display = 'none'; S.prevImg.src = ''; S.file.value = ''; updateSendState(); }
  function updateSendState() { S.send.disabled = !(S.ta.value.trim() || S.pendingImg); }

  function buildPanel() {
    S.wrap = el('div', 'kchat-wrap');
    S.panel = el('div', 'kchat-panel');
    // head
    var head = el('div', 'kchat-head');
    S.titleEl = el('b', null, tr('title'));
    var x = el('button', 'kchat-x', '×'); x.setAttribute('aria-label', tr('close')); x.addEventListener('click', close);
    head.appendChild(S.titleEl); head.appendChild(x);
    // tabs
    S.tabs = el('div', 'kchat-tabs');
    // list
    S.list = el('div', 'kchat-list');
    // foot
    var foot = el('div', 'kchat-foot');
    S.note = el('div', 'kchat-note'); S.note.style.display = 'none';
    S.prev = el('div', 'kchat-prev'); S.prevImg = el('img'); var px = el('button', null, '×'); px.addEventListener('click', clearImage);
    S.prev.appendChild(S.prevImg); S.prev.appendChild(px);
    var row = el('div', 'kchat-row');
    S.file = el('input'); S.file.type = 'file'; S.file.accept = 'image/*'; S.file.style.display = 'none';
    S.file.addEventListener('change', function () { var f = S.file.files && S.file.files[0]; if (!f) return; note(''); shrinkImage(f, function (url) { if (!url) { note(tr('big')); return; } S.pendingImg = url; S.prevImg.src = url; S.prev.style.display = 'flex'; updateSendState(); }); });
    var imgBtn = el('button', 'kchat-ic', '📷'); imgBtn.title = tr('img'); imgBtn.addEventListener('click', function () { S.file.click(); });
    S.ta = el('textarea', 'kchat-ta'); S.ta.placeholder = tr('ph'); S.ta.rows = 1;
    S.ta.addEventListener('input', function () { S.ta.style.height = 'auto'; S.ta.style.height = Math.min(120, S.ta.scrollHeight) + 'px'; updateSendState(); });
    S.ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    S.send = el('button', 'kchat-ic send', '➤'); S.send.title = tr('send'); S.send.disabled = true; S.send.addEventListener('click', function () { doSend(); });
    row.appendChild(imgBtn); row.appendChild(S.ta); row.appendChild(S.send);
    foot.appendChild(S.note); foot.appendChild(S.prev); foot.appendChild(row);

    S.panel.appendChild(head); S.panel.appendChild(S.tabs); S.panel.appendChild(S.list); S.panel.appendChild(foot);
    S.wrap.appendChild(S.panel);
    S.wrap.addEventListener('click', function (e) { if (e.target === S.wrap) close(); });
    document.body.appendChild(S.wrap);
  }

  function open() {
    if (!S.wrap) buildPanel();
    S.wrap.classList.add('open'); S.openState = true;
    applyDir();
    renderTabs(); renderList(); if (S.cur) markSeen(S.cur); renderBadge();
    schedule(true);
    refresh();
  }
  function close() { S.openState = false; if (S.wrap) S.wrap.classList.remove('open'); schedule(false); renderBadge(); }

  function applyDir() {
    var rtl = S.lang === 'ar';
    if (S.panel) S.panel.dir = rtl ? 'rtl' : 'ltr';
    if (S.titleEl) S.titleEl.textContent = tr('title');
    if (S.ta) S.ta.placeholder = tr('ph');
  }

  function schedule(fast) {
    if (S.timer) clearTimeout(S.timer);
    S.timer = setTimeout(tick, fast ? POLL_OPEN : POLL_IDLE);
  }
  function tick() { refresh(); }

  function refresh() {
    if (S.busy) { schedule(S.openState); return; }
    S.busy = true;
    var first = !S.loaded;
    var p = first ? S.api('chat_bootstrap', {}) : S.api('chat_poll', { cursors: S.cursors });
    p.then(function (res) {
      S.busy = false; S.loaded = true;
      if (res && res.me) S.me = res.me;
      if (res && res.channels) { S.channels = res.channels; if (!S.cur || S.channels.indexOf(S.cur) < 0) S.cur = S.channels[0]; }
      if (res && typeof res.retention_days === 'number') S.retention = res.retention_days;
      if (res && res.messages) Object.keys(res.messages).forEach(function (ch) { ingest(ch, res.messages[ch]); });
      if (S.fab) S.fab.style.display = 'flex';
      if (S.openState) { renderTabs(); renderList(true); if (S.cur) markSeen(S.cur); }
      renderBadge();
      schedule(S.openState);
    }).catch(function (e) {
      S.busy = false;
      if (e && (e.code === 'TAMPER_LOCKED' || e.code === 'LOCKED' || e.code === 'BAD_PIN' || e.code === 'BAD_KEY' || e.code === 'NO_SESSION' || e.code === 'PIN_CHANGE_REQUIRED')) {
        if (S.fab) S.fab.style.display = 'none'; if (S.openState) close();
        schedule(false); return;
      }
      schedule(S.openState); // network/offline — keep trying
    });
  }

  var API = {
    start: function (opts) {
      opts = opts || {};
      if (S && S.api) { S.api = opts.api || S.api; if (opts.lang) S.lang = opts.lang; applyDir(); renderBadge(); return; }
      if (typeof opts.api !== 'function') return;
      injectCss();
      S = { api: opts.api, lang: opts.lang === 'ar' ? 'ar' : 'id', channels: [], cur: null, msgs: {}, cursors: {}, seen: store('seen._tmp') || {}, me: null, busy: false, loaded: false, openState: false, retention: 0, pendingImg: '' };
      S.fab = el('button', 'kchat-fab', '💬'); S.fab.setAttribute('aria-label', tr('title')); S.fab.style.display = 'none';
      S.badge = el('span', 'kchat-badge'); S.fab.appendChild(S.badge);
      S.fab.addEventListener('click', open);
      document.body.appendChild(S.fab);
      refresh();
    },
    setLang: function (lang) { if (S) { S.lang = lang === 'ar' ? 'ar' : 'id'; applyDir(); if (S.openState) { renderTabs(); renderList(true); } } },
    stop: function () {
      if (!S) return;
      if (S.timer) clearTimeout(S.timer);
      if (S.fab && S.fab.parentNode) S.fab.parentNode.removeChild(S.fab);
      if (S.wrap && S.wrap.parentNode) S.wrap.parentNode.removeChild(S.wrap);
      S = null;
    }
  };
  if (typeof window !== 'undefined') window.KChatUI = API;
})();
