/* Khair Mart — barcode scanners that type like a keyboard (USB, or Bluetooth in "HID / keyboard" mode).
 * v64 (owner 2026-10-20: «إلى الآن … لا يمكن التواصل مع قارئ الباركود»): a scan typed a code + Enter into whatever had the focus. On a
 * phone or tablet nothing has it (the search box is never focused there, so the screen keyboard stays down), a window is often open (the
 * receipt after a sale, the quantity sheet), goods-in lost the focus after the first item, and a scan into a quantity box became the
 * quantity. KWedge watches every key on the page (it never holds a key back from what has the focus), and at the end of a burst
 * (Enter, Tab, or a pause after 8+ characters) that came faster than a person types it hands the code to the app:
 *   - nothing had the focus (body, a button)          → onScan(code)               (Enter is not passed on: no button is pressed)
 *   - a number box (quantity, grams, money)            → its value is put back, then onScan(code)   (stricter: 6+ characters, < 35 ms)
 *   - a box that takes barcodes (isScanField) or text  → left to that box, as before
 * One instance per page: KWedge.attach({ active, isScanField, onScan }). KWedge.panel(el, lang, find) — the "Pemindai barcode" help and
 * test (every burst is shown with its speed and ending while it is open). KWedge.sameCode(a, b) — UPC-A / EAN-13 leading zeros.
 */
(function () {
  'use strict';
  var GAP = 90;            // ms: a longer pause ends the burst (Bluetooth scanners are slower than USB ones)
  var FAST = 50;           // a scan: on average under 50 ms a key (a fast person types ~120 ms a key)
  var MIN = 4;             // the shortest code read as a scan
  var NUM_FAST = 35, NUM_MIN = 6; // a burst in a number box: stricter, a quick "12" + Enter is never taken
  var NO_END_MIN = 8;      // a scanner set to send no Enter: a fast burst of 8+ characters followed by a pause
  var opts = null, st = null, timer = 0, probe = null; // probe: the "Tes pemindai" panel sees every burst while it is open

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function isText(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|range|color|image)$/i.test(el.type || '');
  }
  function isNumber(el) { return !!el && el.tagName === 'INPUT' && (el.type === 'number' || /^(numeric|decimal)$/.test(el.inputMode || el.getAttribute('inputmode') || '')); }
  function avg(s) { return s.n > 1 ? (s.last - s.t0) / (s.n - 1) : 999; }
  function clear() { if (timer) { clearTimeout(timer); timer = 0; } }

  /** The burst `s` is a scan: decide what to do with it; true when the app took it. */
  function finish(s, viaEnd, endKey) {
    var code = s.buf.trim(), a = avg(s), el = s.el;
    if (probe && code.length >= 2 && !(isText(el) && el.closest && !el.closest('#wedge-panel'))) { probe({ code: code, ms: Math.round(a), end: viaEnd ? endKey : '' }); return true; }
    if (!opts || code.length < MIN) return false;
    if (!isText(el)) {
      if (a >= FAST || (!viaEnd && code.length < NO_END_MIN)) return false;
      opts.onScan(code, { from: 'page' });
      return true;
    }
    if (opts.isScanField && opts.isScanField(el)) return false; // the search / barcode box reads it itself
    if (!isNumber(el) || a >= NUM_FAST || code.length < NUM_MIN) return false;
    try { el.value = s.val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { }
    opts.onScan(code, { from: 'field', el: el });
    return true;
  }

  function onKey(e) {
    if (!opts || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if (opts.active && !opts.active()) { st = null; return; }
    var t = now(), key = e.key || '', el = document.activeElement;
    if (key.length === 1) {
      if (!st || t - st.last > GAP) {
        if (key === ' ') { st = null; return; } // a space never starts a code (it presses a focused button)
        st = { buf: '', t0: t, last: t, n: 0, el: el, val: isText(el) ? el.value : null };
      }
      st.buf += key; st.n++; st.last = t;
      clear();
      timer = setTimeout(function () { var s = st; st = null; timer = 0; if (s && s.buf.trim().length >= (probe ? 2 : NO_END_MIN)) finish(s, false, ''); }, GAP + 10);
      return;
    }
    if (key !== 'Enter' && key !== 'Tab') return;
    var s = st; st = null; clear();
    if (!s || t - s.last > GAP) return;
    // the page may have moved the focus while the code came in (the sale screen sends the first key to its search box)
    if (isText(document.activeElement) && document.activeElement !== s.el && opts.isScanField && opts.isScanField(document.activeElement)) return;
    if (finish(s, true, key)) { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
  }

  /** v64: barcode digits that differ only by the leading zeros (UPC-A 12 digits ↔ EAN-13 "0…") or by spaces are the same code. */
  function sameCode(a, b) {
    a = String(a == null ? '' : a).trim().toLowerCase(); b = String(b == null ? '' : b).trim().toLowerCase();
    if (!a || !b) return false;
    if (a === b) return true;
    var da = a.replace(/[\s-]/g, ''), db = b.replace(/[\s-]/g, '');
    if (da === db) return true;
    return /^\d+$/.test(da) && /^\d+$/.test(db) && da.replace(/^0+/, '') === db.replace(/^0+/, '');
  }

  /* ---- "Pemindai barcode": how to connect one, and a test that says what arrives ---- */
  var TEXT = {
    id: { title: 'Pemindai barcode', hint: 'Pemindai yang bekerja seperti keyboard (USB atau Bluetooth mode HID) bisa dipakai di layar Jual, Barang masuk dan Stok opname — tanpa mengetuk kotak cari.',
      s1: 'Setel pemindai ke mode HID / Keyboard (lihat buku kecilnya: pindai kode "HID" atau "Keyboard"). Mode SPP / BLE tidak bisa.',
      s2: 'Bluetooth: pasangkan di Setelan Bluetooth HP / tablet (bukan di aplikasi). USB: colok langsung atau dengan kabel OTG.',
      s3: 'Setel akhiran (suffix) ke Enter / CR — kebanyakan pemindai sudah begitu.',
      s4: 'Pindai barcode apa saja sekarang. Hasilnya muncul di bawah.',
      wait: 'Menunggu pindaian…', got: 'Terbaca: {code}', speed: '{ms} ms per karakter', end_enter: 'diakhiri Enter ✓', end_tab: 'diakhiri Tab ✓', end_none: 'tanpa Enter — setel akhiran ke Enter',
      slow: 'Terlalu lambat untuk dikenali sebagai pindaian (di atas 50 ms per karakter): pakai kabel USB atau setel kecepatan pemindai ke cepat.',
      found: 'Barang: {name}', not_found: 'Belum ada barang dengan barcode ini di aplikasi', ok: 'Pemindai siap dipakai ✓' },
    ar: { title: 'قارئ الباركود', hint: 'القارئ الذي يعمل كلوحة مفاتيح (USB أو بلوتوث بوضع HID) يعمل في شاشة البيع والبضاعة الواردة وجرد المخزون — بدون الضغط على خانة البحث.',
      s1: 'اضبط القارئ على وضع HID / Keyboard (انظر كتيّبه: امسح رمز «HID» أو «Keyboard»). وضع SPP / BLE لا يعمل.',
      s2: 'بلوتوث: اقرنه من إعدادات البلوتوث في الهاتف / الجهاز اللوحي (وليس من التطبيق). USB: صِله مباشرة أو بكابل OTG.',
      s3: 'اضبط النهاية (suffix) على Enter / CR — أغلب القارئات مضبوطة هكذا.',
      s4: 'امسح أي باركود الآن. تظهر النتيجة في الأسفل.',
      wait: 'بانتظار المسح…', got: 'قُرئ: {code}', speed: '{ms} م.ث لكل حرف', end_enter: 'ينتهي بـ Enter ✓', end_tab: 'ينتهي بـ Tab ✓', end_none: 'بدون Enter — اضبط النهاية على Enter',
      slow: 'بطيء جدًا ليُعرف كمسح (أكثر من 50 م.ث لكل حرف): استعمل كابل USB أو اضبط سرعة القارئ على سريع.',
      found: 'الصنف: {name}', not_found: 'لا يوجد صنف بهذا الباركود في التطبيق بعد', ok: 'القارئ جاهز للاستعمال ✓' }
  };
  function text(lang, k, vars) { var T = TEXT[lang === 'ar' ? 'ar' : 'id'], s = T[k] !== undefined ? T[k] : TEXT.id[k] || k; Object.keys(vars || {}).forEach(function (v) { s = s.replace('{' + v + '}', vars[v]); }); return s; }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /** Draws the help + test into el; find(code) → the product's name or ''. Stop with the returned function (the modal's onClose). */
  function panel(el, lang, find) {
    var T = function (k, v) { return h(text(lang, k, v)); };
    el.innerHTML = '<div id="wedge-panel"><p class="small muted" style="margin-top:0">' + T('hint') + '</p><ol class="small" style="padding-inline-start:18px;margin:0 0 10px">'
      + ['s1', 's2', 's3', 's4'].map(function (k) { return '<li style="margin-bottom:4px">' + T(k) + '</li>'; }).join('') + '</ol>'
      + '<div class="card" id="wedge-res" role="status" style="padding:14px;text-align:center;min-height:72px"><span class="muted">' + T('wait') + '</span></div></div>';
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { }
    probe = function (r) {
      var box = el.querySelector('#wedge-res'); if (!box) { probe = null; return; }
      var name = find ? find(r.code) : '', slow = r.ms >= FAST, good = !slow && r.end && name;
      box.setAttribute('data-code', r.code); box.setAttribute('data-ms', r.ms); box.setAttribute('data-end', r.end || 'none');
      box.innerHTML = '<div style="font-size:20px;font-weight:700" class="num">' + T('got', { code: r.code }) + '</div>'
        + '<div class="small">' + T('speed', { ms: r.ms }) + ' · ' + T(r.end === 'Enter' ? 'end_enter' : r.end === 'Tab' ? 'end_tab' : 'end_none') + '</div>'
        + (slow ? '<div class="small red" data-slow>' + T('slow') + '</div>' : '')
        + '<div class="small" data-found="' + (name ? '1' : '0') + '">' + (name ? T('found', { name: name }) : T('not_found')) + '</div>'
        + (good || (!slow && r.end) ? '<div class="small okc" data-ok style="margin-top:4px"><b>' + T('ok') + '</b></div>' : '');
    };
    return function () { probe = null; };
  }

  window.KWedge = {
    attach: function (o) { opts = o || null; },
    sameCode: sameCode,
    panel: panel,
    text: text,
    _key: onKey // tests
  };
  window.addEventListener('keydown', onKey, true);
})();
