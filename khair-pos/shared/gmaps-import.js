/* Khair Mart — places copied or shared from Google Maps → a list of shops (name, address, phone, link, position).
   v33 (owner 2026-10-11): "take the shops of a street from Google Maps for free and send them to the rep". No Google key:
   the text Google Maps gives when you SHARE a place (name, address, a maps.app.goo.gl link) or COPY a place / its link is
   read here. A full link carries the position (!3d…!4d… or @lat,lng); a short link is followed by our server
   (resolve_links); otherwise the address is looked up on OpenStreetMap, or the rep puts the point on the map himself.
   Used by the owner app, the cashier app and the field app (one copy of the rules). */
(function (root) {
  'use strict';
  var URL_RE = /https?:\/\/[^\s<>"']+/i;
  var GMAPS_HOST = /^(?:maps\.app\.goo\.gl|goo\.gl|(?:www\.)?google\.[a-z.]+|maps\.google\.[a-z.]+)$/i;
  // lines Google adds around a place that are not its name / address (rating, hours, buttons, "·" rows)
  var NOISE = /^(?:\d[.,]\d\s*\(|\(\d+\)$|buka|tutup|open|closed|opens|closes|rute|directions|situs web|website|telepon|call|simpan|save|bagikan|share|kirim ke|send to|ulasan|reviews?|foto|photos?|menu|pesan|order|⋅|·|⭐|★)/i;
  var ADDR = /\b(?:jl\.?|jln\.?|jalan|gg\.?|gang|no\.?\s*\d|rt\.?\s*\d|rw\.?\s*\d|kec\.|kel\.|kota|kab\.|jakarta|bekasi|depok|tangerang|bogor|indonesia|\d{5})\b/i;
  var PHONE = /(?:\+62|\b0)[\d\s().-]{8,16}\d/;

  function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ''; } }
  function isGmaps(u) {
    var h = hostOf(u); if (!GMAPS_HOST.test(h)) return false;
    if (/^goo\.gl$/i.test(h)) return /^https?:\/\/goo\.gl\/maps\//i.test(u);
    if (/google\./i.test(h) && !/^maps\./i.test(h)) return /\/maps/i.test(u) || /[?&](q|ll|cid)=/i.test(u);
    return true;
  }
  var isShort = function (u) { return /^(?:maps\.app\.goo\.gl|goo\.gl)$/i.test(hostOf(u)); };
  function okCoord(lat, lng) { return isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0); }
  /** The position written in a Google Maps link: the place pin (!3d…!4d…) first, else ?q=/ll=lat,lng, else the view (@lat,lng). */
  function coordsFromUrl(u) {
    var s = String(u || ''), m;
    try { s = decodeURIComponent(s); } catch (e) { /* keep as is */ }
    if ((m = s.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/))) return pick(m, true);
    if ((m = s.match(/[?&](?:q|ll|query|destination|center)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/))) return pick(m, true);
    if ((m = s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/))) return pick(m, false);
    return null;
    function pick(x, exact) { var la = Number(x[1]), ln = Number(x[2]); return okCoord(la, ln) ? { lat: la, lng: ln, exact: exact } : null; }
  }
  /** The place name written in a link (/maps/place/Toko+Kurma+Barokah/…, or ?q=Name,+Address). */
  function nameFromUrl(u) {
    var s = String(u || ''), m = s.match(/\/maps\/place\/([^/@?]+)/);
    var v = m ? m[1] : ((s.match(/[?&]q=([^&]+)/) || [])[1] || '');
    try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { v = v.replace(/\+/g, ' '); }
    v = v.trim();
    return /^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(v) ? '' : v;
  }
  function clean(s, n) { return String(s || '').replace(/[\u0000-\u001F\u007F‪-‮⁦-⁩]/g, ' ').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n || 200); }
  function block(lines, url) {
    var txt = lines.map(function (l) { return clean(l, 300); }).filter(function (l) { return l && !NOISE.test(l); });
    var pos = url ? coordsFromUrl(url) : null, phone = '', addr = '', name = '';
    var ll = null;
    txt = txt.filter(function (l) {
      var m = l.match(/^(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})$/); // a "lat, lng" line
      if (m && okCoord(Number(m[1]), Number(m[2]))) { ll = { lat: Number(m[1]), lng: Number(m[2]), exact: true }; return false; }
      var p = l.match(PHONE);
      if (p && l.replace(p[0], '').replace(/[^A-Za-z]/g, '').length < 4) { phone = phone || p[0].replace(/[^\d+]/g, ''); return false; }
      return true;
    });
    name = txt[0] || (url ? nameFromUrl(url) : '');
    // a first line "Name, Jl. …" holds both
    if (txt.length === 1 && name.indexOf(',') > 0 && ADDR.test(name.slice(name.indexOf(',') + 1))) { addr = name.slice(name.indexOf(',') + 1).trim(); name = name.slice(0, name.indexOf(',')).trim(); }
    else addr = txt.slice(1).find(function (l) { return ADDR.test(l); }) || txt[1] || '';
    if (addr.indexOf('·') >= 0) addr = addr.split('·').map(function (x) { return x.trim(); }).find(function (x) { return ADDR.test(x); }) || addr; // "Kategori · Jl. …"
    if (!name && !url) return null;
    pos = pos || ll;
    return { name: clean(name, 100), address: clean(addr, 200), phone: clean(phone, 30), url: url ? String(url).slice(0, 300) : '',
      lat: pos ? pos.lat : null, lng: pos ? pos.lng : null, exact: pos ? pos.exact : false };
  }
  /** Pasted / shared text → places. A link ends a place; so does an empty line. */
  function parse(text) {
    var out = [], cur = [];
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (raw) {
      var line = raw.trim(), m = line.match(URL_RE);
      if (m && isGmaps(m[0].replace(/[),.;]+$/, ''))) {
        var u = m[0].replace(/[),.;]+$/, ''), before = line.slice(0, m.index).trim();
        if (before) cur.push(before);
        var b = block(cur, u); if (b) out.push(b); cur = []; return;
      }
      if (!line) { if (cur.length) { var b2 = block(cur, ''); if (b2) out.push(b2); } cur = []; return; }
      if (m) return; // another site's link: not a place
      cur.push(line);
    });
    if (cur.length) { var b3 = block(cur, ''); if (b3) out.push(b3); }
    // the same place pasted twice → once
    var seen = {};
    return out.filter(function (p) {
      var k = (p.url || '') + '|' + p.name.toLowerCase() + '|' + (p.lat != null ? p.lat.toFixed(5) + ',' + p.lng.toFixed(5) : '');
      if (seen[k] || (!p.name && !p.url)) return false; seen[k] = 1; return true;
    }).slice(0, 60);
  }
  /** A Web Share Target hit (title / text / url as the phone passed them) → one text to parse. */
  function fromShare(title, text, url) {
    var t = String(text || ''), u = String(url || '');
    var s = (title && t.indexOf(title) < 0 ? title + '\n' : '') + t + (u && t.indexOf(u) < 0 ? '\n' + u : '');
    return parse(s);
  }
  /* ---- The office page (owner app + cashier app): send a rep the shops of a street ----
     env: { api(action, data) → Promise (the field API), lang() → 'id'|'ar', today() → 'YYYY-MM-DD', addDays(d, n),
            toast(msg, kind), errMsg(e) }. Rendered into `el`; its own words (Indonesian + Arabic). */
  var STR = {
    id: { title: 'Kirim daftar toko ke sales', hint: 'Di Google Maps cari toko di jalan itu → buka tokonya → Bagikan → Salin, lalu tempel di bawah (bisa banyak toko sekaligus). Gratis, tanpa akun Google. Daftar masuk langsung ke rencana sales untuk hari itu; toko tanpa titik ditaruh sales di petanya.',
      rep: 'Sales', date: 'Tanggal kerja', street: 'Jalan', street_ph: 'mis. Jalan Raya Condet', paste: 'Tempel dari Google Maps', paste_ph: 'Nama toko, alamat, link Google Maps… (satu toko per blok)',
      read: 'Baca daftar', reading: 'Membaca…', none: 'Tidak ada toko yang terbaca. Tempel teks atau link dari Google Maps.', note: 'Catatan untuk sales', send: 'Kirim ke {rep} ({n} toko)',
      pos_ok: 'titik ✓', pos_no: 'belum ada titik — sales menaruhnya', pos_approx: 'titik kira-kira', remove: 'Hapus', need_rep: 'Pilih sales', sent_ok: 'Terkirim ke {rep}: {n} toko untuk {s}',
      sent: 'Terkirim (30 hari)', sent_none: 'Belum ada daftar yang dikirim.', st_sent: 'Belum diterima', st_received: 'Diterima', no_reps: 'Belum ada akun sales.', count: '{n} toko' },
    ar: { title: 'أرسل قائمة محلات إلى المندوب', hint: 'في خرائط جوجل ابحث عن المحلات في ذلك الشارع ← افتح المحل ← مشاركة ← نسخ، ثم الصقه في الأسفل (يمكن عدة محلات مرة واحدة). مجاني بلا حساب جوجل. تدخل القائمة مباشرة في خطة المندوب لذلك اليوم؛ والمحل بلا نقطة يضعه المندوب على خريطته.',
      rep: 'المندوب', date: 'يوم العمل', street: 'الشارع', street_ph: 'مثلًا Jalan Raya Condet', paste: 'الصق من خرائط جوجل', paste_ph: 'اسم المحل، العنوان، رابط خرائط جوجل… (كل محل في فقرة)',
      read: 'اقرأ القائمة', reading: 'جارٍ القراءة…', none: 'لم يُقرأ أي محل. الصق نصًا أو رابطًا من خرائط جوجل.', note: 'ملاحظة للمندوب', send: 'أرسل إلى {rep} ({n} محل)',
      pos_ok: 'النقطة ✓', pos_no: 'بلا نقطة — يضعها المندوب', pos_approx: 'نقطة تقريبية', remove: 'حذف', need_rep: 'اختر المندوب', sent_ok: 'أُرسلت إلى {rep}: {n} محل لـ {s}',
      sent: 'المرسَلة (30 يومًا)', sent_none: 'لم تُرسل أي قائمة بعد.', st_sent: 'لم تُستلم بعد', st_received: 'استُلمت', no_reps: 'لا توجد حسابات مندوبين.', count: '{n} محل' }
  };
  function H(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function officeUI(el, env) {
    var L = function () { return env.lang && env.lang() === 'ar' ? 'ar' : 'id'; };
    var tx = function (k, v) { var x = STR[L()][k] || STR.id[k] || k; Object.keys(v || {}).forEach(function (n) { x = x.split('{' + n + '}').join(v[n]); }); return x; };
    var st = { reps: [], places: [], sent: [], busy: false, msg: '' }, T = env.today(), T1 = env.addDays(T, 1), MAX = env.addDays(T, 14);
    el.innerHTML = '<div class="card pad gl-card" id="gl"><h3 style="margin-top:0">📋 ' + H(tx('title')) + '</h3><p class="small muted" style="margin-top:0">' + H(tx('hint')) + '</p>'
      + '<div class="grid2"><div class="field"><label class="f" for="gl-rep">' + H(tx('rep')) + '</label><select class="input" id="gl-rep"></select></div>'
      + '<div class="field"><label class="f" for="gl-date">' + H(tx('date')) + '</label><input class="input" type="date" id="gl-date" min="' + T + '" max="' + MAX + '" value="' + T1 + '"></div></div>'
      + '<div class="field"><label class="f" for="gl-street">' + H(tx('street')) + '</label><input class="input" id="gl-street" maxlength="100" placeholder="' + H(tx('street_ph')) + '"></div>'
      + '<div class="field"><label class="f" for="gl-text">' + H(tx('paste')) + '</label><textarea class="input" id="gl-text" rows="7" placeholder="' + H(tx('paste_ph')) + '"></textarea></div>'
      + '<button class="btn" type="button" id="gl-read">' + H(tx('read')) + '</button><div class="small muted" id="gl-msg" role="status" style="margin-top:6px"></div>'
      + '<div class="list" id="gl-places" style="margin-top:8px"></div>'
      + '<div class="field" style="margin-top:8px"><label class="f" for="gl-note">' + H(tx('note')) + '</label><input class="input" id="gl-note" maxlength="300"></div>'
      + '<button class="btn primary block" type="button" id="gl-send" disabled></button>'
      + '<h3 style="margin:18px 0 8px">' + H(tx('sent')) + '</h3><div class="list" id="gl-sent"><div class="muted small">…</div></div></div>';
    var $ = function (id) { return el.querySelector('#' + id); };
    function drawPlaces() {
      $('gl-places').innerHTML = st.places.map(function (p, i) {
        var pos = p.lat != null ? (p.approx ? tx('pos_approx') : tx('pos_ok')) : tx('pos_no');
        return '<div class="li gl-place" data-i="' + i + '" data-pos="' + (p.lat != null ? 1 : 0) + '"><div class="grow"><div class="t"><b>' + H(p.name) + '</b></div><div class="s small muted">' + H([p.address, p.phone].filter(Boolean).join(' · ')) + '</div>'
          + '<div class="small ' + (p.lat != null ? 'green' : 'red') + '">' + H(pos) + '</div></div><button class="btn xs ghost" type="button" data-gl-del="' + i + '" aria-label="' + H(tx('remove')) + '">✕</button></div>';
      }).join('');
      var rep = $('gl-rep').value;
      $('gl-send').textContent = tx('send', { rep: rep || '—', n: st.places.length });
      $('gl-send').disabled = st.busy || !st.places.length || !rep;
      $('gl-msg').textContent = st.msg;
    }
    function drawSent() {
      $('gl-sent').innerHTML = st.sent.length ? st.sent.map(function (l) {
        return '<div class="li gl-sent-row" data-status="' + H(l.status) + '"><div class="grow"><div class="t"><b>' + H(l.street || '—') + '</b> → ' + H(l.to_user) + '</div><div class="s small muted">' + H([l.plan_date, tx('count', { n: l.n }), l.from_user].join(' · ')) + '</div></div>'
          + '<span class="badge ' + (l.status === 'received' ? 'green' : 'gray') + '">' + H(tx(l.status === 'received' ? 'st_received' : 'st_sent')) + '</span></div>';
      }).join('') : '<div class="muted small">' + H(tx('sent_none')) + '</div>';
    }
    function loadSent() { return env.api('lists_sent', {}).then(function (r) { st.sent = r.lists || []; drawSent(); }).catch(function (e) { $('gl-sent').innerHTML = '<div class="red small">' + H(env.errMsg(e)) + '</div>'; }); }
    env.api('list_reps', {}).then(function (r) {
      st.reps = r.reps || [];
      $('gl-rep').innerHTML = st.reps.length ? '<option value="">—</option>' + st.reps.map(function (n) { return '<option>' + H(n) + '</option>'; }).join('') : '<option value="">' + H(tx('no_reps')) + '</option>';
      if (st.reps.length === 1) $('gl-rep').value = st.reps[0];
      drawPlaces();
    }).catch(function (e) { st.msg = env.errMsg(e); drawPlaces(); });
    loadSent();
    $('gl-rep').onchange = drawPlaces;
    $('gl-places').onclick = function (e) { var b = e.target.closest('[data-gl-del]'); if (!b) return; st.places.splice(+b.getAttribute('data-gl-del'), 1); drawPlaces(); };
    $('gl-read').onclick = function () {
      var got = parse($('gl-text').value);
      if (!got.length) { st.msg = tx('none'); drawPlaces(); return; }
      st.busy = true; st.msg = tx('reading'); $('gl-read').disabled = true; drawPlaces();
      var need = got.filter(function (p) { return p.lat == null && p.url; }), parts = [];
      for (var i = 0; i < need.length; i += 8) parts.push(need.slice(i, i + 8)); // the server follows ≤ 8 links a call
      parts.reduce(function (pr, part) {
        return pr.then(function () {
          return env.api('resolve_links', { urls: part.map(function (p) { return p.url; }) }).then(function (r) {
            (r.links || []).forEach(function (l) {
              part.filter(function (p) { return p.url === l.url; }).forEach(function (p) {
                if (l.ok && okCoord(l.lat, l.lng)) { p.lat = l.lat; p.lng = l.lng; p.approx = !l.exact; }
                if (l.name) { var c = l.name.indexOf(','); if (!p.name) p.name = (c > 0 ? l.name.slice(0, c) : l.name).trim(); if (!p.address && c > 0) p.address = l.name.slice(c + 1).trim(); }
              });
            });
          }).catch(function () { /* positions stay empty: the rep places them */ });
        });
      }, Promise.resolve()).then(function () {
        var seen = {};
        st.places = st.places.concat(got).filter(function (p) { var k = (p.name || '').toLowerCase() + '|' + (p.url || p.address || ''); if (seen[k] || !p.name) return false; seen[k] = 1; return true; }).slice(0, 60);
        st.busy = false; st.msg = ''; $('gl-read').disabled = false; $('gl-text').value = ''; drawPlaces();
      });
    };
    $('gl-send').onclick = function () {
      var rep = $('gl-rep').value; if (!rep) { env.toast(tx('need_rep'), 'err'); return; }
      st.busy = true; drawPlaces();
      var street = $('gl-street').value.trim();
      env.api('list_send', { to_user: rep, plan_date: $('gl-date').value || T1, street: street, note: $('gl-note').value.trim(),
        places: st.places.map(function (p) { return { name: p.name, address: p.address, phone: p.phone, url: p.url, lat: p.lat, lng: p.lng }; }) })
        .then(function (r) { env.toast(tx('sent_ok', { rep: rep, n: (r.list && r.list.places || []).length, s: street || '—' }), 'ok'); st.places = []; $('gl-note').value = ''; st.busy = false; drawPlaces(); loadSent(); })
        .catch(function (e) { st.busy = false; drawPlaces(); env.toast(env.errMsg(e), 'err'); });
    };
    drawPlaces();
    return { reload: loadSent };
  }
  root.KhairGmaps = { parse: parse, fromShare: fromShare, coordsFromUrl: coordsFromUrl, nameFromUrl: nameFromUrl, isGmaps: isGmaps, isShort: isShort, okCoord: okCoord, officeUI: officeUI };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.KhairGmaps;
})(typeof window !== 'undefined' ? window : globalThis);
