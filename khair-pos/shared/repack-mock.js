/* Khair Mart demo backends (mock.js and kasir/mock.js) — v50 (owner 2026-10-15) repacking in two steps and the packaging
   materials list, written ONCE for both demo apps. Mirrors backend/process.js: set_repack_materials, repack_start, repack_finish,
   repackCostsOf (a material on the list costs the list's price × pieces per pack) and repackMatsIn. Keep identical to the server.
   X = the calling mock's helpers: { E(code, msg, extra), nextId(db, kind), logAct(db, u, kind, txt, ref, amount, level),
   notify(db, u, roles, txt, level), safeName(v, max) }. */
(function () {
  'use strict';
  if (window.KRepackMock) return;
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const r3 = v => Math.round(num(v) * 1000) / 1000;
  const int = v => Math.round(num(v));
  const strv = v => (v == null ? '' : String(v).trim());
  const fmtN = v => String(r3(v));
  const rpT = v => 'Rp ' + String(Math.round(Math.abs(num(v)))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const wib = iso => { const t0 = Date.parse(iso); return isFinite(t0) ? new Date(t0 + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' WIB' : ''; };
  const jkDate = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const isYmd = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const rid = n => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
  const RECENT_MS = 2 * 3600000, SUP = 'KEMAS ULANG';
  const COST_ROLES = ['owner', 'manager', 'akuntan'];

  function catalog(db) {
    const a = (db.settings || {}).repack_materials;
    return (Array.isArray(a) ? a : []).map(x => ({ name: strv(x && x.n).slice(0, 40), cost: Math.max(0, int(x && x.c)) })).filter(x => x.name).slice(0, 60);
  }
  function price(db, name) { const k = strv(name).toLowerCase(); const m = catalog(db).find(x => x.name.toLowerCase() === k); return m ? m.cost : null; }
  function costsOf(db, p) {
    let a = [];
    try { a = JSON.parse(String((p && p.repack_costs) || '') || '[]'); } catch (e) { a = []; }
    return (Array.isArray(a) ? a : []).map(x => {
      const name = strv(x && x.n).slice(0, 40), q = num(x && x.q) > 0 ? r3(x.q) : 1, pr = price(db, name);
      return { name, qty: q, cost: pr === null ? Math.max(0, int(x && x.c)) : Math.round(pr * q) };
    }).filter(x => x.name).slice(0, 12);
  }
  const costPer = (db, p) => costsOf(db, p).reduce((t, x) => t + x.cost, 0);
  /** The pack's materials chosen from the list ([{name, qty}]) → {json, list} or {error}. */
  function matsIn(db, list) {
    if (!Array.isArray(list)) return { error: 'Daftar bahan kemasan tidak valid' };
    const cat = catalog(db), out = [];
    for (const x0 of list) {
      const x = x0 || {}, k = strv(x.name).toLowerCase();
      if (!k) continue;
      const m = cat.find(c => c.name.toLowerCase() === k);
      if (!m) return { error: 'Bahan "' + strv(x.name).slice(0, 40) + '" tidak ada di daftar bahan kemasan — tambahkan dulu ke daftar' };
      const q = x.qty === undefined || x.qty === null || x.qty === '' ? 1 : Number(x.qty);
      if (!Number.isFinite(q) || q <= 0 || q > 1000) return { error: 'Jumlah ' + m.name + ' per kemasan tidak valid' };
      if (out.some(o => o.n.toLowerCase() === k)) return { error: m.name + ' dipilih dua kali' };
      out.push({ n: m.name, q: r3(q), c: Math.round(m.cost * q) });
    }
    if (out.length > 12) return { error: 'Paling banyak 12 bahan kemasan' };
    return { json: out.length ? JSON.stringify(out) : '', list: out };
  }
  function costsText(list, unit) {
    if (!list.length) return 'tanpa bahan kemasan';
    const tot = list.reduce((t, x) => t + num(x.c !== undefined ? x.c : x.cost), 0);
    return 'bahan kemasan per ' + (unit || 'pcs') + ': ' + list.map(x => { const q = num(x.q !== undefined ? x.q : x.qty); return strv(x.n || x.name) + (q > 0 && q !== 1 ? ' x' + fmtN(q) : '') + ' ' + rpT(x.c !== undefined ? x.c : x.cost); }).join(' + ') + ' = ' + rpT(tot);
  }
  /** Settings as the role may see them: the cashier / rep get the materials' names only. */
  const catalogOut = (db, role) => catalog(db).map(x => (COST_ROLES.includes(role) ? { n: x.name, c: x.cost } : { n: x.name }));
  /** A product's materials as the role may see them (names only for the cashier / rep). */
  const productCosts = (db, p, role) => (p.repack_costs && !COST_ROLES.includes(role) ? Object.assign({}, p, { repack_costs: JSON.stringify(costsOf(db, p).map(x => ({ n: x.name }))) }) : p);
  function out(r, role) { const o = Object.assign({}, r); delete o.id; if (role !== 'owner') { delete o.unit_cost; delete o.packaging_cost; delete o.materials_cost; delete o.bulk_cost; } return o; }
  const openList = (db, role) => (['owner', 'manager', 'kasir', 'akuntan'].includes(role) ? (db.repacks || []).filter(r => r.status === 'proses').map(r => out(r, role)) : []);

  function materials(db, u, data, X) {
    if (u.role !== 'owner' && u.role !== 'manager') throw X.E('FORBIDDEN', 'Hanya pemilik / manajer');
    if (!Array.isArray(data.materials)) throw X.E('INVALID', 'Daftar bahan kemasan tidak valid');
    const list = [];
    for (const x0 of data.materials) {
      const x = x0 || {}, raw = strv(x.name);
      if (!raw) continue;
      const name = X.safeName(raw, 40); if (!name) throw X.E('INVALID', 'Nama bahan kemasan hanya boleh huruf dan angka (maks. 40)');
      const c = Number(x.cost === '' || x.cost === undefined || x.cost === null ? NaN : x.cost);
      if (!Number.isFinite(c) || c < 0 || c > 10000000) throw X.E('INVALID', 'Harga ' + name + ' per buah tidak valid');
      if (list.some(o => o.n.toLowerCase() === name.toLowerCase())) throw X.E('INVALID', name + ' ada dua kali di daftar');
      list.push({ n: name, c: Math.round(c) });
    }
    if (list.length > 60) throw X.E('INVALID', 'Paling banyak 60 bahan kemasan');
    const before = catalog(db), ch = [];
    list.forEach(x => { const b = before.find(y => y.name.toLowerCase() === x.n.toLowerCase()); if (!b) ch.push('+ ' + x.n + ' ' + rpT(x.c)); else if (b.cost !== x.c) ch.push(x.n + ' ' + rpT(b.cost) + ' → ' + rpT(x.c)); });
    before.forEach(b => { if (!list.some(x => x.n.toLowerCase() === b.name.toLowerCase())) ch.push('− ' + b.name); });
    if (!ch.length) return { unchanged: true, materials: list };
    db.settings = db.settings || {}; db.settings.repack_materials = list;
    const txt = 'Daftar bahan kemasan diubah (harga per buah): ' + ch.join('; ') + ' — oleh ' + (u.role === 'manager' ? 'manajer ' : 'pemilik ') + u.name;
    X.logAct(db, u, 'atur_kemas', txt.slice(0, 1000), 'bahan', 0, 'info');
    X.notify(db, u, ['owner', 'manager', 'akuntan'].filter(r => r !== u.role), txt, 'info');
    return { materials: list };
  }

  function start(db, u, data, X) {
    if (!['owner', 'manager', 'kasir'].includes(u.role)) throw X.E('FORBIDDEN', 'Tidak diizinkan');
    db.repacks = db.repacks || [];
    const cid = strv(data.client_id).slice(0, 60);
    if (cid) { const same = db.repacks.find(r => strv(r.client_id) === cid); if (same) return { duplicate: true, repack: out(same, u.role) }; }
    const bulk = db.products.find(p => p.id === Number(data.from_product_id)), to = db.products.find(p => p.id === Number(data.to_product_id));
    if (!bulk || bulk.active === false) throw X.E('NOT_FOUND', 'Produk curah tidak ditemukan');
    if (!to || to.active === false) throw X.E('NOT_FOUND', 'Produk kemasan tidak ditemukan');
    if (!(num(to.repack_from) > 0) || !(num(to.repack_qty) > 0)) throw X.E('INVALID', to.name + ' belum diatur sebagai kemasan ulang (manajer mengaturnya dulu)');
    if (Number(to.repack_from) !== Number(bulk.id)) throw X.E('INVALID', to.name + ' dibuat dari ' + ((db.products.find(p => p.id === Number(to.repack_from)) || {}).name || '—') + ', bukan dari ' + bulk.name);
    const pend = X.pending && X.pending(db, bulk.id); // a v38 request still waiting for this bulk is decided first
    if (pend) throw pend;
    const size = num(to.repack_qty), fromQty = r3(data.from_qty);
    if (!(fromQty > 0)) throw X.E('INVALID', 'Jumlah curah yang dikemas tidak valid');
    if (fromQty > num(bulk.stock) + 1e-9) throw X.E('INVALID', 'Stok ' + bulk.name + ' tidak cukup (' + fmtN(bulk.stock) + ' ' + strv(bulk.unit) + ')');
    const planned = Math.floor(fromQty / size + 1e-9);
    if (planned < 1) throw X.E('INVALID', fmtN(fromQty) + ' ' + strv(bulk.unit) + ' kurang dari isi satu kemasan (' + fmtN(size) + ' ' + strv(bulk.unit) + ')');
    const open = db.repacks.filter(r => r.status === 'proses');
    const busy = open.find(r => Number(r.from_product_id) === Number(bulk.id) && Number(r.to_product_id) === Number(to.id));
    if (busy) throw X.E('REPACK_BUSY', strv(busy.started_by || busy.user) + ' sedang mengemas ' + busy.from_name + ' ' + fmtN(busy.from_qty) + ' ' + strv(busy.from_unit) + ' → ' + busy.to_name + ' (mulai ' + wib(busy.started_at || busy.repack_time) + ', ' + busy.repack_id + '). Selesaikan dulu: manajer mengonfirmasi hasilnya.',
      { busy: { repack_id: busy.repack_id, by: strv(busy.started_by || busy.user), at: strv(busy.started_at || busy.repack_time), from_name: busy.from_name, from_qty: num(busy.from_qty), from_unit: strv(busy.from_unit), to_name: busy.to_name, planned: num(busy.planned_qty) } });
    if (data.confirm_recent !== true) {
      const last = db.repacks.filter(r => Number(r.from_product_id) === Number(bulk.id) && Date.now() - Date.parse(r.started_at || r.repack_time) < RECENT_MS)
        .sort((a, b) => String(a.started_at || a.repack_time).localeCompare(String(b.started_at || b.repack_time))).pop();
      if (last) {
        const lq = last.status === 'proses' ? num(last.planned_qty) : num(last.to_qty);
        throw X.E('REPACK_RECENT', strv(last.started_by || last.user) + ' sudah mengemas ulang ' + last.from_name + ' ' + fmtN(last.from_qty) + ' ' + strv(last.from_unit) + ' → ' + last.to_name + ' x' + fmtN(lq) + ' pada ' + wib(last.started_at || last.repack_time) + ' (' + last.repack_id + '). Kalau ini kemas ulang lain (bukan yang sama), tekan "Ya, ini kemas ulang baru".',
          { recent: { repack_id: last.repack_id, user: strv(last.started_by || last.user), at: strv(last.started_at || last.repack_time), from_name: last.from_name, from_qty: num(last.from_qty), from_unit: strv(last.from_unit), to_name: last.to_name, to_qty: lq } });
      }
    }
    const now = new Date().toISOString(), date = jkDate(), fromOld = num(bulk.stock);
    bulk.stock = r3(fromOld - fromQty);
    const rp = {
      repack_id: 'RP' + rid(6), repack_date: date, repack_time: now, user: u.name, status: 'proses',
      from_product_id: bulk.id, from_name: bulk.name, from_unit: strv(bulk.unit), from_qty: fromQty,
      to_product_id: to.id, to_name: to.name, to_unit: strv(to.unit), to_qty: 0, pack_size: size,
      expected_qty: planned, planned_qty: planned, planned_from_qty: fromQty, yield_pct: 0, loss_qty: 0, remaining_qty: 0,
      packaging_cost: Math.max(0, int(data.packaging_cost)), unit_cost: 0, materials_cost: 0, bulk_cost: int(bulk.cost_price),
      exp_date: isYmd(data.exp_date) ? data.exp_date : '', note: strv(data.note).slice(0, 300),
      requested_by: '', approved_by: '', request_id: '', client_id: cid, started_by: u.name, started_at: now, confirmed_by: '', confirmed_at: ''
    };
    db.repacks.push(Object.assign({ id: X.nextId(db, 'repack') }, rp));
    db.purchases.push({ id: X.nextId(db, 'purchase'), purchase_date: date, supplier: SUP, product_id: bulk.id, name: bulk.name, qty: -fromQty, cost_price: int(bulk.cost_price), total: 0,
      note: ('diambil untuk dikemas → ' + to.name + ' (rencana ' + planned + ', ' + rp.repack_id + ') ' + rp.note).trim(), user: u.name, photo_id: '', exp_date: '' });
    const who = { owner: 'pemilik', manager: 'manajer', kasir: 'kasir' }[u.role] || u.role, over = r3(fromQty - planned * size);
    const txt = 'Mulai kemas ulang oleh ' + who + ' ' + u.name + ' (' + wib(now) + ', ' + rp.repack_id + '): ' + bulk.name + ' ' + fmtN(fromQty) + ' ' + strv(bulk.unit) +
      ' diambil → ' + to.name + ' (' + fmtN(size) + ' ' + strv(bulk.unit) + ' per ' + (strv(to.unit) || 'pcs') + ') = ' + planned + ' kemasan rencana' + (over > 0 ? ', sisa ' + fmtN(over) + ' ' + strv(bulk.unit) : '') +
      ' | stok ' + bulk.name + ' ' + fmtN(fromOld) + ' → ' + fmtN(bulk.stock) + ' ' + strv(bulk.unit) + (data.confirm_recent === true ? ' — dikonfirmasi bukan kemas ulang ganda' : '') +
      '. Setelah selesai, manajer mengonfirmasi jumlah kemasan jadi.';
    X.logAct(db, u, 'kemas_ulang', txt, rp.repack_id, 0, 'info');
    X.notify(db, u, ['owner', 'manager'].filter(r => r !== u.role), txt, 'info');
    return { repack: out(rp, u.role), stock: [{ product_id: bulk.id, stock: bulk.stock }] };
  }

  function finish(db, u, data, X) {
    if (u.role !== 'owner' && u.role !== 'manager') throw X.E('FORBIDDEN', 'Hanya manajer / pemilik yang mengonfirmasi hasil kemas ulang');
    const r = (db.repacks || []).find(x => strv(x.repack_id) === strv(data.repack_id));
    if (!r) throw X.E('NOT_FOUND', 'Kemas ulang tidak ditemukan');
    if (r.status !== 'proses') throw X.E('INVALID', 'Kemas ulang ' + r.repack_id + ' sudah ' + (r.status === 'batal' ? 'dibatalkan' : 'dikonfirmasi') + (r.confirmed_by ? ' oleh ' + r.confirmed_by : ''));
    const bulk = db.products.find(p => p.id === Number(r.from_product_id)), to = db.products.find(p => p.id === Number(r.to_product_id));
    if (!bulk || !to) throw X.E('NOT_FOUND', 'Produk curah / kemasan tidak ditemukan');
    const F = num(r.from_qty), size = num(r.pack_size) > 0 ? num(r.pack_size) : num(to.repack_qty), cancel = data.cancel === true;
    const made = cancel ? 0 : r3(data.to_qty), rem = cancel ? F : r3(data.remaining_qty);
    if (!cancel && !(made > 0)) throw X.E('INVALID', 'Isi jumlah kemasan yang jadi (atau batalkan kemas ulang ini)');
    if (!(rem >= 0) || rem > F + 1e-9) throw X.E('INVALID', 'Sisa curah harus antara 0 dan ' + fmtN(F) + ' ' + strv(r.from_unit));
    const used = r3(F - rem);
    if (!cancel && !(used > 0)) throw X.E('INVALID', 'Tidak ada curah yang terpakai: periksa sisa curah');
    if (made * size > used * 1.1 + 1e-9) throw X.E('INVALID', fmtN(made) + ' kemasan × ' + fmtN(size) + ' ' + strv(r.from_unit) + ' lebih dari curah yang terpakai (' + fmtN(used) + ' ' + strv(r.from_unit) + ')');
    const matCost = Math.round(costPer(db, to) * made), other = Math.max(0, int(r.packaging_cost)) + Math.max(0, int(data.packaging_cost));
    const packCost = cancel ? 0 : other + matCost, bulkCost = num(r.bulk_cost) > 0 ? int(r.bulk_cost) : int(bulk.cost_price);
    const unitCost = made > 0 ? Math.round((used * bulkCost + packCost) / made) : 0;
    const expected = size > 0 ? r3(used / size) : 0, yieldPct = expected > 0 ? Math.round(made / expected * 1000) / 10 : 0, loss = r3(used - made * size);
    const now = new Date().toISOString(), date = jkDate(), stock = [];
    if (rem > 0) {
      bulk.stock = r3(num(bulk.stock) + rem);
      db.purchases.push({ id: X.nextId(db, 'purchase'), purchase_date: date, supplier: SUP, product_id: bulk.id, name: bulk.name, qty: rem, cost_price: bulkCost, total: 0,
        note: (cancel ? 'kemas ulang dibatalkan, curah kembali (' : 'sisa curah dikembalikan (') + r.repack_id + ')', user: u.name, photo_id: '', exp_date: '' });
      stock.push({ product_id: bulk.id, stock: bulk.stock });
    }
    if (made > 0) {
      const oldTo = Math.max(0, num(to.stock));
      to.cost_price = oldTo + made > 0 ? Math.round((oldTo * int(to.cost_price) + made * unitCost) / (oldTo + made)) : unitCost;
      to.stock = r3(num(to.stock) + made);
      db.purchases.push({ id: X.nextId(db, 'purchase'), purchase_date: date, supplier: SUP, product_id: to.id, name: to.name, qty: made, cost_price: unitCost, total: 0,
        note: ('dari ' + bulk.name + ' ' + used + ' ' + strv(bulk.unit) + ' (' + r.repack_id + ', dikonfirmasi ' + u.name + ') ' + strv(r.note)).trim(), user: u.name, photo_id: '', exp_date: strv(r.exp_date) });
      stock.push(Object.assign({ product_id: to.id, stock: to.stock }, u.role === 'owner' ? { cost_price: to.cost_price } : {}));
    }
    Object.assign(r, {
      status: cancel ? 'batal' : 'selesai', repack_date: date, from_qty: used, to_qty: made, expected_qty: expected, yield_pct: yieldPct, loss_qty: cancel ? 0 : loss,
      remaining_qty: rem, packaging_cost: packCost, materials_cost: cancel ? 0 : matCost, unit_cost: unitCost, confirmed_by: u.name, confirmed_at: now,
      note: (strv(r.note) + (strv(data.note) ? (strv(r.note) ? ' | ' : '') + strv(data.note).slice(0, 200) : '')).slice(0, 500)
    });
    const by = (u.role === 'manager' ? 'manajer ' : 'pemilik ') + u.name, st = 'dimulai ' + strv(r.started_by || r.user) + ' ' + wib(r.started_at || r.repack_time);
    const rtxt = r.from_name + ' ' + fmtN(r.from_qty) + ' ' + strv(r.from_unit) + ' → ' + r.to_name + ' x' + fmtN(r.to_qty) + ' (hasil ' + r.yield_pct + '%, susut ' + fmtN(r.loss_qty) + ' ' + strv(r.from_unit) + ')';
    const txt = cancel
      ? 'Kemas ulang DIBATALKAN oleh ' + by + ' (' + r.repack_id + ', ' + st + '): ' + r.from_name + ' ' + fmtN(F) + ' ' + strv(r.from_unit) + ' kembali ke stok curah, tidak ada ' + r.to_name + ' yang dibuat.'
      : 'Kemas ulang selesai, dikonfirmasi ' + by + ' (' + r.repack_id + ', ' + st + '): ' + rtxt + ' — rencana ' + fmtN(r.planned_qty) + ', jadi ' + fmtN(made) +
        (rem > 0 ? '; sisa curah ' + fmtN(rem) + ' ' + strv(r.from_unit) + ' kembali ke stok' : '') + (made < num(r.planned_qty) ? ' — KURANG ' + fmtN(r3(num(r.planned_qty) - made)) + ' dari rencana' : '');
    X.logAct(db, u, 'kemas_ulang', txt, r.repack_id, 0, cancel || yieldPct < 95 || made < num(r.planned_qty) ? 'warn' : 'info');
    X.notify(db, u, ['owner', 'manager', 'akuntan'].filter(x => x !== u.role), txt, cancel || yieldPct < 95 ? 'warn' : 'info');
    return { repack: out(r, u.role), stock };
  }

  window.KRepackMock = { catalog, catalogOut, costsOf, costPer, matsIn, costsText, productCosts, out, openList, materials, start, finish };
})();
