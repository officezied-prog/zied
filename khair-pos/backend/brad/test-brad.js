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
// nothing of the gudang data but OUT movements was ever written (checked in call())
assert(T.movements.filter(m => m.type === 'OUT').every(m => /^BRD-/.test(m.order_no)));
console.log('test-brad: all passed (' + T.orders.length + ' orders, ' + T.movements.length + ' movements)');
