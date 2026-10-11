/* Khair Mart — tamper guard (v36), shared by the owner app, Khair Kasir and Khair Sales.
   v36 (owner 2026-10-11: «صور من يحاول كتابة الكود هذا ضروري جدا» — earlier «الكاميرا الأمامية تكفي مع لافتة»
   and «… أو أرقام متتالية أو استعمال الرموز مباشرة يغلق التطبيق»):
   - digitAttempt(el, rule, value): a run of 8+ digits that looks like a sequence (12345678, 87654321, 1234567890),
     one repeated digit (11111111) or a short block repeated (12121212, 123123123, 12341234) typed into a FREE-TEXT
     field (person / product / shop name, note, reason, address, chat). Never in numbers, money, quantities, barcodes /
     SKU, phones, PINs, e-mail, document / reference numbers, promo codes or any search box (a barcode scanner types there),
     and never when the digits arrive as a scanner burst. Returns the run, or ''.
   - snap(): one FRONT-camera frame as a small JPEG (longest side ≤ 640 px) → { status: 'ok', photo } or
     { status: 'denied' | 'none' | 'error' } (the lock works the same without a photo).
   - prime(): asks the camera permission once when a staff member logs in on a store device, so a later shot is silent
     (browsers only allow a silent shot after a grant). A permanent line on the login / lock screen tells people the
     device is watched by a camera for security (UU PDP notice; the owner's decision 2026-10-11).
   - veil(msg) / unveil(): an instant full-screen cover while the photo is taken and the lock is reported.
   - mock: the demo backends' report_tamper / list_tamper_shots (kept here so the three demo servers stay identical). */
(function (root) {
  'use strict';
  var MIN_RUN = 8;
  var asciiDigits = function (v) {
    return String(v == null ? '' : v).replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x660); })
      .replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x6F0); });
  };
  /** True when the whole run is a step-by-one sequence (wrapping 9→0 / 0→9), one repeated digit, or a block of ≤ 4 digits repeated. */
  function isPatternRun(r) {
    if (r.length < MIN_RUN) return false;
    var up = true, down = true, i;
    for (i = 1; i < r.length; i++) {
      var d = (Number(r[i]) - Number(r[i - 1]) + 10) % 10;
      if (d !== 1) up = false;
      if (d !== 9) down = false;
    }
    if (up || down) return true;
    for (var p = 1; p <= 4; p++) {
      if (r.length < p * 2) break;
      var ok = true;
      for (i = p; i < r.length; i++) if (r[i] !== r[i % p]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }
  /** The first maximal digit run of 8+ that is a pattern, or ''. A real phone / invoice number inside a note is not a pattern. */
  function digitRun(v) {
    var runs = asciiDigits(v).match(/\d{8,}/g) || [];
    for (var i = 0; i < runs.length; i++) if (isPatternRun(runs[i])) return runs[i];
    return '';
  }
  // Rules (data-rule) of free text in the three apps; every other rule (num, phone, pin, sku, doc, email, unit, search) is never checked.
  var TEXT_RULES = ['', 'name', 'pname', 'cat', 'text', 'long'];
  // Field ids / names whose words say "a number belongs here" — whitelisted even without a rule (strict on purpose).
  var NUMERIC_WORDS = /(^|[-_ ])(q|qs|search|cari|ref|sku|barcode|bc|scan|phone|hp|tel|wa|pin|key|code|kode|promo|price|harga|retail|whole|cost|qty|amt|amount|nominal|denom|cash|paid|money|counted|maxdisc|wage|rek|acc|account|bank_no|npwp|nik|doc|no|nomor|invoice|inv|plate|plat|veh|vehicle|lat|lng|url|link|email|mail|days|grace|radius|tier|pct)([-_ ]|$)/i;
  /** A free-text field (where a run of digits has no business), or false. Strict: when in doubt, it is NOT free text. */
  function freeText(el, rule) {
    if (!el || !el.tagName) return false;
    if (el.closest && el.closest('[data-digits-ok]')) return false; // pasted lists (Google Maps text) etc.
    var tag = el.tagName;
    if (tag === 'INPUT') { if (String(el.getAttribute('type') || 'text').toLowerCase() !== 'text') return false; }
    else if (tag !== 'TEXTAREA') return false;
    var im = String(el.getAttribute('inputmode') || '').toLowerCase();
    if (im && im !== 'text') return false; // numeric / decimal / tel / email / url / search keyboards
    var ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
    if (/one-time-code|tel|cc-|email|postal-code/.test(ac)) return false;
    var r = rule == null ? String((el.dataset && el.dataset.rule) || '') : String(rule);
    if (TEXT_RULES.indexOf(r) < 0) return false;
    var words = String(el.id || '') + ' ' + String(el.getAttribute('name') || '') + ' ' + Object.keys(el.dataset || {}).join(' ');
    if (NUMERIC_WORDS.test(words.replace(/([a-z])([A-Z])/g, '$1-$2'))) return false;
    return true;
  }
  // Keyboard-wedge barcode readers type a whole code in a burst (a few ms per character); people cannot.
  var SCAN_N = MIN_RUN, SCAN_MS = 300;
  function track(e) {
    var el = e && e.target; if (!el || !el.tagName) return;
    var single = e.inputType === 'insertText' && typeof e.data === 'string' && e.data.length === 1;
    var a = el.__kgKeys || (el.__kgKeys = []);
    if (!single) { a.length = 0; return; }
    a.push(Date.now()); if (a.length > SCAN_N) a.shift();
  }
  function scannerBurst(el) {
    var a = el && el.__kgKeys; return !!(a && a.length >= SCAN_N && a[a.length - 1] - a[0] < SCAN_MS);
  }
  /** The run that trips the lock in this field (value = the field's text), or ''. */
  function digitAttempt(el, rule, value) {
    if (!freeText(el, rule) || scannerBurst(el)) return '';
    return digitRun(value == null ? el.value : value);
  }

  /* ---- camera ---- */
  function withTimeout(p, ms) {
    return new Promise(function (ok, bad) {
      var done = false, tm = setTimeout(function () { if (!done) { done = true; var e = new Error('timeout'); e.name = 'TimeoutError'; bad(e); } }, ms);
      p.then(function (v) { if (done) { stopStream(v); return; } done = true; clearTimeout(tm); ok(v); },
        function (e) { if (done) return; done = true; clearTimeout(tm); bad(e); });
    });
  }
  function stopStream(s) { try { (s && s.getTracks ? s.getTracks() : []).forEach(function (t) { t.stop(); }); } catch (e) { } }
  function camPerm() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve('');
      return navigator.permissions.query({ name: 'camera' }).then(function (p) { return p && p.state || ''; }, function () { return ''; });
    } catch (e) { return Promise.resolve(''); }
  }
  var CONSTRAINTS = { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false };
  function errStatus(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' || n === 'TimeoutError') return 'denied';
    if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError' || n === 'NotReadableError' || n === 'TrackStartError') return 'none';
    return 'error';
  }
  function frameReady(v, ms) {
    return new Promise(function (ok) {
      var t0 = Date.now();
      (function wait() {
        if (v.videoWidth > 0 && v.readyState >= 2) { setTimeout(ok, 350); return; } // a moment for the exposure to settle
        if (Date.now() - t0 > ms) { ok(); return; }
        setTimeout(wait, 50);
      })();
    });
  }
  /** One front-camera frame → { status, photo? }. Never throws; never takes longer than about 7 s. */
  function snap(opts) {
    opts = opts || {};
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return Promise.resolve({ status: 'none' });
    var stream = null, v = null;
    // no permissions.query() short-cut here: some browsers report it wrongly, and a refused camera fails fast anyway
    return Promise.resolve().then(function () {
      return withTimeout(md.getUserMedia(CONSTRAINTS), opts.timeout || 4000).then(function (s) {
        stream = s;
        v = document.createElement('video');
        v.muted = true; v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
        v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
        v.srcObject = s;
        document.body.appendChild(v);
        var pl; try { pl = v.play(); } catch (e) { pl = null; }
        return (pl && pl.then ? withTimeout(pl, 2500).catch(function () { }) : Promise.resolve()).then(function () { return frameReady(v, 2500); });
      }).then(function (r) {
        if (r && r.status) return r;
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) return { status: 'error' };
        var sc = Math.min(1, 640 / Math.max(w, h)), c = document.createElement('canvas');
        c.width = Math.round(w * sc); c.height = Math.round(h * sc);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        var url = c.toDataURL('image/jpeg', 0.6);
        if (url.length > 250000) url = c.toDataURL('image/jpeg', 0.35);
        return /^data:image\/jpeg;base64,/.test(url) ? { status: 'ok', photo: url } : { status: 'error' };
      }, function (e) { return { status: errStatus(e) }; });
    }).catch(function () { return { status: 'error' }; }).then(function (r) {
      stopStream(stream); try { if (v) { v.srcObject = null; v.remove(); } } catch (e) { }
      return r;
    });
  }
  var PRIMED = 'kpos.cam_primed';
  /** Ask for the camera once at a staff login on this device (so the shot is silent later). Never throws, never blocks. */
  function prime() {
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return Promise.resolve('none');
    return camPerm().then(function (perm) {
      if (perm === 'granted' || perm === 'denied') return perm;
      var asked = false; try { asked = !perm && localStorage.getItem(PRIMED) === '1'; } catch (e) { }
      if (asked) return 'asked';
      return withTimeout(md.getUserMedia(CONSTRAINTS), 60000).then(function (s) { stopStream(s); return 'granted'; }, function (e) { return errStatus(e) === 'none' ? 'none' : 'denied'; })
        .then(function (st) { try { localStorage.setItem(PRIMED, '1'); } catch (e) { } return st; });
    }).catch(function () { return 'error'; });
  }
  function shotId() {
    var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = 'TS';
    for (var i = 0; i < 12; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }
  function veil(msg) {
    var d = document.getElementById('kg-veil');
    if (!d) {
      d = document.createElement('div'); d.id = 'kg-veil'; d.setAttribute('role', 'alert');
      d.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(17,24,39,.94);color:#fff;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:700 18px/1.5 system-ui,sans-serif';
      document.body.appendChild(d);
    }
    d.textContent = '🔒 ' + (msg || '');
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) { }
  }
  function unveil() { var d = document.getElementById('kg-veil'); if (d) d.remove(); }

  /* ---- demo backends (mock.js of each app): the same rules as backend/process.js report_tamper / list_tamper_shots ---- */
  var PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+={0,2}$/;
  var STATUSES = ['ok', 'denied', 'none', 'error', 'pending'];
  var NO_PHOTO = { pending: 'foto menyusul', denied: 'tanpa foto (kamera ditolak)', none: 'tanpa foto (tidak ada kamera)', error: 'tanpa foto (kamera gagal)' };
  /** Takes the picture out of a report_tamper body before the code scan / cleaning (a picture is not text). */
  function mockTakePhoto(body) {
    if (!body || body.action !== 'report_tamper' || !body.data || typeof body.data.photo !== 'string') return { body: body, photo: '' };
    var p = body.data.photo, d = Object.assign({}, body.data); delete d.photo;
    return { body: Object.assign({}, body, { data: d }), photo: p.length <= 400000 && PHOTO_RE.test(p) ? p : '' };
  }
  function shotSummary(kind, sample, where, st) {
    return (kind === 'digits' ? 'Angka berurutan "' + sample + '"' : 'Percobaan menulis kode') + ' — akun dikunci (' + where + ')' + (st === 'ok' ? ' · foto tersimpan' : ' · ' + NO_PHOTO[st]);
  }
  /** h = { owner: bool, lock(): void, logAct(kind, summary, level): void, now: ISO, date: YYYY-MM-DD }. */
  function mockReport(db, u, data, photo, h) {
    data = data || {};
    db.tamper_shots = db.tamper_shots || [];
    var where = String(data.where || '').slice(0, 80);
    var kind = data.kind === 'digits' ? 'digits' : 'code';
    var sample = kind === 'digits' ? String(data.sample || '').replace(/[^0-9]/g, '').slice(0, 24) : '';
    var sid = /^TS[A-Z0-9]{8,20}$/.test(String(data.shot_id || '')) ? String(data.shot_id) : '';
    var st = STATUSES.indexOf(String(data.photo_status || '')) >= 0 ? String(data.photo_status) : 'none';
    if (photo) st = 'ok'; else if (st === 'ok') st = 'error';
    if (h.owner) { h.logAct('tamper', 'Pemilik: percobaan kode terdeteksi (' + where + ')', 'warn'); return { locked: false }; }
    var prev = sid ? db.tamper_shots.find(function (r) { return r.shot_id === sid; }) : null;
    if (prev) {
      if (String(prev.user).toLowerCase() !== String(u.name).toLowerCase()) { var er = new Error('Bukan milik Anda'); er.code = 'FORBIDDEN'; throw er; }
      if (prev.photo_status === 'pending') {
        prev.photo = photo; prev.photo_status = st;
        h.logAct('tamper', st === 'ok' ? 'Foto percobaan kode tersimpan (' + prev.place + ')' : 'Percobaan kode: ' + NO_PHOTO[st] + ' (' + prev.place + ')', 'warn');
      }
      return { locked: true, shot_id: sid, photo_status: prev.photo_status }; // the second call never locks again (the owner may have unlocked meanwhile)
    }
    h.lock();
    var row = { shot_id: sid || shotId(), at: h.now, shot_date: h.date, user: u.name, role: u.role, place: where, kind: kind, sample: sample, photo: photo, photo_status: st, device: String((data.device && data.device.id) || '').slice(0, 60) };
    db.tamper_shots.push(row);
    if (db.tamper_shots.length > 30) db.tamper_shots = db.tamper_shots.slice(-30); // localStorage is small in the demo
    h.logAct('tamper', shotSummary(kind, sample, where, st), 'danger');
    return { locked: true, shot_id: row.shot_id, photo_status: st };
  }
  function mockList(db, data) {
    var nm = String((data && data.name) || '').trim().toLowerCase();
    return (db.tamper_shots || []).filter(function (r) { return !nm || String(r.user).toLowerCase() === nm; })
      .slice().sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, 30)
      .map(function (r) { return Object.assign({}, r); });
  }

  root.KGuard = {
    digitRun: digitRun, isPatternRun: isPatternRun, freeText: freeText, track: track, scannerBurst: scannerBurst, digitAttempt: digitAttempt,
    snap: snap, prime: prime, shotId: shotId, veil: veil, unveil: unveil,
    mock: { takePhoto: mockTakePhoto, report: mockReport, list: mockList, summary: shotSummary }
  };
})(typeof window !== 'undefined' ? window : this);
