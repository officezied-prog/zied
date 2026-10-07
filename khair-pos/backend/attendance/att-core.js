/* Khair Mart — attendance core (v17). One source for two places:
   - the n8n workflow "Khair Mart POS – Absensi" (Code node "Process Att" = this file + backend/attendance/process-att.js), and
   - the apps' mock backend (?mock=1 / demo), which loads this file from ../backend/attendance/att-core.js.
   Pure logic: no I/O. KAtt.core(ctx) returns { response, ops } and the workflow writes ops to the data tables.

   Face check: the shop device computes a 128-number face descriptor (face-api, on the device); the server compares it with the
   worker's enrolled descriptor (Euclidean distance ≤ att_face_max, default 0.5). Descriptors never leave the server.

   Append-only and tamper-evident: there is no action that edits or deletes an attendance record. Every record (check-in,
   check-out, failed attempt, face enrolment, worker change) carries seq, prev_hash and hash = sha256(prev_hash | fields);
   finished days are sealed (pos_att_seals: count, last seq, last hash, per-worker summary), and seals are chained too.
   att_report re-computes every hash: a changed field, a removed or re-ordered row, or a missing day shows as a broken chain. */
var KAtt = (function () {
  'use strict';
  /* ---------- SHA-256 (UTF-8), small and dependency-free so it runs the same in n8n and in the browser ---------- */
  var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function utf8(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { var c2 = s.charCodeAt(i + 1); if (c2 >= 0xdc00 && c2 < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00); i++; } }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | c >> 6, 0x80 | c & 63);
      else if (c < 0x10000) out.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
      else out.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    }
    return out;
  }
  function sha256(str) {
    var b = utf8(String(str)), l = b.length * 8;
    b.push(0x80);
    while (b.length % 64 !== 56) b.push(0);
    for (var s = 56; s >= 0; s -= 8) b.push(s >= 32 ? Math.floor(l / Math.pow(2, s)) & 255 : (l >>> s) & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], W = new Array(64);
    function r(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var o = 0; o < b.length; o += 64) {
      for (var t = 0; t < 16; t++) W[t] = (b[o + 4 * t] << 24) | (b[o + 4 * t + 1] << 16) | (b[o + 4 * t + 2] << 8) | b[o + 4 * t + 3];
      for (t = 16; t < 64; t++) {
        var s0 = r(W[t - 15], 7) ^ r(W[t - 15], 18) ^ (W[t - 15] >>> 3), s1 = r(W[t - 2], 17) ^ r(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
        var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }

  /* ---------- helpers ---------- */
  function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  function isHM(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
  function jkt(d) { return new Date(d.getTime() + 7 * 3600000).toISOString(); } // Jakarta wall time as ISO text
  function addDays(d, n) { var x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function minutesOf(hm) { return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)); }
  function wibMinutes(iso) { var j = jkt(new Date(iso)); return Number(j.slice(11, 13)) * 60 + Number(j.slice(14, 16)); }
  function rnd(n) { var s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', r = ''; for (var i = 0; i < n; i++) r += s[Math.floor(Math.random() * s.length)]; return r; }
  function personName(v) { var s = str(v).replace(/\s+/g, ' '); return /^[\p{L}][\p{L} .'-]{0,39}$/u.test(s) ? s : ''; }
  function normPhone(v) { var d = str(v).replace(/\D/g, ''); if (d.indexOf('0') === 0) d = '62' + d.slice(1); else if (d.indexOf('8') === 0) d = '62' + d; return d.length >= 9 && d.length <= 15 ? d : ''; }
  function km(a, b) {
    var R = 6371, toR = Math.PI / 180, dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function descriptor(v) {
    if (!Array.isArray(v) || v.length !== 128) return null;
    var out = [];
    for (var i = 0; i < 128; i++) { var n = Number(v[i]); if (!isFinite(n) || Math.abs(n) > 2) return null; out.push(Math.round(n * 10000) / 10000); }
    return out;
  }
  function distance(a, b) { var s = 0; for (var i = 0; i < 128; i++) { var d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
  function parseJSON(s, dflt) { try { var v = typeof s === 'string' ? JSON.parse(s) : s; return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; } }

  var DEFAULTS = { att_work_start: '08:00', att_work_end: '21:00', att_grace_min: 10, att_radius_m: 200, att_face_max: 0.5, att_min_gap_min: 2,
    att_seasons: [], att_off_weekdays: [] };
  /** Settings live in pos_settings (skey/svalue JSON) next to the POS settings; store_lat/store_lng come from there too. */
  function settingsOf(raw) {
    var s = JSON.parse(JSON.stringify(DEFAULTS));
    Object.keys(raw || {}).forEach(function (k) { s[k] = raw[k]; });
    return s;
  }
  /** Opening hours on a day: a season (e.g. two months before Ramadan → 23:00) overrides the normal end time. */
  function hoursOn(st, day) {
    var start = isHM(st.att_work_start) ? st.att_work_start : '08:00', end = isHM(st.att_work_end) ? st.att_work_end : '21:00', season = '';
    (Array.isArray(st.att_seasons) ? st.att_seasons : []).forEach(function (x) {
      if (x && isDate(x.from) && isDate(x.to) && day >= x.from && day <= x.to) { if (isHM(x.work_start)) start = x.work_start; if (isHM(x.work_end)) end = x.work_end; season = str(x.name); }
    });
    return { start: start, end: end, season: season };
  }

  /* ---------- the chain ---------- */
  var REC_FIELDS = ['seq', 'at', 'att_date', 'worker_id', 'worker_name', 'kind', 'score', 'face_ok', 'device_id', 'by_user', 'lat', 'lng', 'dist_m', 'note', 'client_id'];
  function recHash(r, prev) { return sha256(str(prev) + '|' + REC_FIELDS.map(function (f) { return f === 'face_ok' ? (r[f] === true ? '1' : '0') : str(r[f]); }).join('|')); }
  var SEAL_FIELDS = ['period', 'kind', 'count', 'first_seq', 'last_seq', 'last_hash', 'summary', 'created_at'];
  function sealHash(s, prev) { return sha256(str(prev) + '|' + SEAL_FIELDS.map(function (f) { return str(s[f]); }).join('|')); }
  function sortSeq(list) { return list.slice().sort(function (a, b) { return num(a.seq) - num(b.seq) || num(a.id) - num(b.id); }); }

  /** Checks records (any range, sorted by seq) and the seals of the days in that range.
   *  Two records can share a seq only when two devices saved at the same moment; each must still hash correctly. */
  function verify(records, seals, firstPrev) {
    var issues = [], list = sortSeq(records), bySeq = {};
    list.forEach(function (r) { (bySeq[num(r.seq)] = bySeq[num(r.seq)] || []).push(r); });
    var seqs = Object.keys(bySeq).map(Number).sort(function (a, b) { return a - b; });
    var prevHashes = null; // hashes of the previous seq (one, or two when two devices saved at the same moment)
    seqs.forEach(function (q, i) {
      if (i > 0 && q !== seqs[i - 1] + 1) issues.push({ seq: q, problem: 'gap', text: 'Catatan nomor ' + (seqs[i - 1] + 1) + (q - 1 > seqs[i - 1] + 1 ? '–' + (q - 1) : '') + ' hilang' });
      var group = bySeq[q];
      group.forEach(function (r) {
        if (recHash(r, r.prev_hash) !== r.hash) issues.push({ seq: q, problem: 'changed', text: 'Catatan nomor ' + q + ' (' + str(r.worker_name) + ') diubah' });
        var expect = prevHashes || (firstPrev ? [firstPrev] : null);
        if (expect && expect.indexOf(r.prev_hash) < 0) issues.push({ seq: q, problem: 'link', text: 'Urutan rusak sebelum catatan nomor ' + q });
      });
      prevHashes = group.map(function (r) { return r.hash; });
    });
    var byDay = {};
    list.forEach(function (r) { (byDay[r.att_date] = byDay[r.att_date] || []).push(r); });
    (seals || []).filter(function (s) { return s.kind === 'day'; }).forEach(function (s) {
      if (sealHash(s, s.prev_hash) !== s.hash) issues.push({ day: s.period, problem: 'seal_changed', text: 'Segel hari ' + s.period + ' diubah' });
      var rows = byDay[s.period];
      if (!rows) return; // outside the loaded range
      if (rows.length !== num(s.count)) issues.push({ day: s.period, problem: 'count', text: 'Hari ' + s.period + ': disegel ' + s.count + ' catatan, sekarang ' + rows.length });
      var lastRow = sortSeq(rows).pop();
      if (lastRow && lastRow.hash !== s.last_hash) issues.push({ day: s.period, problem: 'seal_hash', text: 'Hari ' + s.period + ' tidak sama dengan segelnya' });
    });
    return { ok: issues.length === 0, count: list.length, issues: issues.slice(0, 50) };
  }

  /* ---------- per-day summary ---------- */
  function dayRows(records, day, wid) { return sortSeq(records).filter(function (r) { return r.att_date === day && String(r.worker_id) === String(wid); }); }
  function summarizeDay(records, day, w, st, isToday) {
    var rows = dayRows(records, day, w.worker_id), ok = rows.filter(function (r) { return r.kind === 'in' || r.kind === 'out'; });
    var h = hoursOn(st, day), firstIn = null, lastOut = null, minutes = 0, open = null;
    ok.forEach(function (r) {
      if (r.kind === 'in') { if (!firstIn) firstIn = r.at; if (!open) open = r.at; }
      else if (open) { minutes += Math.max(0, Math.round((Date.parse(r.at) - Date.parse(open)) / 60000)); open = null; lastOut = r.at; }
      else lastOut = r.at;
    });
    var late = firstIn ? Math.max(0, wibMinutes(firstIn) - minutesOf(h.start) - num(st.att_grace_min)) : 0;
    var off = (Array.isArray(st.att_off_weekdays) ? st.att_off_weekdays : []).indexOf(new Date(day + 'T00:00:00Z').getUTCDay()) >= 0;
    // today, nobody is absent yet: 'belum' (not arrived yet) is not counted as an absence
    var status = firstIn ? (late > 0 ? 'terlambat' : 'hadir') : (off ? 'libur' : isToday ? 'belum' : 'tidak_hadir');
    return { date: day, worker_id: w.worker_id, name: w.name, first_in: firstIn || '', last_out: lastOut || '', open: !!open, minutes: minutes, late_min: late, status: status,
      fails: rows.filter(function (r) { return r.kind === 'fail'; }).length, hours: h };
  }

  /** ctx = { action, data, me: {name, role}, now: Date, settings: {}, store: {lat, lng},
   *          workers: [], records: [] (today + range rows the action needs), seals: [], head: {seq, hash, seal_hash}, prevBefore: hash before range } */
  function core(ctx) {
    var a = ctx.action, data = ctx.data || {}, me = ctx.me, role = me.role, now = ctx.now || new Date();
    var st = settingsOf(ctx.settings), today = jkt(now).slice(0, 10), nowIso = now.toISOString();
    var ops = { workers: [], records: [], seals: [], settings: [] };
    var head = { seq: num(ctx.head && ctx.head.seq), hash: str(ctx.head && ctx.head.hash) || 'GENESIS', seal_hash: str(ctx.head && ctx.head.seal_hash) || 'GENESIS' };
    var headChanged = false;
    var workers = (ctx.workers || []).map(function (w) { return w; });
    function fail(code, msg, extra) { var r = { ok: false, error: code, message: msg || code }; Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; }); return { response: r, ops: { workers: [], records: [], seals: [], settings: [] } }; }
    function done(resp) {
      if (headChanged) ops.settings.push({ skey: 'att_head', svalue: JSON.stringify({ seq: head.seq, hash: head.hash, seal_hash: head.seal_hash }) });
      return { response: resp, ops: ops };
    }
    function append(rec) {
      var r = { seq: head.seq + 1, at: nowIso, att_date: today, worker_id: '', worker_name: '', kind: '', score: '', face_ok: false, device_id: '', by_user: me.name,
        lat: '', lng: '', dist_m: '', note: '', client_id: '' };
      Object.keys(rec).forEach(function (k) { r[k] = rec[k]; });
      r.prev_hash = head.hash;
      r.hash = recHash(r, r.prev_hash);
      head.seq = r.seq; head.hash = r.hash; headChanged = true;
      ops.records.push(r);
      return r;
    }
    var isBoss = role === 'owner' || role === 'manager';
    function workerOut(w, withToday) {
      var o = { worker_id: w.worker_id, name: w.name, phone: w.phone || '', job: w.job || '', active: w.active !== false, enrolled: !!str(w.face_desc), consent_at: w.consent_at || '' };
      if (role === 'owner') o.daily_wage = num(w.daily_wage);
      if (isBoss && w.face_thumb) o.face_thumb = w.face_thumb;
      if (withToday) {
        var rows = dayRows(ctx.records || [], today, w.worker_id).filter(function (r) { return r.kind === 'in' || r.kind === 'out'; });
        var lastR = rows[rows.length - 1];
        o.today = { state: lastR ? lastR.kind : '', at: lastR ? lastR.at : '' };
      }
      return o;
    }
    function findWorker(id) { return workers.find(function (w) { return String(w.worker_id) === String(id); }); }

    /* Seal every finished day (before today) that has records and no seal yet; runs on any write so days get sealed early. */
    function sealDays() {
      var sealed = {};
      (ctx.seals || []).forEach(function (s) { if (s.kind === 'day') sealed[s.period] = true; });
      var days = {};
      (ctx.records || []).forEach(function (r) { if (r.att_date < today && !sealed[r.att_date]) (days[r.att_date] = days[r.att_date] || []).push(r); });
      Object.keys(days).sort().forEach(function (d) {
        var rows = sortSeq(days[d]), sum = {};
        workers.forEach(function (w) { var x = summarizeDay(rows, d, w, st); if (x.first_in || x.fails) sum[w.worker_id] = [x.status, x.minutes, x.late_min, x.fails]; });
        var s = { period: d, kind: 'day', count: rows.length, first_seq: rows[0].seq, last_seq: rows[rows.length - 1].seq, last_hash: rows[rows.length - 1].hash,
          summary: JSON.stringify(sum), created_at: nowIso };
        s.prev_hash = head.seal_hash; s.hash = sealHash(s, s.prev_hash); head.seal_hash = s.hash; headChanged = true;
        ops.seals.push(s);
      });
    }

    switch (a) {
      case 'att_bootstrap': {
        if (['owner', 'manager', 'kasir'].indexOf(role) < 0) return fail('FORBIDDEN', 'Tidak diizinkan');
        var h = hoursOn(st, today);
        return done({ ok: true, today: today, hours: h, grace_min: num(st.att_grace_min), radius_m: num(st.att_radius_m), store: ctx.store || null,
          workers: workers.filter(function (w) { return w.active !== false || isBoss; }).map(function (w) { return workerOut(w, true); }),
          settings: isBoss ? { att_work_start: st.att_work_start, att_work_end: st.att_work_end, att_grace_min: num(st.att_grace_min), att_radius_m: num(st.att_radius_m), att_seasons: st.att_seasons, att_off_weekdays: st.att_off_weekdays } : undefined });
      }
      case 'worker_save': {
        if (!isBoss) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
        var name = personName(data.name);
        if (!name) return fail('INVALID', 'Nama pekerja hanya boleh huruf, spasi dan . \' -');
        var ex = data.worker_id ? findWorker(data.worker_id) : null;
        if (data.worker_id && !ex) return fail('NOT_FOUND', 'Pekerja tidak ditemukan');
        var dup = workers.find(function (w) { return w !== ex && str(w.name).toLowerCase() === name.toLowerCase(); });
        if (dup) return fail('INVALID', 'Nama ' + name + ' sudah ada');
        var phone = str(data.phone) ? normPhone(data.phone) : '';
        if (str(data.phone) && !phone) return fail('INVALID', 'Nomor HP tidak valid');
        var w = ex ? JSON.parse(JSON.stringify(ex)) : { worker_id: 'W' + rnd(6), created_at: nowIso, created_by: me.name, face_desc: '', face_thumb: '', consent_at: '', consent_by: '', daily_wage: 0 };
        var changes = [];
        if (!ex || w.name !== name) changes.push(ex ? 'nama ' + w.name + ' → ' + name : 'pekerja baru');
        w.name = name;
        if (w.phone !== phone) { if (ex) changes.push('HP'); w.phone = phone; }
        var job = str(data.job).replace(/[<>]/g, '').slice(0, 40);
        if (str(w.job) !== job) { if (ex) changes.push('jabatan'); w.job = job; }
        if (data.active !== undefined && (data.active !== false) !== (w.active !== false)) { changes.push(data.active === false ? 'dinonaktifkan' : 'diaktifkan'); }
        if (data.active !== undefined) w.active = data.active !== false;
        else if (!ex) w.active = true;
        if (data.daily_wage !== undefined) {
          if (role !== 'owner') return fail('FORBIDDEN', 'Upah hanya diatur pemilik');
          var wage = Math.round(num(data.daily_wage));
          if (wage < 0 || wage > 10000000) return fail('INVALID', 'Upah harian tidak valid');
          if (wage !== num(w.daily_wage)) { changes.push('upah'); w.daily_wage = wage; }
        }
        if (!changes.length) return done({ ok: true, worker: workerOut(w) });
        w._id = ex ? ex.id : -1;
        ops.workers.push(w);
        append({ kind: 'worker', worker_id: w.worker_id, worker_name: w.name, note: changes.join(', ').slice(0, 200) });
        sealDays();
        return done({ ok: true, worker: workerOut(w) });
      }
      case 'worker_enroll': {
        if (!isBoss) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
        var we = findWorker(data.worker_id);
        if (!we) return fail('NOT_FOUND', 'Pekerja tidak ditemukan');
        if (data.consent !== true) return fail('CONSENT_REQUIRED', 'Pekerja harus setuju dulu (data wajah hanya untuk absensi)');
        var dsc = descriptor(data.descriptor);
        if (!dsc) return fail('INVALID', 'Data wajah tidak terbaca, ulangi foto');
        var thumb = typeof data.thumb === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{100,30000}$/.test(data.thumb) ? data.thumb : '';
        // the same face may not be enrolled for two workers
        var other = workers.find(function (w2) { var d2 = w2 !== we && str(w2.face_desc) ? descriptor(parseJSON(w2.face_desc, null)) : null; return d2 && distance(d2, dsc) <= num(st.att_face_max); });
        if (other) return fail('FACE_TAKEN', 'Wajah ini sudah terdaftar atas nama ' + other.name);
        var w2 = JSON.parse(JSON.stringify(we));
        var re = !!str(w2.face_desc);
        w2.face_desc = JSON.stringify(dsc); w2.face_thumb = thumb; w2.consent_at = nowIso; w2.consent_by = me.name; w2._id = we.id;
        ops.workers.push(w2);
        append({ kind: 'enroll', worker_id: w2.worker_id, worker_name: w2.name, note: (re ? 'wajah didaftarkan ulang' : 'wajah didaftarkan') + ', persetujuan dicatat oleh ' + me.name });
        sealDays();
        return done({ ok: true, worker: workerOut(w2) });
      }
      case 'worker_forget': {
        // UU PDP: a worker who leaves may ask to delete the face data. The numbers and the thumbnail are cleared;
        // past attendance records stay (they never held the face) and the deletion itself is recorded in the chain.
        if (role !== 'owner') return fail('FORBIDDEN', 'Hanya pemilik');
        var wf = findWorker(data.worker_id);
        if (!wf) return fail('NOT_FOUND', 'Pekerja tidak ditemukan');
        if (!str(wf.face_desc) && !str(wf.face_thumb)) return done({ ok: true, worker: workerOut(wf) });
        var w3 = JSON.parse(JSON.stringify(wf));
        w3.face_desc = ''; w3.face_thumb = ''; w3._id = wf.id;
        ops.workers.push(w3);
        append({ kind: 'forget', worker_id: w3.worker_id, worker_name: w3.name, note: 'data wajah dihapus atas permintaan pekerja' });
        sealDays();
        return done({ ok: true, worker: workerOut(w3) });
      }
      case 'att_mark': {
        if (['owner', 'manager', 'kasir'].indexOf(role) < 0) return fail('FORBIDDEN', 'Tidak diizinkan');
        var wm = findWorker(data.worker_id);
        if (!wm || wm.active === false) return fail('NOT_FOUND', 'Pekerja tidak ditemukan');
        var enrolled = str(wm.face_desc) ? descriptor(parseJSON(wm.face_desc, null)) : null;
        if (!enrolled) return fail('NOT_ENROLLED', 'Wajah ' + wm.name + ' belum didaftarkan');
        var cid = str(data.client_id).slice(0, 60);
        if (cid) {
          var same = (ctx.records || []).find(function (r) { return r.client_id === cid; });
          if (same) return done({ ok: same.kind !== 'fail', duplicate: true, record: { kind: same.kind, at: same.at, worker_name: same.worker_name } });
        }
        var dm = descriptor(data.descriptor);
        if (!dm) return fail('INVALID', 'Wajah tidak terbaca, ulangi');
        var dev = str(data.device && data.device.id).slice(0, 60);
        var loc = data.loc && isFinite(Number(data.loc.lat)) && isFinite(Number(data.loc.lng)) && Number(data.loc.lat) !== 0 ? { lat: Number(data.loc.lat), lng: Number(data.loc.lng) } : null;
        var store = ctx.store && num(ctx.store.lat) && num(ctx.store.lng) ? { lat: num(ctx.store.lat), lng: num(ctx.store.lng) } : null;
        var dist = loc && store ? Math.round(km(loc, store) * 1000) : '';
        var base = { worker_id: wm.worker_id, worker_name: wm.name, device_id: dev, lat: loc ? Math.round(loc.lat * 1e6) / 1e6 : '', lng: loc ? Math.round(loc.lng * 1e6) / 1e6 : '', dist_m: dist, client_id: cid };
        var score = Math.round(distance(dm, enrolled) * 1000) / 1000;
        if (store && !loc) { append(Object.assign({ kind: 'fail', score: score, note: 'lokasi perangkat tidak ada' }, base)); sealDays(); return done({ ok: false, error: 'LOCATION_REQUIRED', message: 'Nyalakan lokasi perangkat toko untuk absen' }); }
        if (store && dist > num(st.att_radius_m)) { append(Object.assign({ kind: 'fail', score: score, note: 'di luar toko (' + dist + ' m)' }, base)); sealDays(); return done({ ok: false, error: 'OUTSIDE', message: 'Absen hanya di toko (jarak ' + dist + ' m)' }); }
        if (score > num(st.att_face_max)) {
          append(Object.assign({ kind: 'fail', score: score, note: 'wajah tidak cocok' }, base)); sealDays();
          return done({ ok: false, error: 'FACE_MISMATCH', message: 'Wajah tidak cocok dengan ' + wm.name + '. Coba lagi menghadap kamera.' });
        }
        var todayRows = dayRows(ctx.records || [], today, wm.worker_id).filter(function (r) { return r.kind === 'in' || r.kind === 'out'; });
        var lastR = todayRows[todayRows.length - 1];
        if (lastR && (Date.parse(nowIso) - Date.parse(lastR.at)) < num(st.att_min_gap_min) * 60000) {
          return done({ ok: true, duplicate: true, record: { kind: lastR.kind, at: lastR.at, worker_name: wm.name }, message: 'Sudah tercatat ' + (lastR.kind === 'in' ? 'masuk' : 'pulang') + ' barusan' });
        }
        var kind = lastR && lastR.kind === 'in' ? 'out' : 'in';
        var rec = append(Object.assign({ kind: kind, score: score, face_ok: true }, base));
        sealDays();
        var hh = hoursOn(st, today);
        var lateMin = kind === 'in' && !lastR ? Math.max(0, wibMinutes(nowIso) - minutesOf(hh.start) - num(st.att_grace_min)) : 0;
        return done({ ok: true, record: { kind: kind, at: rec.at, worker_name: wm.name, late_min: lateMin } });
      }
      case 'att_report': {
        if (!isBoss) return fail('FORBIDDEN', 'Hanya pemilik atau manajer');
        if (!isDate(data.from) || !isDate(data.to) || data.from > data.to) return fail('INVALID', 'Rentang tanggal tidak valid');
        if (addDays(data.from, 62) < data.to) return fail('INVALID', 'Paling lama 62 hari sekali lihat');
        sealDays();
        var recs = (ctx.records || []).filter(function (r) { return r.att_date >= data.from && r.att_date <= data.to; });
        var check = verify(recs, (ctx.seals || []).concat(ops.seals).filter(function (s) { return s.period >= data.from && s.period <= data.to; }), ctx.prevBefore === undefined ? null : ctx.prevBefore);
        var days = [];
        for (var d = data.from; d <= data.to && d <= today; d = addDays(d, 1)) days.push(d);
        var people = workers.filter(function (w) { return w.active !== false || recs.some(function (r) { return String(r.worker_id) === String(w.worker_id); }); });
        var rows = [];
        people.forEach(function (w) {
          days.forEach(function (dd) {
            if (str(w.created_at) && jkt(new Date(w.created_at)).slice(0, 10) > dd) return; // not yet working here
            var x = summarizeDay(recs, dd, w, st, dd === today); delete x.hours; rows.push(x);
          });
        });
        var totals = people.map(function (w) {
          var mine = rows.filter(function (r) { return r.worker_id === w.worker_id; });
          var present = mine.filter(function (r) { return r.status === 'hadir' || r.status === 'terlambat'; }).length;
          var t = { worker_id: w.worker_id, name: w.name, job: w.job || '', days: mine.length, present: present, late_days: mine.filter(function (r) { return r.status === 'terlambat'; }).length,
            absent: mine.filter(function (r) { return r.status === 'tidak_hadir'; }).length, minutes: mine.reduce(function (s, r) { return s + r.minutes; }, 0),
            late_min: mine.reduce(function (s, r) { return s + r.late_min; }, 0), fails: mine.reduce(function (s, r) { return s + r.fails; }, 0) };
          if (role === 'owner') { t.daily_wage = num(w.daily_wage); t.wage_due = present * num(w.daily_wage); }
          return t;
        });
        var events = sortSeq(recs).filter(function (r) { return r.kind !== 'in' && r.kind !== 'out'; }).map(function (r) { return { seq: r.seq, at: r.at, kind: r.kind, worker_name: r.worker_name, by_user: r.by_user, note: r.note, score: r.score }; });
        return done({ ok: true, from: data.from, to: data.to, rows: rows, totals: totals, events: events.slice(-200), verify: check, sealed_days: (ctx.seals || []).concat(ops.seals).filter(function (s) { return s.kind === 'day' && s.period >= data.from && s.period <= data.to; }).length });
      }
      case 'att_settings': {
        if (role !== 'owner') return fail('FORBIDDEN', 'Hanya pemilik');
        var inS = data.settings || {}, out = {}, note = [];
        if (inS.att_work_start !== undefined) { if (!isHM(inS.att_work_start)) return fail('INVALID', 'Jam buka tidak valid'); out.att_work_start = inS.att_work_start; }
        if (inS.att_work_end !== undefined) { if (!isHM(inS.att_work_end)) return fail('INVALID', 'Jam tutup tidak valid'); out.att_work_end = inS.att_work_end; }
        if (inS.att_grace_min !== undefined) { var g = Math.round(num(inS.att_grace_min)); if (g < 0 || g > 120) return fail('INVALID', 'Toleransi 0–120 menit'); out.att_grace_min = g; }
        if (inS.att_radius_m !== undefined) { var rr = Math.round(num(inS.att_radius_m)); if (rr < 30 || rr > 5000) return fail('INVALID', 'Radius 30–5000 m'); out.att_radius_m = rr; }
        if (inS.att_off_weekdays !== undefined) { if (!Array.isArray(inS.att_off_weekdays) || inS.att_off_weekdays.some(function (x) { return [0, 1, 2, 3, 4, 5, 6].indexOf(x) < 0; })) return fail('INVALID', 'Hari libur tidak valid'); out.att_off_weekdays = inS.att_off_weekdays; }
        if (inS.att_seasons !== undefined) {
          if (!Array.isArray(inS.att_seasons) || inS.att_seasons.length > 6) return fail('INVALID', 'Musim tidak valid');
          var bad = inS.att_seasons.find(function (x) { return !x || !isDate(x.from) || !isDate(x.to) || x.from > x.to || (x.work_end !== undefined && !isHM(x.work_end)) || (x.work_start !== undefined && !isHM(x.work_start)); });
          if (bad) return fail('INVALID', 'Musim: tanggal atau jam tidak valid');
          out.att_seasons = inS.att_seasons.map(function (x) { var o = { name: str(x.name).replace(/[<>]/g, '').slice(0, 30), from: x.from, to: x.to }; if (x.work_start) o.work_start = x.work_start; if (x.work_end) o.work_end = x.work_end; return o; });
        }
        Object.keys(out).forEach(function (k) { if (JSON.stringify(out[k]) !== JSON.stringify(st[k])) { ops.settings.push({ skey: k, svalue: JSON.stringify(out[k]) }); note.push(k.replace('att_', '') + '=' + JSON.stringify(out[k])); } });
        if (note.length) append({ kind: 'setting', note: note.join('; ').slice(0, 300) });
        sealDays();
        return done({ ok: true, settings: settingsOf(Object.assign({}, ctx.settings, out)) });
      }
      default:
        return fail('INVALID', 'Aksi tidak dikenal: ' + a);
    }
  }
  return { core: core, sha256: sha256, verify: verify, recHash: recHash, sealHash: sealHash, hoursOn: hoursOn, DEFAULTS: DEFAULTS };
})();
if (typeof window !== 'undefined') window.KAtt = KAtt;
