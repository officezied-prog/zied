/* Khair Mart — attendance in the apps' mock / demo backend (v17). Uses the same core as the server
   (backend/attendance/att-core.js, loaded first) on db.att inside the mock database, and seeds three demo workers
   with ten days of history so the report has something to show. Demo faces are fixed numbers: tests pick them with
   KAttMock.demoFace(i); a real face in a trial does not match them, so a trial user enrols a worker first. */
(function (root) {
  var ACTIONS = ['att_bootstrap', 'worker_save', 'worker_enroll', 'worker_forget', 'att_mark', 'att_report', 'att_settings'];
  function demoFace(i) {
    var x = ((i + 1) * 2654435761) >>> 0, out = [];
    for (var k = 0; k < 128; k++) { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; out.push(Math.round(((x % 2000) / 1000 - 1) * 1000) / 10000); }
    return out;
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function apply(A, ops) {
    ops.workers.forEach(function (w) {
      var o = clone(w), id = o._id; delete o._id;
      if (id === -1 || id === undefined) { o.id = A.nid++; A.workers.push(o); } else { var ex = A.workers.find(function (x) { return x.id === id; }); if (ex) Object.assign(ex, o); }
    });
    ops.records.forEach(function (r) { var o = clone(r); delete o._id; o.id = A.nid++; A.records.push(o); });
    ops.seals.forEach(function (r) { var o = clone(r); delete o._id; o.id = A.nid++; A.seals.push(o); });
    ops.settings.forEach(function (x) { var v = JSON.parse(x.svalue); if (x.skey === 'att_head') A.head = v; else A.settings[x.skey] = v; });
  }
  function run(db, me, action, data, now) {
    var A = db.att, st = db.settings || {};
    var settings = Object.assign({}, A.settings);
    var res = root.KAtt.core({ action: action, data: data || {}, me: me, now: now || new Date(), settings: settings,
      store: { lat: Number(st.store_lat) || 0, lng: Number(st.store_lng) || 0 }, workers: clone(A.workers), records: clone(A.records), seals: clone(A.seals), head: A.head });
    apply(A, res.ops);
    return res.response;
  }
  function ensure(db) {
    if (db.att) return false;
    db.att = { workers: [], records: [], seals: [], settings: {}, head: null, nid: 1 };
    var st = db.settings || {}, loc = Number(st.store_lat) ? { lat: Number(st.store_lat), lng: Number(st.store_lng) } : null;
    var OWNER = { name: 'Pemilik', role: 'owner' }, KASIR = { name: 'Kasir', role: 'kasir' };
    var today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    var day = function (n) { var d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
    var at = function (d, hm) { return new Date(d + 'T' + hm + ':00+07:00'); };
    var people = [['Budi Santoso', 'Kuli angkut', 120000], ['Slamet Riyadi', 'Kuli angkut', 110000], ['Rahmat Hidayat', 'Gudang', 130000]];
    var start = at(day(11), '07:30'), ids = [];
    people.forEach(function (p, i) {
      var r = run(db, OWNER, 'worker_save', { name: p[0], job: p[1], daily_wage: p[2] }, start);
      ids.push(r.worker.worker_id);
      run(db, OWNER, 'worker_enroll', { worker_id: r.worker.worker_id, descriptor: demoFace(i), consent: true }, start);
    });
    // ten days: Budi on time (absent 4 days ago), Slamet often late, Rahmat until closing; one failed face check
    for (var n = 10; n >= 1; n--) {
      var d = day(n);
      if (n !== 4) { run(db, KASIR, 'att_mark', { worker_id: ids[0], descriptor: demoFace(0), loc: loc }, at(d, '07:55')); run(db, KASIR, 'att_mark', { worker_id: ids[0], descriptor: demoFace(0), loc: loc }, at(d, '17:05')); }
      run(db, KASIR, 'att_mark', { worker_id: ids[1], descriptor: demoFace(1), loc: loc }, at(d, n % 3 ? '08:05' : '08:40'));
      run(db, KASIR, 'att_mark', { worker_id: ids[1], descriptor: demoFace(1), loc: loc }, at(d, '16:30'));
      if (n === 6) run(db, KASIR, 'att_mark', { worker_id: ids[2], descriptor: demoFace(0), loc: loc }, at(d, '07:58'));
      run(db, KASIR, 'att_mark', { worker_id: ids[2], descriptor: demoFace(2), loc: loc }, at(d, '08:00'));
      run(db, KASIR, 'att_mark', { worker_id: ids[2], descriptor: demoFace(2), loc: loc }, at(d, '21:00'));
    }
    return true;
  }
  /** E = the mock's error constructor (code, message, extra). Returns the response without ok (the mock adds it). */
  function handle(db, u, action, data, E) {
    ensure(db);
    var res = run(db, { name: u.name, role: u.role }, action, data);
    // as on the server, a refused check-in is still recorded (fail record): the mock keeps db.att although the request fails
    if (!res.ok) { var err = E(res.error || 'SERVER', res.message); err.attState = db.att; throw err; }
    var o = Object.assign({}, res); delete o.ok;
    return o;
  }
  root.KAttMock = { ACTIONS: ACTIONS, handle: handle, demoFace: demoFace, ensure: ensure };
})(window);
