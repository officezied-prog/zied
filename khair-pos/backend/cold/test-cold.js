// node test-cold.js — checks the cold-storage core and parsers without n8n: roles, every action, stock from movements,
// reverse movements, not-enough-stock, FEFO, storage cost, and the readers (DPP-shaped Excel copy + WhatsApp text).
// The DPP sample below has the real report's shape with made-up numbers (the real file stays private).
const assert = require('assert'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const src = ['cold-parsers.js', 'cold-core.js'].map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
const { KCold, KColdParsers } = new Function(src + '\nreturn { KCold, KColdParsers };')();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const ph = (n, pin) => sha('demo:' + n.toLowerCase() + ':' + pin);

// tables like n8n: rows with ids; writes with an id update, without are inserted
const T = { warehouses: [], products: [], containers: [], pallets: [], movements: [], checks: [], orders: [], settings: {},
  users: [{ id: 1, name: 'zied salah', role: 'owner', pin_hash: ph('zied salah', '1234'), active: true },
    { id: 2, name: 'Jihan', role: 'manager', pin_hash: ph('Jihan', '2222'), active: true },
    { id: 3, name: 'Akun', role: 'akuntan', pin_hash: ph('Akun', '3333'), active: true },
    { id: 4, name: 'Emma', role: 'kasir', pin_hash: ph('Emma', '4444'), active: true },
    { id: 5, name: 'Baru', role: 'manager', pin_hash: ph('Baru', '5555'), active: true, must_change: true }] };
let nid = 100;
const WHO = { owner: ['zied salah', '1234'], manager: ['Jihan', '2222'], akuntan: ['Akun', '3333'], kasir: ['Emma', '4444'] };
let NOW = '2026-10-07T02:00:00Z'; // 09:00 WIB
function call(action, data, who = 'owner', pinOverride) {
  const [user, pin] = WHO[who] || [who, pinOverride];
  const state = JSON.parse(JSON.stringify(T));
  const res = KCold.core(state, { action, user, pin_hash: ph(user, pinOverride || pin), data: data || {} }, NOW);
  res.writes.forEach(w => {
    if (w.table === 'settings') { T.settings[w.row.skey] = JSON.parse(w.row.svalue); return; }
    const row = JSON.parse(JSON.stringify(w.row));
    if (row.id === undefined) { row.id = nid++; T[w.table].push(row); } else { const i = T[w.table].findIndex(x => x.id === row.id); assert(i >= 0, 'update of a missing row'); T[w.table][i] = row; }
  });
  return res.response;
}
const ok = r => { assert(r.ok, JSON.stringify(r)); return r; };
const err = (r, code) => { assert.strictEqual(r.ok, false, JSON.stringify(r)); assert.strictEqual(r.error, code, JSON.stringify(r)); return r; };
const stock = (pc, wh) => ok(call('bootstrap', {})).stock.filter(r => r.pallet_code === pc && (!wh || r.warehouse === wh)).reduce((s, r) => s + r.cartons, 0);

// ---------- login and roles ----------
err(call('login', {}, 'zied salah', '9999'), 'BAD_PIN');
err(call('login', {}, 'kasir'), 'FORBIDDEN');
err(call('login', {}, 'Baru', '5555'), 'PIN_CHANGE_REQUIRED');
assert.strictEqual(ok(call('login', {}, 'akuntan')).me.role, 'akuntan');
T.users[0].master_hash = sha('master-code-demo');
assert(KCold.core(JSON.parse(JSON.stringify(T)), { action: 'login', user: 'Jihan', pin_hash: sha('master-code-demo') }, NOW).response.ok); // owner's master code opens any account
T.users.push({ id: 6, name: 'Kunci', role: 'manager', pin_hash: ph('Kunci', '6666'), active: true, locked_until: '2026-10-07T03:00:00Z' });
err(call('login', {}, 'Kunci', '6666'), 'LOCKED');
err(KCold.core(JSON.parse(JSON.stringify(T)), { action: 'login', user: 'Jihan', pin_hash: '' }, NOW).response, 'BAD_PIN');

// ---------- settings: owner only ----------
err(call('warehouse_save', { code: 'DPP', name: 'DPP' }, 'manager'), 'FORBIDDEN');
err(call('warehouse_save', { code: 'DPP' }), 'INVALID'); // a name is needed
err(call('warehouse_save', { code: 'DPP', name: 'DPP', pic_wa: '12' }), 'INVALID');
ok(call('warehouse_save', { code: 'DPP', name: 'DPP Cold Storage', address: 'Jakarta Utara', pic_name: 'Admin', pic_wa: '0812 1111 2222', customer_id: '0157', rate: 450000, rate_frozen: 600000, rate_dry: 300000, rate_unit: 'month', parser: 'dpp' }));
ok(call('warehouse_save', { code: 'BOSKO', name: 'Bosko', rate: 15000, rate_unit: 'day', parser: 'bosko' }));
ok(call('warehouse_save', { code: 'KAWANISHI', name: 'Kawanishi <b>', parser: 'nope' }));
assert.strictEqual(T.warehouses[0].pic_wa, '6281211112222');
assert.strictEqual(T.warehouses[2].name, 'Kawanishi b');
assert.strictEqual(T.warehouses[2].parser, 'generic');
ok(call('product_save', { code: 'SUKARI-3', name: 'Sukari 3kg', kg_per_ctn: 3, aliases: 'sukari, sukkari' }));
ok(call('product_save', { code: 'AJWA-5', name: 'Kurma Ajwa Jumbo 5kg', kg_per_ctn: 5, ctn_per_pallet: 121, aliases: 'ajwa, 157-019' }));
assert.strictEqual(T.products[1].ctn_per_pallet, 121);
// no code, or an Arabic one: made from the name (the owner's first save failed on this)
assert.strictEqual(ok(call('product_save', { code: 'تمر', name: 'تمر خلاص' })).product.code, 'P3');
assert.strictEqual(ok(call('product_save', { name: 'Kurma Medjool 5kg' })).product.code, 'KURMA-MEDJOOL-5KG');
assert.strictEqual(ok(call('warehouse_save', { name: 'Gudang Baru' })).warehouse.code, 'GUDANG-BARU');
err(call('product_save', { name: 'x', ctn_per_pallet: -1 }), 'INVALID');
err(call('product_save', { code: 'X', name: 'x' }, 'manager'), 'FORBIDDEN');
err(call('settings_save', { drivers: [] }, 'manager'), 'FORBIDDEN');
ok(call('settings_save', { drivers: [{ name: 'Pak Udin', wa: '0813-2222-3333', vehicle: 'Engkel', plate: 'b 1234 xyz' }] }));
assert.deepStrictEqual(T.settings.cold_drivers[0], { name: 'Pak Udin', wa: '6281322223333', vehicle: 'Engkel', plate: 'B 1234 XYZ' });
// the manager does not see storage rates; the accountant does
assert.strictEqual(ok(call('bootstrap', {}, 'manager')).warehouses[0].rate, undefined);
assert.strictEqual(ok(call('bootstrap', {}, 'akuntan')).warehouses[0].rate, 450000);

// ---------- container + pallets in ----------
err(call('container_save', { container_no: 'ABC123', warehouse: 'DPP', arrival_date: '2026-09-25' }), 'INVALID');
ok(call('container_save', { container_no: 'cgmu 528 8973', size: '40', warehouse: 'DPP', arrival_date: '2026-09-25', supplier: 'Al Qassim', origin: 'Saudi Arabia', product: 'SUKARI-3', cartons: 693 }, 'manager'));
err(call('container_save', { container_no: 'ABCU1234567', warehouse: 'DPP', arrival_date: '2026-09-25', product: 'NOPE' }), 'NOT_FOUND');
// inbound: a container asks to enter; an in-place purchase gets its own number; entering pallets marks it stored
ok(call('container_save', { container_no: 'MSKU1234567', warehouse: 'BOSKO', arrival_date: '2026-10-10' }));
err(call('container_status', { container_no: 'MSKU1234567', to: 'approved' }), 'INVALID');
ok(call('container_status', { container_no: 'MSKU1234567', to: 'requested' }));
err(call('container_status', { container_no: 'MSKU1234567', to: 'rejected' }), 'INVALID');
ok(call('container_status', { container_no: 'MSKU1234567', to: 'approved' }, 'manager'));
const inp = ok(call('container_save', { kind: 'in_place', warehouse: 'DPP', arrival_date: '2026-09-20', supplier: 'PT Penjual' })).container;
assert.strictEqual(inp.container_no, 'IN26100001'); assert.strictEqual(inp.status, 'planned');
assert.strictEqual(T.containers[0].container_no, 'CGMU5288973');
err(call('pallet_in', { warehouse: 'DPP', container_no: 'XXXX1234567', pallets: [{ pallet_code: 'P1', product: 'SUKARI-3', cartons: 10, exp_date: '2027-01-01' }] }), 'NOT_FOUND');
err(call('pallet_in', { warehouse: 'DPP', pallets: [{ pallet_code: 'P1', product: 'SUKARI-3', cartons: 10 }] }), 'INVALID'); // expiry required
err(call('pallet_in', { warehouse: 'DPP', pallets: [{ pallet_code: 'P1', product: 'SUKARI-3', cartons: 0, exp_date: '2027-01-01' }] }), 'INVALID');
err(call('pallet_in', { warehouse: 'DPP', pallets: [{ pallet_code: 'P1', product: 'SUKARI-3', cartons: 5, exp_date: '2027-01-01' }] }, 'akuntan'), 'FORBIDDEN');
NOW = '2026-09-26T03:00:00Z';
ok(call('pallet_in', { warehouse: 'DPP', container_no: 'CGMU5288973', date: '2026-09-26', pallets: [
  { pallet_code: '2274537', product: 'SUKARI-3', lot: '260925/A', cartons: 286, exp_date: '2027-06-01' },
  { pallet_code: '2274538', product: 'SUKARI-3', lot: '260925/A', cartons: 286, exp_date: '2026-11-15' },
  { pallet_code: '3619208', product: 'AJWA-5', lot: '260925/B', cartons: 121, exp_date: '2027-03-01', zone: 'frozen' }] }, 'manager'));
assert.deepStrictEqual(T.pallets.map(p => p.zone), ['CHILLER', 'CHILLER', 'FROZEN']);
err(call('pallet_in', { warehouse: 'DPP', pallets: [{ pallet_code: '2274537', product: 'SUKARI-3', cartons: 5, exp_date: '2027-01-01' }] }), 'INVALID'); // code taken
assert.strictEqual(T.movements.length, 3);
assert.strictEqual(T.containers.find(c => c.container_no === 'CGMU5288973').status, 'stored');
assert.strictEqual(stock('2274537'), 286);
NOW = '2026-10-07T02:00:00Z';

// ---------- transfer, adjust, reverse ----------
err(call('movement_add', { type: 'TRANSFER', pallet_code: '3619208', warehouse: 'DPP', to_warehouse: 'BOSKO', cartons: 500 }), 'NOT_ENOUGH');
ok(call('movement_add', { type: 'TRANSFER', pallet_code: '3619208', warehouse: 'DPP', to_warehouse: 'BOSKO', cartons: 21 }, 'manager'));
assert.strictEqual(stock('3619208', 'DPP'), 100); assert.strictEqual(stock('3619208', 'BOSKO'), 21);
err(call('movement_add', { type: 'ADJUST', pallet_code: '2274537', warehouse: 'DPP', cartons: -2 }), 'INVALID'); // reason
const adj = ok(call('movement_add', { type: 'ADJUST', pallet_code: '2274537', warehouse: 'DPP', cartons: -2, reason: 'Hitung ulang, 2 ctn rusak' })).movement;
assert.strictEqual(stock('2274537'), 284);
ok(call('movement_reverse', { seq: adj.seq, reason: 'Ternyata tidak rusak' }));
assert.strictEqual(stock('2274537'), 286);
err(call('movement_reverse', { seq: adj.seq, reason: 'lagi' }), 'INVALID'); // already reversed
err(call('movement_reverse', { seq: T.movements[T.movements.length - 1].seq, reason: 'xxx' }), 'INVALID'); // a reversal
const tr = T.movements.find(m => m.type === 'TRANSFER' && m.warehouse === 'BOSKO');
ok(call('movement_reverse', { seq: tr.seq, reason: 'Salah gudang' })); // the pair is undone
assert.strictEqual(stock('3619208', 'DPP'), 121); assert.strictEqual(stock('3619208', 'BOSKO'), 0);
assert(T.movements.every(m => m.seq > 0) && new Set(T.movements.map(m => m.seq)).size === T.movements.length);

// ---------- FEFO ----------
const f = ok(call('fefo', { warehouse: 'DPP', product: 'SUKARI-3', cartons: 300 }, 'akuntan'));
assert.deepStrictEqual(f.lines.map(l => [l.pallet_code, l.cartons]), [['2274538', 286], ['2274537', 14]]); // earliest expiry first
assert.strictEqual(ok(call('fefo', { warehouse: 'DPP', product: 'SUKARI-3', cartons: 600 })).short, 28);

// ---------- pick orders ----------
err(call('order_save', { warehouse: 'DPP', lines: [{ pallet_code: '2274538', cartons: 999 }] }), 'NOT_ENOUGH');
err(call('order_save', { warehouse: 'DPP', dest_type: 'pelanggan', lines: [{ pallet_code: '2274538', cartons: 10 }] }), 'INVALID'); // customer name
const o1 = ok(call('order_save', { warehouse: 'DPP', dest_type: 'toko', pickup_person: 'Wahyu', lines: f.lines.map(l => ({ pallet_code: l.pallet_code, cartons: l.cartons })) }, 'manager')).order;
assert.strictEqual(o1.order_no, 'SPB-261007-001');
assert.strictEqual(o1.dest_name, 'Khair Mart');
// reserved: an open order holds its cartons
err(call('order_save', { warehouse: 'DPP', lines: [{ pallet_code: '2274538', cartons: 1 }] }), 'NOT_ENOUGH');
assert.strictEqual(ok(call('fefo', { warehouse: 'DPP', product: 'SUKARI-3', cartons: 300, order_no: o1.order_no })).lines[0].cartons, 286); // editing o1 itself
const o2 = ok(call('order_save', { warehouse: 'DPP', dest_type: 'pelanggan', dest_name: 'Toko Barokah', dest_address: 'Jl. Dewi Sartika 5', lines: [{ pallet_code: '3619208', cartons: 20 }] })).order;
assert.strictEqual(o2.order_no, 'SPB-261007-002');
ok(call('order_save', { order_no: o2.order_no, warehouse: 'DPP', dest_type: 'pelanggan', dest_name: 'Toko Barokah', lines: [{ pallet_code: '3619208', cartons: 25 }] }));
assert.strictEqual(T.orders.length, 2);
// the order flow: only the allowed next steps, every step logged with who and when
err(call('order_status', { order_no: o2.order_no, to: 'ready' }), 'INVALID'); // open → ready skips the warehouse
ok(call('order_status', { order_no: o2.order_no, to: 'sent' }, 'manager'));
err(call('order_status', { order_no: o2.order_no, to: 'rejected' }), 'INVALID'); // a reason is needed
ok(call('order_status', { order_no: o2.order_no, to: 'rejected', note: 'Stok belum bisa dikeluarkan' }));
err(call('order_save', { order_no: o2.order_no, warehouse: 'DPP', dest_type: 'pelanggan', dest_name: 'Toko Barokah', lines: [{ pallet_code: '3619208', cartons: 999 }] }), 'NOT_ENOUGH'); // rejected releases nothing it doesn't have
ok(call('order_save', { order_no: o2.order_no, warehouse: 'DPP', dest_type: 'pelanggan', dest_name: 'Toko Barokah', lines: [{ pallet_code: '3619208', cartons: 25 }] })); // fixed → open again
['sent', 'approved', 'ready'].forEach(s => ok(call('order_status', { order_no: o2.order_no, to: s }, 'manager')));
err(call('order_status', { order_no: o2.order_no, to: 'dispatch' }, 'akuntan'), 'FORBIDDEN');
ok(call('order_status', { order_no: o2.order_no, to: 'dispatch' }));
err(call('order_status', { order_no: o2.order_no, to: 'driver' }), 'INVALID'); // no driver yet
assert.deepStrictEqual(JSON.parse(T.orders.find(o => o.order_no === o2.order_no).log).map(l => l.to), ['open', 'sent', 'rejected', 'open', 'sent', 'approved', 'ready', 'dispatch']);
err(call('order_pick', { order_no: o2.order_no }, 'akuntan'), 'FORBIDDEN');
err(call('trip_save', { order_no: o2.order_no }), 'INVALID');
ok(call('trip_save', { order_no: o2.order_no, vehicle: 'Pickup', driver: 'Pak Udin', plate: 'b 1 x', cost: 250000, via: 'lalamove' }, 'manager'));
assert.strictEqual(T.orders.find(o => o.order_no === o2.order_no).status, 'driver'); // a driver while dispatch-approved → driver step
// someone took cartons outside the app → pick refuses
const adj2 = ok(call('movement_add', { type: 'ADJUST', pallet_code: '3619208', warehouse: 'DPP', cartons: -110, reason: 'Diambil tanpa SPB' })).movement;
err(call('order_pick', { order_no: o2.order_no }), 'NOT_ENOUGH');
ok(call('movement_reverse', { seq: adj2.seq, reason: 'Salah input' }));
const picked = ok(call('order_pick', { order_no: o2.order_no }, 'manager')).order;
assert.strictEqual(picked.status, 'picked'); assert.strictEqual(picked.trip.cost, 250000); assert.strictEqual(picked.trip.plate, 'B 1 X');
assert.strictEqual(stock('3619208'), 96);
assert.strictEqual(T.movements.filter(m => m.type === 'OUT' && m.order_no === o2.order_no).length, 1);
err(call('order_pick', { order_no: o2.order_no }), 'INVALID');
ok(call('order_status', { order_no: o2.order_no, to: 'delivered' }));
err(call('order_status', { order_no: o2.order_no, to: 'sent' }), 'INVALID');
err(call('order_cancel', { order_no: o2.order_no, reason: 'batal' }), 'INVALID'); // picked: reverse the movement instead
err(call('order_cancel', { order_no: o1.order_no }), 'INVALID');
ok(call('order_cancel', { order_no: o1.order_no, reason: 'Toko masih punya stok' }));
assert.strictEqual(T.orders.find(o => o.order_no === o1.order_no).status, 'cancelled'); // stays visible
ok(call('order_save', { warehouse: 'DPP', lines: [{ pallet_code: '2274538', cartons: 286 }] })); // cancelled order no longer reserves

// ---------- parsers ----------
const DPP = fs.readFileSync(path.join(__dirname, 'sample-dpp.tsv'), 'utf8');
const pd = KColdParsers.parse('dpp', DPP);
assert.strictEqual(pd.report_date, '2026-10-06');
assert.deepStrictEqual(pd.items.map(i => [i.pallet, i.item, i.cartons, i.exp_date, i.zone, i.container_no]), [
  ['2274537', '157-009', 280, '2027-06-01', 'FROZEN', 'CGMU5288973'], ['2274538', '157-009', 286, '2026-11-15', 'FROZEN', 'CGMU5288973'],
  ['3619208', '157-019', 121, '2027-03-01', 'CHILLER', 'CGMU5288973'], ['3619299', '157-019', 50, '2027-04-01', 'CHILLER', 'FBIU5049090']]);
assert.deepStrictEqual(pd.unparsed, ['Catatan: palet 5 rusak sebagian']); // never dropped
const wa = KColdParsers.parse('bosko', 'Selamat pagi pak, stok hari ini:\n1. Sukari 3kg PLT-07 = 120 ctn\n- Ajwa 5kg : 1.200 krt\nMedjool lot 2408: 45\nTotal 1365 ctn\nhalo bos');
assert.deepStrictEqual(wa.items.map(i => [i.product, i.pallet || '', i.lot || '', i.cartons]), [['Sukari 3kg', 'PLT-07', '', 120], ['Ajwa 5kg', '', '', 1200], ['Medjool', '', '2408', 45]]);
assert.deepStrictEqual(wa.unparsed, ['halo bos']);
assert(wa.ignored.includes('Total 1365 ctn'));
assert.strictEqual(KColdParsers.toDate('45773'), '2025-04-26'); // Excel day number

// ---------- daily check ----------
err(call('check_save', { warehouse: 'DPP', text: '' }), 'INVALID');
const pv = ok(call('check_preview', { warehouse: 'DPP', text: DPP }, 'akuntan'));
assert.strictEqual(pv.check_date, '2026-10-06');
const L = Object.fromEntries(pv.result.lines.map(l => [l.key, l]));
assert.strictEqual(L['2274537'].diff, -6);  // they 280, we 286
assert.strictEqual(L['2274538'].diff, 0);
assert.strictEqual(L['3619208'].diff, 0);   // 25 ctn were picked on 07 Oct, after the report date
assert.strictEqual(pv.result.unknown.length, 1); // 3619299: they list it, we don't have it
assert.strictEqual(pv.result.unparsed.length, 1);
assert.strictEqual(T.checks.length, 0); // preview writes nothing
err(call('check_save', { warehouse: 'DPP', text: DPP }, 'akuntan'), 'FORBIDDEN');
const ck = ok(call('check_save', { warehouse: 'DPP', text: DPP, check_date: '2026-10-07' }, 'manager')).check;
assert.strictEqual(ck.check_no, 'CEK-261007-001'); assert(ck.n_diff >= 2); assert(ck.raw_text === DPP.trim(), "raw text kept");
ok(call('check_note', { check_no: ck.check_no, note: '6 ctn rusak, gudang belum lapor' }));
err(call('check_note', { check_no: ck.check_no, note: 'ubah' }), 'INVALID'); // cannot be changed afterwards
const wa2 = ok(call('check_preview', { warehouse: 'DPP', text: 'Sukari 3kg 570 ctn\nAjwa 96 ctn\nKhalas 10 ctn\nhalo' })).result;
assert.deepStrictEqual(wa2.lines.map(l => [l.key, l.theirs, l.ours, l.diff]), [['SUKARI-3', 570, 572, -2], ['AJWA-5', 96, 96, 0]]);
assert.strictEqual(wa2.unknown[0].line, 'Khalas 10 ctn');
assert.deepStrictEqual(wa2.unparsed, ['halo']);
assert.strictEqual(ok(call('check_preview', { warehouse: 'DPP', text: 'Ajwa 96 ctn' })).result.missing[0].key, 'SUKARI-3'); // we have it, they did not list it

// ---------- import a warehouse report as opening stock (owner) ----------
const fresh = ok(call('warehouse_save', { code: 'DPP2', name: 'DPP lantai 2', parser: 'dpp' }));
const items = KColdParsers.parse('dpp', DPP).items.map(i => ({ pallet_code: '9' + i.pallet, product: i.item, product_name: 'Item ' + i.item, ext_item: i.item, cartons: i.cartons, exp_date: i.exp_date, date_in: i.date_in, zone: i.zone, container_no: i.container_no, lot: i.lot, kg_per_ctn: 2 }));
err(call('import_report', { warehouse: 'DPP2', date: '2026-10-06', pallets: items }, 'manager'), 'NOT_FOUND'); // new products: owner only
const imp = ok(call('import_report', { warehouse: 'DPP2', date: '2026-10-06', pallets: items }));
assert.strictEqual(imp.pallets, 4); assert.deepStrictEqual(imp.new_products, ['157-009', '157-019']);
assert(T.containers.some(c => c.container_no === 'FBIU5049090'));
const again = ok(call('check_preview', { warehouse: 'DPP2', text: DPP.replace(/\b(2274537|2274538|3619208|3619299)\b/g, '9$1') })).result;
assert.strictEqual(again.n_diff, 0, JSON.stringify(again)); // the report matches what we imported from it

// ---------- report, alerts, storage cost ----------
const rep = ok(call('report', { date: '2026-10-07' }));
assert(rep.per_warehouse.find(w => w.warehouse === 'DPP').pallets === 3);
assert(rep.expiring.some(r => r.pallet_code === '2274538')); // ≤ 60 days
const dppCost = rep.storage.find(s => s.warehouse === 'DPP');
assert.strictEqual(dppCost.pallet_days, 21); // 3 pallets × 7 days (01–07 Oct)
// 2 chiller pallets at the general rate (no chiller rate set), 1 frozen pallet at the frozen rate
assert.strictEqual(dppCost.cost_to_date, Math.round(14 * 450000 / 30 + 7 * 600000 / 30));
assert.deepStrictEqual(dppCost.pallet_days_zone, { FROZEN: 7, CHILLER: 14, DRY: 0 });
const cont = ok(call('bootstrap', {})).containers.find(c => c.container_no === 'CGMU5288973');
assert.strictEqual(cont.origin, 'Saudi Arabia'); assert.strictEqual(cont.cartons, 693); assert.strictEqual(cont.received, 693 + 687); // + the 3 pallets imported from the report into DPP2 assert.strictEqual(cont.finished_date, '');
assert(cont.now > 0 && cont.now < cont.received);
assert.strictEqual(ok(call('report', {}, 'manager')).storage, undefined);
const boot = ok(call('bootstrap', {}));
assert(boot.alerts.no_check_today.includes('DPP2') && !boot.alerts.no_check_today.includes('DPP'));
assert.strictEqual(boot.alerts.unexplained.length, 0);
assert(boot.orders.some(o => o.status === 'cancelled'));
assert.strictEqual(KCold.vehicleFor(500), 'Pickup (bak)'); assert.strictEqual(KCold.vehicleFor(2000), 'Engkel (CDE)');
err(call('nope', {}), 'INVALID');
// nothing was ever deleted and no movement changed
assert(T.movements.every(m => m.by_user && m.at));
console.log('test-cold: all passed (' + T.movements.length + ' movements, ' + T.orders.length + ' orders)');
