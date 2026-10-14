/* Khair Mart — "Install the app" in one tap (v46, owner 2026-10-14: «نعم ابنِ زر التثبيت»).
   Chrome (Android, also Windows / Mac) offers to install the web app as a real phone app: a WebAPK that Google signs, so the
   phone shows no "unknown source" / Play Protect warning, the icon sits with the other apps, it opens full screen and updates
   itself. The browser's offer is kept and shown as a small card at the top of the LOGIN card: "Pasang" → the phone's own
   install dialog. On iPhone (no such offer) the card says how: Share ⬆️ → "Add to Home Screen".
   Never shown inside the installed app, inside the owner app's frame (the cold-storage page), after "✕" (asked again after
   3 days) or once installed.
     <script src="shared/install-btn.js" data-host="#login:not([hidden]) .login-card"></script>
   data-host: the login card the install card goes into (the app's own re-render may drop it; it is put back). */
(function () {
  'use strict';
  if (window.KInstall) return;
  var me = document.currentScript;
  var HOST = (me && me.getAttribute('data-host')) || '#login:not([hidden]) .login-card';
  var KEY = 'kinst.closed', WAIT_MS = 3 * 864e5;
  var T = {
    id: { title: 'Pasang aplikasi ini di HP', sub: 'Sekali tap — ikon di layar HP, layar penuh, aman & gratis', btn: 'Pasang', ios: 'Di iPhone: tap Bagikan ⬆️ lalu "Tambah ke Layar Utama"', close: 'Tutup' },
    ar: { title: 'ثبّت التطبيق على هاتفك', sub: 'بضغطة واحدة — أيقونة مع تطبيقاتك، شاشة كاملة، آمن ومجاني', btn: 'تثبيت', ios: 'على الآيفون: اضغط «مشاركة» ⬆️ ثم «إضافة إلى الشاشة الرئيسية»', close: 'إغلاق' }
  };
  var framed = true; try { framed = window.top !== window.self; } catch (e) { }
  var ua = navigator.userAgent || '';
  var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  var offer = null, installed = false, card = null, drawn = '', queued = false, watching = false;

  function standalone() {
    try { return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true || /^android-app:/.test(document.referrer); } catch (e) { return false; }
  }
  function closedRecently() { try { var v = Number(localStorage.getItem(KEY)); return v > 0 && Date.now() - v < WAIT_MS; } catch (e) { return false; } }
  function host() { try { return document.querySelector(HOST); } catch (e) { return null; } } // e.g. :has() on an old browser → no card
  function lang() { return String(document.documentElement.lang || '').slice(0, 2) === 'ar' ? 'ar' : 'id'; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function css() {
    if (document.getElementById('kinst-css')) return;
    var st = document.createElement('style'); st.id = 'kinst-css';
    st.textContent = '#kinst{display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:10px 12px;border:1px solid #BBF7D0;border-radius:14px;background:#F0FDF4;color:#14532D;text-align:start;font-size:14px;line-height:1.35}'
      + '#kinst[hidden]{display:none}#kinst .ki-ic{font-size:26px;flex:none}#kinst .ki-t{flex:1;min-width:0}#kinst .ki-t b{display:block;font-size:15px}'
      + '#kinst .ki-t span{display:block;font-size:12px;color:#166534}#kinst .ki-go{flex:none;background:#15803D;color:#fff;border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:800;font-size:15px;cursor:pointer}'
      + '#kinst .ki-go:active{background:#166534}#kinst .ki-x{flex:none;align-self:flex-start;background:transparent;border:0;color:#166534;font-size:16px;line-height:1;padding:2px 4px;cursor:pointer}';
    (document.head || document.documentElement).appendChild(st);
  }
  function draw(mode) {
    var L = T[lang()], key = mode + ':' + lang();
    if (!card) {
      css();
      card = document.createElement('div'); card.id = 'kinst'; card.setAttribute('role', 'region');
      card.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button'); if (!b) return;
        e.preventDefault(); e.stopPropagation();
        if (b.classList.contains('ki-go')) install(); else if (b.classList.contains('ki-x')) close();
      });
    }
    if (drawn !== key) {
      drawn = key; card.setAttribute('data-mode', mode); card.setAttribute('aria-label', L.title);
      card.innerHTML = '<span class="ki-ic" aria-hidden="true">📲</span><div class="ki-t"><b>' + esc(L.title) + '</b><span>' + esc(mode === 'ios' ? L.ios : L.sub) + '</span></div>'
        + (mode === 'ios' ? '' : '<button type="button" class="ki-go" id="kinst-go">' + esc(L.btn) + '</button>')
        + '<button type="button" class="ki-x" id="kinst-x" aria-label="' + esc(L.close) + '" title="' + esc(L.close) + '">✕</button>';
    }
  }
  function update() {
    queued = false;
    var mode = offer ? 'offer' : (ios ? 'ios' : '');
    var h = mode && !installed && !framed && !standalone() && !closedRecently() ? host() : null;
    if (!h) { if (card && card.parentNode) card.parentNode.removeChild(card); return; }
    draw(mode);
    if (card.parentNode !== h || card !== h.firstElementChild) h.insertBefore(card, h.firstChild); // top of the card, seen without scrolling; put back when the app re-draws it
  }
  function schedule() { if (queued) return; queued = true; (window.requestAnimationFrame || setTimeout)(update); }
  function watch() { // only while there is something to show: no observer at all on a phone that already has the app
    if (watching || framed || typeof MutationObserver === 'undefined') return;
    watching = true;
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'lang'] });
    schedule();
  }
  function install() {
    var ev = offer; if (!ev) return;
    offer = null; update();
    try {
      var p = ev.prompt(); // the phone's own dialog
      Promise.resolve(ev.userChoice).then(function (r) { if (r && r.outcome === 'accepted') installed = true; update(); }, update);
      if (p && p.catch) p.catch(function () { });
    } catch (e) { update(); }
  }
  function close() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { } update(); }

  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); offer = e; watch(); schedule(); });
  window.addEventListener('appinstalled', function () { installed = true; offer = null; schedule(); });
  if (ios) watch();
  window.KInstall = { available: function () { return !!offer; }, prompt: install, update: schedule };
})();
