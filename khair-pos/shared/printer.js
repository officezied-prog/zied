/* Khair Mart — small receipt printers (v54, owner 2026-10-15: «أحاول أن أربط التطبيق بهذه المطبعة الصغيرة ولكن لا يعمل. أريد من التطبيق أن
   يرتبط بكثير من أنواع من المطابع حتى يستطيع طباعة الأوراق الصغيرة، الفاتورات الصغيرة»). Receipt printers (58 / 80 mm, "POS-58",
   VSC TM-58D, RPP02 …) speak ESC/POS. The page builds the receipt as ESC/POS bytes and sends them one of these ways (chosen per device):
     app     v58 (owner 2026-10-16: «يجب ان يتثبت مع تثبيت التطبيق مباشر لا يثبت لحاله»): inside the Khair Mart / Khair Kasir Android app
             (APK) the app itself prints on a paired Bluetooth printer (android/native/KhairPrintActivity.java, intent scheme
             khairprint) — no other app to install; the default there
     system  the browser's print window (as before: needs the printer's driver on a PC, or a print service app on Android)
     rawbt   Android: the free RawBT app (Google Play) prints to any Bluetooth / USB / Wi-Fi receipt printer it is paired with
     ble     Bluetooth straight from Chrome (Web Bluetooth) — printers with "BLE" (Bluetooth 4 Low Energy); no extra app
     usb     a USB cable straight from Chrome (WebUSB) — Android with an OTG cable, Chromebook, Mac, Linux (Windows keeps the
             printer for its own driver: there use "system" or "serial")
     serial  a COM port from Chrome on a computer (Web Serial) — USB-serial printers and paired Bluetooth printers (SPP)
   KPrint.cfg() / KPrint.save(cfg) — {mode, width: 58 | 80, cut, logo} kept on this device (localStorage kprint.cfg; inside the app kprint.cfg.app)
   KPrint.doc(width) — an ESC/POS builder: .center() .left() .bold(on) .big(on) .text(s) .line(s) .pair(l, r) .hr() .feed(n) .cut() .bytes()
   KPrint.send(bytes) → Promise (rejects with Error(code): NO_SUPPORT | CANCELLED | NOT_FOUND | WRITE_FAILED | NO_RAWBT)
   KPrint.receipt(rc, store) → the sale receipt as ESC/POS bytes (labels in Indonesian: receipt printers have no Arabic letters)
   KPrint.panel(el, lang, {store, printHTML}) — the "Printer struk" settings (ways, paper, cut, test print) drawn into el
   KPrint.text(lang, key, vars) / KPrint.errText(lang, e) — this file's own texts (id / ar)
   KPrint.support() → {app, ble, usb, serial, android}
   KPrint.go(url) opens the RawBT / Khair app link (replaceable, e.g. by the tests)
   KPrint.prepLogo() → Promise(true when the store logo is ready to print); KPrint.logoBytes(width) its ESC/POS raster (v68)
   KPrint.appLink(what) the Khair app link (intent:…;scheme=khairprint) inside the Khair Android app, else '' (v59: 'site-settings' for the camera)
   Only ASCII reaches the printer (receipt printers have no Arabic or emoji): accents are dropped, other characters become '?'. */
(function () {
  'use strict';
  if (window.KPrint) return;
  var MODES = ['app', 'system', 'rawbt', 'ble', 'usb', 'serial'];
  // v58: inside the Khair Android app (a Trusted Web Activity) the page is opened with the referrer android-app://<package>; kept for
  // the reloads of this app (the update check reloads the page)
  // v64 (owner 2026-10-20: «لا يمكن تواصل التطبيق بآلة استخراج فاتورة الدفع الصغيرة»): kept per app — the owner app and Khair Kasir share
  // this site's storage, so the app opened last sent the other one's prints to its own package (or to one not installed)
  var APP = (function () {
    var want = /\/kasir(\/|$)/.test(location.pathname) ? 'com.khairmart.kasir' : 'com.khairmart.owner';
    var m = /^android-app:\/\/(com\.khairmart\.(?:owner|kasir))/.exec(document.referrer || '');
    try {
      if (m) { localStorage.setItem('kprint.app:' + m[1], '1'); return m[1]; }
      return localStorage.getItem('kprint.app:' + want) || localStorage.getItem('kprint.app') === want ? want : '';
    } catch (e) { return m ? m[1] : ''; }
  })();
  // v64: the way chosen in a Chrome tab no longer carries into the app (they share this site's storage): the app keeps its own, and
  // starts on its own Bluetooth printing
  var KEY = APP ? 'kprint.cfg.app' : 'kprint.cfg';
  function cfg() {
    var c = {};
    try { c = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { c = {}; }
    var mode = MODES.indexOf(c.mode) >= 0 && (c.mode !== 'app' || APP) ? c.mode : APP ? 'app' : 'system';
    return { mode: mode, width: Number(c.width) === 80 ? 80 : 58, cut: c.cut !== false, logo: c.logo !== false };
  }
  function save(c) { try { localStorage.setItem(KEY, JSON.stringify({ mode: c.mode, width: c.width, cut: c.cut, logo: c.logo !== false })); } catch (e) { } return cfg(); }
  var android = /Android/i.test(navigator.userAgent || '');
  function support() { return { app: !!APP, ble: !!(navigator.bluetooth && navigator.bluetooth.requestDevice), usb: !!(navigator.usb && navigator.usb.requestDevice), serial: !!(navigator.serial && navigator.serial.requestPort), android: android }; }

  /* ---- text → printable ASCII ---- */
  var MAP = { '→': '->', '←': '<-', '×': 'x', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '*', '·': '-', '≥': '>=', '≤': '<=', ' ': ' ' };
  function ascii(s) {
    s = String(s == null ? '' : s).replace(/[⁦-⁩‎‏]/g, '');
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) { }
    var out = '';
    for (var i = 0; i < s.length; i++) { var ch = s[i], c = ch.charCodeAt(0); out += MAP[ch] !== undefined ? MAP[ch] : (c === 10 || (c >= 32 && c < 127)) ? ch : '?'; }
    return out;
  }
  /** Words wrapped to n characters (a word longer than n is cut). */
  function wrap(s, n) {
    var out = [];
    String(s).split('\n').forEach(function (para) {
      var line = '';
      para.split(/\s+/).filter(Boolean).forEach(function (w) {
        while (w.length > n) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, n)); w = w.slice(n); }
        if (!line) line = w; else if (line.length + 1 + w.length <= n) line += ' ' + w; else { out.push(line); line = w; }
      });
      out.push(line);
    });
    return out;
  }

  /* ---- ESC/POS builder ---- */
  function doc(width) {
    var cols = Number(width) === 80 ? 48 : 32, buf = [], big = false;
    var b = function () { for (var i = 0; i < arguments.length; i++) buf.push(arguments[i]); return d; };
    var put = function (s) { s = ascii(s); for (var i = 0; i < s.length; i++) buf.push(s.charCodeAt(i) & 0x7f); };
    var n = function () { return big ? Math.floor(cols / 2) : cols; };
    var d = {
      cols: cols,
      init: function () { return b(0x1b, 0x40, 0x1b, 0x74, 0x00); }, // ESC @ (reset), ESC t 0 (PC437: ASCII is the same on every printer)
      left: function () { return b(0x1b, 0x61, 0); }, center: function () { return b(0x1b, 0x61, 1); }, right: function () { return b(0x1b, 0x61, 2); },
      bold: function (on) { return b(0x1b, 0x45, on ? 1 : 0); },
      big: function (on) { big = !!on; return b(0x1d, 0x21, on ? 0x11 : 0); }, // GS ! — double width + height
      text: function (s) { wrap(s, n()).forEach(function (l) { put(l); buf.push(10); }); return d; },
      line: function (s) { put(String(s).slice(0, n())); buf.push(10); return d; },
      /** "label ........ value" on one line (the label wraps when it is long; the value stays right). */
      pair: function (l, r) {
        l = ascii(l); r = ascii(r); var w = n();
        if (l.length + 1 + r.length <= w) { put(l + new Array(w - l.length - r.length + 1).join(' ') + r); buf.push(10); return d; }
        var ls = wrap(l, w); ls.forEach(function (x, i) { if (i < ls.length - 1) { put(x); buf.push(10); } });
        var last = ls[ls.length - 1] || '';
        if (last.length + 1 + r.length <= w) put(last + new Array(w - last.length - r.length + 1).join(' ') + r); else { put(last); buf.push(10); put(new Array(Math.max(0, w - r.length) + 1).join(' ') + r); }
        buf.push(10); return d;
      },
      hr: function (ch) { put(new Array(n() + 1).join(ch || '-')); buf.push(10); return d; },
      feed: function (k) { return b(0x1b, 0x64, Math.max(0, Math.min(10, k || 1))); }, // ESC d n
      cut: function () { return b(0x1d, 0x56, 0x42, 0x00); }, // GS V 66 0 — feed + cut (ignored by printers without a cutter)
      raw: function (arr) { for (var i = 0; i < arr.length; i++) buf.push(arr[i]); return d; },
      bytes: function () { return new Uint8Array(buf); }
    };
    return d.init();
  }

  /* ---- v68 (owner 2026-10-20: «تم إصلاح المطبعة الصغيرة، ولكن لا يوجد فيها اللوجو حق الشركة»): the store logo on top of the receipt.
     The site's logo.png is drawn once in a canvas and made black / white (a thermal printer prints dots — no colour, no grey: the red
     and the blue print black, the white stays paper), cropped to its ink and sent as a GS v 0 raster image: 160 dots wide (2 cm) on 58 mm
     paper (384 dots), 192 on 80 mm (576), centred by blank dots on its left (so no printer has to centre an image itself), in bands of
     48 rows (small printer buffers). Ready a moment after the page opens; a print before that goes without it and readies it. */
  var LOGO = { src: '', bytes: {}, p: null }, LOGO_W = { 58: [384, 160], 80: [576, 192] }; // v68 (owner: «Logo should small not big»)
  try {
    var me = document.currentScript || document.querySelector('script[src*="shared/printer.js"]');
    LOGO.src = me && me.src ? new URL('../logo.png', me.src).href : '';
  } catch (e) { LOGO.src = ''; }
  function logoRaster(img, paper, w) {
    var h = Math.max(1, Math.round(img.naturalHeight * w / img.naturalWidth)), cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
    var px = g.getImageData(0, 0, w, h).data;
    var ink = function (x, y) { var i = (y * w + x) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < 170; };
    var rowInk = function (y) { for (var x = 0; x < w; x++) if (ink(x, y)) return true; return false; };
    var top = 0, bot = h - 1;
    while (top < h && !rowInk(top)) top++;
    while (bot > top && !rowInk(bot)) bot--;
    if (top >= h) return [];
    var pad = Math.floor((paper - w) / 16) * 8, bpr = (pad + w) / 8, out = [0x1b, 0x61, 0]; // left: the blank dots centre it
    for (var y0 = top; y0 <= bot; y0 += 48) {
      var rows = Math.min(48, bot - y0 + 1);
      out.push(0x1d, 0x76, 0x30, 0, bpr & 255, bpr >> 8, rows & 255, rows >> 8);
      for (var y = y0; y < y0 + rows; y++) for (var bx = 0; bx < bpr; bx++) {
        var v = 0;
        for (var k = 0; k < 8; k++) { var x = bx * 8 + k - pad; if (x >= 0 && x < w && ink(x, y)) v |= 0x80 >> k; }
        out.push(v);
      }
    }
    out.push(0x1b, 0x64, 1); // a line of paper under it
    return out;
  }
  function prepLogo() {
    if (LOGO.p) return LOGO.p;
    LOGO.p = new Promise(function (res) {
      if (!LOGO.src || typeof Image === 'undefined') { res(false); return; }
      var img = new Image();
      img.onload = function () {
        try { [58, 80].forEach(function (k) { LOGO.bytes[k] = logoRaster(img, LOGO_W[k][0], LOGO_W[k][1]); }); res(true); } catch (e) { LOGO.p = null; res(false); }
      };
      img.onerror = function () { LOGO.p = null; res(false); }; // tried again with the next print
      img.src = LOGO.src;
    });
    return LOGO.p;
  }
  setTimeout(function () { try { var c = cfg(); if (c.logo && c.mode !== 'system') prepLogo(); } catch (e) { } }, 1200);
  function addLogo(d, c) {
    var lg = c.logo ? LOGO.bytes[c.width] : null;
    if (lg && lg.length) d.raw(lg); else if (c.logo) prepLogo();
  }

  /* ---- transports ---- */
  function err(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  // RawBT (Android app ru.a402d.rawbtprinter): an intent link with the bytes in base64; a phone without RawBT opens its Play Store page
  function viaRawBT(bytes) {
    var url = android ? 'intent:base64,' + b64(bytes) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;' : 'rawbt:base64,' + b64(bytes);
    try { (window.KPrint.go || function (u) { window.location.href = u; })(url); } catch (e) { return Promise.reject(err('NO_RAWBT')); }
    return Promise.resolve('rawbt');
  }
  // v58 the Khair Android app prints itself (classic Bluetooth, the paired printer it remembers); "choose" asks for the printer again
  function appLink(what) { return 'intent:' + what + '#Intent;scheme=khairprint;package=' + APP + ';end;'; }
  function viaApp(bytes) {
    if (!APP) return Promise.reject(err('NO_SUPPORT'));
    try { (window.KPrint.go || function (u) { window.location.href = u; })(appLink('base64,' + b64(bytes))); } catch (e) { return Promise.reject(err('WRITE_FAILED', e && e.message)); }
    return Promise.resolve('app');
  }
  // Web Bluetooth: the GATT services receipt printers use for their "serial over BLE"
  var BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455',
    '0000ff00-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ae30-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb']; // v64: FFF0, used by many cheap BLE printers
  var ble = { dev: null, ch: null };
  function bleChar(server) {
    return server.getPrimaryServices().then(function (svcs) {
      var tryAt = function (i) {
        if (i >= svcs.length) return Promise.reject(err('NOT_FOUND', 'no writable characteristic'));
        return svcs[i].getCharacteristics().then(function (chs) {
          var c = chs.filter(function (x) { return x.properties && (x.properties.writeWithoutResponse || x.properties.write); })[0];
          return c || tryAt(i + 1);
        }, function () { return tryAt(i + 1); });
      };
      return tryAt(0);
    });
  }
  function viaBLE(bytes) {
    if (!support().ble) return Promise.reject(err('NO_SUPPORT'));
    var ready = ble.dev && ble.dev.gatt && ble.dev.gatt.connected && ble.ch ? Promise.resolve(ble.ch)
      : (ble.dev ? Promise.resolve(ble.dev) : navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES }))
        .then(function (dev) { ble.dev = dev; return dev.gatt.connect(); })
        .then(bleChar).then(function (c) { ble.ch = c; return c; });
    return ready.then(function (c) {
      var fast = c.properties && c.properties.writeWithoutResponse, size = fast ? 20 : 180, i = 0;
      var next = function () {
        if (i >= bytes.length) return 'ble';
        var part = bytes.slice(i, i + size); i += size;
        var w = fast && c.writeValueWithoutResponse ? c.writeValueWithoutResponse(part) : (c.writeValueWithResponse ? c.writeValueWithResponse(part) : c.writeValue(part));
        return w.then(function () { return fast && i % 400 < size ? sleep(8) : null; }).then(next);
      };
      return next();
    }).catch(function (e) {
      ble.ch = null;
      if (e && e.name === 'NotFoundError') throw err('CANCELLED');
      throw e && e.code ? e : err('WRITE_FAILED', e && e.message);
    });
  }
  // WebUSB: the printer's bulk OUT endpoint (class 7 "printer", or any interface that has one)
  function usbOut(dev) {
    var cfg0 = dev.configuration || (dev.configurations && dev.configurations[0]);
    var hit = null;
    (cfg0 ? cfg0.interfaces : []).forEach(function (itf) {
      (itf.alternates || [itf.alternate]).forEach(function (alt) {
        if (!alt || hit) return;
        var ep = (alt.endpoints || []).filter(function (e) { return e.direction === 'out' && e.type === 'bulk'; })[0];
        if (ep && (!hit || alt.interfaceClass === 7)) hit = { itf: itf.interfaceNumber, alt: alt.alternateSetting, ep: ep.endpointNumber };
      });
    });
    return hit;
  }
  function viaUSB(bytes) {
    if (!support().usb) return Promise.reject(err('NO_SUPPORT'));
    return navigator.usb.getDevices().then(function (list) { return list[0] || navigator.usb.requestDevice({ filters: [] }); })
      .then(function (dev) {
        return (dev.opened ? Promise.resolve() : dev.open())
          .then(function () { return dev.configuration ? null : dev.selectConfiguration(1); })
          .then(function () {
            var o = usbOut(dev); if (!o) throw err('NOT_FOUND', 'no USB printer endpoint');
            return dev.claimInterface(o.itf).catch(function () { }).then(function () { return dev.transferOut(o.ep, bytes); });
          });
      }).then(function () { return 'usb'; }, function (e) {
        if (e && e.name === 'NotFoundError') throw err('CANCELLED');
        throw e && e.code ? e : err('WRITE_FAILED', e && e.message);
      });
  }
  // Web Serial: a COM port (remembered after the first choice)
  function viaSerial(bytes) {
    if (!support().serial) return Promise.reject(err('NO_SUPPORT'));
    return navigator.serial.getPorts().then(function (ports) { return ports[0] || navigator.serial.requestPort(); })
      .then(function (port) {
        return (port.writable ? Promise.resolve() : port.open({ baudRate: 9600 })).then(function () {
          var w = port.writable.getWriter();
          return w.write(bytes).then(function () { w.releaseLock(); }, function (e) { w.releaseLock(); throw e; });
        });
      }).then(function () { return 'serial'; }, function (e) {
        if (e && e.name === 'NotFoundError') throw err('CANCELLED');
        throw e && e.code ? e : err('WRITE_FAILED', e && e.message);
      });
  }
  function send(bytes, mode) {
    mode = mode || cfg().mode;
    return mode === 'app' ? viaApp(bytes) : mode === 'rawbt' ? viaRawBT(bytes) : mode === 'ble' ? viaBLE(bytes) : mode === 'usb' ? viaUSB(bytes) : mode === 'serial' ? viaSerial(bytes) : Promise.reject(err('NO_SUPPORT', 'system'));
  }

  /* ---- the sale receipt (the apps' receipt object: invoice_no, sale_time, cashier, customer_name, lines, totals, method, parts …) ---- */
  var R = { no: 'No', date: 'Tgl', cashier: 'Kasir', customer: 'Pelanggan', subtotal: 'Subtotal', disc: 'Diskon', mdisc: 'Diskon member', fee: 'Biaya kirim struk',
    promo: 'Kode promo', total: 'TOTAL', paid: 'Bayar', change: 'Kembalian', debt: 'Hutang', debt_total: 'Total hutang', approved: 'Disetujui', phone: 'Telp',
    pending: 'BELUM TERKIRIM', recorded: 'Transaksi direkam untuk layanan & keamanan', member: 'Member {no} - pembelian ke-{n}',
    pm: { tunai: 'Tunai', transfer: 'Transfer', qris: 'QRIS', kartu: 'Kartu', hutang: 'Hutang', campur: 'Campur' } };
  var NF = new Intl.NumberFormat('id-ID'), num = function (v) { v = Number(v); return isFinite(v) ? v : 0; }, N = function (v) { return NF.format(Math.round(num(v))); };
  function qty(q) { return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 }).format(num(q)); }
  function when(iso, day) {
    var d = new Date(iso || day || Date.now()); if (isNaN(d)) return String(day || '');
    try { return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function receipt(rc, st) {
    st = st || {}; var c = cfg(), d = doc(c.width), pm = function (m) { return R.pm[m] || m || ''; };
    addLogo(d, c);
    d.center().bold(true).big(true).text(st.store_name || 'Khair Mart').big(false).bold(false);
    if (st.address) d.text(st.address);
    if (st.phone) d.text(R.phone + ' ' + st.phone);
    d.hr();
    if (rc.pending) d.bold(true).text(R.pending).bold(false);
    d.left().pair(R.no, (rc.invoice_no || '-') + (rc.invoice_no && rc.cashier ? ' ' + rc.cashier : '')) // v68: the employee's name with the number.pair(R.date, when(rc.sale_time, rc.sale_date)).pair(R.cashier, rc.cashier || '').pair(R.customer, rc.customer_name || '').hr();
    (rc.lines || []).forEach(function (l) { d.text((l.name || '') + (l.price_type === 'grosir' ? ' (G)' : '')); d.pair('  ' + qty(l.qty) + ' x ' + N(l.unit_price), N(l.line_total)); });
    d.hr();
    if (num(rc.discount)) d.pair(R.subtotal, N(rc.subtotal));
    if (num(rc.member_disc)) d.pair(R.mdisc + (rc.member && rc.member.pct ? ' ' + rc.member.pct + '%' : ''), '-' + N(rc.member_disc));
    if (num(rc.discount) - num(rc.member_disc) > 0) d.pair(R.disc, '-' + N(num(rc.discount) - num(rc.member_disc)));
    if (num(rc.send_fee)) d.pair(R.fee, N(rc.send_fee));
    if (rc.promo_code) d.pair(R.promo, rc.promo_code);
    d.bold(true).pair(R.total, 'Rp ' + N(rc.total)).bold(false);
    d.pair(R.paid + ' (' + pm(rc.method) + ')', N(rc.paid));
    (rc.parts || []).forEach(function (x) { d.pair('  ' + pm(x.m), N(x.a)); });
    if (num(rc.change)) d.bold(true).pair(R.change, N(rc.change)).bold(false);
    if (num(rc.debt)) d.bold(true).pair(R.debt, N(rc.debt)).bold(false);
    if (num(rc.debt) && num(rc.debt_after)) d.pair(R.debt_total, N(rc.debt_after));
    if (num(rc.debt) && rc.approved_by) d.pair(R.approved, rc.approved_by);
    if (rc.member) d.hr().center().text(R.member.replace('{no}', rc.member.member_no || '').replace('{n}', rc.member.purchase_no || ''));
    d.hr().center();
    String(st.receipt_footer || '').split('\n').filter(function (x) { return x.trim(); }).forEach(function (x) { d.text(x); });
    if (rc.recorded) d.text(R.recorded);
    d.feed(3); if (c.cut) d.cut();
    return d.bytes();
  }
  function testBytes(st) {
    var c = cfg(), d = doc(c.width);
    addLogo(d, c);
    d.center().bold(true).big(true).text((st && st.store_name) || 'Khair Mart').big(false).text('Tes printer OK').bold(false)
      .text(when()).text(TEXT.id['mode_' + c.mode] + ' - ' + c.width + ' mm').left().hr()
      .line('1234567890123456789012345678901234567890123456789').pair('Total', 'Rp 123.456').hr('=').feed(3);
    if (c.cut) d.cut();
    return d.bytes();
  }

  /* ---- the settings panel and its texts ---- */
  var TEXT = {
    id: { title: 'Printer struk', hint: 'Pilih cara mencetak struk dari perangkat ini, lalu tekan "Tes cetak". Printer struk kecil 58 / 80 mm (POS-58, VSC, RPP02 …).',
      mode_app: 'Bluetooth (aplikasi Khair)', desc_app: 'Langsung dari aplikasi Khair di HP ini, tanpa aplikasi lain. Pasangkan printer dulu di Setelan Bluetooth HP (PIN biasanya 0000 / 1234), lalu pilih printernya di sini.',
      test_sent_app: 'Dikirim ke aplikasi Khair — hasilnya muncul di layar: "Struk tercetak", atau kenapa gagal dan tombol "Coba lagi" / "Pilih printer lain".',
      choose: 'Pilih / ganti printer', apk: 'Di Android: pasang aplikasi Khair (APK) — mencetak sendiri ke printer Bluetooth, tanpa RawBT.',
      mode_system: 'Jendela cetak (driver)', mode_rawbt: 'RawBT (Android)', mode_ble: 'Bluetooth langsung (BLE)', mode_usb: 'Kabel USB langsung', mode_serial: 'Port COM (komputer)',
      desc_system: 'Seperti sebelumnya: jendela cetak browser. Di komputer pasang driver printernya dulu.',
      desc_rawbt: 'Paling cocok untuk HP / tablet Android: pasang aplikasi gratis RawBT, pilih printernya di sana (Bluetooth / USB / Wi-Fi).',
      desc_ble: 'Tanpa aplikasi tambahan, dari Chrome: hanya printer Bluetooth BLE. Pertama kali pilih printernya.',
      desc_usb: 'Kabel USB (OTG di HP Android). Di Windows pakai "Jendela cetak" atau "Port COM".',
      desc_serial: 'Chrome di komputer: printer USB-serial atau Bluetooth yang sudah dipasangkan (COM).',
      no_support: 'Tidak tersedia di browser / perangkat ini', width: 'Lebar kertas', cut: 'Potong kertas di akhir (jika printer punya pemotong)', logo: 'Cetak logo toko di atas struk',
      test: 'Tes cetak', sending: 'Mengirim ke printer…', test_sent: 'Terkirim ke printer. Kalau kertas tidak keluar: cek printer menyala, sudah dipasangkan, dan pilih cara lain.',
      sent: 'Struk dikirim ke printer', e_cancel: 'Tidak ada printer yang dipilih', e_support: 'Cara cetak ini tidak didukung di browser ini — pilih cara lain di Printer struk',
      e_notfound: 'Printer tidak dikenali — coba cara lain (RawBT / Port COM)', e_fail: 'Gagal mengirim ke printer: {msg}' },
    ar: { title: 'طابعة الإيصالات', hint: 'اختر طريقة طباعة الإيصال من هذا الجهاز، ثم اضغط «طباعة تجربة». طابعات الإيصالات الصغيرة 58 / 80 مم.',
      mode_app: 'بلوتوث (تطبيق خير)', desc_app: 'مباشرة من تطبيق خير في هذا الهاتف، بدون أي تطبيق آخر. اقرن الطابعة أولًا من إعدادات البلوتوث في الهاتف (الرمز غالبًا 0000 / 1234)، ثم اخترها هنا.',
      test_sent_app: 'أُرسل إلى تطبيق خير — تظهر النتيجة على الشاشة: «تمت الطباعة»، أو سبب الفشل مع زر «أعد المحاولة» / «اختر طابعة أخرى».',
      choose: 'اختر / غيّر الطابعة', apk: 'في أندرويد: ثبّت تطبيق خير (APK) — يطبع بنفسه على طابعة البلوتوث بدون RawBT.',
      mode_system: 'نافذة الطباعة (التعريف)', mode_rawbt: 'RawBT (أندرويد)', mode_ble: 'بلوتوث مباشر (BLE)', mode_usb: 'كابل USB مباشر', mode_serial: 'منفذ COM (الحاسوب)',
      desc_system: 'كما كان: نافذة الطباعة في المتصفح. في الحاسوب ثبّت تعريف الطابعة أولًا.',
      desc_rawbt: 'الأنسب للهاتف / الجهاز اللوحي أندرويد: ثبّت تطبيق RawBT المجاني واختر الطابعة فيه (بلوتوث / USB / Wi-Fi).',
      desc_ble: 'بدون تطبيق إضافي من Chrome: طابعات البلوتوث BLE فقط. في المرة الأولى اختر الطابعة.',
      desc_usb: 'كابل USB (OTG في هاتف أندرويد). في Windows استعمل «نافذة الطباعة» أو «منفذ COM».',
      desc_serial: 'Chrome في الحاسوب: طابعة USB تسلسلية أو بلوتوث مقترنة (COM).',
      no_support: 'غير متاح في هذا المتصفح / الجهاز', width: 'عرض الورق', cut: 'قصّ الورق في النهاية (إن كان في الطابعة قاطع)', logo: 'طباعة شعار المتجر أعلى الإيصال',
      test: 'طباعة تجربة', sending: 'جارٍ الإرسال إلى الطابعة…', test_sent: 'أُرسل إلى الطابعة. إذا لم تخرج الورقة: تأكد أن الطابعة تعمل ومقترنة، أو اختر طريقة أخرى.',
      sent: 'أُرسل الإيصال إلى الطابعة', e_cancel: 'لم يتم اختيار طابعة', e_support: 'هذه الطريقة غير مدعومة في هذا المتصفح — اختر طريقة أخرى في طابعة الإيصالات',
      e_notfound: 'لم يتم التعرف على الطابعة — جرّب طريقة أخرى (RawBT / منفذ COM)', e_fail: 'تعذّر الإرسال إلى الطابعة: {msg}' }
  };
  function text(lang, k, vars) { var T = TEXT[lang === 'ar' ? 'ar' : 'id'], s = T[k] !== undefined ? T[k] : TEXT.id[k] || k; Object.keys(vars || {}).forEach(function (v) { s = s.replace('{' + v + '}', vars[v]); }); return s; }
  function errText(lang, e) { var k = e && e.code; return text(lang, k === 'CANCELLED' ? 'e_cancel' : k === 'NO_SUPPORT' ? 'e_support' : k === 'NOT_FOUND' ? 'e_notfound' : 'e_fail', { msg: e && e.message ? String(e.message).slice(0, 80) : '' }); }
  function h(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function panel(el, lang, opts) {
    opts = opts || {};
    var sup = support(), ok = function (m) { return m === 'system' || m === 'rawbt' || !!sup[m]; }, T = function (k, v) { return h(text(lang, k, v)); };
    var shown = MODES.filter(function (m) { return m !== 'app' || APP; }); // the app's own printing only inside the Khair Android app
    var draw = function () {
      var c = cfg();
      el.innerHTML = '<p class="small muted" style="margin-top:0">' + T('hint') + '</p>'
        + (!APP && android && opts.apk ? '<p class="small" id="prn-apk" style="margin-top:0">📲 <a href="' + h(opts.apk) + '">' + T('apk') + '</a></p>' : '')
        + '<div class="list" id="prn-m" role="radiogroup">' + shown.map(function (m) {
        return '<button type="button" class="li' + (c.mode === m ? ' on' : '') + '" role="radio" aria-checked="' + (c.mode === m) + '" data-m="' + m + '" id="prn-m-' + m + '"' + (ok(m) ? '' : ' disabled') + '>'
          + '<div class="grow"><div class="t">' + (c.mode === m ? '● ' : '○ ') + T('mode_' + m) + '</div><div class="s">' + T(ok(m) ? 'desc_' + m : 'no_support') + '</div></div></button>';
      }).join('') + '</div>'
        + '<div class="li" style="margin-top:10px"><div class="grow t">' + T('width') + '</div><div class="seg" style="min-width:150px" id="prn-w"><button type="button" class="' + (c.width === 58 ? 'on' : '') + '" data-w="58">58 mm</button><button type="button" class="' + (c.width === 80 ? 'on' : '') + '" data-w="80">80 mm</button></div></div>'
        + '<label class="check" style="margin-top:8px"><input type="checkbox" id="prn-cut"' + (c.cut ? ' checked' : '') + '> ' + T('cut') + '</label>'
        + '<label class="check" style="margin-top:8px"><input type="checkbox" id="prn-logo"' + (c.logo ? ' checked' : '') + '> ' + T('logo') + '</label>'
        + (c.mode === 'app' ? '<button type="button" class="btn block" id="prn-choose" style="margin-top:10px">' + T('choose') + '</button>' : '')
        + '<button type="button" class="btn primary block" id="prn-test" style="margin-top:12px">' + T('test') + '</button><div class="small" id="prn-status" role="status" style="margin-top:8px"></div>';
      Array.prototype.forEach.call(el.querySelectorAll('#prn-m [data-m]'), function (b) { b.onclick = function () { save(Object.assign(cfg(), { mode: b.dataset.m })); ble.dev = null; ble.ch = null; draw(); }; });
      Array.prototype.forEach.call(el.querySelectorAll('#prn-w [data-w]'), function (b) { b.onclick = function () { save(Object.assign(cfg(), { width: Number(b.dataset.w) })); draw(); }; });
      el.querySelector('#prn-cut').onchange = function (e) { save(Object.assign(cfg(), { cut: e.target.checked })); };
      el.querySelector('#prn-logo').onchange = function (e) { save(Object.assign(cfg(), { logo: e.target.checked })); if (e.target.checked) prepLogo(); };
      var chooseBtn = el.querySelector('#prn-choose');
      if (chooseBtn) chooseBtn.onclick = function () { save(cfg()); (window.KPrint.go || function (u) { window.location.href = u; })(appLink('choose')); };
      el.querySelector('#prn-test').onclick = function (e) {
        var btn = e.currentTarget, st = el.querySelector('#prn-status'), cc = cfg();
        if (cc.mode === 'system') { if (opts.printHTML) opts.printHTML('<div class="receipt w' + cc.width + '" id="receipt"><div class="c b big">' + h((opts.store || {}).store_name || 'Khair Mart') + '</div><div class="c">Tes printer OK</div></div>'); return; }
        btn.disabled = true; st.className = 'small'; st.textContent = text(lang, 'sending');
        (cc.logo ? prepLogo() : Promise.resolve(false)).then(function () { return send(testBytes(opts.store)); }).then(function () { st.className = 'small okc'; st.textContent = text(lang, cc.mode === 'app' ? 'test_sent_app' : 'test_sent'); }, function (er) { st.className = 'small red'; st.textContent = errText(lang, er); })
          .then(function () { btn.disabled = false; });
      };
    };
    draw();
  }
  window.KPrint = { MODES: MODES, cfg: cfg, save: save, support: support, doc: doc, send: send, receipt: receipt, testBytes: testBytes, panel: panel, prepLogo: prepLogo, logoBytes: function (w) { return LOGO.bytes[Number(w) === 80 ? 80 : 58] || null; }, text: text, errText: errText, ascii: ascii, wrap: wrap, appLink: function (what) { return APP ? appLink(what) : ''; }, forget: function () { ble.dev = null; ble.ch = null; } };
})();
