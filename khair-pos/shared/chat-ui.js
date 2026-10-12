/* Khair Mart POS — in-app chat panel (Phase 3). Self-contained, framework-free: mounts a floating
   launcher + a slide-in panel on document.body, so the three apps (owner / kasir / sales) all use it
   the same way. The app only provides a chat API wrapper and the language.

   Usage:
     KChatUI.start({ api: (action, data) => Promise<response>, lang: 'id' | 'ar' });
     KChatUI.setLang('ar');       // when the user switches language
     KChatUI.stop();              // on logout

   `api('chat_bootstrap')` / `api('chat_poll', {cursors})` / `api('chat_send', {channel, body, image, cid})`
   mirror backend/chat/chat-core.js. Channels: 'general' (everyone) and 'owner_mgr' (owner + manager).
   v36 (owner 2026-10-11: «أريد الدردشة مع كل الفريق المسجل وكل من له يحمل هذا التطبيق»): a "Team" tab lists every
   registered user (names only) with an unread badge; tapping one opens a private 1-to-1 room ('dm:…', only the two of
   them). No extra polling: the same poll carries {cursors, seen} and returns the open rooms' messages, the team list
   and the unread count of every room. KChatUI.start({ api, lang, user }) — `user` loads this device's read marks at once.
   Names only — the panel shows the sender's name, never a role word.
   v38 (owner 2026-10-12: "For any notice come to me make for me I can reply" + «نعم زر رد او اغلق مباشر ما في مشكل»):
   a message may carry `quote` (the notice it answers: text, time, ref/invoice no.) — shown as a compact block above the text,
   in every app. The apps reply / close notices through KChatUI.sendTo(name, {body, quote, ref}) / KChatUI.closeNotices(ids);
   the user's notice state (closed / replied) rides on the same poll (data.notice_v → res.notices only when it changed) and is
   handed to opts.onNotices(state). KChatUI.team() lists the people one can write to. */
(function () {
  'use strict';
  var IMG_MAX = 180000, MAX_DIM = 900, Q = 0.55;
  var POLL_OPEN = 4000, POLL_IDLE = 20000;

  var T = {
    id: { title: 'Obrolan', general: 'Umum', owner_mgr: 'Pemilik & Manajer', team: 'Tim', back: 'Kembali ke tim', team_hint: 'Pilih nama untuk obrolan pribadi (hanya kalian berdua).', send: 'Kirim', ph: 'Tulis pesan…',
      img: 'Gambar', empty: 'Belum ada pesan.', you: 'Anda', close: 'Tutup', today: 'Hari ini', yesterday: 'Kemarin',
      sending: 'mengirim…', failed: 'gagal', big: 'Gambar terlalu besar — coba foto lebih kecil.', retry: 'Coba lagi',
      locked: 'Akun terkunci.', offline: 'Luring — pesan menunggu.', quote: 'Pemberitahuan' },
    ar: { title: 'المحادثة', general: 'عام', owner_mgr: 'المالك والمدير', team: 'الفريق', back: 'رجوع إلى الفريق', team_hint: 'اختر اسمًا لمحادثة خاصة (بينكما فقط).', send: 'إرسال', ph: 'اكتب رسالة…',
      img: 'صورة', empty: 'لا توجد رسائل بعد.', you: 'أنت', close: 'إغلاق', today: 'اليوم', yesterday: 'أمس',
      sending: 'يُرسل…', failed: 'فشل', big: 'الصورة كبيرة جداً — جرّب صورة أصغر.', retry: 'إعادة',
      locked: 'الحساب مقفل.', offline: 'غير متصل — الرسالة تنتظر.', quote: 'إشعار' }
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
      // v36: team list + private room bar
      '.kchat-peer{display:none;align-items:center;gap:8px;background:#e8f5ee;padding:6px 10px;border-bottom:1px solid #cfe9db;flex:0 0 auto}',
      '.kchat-peer b{flex:1;font-size:14px;color:#0a7d4b}',
      '.kchat-back{border:none;background:#fff;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:16px;line-height:1;color:#0a7d4b}',
      '.kchat-hint{color:#64748b;font-size:12px;text-align:center;margin:2px 0 4px}',
      '.kchat-member{display:flex;align-items:center;gap:10px;width:100%;border:none;background:#fff;border-radius:12px;padding:10px 12px;cursor:pointer;text-align:start;box-shadow:0 1px 2px rgba(0,0,0,.08);font:inherit;color:inherit}',
      '.kchat-member .av{flex:0 0 auto;width:34px;height:34px;border-radius:50%;background:#0a7d4b;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:15px}',
      '.kchat-member .nm{flex:1;font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.kchat-member .tm{font-size:11px;color:#94a3b8}',
      '.kchat-mbadge{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#e11d48;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}',
      // v38: the quoted notice above a reply
      '.kchat-quote{border-inline-start:3px solid #0a7d4b;background:rgba(10,125,75,.08);border-radius:6px;padding:4px 8px;margin:2px 0 5px;font-size:12px;line-height:1.3}',
      '.kchat-quote .kq-h{font-weight:700;color:#0a7d4b;font-size:11px;margin-bottom:2px}',
      '.kchat-quote .kq-t{color:#334155;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}',
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

  function isDm(ch) { return String(ch || '').indexOf('dm:') === 0; }
  function unreadFor(ch) {
    // v36: a private room this device has not opened yet → the server's count (same poll); an open one → counted here
    if (isDm(ch) && !(ch in S.cursors)) return (S.unreadSrv && S.unreadSrv[ch]) || 0;
    var seen = (S.seen && S.seen[ch]) || '';
    return (S.msgs[ch] || []).reduce(function (n, m) { return (!m.pending && m.from_name !== (S.me && S.me.name) && String(m.created_at) > seen) ? n + 1 : n; }, 0);
  }
  function teamUnread() { return (S.team || []).reduce(function (n, t) { return n + unreadFor(t.channel); }, 0); }
  function totalUnread() { return (S.channels || []).reduce(function (n, ch) { return n + unreadFor(ch); }, 0) + teamUnread(); }

  function renderBadge() {
    if (!S.fab) return;
    var n = totalUnread();
    S.badge.textContent = n > 99 ? '99+' : String(n);
    S.badge.style.display = n > 0 ? 'flex' : 'none';
  }

  function markSeen(ch) {
    if (S.unreadSrv && S.unreadSrv[ch]) S.unreadSrv[ch] = 0;
    var arr = S.msgs[ch] || []; if (!arr.length) return;
    S.seen = S.seen || {}; S.seen[ch] = arr[arr.length - 1].created_at;
    store('seen.' + (S.me ? S.me.name : '_'), S.seen);
  }

  function renderTabs() {
    S.tabs.innerHTML = '';
    var tabs = (S.channels || []).slice(); if ((S.team || []).length) tabs.push('team'); // v36: the team tab
    if (tabs.length < 2) { S.tabs.style.display = 'none'; renderPeer(); return; }
    S.tabs.style.display = 'flex';
    var onTeam = S.view === 'team' || isDm(S.cur);
    tabs.forEach(function (ch) {
      var on = ch === 'team' ? onTeam : (!onTeam && ch === S.cur);
      var b = el('button', 'kchat-tab' + (on ? ' on' : ''), tr(ch)); b.setAttribute('data-ch', ch);
      var dot = el('span', 'dot'); if (!on && (ch === 'team' ? teamUnread() : unreadFor(ch)) > 0) dot.style.display = 'block';
      b.appendChild(dot);
      b.addEventListener('click', function () {
        if (ch === 'team') { S.view = 'team'; S.cur = S.channels[0]; S.peer = null; }
        else { S.view = 'room'; S.cur = ch; S.peer = null; markSeen(ch); }
        renderTabs(); renderList(); renderBadge();
      });
      S.tabs.appendChild(b);
    });
    renderPeer();
  }

  /* v36: the bar above a private room (back to the team list + the other person's name) */
  function renderPeer() {
    if (!S.peerBar) return;
    var dm = S.view !== 'team' && isDm(S.cur) && S.peer;
    S.peerBar.style.display = dm ? 'flex' : 'none';
    S.foot.style.display = S.view === 'team' ? 'none' : '';
    if (dm) { S.peerName.textContent = S.peer.name; S.backBtn.textContent = S.lang === 'ar' ? '›' : '‹'; S.backBtn.title = tr('back'); S.backBtn.setAttribute('aria-label', tr('back')); }
  }

  function openDm(t) {
    S.view = 'room'; S.cur = t.channel; S.peer = t;
    if (!(t.channel in S.cursors)) { S.cursors[t.channel] = ''; S.msgs[t.channel] = S.msgs[t.channel] || []; }
    renderTabs(); renderList(); markSeen(t.channel); renderBadge();
    refresh(true); // fetch the room now (the same poll call, just sooner)
  }

  function renderTeam() {
    var list = S.list; list.innerHTML = '';
    var team = (S.team || []).slice().sort(function (a, b) {
      return (unreadFor(b.channel) > 0) - (unreadFor(a.channel) > 0) || String((S.last || {})[b.channel] || '').localeCompare(String((S.last || {})[a.channel] || '')) || a.name.localeCompare(b.name);
    });
    list.appendChild(el('div', 'kchat-hint', tr('team_hint')));
    team.forEach(function (t) {
      var b = el('button', 'kchat-member'); b.type = 'button'; b.setAttribute('data-name', t.name);
      b.appendChild(el('span', 'av', (t.name || '?').trim().charAt(0).toUpperCase()));
      b.appendChild(el('span', 'nm', t.name));
      var at = (S.last || {})[t.channel]; if (at) b.appendChild(el('span', 'tm', dayLabel(at) === tr('today') ? timeLabel(at) : dayLabel(at)));
      var n = unreadFor(t.channel); if (n > 0) b.appendChild(el('span', 'kchat-mbadge', n > 99 ? '99+' : String(n)));
      b.addEventListener('click', function () { openDm(t); });
      list.appendChild(b);
    });
  }

  function renderList(keepScroll) {
    if (S.view === 'team') { renderTeam(); return; }
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
      if (m.quote && m.quote.text) box.appendChild(quoteEl(m.quote)); // v38
      if (m.body) box.appendChild(el('div', 'kchat-body', m.body));
      if (m.image) { var im = el('img', 'kchat-img'); im.src = m.image; im.alt = tr('img'); im.addEventListener('click', function () { im.classList.toggle('full'); }); box.appendChild(im); }
      var tm = el('div', 'kchat-time', (m.failed ? tr('failed') + ' · ' : m.pending ? tr('sending') + ' ' : '') + timeLabel(m.created_at));
      box.appendChild(tm);
      if (m.failed) { var rb = el('button', 'kchat-ic', '↻'); rb.title = tr('retry'); rb.style.cssText = 'width:auto;height:auto;padding:1px 7px;font-size:12px;margin-top:3px'; rb.addEventListener('click', function () { doSend(m); }); box.appendChild(rb); }
      list.appendChild(box);
    });
    if (!keepScroll || atBottom) list.scrollTop = list.scrollHeight;
  }

  /* v38: the compact block of the notice a message answers (notice text + date/time + ref / invoice no.) */
  function quoteEl(q) {
    var b = el('div', 'kchat-quote'), at = q.at ? (dayLabel(q.at) + ' ' + timeLabel(q.at)).trim() : '';
    b.appendChild(el('div', 'kq-h', ['↩ ' + tr('quote'), at, q.no || ''].filter(Boolean).join(' · ')));
    b.appendChild(el('div', 'kq-t', (q.by ? q.by + ': ' : '') + q.text));
    return b;
  }
  /* v38: hand the notice state (closed / replied) to the app */
  function takeNotices(ns) {
    if (!ns || typeof ns !== 'object') return;
    S.noticeV = String(ns.v == null ? '' : ns.v);
    if (typeof S.onNotices === 'function') { try { S.onNotices(ns); } catch (e) { } }
  }

  function note(msg) { S.note.textContent = msg || ''; S.note.style.display = msg ? 'block' : 'none'; }

  /* one send (also a retry); v38: a reply to a notice carries quote + ref */
  function post(m) {
    var data = { channel: m.channel, body: m.body, image: m.image, cid: m.cid };
    if (m.quote) data.quote = m.quote;
    if (m.ref) data.ref = m.ref;
    return S.api('chat_send', data).then(function (res) {
      m.pending = false; m.failed = false;
      if (res && res.message) { m.created_at = res.message.created_at; m.from_name = res.message.from_name || m.from_name; if (m.created_at > (S.cursors[m.channel] || '')) S.cursors[m.channel] = m.created_at; }
      if (res && res.notices) takeNotices(res.notices);
      return res;
    });
  }

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
    post(m).then(function () {
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
    // v36: private-room bar
    S.peerBar = el('div', 'kchat-peer'); S.backBtn = el('button', 'kchat-back', '‹'); S.peerName = el('b');
    S.backBtn.addEventListener('click', function () { S.view = 'team'; S.cur = S.channels[0]; S.peer = null; renderTabs(); renderList(); renderBadge(); });
    S.peerBar.appendChild(S.backBtn); S.peerBar.appendChild(S.peerName);
    // list
    S.list = el('div', 'kchat-list');
    // foot
    var foot = el('div', 'kchat-foot'); S.foot = foot;
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

    S.panel.appendChild(head); S.panel.appendChild(S.tabs); S.panel.appendChild(S.peerBar); S.panel.appendChild(S.list); S.panel.appendChild(foot);
    S.wrap.appendChild(S.panel);
    S.wrap.addEventListener('click', function (e) { if (e.target === S.wrap) close(); });
    document.body.appendChild(S.wrap);
  }

  function open() {
    if (!S.wrap) buildPanel();
    S.wrap.classList.add('open'); S.openState = true;
    applyDir();
    renderTabs(); renderList(); if (S.cur && S.view !== 'team') markSeen(S.cur); renderBadge();
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
  // v36 (lean, CLAUDE.md): no chat calls while the app is in the background — one call as soon as it is shown again
  function tick() { if (typeof document !== 'undefined' && document.hidden) { S.paused = true; return; } refresh(); }
  function onVisible() { if (S && S.paused && !document.hidden) { S.paused = false; refresh(); } }

  function refresh(soon) {
    if (S.busy) { if (soon) S.again = true; else schedule(S.openState); return; }
    S.busy = true; S.again = false;
    var first = !S.loaded;
    // v36: the same single call also reports what this device has read (seen) → unread counts for every room
    var p = first ? S.api('chat_bootstrap', { seen: S.seen || {} }) : S.api('chat_poll', { cursors: S.cursors, seen: S.seen || {}, notice_v: S.noticeV || '' }); // v38: notice_v
    var mine = S;
    p.then(function (res) {
      if (S !== mine) return; // stopped (logout) meanwhile
      S.busy = false; S.loaded = true;
      if (res && res.me) {
        S.me = res.me;
        // read marks of this user on this device (when the app did not pass `user`): load once and ask again at once
        if (S.seenFor !== res.me.name) { S.seenFor = res.me.name; S.seen = store('seen.' + res.me.name) || {}; S.again = true; }
      }
      if (res && res.channels) { S.channels = res.channels; if (!S.cur || (!isDm(S.cur) && S.channels.indexOf(S.cur) < 0)) S.cur = S.channels[0]; }
      if (res && Array.isArray(res.team)) {
        S.team = res.team;
        if (S.peer) { var still = S.team.find(function (t) { return t.channel === S.peer.channel; }); if (!still) { S.peer = null; S.view = 'team'; S.cur = S.channels[0]; } }
      }
      if (res && res.unread && typeof res.unread === 'object') S.unreadSrv = res.unread;
      if (res && res.last && typeof res.last === 'object') S.last = res.last;
      if (res && typeof res.retention_days === 'number') S.retention = res.retention_days;
      if (res && res.messages) Object.keys(res.messages).forEach(function (ch) { ingest(ch, res.messages[ch]); });
      if (res && res.notices) takeNotices(res.notices); // v38
      if (S.fab) S.fab.style.display = 'flex';
      if (S.openState) { renderTabs(); renderList(true); if (S.cur && S.view !== 'team') markSeen(S.cur); }
      renderBadge();
      if (S.again) { S.again = false; refresh(); return; }
      schedule(S.openState);
    }).catch(function (e) {
      if (S !== mine) return;
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
      if (S && S.api) { S.api = opts.api || S.api; if (opts.lang) S.lang = opts.lang; if (opts.onNotices) S.onNotices = opts.onNotices; applyDir(); renderBadge(); return; }
      if (typeof opts.api !== 'function') return;
      injectCss();
      // v36: read marks are per user on this device ('kchat.seen.<name>'); `user` lets the very first call carry them
      S = { api: opts.api, lang: opts.lang === 'ar' ? 'ar' : 'id', channels: [], cur: null, msgs: {}, cursors: {}, seen: opts.user ? (store('seen.' + opts.user) || {}) : {}, seenFor: opts.user || null,
        me: null, busy: false, loaded: false, openState: false, retention: 0, pendingImg: '', team: [], unreadSrv: {}, last: {}, view: 'room', peer: null,
        onNotices: opts.onNotices || null, noticeV: '' };
      S.fab = el('button', 'kchat-fab', '💬'); S.fab.setAttribute('aria-label', tr('title')); S.fab.style.display = 'none';
      S.badge = el('span', 'kchat-badge'); S.fab.appendChild(S.badge);
      S.fab.addEventListener('click', open);
      document.body.appendChild(S.fab);
      document.addEventListener('visibilitychange', onVisible);
      refresh();
    },
    setLang: function (lang) { if (S) { S.lang = lang === 'ar' ? 'ar' : 'id'; applyDir(); if (S.openState) { renderTabs(); renderList(true); } } },
    // v36: open a private room with a team member by name (used by the apps and the tests)
    openWith: function (name) { if (!S) return false; var t = (S.team || []).find(function (x) { return x.name === name; }); if (!t) return false; if (!S.openState) open(); openDm(t); return true; },
    // v38: the people this user can write to privately ([{name, role, channel}]) — names for the reply picker
    team: function () { return S ? (S.team || []).map(function (t) { return { name: t.name, role: t.role, channel: t.channel }; }) : []; },
    /** v38: a private message to one team member (a reply to a notice: {body, quote, ref}). Resolves with the server's answer. */
    sendTo: function (name, msg) {
      if (!S) return Promise.reject(Object.assign(new Error('chat not started'), { code: 'NO_SESSION' }));
      msg = msg || {};
      var mine = S, find = function () { return (mine.team || []).find(function (x) { return x.name === name; }); };
      var ready = find() ? Promise.resolve() : mine.api('chat_poll', { cursors: {}, seen: mine.seen || {} }).then(function (res) { if (res && Array.isArray(res.team)) mine.team = res.team; });
      return ready.then(function () {
        var t = find(); if (!t) throw Object.assign(new Error('not in team'), { code: 'NOT_FOUND' });
        if (!(t.channel in mine.cursors)) { mine.cursors[t.channel] = ''; mine.msgs[t.channel] = mine.msgs[t.channel] || []; }
        var m = { cid: uuid(), channel: t.channel, from_name: mine.me ? mine.me.name : '', body: String(msg.body || '').trim(), image: '', created_at: new Date().toISOString(), pending: true, failed: false };
        if (msg.quote) m.quote = msg.quote; if (msg.ref) m.ref = msg.ref;
        mine.msgs[t.channel].push(m);
        return post(m).then(function (res) { if (S === mine) { markSeen(t.channel); if (S.openState) renderList(true); renderBadge(); } return res; }, function (e) {
          mine.msgs[t.channel] = (mine.msgs[t.channel] || []).filter(function (x) { return x !== m; }); throw e;
        });
      });
    },
    /** v38: "Tutup" — close notices (ids) for every device of this user. Resolves with the new notice state. */
    closeNotices: function (ids) {
      if (!S) return Promise.reject(Object.assign(new Error('chat not started'), { code: 'NO_SESSION' }));
      var mine = S;
      return mine.api('notice_close', { ids: ids }).then(function (res) { if (S === mine && res && res.notices) takeNotices(res.notices); return res && res.notices; });
    },
    stop: function () {
      if (!S) return;
      if (S.timer) clearTimeout(S.timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (S.fab && S.fab.parentNode) S.fab.parentNode.removeChild(S.fab);
      if (S.wrap && S.wrap.parentNode) S.wrap.parentNode.removeChild(S.wrap);
      S = null;
    }
  };
  if (typeof window !== 'undefined') window.KChatUI = API;
})();
