/* Khair Mart — every app picks up a new version by itself (v49, owner 2026-10-14: «لم تظهرت النسخة الجديدة»).
   GitHub Pages lets a phone keep its copy of a page for 10 minutes, and an app left open (an installed app stays in the
   phone's memory) never loads its page again, so a new version could take hours or days to reach a cashier's phone.
   Now the app asks the site for its own page when it opens, each time it comes back on screen (at most every 5 minutes)
   and every 30 minutes while on screen. Unchanged = a few bytes ("304"). Another APP_VERSION there = a new version:
   - nobody is working in the app (login screen, or not touched since it opened) → it reloads itself, quietly;
   - someone is working → a green bar at the top: "Versi baru … sudah siap — Perbarui" (one tap; the login stays).
   It never reloads twice for the same version (a stale copy somewhere → the bar instead) and never while offline.
   v69 (owner 2026-10-20: «عند فتح التطبيق اريد ان ارى عدد الإصدار»): the first time a new version opens on this phone, a short
   green note at the bottom says so for a few seconds (the version itself stays in the app's top bar and on its login screen).
     KUpdate.start({ version: APP_VERSION, idle: () => the login screen is shown })
     KUpdate.check() → Promise<'same' | 'new' | 'none'> */
(function () {
  'use strict';
  if (window.KUpdate) return;
  var T = {
    id: { title: 'Versi baru {v} sudah siap', btn: 'Perbarui', later: 'Nanti', done: 'Aplikasi diperbarui ke versi {v}' },
    ar: { title: 'نسخة جديدة {v} جاهزة', btn: 'تحديث', later: 'لاحقًا', done: 'تم تحديث التطبيق إلى النسخة {v}' }
  };
  var KEY = 'kupd.to', SEEN = 'kupd.seen:' + location.pathname.replace(/[^\/]*$/, ''), DONE_MS = 6000, EVERY_MS = 30 * 60e3, AGAIN_MS = 5 * 60e3, QUIET_MS = 20e3, LATER_MS = 30 * 60e3;
  var framed = true; try { framed = window.top !== window.self; } catch (e) { }
  var cur = '', idle = null, started = false, last = 0, busy = null, found = '', touched = 0, later = 0, bar = null, drawn = '', tick = null;

  function lang() { return String(document.documentElement.lang || '').slice(0, 2) === 'ar' ? 'ar' : 'id'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function tried() { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function setTried(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) { } }

  function css() {
    if (document.getElementById('kupd-css')) return;
    var st = document.createElement('style'); st.id = 'kupd-css';
    st.textContent = '#kupd{position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;align-items:center;gap:10px;padding:calc(8px + env(safe-area-inset-top)) 12px 8px;'
      + 'background:#15803D;color:#fff;font:600 14px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.25);text-align:start}'
      + '#kupd .ku-t{flex:1;min-width:0}#kupd .ku-go{flex:none;background:#fff;color:#14532D;border:0;border-radius:10px;padding:9px 16px;font:inherit;font-weight:800;cursor:pointer}'
      + '#kupd .ku-x{flex:none;background:transparent;border:1px solid rgba(255,255,255,.6);color:#fff;border-radius:10px;padding:8px 10px;font:inherit;cursor:pointer}'
      + '#kupd-ok{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom));z-index:2147483000;max-width:calc(100% - 32px);'
      + 'padding:10px 16px;border-radius:12px;background:#15803D;color:#fff;font:600 14px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'box-shadow:0 4px 14px rgba(0,0,0,.25);text-align:center;pointer-events:none}'
      + '@media print{#kupd,#kupd-ok{display:none}}';
    (document.head || document.documentElement).appendChild(st);
  }
  function hide() { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); }
  function show() {
    if (!found || Date.now() < later || !document.body) { hide(); return; }
    var L = T[lang()], key = found + ':' + lang();
    if (!bar) {
      css();
      bar = document.createElement('div'); bar.id = 'kupd'; bar.setAttribute('role', 'status');
      bar.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button'); if (!b) return;
        e.preventDefault(); e.stopPropagation();
        if (b.id === 'kupd-go') { setTried(found); location.reload(); } // the session of this tab survives a reload in every app
        else { later = Date.now() + LATER_MS; hide(); }
      });
    }
    if (drawn !== key) {
      drawn = key;
      bar.innerHTML = '<span aria-hidden="true">🔄</span><span class="ku-t">' + esc(L.title.replace('{v}', found)) + '</span>'
        + '<button type="button" class="ku-go" id="kupd-go">' + esc(L.btn) + '</button><button type="button" class="ku-x" id="kupd-x">' + esc(L.later) + '</button>';
    }
    if (bar.parentNode !== document.body) document.body.appendChild(bar);
  }
  /** A short note the first time this version opens here (never on a first install; it never blocks a tap). */
  function noteNew(reloaded) {
    var prev = '';
    try { prev = localStorage.getItem(SEEN) || ''; localStorage.setItem(SEEN, cur); } catch (e) { return; }
    if (!(prev ? prev !== cur : reloaded) || !document.body) return; // reloaded = this app just reloaded itself into the new version
    css();
    var el = document.createElement('div'); el.id = 'kupd-ok'; el.setAttribute('role', 'status');
    el.textContent = '\u2705 ' + T[lang()].done.replace('{v}', cur);
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, DONE_MS);
  }
  function free() { try { return !!(idle && idle()); } catch (e) { return false; } }
  function canReload() {
    if (!found || found === tried() || navigator.onLine === false) return false; // never twice for the same version
    if (touched && Date.now() - touched < QUIET_MS) return false; // a key / tap a moment ago: wait until it is quiet
    return !touched || free();
  }
  function act() {
    if (!found) { hide(); return; }
    if (canReload()) { setTried(found); location.reload(); return; }
    show();
    if (!tick) tick = setInterval(function () { if (!found) { clearInterval(tick); tick = null; return; } act(); }, 5000);
  }
  function check() {
    if (busy) return busy;
    if (!/^https?:$/.test(location.protocol)) return Promise.resolve('none');
    last = Date.now();
    try { if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update().catch(function () { }); }).catch(function () { }); } catch (e) { }
    busy = fetch(location.href.split('#')[0], { cache: 'no-cache', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (html) {
        var m = /\bAPP_VERSION\s*=\s*'([^'\\<>\s]{1,40})'/.exec(html || '');
        if (!m) return 'none'; // an error page, a hotel / airport login page…
        if (m[1] === cur) { found = ''; act(); return 'same'; }
        found = m[1]; act(); return 'new';
      }, function () { return 'none'; }) // offline
      .then(function (r) { busy = null; return r; });
    return busy;
  }
  function start(o) {
    if (started || framed || !o || !o.version) return;
    started = true; cur = String(o.version); idle = o.idle || null;
    var reloaded = tried() === cur;
    if (reloaded) setTried(''); // the reload brought the new version
    noteNew(reloaded);
    var mark = function () { touched = Date.now(); };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (Date.now() - last >= AGAIN_MS) check(); else if (found) act();
    });
    setTimeout(check, 3000);
    setInterval(function () { if (!document.hidden && Date.now() - last >= EVERY_MS) check(); }, 60e3);
  }
  window.KUpdate = { start: start, check: check, pending: function () { return found; } };
})();
