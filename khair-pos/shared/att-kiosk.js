/* Khair Mart — attendance screens shared by the owner app and Khair Kasir (v17).
   KAttKiosk.open(opts)   full-screen check-in/out on the shop device: tap your name → look at the camera → "Masuk 08:05".
   KAttKiosk.enroll(opts) register a worker's face (owner / manager) after the worker agrees (UU PDP consent text).
   opts: { api(action, data) → Promise, lang: 'id'|'ar', deviceId: string, onClose() }
   Faces are read on this device (shared/face.js); the server gets the 128 numbers and decides. Records cannot be edited later. */
(function (root) {
  var L = {
    id: { title: 'Absensi pekerja', pick: 'Ketuk nama Anda', look: 'Lihat ke kamera…', reading: 'Membaca wajah…', no_face: 'Wajah belum terlihat jelas. Dekatkan wajah, cahaya cukup.',
      many: 'Hanya satu orang di depan kamera', small: 'Dekatkan wajah ke kamera', loading: 'Menyiapkan kamera (pertama kali agak lama)…', in: 'MASUK', out: 'PULANG', late: 'Terlambat {n} menit',
      not_yet: 'Belum absen', in_at: 'Masuk {t}', out_at: 'Pulang {t}', not_enrolled: 'Wajah belum didaftarkan', close: 'Tutup', back: 'Kembali', again: 'Coba lagi',
      cam_err: 'Kamera tidak bisa dibuka. Izinkan kamera untuk halaman ini.',
      cam_denied: 'Izin kamera ditolak di HP ini, jadi absen dengan wajah belum bisa.',
      cam_how: 'Cara mengizinkan: buka Chrome → ⋮ → Setelan → Setelan situs → Kamera → {host} → Izinkan. Lalu kembali ke sini dan tekan Coba lagi.',
      cam_app: 'Buka izin kamera', cam_app_how: 'Tekan «Buka izin kamera» → Kamera → Izinkan. Lalu kembali ke sini dan tekan Coba lagi.',
      cam_os: 'Jika Chrome sendiri tidak boleh memakai kamera: Setelan HP → Aplikasi → Chrome → Izin → Kamera → Izinkan.',
      cam_busy: 'Kamera sedang dipakai aplikasi lain (kamera HP, WhatsApp, panggilan video). Tutup aplikasi itu, lalu tekan Coba lagi.',
      cam_none: 'Kamera tidak ditemukan di perangkat ini. Pakai HP atau tablet yang punya kamera depan.',
      cam_unsupported: 'Browser ini tidak bisa memakai kamera. Buka aplikasi lewat Chrome versi terbaru.', model_err: 'Data pengenal wajah gagal dimuat. Periksa internet lalu coba lagi.',
      offline: 'Tidak ada internet. Absen perlu internet.', none: 'Belum ada pekerja. Pemilik / manajer menambahkannya di menu Absensi.', note: 'Catatan absen tidak bisa diubah atau dihapus.',
      enroll_title: 'Daftarkan wajah: {name}', consent: 'Saya, {name}, setuju wajah saya dipakai hanya untuk absensi di Khair Mart. Data wajah disimpan sebagai angka, bukan foto, dan bisa dihapus jika saya berhenti bekerja (permintaan ke pemilik).',
      consent_need: 'Centang persetujuan pekerja dulu', start: 'Mulai', enroll_step: 'Foto {i} dari {n}…', enroll_ok: 'Wajah {name} terdaftar', save_err: 'Gagal menyimpan' },
    ar: { title: 'حضور العمال', pick: 'اضغط على اسمك', look: 'انظر إلى الكاميرا…', reading: 'جارٍ قراءة الوجه…', no_face: 'الوجه غير واضح بعد. قرّب وجهك مع إضاءة كافية.',
      many: 'شخص واحد فقط أمام الكاميرا', small: 'قرّب وجهك من الكاميرا', loading: 'تجهيز الكاميرا (أول مرة يأخذ وقتًا)…', in: 'دخول', out: 'خروج', late: 'تأخر {n} دقيقة',
      not_yet: 'لم يسجّل بعد', in_at: 'دخل {t}', out_at: 'خرج {t}', not_enrolled: 'الوجه غير مسجّل', close: 'إغلاق', back: 'رجوع', again: 'حاول مجددًا',
      cam_err: 'تعذّر فتح الكاميرا. اسمح باستخدام الكاميرا لهذه الصفحة.',
      cam_denied: 'تم رفض إذن الكاميرا على هذا الهاتف، لذلك لا يمكن تسجيل الحضور بالوجه بعد.',
      cam_how: 'للسماح بها: افتح Chrome ← ⋮ ← الإعدادات ← إعدادات المواقع ← الكاميرا ← {host} ← سماح. ثم ارجع هنا واضغط «حاول مجددًا».',
      cam_app: 'فتح إذن الكاميرا', cam_app_how: 'اضغط «فتح إذن الكاميرا» ← الكاميرا ← سماح. ثم ارجع هنا واضغط «حاول مجددًا».',
      cam_os: 'إذا كان Chrome نفسه ممنوعًا من الكاميرا: إعدادات الهاتف ← التطبيقات ← Chrome ← الأذونات ← الكاميرا ← سماح.',
      cam_busy: 'الكاميرا مستخدمة في تطبيق آخر (كاميرا الهاتف، واتساب، مكالمة فيديو). أغلق ذلك التطبيق ثم اضغط «حاول مجددًا».',
      cam_none: 'لا توجد كاميرا في هذا الجهاز. استعمل هاتفًا أو جهازًا لوحيًا فيه كاميرا أمامية.',
      cam_unsupported: 'هذا المتصفح لا يستطيع استعمال الكاميرا. افتح التطبيق من آخر إصدار من Chrome.', model_err: 'تعذّر تحميل بيانات التعرّف على الوجه. تحقق من الإنترنت ثم أعد المحاولة.',
      offline: 'لا يوجد إنترنت. تسجيل الحضور يحتاج إنترنت.', none: 'لا يوجد عمال بعد. يضيفهم المالك أو المدير من قائمة الحضور.', note: 'سجلات الحضور لا يمكن تعديلها أو حذفها.',
      enroll_title: 'تسجيل وجه: {name}', consent: 'أنا {name} أوافق على استخدام وجهي فقط لتسجيل الحضور في خير مارت. تُحفظ بيانات الوجه كأرقام لا كصورة، ويمكن حذفها عند ترك العمل (بطلب إلى المالك).',
      consent_need: 'ضع علامة موافقة العامل أولًا', start: 'ابدأ', enroll_step: 'صورة {i} من {n}…', enroll_ok: 'تم تسجيل وجه {name}', save_err: 'تعذّر الحفظ' }
  };
  var CSS = '.kak{position:fixed;inset:0;z-index:9000;background:#0f172a;color:#fff;display:flex;flex-direction:column;font:16px/1.4 system-ui,Arial,sans-serif}' +
    '.kak[dir=rtl]{direction:rtl}.kak-h{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#111827}.kak-h b{font-size:20px;flex:1}.kak-clock{font-size:22px;font-variant-numeric:tabular-nums}' +
    '.kak-btn{min-height:48px;padding:0 18px;border-radius:12px;border:0;background:#334155;color:#fff;font-size:17px;font-weight:700;cursor:pointer}.kak-btn.p{background:#16a34a}' +
    '.kak-body{flex:1;overflow:auto;padding:16px}.kak-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}' +
    '.kak-w{min-height:96px;border-radius:16px;border:2px solid #334155;background:#1e293b;color:#fff;font-size:19px;font-weight:800;padding:10px;text-align:center;cursor:pointer}' +
    '.kak-w small{display:block;font-size:13px;font-weight:600;margin-top:6px;color:#cbd5e1}.kak-w.in{border-color:#16a34a}.kak-w.in small{color:#86efac}.kak-w[disabled]{opacity:.45;cursor:not-allowed}' +
    '.kak-cam{display:flex;flex-direction:column;align-items:center;gap:14px}.kak-cam video{width:min(92vw,520px);aspect-ratio:4/3;border-radius:18px;background:#000;object-fit:cover;transform:scaleX(-1)}' +
    '.kak-msg{font-size:20px;font-weight:700;text-align:center;min-height:28px}.kak-res{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:60vh;text-align:center}' +
    '.kak-res .big{font-size:44px;font-weight:900}.kak-res.ok .big{color:#4ade80}.kak-res.bad .big{color:#f87171}.kak-res .who{font-size:28px;font-weight:800}.kak-note{font-size:12px;color:#94a3b8;text-align:center;padding:8px}' +
    '.kak-help{max-width:560px;background:#1e293b;border-radius:14px;padding:12px 14px;font-size:15px;text-align:start}.kak-help p{margin:6px 0}.kak-help p.b{font-size:17px;font-weight:800}' +
    '.kak-help .kak-btn{width:100%;margin-top:8px}.kak-row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}' +
    '.kak-consent{max-width:560px;background:#1e293b;border-radius:14px;padding:14px;font-size:15px}.kak-consent label{display:flex;gap:10px;align-items:flex-start;cursor:pointer}.kak-consent input{width:24px;height:24px;flex:none}';
  function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tt(lang, k, v) { var s = (L[lang] || L.id)[k] || L.id[k] || k; Object.keys(v || {}).forEach(function (x) { s = s.replace('{' + x + '}', v[x]); }); return s; }
  function hhmm(iso) { if (!iso) return ''; var d = new Date(new Date(iso).getTime() + 7 * 3600000); return d.toISOString().slice(11, 16); }
  function uid() { return 'A' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function shell(lang, title) {
    if (!document.getElementById('kak-css')) { var st = document.createElement('style'); st.id = 'kak-css'; st.textContent = CSS; document.head.appendChild(st); }
    var el = document.createElement('div'); el.className = 'kak'; el.id = 'att-kiosk'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    if (lang === 'ar') { el.setAttribute('dir', 'rtl'); el.lang = 'ar'; }
    el.innerHTML = '<div class="kak-h"><b>' + esc(title) + '</b><span class="kak-clock" id="kak-clock"></span><button class="kak-btn" id="kak-close">' + esc(tt(lang, 'close')) + '</button></div><div class="kak-body" id="kak-body"></div><div class="kak-note">' + esc(tt(lang, 'note')) + '</div>';
    document.body.appendChild(el);
    var clock = function () { var c = el.querySelector('#kak-clock'); if (c) c.textContent = hhmm(new Date().toISOString()); };
    clock(); el._clock = setInterval(clock, 15000);
    return el;
  }
  function getLoc() {
    return new Promise(function (ok) {
      if (!navigator.geolocation) return ok(null);
      var done = false; setTimeout(function () { if (!done) { done = true; ok(null); } }, 9000);
      navigator.geolocation.getCurrentPosition(function (p) { if (!done) { done = true; ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }); } },
        function () { if (!done) { done = true; ok(null); } }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }
  /** Camera loop: reads until one clear face (or gives up after ~20 s). */
  function capture(el, lang, onRead) {
    var body = el.querySelector('#kak-body');
    body.innerHTML = '<div class="kak-cam"><video id="kak-video" autoplay muted playsinline></video><div class="kak-msg" id="kak-msg">' + esc(tt(lang, 'loading')) + '</div><button class="kak-btn" id="kak-back">' + esc(tt(lang, 'back')) + '</button></div>';
    var video = body.querySelector('#kak-video'), msg = body.querySelector('#kak-msg'), stream = null, stopped = false;
    function stop() { stopped = true; if (stream) root.KFace.stopCamera(stream); stream = null; }
    el._stop = stop;
    return new Promise(function (resolve) {
      body.querySelector('#kak-back').onclick = function () { stop(); resolve(null); };
      root.KFace.load().catch(function () { throw new Error('MODEL'); }).then(function () {
        if (root.KFACE_STUB) return null;
        return root.KFace.startCamera(video).catch(function (e) { var x = new Error('CAMERA'); x.reason = root.KFace.camReason ? root.KFace.camReason(e) : 'other'; throw x; });
      }).then(function (st) {
        stream = st; if (stopped) { stop(); return; }
        msg.textContent = tt(lang, 'look');
        var tries = 0;
        (function loop() {
          if (stopped) return;
          onRead(video).then(function (r) {
            if (stopped) return;
            if (r && r.descriptor) { stop(); resolve(r); return; }
            msg.textContent = tt(lang, r && r.many ? 'many' : r && r.small ? 'small' : 'no_face');
            if (++tries > 40) { stop(); resolve({ error: 'NO_FACE' }); return; }
            setTimeout(loop, root.KFACE_STUB ? 0 : 450);
          }, function () { stop(); resolve({ error: 'MODEL' }); });
        })();
      }).catch(function (e) { stop(); resolve(e && e.message === 'CAMERA' ? { error: 'CAMERA', reason: e.reason || 'other' } : { error: 'MODEL' }); });
    });
  }
  /** v59 (owner 2026-10-17: «لا يمكن استعمال الكميرا في تسجيل الحضور»): the camera did not open — why, and how to allow it. A camera
   *  refused once stays refused, so the steps lead to the browser's site settings; inside the Khair Android app one button opens them
   *  (khairprint:site-settings, android/native/KhairPrintActivity.java). */
  function camHelp(lang, reason) {
    var link = reason === 'denied' && root.KPrint && root.KPrint.appLink ? root.KPrint.appLink('site-settings') : '';
    // (an app installed before v59 opens nothing from the button: the Chrome way is always written too)
    var lines = reason === 'denied' ? [tt(lang, 'cam_denied')].concat(link ? [tt(lang, 'cam_app_how')] : [], [tt(lang, 'cam_how', { host: location.host }), tt(lang, 'cam_os')])
      : [tt(lang, reason === 'busy' ? 'cam_busy' : reason === 'none' ? 'cam_none' : reason === 'unsupported' ? 'cam_unsupported' : 'cam_err')];
    return '<div class="kak-help" id="kak-cam-help" data-reason="' + esc(reason || 'other') + '">' + lines.map(function (l, i) { return '<p' + (i ? '' : ' class="b"') + '>' + esc(l) + '</p>'; }).join('') +
      (link ? '<button class="kak-btn p" id="kak-perm" data-link="' + esc(link) + '">' + esc(tt(lang, 'cam_app')) + '</button>' : '') + '</div>';
  }
  function bindHelp(body) {
    var b = body.querySelector('#kak-perm');
    if (b) b.onclick = function () { (root.KPrint.go || function (u) { location.href = u; })(b.dataset.link); };
  }
  function errText(lang, e) {
    if (!e) return tt(lang, 'save_err');
    if (e.code === 'NETWORK' || e.name === 'NetError') return tt(lang, 'offline');
    return e.message || tt(lang, 'save_err');
  }

  function open(opts) {
    var lang = opts.lang === 'ar' ? 'ar' : 'id', el = shell(lang, tt(lang, 'title')), body = el.querySelector('#kak-body'), data = null, timer = null, closed = false;
    function close() { closed = true; clearInterval(el._clock); clearTimeout(timer); if (el._stop) el._stop(); el.remove(); if (opts.onClose) opts.onClose(); }
    el.querySelector('#kak-close').onclick = close;
    function grid() {
      if (closed) return;
      body.innerHTML = '<div class="kak-msg" style="margin-bottom:12px">' + esc(tt(lang, 'pick')) + '</div><div class="kak-grid" id="kak-grid"></div>';
      var g = body.querySelector('#kak-grid'), list = (data && data.workers || []).filter(function (w) { return w.active !== false; });
      if (!list.length) { g.outerHTML = '<div class="kak-msg">' + esc(tt(lang, 'none')) + '</div>'; return; }
      g.innerHTML = list.map(function (w) {
        var st = w.today && w.today.state, sub = !w.enrolled ? tt(lang, 'not_enrolled') : st === 'in' ? tt(lang, 'in_at', { t: hhmm(w.today.at) }) : st === 'out' ? tt(lang, 'out_at', { t: hhmm(w.today.at) }) : tt(lang, 'not_yet');
        return '<button class="kak-w ' + (st === 'in' ? 'in' : '') + '" data-w="' + esc(w.worker_id) + '" ' + (w.enrolled ? '' : 'disabled') + '>' + esc(w.name) + '<small>' + esc(sub) + '</small></button>';
      }).join('');
      Array.prototype.forEach.call(g.querySelectorAll('[data-w]'), function (b) { b.onclick = function () { mark(list.find(function (w) { return w.worker_id === b.dataset.w; })); }; });
    }
    function result(ok, big, who, sub) {
      body.innerHTML = '<div class="kak-res ' + (ok ? 'ok' : 'bad') + '" id="kak-result" data-ok="' + (ok ? '1' : '0') + '"><div class="big">' + esc(big) + '</div><div class="who">' + esc(who || '') + '</div><div class="kak-msg">' + esc(sub || '') + '</div>' +
        (ok ? '' : '<button class="kak-btn" id="kak-again">' + esc(tt(lang, 'again')) + '</button>') + '</div>';
      var again = body.querySelector('#kak-again'); if (again) again.onclick = function () { clearTimeout(timer); load(); };
      timer = setTimeout(load, ok ? 3500 : 6000);
    }
    function camFail(w, reason) {
      body.innerHTML = '<div class="kak-res bad" id="kak-result" data-ok="0" data-err="camera"><div class="big">✗</div><div class="who">' + esc(w.name) + '</div>' + camHelp(lang, reason) +
        '<div class="kak-row"><button class="kak-btn" id="kak-again">' + esc(tt(lang, 'again')) + '</button><button class="kak-btn" id="kak-names">' + esc(tt(lang, 'back')) + '</button></div></div>';
      bindHelp(body);
      body.querySelector('#kak-again').onclick = function () { clearTimeout(timer); mark(w); };
      body.querySelector('#kak-names').onclick = function () { clearTimeout(timer); load(); };
      timer = setTimeout(load, 90000); // back to the names by itself, after time to follow the steps
    }
    function mark(w) {
      if (!w) return;
      var locP = getLoc();
      capture(el, lang, root.KFace.read).then(function (r) {
        if (closed) return;
        if (!r) { grid(); return; }
        if (r.error === 'CAMERA') { camFail(w, r.reason); return; }
        if (r.error) { result(false, '✗', w.name, tt(lang, r.error === 'MODEL' ? 'model_err' : 'no_face')); return; }
        body.innerHTML = '<div class="kak-res"><div class="kak-msg">' + esc(tt(lang, 'reading')) + '</div></div>';
        return locP.then(function (loc) {
          return opts.api('att_mark', { worker_id: w.worker_id, descriptor: r.descriptor, loc: loc, device: { id: opts.deviceId || '' }, client_id: uid() });
        }).then(function (res) {
          var rec = res.record || {};
          result(true, (rec.kind === 'out' ? tt(lang, 'out') : tt(lang, 'in')) + ' ' + hhmm(rec.at), rec.worker_name || w.name, rec.late_min ? tt(lang, 'late', { n: rec.late_min }) : (res.message || ''));
        }, function (e) { result(false, '✗', w.name, errText(lang, e)); });
      });
    }
    function load() {
      if (closed) return;
      body.innerHTML = '<div class="kak-res"><div class="kak-msg">…</div></div>';
      opts.api('att_bootstrap', {}).then(function (r) { data = r; grid(); }, function (e) { body.innerHTML = '<div class="kak-res bad"><div class="kak-msg">' + esc(errText(lang, e)) + '</div><button class="kak-btn" id="kak-again">' + esc(tt(lang, 'again')) + '</button></div>'; body.querySelector('#kak-again').onclick = load; });
    }
    load();
    return { close: close };
  }

  function enroll(opts) {
    var lang = opts.lang === 'ar' ? 'ar' : 'id', w = opts.worker, el = shell(lang, tt(lang, 'enroll_title', { name: w.name })), body = el.querySelector('#kak-body'), closed = false;
    function close(done) { closed = true; clearInterval(el._clock); if (el._stop) el._stop(); el.remove(); if (opts.onClose) opts.onClose(done === true); }
    el.querySelector('#kak-close').onclick = close;
    function consent() {
      body.innerHTML = '<div class="kak-cam"><div class="kak-consent"><label><input type="checkbox" id="kak-consent"> <span>' + esc(tt(lang, 'consent', { name: w.name })) + '</span></label></div>' +
        '<div class="kak-msg" id="kak-msg"></div><button class="kak-btn p" id="kak-start">' + esc(tt(lang, 'start')) + '</button></div>';
      body.querySelector('#kak-start').onclick = function () {
        if (!body.querySelector('#kak-consent').checked) { body.querySelector('#kak-msg').textContent = tt(lang, 'consent_need'); return; }
        var n = 5;
        capture(el, lang, function (video) {
          return root.KFace.readAverage(video, n, function (i) { var m = el.querySelector('#kak-msg'); if (m) m.textContent = tt(lang, 'enroll_step', { i: Math.min(i + 1, n), n: n }); });
        }).then(function (r) {
          if (closed) return;
          if (!r) { consent(); return; }
          if (r.error === 'CAMERA') { show(false, '', camHelp(lang, r.reason)); return; }
          if (r.error) { show(false, tt(lang, r.error === 'MODEL' ? 'model_err' : 'no_face')); return; }
          body.innerHTML = '<div class="kak-res"><div class="kak-msg">' + esc(tt(lang, 'reading')) + '</div></div>';
          opts.api('worker_enroll', { worker_id: w.worker_id, descriptor: r.descriptor, thumb: r.thumb, consent: true })
            .then(function () { show(true, tt(lang, 'enroll_ok', { name: w.name })); }, function (e) { show(false, errText(lang, e)); });
        });
      };
    }
    function show(ok, text, help) {
      body.innerHTML = '<div class="kak-res ' + (ok ? 'ok' : 'bad') + '" id="kak-result" data-ok="' + (ok ? '1' : '0') + '"><div class="big">' + (ok ? '✓' : '✗') + '</div>' + (help || '<div class="kak-msg">' + esc(text) + '</div>') +
        '<button class="kak-btn ' + (ok ? 'p' : '') + '" id="kak-done">' + esc(ok ? tt(lang, 'close') : tt(lang, 'again')) + '</button></div>';
      body.querySelector('#kak-done').onclick = ok ? function () { close(true); } : consent;
      bindHelp(body);
    }
    consent();
    return { close: close };
  }
  root.KAttKiosk = { open: open, enroll: enroll, L: L };
})(window);
