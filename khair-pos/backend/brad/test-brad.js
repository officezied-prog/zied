// node test-brad.js — Khair Order Brad core (v60): roles, the order read by rules / an AI answer, the 9 steps, the cooler's
// hours (16:00, 17:00 overtime per started hour, Sunday by arrangement, holidays), the car (+20 %), door, loading
// (30 min a pallet), the goods out of the gudang ledger at departure, the WhatsApp texts and the pasted-reply reader.
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const src = [['cold', 'cold-parsers.js'], ['cold', 'cold-core.js'], ['brad', 'brad-core.js']].map(f => fs.readFileSync(path.join(__dirname, '..', ...f), 'utf8')).join('\n');
const { KBrad } = new Function(src + '\nreturn { KBrad };')();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const ph = (n, pin) => sha('demo:' + n.toLowerCase() + ':' + pin);
const IN = (seq, pc, wh, n) => ({ id: 500 + seq, seq, move_date: '2026-10-01', at: '2026-10-01T02:00:00Z', type: 'IN', pallet_code: pc, warehouse: wh, cartons: n, ref_seq: 0, grp: seq, order_no: '', reason: '', by_user: 'x' });
const T = {
  users: [{ id: 1, name: 'Pemilik', role: 'owner', pin_hash: ph('Pemilik', '1234'), active: true }, { id: 2, name: 'Jihan', role: 'manager', pin_hash: ph('Jihan', '2222'), active: true },
    { id: 3, name: 'Akun', role: 'akuntan', pin_hash: ph('Akun', '3333'), active: true }, { id: 4, name: 'Siti', role: 'kasir', pin_hash: ph('Siti', '1111'), active: true }],
  settings: { store_name: 'Khair Mart', cold_company: 'PT. SAIDA REZEKI ABADI' },
  warehouses: [{ id: 1, code: 'DPP', name: 'DPP Cold Storage', address: 'Jakarta Utara', pic_wa: '6281211112222', active: true }, { id: 2, code: 'BOSKO', name: 'Bosko', address: 'Bekasi', active: true }],
  products: [{ id: 1, code: 'SUKARI-3', name: 'Kurma Sukari 3kg', kg_per_ctn: 3, aliases: 'sukari', active: true }, { id: 2, code: 'AJWA-5', name: 'Kurma Ajwa 5kg', kg_per_ctn: 5, aliases: 'ajwa', active: true }],
  pallets: [{ id: 11, pallet_code: 'S-1001', product: 'SUKARI-3', exp_date: '2027-01-01', lot: 'L1' }, { id: 12, pallet_code: 'S-1002', product: 'SUKARI-3', exp_date: '2026-12-01', lot: 'L2' },
    { id: 13, pallet_code: 'A-2001', product: 'AJWA-5', exp_date: '2027-02-01', lot: 'L3' }, { id: 14, pallet_code: 'B-3001', product: 'SUKARI-3', exp_date: '2027-03-01', lot: 'L4' }],
  movements: [IN(1, 'S-1001', 'DPP', 100), IN(2, 'S-1002', 'DPP', 50), IN(3, 'A-2001', 'DPP', 121), IN(4, 'B-3001', 'BOSKO', 80)],
  cold_orders: [{ id: 70, order_no: 'SPB-261010-001', status: 'open', warehouse: 'DPP', lines: JSON.stringify([{ pallet_code: 'S-1001', cartons: 10 }]) }], // the gudang app's open order
  customers: [{ id: 50, name: 'Toko Zahra', phone: '6281300000099', address: 'Jl. Melati 9' }],
  orders: [],
};
let nid = 1000, NOW = '2026-10-14T03:00:00Z'; // Wednesday 10:00 WIB
const WHO = { owner: ['Pemilik', '1234'], manager: ['Jihan', '2222'], akuntan: ['Akun', '3333'], kasir: ['Siti', '1111'] };
function call(action, data, who = 'manager') {
  const [user, pin] = WHO[who];
  const res = KBrad.core(JSON.parse(JSON.stringify(T)), { action, user, pin_hash: ph(user, pin), data: data || {} }, NOW);
  res.writes.forEach(w => {
    if (w.table === 'settings') { T.settings[w.row.skey] = JSON.parse(w.row.svalue); return; }
    assert(['orders', 'movements'].includes(w.table), 'writes only its orders and the goods out: ' + w.table);
    const row = JSON.parse(JSON.stringify(w.row));
    if (row.id === undefined) { row.id = nid++; T[w.table].push(row); } else { const i = T[w.table].findIndex(x => x.id === row.id); assert(i >= 0); T[w.table][i] = row; }
  });
  return res.response;
}
const ok = r => { assert(r.ok, JSON.stringify(r)); return r; };
const err = (r, c) => { assert.strictEqual(r.ok, false, JSON.stringify(r)); assert.strictEqual(r.error, c, JSON.stringify(r)); return r; };
const free = (pc) => ok(call('bootstrap')).stock.find(r => r.pallet_code === pc).free;
const mk = (extra) => ok(call('order_save', Object.assign({ warehouse: 'DPP', dest_type: 'pelanggan', dest_name: 'Toko Zahra', customer_id: 50, dest_phone: '081300000099', lines: [{ pallet_code: 'A-2001', cartons: 5 }] }, extra))).order;

// ---------- who may do what ----------
err(call('login', {}, 'kasir'), 'FORBIDDEN');
assert.strictEqual(ok(call('login', {}, 'akuntan')).me.role, 'akuntan');
err(call('order_save', { warehouse: 'DPP' }, 'akuntan'), 'FORBIDDEN');
err(call('cooler_save', { code: 'DPP', wa: '0812' }, 'manager'), 'FORBIDDEN');
// ---------- bootstrap: the coolers (WhatsApp from the gudang app unless set here), the owner's hours, the stock less what is held ----------
const B = ok(call('bootstrap'));
assert.deepStrictEqual(B.coolers.map(c => [c.code, c.wa, c.hours.last, c.hours.close]), [['DPP', '6281211112222', '16:00', '17:00'], ['BOSKO', '', '16:00', '17:00']]);
assert.deepStrictEqual([B.eta_margin, B.load_min], [20, 30]);
assert.strictEqual(free('S-1001'), 90); // 10 held by the gudang app's open order
// ---------- the order from a pasted message (no AI): FEFO, the registry customer, "besok" ----------
const rd = ok(call('order_read', { text: 'Selamat pagi\nKirim ke Toko Zahra besok\nSukari 60 ctn\nMangga 2 ctn' })).draft;
assert.deepStrictEqual([rd.warehouse, rd.order_date, rd.dest_name, rd.customer_id], ['DPP', '2026-10-15', 'Toko Zahra', 50]);
assert.deepStrictEqual(rd.lines.map(l => [l.pallet_code, l.cartons]), [['S-1002', 50], ['S-1001', 10]]); // oldest expiry first
assert.deepStrictEqual(rd.unmatched, [{ line: 'Mangga 2 ctn', reason: 'unknown' }]);
// an AI answer (the Worker's pass 2): the written pallet, whole when no quantity
const pre = ok(call('order_read', { has_image: true, ai_on: true }));
assert.strictEqual(pre.need_ai, true); assert.match(pre.prompt.catalog, /A-2001 \| AJWA-5 \| DPP \| 121/);
const ai = ok(call('order_read', { has_image: true, _ai: { model: 'claude-haiku-5-5', text: JSON.stringify({ items: [{ pallet: 'A-2001', qty: 0 }] }) } }));
assert.deepStrictEqual([ai.read_by, ai.draft.lines[0].cartons], ['claude-haiku-5-5', 121]);
err(call('order_read', { has_image: true }), 'AI_OFF');
// ---------- step 1: the order is written ----------
err(call('order_save', { warehouse: 'DPP', lines: [{ pallet_code: 'S-1001', cartons: 91 }] }), 'NOT_ENOUGH'); // 90 free
err(call('order_save', { warehouse: 'DPP', order_date: '2026-10-13', lines: [{ pallet_code: 'S-1001', cartons: 1 }] }), 'INVALID'); // the past
const o1 = ok(call('order_save', { warehouse: 'DPP', order_date: rd.order_date, dest_type: rd.dest_type, dest_name: rd.dest_name, customer_id: rd.customer_id, dest_phone: rd.dest_phone,
  dest_address: rd.dest_address, source: 'message', read_by: 'rules', lines: rd.lines.map(l => ({ pallet_code: l.pallet_code, cartons: l.cartons })) })).order;
assert.deepStrictEqual([o1.order_no, o1.status, o1.step, o1.customer_id, o1.pallets, o1.cartons], ['BRD-261014-001', 'new', 1, 50, 2, 60]);
assert.match(o1.log[0].note, /Dibaca dari pesan \(rules\)/);
assert.strictEqual(free('S-1001'), 80); // held by this order now
// the text for the cold store: quantity, product, pallet, product code
const C = { cooler: B.coolers[0], products: { 'SUKARI-3': { name: 'Kurma Sukari 3kg' } }, company: B.company };
const m1 = KBrad.msgOrder(o1, C);
assert.match(m1, /^\*ORDER AMBIL — Khair Mart\*\nNo: BRD-261014-001\nTanggal ambil: Kamis, 15 Oktober 2026\nGudang: DPP Cold Storage\nTujuan: Toko Zahra \(pelanggan\)/);
assert.match(m1, /1\. 50 ctn · Kurma Sukari 3kg · Palet S-1002 \(utuh\) · Kode SUKARI-3\n2\. 10 ctn · Kurma Sukari 3kg · Palet S-1001 · Kode SUKARI-3\nTotal: 60 ctn · 2 palet/);
// ---------- steps 2–4: sent, agreed, ready (a rejected order is changed and sent again) ----------
err(call('order_status', { order_no: o1.order_no, to: 'ready' }), 'INVALID'); // not yet
ok(call('order_status', { order_no: o1.order_no, to: 'sent' }));
err(call('order_status', { order_no: o1.order_no, to: 'rejected', note: '' }), 'INVALID'); // a reason
ok(call('order_status', { order_no: o1.order_no, to: 'rejected', note: 'Palet S-1001 belum turun' }));
err(call('order_save', { order_no: o1.order_no, warehouse: 'BOSKO', lines: [{ pallet_code: 'B-3001', cartons: 1 }] }), 'INVALID'); // not another cooler
const o1b = ok(call('order_save', { order_no: o1.order_no, warehouse: 'DPP', order_date: '2026-10-15', dest_type: 'pelanggan', dest_name: 'Toko Zahra', customer_id: 50, lines: [{ pallet_code: 'S-1002', cartons: 50 }, { pallet_code: 'A-2001', cartons: 20 }] })).order;
assert.deepStrictEqual([o1b.status, o1b.log[o1b.log.length - 1].note], ['new', 'Diubah setelah ditolak']);
for (const to of ['sent', 'approved', 'ready']) ok(call('order_status', { order_no: o1.order_no, to }));
// ---------- after 16:00: a same-day pickup asks first (tomorrow 09:00, or today with the overtime risk) ----------
NOW = '2026-10-14T09:20:00Z'; // 16:20 WIB
const a = mk({ order_date: '2026-10-14' }), b = mk({ order_date: '2026-10-14' });
const ah = err(call('order_status', { order_no: a.order_no, to: 'sent' }), 'AFTER_HOURS');
assert.deepStrictEqual([ah.last, ah.close, ah.ot, ah.next], ['16:00', '17:00', 300000, '2026-10-15']);
assert.strictEqual(ok(call('order_status', { order_no: a.order_no, to: 'sent', when: 'later' })).order.order_date, '2026-10-15');
const bs = ok(call('order_status', { order_no: b.order_no, to: 'sent', when: 'overtime' })).order;
assert.deepStrictEqual([bs.order_date, bs.log[bs.log.length - 1].note], ['2026-10-14', 'Hari ini, risiko lembur disetujui']);
// ---------- step 5: the car — Lalamove's 40 min + 20 % from 16:20 = 17:08 → asked first; cancelled → book again ----------
ok(call('order_status', { order_no: b.order_no, to: 'approved' })); ok(call('order_status', { order_no: b.order_no, to: 'ready' }));
err(call('car_save', { order_no: b.order_no, driver: 'Pak Budi', plate: '' }), 'INVALID');
const lc = err(call('car_save', { order_no: b.order_no, via: 'lalamove', vehicle: 'Engkel (CDE)', driver: 'Pak Budi', plate: 'b 1234 xyz', driver_wa: '0812 9999 0000', eta_min: 40 }), 'LATE_CAR');
assert.deepStrictEqual([lc.eta_at, lc.ot_hours, lc.ot_cost], ['2026-10-14T10:08:00.000Z', 1, 300000]);
const c1 = ok(call('car_save', { order_no: b.order_no, via: 'lalamove', vehicle: 'Engkel (CDE)', driver: 'Pak Budi', plate: 'b 1234 xyz', driver_wa: '0812 9999 0000', eta_min: 40, accept_ot: true })).order;
assert.deepStrictEqual([c1.status, c1.step, c1.car.plate, c1.car.driver_wa, c1.eta_at], ['car', 5, 'B 1234 XYZ', '6281299990000', '2026-10-14T10:08:00.000Z']);
assert.strictEqual(KBrad.msgCar(c1, C), 'Order ' + b.order_no + ' — mobil untuk ambil di DPP Cold Storage:\nKendaraan: Engkel (CDE)\nNo. polisi: B 1234 XYZ\nSopir: Pak Budi (081299990000)\nPerkiraan tiba: 17:08\nTerima kasih.');
err(call('car_cancel', { order_no: b.order_no, reason: '' }), 'INVALID');
const cx = ok(call('car_cancel', { order_no: b.order_no, reason: 'Sopir batal' }));
assert.deepStrictEqual([cx.order.status, cx.order.car, cx.order.car_cancels, cx.risk], ['ready', null, 1, true]);
ok(call('car_save', { order_no: b.order_no, via: 'lalamove', driver: 'Pak Andi', plate: 'B 2 CD', driver_wa: '081277776666', eta_min: 30, accept_ot: true }));
// ---------- steps 6–7: in at 17:10 = one full hour (Rp 300.000), its cause required; the door ----------
NOW = '2026-10-14T10:15:00Z'; // 17:15 WIB
err(call('order_arrived', { order_no: b.order_no, time: '17:20' }), 'INVALID'); // not yet
const cz = err(call('order_arrived', { order_no: b.order_no, time: '17:10' }), 'CAUSE');
assert.deepStrictEqual([cz.ot_hours, cz.ot_cost], [1, 300000]);
const ar = ok(call('order_arrived', { order_no: b.order_no, time: '17:10', cause: 'car_cancel', note: 'Mobil pertama batal' })).order;
assert.deepStrictEqual([ar.status, ar.ot_hours, ar.ot_cost, ar.ot_cause, ar.arrived_at], ['arrived', 1, 300000, 'car_cancel', '2026-10-14T10:10:00.000Z']);
err(call('door_save', { order_no: b.order_no, door: '' }), 'INVALID');
const dr = ok(call('door_save', { order_no: b.order_no, door: '12' })).order;
assert.deepStrictEqual([dr.status, dr.step, dr.door], ['door', 7, '12']);
assert.strictEqual(KBrad.msgDoor(dr, C), 'Halo Pak Andi, order ' + b.order_no + ':\nsilakan masuk ke DPP Cold Storage (Jakarta Utara) — *PINTU 12*.\nMuat 1 palet · 5 ctn untuk Toko Zahra.\nTerima kasih.');
// ---------- step 8: loading, about 30 minutes a pallet ----------
const ld = ok(call('load_start', { order_no: b.order_no })).order;
assert.deepStrictEqual([ld.status, ld.load_end_est], ['loading', '2026-10-14T10:45:00.000Z']);
// ---------- step 9: the car leaves — the goods go out of the gudang stock (a shortage is said, never blocks) ----------
const before = T.movements.length;
const dp = ok(call('depart', { order_no: b.order_no }));
assert.deepStrictEqual([dp.order.status, dp.order.step, dp.short], ['departed', 9, []]);
const out = T.movements.slice(before);
assert.deepStrictEqual(out.map(m => [m.type, m.pallet_code, m.warehouse, m.cartons, m.order_no, m.by_user]), [['OUT', 'A-2001', 'DPP', -5, b.order_no, 'Jihan']]);
assert.match(out[0].reason, /Ambil ke Toko Zahra \(Order Brad\)/);
assert.strictEqual(ok(call('bootstrap')).stock.find(r => r.pallet_code === 'A-2001').cartons, 116);
assert.match(KBrad.msgDepart(dp.order, C), /^Halo Toko Zahra, pesanan BRD-261014-\d{3} \(5 ctn\) sudah berangkat dari DPP Cold Storage jam 17:15\.\nMobil: B 2 CD · Sopir Pak Andi \(081277776666\)\nTerima kasih — Khair Mart$/);
ok(call('order_status', { order_no: b.order_no, to: 'delivered' }));
err(call('order_status', { order_no: b.order_no, to: 'cancelled', note: 'salah' }), 'INVALID'); // gone
// a shortage at the departure (the stock changed since): what there is goes out, the rest is said
const sh = mk({ order_date: '2026-10-15', lines: [{ pallet_code: 'S-1001', cartons: 30 }] });
NOW = '2026-10-15T02:00:00Z'; // Thursday 09:00
for (const to of ['sent', 'approved', 'ready']) ok(call('order_status', { order_no: sh.order_no, to }));
ok(call('car_save', { order_no: sh.order_no, driver: 'Pak C', plate: 'B 3 EF' })); ok(call('order_arrived', { order_no: sh.order_no, time: '08:55', door: '4' }));
T.movements.push(Object.assign(IN(99, 'S-1001', 'DPP', -80), { id: 999, type: 'ADJUST' })); // the gudang app took 80 out meanwhile
const ds = ok(call('depart', { order_no: sh.order_no }));
assert.deepStrictEqual(ds.short, ['S-1001 (stok 20, order 30)']);
assert.strictEqual(T.movements[T.movements.length - 1].cartons, -20);
// ---------- Sunday: only with the agreed extra cost; a public holiday is closed ----------
const su = mk({ order_date: '2026-10-18', lines: [{ pallet_code: 'A-2001', cartons: 1 }] });
const arr = err(call('order_status', { order_no: su.order_no, to: 'sent' }), 'ARRANGE');
assert.strictEqual(arr.next, '2026-10-19');
const sus = ok(call('order_status', { order_no: su.order_no, to: 'sent', extra_cost: 350000, extra_note: 'Buka Minggu' })).order;
assert.deepStrictEqual([sus.extra_cost, sus.extra_note], [350000, 'Buka Minggu']);
assert.match(KBrad.msgOrder(sus, C), /Hari perjanjian: biaya tambahan Rp 350\.000 \(Buka Minggu\)/);
err(call('settings_save', { holidays: [{ date: '2026-10-20', name: 'Libur X' }] }, 'manager'), 'FORBIDDEN');
ok(call('settings_save', { holidays: [{ date: '2026-10-20', name: 'Libur X' }], eta_margin: 15, load_min: 25 }, 'owner'));
assert.deepStrictEqual([T.settings.brad_eta_margin, T.settings.brad_load_min], [15, 25]);
const cl = err(call('order_save', { warehouse: 'DPP', order_date: '2026-10-20', lines: [{ pallet_code: 'A-2001', cartons: 1 }] }), 'CLOSED');
assert.strictEqual(cl.next, '2026-10-21'); assert.match(cl.message, /Libur X/);
// a cooler's own hours and WhatsApp (owner)
err(call('cooler_save', { code: 'BOSKO', hours: { open: '09:00', close: '15:00', last: '16:00', days: [1] } }, 'owner'), 'INVALID');
ok(call('cooler_save', { code: 'BOSKO', wa: '0813 5555 6666', hours: { open: '08:00', close: '16:00', brk: '', last: '15:00', days: [1, 2, 3, 4, 5], arrange: [6], ot: 250000 } }, 'owner'));
const bo = ok(call('bootstrap')).coolers.find(c => c.code === 'BOSKO');
assert.deepStrictEqual([bo.wa, bo.wa_own, bo.hours.last, bo.hours.brk, bo.hours.arrange, bo.hours.ot], ['6281355556666', true, '15:00', '', [6], 250000]);
// ---------- cancel; the month's overtime ----------
const cn = mk({ order_date: '2026-10-15' });
err(call('order_status', { order_no: cn.order_no, to: 'cancelled', note: '' }), 'INVALID');
assert.strictEqual(ok(call('order_status', { order_no: cn.order_no, to: 'cancelled', note: 'Pelanggan batal' })).order.status, 'cancelled');
const ot = ok(call('bootstrap')).overtime;
assert.deepStrictEqual([ot.count, ot.hours, ot.cost, ot.by_cause.car_cancel, ot.n_extra, ot.extra], [1, 1, 300000, 300000, 1, 350000]);
// ---------- the home page's warnings (computed on the device from the same rules) ----------
const W = ok(call('bootstrap')), cfg = { DPP: {} };
const al = (iso, o) => KBrad.timeAlerts([o], cfg, iso, []).map(x => x.kind);
const today = { order_no: 'X', warehouse: 'DPP', order_date: '2026-10-14', status: 'ready' };
assert.deepStrictEqual([al('2026-10-14T08:00:00Z', today), al('2026-10-14T08:35:00Z', today), al('2026-10-14T10:05:00Z', today)], [[], ['no_car'], ['overtime']]);
assert.deepStrictEqual(al('2026-10-14T07:00:00Z', Object.assign({}, today, { status: 'car', eta_at: '2026-10-14T06:30:00Z' })), ['car_late']);
assert(W.orders.length >= 5);
// ---------- the cold store's reply, pasted ----------
assert.deepStrictEqual(['Ok pak siap', 'Pak, mobil masuk pintu 12 ya', 'Maaf stok habis', 'Barang sudah siap diambil', 'Terima kasih', 'door no. 7B'].map(s => KBrad.readReply(s)),
  [{ kind: 'approve', door: '' }, { kind: 'door', door: '12' }, { kind: 'reject', door: '' }, { kind: 'ready', door: '' }, { kind: '', door: '' }, { kind: 'door', door: '7B' }]);
// ---------- v61 stage 2: automatic WhatsApp — the template messages of each step; the cold store's buttons and replies ----------
{
  NOW = '2026-10-15T03:00:00Z'; // Thursday 10:00 WIB
  T.wa_log = [];
  const waIn = (ev) => { // like the Worker's webhook: the event through waEvent, its writes kept
    const r = KBrad.waEvent(JSON.parse(JSON.stringify(T)), ev, NOW);
    r.writes.forEach(w => { const row = JSON.parse(JSON.stringify(w.row));
      if (w.table === 'log') { row.id = nid++; T.wa_log.push(row); return; }
      assert.strictEqual(w.table, 'orders'); const i = T.orders.findIndex(x => x.id === row.id); T.orders[i] = row; });
    return r.response;
  };
  const st = no => T.orders.find(x => x.order_no === no).status;
  const o = mk({ order_date: '2026-10-15', lines: [{ pallet_code: 'A-2001', cartons: 3 }] }), no = o.order_no;
  // step 2: the order to the cold store — one line per value, buttons carrying the order number
  const s2 = ok(call('order_status', { order_no: no, to: 'sent' }));
  assert.strictEqual(s2.wa.length, 1);
  const m = s2.wa[0];
  assert.deepStrictEqual([m.kind, m.to, m.template, m.lang, m.order_no], ['order', '6281211112222', 'khair_order_brad', 'id', no]);
  assert.deepStrictEqual(m.payloads, ['BRD|APPROVE|' + no, 'BRD|REJECT|' + no, 'BRD|READY|' + no]);
  assert.deepStrictEqual(m.params, [no, 'Kamis, 15 Oktober 2026', 'DPP Cold Storage', 'Toko Zahra (pelanggan)', '3 ctn Kurma Ajwa 5kg, palet A-2001, kode AJWA-5', '3 ctn, 1 palet']);
  // a tap from another number is shown, never applied; the cold store's own tap is
  let r = waIn({ id: 'wamid.x1', from: '6289999999999', type: 'button', payload: 'BRD|APPROVE|' + no, text: 'Setuju' });
  assert.deepStrictEqual([r.applied, r.note, st(no)], ['', 'not_cooler', 'sent']);
  r = waIn({ id: 'wamid.x2', from: '081211112222', type: 'button', payload: 'BRD|APPROVE|' + no, text: 'Setuju' });
  assert.deepStrictEqual([r.applied, st(no)], ['approved', 'approved']);
  assert.strictEqual(JSON.parse(T.orders.find(x => x.order_no === no).log).pop().by, 'WhatsApp DPP Cold Storage');
  r = waIn({ id: 'wamid.x3', from: '6281211112222', type: 'button', payload: 'BRD|APPROVE|' + no, text: 'Setuju' });
  assert.deepStrictEqual([r.applied, r.note], ['', 'not_now']); // already agreed
  r = waIn({ id: 'wamid.x4', from: '6281211112222', type: 'button', payload: 'BRD|READY|' + no, text: 'Barang siap' });
  assert.deepStrictEqual([r.applied, st(no)], ['ready', 'ready']);
  // step 5: the car to the cold store, with the "Mobil sudah masuk" button
  const c5 = ok(call('car_save', { order_no: no, driver: 'Pak Andi', plate: 'B 7 XY', driver_wa: '081277776666', vehicle: 'Pickup (bak)', eta_min: 20 }));
  assert.deepStrictEqual([c5.wa[0].kind, c5.wa[0].template, c5.wa[0].payloads, c5.wa[0].params], ['car', 'khair_mobil_brad', ['BRD|IN|' + no],
    [no, 'DPP Cold Storage', 'Pickup (bak)', 'B 7 XY', 'Pak Andi (081277776666)', '10:23']]); // 20 min + the owner's 15 % (set above)
  // the cold store replies to that message "pintu 7": the car is in, at door 7 — and the door goes on to the driver by itself
  NOW = '2026-10-15T03:30:00Z';
  r = waIn({ id: 'wamid.x5', from: '6281211112222', type: 'text', text: 'Sudah masuk pak, pintu 7', ctx_order_no: no });
  assert.deepStrictEqual([r.applied, st(no)], ['door', 'door']);
  const od = T.orders.find(x => x.order_no === no);
  assert.deepStrictEqual([od.door, od.arrived_at, od.ot_hours], ['7', '2026-10-15T03:30:00Z', 0]);
  assert.deepStrictEqual([r.wa[0].kind, r.wa[0].to, r.wa[0].template, r.wa[0].params], ['door', '6281277776666', 'khair_pintu_brad', ['Pak Andi', no, 'DPP Cold Storage', 'Jakarta Utara', '7', '1 palet, 3 ctn', 'Toko Zahra']]);
  // a reply that quotes nothing goes to that cold store's only waiting order; with two waiting it stays unassigned
  T.orders.filter(x => x.warehouse === 'DPP' && ['sent', 'approved', 'car', 'arrived'].includes(x.status)).forEach(x => ok(call('order_status', { order_no: x.order_no, to: 'cancelled', note: 'uji WhatsApp' })));
  const p1 = mk({ order_date: '2026-10-15', lines: [{ pallet_code: 'A-2001', cartons: 1 }] }); ok(call('order_status', { order_no: p1.order_no, to: 'sent' }));
  r = waIn({ id: 'wamid.x6', from: '6281211112222', type: 'text', text: 'ok siap' });
  assert.deepStrictEqual([r.order_no, r.applied], [p1.order_no, 'approved']); // (the door order is not waiting for an answer)
  const p2 = mk({ order_date: '2026-10-15', lines: [{ pallet_code: 'A-2001', cartons: 1 }] }); ok(call('order_status', { order_no: p2.order_no, to: 'sent' }));
  const p3 = mk({ order_date: '2026-10-15', lines: [{ pallet_code: 'A-2001', cartons: 1 }] }); ok(call('order_status', { order_no: p3.order_no, to: 'sent' }));
  r = waIn({ id: 'wamid.x7', from: '6281211112222', type: 'text', text: 'ok' });
  assert.deepStrictEqual([r.order_no, r.applied], ['', '']);
  r = waIn({ id: 'wamid.x8', from: '6281211112222', type: 'button', payload: 'BRD|REJECT|' + p2.order_no, text: 'Tolak' });
  assert.deepStrictEqual([r.applied, st(p2.order_no)], ['rejected', 'rejected']);
  assert.match(T.orders.find(x => x.order_no === p2.order_no).rejected_reason, /Lewat WhatsApp: Tolak/);
  // "Mobil sudah masuk" after 17:00: not entered by WhatsApp (the overtime's cause is chosen in the app)
  ok(call('order_status', { order_no: p3.order_no, to: 'approved' })); ok(call('order_status', { order_no: p3.order_no, to: 'ready' }));
  ok(call('car_save', { order_no: p3.order_no, driver: 'Pak C', plate: 'B 3 EF' }));
  NOW = '2026-10-15T10:10:00Z'; // 17:10
  r = waIn({ id: 'wamid.x9', from: '6281211112222', type: 'button', payload: 'BRD|IN|' + p3.order_no, text: 'Mobil sudah masuk' });
  assert.deepStrictEqual([r.applied, r.note, st(p3.order_no)], ['', 'after_close', 'car']);
  // every incoming message is logged (shown on its order)
  assert.deepStrictEqual(T.wa_log.map(x => [x.dir, x.applied]).slice(0, 3), [['in', 'not_cooler'], ['in', 'approved'], ['in', 'not_now']]);
  // the departure goes to the customer; a shop order sends nothing
  NOW = '2026-10-15T04:00:00Z';
  ok(call('load_start', { order_no: no }));
  const dpt = ok(call('depart', { order_no: no }));
  assert.deepStrictEqual([dpt.wa[0].kind, dpt.wa[0].to, dpt.wa[0].template, dpt.wa[0].params[7]], ['depart', '6281300000099', 'khair_berangkat_brad', 'Khair Mart']);
  // the owner: the templates to register (Indonesian, UTILITY; quick replies on the order and the car); a test message
  err(call('wa_admin', { op: 'templates' }, 'manager'), 'FORBIDDEN');
  assert.strictEqual(ok(call('wa_admin', { op: 'status' }, 'manager')).names.length, 4);
  const defs = ok(call('wa_admin', { op: 'templates' }, 'owner')).defs;
  assert.deepStrictEqual(defs.map(d => [d.name, d.language, d.category, (d.components[1] || { buttons: [] }).buttons.length]),
    [['khair_order_brad', 'id', 'UTILITY', 3], ['khair_mobil_brad', 'id', 'UTILITY', 1], ['khair_pintu_brad', 'id', 'UTILITY', 0], ['khair_berangkat_brad', 'id', 'UTILITY', 0]]);
  defs.forEach(d => { const b = d.components[0], n = (b.text.match(/\{\{\d+\}\}/g) || []).length;
    assert.strictEqual(b.example.body_text[0].length, n, d.name); assert(!/^\{\{/.test(b.text) && !/\}\}$/.test(b.text.trim()), d.name + ' starts/ends with a variable');
    (d.components[1] || { buttons: [] }).buttons.forEach(x => assert(x.text.length <= 20, x.text)); });
  err(call('wa_admin', { op: 'test', to: '12' }, 'owner'), 'INVALID');
  assert.strictEqual(ok(call('wa_admin', { op: 'test', to: '0812 1111 0000' }, 'owner')).wa[0].to, '6281211110000');
  // the month's cap (owner) and the light poll's stamp
  ok(call('settings_save', { wa_cap: 500 }, 'owner'));
  assert.strictEqual(ok(call('bootstrap')).wa_cap, 500);
  const stamp = ok(call('poll', {}, 'akuntan')).stamp;
  assert.strictEqual(stamp, KBrad.stampOf(T.orders, T.wa_log));
  assert(stamp >= '2026-10-15T10:10:00Z');
  ok(call('order_status', { order_no: p3.order_no, to: 'cancelled', note: 'uji stamp' })); // a change in the same second still shows
  assert.notStrictEqual(ok(call('poll', {}, 'akuntan')).stamp, stamp);
}
// ---------- v62: the car the customer booked himself — his message read by fixed rules; kept with the trip; the link to the cold store ----------
{
  const P = KBrad.parseCarMsg, none = { driver: '', plate: '', phone: '', link: '', vehicle: '', eta_min: null };
  const LINK = 'https://share.lalamove.com/?ID100221014123456&lang=id_ID';
  // a customer's own words, all on one line
  assert.deepStrictEqual(P('Driver: Budi Santoso, B 1234 XYZ, 0812-3456-7890, Grand Max, sampai 25 menit, ' + LINK),
    { driver: 'Budi Santoso', plate: 'B 1234 XYZ', phone: '6281234567890', link: LINK, vehicle: 'Grand Max', eta_min: 25 });
  // Lalamove's share text (the full stop after the link is not part of it)
  assert.deepStrictEqual(P('Pesanan Lalamove saya sedang dalam perjalanan.\nPengemudi Anda: Ahmad Fauzi\nPlat: D 5678 AB\nNo. HP: +62 813-1111-2222\nKendaraan: L300 Pick Up\nEstimasi tiba dalam 20 min\nLacak pesanan: https://share.lalamove.com/?ID=987654&lang=id_ID.'),
    { driver: 'Ahmad Fauzi', plate: 'D 5678 AB', phone: '6281311112222', link: 'https://share.lalamove.com/?ID=987654&lang=id_ID', vehicle: 'L300 pickup', eta_min: 20 });
  assert.deepStrictEqual(P('Assalamualaikum pak, mobilnya sudah saya pesan ya. Sopirnya Pak Joko, nopol AB 12 C, wa 6285711112222, motor, ± 30 mnt'),
    { driver: 'Pak Joko', plate: 'AB 12 C', phone: '6285711112222', link: '', vehicle: 'Motor', eta_min: 30 });
  assert.deepStrictEqual(P('Jenis kendaraan: Mobil\nNama pengemudi : SUPRIYADI\nTNKB: B-2345-UVW\nKontak: 0857 1234 5678'),
    { driver: 'SUPRIYADI', plate: 'B 2345 UVW', phone: '6285712345678', link: '', vehicle: 'Mobil', eta_min: null });
  assert.deepStrictEqual(P('Your driver: Rudi, License plate: F 1 XY, Blind Van, ETA 15-20 mins'), { driver: 'Rudi', plate: 'F 1 XY', phone: '', link: '', vehicle: 'Blind van', eta_min: 20 }); // a range: its upper end
  assert.deepStrictEqual(P('Sopir pak Dedi (0813 9999 8888) mobil cdd box, b1234tuv, kira2 40-50 menit sampai'), { driver: 'pak Dedi', plate: 'B 1234 TUV', phone: '6281399998888', link: '', vehicle: 'CDD', eta_min: 50 });
  assert.deepStrictEqual(P('No. kendaraan B 9 ABC, engkel, 1 jam 10 menit'), Object.assign({}, none, { plate: 'B 9 ABC', vehicle: 'Engkel (CDE)', eta_min: 70 }));
  assert.deepStrictEqual(P('Driver: Budi, plat B 1234 ya, sampai dalam 1,5 jam'), Object.assign({}, none, { driver: 'Budi', plate: 'B 1234', eta_min: 90 })); // after its label a plate may lack its letters
  // what was read leaves the text: the plate is not part of the name, the minutes are not part of the phone
  assert.deepStrictEqual(P('Driver: Budi Santoso B 1234 XYZ'), Object.assign({}, none, { driver: 'Budi Santoso', plate: 'B 1234 XYZ' }));
  assert.deepStrictEqual(P('Driver Andi 0812 345 678 25 menit'), Object.assign({}, none, { driver: 'Andi', phone: '62812345678', eta_min: 25 }));
  // not plates: a car model, an address; "mobil" alone is any car; "driver sudah otw" names nobody; "buka 24 jam" is not the trip
  assert.deepStrictEqual(P('Kendaraan L300 B 1234 XYZ driver sudah otw'), Object.assign({}, none, { plate: 'B 1234 XYZ', vehicle: 'L300' }));
  assert.deepStrictEqual(P('Alamat Jl. Melati RT 05 RW 03 no 12 ya, Blok B 12 A, pakai L300'), Object.assign({}, none, { vehicle: 'L300' }));
  assert.deepStrictEqual(P('mobil sudah dipesan, sopir lalamove sudah jalan, 15mnt, buka 24 jam'), Object.assign({}, none, { eta_min: 15 }));
  // links: http(s) only, Lalamove's first, at most 300 characters
  assert.deepStrictEqual(P('lacak javascript:alert(1) atau www.lalamove.com/x ftp://a.b'), none);
  assert.strictEqual(P('peta https://maps.app.goo.gl/abc lalu https://share.lalamove.com/?ID=1').link, 'https://share.lalamove.com/?ID=1');
  assert.strictEqual(P('https://share.lalamove.com/?ID=' + '9'.repeat(300)).link, '');
  // none of it
  [null, undefined, '', 'Pak, nanti saya kabari ya. Terima kasih', 'Barang sudah siap?', 'Ok pak 👍'].forEach(s => assert.deepStrictEqual(P(s), none, String(s)));

  NOW = '2026-10-15T03:00:00Z'; // Thursday 10:00 WIB (the ETA margin is 15 % since the owner's setting above)
  const o = mk({ order_date: '2026-10-15', lines: [{ pallet_code: 'A-2001', cartons: 2 }] }), no = o.order_no;
  for (const to of ['sent', 'approved', 'ready']) ok(call('order_status', { order_no: no, to }));
  const MSG = 'Pak, mobil saya yang pesan ya.\r\nDriver: Budi Santoso, B 1234 XYZ, 0812-3456-7890, Grand Max, sampai 25 menit\n\n\n\nLacak: ' + LINK + '\u0007';
  // the driver and the plate are still required, even with the message there
  err(call('car_save', { order_no: no, via: 'pelanggan', customer_msg: MSG, driver: '', plate: '' }), 'INVALID');
  err(call('car_save', { order_no: no, via: 'pelanggan', customer_msg: MSG, driver: 'Budi Santoso', plate: '' }), 'INVALID');
  err(call('car_save', { order_no: no, via: 'pelanggan', customer_msg: MSG, driver: '', plate: 'B 1234 XYZ' }), 'INVALID');
  err(call('car_save', { order_no: no, via: 'pelanggan', driver: 'Budi', plate: 'B 1 AB', track_url: 'javascript:alert(1)' }), 'INVALID'); // a link: http(s) only
  err(call('car_save', { order_no: no, via: 'pelanggan', driver: 'Budi', plate: 'B 1 AB', track_url: 'https://x.y/' + 'a'.repeat(300) }), 'INVALID');
  const p = KBrad.parseCarMsg(MSG);
  const cp = ok(call('car_save', { order_no: no, via: 'pelanggan', customer_msg: MSG, driver: p.driver, plate: p.plate, driver_wa: p.phone, vehicle: p.vehicle, eta_min: p.eta_min, track_url: p.link })).order;
  assert.deepStrictEqual([cp.status, cp.car.via, cp.car.driver, cp.car.plate, cp.car.driver_wa, cp.car.vehicle, cp.car.cost, cp.car.eta_min, cp.car.track_url, cp.eta_at],
    ['car', 'pelanggan', 'Budi Santoso', 'B 1234 XYZ', '6281234567890', 'Grand Max', 0, 25, LINK, '2026-10-15T03:29:00.000Z']); // the customer pays: cost 0; 25 min + 15 %
  // his message as he wrote it: its lines, no control characters, at most 1000 characters
  assert.strictEqual(cp.car.customer_msg, 'Pak, mobil saya yang pesan ya.\nDriver: Budi Santoso, B 1234 XYZ, 0812-3456-7890, Grand Max, sampai 25 menit\n\nLacak: ' + LINK);
  assert.match(cp.log[cp.log.length - 1].note, /^B 1234 XYZ · Budi Santoso · dipesan pelanggan · tiba ± 10:29$/);
  // to the cold store: the car, and the tracking link (the hand-sent text) — the car template keeps its six values, without it
  assert.strictEqual(KBrad.msgCar(cp, C), 'Order ' + no + ' — mobil untuk ambil di DPP Cold Storage:\nKendaraan: Grand Max\nNo. polisi: B 1234 XYZ\nSopir: Budi Santoso (081234567890)\nPerkiraan tiba: 10:29\nLacak mobil: ' + LINK + '\nTerima kasih.');
  const wm = KBrad.waOut(T.orders.find(x => x.order_no === no), 'car', C);
  assert.deepStrictEqual(wm.params, [no, 'DPP Cold Storage', 'Grand Max', 'B 1234 XYZ', 'Budi Santoso (081234567890)', '10:29']);
  assert.strictEqual((KBrad.WA_TEMPLATES.car.body.match(/\{\{\d+\}\}/g) || []).length, wm.params.length);
  // changed: no link typed → the one in his message; a cost he left to us is kept; a long message is cut at 1000
  const cq = ok(call('car_save', { order_no: no, via: 'pelanggan', customer_msg: 'Driver: Joko, B 2 CD ' + LINK + ' ' + 'x'.repeat(1200), driver: 'Joko', plate: 'B 2 CD', cost: 150000 })).order;
  assert.deepStrictEqual([cq.car.track_url, cq.car.cost, cq.car.customer_msg.length, cq.eta_at], [LINK, 150000, 1000, '']);
  assert.match(cq.log[cq.log.length - 1].note, /^Mobil diubah: B 2 CD · Joko · dipesan pelanggan$/);
  // Lalamove / own driver: as before — no message, no link kept (even if sent), the cost as typed
  const cl = ok(call('car_save', { order_no: no, via: 'lalamove', driver: 'Pak Andi', plate: 'B 7 XY', cost: 85000, customer_msg: MSG, track_url: LINK })).order;
  assert.deepStrictEqual([cl.car.via, cl.car.cost, 'customer_msg' in cl.car, 'track_url' in cl.car], ['lalamove', 85000, false, false]);
  assert.doesNotMatch(KBrad.msgCar(cl, C), /Lacak/);
  assert.strictEqual(ok(call('car_save', { order_no: no, via: 'sopir', driver: 'Pak C', plate: 'B 3 EF' })).order.car.via, 'sopir');
  assert.strictEqual(ok(call('car_save', { order_no: no, via: 'kapal', driver: 'Pak C', plate: 'B 3 EF' })).order.car.via, 'lalamove'); // unknown → Lalamove, as before
  ok(call('order_status', { order_no: no, to: 'cancelled', note: 'uji mobil pelanggan' }));
}
// ---------- v63 stage 3: the Lalamove car booked by the server — places, the plan (hours, cap, a price that rose), Lalamove's reports ----------
{
  // where a place is: "lat,lng", Google Maps links (the pin first), a WhatsApp location, geo: — a short link only via the Worker
  const G = KBrad.geoOf, at = (lat, lng) => ({ lat, lng });
  assert.deepStrictEqual(G('-6.2088,106.8456'), at(-6.2088, 106.8456));
  assert.deepStrictEqual(G('  -6.2088 , 106.8456 '), at(-6.2088, 106.8456));
  assert.deepStrictEqual(G('https://maps.google.com/maps?q=-6.208800%2C106.845600&z=17&hl=en'), at(-6.2088, 106.8456)); // a WhatsApp location
  assert.deepStrictEqual(G('https://www.google.com/maps/place/Toko+Zahra/@-6.25,106.85,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-6.2512!4d106.8523!16s'), at(-6.2512, 106.8523));
  assert.deepStrictEqual(G('https://www.google.com/maps/@-6.1214,106.9021,15z'), at(-6.1214, 106.9021));
  assert.deepStrictEqual(G('https://www.google.com/maps/search/?api=1&query=-6.3,106.9'), at(-6.3, 106.9));
  assert.deepStrictEqual(G('https://www.google.com/maps/dir/?api=1&destination=-6.3%2C106.95'), at(-6.3, 106.95));
  assert.deepStrictEqual(G('geo:-6.2,106.8?z=19'), at(-6.2, 106.8));
  assert.deepStrictEqual(G('Lokasi kami: -6.208812, 106.845634 ya pak'), at(-6.208812, 106.845634));
  assert.deepStrictEqual(G('-6.20881234,106.84563456'), at(-6.208812, 106.845635)); // 6 decimals (≈ 10 cm)
  ['https://maps.app.goo.gl/AbCdEf123', '106.8456,-6.2088', '0,0', '12, 30', '12 ctn, 30 dus', 'Jl. Melati 9', '', null, undefined].forEach(s => assert.strictEqual(G(s), null, String(s)));
  // the vehicle proposed by the weight (+10 %): the smallest that holds it, else the biggest; unknown weight → staff choose
  const SV = [{ key: 'MOTORCYCLE', load: { value: '20', unit: 'kg' } }, { key: 'TRUCK175', load: { value: '1000', unit: 'kg' } }, { key: 'VAN', load: { value: '600', unit: 'kg' } }, { key: 'X' }];
  assert.deepStrictEqual([500, 545, 546, 900, 5000, 0].map(kg => KBrad.lalaServiceFor(SV, kg)), ['VAN', 'VAN', 'TRUCK175', 'TRUCK175', 'TRUCK175', '']);

  // the system requests come only from the Worker: never from a client (not even with __sys in its data), and they run nothing else
  const SYSRUN = (action, data) => KBrad.core(JSON.parse(JSON.stringify(T)), { __sys: 'lalamove', action, data: data || {} }, NOW), SYS = (a, d) => SYSRUN(a, d).response;
  function sys(action, data) {
    const res = SYSRUN(action, data);
    res.writes.forEach(w => {
      if (w.table === 'settings') { T.settings[w.row.skey] = JSON.parse(w.row.svalue); return; }
      assert(['orders', 'movements'].includes(w.table), 'writes only its orders and the goods out: ' + w.table);
      const row = JSON.parse(JSON.stringify(w.row));
      if (row.id === undefined) { row.id = nid++; T[w.table].push(row); } else { const i = T[w.table].findIndex(x => x.id === row.id); assert(i >= 0); T[w.table][i] = row; }
    });
    return res.response;
  }
  ['lala_booked', 'lala_sync', 'lala_cancelled', 'lala_due', 'lala_services'].forEach(a => err(call(a, { __sys: 'lalamove', items: [] }), 'FORBIDDEN'));
  err(SYS('order_save', { warehouse: 'DPP' }), 'FORBIDDEN');
  err(SYS('bootstrap'), 'FORBIDDEN');

  NOW = '2026-10-16T03:00:00Z'; // Friday 10:00 WIB (the ETA margin is the owner's 15 %)
  // the owner's settings: the month's cap, the shop's place, each cooler's place (read from a Maps link / "lat,lng")
  err(call('settings_save', { cooler_geo: { DPP: '-6.1214,106.9021' } }, 'manager'), 'FORBIDDEN');
  err(call('settings_save', { store_geo: 'Jl. Raya Condet' }, 'owner'), 'INVALID');
  err(call('settings_save', { cooler_geo: { NOPE: '-6.1,106.9' } }, 'owner'), 'NOT_FOUND');
  err(call('settings_save', { lala_cap: -1 }, 'owner'), 'INVALID');
  ok(call('settings_save', { lala_cap: 500000, store_geo: 'https://maps.google.com/?q=-6.2297,106.8679', store_address: 'Jl. Raya Condet No.4', cooler_geo: { DPP: '-6.1214, 106.9021' } }, 'owner'));
  assert.deepStrictEqual([T.settings.brad_lala_cap, T.settings.brad_store_geo], [500000, { lat: -6.2297, lng: 106.8679, address: 'Jl. Raya Condet No.4' }]);
  ok(call('cooler_save', { code: 'DPP', wa: '' }, 'owner')); // its WhatsApp / hours saved again: its place stays
  const B3 = ok(call('bootstrap'));
  const dpp = B3.coolers.find(c => c.code === 'DPP');
  assert.deepStrictEqual([dpp.lat, dpp.lng, B3.coolers.find(c => c.code === 'BOSKO').lat], [-6.1214, 106.9021, null]);
  assert.deepStrictEqual([B3.lala.cap, B3.lala.spent, B3.lala.month, B3.lala.store_geo.lat, B3.lala.pickup_min, B3.lala.services, B3.lala_due], [500000, 0, '2026-10', -6.2297, 40, [], []]);
  // an order with where the goods go (unreadable → said; empty → none; not sent when changed → kept)
  const lines = [{ pallet_code: 'A-2001', cartons: 10 }];
  err(call('order_save', { warehouse: 'DPP', order_date: '2026-10-16', dest_type: 'pelanggan', dest_name: 'Toko Zahra', dest_geo: 'di sebelah masjid', lines }), 'INVALID');
  const L1 = ok(call('order_save', { warehouse: 'DPP', order_date: '2026-10-16', dest_type: 'pelanggan', dest_name: 'Toko Zahra', customer_id: 50, dest_phone: '081300000099', dest_address: 'Jl. Melati 9',
    dest_geo: 'https://www.google.com/maps/place/Toko+Zahra/@-6.25,106.85,17z/data=!3d-6.2512!4d106.8523', lines })).order;
  assert.deepStrictEqual([L1.dest_lat, L1.dest_lng], [-6.2512, 106.8523]);
  const no = L1.order_no;
  for (const to of ['sent', 'approved', 'ready']) ok(call('order_status', { order_no: no, to }));
  // the plan: staff only; a vehicle; the cooler's place; after closing asked first; a scheduled pickup; the cap; a price that rose
  err(call('lala_plan', { order_no: no, service: 'VAN' }, 'akuntan'), 'FORBIDDEN');
  err(call('lala_plan', { order_no: no, service: '' }), 'INVALID');
  ok(call('settings_save', { cooler_geo: { DPP: '' } }, 'owner'));
  assert.match(err(call('lala_plan', { order_no: no, service: 'VAN' }), 'NO_GEO').message, /Lokasi gudang DPP Cold Storage belum diisi/);
  ok(call('settings_save', { cooler_geo: { DPP: '-6.1214,106.9021' } }, 'owner'));
  const p = ok(call('lala_plan', { order_no: no, service: 'van', eta_min: 30 })).plan;
  assert.deepStrictEqual(p.quote, { serviceType: 'VAN', language: 'id_ID', stops: [{ coordinates: { lat: '-6.1214', lng: '106.9021' }, address: 'Jakarta Utara' }, { coordinates: { lat: '-6.2512', lng: '106.8523' }, address: 'Jl. Melati 9' }] });
  assert.deepStrictEqual(p.order, { sender: { name: 'DPP Cold Storage', phone: '+6281211112222' }, recipients: [{ name: 'Toko Zahra', phone: '+6281300000099', remarks: 'Order ' + no + ': 10 ctn, 1 palet, ± 50 kg, ambil di DPP Cold Storage' }],
    isPODEnabled: false, metadata: { order_no: no } });
  assert.deepStrictEqual([p.eta_at, p.eta_min, p.schedule_at, p.kg, p.by, p.spent, p.cap, p.warn], ['2026-10-16T03:35:00.000Z', 30, '', 50, 'Jihan', 0, 500000, '']); // 30 min + 15 %
  assert.strictEqual(ok(call('lala_plan', { order_no: no, service: 'VAN' })).plan.eta_at, '2026-10-16T03:46:00.000Z'); // nothing typed: 40 min + 15 %
  const ps = ok(call('lala_plan', { order_no: no, service: 'VAN', schedule_at: '2026-10-16T07:00:00Z' })).plan;
  assert.deepStrictEqual([ps.quote.scheduleAt, ps.eta_at, ps.eta_min], ['2026-10-16T07:00:00.000Z', '2026-10-16T07:00:00.000Z', null]);
  assert.strictEqual(ok(call('lala_plan', { order_no: no, service: 'VAN', schedule_at: '2026-10-16T05:30:00Z' })).plan.warn, 'BREAK'); // 12:30
  err(call('lala_plan', { order_no: no, service: 'VAN', schedule_at: '2026-10-16T01:00:00Z' }), 'INVALID'); // the past
  err(call('lala_plan', { order_no: no, service: 'VAN', schedule_at: '2026-10-20T03:00:00Z' }), 'CLOSED'); // the owner's holiday
  const lt = err(call('lala_plan', { order_no: no, service: 'VAN', schedule_at: '2026-10-16T10:10:00Z' }), 'LATE_CAR'); // 17:10
  assert.deepStrictEqual([lt.ot_hours, lt.ot_cost], [1, 300000]);
  ok(call('lala_plan', { order_no: no, service: 'VAN', schedule_at: '2026-10-16T10:10:00Z', accept_ot: true }));
  NOW = '2026-10-16T09:40:00Z'; // 16:40: 40 min + 15 % = 17:26 → overtime asked first
  assert.match(err(call('lala_plan', { order_no: no, service: 'VAN' }), 'LATE_CAR').message, /tiba 17:26, lewat 17:00: lembur 1 jam \(Rp 300\.000\)/);
  NOW = '2026-10-16T03:00:00Z';
  const cp = err(call('lala_plan', { order_no: no, service: 'VAN', _price: 600000 }), 'LALA_CAP');
  assert.deepStrictEqual([cp.spent, cp.cap, cp.price], [0, 500000, 600000]);
  const pc = err(call('lala_plan', { order_no: no, service: 'VAN', _price: 100000, seen_price: 90000 }), 'PRICE_CHANGED'); // > 5 % up
  assert.deepStrictEqual([pc.price, pc.seen_price], [100000, 90000]);
  assert.strictEqual(ok(call('lala_plan', { order_no: no, service: 'VAN', _price: 100000, seen_price: 96000 })).plan.price, 100000); // ≤ 5 %: booked
  // booked (the Worker, after Lalamove took it): status 'car', looking for a driver; no WhatsApp yet (no driver, no plate)
  const SHARE = 'https://share.lalamove.com/?ID=3001&lang=id_ID';
  const booked = d => Object.assign({ order_no: no, by: 'Jihan', service: 'VAN', service_name: 'Van', eta_at: p.eta_at, eta_min: 30, dest: p.dest,
    quote: { id: 'Q1', price: 95000, currency: 'IDR', distance_m: 15200 }, placed: { order_id: '3001', share_link: SHARE, status: 'ASSIGNING_DRIVER', price: 95000 } }, d);
  const b1 = ok(sys('lala_booked', booked())).order;
  assert.deepStrictEqual([b1.status, b1.car.via, b1.car.lala_order_id, b1.car.lala_quote_id, b1.car.price, b1.car.cost, b1.car.share_link, b1.car.lala_status, b1.car.driver, b1.car.vehicle, b1.eta_at],
    ['car', 'lalamove_api', '3001', 'Q1', 95000, 95000, SHARE, 'ASSIGNING_DRIVER', '', 'Van', '2026-10-16T03:35:00.000Z']);
  const last = o => o.log[o.log.length - 1];
  assert.deepStrictEqual([last(b1).by, last(b1).note], ['Jihan', 'Lalamove otomatis · Van · Rp 95.000 · mobil dipesan, mencari sopir · tiba ± 10:35']);
  // one car at a time: no second booking, no car typed over it, no cancel by hand unless staff cancelled it in Lalamove's app
  err(sys('lala_booked', booked({ placed: { order_id: '3009' } })), 'LALA_ACTIVE');
  err(call('lala_plan', { order_no: no, service: 'VAN' }), 'LALA_ACTIVE');
  err(call('car_save', { order_no: no, driver: 'Pak C', plate: 'B 3 EF' }), 'LALA_ACTIVE');
  err(call('car_cancel', { order_no: no, reason: 'Sopir lama' }), 'LALA_ACTIVE');
  err(call('order_status', { order_no: no, to: 'cancelled', note: 'Pelanggan batal' }), 'LALA_ACTIVE');
  assert.strictEqual(ok(call('bootstrap')).lala.spent, 95000);
  // read again when not looked at for 90 s: the oldest look first
  assert.deepStrictEqual(ok(SYS('lala_due', {})).due, []);
  NOW = '2026-10-16T03:02:00Z';
  assert.deepStrictEqual(ok(call('bootstrap')).lala_due, [{ order_no: no, lala_order_id: '3001', driver_id: '', synced_at: '2026-10-16T03:00:00Z' }]);
  assert.deepStrictEqual(ok(call('poll')).lala_due, [{ order_no: no, lala_order_id: '3001', driver_id: '', synced_at: '2026-10-16T03:00:00Z' }]);
  // Lalamove's reports → the order. Still looking: only the time of the look (no log line); another trip: nothing; no answer: kept
  const ord = () => ok(call('bootstrap')).orders.find(x => x.order_no === no), n0 = ord().log.length;
  const rep = (d) => ok(sys('lala_sync', { items: [Object.assign({ order_no: no, lala_order_id: '3001', ok: true, status: 'ASSIGNING_DRIVER', driver_id: '', driver: null }, d)] }));
  assert.deepStrictEqual(rep({}).applied, ['same']);
  assert.deepStrictEqual([ord().log.length, ord().car.lala_synced_at], [n0, '2026-10-16T03:02:00Z']);
  assert.deepStrictEqual(ok(SYS('lala_due', {})).due, []);
  assert.deepStrictEqual(rep({ lala_order_id: '9999' }).applied, ['not_trip']);
  assert.deepStrictEqual(rep({ ok: false, error: 'Lalamove: tidak menjawab (10 detik)' }).applied, ['error']);
  assert.deepStrictEqual([ord().car.lala_error, ord().car.lala_status, ord().log.length], ['Lalamove: tidak menjawab (10 detik)', 'ASSIGNING_DRIVER', n0]);
  // the driver found: in the car, and the same car message to the cold store as step 5 (the Worker sends it, else the app by hand)
  const DRV = { status: 'ON_GOING', driver_id: 'D77', driver: { name: 'Slamet', phone: '+62 813-1111-2222', plate: 'b 9876 tkl' } };
  let r = rep(DRV);
  assert.deepStrictEqual(r.applied, ['driver']);
  assert.deepStrictEqual([r.wa.length, r.wa[0].kind, r.wa[0].to, r.wa[0].template, r.wa[0].params], [1, 'car', '6281211112222', 'khair_mobil_brad', [no, 'DPP Cold Storage', 'Van', 'B 9876 TKL', 'Slamet (081311112222)', '10:35']]);
  let o = ord();
  assert.deepStrictEqual([o.status, o.car.driver, o.car.plate, o.car.driver_wa, o.car.lala_driver_id, o.car.lala_status, 'lala_error' in o.car], ['car', 'Slamet', 'B 9876 TKL', '6281311112222', 'D77', 'ON_GOING', false]);
  assert.deepStrictEqual([last(o).by, last(o).note], ['Lalamove', 'Sopir Lalamove: Slamet · B 9876 TKL']);
  assert.match(KBrad.msgCar(T.orders.find(x => x.order_no === no), C), /Kendaraan: Van\nNo\. polisi: B 9876 TKL\nSopir: Slamet \(081311112222\)/);
  // the same report again: nothing (no log line, no message)
  r = rep(DRV);
  assert.deepStrictEqual([r.applied, r.wa, ord().log.length], [['same'], [], o.log.length]);
  // in at door 3 (by hand or the cold store's WhatsApp, as before); Lalamove: picked up → the departure, the goods out of the stock
  NOW = '2026-10-16T03:45:00Z';
  ok(call('order_arrived', { order_no: no, time: '10:40', door: '3' }));
  const mv = T.movements.length, stockA = () => T.movements.filter(m => m.pallet_code === 'A-2001' && m.warehouse === 'DPP').reduce((s, m) => s + m.cartons, 0), s0 = stockA();
  r = rep(Object.assign({}, DRV, { status: 'PICKED_UP' }));
  assert.deepStrictEqual([r.applied, r.wa.map(m => [m.kind, m.to])], [['departed'], [['depart', '6281300000099']]]);
  o = ord();
  assert.deepStrictEqual([o.status, o.departed_at, last(o).note, last(o).by, stockA()], ['departed', '2026-10-16T03:45:00Z', 'Lalamove: barang diambil', 'Lalamove', s0 - 10]);
  assert.deepStrictEqual(T.movements.slice(mv).map(m => [m.type, m.pallet_code, m.cartons, m.order_no, m.by_user]), [['OUT', 'A-2001', -10, no, 'Lalamove']]);
  r = rep(Object.assign({}, DRV, { status: 'PICKED_UP' }));
  assert.deepStrictEqual([r.applied, r.wa, T.movements.length], [['same'], [], mv + 1]); // never twice
  // completed → delivered; then nothing more to read
  assert.deepStrictEqual(rep(Object.assign({}, DRV, { status: 'COMPLETED' })).applied, ['delivered']);
  o = ord();
  assert.deepStrictEqual([o.status, o.car.lala_status, last(o).note, KBrad.lalaOpen(T.orders.find(x => x.order_no === no))], ['delivered', 'COMPLETED', 'Lalamove: selesai', false]);
  NOW = '2026-10-16T04:00:00Z';
  assert.deepStrictEqual(ok(call('bootstrap')).lala_due, []);
  assert.strictEqual(ok(call('bootstrap')).lala.spent, 95000); // a completed trip counts
  // few reads: a pickup booked for later than 2 hours is looked at every 30 minutes (Lalamove's webhook: at once); 3 days after its
  // pickup a trip left open is not read any more
  const trip = (c) => ({ order_no: 'X', status: 'car', car: JSON.stringify(Object.assign({ via: 'lalamove_api', lala_order_id: '77', lala_status: 'ASSIGNING_DRIVER', booked_at: '2026-10-16T03:00:00Z', lala_synced_at: '2026-10-16T03:00:00Z' }, c)) });
  const due = (o, iso, age) => KBrad.lalaDue([o], Date.parse(iso), age || 90, 5, '').length;
  const later = trip({ schedule_at: '2026-10-17T02:00:00Z' });
  assert.deepStrictEqual([due(later, '2026-10-16T03:02:00Z'), due(later, '2026-10-16T03:31:00Z'), due(later, '2026-10-16T03:01:00Z', 15), due(trip({}), '2026-10-16T03:02:00Z')], [0, 1, 1, 1]);
  assert.deepStrictEqual([due(trip({}), '2026-10-19T02:59:00Z'), due(trip({}), '2026-10-19T03:01:00Z'), due(trip({ lala_status: 'COMPLETED' }), '2026-10-16T04:00:00Z')], [1, 0, 0]);
  // no driver found (expired) / cancelled by Lalamove while the car is awaited → back to "book a car", counted; once
  const mkReady = () => { const x = mk({ order_date: '2026-10-16', lines: [{ pallet_code: 'A-2001', cartons: 2 }] }); for (const to of ['sent', 'approved', 'ready']) ok(call('order_status', { order_no: x.order_no, to })); return x.order_no; };
  const book = (n, id, price) => ok(sys('lala_booked', booked({ order_no: n, eta_at: '', eta_min: 40, placed: { order_id: id, share_link: '', status: 'ASSIGNING_DRIVER', price: price || 80000 } }))).order;
  const no2 = mkReady(); book(no2, '3002');
  const rep2 = (n, id, d) => ok(sys('lala_sync', { items: [Object.assign({ order_no: n, lala_order_id: id, ok: true }, d)] }));
  assert.deepStrictEqual(rep2(no2, '3002', { status: 'EXPIRED' }).applied, ['cancelled']);
  o = ok(call('bootstrap')).orders.find(x => x.order_no === no2);
  assert.deepStrictEqual([o.status, o.car, o.car_cancels, last(o).note, last(o).by], ['ready', null, 1, 'Lalamove tidak dapat sopir: belum ada sopir — pesan mobil lagi', 'Lalamove']);
  assert.deepStrictEqual(rep2(no2, '3002', { status: 'EXPIRED' }).applied, ['not_trip']);
  // picked up while the car is still "booked" here: said on the order; it leaves once staff mark the car in
  const no3 = mkReady(); book(no3, '3003', 70000);
  assert.deepStrictEqual(rep2(no3, '3003', { status: 'PICKED_UP', driver_id: 'D1', driver: { name: 'Andi', phone: '', plate: 'B 1 A' } }).applied, ['driver']);
  o = ok(call('bootstrap')).orders.find(x => x.order_no === no3);
  assert.deepStrictEqual([o.status, last(o).note], ['car', 'Sopir Lalamove: Andi · B 1 A · Lalamove: barang sudah diambil — catat mobil masuk lalu berangkat']);
  ok(call('order_arrived', { order_no: no3, time: '10:55' }));
  assert.deepStrictEqual(rep2(no3, '3003', { status: 'PICKED_UP', driver_id: 'D1' }).applied, ['departed']);
  // staff cancel it (the Worker cancels at Lalamove first, then tells the core); by hand only after cancelling it in Lalamove's app
  const no4 = mkReady(); book(no4, '3004');
  err(call('lala_cancel', { order_no: no4, reason: '' }), 'INVALID');
  err(call('lala_cancel', { order_no: no4, reason: 'Batal' }, 'akuntan'), 'FORBIDDEN');
  const nWrites = T.orders.find(x => x.order_no === no4).log;
  const cc = ok(call('lala_cancel', { order_no: no4, reason: 'Pelanggan ambil sendiri' })).cancel;
  assert.deepStrictEqual([cc, T.orders.find(x => x.order_no === no4).log], [{ order_no: no4, lala_order_id: '3004', reason: 'Pelanggan ambil sendiri', by: 'Jihan' }, nWrites]); // nothing written yet
  err(sys('lala_cancelled', { order_no: no4, lala_order_id: '9999', reason: 'x' }), 'NOT_FOUND');
  const cx2 = ok(sys('lala_cancelled', { order_no: no4, lala_order_id: '3004', reason: cc.reason, by: 'Jihan' })).order;
  assert.deepStrictEqual([cx2.status, cx2.car, cx2.car_cancels, last(cx2).note, last(cx2).by], ['ready', null, 1, 'Lalamove dibatalkan: belum ada sopir — Pelanggan ambil sendiri', 'Jihan']);
  err(call('lala_cancel', { order_no: no3, reason: 'Terlambat' }), 'INVALID'); // the goods are already on the car
  book(no4, '3005');
  const mc = ok(call('car_cancel', { order_no: no4, reason: 'Server tidak bisa hubungi Lalamove', manual: true })).order;
  assert.deepStrictEqual([mc.status, mc.car_cancels], ['ready', 2]);
  assert.match(last(mc).note, /\(dibatalkan sendiri di aplikasi Lalamove\)$/);
  // the month's spend: the trips not cancelled (95.000 + 70.000) — over the cap nothing more is booked by the server
  assert.strictEqual(KBrad.lalaSpent(T.orders, '2026-10'), 165000);
  ok(call('settings_save', { lala_cap: 165000 }, 'owner'));
  assert.match(err(call('lala_plan', { order_no: no4, service: 'VAN' }), 'LALA_CAP').message, /Batas biaya Lalamove bulan ini \(Rp 165\.000\) tercapai: sudah Rp 165\.000/);
  ok(call('settings_save', { lala_cap: 10000000 }, 'owner'));
  // the city's vehicles, kept for the car form (the Worker reads them: "Tes koneksi"); then only those can be booked
  err(call('lala_admin', { op: 'status' }, 'akuntan'), 'FORBIDDEN');
  err(call('lala_admin', { op: 'delete' }), 'INVALID');
  assert.strictEqual(ok(call('lala_admin', { op: 'test' })).lala.cap, 10000000);
  ok(sys('lala_services', { city: { locode: 'ID_JKT', name: 'Jakarta' }, services: [{ key: 'VAN', description: 'Van', load: { value: '600', unit: 'kg' } }, { key: 'bad key!' }, { key: 'truck175', description: 'Pickup', load: { value: '1000', unit: 'kg' } }] }));
  assert.deepStrictEqual(T.settings.brad_lala_services.services, [{ key: 'VAN', description: 'Van', load: { value: 600, unit: 'kg' } }, { key: 'TRUCK175', description: 'Pickup', load: { value: 1000, unit: 'kg' } }]);
  assert.deepStrictEqual(ok(call('bootstrap')).lala.services_city, { locode: 'ID_JKT', name: 'Jakarta' });
  assert.match(err(call('lala_plan', { order_no: no4, service: 'HELICOPTER' }), 'INVALID').message, /tidak ada di Lalamove kota ini/);
  assert.strictEqual(ok(call('lala_plan', { order_no: no4, service: 'TRUCK175' })).plan.service_name, 'Pickup');
  // an order for the shop goes to the shop's place, to its phone
  const ts = ok(call('order_save', { warehouse: 'DPP', order_date: '2026-10-16', dest_type: 'toko', lines: [{ pallet_code: 'A-2001', cartons: 1 }] })).order;
  for (const to of ['sent', 'approved', 'ready']) ok(call('order_status', { order_no: ts.order_no, to }));
  assert.match(err(call('lala_plan', { order_no: ts.order_no, service: 'VAN' }), 'INVALID').message, /Nomor HP penerima wajib/); // the shop has no phone in the test settings
  const tp = ok(call('lala_plan', { order_no: ts.order_no, service: 'VAN', dest_phone: '0812 8000 2700' })).plan;
  assert.deepStrictEqual([tp.quote.stops[1], tp.order.recipients[0].name, tp.order.recipients[0].phone], [{ coordinates: { lat: '-6.2297', lng: '106.8679' }, address: 'Jl. Raya Condet No.4' }, 'Khair Mart', '+6281280002700']);
  [no2, no4, ts.order_no].forEach(n => ok(call('order_status', { order_no: n, to: 'cancelled', note: 'uji Lalamove' })));
}
// nothing of the gudang data but OUT movements was ever written (checked in call())
assert(T.movements.filter(m => m.type === 'OUT').every(m => /^BRD-/.test(m.order_no)));
console.log('test-brad: all passed (' + T.orders.length + ' orders, ' + T.movements.length + ' movements)');
