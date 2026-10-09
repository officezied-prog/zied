'use strict';
/* Khair Kasir — demo/mock backend (cashier app). Mirrors backend/process.js; same localStorage DB key as the owner app. Loaded before the main script; used only in ?mock=1 / demo mode. */
const MockServer = (() => {
  const DBKEY = 'kmock.db';
  const COST_KEYS = ['cost_price', 'total_cost', 'profit', 'line_profit', 'cost'];
  const CHANNELS = ['toko', 'whatsapp', 'shopee', 'tiktok', 'tokopedia', 'web', 'lainnya'];
  const READ_ONLY = ['users', 'login', 'bootstrap', 'get_sales', 'check_approval', 'list_approvals', 'list_photos', 'party_ledger', 'list_returns', 'get_sale'];
  /* v16 settings defaults as on the server (an older demo DB lacks them) */
  const V16_DEFAULTS = { limit_agreements: [], receipt_send_fee: 500, max_discount_pct: 3, sell_from_shop_only: true, return_owner_min_value: 2000000, return_owner_min_qty: 0, return_fee_pct: 0, require_return_photo: true, require_carrier: true, member_enabled: true, member_tiers: [{ from: 2, pct: 2 }, { from: 5, pct: 3 }, { from: 10, pct: 5 }] };
  class MockErr extends Error { constructor(code, message) { super(message || code); this.code = code; } }
  const E = (code, msg, extra) => { const e = new MockErr(code, msg); if (extra) e.extra = extra; return e; };
  let ready = null;

  function load() { try { return JSON.parse(localStorage.getItem(DBKEY) || 'null'); } catch (e) { return null; } }
  function save(db) { try { localStorage.setItem(DBKEY, JSON.stringify(db)); } catch (e) { throw E('SERVER', 'mock storage full'); } }
  function ensure() {
    if (!ready) ready = (async () => { if (!load()) save(await seed(new URLSearchParams(location.search).get('seed'))); })();
    return ready;
  }
  function stripPayload(str) {
    try { const pl = JSON.parse(str); if (pl && pl.changes && pl.changes.cost_price) { pl.changes.cost_price = { from: null, to: null }; } return JSON.stringify(pl); } catch (e) { return str; }
  }
  function strip(o) {
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.payload === 'string' && o.kind === 'price') o = Object.assign({}, o, { payload: stripPayload(o.payload) });
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === 'object') { const r = {}; for (const k in o) if (!COST_KEYS.includes(k)) r[k] = strip(o[k]); return r; }
    return o;
  }
  const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const nextId = (db, k) => (db.seq[k] = (db.seq[k] || 0) + 1);
  function invoiceNo(db, ymd) {
    const n = db.sales.filter(s => s.sale_date === ymd).length + 1;
    return `KM${ymd.slice(2).replace(/-/g, '')}-${String(n).padStart(4, '0')}`;
  }
  function productFields(src, base) {
    const p = Object.assign({}, base);
    const str = k => { if (src[k] !== undefined) p[k] = String(src[k] == null ? '' : src[k]).trim(); };
    const money = k => { if (src[k] !== undefined && src[k] !== '') p[k] = Math.max(0, int(src[k])); };
    ['sku', 'name', 'category', 'unit', 'notes'].forEach(str);
    ['cost_price', 'retail_price', 'wholesale_price'].forEach(money);
    if (src.wholesale_min_qty !== undefined && src.wholesale_min_qty !== '') p.wholesale_min_qty = Math.max(0, roundQty(src.wholesale_min_qty));
    if (src.min_stock !== undefined && src.min_stock !== '') p.min_stock = Math.max(0, roundQty(src.min_stock));
    if (src.active !== undefined) p.active = !(src.active === false || src.active === 'false' || src.active === 0);
    return p;
  }
  function priceSale(db, data, quote) {
    if (!Array.isArray(data.items) || !data.items.length) throw E('INVALID', 'items required');
    if (!quote && !['tunai', 'transfer', 'qris', 'hutang'].includes(data.payment_method)) throw E('INVALID', 'payment_method');
    const cust = data.customer_id ? db.customers.find(c => c.id === Number(data.customer_id)) : null;
    if (data.customer_id && !cust) throw E('NOT_FOUND', 'customer');
    const lines = data.items.map(it => {
      const p = db.products.find(x => x.id === Number(it.product_id));
      if (!p) throw E('NOT_FOUND', 'product ' + it.product_id);
      const qty = roundQty(it.qty);
      if (!(qty > 0)) throw E('INVALID', 'qty must be > 0');
      const unit_price = Math.max(0, int(it.unit_price));
      const line_total = Math.round(qty * unit_price), line_cost = Math.round(qty * p.cost_price);
      // v16 list price (discount rule): wholesale when the customer is grosir or the line reaches wholesale_min_qty, else retail
      const grosirOk = int(p.wholesale_price) > 0 && ((cust && cust.type === 'grosir') || (num(p.wholesale_min_qty) > 0 && qty >= num(p.wholesale_min_qty)));
      const listPrice = grosirOk ? Math.min(int(p.wholesale_price), int(p.retail_price) || int(p.wholesale_price)) : int(p.retail_price);
      return { p, qty, unit_price, price_type: it.price_type === 'grosir' ? 'grosir' : 'eceran', line_total, line_cost, list_total: Math.round(qty * listPrice) };
    });
    const subtotal = sum(lines, l => l.line_total);
    const discount = Math.min(subtotal, Math.max(0, int(data.discount)));
    // (07 Oct) receipt sent by WhatsApp / e-mail: the first one per customer is free, later ones add receipt_send_fee
    if (data.send_receipt === true && !cust) throw E('INVALID', 'Simpan nomor HP pelanggan dulu untuk kirim struk');
    const sendFee = data.send_receipt === true ? receiptFee(db, cust) : 0;
    const total = subtotal - discount + sendFee;
    const total_cost = sum(lines, l => l.line_cost);
    const paid = Math.max(0, int(data.paid_amount));
    const debt = Math.max(0, total - paid);
    if (debt > 0 && !cust && !quote) throw E('INVALID', 'Debt requires customer_id');
    return { cust, lines, subtotal, discount, total, total_cost, paid, debt, sale_date: isYmd(data.sale_date) ? data.sale_date : jktDate(), listTotal: sum(lines, l => l.list_total), sendFee };
  }
  function receiptFee(db, cust) {
    const v = db.settings.receipt_send_fee;
    const fee = v === undefined || v === null || v === '' ? 500 : Math.max(0, Math.round(num(v)));
    return cust && num(cust.receipts_sent) >= 1 ? fee : 0;
  }
  const openShiftOf = (db, name) => db.shifts.find(x => x.status === 'open' && String(x.cashier).toLowerCase() === String(name).toLowerCase());
  function shiftSummary(db, sh) {
    if (!sh) return null;
    if (sh.status === 'closed') return sh;
    const sales = db.sales.filter(x => x.shift_id === sh.shift_id && x.status !== 'void');
    const cash_sales = sum(sales.filter(x => x.payment_method === 'tunai' || x.payment_method === 'hutang'), x => Math.min(int(x.paid_amount), int(x.total)));
    const cash_payments = sum(db.payments.filter(x => x.shift_id === sh.shift_id && x.method === 'tunai'), x => int(x.amount));
    const moves = db.cash_moves.filter(x => x.shift_id === sh.shift_id);
    const kasExp = db.expenses.filter(x => x.shift_id === sh.shift_id && x.paid_from === 'kas');
    const cash_in = sum(moves.filter(x => x.type === 'in'), x => int(x.amount));
    const cash_out = sum(moves.filter(x => x.type === 'out'), x => int(x.amount)) + sum(kasExp, x => int(x.amount));
    const list = moves.map(m => ({ type: m.type, amount: m.amount, note: m.note, time: m.time })).concat(kasExp.map(x => ({ type: 'out', amount: x.amount, note: 'Pengeluaran: ' + x.category + (x.note ? ' — ' + x.note : ''), time: x.expense_date })));
    // v15: sales per method + pieces sold (transfer / QRIS = what was paid that way, hutang = the debt part)
    const paidOf = x => Math.min(int(x.paid_amount), int(x.total));
    const invs = new Set(sales.map(x => x.invoice_no));
    return Object.assign({}, sh, { sales_count: sales.length, sales_total: sum(sales, x => int(x.total)), cash_sales, cash_payments, cash_in, cash_out, moves: JSON.stringify(list),
      transfer_sales: sum(sales.filter(x => x.payment_method === 'transfer'), paidOf), qris_sales: sum(sales.filter(x => x.payment_method === 'qris'), paidOf),
      debt_sales: sum(sales, x => int(x.debt_amount)), items_qty: roundQty(sum(db.items.filter(i => invs.has(i.invoice_no)), i => num(i.qty))),
      expected_cash: int(sh.opening_cash) + cash_sales + cash_payments + cash_in - cash_out });
  }
  const BLIND = ['cash_sales', 'cash_payments', 'sales_total', 'expected_cash'];
  /** Blind count: a kasir never sees the running cash totals of an open shift. */
  const blind = (sh, role) => { if (!sh || role !== 'kasir' || sh.status !== 'open') return sh; const o = Object.assign({}, sh); BLIND.forEach(k => delete o[k]); return o; };
  function voidSaleNow(db, inv, reason, by) {
    const s = db.sales.find(x => x.invoice_no === inv);
    if (!s) throw E('NOT_FOUND', 'invoice');
    if (s.status === 'void') return s;
    s.status = 'void'; s.void_reason = reason; s.voided_by = by; s.voided_at = jktISO();
    db.items.filter(i => i.invoice_no === s.invoice_no).forEach(i => { const p = db.products.find(x => x.id === i.product_id); if (p) { shopSet.set(p.id, r3((shopSet.has(p.id) ? shopSet.get(p.id) : shopOf(p)) + i.qty)); p.stock = roundQty(p.stock + i.qty); } });
    const c = s.customer_id ? db.customers.find(x => x.id === s.customer_id) : null;
    if (c && s.debt_amount) c.debt_balance = Math.max(0, int(c.debt_balance) - s.debt_amount);
    if (c) c.visits = Math.max(0, num(c.visits) - 1); // v16: a voided purchase does not count
    return s;
  }
  function addTransferConfirm(db, u, refType, ref, amount, who, bank, transferRef) {
    if (money(amount) <= 0) return null;
    return newApproval(db, u, { kind: 'transfer_confirm', approver_role: 'manager', ref: String(ref), total: money(amount), customer_name: String(who || ''), note: (String(bank || '') ? 'Bank ' + bank : '') + (String(transferRef || '') ? ' ref ' + transferRef : ''), summary: ('Konfirmasi transfer masuk ' + String(who || '') + ' Rp ' + money(amount) + ' (' + refType + ' ' + ref + ') — pastikan dana sudah masuk').slice(0, 1500), payload: JSON.stringify({ ref_type: refType, ref: String(ref), amount: money(amount), bank: String(bank || ''), transfer_ref: String(transferRef || ''), who: String(who || '') }) });
  }
  function newApproval(db, u, f) {
    const ap = Object.assign({ request_id: 'APR-' + String(nextId(db, 'approval')).padStart(4, '0'), client_id: '', created_at: jktISO(), cashier: u.name, customer_id: null, customer_name: '', customer_debt_before: 0, total: 0, debt_amount: 0, summary: '', status: 'pending', decided_by: '', decided_at: '', note: '', kind: 'credit', ref: '', payload: '', approver_role: 'manager' }, f);
    db.approvals.push(ap);
    return ap;
  }
  /* Stok opname (stock count): owner applies directly, others create an owner approval (kind 'opname'). */
  const OPNAME_SUPPLIER = 'STOK OPNAME';
  function opnameLog(db, p, diff, counted, system, note, user) {
    db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: OPNAME_SUPPLIER, product_id: p.id, name: p.name, qty: diff, cost_price: p.cost_price, total: 0, note: `${note || 'Stok opname'} (dihitung ${fmtQty(counted)}, sistem ${fmtQty(system)})`, user });
  }
  function stockCount(db, u, data) {
    if (u.role === 'sales') throw E('FORBIDDEN', 'Sales accounts cannot count stock');
    const counts = data.counts;
    if (!Array.isArray(counts) || !counts.length) throw E('INVALID', 'counts required');
    if (counts.length > 500) throw E('INVALID', 'max 500 lines per count');
    const seen = new Set();
    const lines = counts.map(c => {
      const p = db.products.find(x => x.id === Number(c && c.product_id));
      if (!p) throw E('NOT_FOUND', 'product ' + (c && c.product_id));
      if (seen.has(p.id)) throw E('INVALID', 'duplicate product ' + p.id);
      seen.add(p.id);
      if (c.counted === '' || c.counted == null || !Number.isFinite(Number(c.counted)) || Number(c.counted) < 0) throw E('INVALID', 'counted must be >= 0');
      const counted = roundQty(c.counted), system = roundQty(p.stock);
      return { product_id: p.id, name: p.name, unit: p.unit, system, counted, diff: roundQty(counted - system) };
    });
    const note = String(data.note || '').trim();
    const changed = lines.filter(l => l.diff !== 0);
    const cnt = 'Stok opname ' + lines.length + ' barang, ' + changed.length + ' selisih: ' + changed.slice(0, 20).map(l => l.name + ' ' + l.system + '→' + l.counted).join('; ');
    if (u.role === 'owner') logAct(db, u, 'opname', cnt, '', 0, changed.length ? 'warn' : 'info');
    else logAct(db, u, 'minta_opname', 'Minta ' + cnt, '', 0, 'info');
    if (u.role === 'owner') {
      const stock = lines.map(l => {
        const p = db.products.find(x => x.id === l.product_id);
        if (l.diff) opnameLog(db, p, l.diff, l.counted, l.system, note, u.name);
        p.stock = l.counted;
        return { product_id: p.id, stock: p.stock };
      });
      return { applied: true, lines, stock };
    }
    const diffs = lines.filter(l => l.diff);
    const summary = `Stok opname ${lines.length} barang, ${diffs.length} selisih` + (diffs.length ? ': ' + diffs.slice(0, 3).map(l => `${l.name} ${fmtQty(l.system)}→${fmtQty(l.counted)}`).join(', ') + (diffs.length > 3 ? ', …' : '') : '');
    const approval = newApproval(db, u, { kind: 'opname', approver_role: 'owner', summary, payload: JSON.stringify({ lines, counted_at: jktISO(), by: u.name, note }) });
    return { applied: false, request_id: approval.request_id, approval: approvalOut(approval, u.role), lines };
  }
  /** Approved opname: each line's diff is added to the CURRENT stock (sales made meanwhile are kept). */
  function applyOpname(db, ap, approver) {
    let pl = {}; try { pl = JSON.parse(ap.payload || '{}'); } catch (e) { }
    const by = pl.by || ap.cashier;
    return (pl.lines || []).map(l => {
      const p = db.products.find(x => x.id === Number(l.product_id)); if (!p) return null;
      const diff = roundQty(l.diff);
      if (diff) { p.stock = roundQty(num(p.stock) + diff); opnameLog(db, p, diff, l.counted, l.system, [pl.note, `oleh ${by}, disetujui ${approver}`].filter(Boolean).join(' · '), by); }
      return { product_id: p.id, stock: p.stock };
    }).filter(Boolean);
  }
  const nameTokens = s => norm(s).replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean).map(w => w === 'gr' ? 'g' : w);
  function nameScore(a, b) { const A = nameTokens(a), B = new Set(nameTokens(b)); return A.length ? A.filter(w => B.has(w)).length / A.length : 0; }
  const blankProduct = () => ({ sku: '', name: '', category: '', unit: 'pcs', cost_price: 0, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0, stock: 0, min_stock: 0, active: true, notes: '' });

  /* ---- v11–v13, as on the server: devices (deviceTouch), activity log (logAct), goods-in checked against the note and
     locked after saving (purchase_no, request_purchase_fix), customer payments matched with the transfer slip ---- */
  const str = v => v === undefined || v === null ? '' : String(v).trim();
  const money = v => Math.round(num(v));
  const fmtN = v => String(Math.round(num(v) * 1000) / 1000);
  function rand(n) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
  let lastRole = ''; // role of the authenticated caller (also via the owner's master code)
  let dirty = false; // read-only actions still save when a device row / activity row was written
  const LOG = []; // last requests as received (action, user, device) — for the tests
  function logAct(db, u, kind, summary, ref, amount, level) {
    db.activity = db.activity || [];
    db.activity.push({ id: nextId(db, 'activity'), act_id: 'AC' + rand(8), at: new Date().toISOString(), act_date: jktDate(), user: u.name, role: u.role, kind,
      summary: str(summary).slice(0, 1000), ref: str(ref).slice(0, 60), amount: money(amount), level: level || 'info' });
    dirty = true;
  }
  const isCoord = (lat, lng) => isFinite(Number(lat)) && isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && !(Number(lat) === 0 && Number(lng) === 0) && lat !== null && lat !== '' && lng !== null && lng !== '' && lat !== undefined && lng !== undefined;
  function metres(aLat, aLng, bLat, bLng) {
    const R = 6371000, k = Math.PI / 180, dLat = (bLat - aLat) * k, dLng = (bLng - aLng) * k;
    const x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * k) * Math.cos(bLat * k) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  /** Written only when something changed (new device, other user, status, moved > 100 m) or every 10 minutes. */
  function deviceTouch(db, u, dev, force) {
    if (!dev || typeof dev !== 'object') return null;
    const id = str(dev.id);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
    db.devices = db.devices || [];
    const ex = db.devices.find(x => x.device_id === id) || null;
    const now = new Date().toISOString();
    const hasLoc = isCoord(dev.lat, dev.lng);
    const status = ['granted', 'denied', 'unavailable', 'prompt', 'off'].indexOf(dev.loc_status) >= 0 ? dev.loc_status : (hasLoc ? 'granted' : 'unavailable');
    if (ex && !force) {
      const moved = hasLoc && (!isCoord(ex.lat, ex.lng) || metres(num(ex.lat), num(ex.lng), num(dev.lat), num(dev.lng)) > 100);
      const stale = !(Date.parse(ex.last_seen) > Date.now() - 600000);
      if (!moved && !stale && str(ex.user) === u.name && str(ex.loc_status) === status) return ex;
    }
    const row = {
      device_id: id, user: u.name, role: u.role, app: ['owner', 'kasir', 'sales'].indexOf(dev.app) >= 0 ? dev.app : 'owner',
      label: str(dev.label).slice(0, 60), ua: str(navigator.userAgent).slice(0, 300), ip: '',
      lat: hasLoc ? Math.round(num(dev.lat) * 1e6) / 1e6 : (ex ? num(ex.lat) : 0), lng: hasLoc ? Math.round(num(dev.lng) * 1e6) / 1e6 : (ex ? num(ex.lng) : 0),
      acc: hasLoc ? Math.round(num(dev.acc)) : (ex ? num(ex.acc) : 0), loc_status: status, loc_at: hasLoc ? now : (ex ? str(ex.loc_at) : ''),
      first_seen: ex ? str(ex.first_seen) || now : now, last_seen: now, pings: (ex ? num(ex.pings) : 0) + 1,
      battery: isFinite(Number(dev.battery)) && dev.battery !== null && dev.battery !== '' && dev.battery !== undefined ? Math.round(Math.min(1, Math.max(0, num(dev.battery))) * 100) / 100 : (ex ? num(ex.battery) : 0)
    };
    if (ex) Object.assign(ex, row); else db.devices.push(Object.assign({ id: nextId(db, 'device') }, row));
    dirty = true;
    if (!ex) logAct(db, u, 'perangkat_baru', 'Perangkat baru: ' + (row.label || 'tanpa nama') + ' (' + row.app + ', ' + u.name + ')' + (row.ip ? ' IP ' + row.ip : ''), id, 0, 'info');
    return row;
  }
  /* Purchase correction (only with manager / owner approval): target lines vs what the rows of that note say now. */
  function purchaseFixChanges(rows, lines) {
    const cur = {};
    rows.forEach(r => {
      const k = String(r.product_id);
      if (!cur[k]) cur[k] = { qty: 0, total: 0, supplier: str(r.supplier), name: str(r.name) };
      cur[k].qty = Math.round((cur[k].qty + num(r.qty)) * 1000) / 1000;
      cur[k].total += money(r.total);
    });
    const changes = [];
    (Array.isArray(lines) ? lines : []).slice(0, 100).forEach(l => {
      const c = cur[String(l.product_id)];
      if (!c) return;
      const qty = Math.round(num(l.qty) * 1000) / 1000;
      if (qty < 0) return;
      const cost = l.cost_price === undefined || l.cost_price === null || l.cost_price === '' ? (c.qty > 0 ? Math.round(c.total / c.qty) : 0) : money(l.cost_price);
      const total = Math.round(qty * cost);
      const dq = Math.round((qty - c.qty) * 1000) / 1000, dt = total - c.total;
      if (dq !== 0 || dt !== 0) changes.push({ product_id: Number(l.product_id), name: c.name, supplier: c.supplier, from_qty: c.qty, to_qty: qty, from_total: c.total, to_total: total, cost_price: cost, d_qty: dq, d_total: dt });
    });
    return { found: Object.keys(cur).length > 0, changes };
  }
  function applyPurchaseFix(db, u, no, changes, reason, byName) {
    const out = [];
    changes.forEach(ch => {
      const p = db.products.find(x => x.id === Number(ch.product_id));
      if (!p) return;
      const st = num(p.stock), ns = Math.round((st + ch.d_qty) * 1000) / 1000;
      const nc = ns > 0 && st + ch.d_qty > 0 ? Math.max(0, Math.round((Math.max(0, st) * money(p.cost_price) + ch.d_total) / Math.max(ns, 0.001))) : money(p.cost_price);
      p.stock = ns; p.cost_price = nc;
      db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: ch.supplier, product_id: p.id, name: str(p.name), qty: ch.d_qty, cost_price: ch.cost_price, total: ch.d_total,
        note: ('KOREKSI ' + no + ': ' + fmtN(ch.from_qty) + '→' + fmtN(ch.to_qty) + ' | ' + str(reason)).slice(0, 500), user: byName, photo_id: '', exp_date: '',
        purchase_no: no, match_status: 'koreksi', match_notes: str(reason).slice(0, 300) });
      const o = { product_id: p.id, stock: ns };
      if (u.role === 'owner') o.cost_price = nc;
      out.push(o);
    });
    return out;
  }
  const fixSummary = (no, changes) => 'Koreksi barang masuk ' + no + ': ' + changes.map(c => c.name + ' ' + fmtN(c.from_qty) + '→' + fmtN(c.to_qty) + (c.d_total ? ' (Rp ' + c.from_total + '→' + c.to_total + ')' : '')).join('; ');
  /* Payments (v13), as on the server: open documents of a party (customer → sales with debt, total = debt_amount;
     supplier → goods-in notes), paid = what other payments allocated to them. */
  const parseAlloc = a => { if (Array.isArray(a)) return a; try { const x = JSON.parse(a || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; } };
  const parseObj = o => { if (o && typeof o === 'object') return o; try { return JSON.parse(o || '{}') || {}; } catch (e) { return {}; } };
  const payDir = p => str(p.direction) || 'in';
  function partyDocs(db, pt, key, excludePayId) {
    const docs = {};
    if (pt === 'customer') {
      db.sales.filter(x => Number(x.customer_id) === Number(key) && x.status !== 'void' && money(x.debt_amount) > 0)
        .forEach(x => { docs[x.invoice_no] = { ref: x.invoice_no, date: str(x.sale_date), total: money(x.debt_amount), paid: 0 }; });
    } else {
      db.purchases.filter(x => str(x.supplier) === key).forEach(x => {
        const ref = str(x.purchase_no) || ('PB-' + str(x.purchase_date));
        if (!docs[ref]) docs[ref] = { ref, date: str(x.purchase_date), total: 0, paid: 0 };
        docs[ref].total += money(x.total);
        if (str(x.purchase_date) < docs[ref].date) docs[ref].date = str(x.purchase_date);
      });
    }
    db.payments.forEach(p => {
      if (excludePayId && p.pay_id === excludePayId) return;
      const mine = pt === 'customer' ? (Number(p.customer_id) === Number(key) && payDir(p) === 'in') : (str(p.supplier) === key && payDir(p) === 'out');
      if (!mine) return;
      parseAlloc(p.alloc).forEach(a => { if (docs[a.ref]) docs[a.ref].paid += money(a.amount); });
    });
    // v16: what payments left unallocated goes to the oldest open documents first (auto: true)
    const list = Object.keys(docs).map(k => docs[k]).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let free = 0;
    db.payments.forEach(p => {
      if (excludePayId && p.pay_id === excludePayId) return;
      const mine = pt === 'customer' ? (Number(p.customer_id) === Number(key) && payDir(p) === 'in') : (str(p.supplier) === key && payDir(p) === 'out');
      if (mine) free += Math.max(0, money(p.amount) - sum(parseAlloc(p.alloc), a => money(a.amount)));
    });
    for (const d of list) { if (free <= 0) break; const left = Math.max(0, d.total - d.paid); const x = Math.min(free, left); if (x > 0) { d.paid += x; d.auto = true; free -= x; } }
    Object.keys(docs).forEach(k => { docs[k].remaining = Math.max(0, docs[k].total - docs[k].paid); });
    return docs;
  }
  function checkAlloc(list, docs, amount) {
    const out = [], seen = {};
    let total = 0;
    const arr = Array.isArray(list) ? list.slice(0, 50) : [];
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i] || {};
      const ref = str(a.ref || a.invoice_no || a.purchase_no), amt = money(a.amount);
      if (!ref || !(amt > 0)) return { error: 'Alokasi tidak valid' };
      if (!docs[ref]) return { error: 'Faktur / nota tidak ditemukan untuk pihak ini: ' + ref };
      if (seen[ref]) return { error: 'Faktur dobel di alokasi: ' + ref };
      seen[ref] = true;
      if (amt > docs[ref].remaining) return { error: 'Alokasi ' + ref + ' melebihi sisa (' + docs[ref].remaining + ')' };
      total += amt;
      out.push({ ref, amount: amt });
    }
    if (total > amount) return { error: 'Total alokasi melebihi jumlah pembayaran' };
    return { alloc: out, sum: total };
  }
  function allocStatus(amount, chk, docs) {
    if (!chk.alloc.length) return 'belum_dialokasi';
    if (chk.alloc.some(a => docs[a.ref].remaining - a.amount > 0)) return 'sebagian';
    if (chk.sum < amount) return 'lebih';
    return 'lunas';
  }
  const dupRef = (db, ref) => !!str(ref) && db.payments.some(p => str(p.transfer_ref) && str(p.transfer_ref).toLowerCase() === str(ref).toLowerCase());
  const payOut = p => Object.assign({}, p, { alloc: parseAlloc(p.alloc) });
  function payAccount(db, method, want) {
    if (method !== 'transfer' && method !== 'qris') return '';
    const accs = (Array.isArray(db.settings.bank_accounts) ? db.settings.bank_accounts : []).filter(x => x && str(x.id));
    if (str(want) && accs.some(x => str(x.id) === str(want))) return str(want);
    const act = accs.filter(x => x.active !== false);
    return act.length ? str(act[0].id) : '';
  }

  /* ---- v16 (mirrors the server): discount limit, members, cost never to kasir/manager, own PINs ---- */
  const maxDiscPct = db => { const v = num(db.settings.max_discount_pct); return v > 0 ? v : 3; };
  const DEFAULT_TIERS = [{ from: 2, pct: 2 }, { from: 5, pct: 3 }, { from: 10, pct: 5 }];
  /** A member's discount for this purchase: tier of (visits + 1); first purchase → 0 %. */
  function memberInfo(db, c) {
    if (!c || c.member !== true || db.settings.member_enabled === false) return null;
    const n = Math.max(0, Math.round(num(c.visits))) + 1;
    const tiers = Array.isArray(db.settings.member_tiers) ? db.settings.member_tiers : DEFAULT_TIERS;
    let pct = 0;
    tiers.forEach(t => { const f = num(t && t.from), q = num(t && t.pct); if (f >= 1 && f <= n && q > 0 && q <= 50 && q > pct) pct = q; });
    return { pct, purchase_no: n, member_no: str(c.member_no) };
  }
  const discountOf = P => { const amount = Math.max(0, P.listTotal - (P.total - (P.sendFee || 0))); return { amount, pct: P.listTotal > 0 ? Math.round(amount / P.listTotal * 1000) / 10 : 0 }; };
  const marginPct = (total, cost) => total > 0 ? Math.round((total - cost) / total * 1000) / 10 : 0;
  /** What a non-owner may see of an approval: no profit (discount), quantities only (purchase fix). */
  function approvalOut(a, role) {
    if (!a) return a;
    const o = Object.assign({}, a);
    if (role !== 'owner') {
      if (a.kind === 'discount' && role !== 'manager') { // (07 Oct) owner and manager see the profit; kasir never
        const pl = parseObj(a.payload); ['profit_before', 'profit_after', 'margin_before', 'margin_after', 'cost'].forEach(f => { delete pl[f]; });
        o.payload = JSON.stringify(pl); o.summary = str(o.summary).replace(/ \| laba[^|]*/g, '');
      }
      if (a.kind === 'purchase_fix') {
        const pl = parseObj(a.payload);
        if (Array.isArray(pl.changes)) pl.changes = pl.changes.map(qtyOnly);
        o.payload = JSON.stringify(pl); o.summary = str(o.summary).replace(/ \(Rp -?\d+→-?\d+\)/g, ''); o.total = 0;
      }
      if (a.kind === 'retur') {
        // supplier returns are valued at purchase cost: only the owner sees the amounts
        const pl = parseObj(a.payload);
        if (pl.kind === 'pemasok') {
          delete pl.value; delete pl.refund; (pl.lines || []).forEach(l => { delete l.unit_price; delete l.value; });
          o.payload = JSON.stringify(pl); o.total = 0; o.summary = str(o.summary).replace(/ \| nilai Rp -?\d+/g, '');
        }
      }
    }
    o.can_decide = role === 'owner' || (role === 'manager' && a.approver_role !== 'owner');
    return o;
  }
  const qtyOnly = c => { const x = Object.assign({}, c); ['cost_price', 'from_total', 'to_total', 'd_total'].forEach(f => { delete x[f]; }); return x; };
  /* v16 warehouse (gudang) and shelf (toko): stock = total, shop_stock = on the shelf; a product without shop_stock counts all
     its stock as on the shelf. Only sales, voids and move_stock set the shelf (shopSet); every other change of a product row
     keeps its shelf, capped at the total — goods-in, corrections and counts therefore land in the warehouse. */
  const shopOf = p => p.shop_stock === undefined || p.shop_stock === null || p.shop_stock === '' ? num(p.stock) : num(p.shop_stock);
  const r3 = v => Math.round(num(v) * 1000) / 1000;
  const productOut = p => Object.assign({}, p, { shop_stock: shopOf(p), gudang_stock: r3(num(p.stock) - shopOf(p)) });
  const shopSet = new Map();
  function normShop(db, snap) {
    db.products.forEach(p => {
      const was = snap.get(p.id), written = !was || was.json !== JSON.stringify(p) || shopSet.has(p.id);
      if (!written) return;
      const st = num(p.stock);
      let sh = shopSet.has(p.id) ? shopSet.get(p.id) : (was ? was.shop : st);
      if (sh > st) sh = st;
      if (sh < 0 && st >= 0) sh = 0;
      p.shop_stock = r3(sh);
    });
  }
  /* ---- v16 returns (retur), who brought the goods (carrier) and strict text fields — as on the server ---- */
  // Everything the apps send is plain text: control / direction-override characters and < > (and tags) are removed,
  // __proto__ / constructor / prototype keys are dropped, strings are cut at 4000 characters.
  const CODE_RUN = /[<>{}\[\];`$\\|=]{3,}/, CODE_TOK = /<\s*\/?\s*script\b|<\/[a-z]|javascript:|\$\{|=>|\beval\s*\(|\bfunction\s*\(|\b(?:document|window|globalThis|self)\s*\.\s*[a-z_$]|\brequire\s*\(|\bimport\s*\(/i;
  function scanCodeAttempt(o, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 6) return '';
    let hit = '';
    Object.keys(o).some(k => {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
      const v = o[k];
      if (typeof v === 'string') { if (CODE_RUN.test(v) || CODE_TOK.test(v)) { hit = v.slice(0, 60); return true; } }
      else if (v && typeof v === 'object') { hit = scanCodeAttempt(v, (depth || 0) + 1); if (hit) return true; }
      return false;
    });
    return hit;
  }
  function cleanInput(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    Object.keys(o).forEach(k => {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') { delete o[k]; return; }
      const v = o[k];
      if (typeof v === 'string') o[k] = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').slice(0, 4000);
      else if (v && typeof v === 'object') cleanInput(v, depth + 1);
    });
  }
  const AGREED_KEYS = ['return_owner_min_value', 'return_owner_min_qty'];
  const RETURN_REASONS = ['tidak_sesuai', 'rusak', 'kadaluarsa', 'salah_kirim', 'kualitas_buruk', 'berubah_pikiran', 'lainnya'];
  const RETURN_REASON_TEXT = { tidak_sesuai: 'Tidak sesuai spesifikasi', rusak: 'Rusak / cacat', kadaluarsa: 'Kedaluwarsa', salah_kirim: 'Salah kirim / salah barang', kualitas_buruk: 'Kualitas buruk', berubah_pikiran: 'Pelanggan berubah pikiran', lainnya: 'Lainnya' };
  const personName = v => { const x = str(v).replace(/\s+/g, ' '); return /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'-]{0,59}$/u.test(x) ? x : ''; };
  const safeName = (v, max) => { const x = str(v).replace(/\s+/g, ' '); return x.length <= (max || 80) && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'&()\/%+#-]*$/u.test(x) ? x : ''; };
  const docNo = v => { const x = str(v).toUpperCase().replace(/\s+/g, ' '); return /^[A-Z0-9][A-Z0-9 \/.-]{0,39}$/.test(x) ? x : ''; };
  const CARRIER_TYPES = ['umum', 'teman', 'pemasok', 'karyawan'];
  function readCarrier(c, required) {
    c = c && typeof c === 'object' ? c : {};
    const type = CARRIER_TYPES.indexOf(c.type) >= 0 ? c.type : '';
    if (!type) return required ? { error: 'Pilih siapa yang membawa barang (kendaraan umum / teman / sopir pemasok / karyawan)' } : { type: '', name: '', vehicle: '', phone: '' };
    const name = str(c.name) ? personName(c.name) : '';
    if (str(c.name) && !name) return { error: 'Nama pembawa barang hanya boleh huruf' };
    const vehicle = str(c.vehicle) ? docNo(c.vehicle) : '';
    if (str(c.vehicle) && !vehicle) return { error: 'Nomor kendaraan hanya boleh huruf dan angka' };
    const phone = str(c.phone) ? normPhone(c.phone) : '';
    if (str(c.phone) && !phone) return { error: 'Nomor HP pembawa tidak valid' };
    if (type === 'umum' && !vehicle) return { error: 'Kendaraan umum: tulis nomor kendaraannya (plat / nomor angkot)' };
    if ((type === 'teman' || type === 'karyawan') && !name) return { error: 'Tulis nama orang yang membawa barang' };
    const kindText = str(c.kind) ? str(c.kind).replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 30) : '';
    return { type, name: name || kindText, vehicle, phone };
  }
  /** Quantities already returned (approved returns + pending requests) for one invoice / goods-in note. */
  function returnedBefore(db, ref) {
    const q = {};
    const add = lines => (Array.isArray(lines) ? lines : []).forEach(l => { const k = String(l.product_id); q[k] = Math.round(((q[k] || 0) + num(l.qty)) * 1000) / 1000; });
    (db.returns || []).filter(r => str(r.ref) === ref && r.status === 'approved').forEach(r => { let l = []; try { l = JSON.parse(r.lines || '[]'); } catch (e) { l = []; } add(l); });
    db.approvals.filter(a => a.kind === 'retur' && a.status === 'pending').forEach(a => { let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; } if (str(pl.ref) === ref) add(pl.lines); });
    return q;
  }
  function returnOut(r, role) {
    if (!r) return null;
    const o = JSON.parse(JSON.stringify(r));
    if (typeof o.lines === 'string') { try { o.lines = JSON.parse(o.lines); } catch (e) { o.lines = []; } }
    if (role === 'kasir' && o.kind === 'pemasok') return null;
    if (role !== 'owner' && o.kind === 'pemasok') { delete o.value; delete o.refund; (o.lines || []).forEach(l => { delete l.unit_price; delete l.value; }); }
    return o;
  }
  const isHex64 = h => /^[0-9a-f]{64}$/.test(String(h || ''));
  const lockMsg = until => 'Terlalu banyak PIN salah. Coba lagi jam ' + new Date(Date.parse(until) + 7 * 3600000).toISOString().slice(11, 16) + ' WIB';

  function handle(db, body) {
    const { action, key, user, pin_hash } = body;
    const data = body.data || {};
    if (key !== 'demo') throw E('BAD_KEY', 'Store key not found');
    if (action === 'users') return { users: db.users.filter(u => u.active).map(u => ({ name: u.name, role: u.role })) };
    if (action === 'setup') {
      if (db.users.length) throw E('FORBIDDEN', 'Users already exist');
      const name = String(data.owner_name || '').trim();
      if (!name || !/^[0-9a-f]{64}$/.test(data.pin_hash || '')) throw E('INVALID', 'owner_name and pin_hash required');
      db.users.push({ name, role: 'owner', pin_hash: data.pin_hash, active: true });
      return { user: { name, role: 'owner' } };
    }
    if (!db.users.length) throw E('NO_USERS', 'Run setup first');
    // v16 (as on the server): lock after 5 wrong PINs in a row (15 min), owner master code opens every account, own PIN at first login
    const u = db.users.find(x => x.active !== false && x.name.toLowerCase() === String(user || '').trim().toLowerCase());
    if (!u) throw E('BAD_PIN', 'Nama atau PIN salah');
    if (Date.parse(u.locked_until) > Date.now()) throw E('LOCKED', lockMsg(u.locked_until), { locked_until: str(u.locked_until) });
    const masterOwner = isHex64(pin_hash) && u.pin_hash !== pin_hash ? db.users.find(x => x.active !== false && x.role === 'owner' && isHex64(x.master_hash) && x.master_hash === pin_hash) || null : null;
    const viaMaster = !!masterOwner;
    if (u.pin_hash !== pin_hash && !viaMaster) {
      const fc = num(u.fail_count) + 1, until = fc >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : '';
      u.fail_count = until ? 0 : fc; u.locked_until = until;
      save(db); // the failure is written although the request fails
      if (until) throw E('LOCKED', lockMsg(until), { locked_until: until });
      throw E('BAD_PIN', 'Nama atau PIN salah' + (fc >= 3 ? ' (' + (5 - fc) + ' kali lagi, lalu akun dikunci 15 menit)' : ''));
    }
    if ((num(u.fail_count) > 0 || str(u.locked_until)) && !['change_pin', 'set_master', 'save_user'].includes(action)) { u.fail_count = 0; u.locked_until = ''; dirty = true; }
    if (u.must_change === true && !viaMaster && !['login', 'change_pin', 'users', 'device_ping'].includes(action)) throw E('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
    lastRole = u.role;
    if (u.role === 'sales' && !['login', 'bootstrap', 'device_ping', 'change_pin'].includes(action)) throw E('FORBIDDEN', 'Akun sales memakai aplikasi Khair Sales');
    if (action !== 'device_ping') deviceTouch(db, u, data.device, false);
    const owner = u.role === 'owner';
    const needOwner = () => { if (!owner) throw E('FORBIDDEN', 'Owner only'); };
    // v19 anti-tamper: a clear code attempt locks a non-owner account (only the owner opens it, from the owner app).
    const lockedSet = () => Array.isArray(db.settings.locked_accounts) ? db.settings.locked_accounts.map(x => String(x).toLowerCase()) : [];
    const isLockedAcct = n => lockedSet().indexOf(String(n).trim().toLowerCase()) >= 0;
    const codeHit = body.__codeHit || '';
    if (codeHit && !owner) { if (!isLockedAcct(u.name)) db.settings.locked_accounts = lockedSet().concat([u.name.toLowerCase()]); logAct(db, u, 'tamper', 'Percobaan menulis kode — akun dikunci: "' + codeHit + '" (aksi ' + action + ')', u.name, 0, 'danger'); const er = E('TAMPER', 'Input tidak sah. Akun dikunci, hanya pemilik yang membuka.'); er.extra = { locked: true }; throw er; }
    if (codeHit && owner) { logAct(db, u, 'tamper', 'Input ditolak (karakter kode): "' + codeHit + '" (aksi ' + action + ')', u.name, 0, 'warn'); dirty = true; throw E('INVALID', 'Input tidak sah (karakter kode tidak diperbolehkan)'); }
    if (!owner && isLockedAcct(u.name) && !['login', 'users', 'device_ping', 'change_pin', 'report_tamper'].includes(action)) { const er = E('TAMPER_LOCKED', 'Akun dikunci setelah percobaan tidak sah. Hanya pemilik yang membuka.'); er.extra = { locked: true }; throw er; }
    const prodById = id => db.products.find(p => p.id === Number(id));
    const custById = id => db.customers.find(c => c.id === Number(id));

    switch (action) {
      case 'att_bootstrap': case 'worker_save': case 'worker_enroll': case 'worker_forget': case 'att_mark': case 'att_report': case 'att_settings':
        if (!window.KAttMock || !window.KAtt) throw E('SERVER', 'Attendance mock not loaded');
        return window.KAttMock.handle(db, u, action, data, E);
      case 'login':
        if (viaMaster) logAct(db, u, 'masuk_master', 'Masuk ke akun ' + u.name + ' (' + u.role + ') dengan kode pemilik', u.name, 0, 'warn');
        return { user: { name: u.name, role: u.role }, must_change: u.must_change === true && !viaMaster, via_master: viaMaster, tamper_locked: u.role !== 'owner' && isLockedAcct(u.name) };
      case 'report_tamper':
        if (owner) { logAct(db, u, 'tamper', 'Pemilik: percobaan kode terdeteksi (' + String(data.where || '').slice(0, 60) + ')', u.name, 0, 'warn'); dirty = true; return { locked: false }; }
        if (!isLockedAcct(u.name)) db.settings.locked_accounts = lockedSet().concat([u.name.toLowerCase()]);
        logAct(db, u, 'tamper', 'Percobaan menulis kode — akun dikunci (' + String(data.where || '').slice(0, 60) + ')', u.name, 0, 'danger'); dirty = true;
        return { locked: true };
      case 'move_stock': {
        // warehouse → shelf (to "toko") or back (to "gudang"); the shelf only gets what is in the warehouse
        const toShop = data.to !== 'gudang';
        const lines = Array.isArray(data.lines) ? data.lines.slice(0, 200) : [];
        if (!lines.length) throw E('INVALID', 'Pilih barang yang dipindah');
        const agg = new Map();
        for (const l of lines) {
          const p = prodById(l && l.product_id);
          if (!p) throw E('NOT_FOUND', 'Produk tidak ditemukan: ' + (l && l.product_id));
          const q = r3(l.qty);
          if (!(q > 0)) throw E('INVALID', 'Jumlah tidak valid: ' + str(p.name));
          agg.set(p.id, r3((agg.get(p.id) || 0) + q));
        }
        const short = [], out = [];
        agg.forEach((q, pid) => {
          const p = prodById(pid), sh = shopOf(p), gd = r3(num(p.stock) - sh);
          if (toShop && q > gd + 1e-9) short.push(str(p.name) + ': gudang ' + fmtN(Math.max(0, gd)) + (gd <= 0 ? ' — belum ada barang masuk dengan nota' : ''));
          else if (!toShop && q > sh + 1e-9) short.push(str(p.name) + ': rak ' + fmtN(Math.max(0, sh)));
          else out.push({ p, q, sh: r3(sh + (toShop ? q : -q)) });
        });
        if (short.length) throw E(toShop ? 'NOT_IN_GUDANG' : 'NOT_ON_SHELF', (toShop ? 'Tidak bisa pindah ke toko — stok gudang kurang: ' : 'Stok rak kurang: ') + short.join('; '));
        out.forEach(x => shopSet.set(x.p.id, x.sh));
        const note = str(data.note).slice(0, 200);
        logAct(db, u, 'pindah_stok', (toShop ? 'Gudang → toko: ' : 'Toko → gudang: ') + out.map(x => str(x.p.name) + ' ' + fmtN(x.q) + ' ' + str(x.p.unit)).join('; ') + (note ? ' | ' + note : ''), '', 0, 'info');
        return { stock: out.map(x => ({ product_id: x.p.id, stock: num(x.p.stock), shop_stock: x.sh, gudang_stock: r3(num(x.p.stock) - x.sh) })) };
      }
      case 'change_pin': {
        const h = data.new_pin_hash;
        if (!isHex64(h)) throw E('INVALID', 'PIN baru tidak valid');
        if (h === u.pin_hash) throw E('INVALID', 'PIN baru harus berbeda dari PIN lama');
        if (viaMaster && u.role === 'owner') throw E('FORBIDDEN', 'PIN pemilik hanya bisa diganti dengan PIN pemilik sendiri');
        if (db.users.some(x => x.active !== false && isHex64(x.master_hash) && x.master_hash === h)) throw E('INVALID', 'PIN baru tidak valid');
        Object.assign(u, { pin_hash: h, must_change: viaMaster, fail_count: 0, locked_until: '' });
        logAct(db, u, 'ganti_pin', viaMaster ? 'PIN ' + u.name + ' direset dengan kode pemilik (wajib ganti saat masuk)' : u.name + ' mengganti PIN sendiri', u.name, 0, viaMaster ? 'warn' : 'info');
        return { must_change: viaMaster };
      }
      case 'set_master': {
        if (u.role !== 'owner' || viaMaster) throw E('FORBIDDEN', 'Hanya pemilik dengan PIN sendiri');
        if (!isHex64(data.master_hash) || data.master_hash === u.pin_hash) throw E('INVALID', 'Kode pemilik tidak valid');
        if (db.users.some(x => x.pin_hash === data.master_hash)) throw E('INVALID', 'Kode pemilik tidak valid');
        const had = isHex64(u.master_hash);
        Object.assign(u, { master_hash: data.master_hash, fail_count: 0, locked_until: '' });
        logAct(db, u, 'kode_pemilik', 'Kode pemilik ' + (had ? 'diganti' : 'dibuat'), u.name, 0, 'warn');
        return {};
      }
      case 'request_discount': {
        // v16: a kasir above max_discount_pct (+ member %) asks the manager / owner first
        if (!data.client_id) throw E('INVALID', 'client_id wajib');
        const P = priceSale(db, data, true);
        const disc = discountOf(P), mem = memberInfo(db, P.cust), allowed = maxDiscPct(db) + (mem ? mem.pct : 0);
        if (disc.pct <= allowed + 1e-9) throw E('INVALID', 'Diskon ' + disc.pct + '% masih dalam batas, tidak perlu persetujuan');
        const profitBefore = P.listTotal - P.total_cost, profitAfter = P.total - P.total_cost;
        const mb = marginPct(P.listTotal, P.total_cost), ma = marginPct(P.total, P.total_cost);
        const reason = str(data.reason).slice(0, 300);
        const ap = newApproval(db, u, {
          kind: 'discount', approver_role: 'manager', client_id: String(data.client_id), ref: String(data.client_id),
          customer_id: P.cust ? P.cust.id : 0, customer_name: P.cust ? str(P.cust.name) : str(data.customer_name || 'Umum'),
          total: P.total, debt_amount: disc.amount, note: reason,
          summary: ('Diskon ' + disc.pct + '% (Rp ' + disc.amount + '): Rp ' + P.listTotal + ' → Rp ' + P.total + ' — ' + P.lines.map(l => l.p.name + ' x' + l.qty + ' @' + l.unit_price).join('; ') +
            ' | laba ' + mb + '% → ' + ma + '% (Rp ' + profitBefore + ' → Rp ' + profitAfter + ')').slice(0, 1500),
          payload: JSON.stringify({ list_total: P.listTotal, total: P.total, discount: disc.amount, pct: disc.pct, max_pct: maxDiscPct(db), member_pct: mem ? mem.pct : 0, reason,
            lines: P.lines.map(l => ({ name: l.p.name, qty: l.qty, unit_price: l.unit_price })),
            profit_before: profitBefore, profit_after: profitAfter, margin_before: mb, margin_after: ma })
        });
        logAct(db, u, 'minta_diskon', 'Minta diskon ' + disc.pct + '% (Rp ' + disc.amount + ') total Rp ' + P.listTotal + ' → Rp ' + P.total + ' | laba ' + mb + '% → ' + ma + '%' + (reason ? ' | ' + reason : ''), ap.request_id, disc.amount, 'warn');
        return { request_id: ap.request_id, approval: approvalOut(ap, u.role) };
      }
      case 'device_ping': {
        if (!deviceTouch(db, u, data.device, true)) throw E('INVALID', 'device.id tidak valid');
        return { require_location: db.settings.require_device_location === true, server_time: new Date().toISOString() };
      }
      case 'bootstrap': return { products: db.products.map(productOut), customers: db.customers, settings: Object.assign({}, V16_DEFAULTS, db.settings), via_master: viaMaster, must_change: u.must_change === true && !viaMaster,
        users: db.users.map(x => u.role === 'owner' ? { name: x.name, role: x.role, active: x.active !== false, must_change: x.must_change === true, locked: Date.parse(x.locked_until) > Date.now(), has_master: x.role === 'owner' && isHex64(x.master_hash) } : { name: x.name, role: x.role, active: x.active !== false }), server_time: new Date().toISOString(), approvals_pending: ['owner', 'manager'].includes(u.role) ? db.approvals.filter(x => x.status === 'pending').length : 0,
        shift: blind(shiftSummary(db, openShiftOf(db, u.name)), u.role), open_shifts: ['owner', 'manager'].includes(u.role) ? db.shifts.filter(x => x.status === 'open').map(x => shiftSummary(db, x)) : [] };

      case 'save_sale': {
        const cid = String(data.client_id || '');
        if (!cid) throw E('INVALID', 'client_id required');
        const ex = db.sales.find(s => s.client_id === cid);
        if (ex) {
          const { id: _o, ...exOut } = ex;
          const ids = [...new Set(db.items.filter(i => i.invoice_no === ex.invoice_no).map(i => i.product_id))];
          return { invoice_no: ex.invoice_no, sale: exOut, stock: ids.map(id => ({ product_id: id, stock: prodById(id) ? prodById(id).stock : 0 })), duplicate: true, exit_photo_required: ex.exit_photo === 'required' };
        }
        const shift = openShiftOf(db, u.name);
        if (!shift && u.role === 'kasir' && db.settings.require_shift !== false) throw E('SHIFT_REQUIRED', 'Buka kasir (shift) dulu'); // v15: only kasir accounts need a drawer
        const P = priceSale(db, data);
        // v16: only goods already on the shop shelf can be sold (a sale queued offline is never refused: queued: true)
        const qtyBy = new Map(); P.lines.forEach(l => qtyBy.set(l.p.id, r3((qtyBy.get(l.p.id) || 0) + l.qty)));
        const notOnShelf = [];
        qtyBy.forEach((q, pid) => { const p = prodById(pid), sh = shopOf(p); if (q > sh + 1e-9) notOnShelf.push({ product_id: p.id, name: str(p.name), need: q, shop: sh, gudang: r3(num(p.stock) - sh) }); });
        if (notOnShelf.length && db.settings.sell_from_shop_only !== false && data.queued !== true) {
          throw E('NOT_ON_SHELF', 'Barang belum ada di rak toko: ' + notOnShelf.map(x => x.name + ' (perlu ' + fmtN(x.need) + ', rak ' + fmtN(x.shop) + ', gudang ' + fmtN(x.gudang) + (x.gudang <= 0 ? ' — belum ada barang masuk dengan nota' : ' — pindahkan dulu dari gudang') + ')').join('; '), { items: notOnShelf });
        }
        let approved_by = '', usedApproval = null;
        if (P.debt > 0 && u.role === 'kasir') {
          if (data.approver && data.approver.user) {
            const a = db.users.find(x => x.active && ['owner', 'manager'].includes(x.role) && x.name.toLowerCase() === String(data.approver.user).toLowerCase());
            if (!a || a.pin_hash !== data.approver.pin_hash) throw E('APPROVAL_REQUIRED', 'Approver PIN wrong or approver not allowed');
            approved_by = a.name;
          } else if (data.approval_id) {
            const ap = db.approvals.find(x => x.request_id === data.approval_id);
            if (!ap || ap.status !== 'approved' || ap.client_id !== cid || ap.customer_id !== (P.cust ? P.cust.id : null) || ap.total < P.total || ap.debt_amount < P.debt) throw E('APPROVAL_REQUIRED', 'Approval not valid for this sale');
            approved_by = ap.decided_by; usedApproval = ap;
          } else throw E('APPROVAL_REQUIRED', 'Credit sale needs owner/manager approval');
        } else if (P.debt > 0) approved_by = u.name;
        // v16: discount above max_discount_pct (+ member %) needs an approved request for a kasir
        const disc = discountOf(P), mem = memberInfo(db, P.cust), allowedPct = maxDiscPct(db) + (mem ? mem.pct : 0);
        let discBy = '', usedDisc = null;
        if (disc.pct > allowedPct + 1e-9) {
          if (u.role === 'kasir') {
            const da = data.discount_approval_id ? db.approvals.find(x => x.request_id === String(data.discount_approval_id)) : null;
            if (!da || da.kind !== 'discount') throw E('DISCOUNT_APPROVAL_REQUIRED', 'Diskon ' + disc.pct + '% melebihi batas ' + allowedPct + '%: minta persetujuan manajer / pemilik');
            if (da.status !== 'approved') throw E('DISCOUNT_APPROVAL_REQUIRED', da.status === 'rejected' ? 'Diskon ditolak: ' + str(da.note) : 'Diskon belum disetujui');
            if (da.client_id !== cid || disc.amount > int(da.debt_amount)) throw E('DISCOUNT_APPROVAL_REQUIRED', 'Transaksi berubah setelah diskon disetujui, minta persetujuan lagi');
            discBy = str(da.decided_by); usedDisc = da;
          } else discBy = u.name;
        }
        const st = db.settings;
        const minTotal = int(st.exit_photo_min_total ?? 1000000), minQty = num(st.exit_photo_min_qty ?? 20);
        const exitReq = (minTotal > 0 && P.total >= minTotal) || (minQty > 0 && P.lines.some(l => l.qty >= minQty));
        const { cust, lines, subtotal, discount, total, total_cost, paid, debt, sale_date } = P;
        const sale = {
          id: nextId(db, 'sale'), invoice_no: invoiceNo(db, sale_date), sale_date, sale_time: data.sale_time || jktISO(),
          cashier: u.name, customer_id: cust ? cust.id : null, customer_name: cust ? cust.name : (data.customer_name || 'Umum'),
          customer_type: cust ? cust.type : 'eceran', subtotal, discount, send_fee: P.sendFee, total, total_cost, profit: total - total_cost,
          payment_method: data.payment_method, paid_amount: paid, debt_amount: debt, status: 'ok',
          survey: JSON.stringify(data.survey_consent && Array.isArray(data.survey) ? data.survey.filter(x => x && String(x.a || '').trim()).map(x => ({ q: String(x.q), a: String(x.a) })) : []),
          survey_transcript: data.survey_consent === true ? String(data.survey_transcript || '').trim().slice(0, 4000) : '',
          notes: (String(data.notes || '') + (mem && mem.pct > 0 ? ' [member ' + mem.pct + '% · pembelian ke-' + mem.purchase_no + ']' : '') + (discBy ? ' [diskon ' + disc.pct + '% disetujui ' + discBy + ']' : '')).trim(), client_id: cid, approved_by, exit_photo: exitReq ? 'required' : '', exit_match: '',
          channel: CHANNELS.includes(data.channel) ? data.channel : 'toko', promo_code: String(data.promo_code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''), shift_id: shift ? shift.shift_id : ''
        };
        if (usedApproval) usedApproval.status = 'used';
        if (usedDisc) usedDisc.status = 'used';
        db.sales.push(sale);
        if (sale.payment_method === 'transfer' && money(sale.paid_amount) > 0) addTransferConfirm(db, u, 'faktur', sale.invoice_no, sale.paid_amount, sale.customer_name, str(data.bank), str(data.transfer_ref));
        const touched = new Map();
        qtyBy.forEach((q, pid) => { const p = prodById(pid); shopSet.set(pid, r3(shopOf(p) - q)); });
        for (const l of lines) {
          db.items.push({ invoice_no: sale.invoice_no, sale_date, product_id: l.p.id, sku: l.p.sku, name: l.p.name, qty: l.qty, unit_price: l.unit_price, price_type: l.price_type, cost_price: l.p.cost_price, line_total: l.line_total, line_profit: l.line_total - l.line_cost, customer_name: sale.customer_name });
          l.p.stock = roundQty(l.p.stock - l.qty);
          touched.set(l.p.id, l.p);
        }
        if (cust) { cust.debt_balance = int(cust.debt_balance) + debt; cust.visits = Math.max(0, Math.round(num(cust.visits))) + 1; cust.last_visit = data.sale_date; cust.receipts_sent = Math.max(0, Math.round(num(cust.receipts_sent))) + (data.send_receipt === true ? 1 : 0); }
        if (notOnShelf.length) logAct(db, u, 'jual_tanpa_rak', 'Penjualan ' + sale.invoice_no + ' (tersimpan offline) melebihi stok rak: ' + notOnShelf.map(x => x.name + ' perlu ' + fmtN(x.need) + ', rak ' + fmtN(x.shop)).join('; '), sale.invoice_no, 0, 'warn');
        if (discBy) logAct(db, u, 'diskon', 'Diskon ' + disc.pct + '% (Rp ' + disc.amount + ') pada ' + sale.invoice_no + ' oleh ' + u.name + (discBy !== u.name ? ', disetujui ' + discBy : ''), sale.invoice_no, disc.amount, 'warn');
        if (debt > 0) logAct(db, u, 'hutang', 'Penjualan hutang ' + sale.invoice_no + ' ' + str(sale.customer_name) + ' Rp ' + debt + (approved_by ? ' (disetujui ' + approved_by + ')' : ''), sale.invoice_no, debt, 'info');
        const { id: _omit, ...saleOut } = sale;
        return Object.assign({ invoice_no: sale.invoice_no, sale: saleOut, stock: [...touched.values()].map(p => ({ product_id: p.id, stock: p.stock, shop_stock: Math.min(p.stock, shopSet.get(p.id)) })), duplicate: false, exit_photo_required: exitReq, member: mem });
      }
      case 'request_credit': {
        const cid = String(data.client_id || '');
        if (!cid) throw E('INVALID', 'client_id required');
        const P = priceSale(db, data);
        if (!(P.debt > 0)) throw E('INVALID', 'No debt in this sale');
        const open = db.approvals.find(x => x.client_id === cid && x.status === 'pending' && x.total === P.total && x.debt_amount === P.debt && x.customer_id === P.cust.id);
        if (open) return { request_id: open.request_id, approval: approvalOut(open, u.role) };
        const approval = {
          request_id: 'APR-' + String(nextId(db, 'approval')).padStart(4, '0'), client_id: cid, created_at: jktISO(), cashier: u.name,
          customer_id: P.cust.id, customer_name: P.cust.name, customer_debt_before: int(P.cust.debt_balance), total: P.total, debt_amount: P.debt,
          summary: P.lines.map(l => `${fmtQty(l.qty)}× ${l.p.name}`).join(', '), status: 'pending', decided_by: '', decided_at: '', note: '',
          kind: 'credit', ref: cid, payload: '', approver_role: 'manager'
        };
        db.approvals.push(approval);
        return { request_id: approval.request_id, approval: approvalOut(approval, u.role) };
      }
      case 'request_return': {
        // v16 returns: kind "pelanggan" (a customer brings goods back: refund or less debt) or "pemasok" (goods go back to the
        // supplier). The manager approves; above the limit only the owner. The owner is always told (activity log).
        const kind = data.kind === 'pemasok' ? 'pemasok' : 'pelanggan';
        const st = Object.assign({}, V16_DEFAULTS, db.settings);
        const reasonCode = RETURN_REASONS.indexOf(data.reason_code) >= 0 ? data.reason_code : '';
        if (!reasonCode) throw E('INVALID', 'Pilih alasan retur');
        const reasonNote = str(data.reason_note).slice(0, 300);
        if (reasonCode === 'lainnya' && !reasonNote) throw E('INVALID', 'Tulis alasan retur');
        const lines = Array.isArray(data.lines) ? data.lines.slice(0, 100) : [];
        if (!lines.length) throw E('INVALID', 'Pilih barang yang diretur');
        const agg = {};
        for (const l0 of lines) {
          const l = l0 || {};
          const p = prodById(l.product_id);
          if (!p) throw E('NOT_FOUND', 'Produk tidak ditemukan: ' + l.product_id);
          const q = Math.round(num(l.qty) * 1000) / 1000;
          if (!(q > 0)) throw E('INVALID', 'Jumlah tidak valid: ' + str(p.name));
          const cond = l.condition === 'rusak' ? 'rusak' : 'baik';
          const k = String(p.id) + '|' + (kind === 'pelanggan' ? cond : '');
          if (!agg[k]) agg[k] = { product_id: p.id, name: str(p.name), unit: str(p.unit), qty: 0, condition: kind === 'pelanggan' ? cond : '' };
          agg[k].qty = Math.round((agg[k].qty + q) * 1000) / 1000;
        }
        const list = Object.keys(agg).map(k => agg[k]);
        const qtyByPid = {};
        list.forEach(l => { qtyByPid[String(l.product_id)] = Math.round(((qtyByPid[String(l.product_id)] || 0) + l.qty) * 1000) / 1000; });
        const ref = kind === 'pelanggan' ? str(data.invoice_no) : str(data.purchase_no);
        if (!ref) throw E('INVALID', kind === 'pelanggan' ? 'Nomor faktur pembelian wajib' : 'Nomor barang masuk (nota pemasok) wajib');
        const before = returnedBefore(db, ref);
        const returnId = 'RT' + jktDate().replace(/-/g, '').slice(2) + '-' + rand(4);
        let rec;
        if (kind === 'pelanggan') {
          const sale = db.sales.find(x => x.invoice_no === ref);
          if (!sale) throw E('NOT_FOUND', 'Faktur tidak ditemukan: ' + ref);
          if (sale.status === 'void') throw E('INVALID', 'Faktur ini sudah dibatalkan');
          const items = db.items.filter(it => it.invoice_no === ref);
          const sold = {}, value = {};
          items.forEach(it => { const k = String(it.product_id); sold[k] = (sold[k] || 0) + num(it.qty); value[k] = (value[k] || 0) + money(it.line_total); });
          const discRatio = money(sale.subtotal) > 0 ? Math.min(1, money(sale.discount) / money(sale.subtotal)) : 0;
          const over = [];
          Object.keys(qtyByPid).forEach(pid => {
            const left = Math.round(((sold[pid] || 0) - (before[pid] || 0)) * 1000) / 1000;
            if (qtyByPid[pid] > left + 1e-9) over.push(str(prodById(pid).name) + ': dibeli ' + fmtN(sold[pid] || 0) + ', sudah diretur ' + fmtN(before[pid] || 0));
          });
          if (over.length) throw E('INVALID', 'Jumlah retur melebihi yang dibeli di faktur ini: ' + over.join('; '));
          list.forEach(l => {
            const pid = String(l.product_id);
            const unitNet = sold[pid] > 0 ? (value[pid] / sold[pid]) * (1 - discRatio) : 0;
            l.unit_price = Math.round(unitNet);
            l.value = Math.round(l.qty * unitNet);
          });
          const gross = list.reduce((a1, l) => a1 + l.value, 0);
          const feePct = Math.min(50, Math.max(0, num(st.return_fee_pct)));
          const fee = Math.round(gross * feePct / 100);
          const method = ['tunai', 'transfer', 'potong_hutang', 'tukar'].indexOf(data.refund_method) >= 0 ? data.refund_method : 'tunai';
          const cust = sale.customer_id != null ? custById(sale.customer_id) || null : null;
          if (method === 'potong_hutang' && !(cust && money(cust.debt_balance) > 0)) throw E('INVALID', 'Pelanggan ini tidak punya hutang untuk dipotong');
          if (str(data.returned_by) && !personName(data.returned_by)) throw E('INVALID', 'Nama orang yang mengembalikan hanya boleh huruf');
          if (str(data.returned_by_phone) && !normPhone(data.returned_by_phone)) throw E('INVALID', 'Nomor HP orang yang mengembalikan tidak valid');
          const by = personName(data.returned_by) || (cust ? str(cust.name) : str(sale.customer_name));
          if (!by) throw E('INVALID', 'Nama orang yang mengembalikan wajib');
          rec = {
            return_id: returnId, kind, ref, party_id: cust ? cust.id : 0, party_name: str(sale.customer_name), bought_by: str(sale.customer_name),
            bought_date: str(sale.sale_date), returned_by: by, returned_by_phone: normPhone(data.returned_by_phone), lines: list,
            qty_total: Math.round(list.reduce((a1, l) => a1 + l.qty, 0) * 1000) / 1000, value: gross, fee_pct: feePct, fee,
            refund: gross - fee, refund_method: method, reason_code: reasonCode, reason_note: reasonNote, photo_id: '', out_doc_no: '',
            carrier_type: '', carrier_name: '', carrier_vehicle: '', carrier_phone: ''
          };
        } else {
          const prows = db.purchases.filter(x => str(x.purchase_no) === ref && num(x.qty) > 0);
          if (!prows.length) throw E('NOT_FOUND', 'Barang masuk tidak ditemukan: ' + ref);
          const bought = {}, cost = {};
          prows.forEach(x => { const k = String(x.product_id); bought[k] = (bought[k] || 0) + num(x.qty); cost[k] = money(x.cost_price); });
          const over = [];
          Object.keys(qtyByPid).forEach(pid => {
            const left = Math.round(((bought[pid] || 0) - (before[pid] || 0)) * 1000) / 1000;
            if (!bought[pid]) over.push(str(prodById(pid).name) + ': tidak ada di nota ' + ref);
            else if (qtyByPid[pid] > left + 1e-9) over.push(str(prodById(pid).name) + ': masuk ' + fmtN(bought[pid]) + ', sudah diretur ' + fmtN(before[pid] || 0));
            else if (qtyByPid[pid] > num(prodById(pid).stock) + 1e-9) over.push(str(prodById(pid).name) + ': stok hanya ' + fmtN(prodById(pid).stock));
          });
          if (over.length) throw E('INVALID', 'Retur ke pemasok tidak bisa: ' + over.join('; '));
          const outDoc = docNo(data.out_doc_no);
          if (!outDoc) throw E('INVALID', 'Nomor nota / surat jalan barang keluar wajib (huruf, angka, / - . saja)');
          const photoId = str(data.photo_id);
          const ph = photoId ? db.photos.find(x => x.photo_id === photoId) : null;
          if (st.require_return_photo !== false && !ph) throw E('INVALID', 'Foto bukti barang keluar wajib');
          const carrier = readCarrier(data.carrier, true);
          if (carrier.error) throw E('INVALID', carrier.error);
          list.forEach(l => { l.unit_price = cost[String(l.product_id)] || 0; l.value = Math.round(l.qty * l.unit_price); });
          const gross = list.reduce((a1, l) => a1 + l.value, 0);
          rec = {
            return_id: returnId, kind, ref, party_id: 0, party_name: str(prows[0].supplier), bought_by: '', bought_date: str(prows[0].purchase_date),
            returned_by: carrier.name || u.name, returned_by_phone: carrier.phone, lines: list,
            qty_total: Math.round(list.reduce((a1, l) => a1 + l.qty, 0) * 1000) / 1000, value: gross, fee_pct: 0, fee: 0,
            refund: gross, refund_method: 'nota_kredit', reason_code: reasonCode, reason_note: reasonNote, photo_id: ph ? photoId : '', out_doc_no: outDoc,
            carrier_type: carrier.type, carrier_name: carrier.name, carrier_vehicle: carrier.vehicle, carrier_phone: carrier.phone
          };
        }
        const minVal = num(st.return_owner_min_value) > 0 ? num(st.return_owner_min_value) : 2000000;
        const minQty = num(st.return_owner_min_qty);
        const ownerNeeded = rec.value >= minVal || (minQty > 0 && rec.qty_total >= minQty);
        const summary = (kind === 'pelanggan' ? 'Retur pelanggan ' + rec.party_name + ' (dikembalikan ' + rec.returned_by + ') faktur ' + ref : 'Retur ke pemasok ' + rec.party_name + ' dari ' + ref + ', nota keluar ' + rec.out_doc_no) +
          ': ' + list.map(l => l.name + ' ' + fmtN(l.qty) + ' ' + l.unit + (l.condition === 'rusak' ? ' (rusak)' : '')).join('; ') +
          ' | ' + RETURN_REASON_TEXT[reasonCode] + (reasonNote ? ': ' + reasonNote : '') +
          (kind === 'pelanggan' ? ' | uang kembali Rp ' + rec.refund + ' (' + rec.refund_method + ')' + (rec.fee ? ', potongan retur Rp ' + rec.fee : '') : ' | nilai Rp ' + rec.value);
        const ap = newApproval(db, u, {
          kind: 'retur', approver_role: ownerNeeded ? 'owner' : 'manager', ref: returnId, client_id: str(data.client_id).slice(0, 60),
          customer_id: rec.party_id, customer_name: rec.party_name, total: kind === 'pelanggan' ? rec.refund : rec.value, debt_amount: 0,
          summary: summary.slice(0, 1500), note: reasonNote, payload: JSON.stringify(rec)
        });
        logAct(db, u, 'minta_retur', summary + (ownerNeeded ? ' — butuh persetujuan pemilik' : ' — menunggu manajer'), returnId, ap.total, 'warn');
        return { request_id: ap.request_id, return_id: returnId, approver_role: ap.approver_role, approval: approvalOut(ap, u.role) };
      }
      case 'propose_agreement': {
        // (07 Oct) the owner and the manager agree on the return limit: one proposes, the other confirms; each agreement is recorded
        if (!['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const key = AGREED_KEYS.indexOf(data.key) >= 0 ? data.key : '';
        if (!key) throw E('INVALID', 'Batas tidak dikenal');
        const value = Math.round(num(data.value));
        if (!(value >= 0) || value > 1000000000 || (key === 'return_owner_min_value' && value < 1)) throw E('INVALID', 'Nilai tidak valid');
        const note = str(data.note).slice(0, 300);
        const st = Object.assign({}, V16_DEFAULTS, db.settings);
        const label = key === 'return_owner_min_value' ? 'Batas retur yang perlu persetujuan pemilik: Rp ' : 'Batas jumlah barang retur untuk pemilik: ';
        const ap = newApproval(db, u, { kind: 'kesepakatan', approver_role: u.role === 'owner' ? 'manager' : 'owner', ref: key, total: value,
          summary: ('Usul ' + u.name + ': ' + label + value + ' (sekarang ' + num(st[key]) + ')' + (note ? ' | ' + note : '')).slice(0, 1500), note,
          payload: JSON.stringify({ key, value, from: num(st[key]), proposed_by: u.name, proposed_role: u.role }) });
        logAct(db, u, 'usul_kesepakatan', ap.summary, ap.request_id, value, 'info');
        return { request_id: ap.request_id, approval: approvalOut(ap, u.role) };
      }
      case 'get_sale': {
        // one invoice by its number (returns at the counter): the sale, its lines and what was already returned or is pending
        const no = str(data.invoice_no);
        const sale = no ? db.sales.find(x => x.invoice_no === no) : null;
        if (!no || !sale) throw E('NOT_FOUND', 'Faktur tidak ditemukan: ' + no);
        const cust = sale.customer_id != null ? custById(sale.customer_id) || null : null;
        return { sale, items: db.items.filter(it => it.invoice_no === no), returned: returnedBefore(db, no), customer_debt: cust ? money(cust.debt_balance) : 0 };
      }
      case 'list_returns': {
        if (!['owner', 'manager', 'kasir'].includes(u.role)) throw E('FORBIDDEN', 'Tidak diizinkan');
        const inR = d => (!isYmd(data.from) || str(d) >= data.from) && (!isYmd(data.to) || str(d) <= data.to);
        const done1 = db.returns.filter(r => inR(r.return_date)).map(r => returnOut(r, u.role)).filter(Boolean);
        const pending = db.approvals.filter(a => a.kind === 'retur' && a.status === 'pending').map(a => {
          const pl = parseObj(a.payload);
          return returnOut(Object.assign({}, pl, { status: 'pending', request_id: a.request_id, approver_role: a.approver_role, return_date: str(a.created_at).slice(0, 10), user: str(a.cashier) }), u.role);
        }).filter(Boolean);
        return { returns: pending.concat(done1.sort((x, y) => String(y.at).localeCompare(String(x.at)))) };
      }
      case 'check_approval': {
        const ap = db.approvals.find(x => x.request_id === data.request_id);
        if (!ap) throw E('NOT_FOUND', 'approval');
        return { approval: approvalOut(ap, u.role) };
      }
      case 'list_approvals': {
        if (!['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Owner/manager only');
        return { approvals: db.approvals.filter(x => x.status === 'pending').map(x => approvalOut(x, u.role)) };
      }
      case 'decide_approval': {
        if (!['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Owner/manager only');
        const ap = db.approvals.find(x => x.request_id === data.request_id);
        if (!ap) throw E('NOT_FOUND', 'approval');
        if (!['approved', 'rejected'].includes(data.decision)) throw E('INVALID', 'decision');
        if (ap.status !== 'pending') throw E('INVALID', 'Already decided: ' + ap.status);
        if (ap.approver_role === 'owner' && u.role !== 'owner') throw E('NEEDS_OWNER', 'Only the owner can decide this request');
        const out = {};
        if (data.decision === 'approved' && ap.kind === 'void') {
          if (data.invoice_no !== ap.ref) throw E('INVALID', 'invoice_no must equal approval.ref');
          let reason = ''; try { reason = JSON.parse(ap.payload || '{}').reason || ''; } catch (e) { }
          out.sale = voidSaleNow(db, ap.ref, `${reason} (diminta ${ap.cashier}, disetujui ${u.name})`, u.name);
        }
        if (data.decision === 'approved' && ap.kind === 'price') {
          const p = prodById(ap.ref); if (!p) throw E('NOT_FOUND', 'product');
          const pl = JSON.parse(ap.payload || '{}');
          for (const [f, ch] of Object.entries(pl.changes || {})) p[f] = int(ch.to);
          out.product = p;
        }
        if (data.decision === 'approved' && ap.kind === 'opname') out.stock = applyOpname(db, ap, u.name);
        if (data.decision === 'approved' && ap.kind === 'purchase_fix') {
          const pl = parseObj(ap.payload), no = str(pl.purchase_no);
          // as on the server: the rows are looked up by data.purchase_no, which must be approval.ref
          const rows = no && str(data.purchase_no) === no ? db.purchases.filter(r => str(r.purchase_no) === no) : [];
          const pf = purchaseFixChanges(rows, pl.lines);
          if (!pf.found) throw E('INVALID', 'Kirim purchase_no barang masuk yang dikoreksi');
          out.stock = applyPurchaseFix(db, u, no, pf.changes, str(pl.reason) + ' (diminta ' + str(ap.cashier) + ', disetujui ' + u.name + ')', u.name);
        }
        if (ap.kind === 'kesepakatan') {
          if (str(ap.cashier).toLowerCase() === u.name.toLowerCase()) throw E('FORBIDDEN', 'Kesepakatan harus dikonfirmasi pihak lain');
          if (ap.approver_role === 'owner' && u.role !== 'owner') throw E('NEEDS_OWNER', 'Butuh konfirmasi pemilik');
          if (ap.approver_role === 'manager' && u.role !== 'manager') throw E('FORBIDDEN', 'Kesepakatan ini dikonfirmasi oleh manajer');
          const pl = parseObj(ap.payload);
          if (data.decision === 'approved' && AGREED_KEYS.indexOf(pl.key) >= 0) {
            db.settings[pl.key] = num(pl.value);
            const agreed = { key: pl.key, value: num(pl.value), from: num(pl.from), proposed_by: str(pl.proposed_by), confirmed_by: u.name, at: new Date().toISOString(), note: str(ap.note) };
            const hist = Array.isArray(db.settings.limit_agreements) ? db.settings.limit_agreements.slice() : [];
            hist.unshift(agreed);
            db.settings.limit_agreements = hist.slice(0, 50);
            out.agreement = agreed;
          }
          logAct(db, u, 'kesepakatan', (data.decision === 'approved' ? 'Disepakati ' : 'Ditolak ') + str(pl.proposed_by) + ' & ' + u.name + ': ' + str(ap.summary).slice(0, 500), ap.request_id, money(ap.total), 'warn');
        }
        if (ap.kind === 'retur') {
          const rec = parseObj(ap.payload);
          const lines = Array.isArray(rec.lines) ? rec.lines : [];
          if (data.decision === 'approved') {
            const back = {};
            lines.forEach(l => {
              const pid = String(l.product_id);
              if (rec.kind === 'pemasok') back[pid] = (back[pid] || 0) - num(l.qty);
              else if (l.condition !== 'rusak') back[pid] = (back[pid] || 0) + num(l.qty);
            });
            // good returned goods go back to the warehouse (checked before they return to the shelf); damaged ones are not stock
            out.stock = [];
            Object.keys(back).forEach(pid => {
              const p = prodById(pid);
              if (!p || !back[pid]) return;
              const ns = Math.round((num(p.stock) + back[pid]) * 1000) / 1000;
              if (back[pid] < 0) shopSet.set(p.id, Math.min(shopOf(p), Math.max(0, ns)));
              p.stock = ns;
              out.stock.push({ product_id: p.id, stock: ns });
            });
            if (rec.kind === 'pemasok') {
              // a credit note from the supplier: negative goods-in rows lower what we owe them
              lines.forEach(l => {
                db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: str(rec.party_name), product_id: l.product_id, name: str(l.name), qty: -num(l.qty),
                  cost_price: money(l.unit_price), total: -money(l.value), note: 'RETUR ' + str(rec.return_id) + ' dari ' + str(rec.ref) + ' — ' + (RETURN_REASON_TEXT[rec.reason_code] || '') + (rec.reason_note ? ': ' + str(rec.reason_note) : ''),
                  user: str(ap.cashier), photo_id: str(rec.photo_id), exp_date: '', purchase_no: str(rec.return_id), match_status: 'retur', match_notes: 'nota keluar ' + str(rec.out_doc_no) });
              });
            } else {
              const cust = rec.party_id ? custById(rec.party_id) : null;
              const refund = money(rec.refund);
              if (rec.refund_method === 'potong_hutang' && cust) cust.debt_balance = Math.max(0, money(cust.debt_balance) - refund);
              else if ((rec.refund_method === 'tunai' || rec.refund_method === 'transfer') && refund > 0) {
                db.payments.push({ id: nextId(db, 'payment'), pay_id: 'PY' + rand(7), pay_date: jktDate(), pay_time: new Date().toISOString(), direction: 'out', party_type: 'customer',
                  customer_id: rec.party_id || 0, customer_name: str(rec.party_name), supplier: '', amount: refund, method: rec.refund_method,
                  account_id: payAccount(db, rec.refund_method, data.account_id), slip_date: '', bank: '', transfer_ref: '', proof_photo_id: '', alloc: '[]', match_status: 'retur',
                  note: 'Uang kembali retur ' + str(rec.return_id) + ' faktur ' + str(rec.ref), cashier: str(ap.cashier) });
                const sh = rec.refund_method === 'tunai' ? openShiftOf(db, ap.cashier) : null;
                if (sh) db.cash_moves.push({ id: nextId(db, 'move'), shift_id: sh.shift_id, type: 'out', amount: refund, note: 'Retur ' + str(rec.return_id), user: u.name, time: jktISO() });
              }
            }
          }
          db.returns.push(Object.assign({}, rec, { id: nextId(db, 'return'), lines: JSON.stringify(lines), status: data.decision, user: str(ap.cashier), approved_by: u.name, return_date: jktDate(), at: new Date().toISOString(), request_id: ap.request_id }));
          logAct(db, u, 'retur', (data.decision === 'approved' ? 'Retur disetujui ' : 'Retur ditolak ') + u.name + ': ' + str(ap.summary).slice(0, 600), str(rec.return_id), money(ap.total), 'warn');
          out.return_id = str(rec.return_id);
        }
        if (ap.kind === 'transfer_confirm') logAct(db, u, data.decision === 'approved' ? 'transfer_ok' : 'transfer_gagal', (data.decision === 'approved' ? 'Transfer masuk DIKONFIRMASI oleh ' + u.name : 'Transfer TIDAK diterima — ' + u.name) + ' | ' + str(ap.summary), str(ap.ref), money(ap.total), data.decision === 'approved' ? 'info' : 'warn');
        Object.assign(ap, { status: data.decision, decided_by: u.name, decided_at: jktISO(), note: str(data.note) || str(ap.note) });
        logAct(db, u, 'keputusan', (data.decision === 'approved' ? 'Disetujui' : 'Ditolak') + ' (' + str(ap.kind || 'credit') + ', diminta ' + str(ap.cashier) + '): ' + str(ap.summary).slice(0, 600) + (str(data.note) ? ' | ' + str(data.note) : ''), ap.request_id, money(ap.total), data.decision === 'approved' ? 'info' : 'warn');
        return Object.assign({ approval: approvalOut(ap, u.role) }, out);
      }
      case 'scan_purchase': {
        if (!String(data.image_base64 || '').length) throw E('INVALID', 'image_base64 required');
        let extracted;
        try { extracted = JSON.parse(localStorage.getItem('kmock.scan') || 'null'); } catch (e) { }
        if (!extracted) extracted = {
          supplier: 'CV Timur Tengah Food', date: jktDate(), invoice_no: 'TTF-' + jktDate().replace(/-/g, '').slice(2), total: 3710000,
          items: [
            { name: 'KURMA MEDJOOL JUMBO 1KG', qty: 10, unit: 'kg', unit_price: 170000, total: 1700000 },
            { name: 'GULA PASIR 1 KG', qty: 50, unit: 'pak', unit_price: 15000, total: 750000 },
            { name: 'MADU SIDR YAMAN 500GR', qty: 6, unit: 'btl', unit_price: 210000, total: 1260000 }
          ]
        };
        const suggestions = [];
        extracted.items.forEach((it, index) => {
          let best = null;
          for (const p of db.products) { const sc = nameScore(it.name, p.name); if (!best || sc > best.score) best = { index, product_id: p.id, product_name: p.name, score: sc }; }
          if (best && best.score >= 0.34) suggestions.push(best);
        });
        const photo = { photo_id: 'PH-' + String(nextId(db, 'photo')).padStart(5, '0'), kind: 'masuk', ref: '', created_at: jktISO(), photo_date: jktDate(), user: u.name, drive_url: '', extracted, match_status: '', match_notes: '' };
        db.photos.push(photo);
        return { photo_id: photo.photo_id, extracted, suggestions, drive_url: '' };
      }
      case 'scan_exit': {
        if (!String(data.image_base64 || '').length) throw E('INVALID', 'image_base64 required');
        const sale = db.sales.find(x => x.invoice_no === data.invoice_no);
        if (!sale) throw E('NOT_FOUND', 'invoice');
        const items = db.items.filter(i => i.invoice_no === sale.invoice_no).map(i => ({ name: i.name, qty: i.qty }));
        let mode = 'cocok'; try { mode = localStorage.getItem('kmock.exit') || 'cocok'; } catch (e) { }
        const seen = items.map((i, k) => ({ name: i.name, qty: mode === 'tidak_cocok' && k === 0 ? i.qty + 2 : i.qty }));
        const match = mode === 'tidak_cocok' ? { status: 'tidak_cocok', notes: 'Jumlah barang di foto berbeda dengan nota.', diffs: [{ name: items[0].name, recorded_qty: items[0].qty, photo_qty: seen[0].qty }] }
          : mode === 'perlu_cek' ? { status: 'perlu_cek', notes: 'Foto kurang jelas, sebagian barang tidak terbaca.', diffs: [] }
          : { status: 'cocok', notes: 'Semua barang sesuai nota.', diffs: [] };
        const photo = { photo_id: 'PH-' + String(nextId(db, 'photo')).padStart(5, '0'), kind: 'keluar', ref: sale.invoice_no, created_at: jktISO(), photo_date: jktDate(), user: u.name, drive_url: '', extracted: { items: seen }, match_status: match.status, match_notes: match.notes };
        db.photos.push(photo);
        sale.exit_photo = photo.photo_id; sale.exit_match = match.status;
        return { photo_id: photo.photo_id, extracted: { items: seen }, match, drive_url: '' };
      }
      case 'scan_supplier_return': {
        // v17 photo workflow, kind 'retur': the outgoing return note / goods going back to the supplier (demo: localStorage kmock.retur)
        if (!String(data.image_base64 || '').length) throw E('INVALID', 'image_base64 required');
        let ex = null;
        try { ex = JSON.parse(localStorage.getItem('kmock.retur') || 'null'); } catch (e) { }
        if (!ex) ex = { doc_no: 'RTR-' + jktDate().replace(/-/g, '').slice(2), supplier: null, date: jktDate(), items: [], readable: true, notes: '' };
        const pno = String(data.purchase_no || '').trim().toUpperCase();
        const photo = { photo_id: 'PH-' + String(nextId(db, 'photo')).padStart(5, '0'), kind: 'retur', ref: /^[A-Z0-9][A-Z0-9 \/.-]{0,39}$/.test(pno) ? pno : '', created_at: jktISO(), photo_date: jktDate(), user: u.name, drive_url: '', extracted: ex,
          match_status: ex.readable === false ? 'perlu_cek' : '', match_notes: String(ex.notes || '') };
        db.photos.push(photo);
        return { photo_id: photo.photo_id, extracted: ex, drive_url: '' };
      }
      case 'list_photos': {
        if (!isYmd(data.from) || !isYmd(data.to)) throw E('INVALID', 'from/to');
        return { photos: db.photos.filter(x => x.photo_date >= data.from && x.photo_date <= data.to) };
      }
      case 'void_sale': {
        needOwner();
        if (!String(data.reason || '').trim()) throw E('INVALID', 'reason required');
        const vs = db.sales.find(x => x.invoice_no === data.invoice_no);
        if (vs && vs.status !== 'void') logAct(db, u, 'batal', 'Faktur dibatalkan ' + vs.invoice_no + ' Rp ' + money(vs.total) + ': ' + str(data.reason), vs.invoice_no, money(vs.total), 'warn');
        return { sale: voidSaleNow(db, data.invoice_no, String(data.reason), u.name) };
      }
      case 'request_void': {
        const sale = db.sales.find(x => x.invoice_no === data.invoice_no);
        if (!sale) throw E('NOT_FOUND', 'invoice');
        if (sale.status === 'void') throw E('INVALID', 'Already void');
        const reason = String(data.reason || '').trim();
        if (!reason) throw E('INVALID', 'reason required');
        const open = db.approvals.find(x => x.kind === 'void' && x.ref === sale.invoice_no && x.status === 'pending');
        if (open) return { request_id: open.request_id, approval: open };
        const approval = newApproval(db, u, { kind: 'void', ref: sale.invoice_no, approver_role: 'owner', customer_id: sale.customer_id, customer_name: sale.customer_name, total: sale.total, debt_amount: sale.debt_amount,
          summary: `${sale.invoice_no} · ${sale.sale_date}`, payload: JSON.stringify({ reason, invoice_no: sale.invoice_no, sale_date: sale.sale_date, total: sale.total }) });
        logAct(db, u, 'minta_batal', 'Minta batal faktur ' + sale.invoice_no + ': ' + reason, sale.invoice_no, money(sale.total), 'warn');
        return { request_id: approval.request_id, approval: approvalOut(approval, u.role) };
      }
      case 'change_price': {
        const p = prodById(data.product_id); if (!p) throw E('NOT_FOUND', 'product');
        const changes = {};
        for (const f of ['retail_price', 'wholesale_price', 'cost_price']) if (data[f] !== undefined && data[f] !== null && data[f] !== '' && int(data[f]) !== int(p[f])) { if (int(data[f]) < 0) throw E('INVALID', f); changes[f] = { from: int(p[f]), to: int(data[f]) }; }
        if (!Object.keys(changes).length) throw E('INVALID', 'No price change');
        const reason = String(data.reason || '').trim();
        const direct = u.role === 'owner' || (u.role === 'manager' && !changes.cost_price);
        const payload = JSON.stringify({ changes, product_name: p.name, reason });
        const fields = { kind: 'price', ref: p.id, approver_role: changes.cost_price ? 'owner' : 'manager', customer_id: null, customer_name: '', total: 0, debt_amount: 0, summary: p.name, payload };
        const psum = 'Ubah harga ' + str(p.name) + ': ' + Object.keys(changes).map(f => f + ' ' + changes[f].from + '→' + changes[f].to).join(', ');
        if (direct) {
          for (const [f, ch] of Object.entries(changes)) p[f] = ch.to;
          newApproval(db, u, Object.assign(fields, { status: 'auto', decided_by: u.name, decided_at: jktISO() }));
          logAct(db, u, 'harga', psum + (reason ? ' | ' + reason : ''), String(p.id), 0, 'warn');
          return { applied: true, product: p };
        }
        const approval = newApproval(db, u, fields);
        logAct(db, u, 'minta_harga', 'Minta ' + psum + (reason ? ' | ' + reason : ''), String(p.id), 0, 'info');
        return { applied: false, request_id: approval.request_id, approval: approvalOut(approval, u.role) };
      }
      case 'open_shift': {
        // kasir accounts always; (07 Oct) the manager may open her own drawer when she works as cashier — her opening goes to the owner
        if (u.role !== 'kasir' && u.role !== 'manager') throw E('FORBIDDEN', 'Buka kas hanya dari akun kasir atau manajer (aplikasi Khair Kasir)');
        const ex = openShiftOf(db, u.name);
        if (ex) return { shift: Object.assign(blind(shiftSummary(db, ex), u.role), { already: true }) };
        if (data.opening_cash === undefined || data.opening_cash === '' || int(data.opening_cash) < 0) throw E('INVALID', 'opening_cash');
        const opening = int(data.opening_cash);
        const sh = { shift_id: 'SH-' + String(nextId(db, 'shift')).padStart(4, '0'), cashier: u.name, shift_date: isYmd(data.shift_date) ? data.shift_date : jktDate(), opened_at: jktISO(), closed_at: '', status: 'open', opening_cash: opening, counted_cash: null, difference: null, note: String(data.note || '') };
        const last = db.shifts.filter(x => x.status === 'closed').sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))[0] || null;
        db.shifts.push(sh);
        const lastTxt = last ? ' — kas terakhir ditutup ' + str(last.closed_at).slice(0, 16).replace('T', ' ') + ' oleh ' + str(last.cashier) + ': dihitung Rp ' + money(last.counted_cash) + ', selisih dengan pembukaan Rp ' + (opening - money(last.counted_cash)) : '';
        const approval = newApproval(db, u, { kind: 'buka_kas', approver_role: u.role === 'manager' ? 'owner' : 'manager', ref: sh.shift_id, total: opening,
          summary: ('Buka kas ' + u.name + ': modal awal dihitung Rp ' + opening + lastTxt).slice(0, 1500), note: str(data.note),
          payload: JSON.stringify({ shift_id: sh.shift_id, opening_cash: opening, last_counted: last ? money(last.counted_cash) : null, last_cashier: last ? str(last.cashier) : '' }) });
        logAct(db, u, 'buka_kas', 'Buka kas ' + u.name + ' Rp ' + opening + lastTxt, sh.shift_id, opening, last && money(last.counted_cash) !== opening ? 'warn' : 'info');
        // PROPOSED (not in the v15 server answer): request_id / approval, so the cashier can follow the approval with check_approval
        return { already: false, shift: blind(shiftSummary(db, sh), u.role), request_id: approval.request_id, approval: approvalOut(approval, u.role) };
      }
      case 'cash_move': {
        const sh = openShiftOf(db, u.name); if (!sh) throw E('SHIFT_REQUIRED', 'No open shift');
        if (!['in', 'out'].includes(data.type)) throw E('INVALID', 'type');
        const amount = int(data.amount); if (amount <= 0) throw E('INVALID', 'amount');
        if (!String(data.note || '').trim()) throw E('INVALID', 'note required');
        db.cash_moves.push({ id: nextId(db, 'move'), shift_id: sh.shift_id, type: data.type, amount, note: String(data.note).trim(), user: u.name, time: jktISO() });
        logAct(db, u, 'kas', (data.type === 'in' ? 'Kas masuk' : 'Kas keluar') + ' Rp ' + amount + ': ' + str(data.note).slice(0, 300), sh.shift_id, amount, 'info');
        return { shift: blind(shiftSummary(db, sh), u.role) };
      }
      case 'close_shift': {
        let who = u.name;
        if (data.cashier && String(data.cashier).toLowerCase() !== u.name.toLowerCase()) {
          if (!['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Only owner/manager can close another cashier shift');
          who = data.cashier;
        }
        const sh = openShiftOf(db, who); if (!sh) throw E('SHIFT_REQUIRED', 'No open shift');
        if (data.counted_cash === undefined || data.counted_cash === '' || int(data.counted_cash) < 0) throw E('INVALID', 'counted_cash');
        const sm = shiftSummary(db, sh);
        Object.assign(sh, sm, { status: 'closed', closed_at: jktISO(), counted_cash: int(data.counted_cash), difference: int(data.counted_cash) - sm.expected_cash, note: [sh.note, String(data.note || '')].filter(Boolean).join(' / '), closed_by: u.name });
        logAct(db, u, 'tutup_kas', 'Tutup kas ' + str(sh.cashier) + ': dihitung Rp ' + sh.counted_cash + ', seharusnya Rp ' + sm.expected_cash + ', selisih Rp ' + sh.difference, sh.shift_id, sh.difference, sh.difference ? 'warn' : 'info');
        return { shift: sh };
      }
      case 'save_expense': {
        const cats = ['sewa', 'gaji', 'listrik_air', 'transport', 'iklan', 'kemasan', 'perawatan', 'lain'];
        if (!cats.includes(data.category)) throw E('INVALID', 'category');
        const amount = int(data.amount);
        if (amount <= 0) throw E('INVALID', 'amount must be > 0');
        const esh = openShiftOf(db, u.name);
        const paid_from = data.paid_from === 'lain' || data.paid_from === 'kas' ? data.paid_from : (esh ? 'kas' : 'lain');
        if (paid_from === 'kas' && !esh) throw E('SHIFT_REQUIRED', 'paid_from kas needs an open shift');
        const expense = { id: nextId(db, 'expense'), expense_date: isYmd(data.expense_date) ? data.expense_date : jktDate(), category: data.category, amount, note: String(data.note || ''), user: u.name, photo_id: String(data.photo_id || ''), paid_from, shift_id: paid_from === 'kas' ? esh.shift_id : '' };
        db.expenses.push(expense);
        logAct(db, u, 'biaya', 'Pengeluaran ' + expense.category + ' Rp ' + amount + (expense.note ? ': ' + expense.note : '') + ' (' + paid_from + ')', '', amount, 'info');
        return { expense };
      }
      case 'save_product': {
        needOwner();
        const name = String(data.name || '').trim();
        if (!name) throw E('INVALID', 'name required');
        const sku = String(data.sku || '').trim();
        if (sku && db.products.some(p => p.sku === sku && p.id !== Number(data.id))) throw E('INVALID', 'SKU already used');
        if (data.id) {
          const p = prodById(data.id); if (!p) throw E('NOT_FOUND', 'product');
          const { stock, ...rest } = data;
          const before = { retail_price: p.retail_price, wholesale_price: p.wholesale_price, cost_price: p.cost_price };
          Object.assign(p, productFields(rest, {}), { name });
          const changes = {}; for (const f in before) if (int(before[f]) !== int(p[f])) changes[f] = { from: int(before[f]), to: int(p[f]) };
          if (Object.keys(changes).length) newApproval(db, u, { kind: 'price', ref: p.id, summary: p.name, status: 'auto', decided_by: u.name, decided_at: jktISO(), payload: JSON.stringify({ changes, product_name: p.name, reason: 'save_product' }) });
          const ch = Object.keys(changes);
          logAct(db, u, ch.length ? 'harga' : 'produk', 'Ubah produk ' + name + (ch.length ? ': ' + ch.map(f => f + ' ' + changes[f].from + '→' + changes[f].to).join(', ') : ''), String(p.id), 0, ch.length ? 'warn' : 'info');
          return { product: p };
        }
        const p = Object.assign(productFields(data, blankProduct()), { id: nextId(db, 'product'), name, stock: roundQty(data.stock || 0) });
        db.products.push(p);
        logAct(db, u, 'produk_baru', 'Produk baru: ' + name + ' (stok ' + fmtN(p.stock) + ' ' + p.unit + ')', sku, 0, 'info');
        return { product: p };
      }
      case 'import_products': {
        needOwner();
        if (!Array.isArray(data.rows)) throw E('INVALID', 'rows required');
        let created = 0, updated = 0, skipped = 0;
        for (const r of data.rows) {
          const sku = String(r.sku || '').trim(), name = String(r.name || '').trim();
          let p = sku ? db.products.find(x => x.sku === sku) : null;
          if (!p && name) p = db.products.find(x => x.name.trim().toLowerCase() === name.toLowerCase());
          const clean = {}; for (const k in r) if (r[k] !== '' && r[k] != null) clean[k] = r[k];
          if (p) {
            Object.assign(p, productFields(clean, {}));
            if (r.stock !== undefined && r.stock !== '') p.stock = roundQty(r.stock);
            updated++;
          } else if (name) {
            db.products.push(Object.assign(productFields(clean, blankProduct()), { id: nextId(db, 'product'), name, stock: roundQty(r.stock || 0) }));
            created++;
          } else skipped++;
        }
        logAct(db, u, 'impor', 'Impor produk: ' + created + ' baru, ' + updated + ' diubah', '', 0, 'info');
        return { created, updated, skipped };
      }
      case 'stock_adjust': {
        needOwner();
        const p = prodById(data.product_id); if (!p) throw E('NOT_FOUND', 'product');
        if (!String(data.reason || '').trim()) throw E('INVALID', 'reason required');
        if (!Number.isFinite(Number(data.new_stock))) throw E('INVALID', 'new_stock');
        const diff = roundQty(roundQty(data.new_stock) - num(p.stock));
        db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: ADJUST_SUPPLIER, product_id: p.id, name: p.name, qty: diff, cost_price: p.cost_price, total: 0, note: String(data.reason), user: u.name });
        logAct(db, u, 'stok', 'Penyesuaian stok ' + str(p.name) + ': ' + fmtN(p.stock) + '→' + fmtN(data.new_stock) + (str(data.reason) ? ' | ' + str(data.reason) : ''), String(p.id), 0, 'warn');
        p.stock = roundQty(data.new_stock);
        return { product: p };
      }
      case 'save_customer': {
        // as on the server: a number taken at the counter (no id) that is already known updates that customer
        const phone = normPhone(data.phone);
        let ex = data.id ? custById(data.id) : null;
        if (data.id && !ex) throw E('NOT_FOUND', 'Pelanggan tidak ditemukan');
        let existed = false;
        if (!ex && phone) { ex = db.customers.find(x => normPhone(x.phone) === phone) || null; existed = !!ex; }
        if (str(data.name) && !safeName(data.name, 80)) throw E('INVALID', 'Nama pelanggan hanya boleh huruf, angka dan . , \' & ( ) / -');
        if (str(data.phone) && !/^[0-9+ ().-]{3,20}$/.test(str(data.phone))) throw E('INVALID', 'Nomor HP hanya boleh angka (contoh 0812xxxxxxx)');
        if (str(data.address).length > 200 || str(data.notes).length > 300) throw E('INVALID', 'Alamat / catatan terlalu panjang');
        const name = safeName(data.name, 80) || (ex ? str(ex.name) : (phone ? 'Pelanggan ' + phone.slice(-4) : ''));
        if (!name) throw E('INVALID', 'Nama pelanggan wajib');
        const optin = typeof data.wa_optin === 'boolean' ? (existed ? (data.wa_optin || ex.wa_optin === true) : data.wa_optin) : !!(ex && ex.wa_optin === true);
        const c = existed ? {
          name, phone, type: str(ex.type) || 'eceran', address: str(data.address) || str(ex.address), notes: str(data.notes) || str(ex.notes),
          debt_balance: money(ex.debt_balance), wa_optin: optin, source: str(ex.source) || str(data.source).slice(0, 20)
        } : {
          name, phone: phone || (data.phone !== undefined ? str(data.phone) : (ex ? str(ex.phone) : '')),
          type: data.type !== undefined ? (data.type === 'grosir' ? 'grosir' : 'eceran') : (ex ? str(ex.type) || 'eceran' : 'eceran'),
          address: data.address !== undefined ? str(data.address) : (ex ? str(ex.address) : ''), notes: data.notes !== undefined ? str(data.notes) : (ex ? str(ex.notes) : ''),
          debt_balance: ex ? money(ex.debt_balance) : 0, wa_optin: optin, source: str(data.source).slice(0, 20) || (ex ? str(ex.source) : '')
        };
        // v16 e-mail and membership: any user registers a member; only owner / manager may end a membership
        const email = data.email !== undefined ? str(data.email).toLowerCase() : (ex ? str(ex.email) : '');
        if (email && !(/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(email) && email.length <= 120)) throw E('INVALID', 'Alamat e-mail tidak valid');
        const wasMember = !!(ex && ex.member === true);
        const member = typeof data.member === 'boolean' ? data.member : wasMember;
        if (wasMember && !member && !['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Hanya pemilik / manajer yang bisa menghapus member');
        c.email = email; c.member = member;
        c.member_no = ex && str(ex.member_no) ? str(ex.member_no) : (member ? 'M' + rand(6) : '');
        c.member_since = member ? (ex && str(ex.member_since) && wasMember ? str(ex.member_since) : jktDate()) : (ex ? str(ex.member_since) : '');
        c.visits = ex ? Math.max(0, Math.round(num(ex.visits))) : 0;
        c.receipts_sent = ex ? Math.max(0, Math.round(num(ex.receipts_sent))) : 0;
        c.last_visit = ex ? str(ex.last_visit) : '';
        let row;
        if (ex) row = Object.assign(ex, c); else { row = Object.assign({ id: nextId(db, 'customer') }, c); db.customers.push(row); }
        if (member && !wasMember) logAct(db, u, 'member_baru', 'Member baru: ' + c.name + ' (' + c.member_no + ')' + (c.phone ? ' ' + c.phone : '') + (email ? ' ' + email : ''), c.member_no, 0, 'info');
        if (!member && wasMember) logAct(db, u, 'member_berhenti', 'Member dihapus: ' + c.name + ' (' + c.member_no + ')', c.member_no, 0, 'warn');
        return { existed, customer: row, member: memberInfo(db, row) };
      }
      case 'receive_payment': {
        // v13 as on the server: slip check (photo kind 'bayar'), allocation to invoices, match_status; v14 account_id / slip_date
        const c = custById(data.customer_id); if (!c) throw E('NOT_FOUND', 'Pelanggan tidak ditemukan');
        const amount = money(data.amount);
        if (!(amount > 0)) throw E('INVALID', 'Jumlah pembayaran tidak valid');
        if (amount > money(c.debt_balance)) throw E('INVALID', 'Pembayaran melebihi hutang');
        if (dupRef(db, data.transfer_ref)) throw E('INVALID', 'Nomor transfer ini sudah pernah dipakai: ' + str(data.transfer_ref));
        let sc = null;
        if (str(data.photo_id)) {
          const ph = db.photos.find(x => x.photo_id === str(data.photo_id));
          if (!ph || ph.kind !== 'bayar') throw E('INVALID', 'Foto bukti pembayaran tidak ditemukan');
          const ex = parseObj(ph.extracted);
          const slip = ex.amount === null || ex.amount === undefined || !isFinite(Number(ex.amount)) ? null : money(ex.amount);
          if (slip !== null && slip !== amount && !str(data.mismatch_reason)) throw E('MISMATCH', 'Jumlah tidak sama dengan bukti transfer: input ' + amount + ', bukti ' + slip, { slip_amount: slip, extracted: ex });
          sc = { slip, ex, ph };
        }
        const docs = partyDocs(db, 'customer', c.id, '');
        const chk = checkAlloc(data.alloc, docs, amount);
        if (chk.error) throw E('INVALID', chk.error);
        const psh = openShiftOf(db, u.name);
        const pay = {
          id: nextId(db, 'payment'), pay_id: 'PY' + rand(7), pay_date: isYmd(data.pay_date) ? data.pay_date : jktDate(), pay_time: new Date().toISOString(),
          direction: 'in', party_type: 'customer', customer_id: c.id, customer_name: str(c.name), supplier: '', amount,
          method: ['tunai', 'transfer', 'qris'].includes(data.method) ? data.method : 'tunai',
          account_id: payAccount(db, data.method, data.account_id), slip_date: sc && sc.ex && sc.ex.date ? str(sc.ex.date) : '',
          bank: str(data.bank).slice(0, 60), transfer_ref: str(data.transfer_ref).slice(0, 80), proof_photo_id: str(data.photo_id).slice(0, 40),
          alloc: JSON.stringify(chk.alloc), match_status: allocStatus(amount, chk, docs),
          note: (str(data.note) + (str(data.mismatch_reason) ? ' | beda dengan bukti: ' + str(data.mismatch_reason) : '')).slice(0, 500), cashier: u.name,
          shift_id: psh ? psh.shift_id : ''
        };
        db.payments.push(pay);
        c.debt_balance = Math.max(0, money(c.debt_balance) - amount);
        if (pay.method === 'transfer') addTransferConfirm(db, u, 'pembayaran', pay.pay_id, amount, c.name, pay.bank, pay.transfer_ref);
        if (sc) sc.ph.ref = pay.pay_id;
        const dateOff = pay.slip_date && pay.slip_date !== pay.pay_date;
        logAct(db, u, 'bayar_masuk', 'Pembayaran ' + str(c.name) + ' Rp ' + amount + ' (' + pay.method + (pay.bank ? ' ' + pay.bank : '') + (pay.transfer_ref ? ', ref ' + pay.transfer_ref : '') + ')' +
          (chk.alloc.length ? ' untuk ' + chk.alloc.map(a => a.ref + ' Rp ' + a.amount).join(', ') : ' — belum dialokasi') + (str(data.mismatch_reason) ? ' | beda dengan bukti: ' + str(data.mismatch_reason) : '') +
          (dateOff ? ' | tanggal bukti ' + pay.slip_date + ' ≠ dicatat ' + pay.pay_date : ''),
          pay.pay_id, amount, str(data.mismatch_reason) || dateOff || pay.match_status === 'belum_dialokasi' ? 'warn' : 'info');
        return { payment: payOut(pay), customer: c };
      }
      case 'party_ledger': {
        const pt = data.party_type === 'supplier' ? 'supplier' : 'customer';
        if (pt === 'supplier' && !['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        let key, balance;
        if (pt === 'customer') {
          const c = custById(data.customer_id); if (!c) throw E('NOT_FOUND', 'Pelanggan tidak ditemukan');
          key = c.id; balance = money(c.debt_balance);
        } else { key = str(data.supplier); if (!key) throw E('INVALID', 'Nama pemasok wajib'); }
        const docs = partyDocs(db, pt, key, '');
        const pays = db.payments.filter(p => pt === 'customer' ? (Number(p.customer_id) === Number(key) && payDir(p) === 'in') : (str(p.supplier) === key && payDir(p) === 'out'))
          .map(payOut).sort((a, b) => String((b.pay_date || '') + (b.pay_time || '')).localeCompare(String((a.pay_date || '') + (a.pay_time || ''))));
        const list = Object.keys(docs).map(k => docs[k]).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        if (pt === 'supplier') balance = sum(list, d => d.total) - sum(pays, p => money(p.amount));
        return { party_type: pt, docs: list, payments: pays, balance };
      }
      case 'scan_payment': {
        // photo workflow, kind 'bayar': the AI reads the transfer slip (demo: localStorage kmock.scanpay or a sample slip)
        if (!String(data.image_base64 || '').length) throw E('INVALID', 'image_base64 required');
        let extracted = null;
        try { extracted = JSON.parse(localStorage.getItem('kmock.scanpay') || 'null'); } catch (e) { }
        if (!extracted) extracted = { date: jktDate(), amount: 500000, sender_name: 'TOKO BERKAH CONDET', receiver_name: 'KHAIR MART', bank: 'BCA', transfer_ref: 'BCA' + jktDate().replace(/-/g, '').slice(2) + '7731', readable: true, notes: '' };
        const photo = { photo_id: 'PH-' + String(nextId(db, 'photo')).padStart(5, '0'), kind: 'bayar', ref: '', created_at: jktISO(), photo_date: jktDate(), user: u.name, drive_url: '', extracted, match_status: '', match_notes: '' };
        db.photos.push(photo);
        return { photo_id: photo.photo_id, extracted, drive_url: '' };
      }
      case 'save_purchase': {
        if (!Array.isArray(data.items) || !data.items.length) throw E('INVALID', 'items required');
        if (str(data.supplier) && !safeName(data.supplier, 80)) throw E('INVALID', 'Nama pemasok hanya boleh huruf dan angka');
        // v16 who brought the goods: public transport (+ its number), a friend (name), the supplier's driver or our staff
        const carrier = readCarrier(data.carrier, Object.assign({}, V16_DEFAULTS, db.settings).require_carrier !== false);
        if (carrier.error) throw E('CARRIER_REQUIRED', carrier.error);
        const photo = data.photo_id ? db.photos.find(x => x.photo_id === data.photo_id && x.kind === 'masuk') : null;
        if (data.photo_id && !photo) throw E('INVALID', 'photo_id not found');
        if (!photo && db.settings.require_purchase_photo !== false) throw E('INVALID', 'Purchase photo (photo_id) required');
        const pdate = isYmd(data.purchase_date) ? data.purchase_date : jktDate();
        // v12: what was typed is checked against the photographed note before anything is saved
        const typed = data.items.map(it => { const p0 = prodById(it.product_id); return { name: p0 ? str(p0.name) : str(it.product_id), qty: roundQty(it.qty), photo_index: it.photo_index }; });
        const match = photo ? NoteMatch.match(typed, photo.extracted) : { status: 'tanpa_foto', diffs: [], notes: '' };
        const reason = str(data.mismatch_reason).slice(0, 300);
        if (match.status === 'tidak_cocok' && !reason) throw E('MISMATCH', 'Jumlah tidak sama dengan nota: ' + NoteMatch.diffText(match.diffs), { match });
        const checked = data.items.map(it => {
          const p = prodById(it.product_id); if (!p) throw E('NOT_FOUND', 'product ' + it.product_id);
          const qty = roundQty(it.qty); if (!(qty > 0)) throw E('INVALID', 'qty must be > 0');
          const expNone = it.exp_none === true;
          const exp = isYmd(it.exp_date) ? it.exp_date : '';
          if (!expNone && !exp) throw E('INVALID', 'Tanggal kedaluwarsa wajib untuk ' + p.name + ' (isi tanggal atau tandai "tak ada")');
          return { p, qty, cost: Math.max(0, int(it.cost_price)), exp, expNone };
        });
        const purchase_no = 'PB' + pdate.replace(/-/g, '').slice(2) + '-' + rand(4);
        const matchNotes = ((match.diffs.length ? NoteMatch.diffText(match.diffs) : '') + (reason ? ' | alasan: ' + reason : '')).slice(0, 500);
        const out = [];
        let sumTotal = 0;
        const prevStockById = {};
        const today0 = jktDate();
        for (const { p, qty, cost, exp, expNone } of checked) {
          const old = Math.max(0, num(p.stock));
          if (prevStockById[p.id] === undefined) prevStockById[p.id] = old;
          p.cost_price = old + qty > 0 ? Math.round((old * p.cost_price + qty * cost) / (old + qty)) : cost;
          p.stock = roundQty(p.stock + qty);
          if (expNone) { p.exp_none = true; p.exp_date = ''; }
          else { p.exp_none = false; const cur = isYmd(p.exp_date) ? p.exp_date : ''; p.exp_date = (!cur || prevStockById[p.id] <= 0 || cur < today0) ? exp : (exp < cur ? exp : cur); }
          db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: pdate, supplier: String(data.supplier || ''), product_id: p.id, name: p.name, qty, cost_price: cost, total: Math.round(qty * cost), note: String(data.note || ''), user: u.name, photo_id: photo ? photo.photo_id : '', exp_date: exp,
            purchase_no, match_status: match.status, match_notes: matchNotes, carrier_type: carrier.type, carrier_name: carrier.name, carrier_vehicle: carrier.vehicle, carrier_phone: carrier.phone });
          sumTotal += Math.round(qty * cost);
          const o = out.find(x => x.product_id === p.id);
          if (o) Object.assign(o, { stock: p.stock, cost_price: p.cost_price, exp_date: p.exp_date, exp_none: p.exp_none }); else out.push({ product_id: p.id, stock: p.stock, cost_price: p.cost_price, exp_date: p.exp_date, exp_none: p.exp_none });
        }
        if (photo) photo.ref = [photo.ref, String(data.supplier || '')].filter(Boolean).join(' ') || 'masuk';
        logAct(db, u, 'masuk', 'Barang masuk ' + purchase_no + (str(data.supplier) ? ' dari ' + str(data.supplier) : '') + ': ' + data.items.length + ' baris, Rp ' + sumTotal + ' — nota: ' + match.status + (matchNotes ? ' (' + matchNotes + ')' : '') + (carrier.type ? ' — dibawa ' + ({ umum: 'kendaraan umum', teman: 'teman', pemasok: 'sopir pemasok', karyawan: 'karyawan' })[carrier.type] + (carrier.name ? ' ' + carrier.name : '') + (carrier.vehicle ? ' ' + carrier.vehicle : '') : ''), purchase_no, sumTotal, match.status === 'cocok' ? 'info' : 'warn');
        return { stock: out, purchase_no, match };
      }
      case 'request_purchase_fix': {
        // a saved goods-in can only be corrected with the manager's (or owner's) approval; the owner sees it in the log
        const no = str(data.purchase_no);
        if (!no) throw E('INVALID', 'purchase_no wajib');
        const reason = str(data.reason).slice(0, 300);
        if (!reason) throw E('INVALID', 'Alasan koreksi wajib diisi');
        const pf = purchaseFixChanges(db.purchases.filter(r => str(r.purchase_no) === no), data.lines);
        if (!pf.found) throw E('NOT_FOUND', 'Barang masuk tidak ditemukan');
        if (!pf.changes.length) throw E('INVALID', 'Tidak ada perubahan');
        const summary = fixSummary(no, pf.changes);
        if (['owner', 'manager'].includes(u.role)) {
          const stock = applyPurchaseFix(db, u, no, pf.changes, reason, u.name);
          logAct(db, u, 'koreksi_masuk', summary + ' | ' + reason, no, sum(pf.changes, c => c.d_total), 'warn');
          return { applied: true, changes: u.role === 'owner' ? pf.changes : pf.changes.map(qtyOnly), stock };
        }
        const approval = newApproval(db, u, { kind: 'purchase_fix', approver_role: 'manager', ref: no, note: reason, summary: summary.slice(0, 1500), total: sum(pf.changes, c => c.to_total),
          payload: JSON.stringify({ purchase_no: no, lines: data.lines, reason, changes: pf.changes }) });
        logAct(db, u, 'minta_koreksi', 'Minta ' + summary + ' | ' + reason, no, 0, 'warn');
        return { applied: false, request_id: approval.request_id, approval: approvalOut(approval, u.role), changes: u.role === 'owner' ? pf.changes : pf.changes.map(qtyOnly) };
      }
      case 'stock_count': return stockCount(db, u, data);
      case 'get_sales': {
        if (!isYmd(data.from) || !isYmd(data.to)) throw E('INVALID', 'from/to');
        const inR = d => d >= data.from && d <= data.to;
        const sales = db.sales.filter(s => inR(s.sale_date));
        const inv = new Set(sales.map(s => s.invoice_no));
        return { sales, items: db.items.filter(i => inv.has(i.invoice_no)), payments: db.payments.filter(p => inR(p.pay_date)), purchases: db.purchases.filter(p => inR(p.purchase_date)).map(p => { if (u.role === 'owner') return p; const o = Object.assign({}, p); delete o.total; return o; }), expenses: db.expenses.filter(x => inR(x.expense_date)), shifts: db.shifts.filter(x => inR(x.shift_date)).map(x => blind(shiftSummary(db, x), u.role)) };
      }
      case 'save_settings': {
        needOwner();
        const s = data.settings || {};
        if (s.paper !== undefined && !['58', '80'].includes(String(s.paper))) throw E('INVALID', 'paper');
        if (s.exit_photo_min_total !== undefined) s.exit_photo_min_total = Math.max(0, int(s.exit_photo_min_total));
        if (s.exit_photo_min_qty !== undefined) s.exit_photo_min_qty = Math.max(0, num(s.exit_photo_min_qty));
        ['wa_shop_number', 'wa_manager_number', 'wa_owner_number'].forEach(k => { if (s[k] !== undefined) s[k] = String(s[k] || '').replace(/[^\d+]/g, '').slice(0, 20); });
        if (s.report_time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.report_time))) throw E('INVALID', 'report_time');
        if (s.survey_voice !== undefined) s.survey_voice = !(s.survey_voice === false || s.survey_voice === 'false');
        const cur = Object.assign({}, V16_DEFAULTS, db.settings);
        if (AGREED_KEYS.some(k => s[k] !== undefined && JSON.stringify(s[k]) !== JSON.stringify(cur[k]))) throw E('AGREEMENT_REQUIRED', 'Batas retur diubah lewat kesepakatan pemilik dan manajer (propose_agreement)');
        delete s.limit_agreements;
        const changedKeys = Object.keys(s).filter(k => JSON.stringify(s[k]) !== JSON.stringify(db.settings[k]));
        if (changedKeys.length) logAct(db, u, 'pengaturan', 'Pengaturan diubah: ' + changedKeys.join(', '), '', 0, 'info');
        Object.assign(db.settings, s);
        return { settings: db.settings };
      }
      case 'save_user': {
        needOwner();
        const name = String(data.name || '').trim();
        if (!name) throw E('INVALID', 'name required');
        const role = ['owner', 'manager', 'sales'].includes(data.role) ? data.role : 'kasir';
        if (data.pin_hash && !/^[0-9a-f]{64}$/.test(data.pin_hash)) throw E('INVALID', 'pin_hash');
        let x = db.users.find(v => v.name.toLowerCase() === name.toLowerCase());
        const existed = !!x;
        const active = data.active === undefined ? true : !!data.active;
        const ownersLeft = db.users.filter(v => v !== x && v.role === 'owner' && v.active).length + (role === 'owner' && active ? 1 : 0);
        if (!ownersLeft) throw E('INVALID', 'At least one active owner required');
        if (!x) {
          if (!data.pin_hash) throw E('INVALID', 'pin_hash required');
          x = { name, role, pin_hash: data.pin_hash, active };
          db.users.push(x);
        }
        const newPinDiff = existed && !!data.pin_hash && data.pin_hash !== x.pin_hash;
        if (existed) { x.role = role; x.active = active; if (data.pin_hash) x.pin_hash = data.pin_hash; }
        // v16: a PIN set by the owner for someone else is temporary — that person chooses their own at the next login
        const newPin = !!data.pin_hash && (!existed || newPinDiff);
        x.must_change = newPin ? x !== u : x.must_change === true;
        if (newPin) { x.fail_count = 0; x.locked_until = ''; }
        logAct(db, u, 'pengguna', (existed ? 'Pengguna diubah: ' : 'Pengguna baru: ') + x.name + ' (' + x.role + (x.active ? '' : ', nonaktif') + ')' + (existed && data.pin_hash ? ', PIN diganti' : ''), x.name, 0, 'warn');
        return { user: { name: x.name, role: x.role, active: x.active, must_change: x.must_change } };
      }
      default: throw E('INVALID', 'Unknown action ' + action);
    }
  }

  // v17 attendance: the same core as the server (backend/attendance/att-core.js) + demo data (shared/att-mock.js), loaded on first use
  let attLoad = null;
  function loadAttMock() {
    if (window.KAttMock && window.KAtt) return Promise.resolve();
    const one = src => new Promise(res => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
    return attLoad || (attLoad = one('../backend/attendance/att-core.js').then(() => one('../shared/att-mock.js')));
  }
  // Phase 3 chat: same core as the server (backend/chat/chat-core.js) + demo handler (shared/chat-mock.js)
  const CHAT_ACTIONS = ['chat_bootstrap', 'chat_poll', 'chat_send', 'chat_set_retention'];
  let chatLoad = null;
  function loadChatMock() {
    if (window.KChat && window.KChatMock) return Promise.resolve();
    const one = src => new Promise(res => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
    return chatLoad || (chatLoad = one('../backend/chat/chat-core.js').then(() => one('../shared/chat-mock.js')));
  }
  /* ---- Field sales: handled by shared/field-mock.js (loaded statically by the page; lazy-load fallback kept).
     The cashier app only reaches cashier_orders (read-only); the field mock's per-action role gate forbids the kasir
     every other field action (field_order, list_field, …), mirroring the server's KASIR_ONLY gate. ---- */
  const FIELD_ACTIONS = ['field_bootstrap', 'day_start', 'day_end', 'track', 'check_in', 'field_order', 'list_field', 'update_order', 'set_product_image', 'product_images', 'link_shop', 'cashier_orders'];
  const ext = () => (window.KhairFieldMock && typeof window.KhairFieldMock.handle === 'function') ? window.KhairFieldMock : null;
  /** Seeds the field tables (and demo rep Ahmad) — synchronous and idempotent; skipped until the store has users. */
  function ensureField(db) {
    const X = ext();
    if (!X || typeof X.seed !== 'function' || !db.users.length) return false;
    return !!X.seed(db);
  }
  function fieldHandle(db, body) {
    if (body.key !== 'demo') throw E('BAD_KEY', 'Store key not found');
    const u = db.users.find(x => x.active && x.name.toLowerCase() === String(body.user || '').toLowerCase());
    if (!u || u.pin_hash !== body.pin_hash) throw E('BAD_PIN', 'Wrong user or PIN');
    const X = ext();
    if (!X || (Array.isArray(X.actions) && !X.actions.includes(body.action))) throw E('SERVER', 'Field mock (shared/field-mock.js) not loaded');
    return X.handle(body.action, body.data || {}, { name: u.name, role: u.role }, db, { now: () => new Date(), jktDate, jktISO });
  }
  function loadExtFieldMock() {
    return new Promise(res => {
      if (ext()) return res();
      const sc = document.createElement('script'); sc.src = '../shared/field-mock.js';
      const done = () => res(); sc.onload = done; sc.onerror = done; setTimeout(done, 3000);
      document.head.appendChild(sc);
    });
  }
  let extLoad = null;
  async function request(body) {
    await ensure();
    if (/^(att_|worker_)/.test(body.action)) await loadAttMock();
    await sleep(30 + Math.random() * 50);
    let forced = false; try { forced = localStorage.getItem('kmock.offline') === '1'; } catch (e) { }
    if (!navigator.onLine || forced) throw new NetError('offline (mock)');
    const db = load();
    db.approvals = db.approvals || []; db.photos = db.photos || []; db.expenses = db.expenses || []; db.shifts = db.shifts || []; db.cash_moves = db.cash_moves || [];
    db.devices = db.devices || []; db.activity = db.activity || []; db.returns = db.returns || [];
    // chat is append-only text/images; it bypasses the POS tamper scan (a message may legitimately contain symbols)
    if (CHAT_ACTIONS.includes(body.action)) {
      await loadChatMock();
      if (!window.KChatMock) throw E('SERVER', 'Chat mock not loaded');
      const cdb = load(); // fresh read AFTER the async load: the background chat poll must never save a stale snapshot over another call's writes
      const out = window.KChatMock.handle(cdb, body, E);
      if (cdb._dirty) { delete cdb._dirty; save(cdb); }
      return out;
    }
    // Field-sales backend (separate workflow khair-field): delegated to shared/field-mock.js, which strips cost itself.
    if (FIELD_ACTIONS.includes(body.action)) {
      if (!extLoad) extLoad = loadExtFieldMock();
      await extLoad;
      const fdb = load(); // fresh read AFTER the async load
      if (ensureField(fdb)) save(fdb);
      let fres;
      try {
        fres = Object.assign({ ok: true }, strip(fieldHandle(fdb, body))); // strip() = defence-in-depth; orders carry no cost
        save(fdb); // field-mock mutates fdb in place (write actions); a no-op for the read-only cashier_orders
      } catch (e) {
        fres = Object.assign({ ok: false, error: e.code || 'SERVER', message: e.message }, e.extra || {});
      }
      return JSON.parse(JSON.stringify(fres));
    }
    LOG.push({ action: body.action, user: body.user || '', device: body.data && body.data.device ? JSON.parse(JSON.stringify(body.data.device)) : null, at: Date.now() });
    if (LOG.length > 300) LOG.shift();
    let res;
    dirty = false;
    try {
      lastRole = '';
      shopSet.clear();
      const snap = new Map(db.products.map(p => [p.id, { json: JSON.stringify(p), shop: shopOf(p) }]));
      let __codeHit = '';
      if (body.data && typeof body.data === 'object' && !/^(scan_|att_mark|worker_enroll)/.test(body.action)) { __codeHit = scanCodeAttempt(body.data, 0); body = Object.assign({}, body, { data: JSON.parse(JSON.stringify(body.data)) }); cleanInput(body.data, 0); } // (a copy: the server gets it over the network)
      body.__codeHit = __codeHit;
      res = handle(db, body);
      normShop(db, snap);
      const role = lastRole;
      if (!READ_ONLY.includes(body.action) || dirty) save(db);
      res = Object.assign({ ok: true }, role === 'owner' || ['users', 'setup'].includes(body.action) ? res : strip(res));
    } catch (e) {
      if (e.attState) { const fresh = load(); fresh.att = e.attState; save(fresh); } // v17: refused check-ins stay recorded
      if (e.code === 'TAMPER') { const fresh = load(); fresh.settings = fresh.settings || {}; fresh.settings.locked_accounts = db.settings.locked_accounts; save(fresh); }
      res = Object.assign({ ok: false, error: e.code || 'SERVER', message: e.message }, e.extra || {});
    }
    return JSON.parse(JSON.stringify(res));
  }

  /* ---- Seed data ---- */
  function rng(seedN) { let a = seedN >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  async function seed(mode) {
    const R = rng(20261006), pick = a => a[Math.floor(R() * a.length)], ri = (a, b) => a + Math.floor(R() * (b - a + 1));
    const P = [
      ['Kurma Ajwa Al-Madinah 1 kg', 'Kurma', 'kg', 135000, 175000, 160000, 5, 40, 10, 6],
      ['Kurma Sukkari Al-Qassim Box 1 kg', 'Kurma', 'box', 85000, 115000, 102000, 6, 60, 12, 8],
      ['Kurma Medjool Jumbo 1 kg', 'Kurma', 'kg', 165000, 215000, 195000, 5, 25, 8, 4],
      ['Kurma Tunisia Tangkai 500 g', 'Kurma', 'box', 28000, 38000, 33000, 10, 120, 24, 9],
      ['Kurma Khalas 1 kg', 'Kurma', 'kg', 52000, 70000, 62000, 5, 80, 15, 7],
      ['Kurma Mesir Golden Valley 1 kg', 'Kurma', 'box', 33000, 45000, 39500, 10, 6, 20, 5],
      ['Kismis Hijau Afghanistan 1 kg', 'Kismis', 'kg', 72000, 95000, 86000, 5, 35, 10, 5],
      ['Kismis Hitam 500 g', 'Kismis', 'pak', 26000, 35000, 31000, 10, 50, 12, 4],
      ['Cokelat Arab Kerang 500 g', 'Cokelat', 'pak', 45000, 65000, 57000, 6, 45, 10, 6],
      ['Cokelat Turki Lezzo 1 kg', 'Cokelat', 'kg', 68000, 95000, 84000, 5, 4, 8, 3],
      ['Kacang Pistachio Panggang 500 g', 'Kacang', 'pak', 98000, 135000, 122000, 5, 30, 8, 4],
      ['Kacang Almond Panggang 500 g', 'Kacang', 'pak', 62000, 85000, 76000, 5, 38, 10, 5],
      ['Kacang Mete Arab 250 g', 'Kacang', 'pak', 38000, 52000, 46000, 10, 22, 10, 3],
      ['Gamis Pria Saudi Putih', 'Busana', 'pcs', 120000, 185000, 160000, 3, 18, 5, 2],
      ['Sajadah Turki Tebal', 'Perlengkapan Ibadah', 'pcs', 65000, 98000, 85000, 5, 26, 6, 2],
      ['Tasbih Kayu Kokka', 'Perlengkapan Ibadah', 'pcs', 15000, 25000, 20000, 12, 3, 10, 1],
      ['Air Zamzam 5 L', 'Minuman', 'botol', 95000, 135000, 120000, 4, 14, 6, 2],
      ['Beras Premium 5 kg', 'Sembako', 'karung', 68000, 76000, 72500, 10, 70, 20, 8],
      ['Minyak Goreng 2 L', 'Sembako', 'pouch', 31000, 36000, 34000, 12, 96, 24, 8],
      ['Gula Pasir 1 kg', 'Sembako', 'pak', 15500, 18000, 16800, 20, 140, 40, 8],
      ['Teh Al-Kbous Yaman 100 g', 'Minuman', 'pak', 18000, 26000, 22500, 12, 48, 12, 3],
      ['Kopi Arab Kapulaga 250 g', 'Minuman', 'pak', 42000, 60000, 53000, 6, 28, 8, 3],
      ['Bumbu Kabsah 100 g', 'Bumbu', 'pak', 12000, 18000, 15000, 12, 60, 15, 4],
      ['Rempah Nasi Mandi 100 g', 'Bumbu', 'pak', 13000, 19000, 16000, 12, 55, 15, 4],
      ["Za'atar 200 g", 'Bumbu', 'pak', 22000, 32000, 27500, 10, 34, 10, 2],
      ['Dallah Kuningan 1 L', 'Peralatan Dapur', 'pcs', 145000, 210000, 185000, 3, 9, 3, 1],
      ['Finjan Set 12 pcs', 'Peralatan Dapur', 'set', 55000, 85000, 72000, 4, 16, 4, 1],
      ['Minyak Zaitun Extra Virgin 500 ml', 'Sembako', 'botol', 72000, 98000, 88000, 6, 1, 6, 2]
    ];
    const products = P.map((r, i) => ({ id: i + 1, sku: '89910' + String(70001 + i * 37).padStart(7, '0') + (i % 10), name: r[0], category: r[1], unit: r[2], cost_price: r[3], retail_price: r[4], wholesale_price: r[5], wholesale_min_qty: r[6], stock: r[7], min_stock: r[8], active: true, notes: '', size: '', weight: '', exp_date: '', exp_none: false }));
    const weights = P.map(r => r[9]);
    const wsum = sum(weights);
    const pickProduct = () => { let x = R() * wsum; for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return products[i]; } return products[0]; };
    const customers = [
      ['Toko Berkah Condet', '0812-1111-2233', 'grosir', 'Jl. Raya Condet No. 5'],
      ['Warung Bu Halimah', '0813-2222-3344', 'grosir', 'Gg. Kober, Batu Ampar'],
      ['Toko Al-Barokah Kramat Jati', '0857-3333-4455', 'grosir', 'Jl. Dewi Sartika No. 88'],
      ['Ibu Fatimah', '0812-4444-5566', 'eceran', 'Balekambang'],
      ['Pak Hasan Alatas', '0811-5555-6677', 'eceran', 'Cililitan'],
      ['Ustadzah Aisyah', '0819-6666-7788', 'eceran', 'Kampung Tengah']
    ].map((c, i) => ({ id: i + 1, name: c[0], phone: c[1], type: c[2], address: c[3], notes: '', debt_balance: 0, wa_optin: i === 3 || i === 5, source: '' }));
    const debt = {};
    const sales = [], items = [], payments = [], purchases = [];
    const sources = ['dari TikTok', 'lihat video di TikTok', 'Instagram', 'dari IG', 'Facebook', 'cari di Google Maps', 'Google', 'dikasih tahu teman', 'saudara / keluarga', 'lewat depan toko', 'kebetulan lewat', 'sudah langganan lama', 'pelanggan lama', 'dari pengajian'];
    const likes = ['kurmanya segar', 'harga grosirnya murah', 'pelayanan ramah', 'lengkap barang Arab', 'cokelatnya enak'];
    const wants = ['kurma Sagai', 'madu Yaman', 'minyak wangi', '', 'roti Arab'];
    const T = today(), nowHour = jktHour(new Date());
    let seqSale = 0, seqPay = 0, seqPur = 0;
    const suppliers = ['PT Kurma Nusantara', 'CV Timur Tengah Food', 'Agen Sembako Pasar Induk', 'Grosir Kramat Jati'];
    const expenses = []; let seqExp = 0;
    const addExp = (date, category, amount, note) => expenses.push({ id: ++seqExp, expense_date: date, category, amount: Math.round(amount / 1000) * 1000, note, user: 'Pemilik', photo_id: '' });
    for (let d = 399; d >= 0; d--) {
      const date = addDays(T, -d);
      const dow = new Date(date + 'T00:00:00Z').getUTCDay();
      const dom = +date.slice(8, 10);
      if (dom === 1) addExp(date, 'sewa', 6000000, 'Sewa ruko bulan ini');
      if (dom === 25) addExp(date, 'gaji', 9500000, 'Gaji 3 karyawan');
      if (dom === 10) addExp(date, 'listrik_air', 1100000 + R() * 600000, 'PLN + PAM');
      if (dow === 2) addExp(date, 'transport', 150000 + R() * 250000, 'Bensin / ongkir ambil barang');
      if (dom === 5 || dom === 20) addExp(date, 'iklan', 300000 + R() * 450000, pick(['Iklan TikTok', 'Iklan Instagram', 'Cetak brosur']));
      if (dom === 15) addExp(date, 'kemasan', 400000 + R() * 500000, 'Plastik, dus, lakban');
      if (dom === 18 && R() < 0.4) addExp(date, 'perawatan', 250000 + R() * 900000, 'Servis AC / kulkas');
      const n = Math.round((d >= 60 ? 0.3 : 1) * (8 + R() * 12) * (dow === 0 || dow === 6 ? 1.3 : 1) * (d === 0 ? Math.max(0, Math.min(1, (nowHour - 8) / 13)) : 1));
      const times = Array.from({ length: n }, () => [ri(8, d === 0 ? Math.max(8, Math.min(21, nowHour)) : 21), ri(0, 59)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let inv = 0;
      for (const [hh, mm] of times) {
        const roll = R();
        const cust = roll < 0.18 ? customers[ri(0, 2)] : roll < 0.3 ? customers[ri(3, 5)] : null;
        const grosir = cust && cust.type === 'grosir';
        const nLines = d >= 60 ? (grosir ? ri(1, 3) : ri(1, 2)) : grosir ? ri(2, 5) : ri(1, 3);
        const chosen = new Map();
        for (let k = 0; k < nLines; k++) chosen.set(pickProduct().id, true);
        const invoice_no = `KM${date.slice(2).replace(/-/g, '')}-${String(++inv).padStart(4, '0')}`;
        let subtotal = 0, totalCost = 0;
        const lines = [...chosen.keys()].map(pid => {
          const p = products[pid - 1];
          let qty;
          if (grosir) qty = p.wholesale_min_qty + ri(0, p.wholesale_min_qty);
          else if (p.unit === 'kg') qty = pick([0.5, 1, 1, 1, 1.5, 2]);
          else qty = R() < 0.08 ? p.wholesale_min_qty : ri(1, 3);
          const pt = grosir || (p.wholesale_min_qty > 0 && qty >= p.wholesale_min_qty) ? 'grosir' : 'eceran';
          const unit_price = pt === 'grosir' ? p.wholesale_price : p.retail_price;
          const line_total = Math.round(qty * unit_price), line_cost = Math.round(qty * p.cost_price);
          subtotal += line_total; totalCost += line_cost;
          return { invoice_no, sale_date: date, product_id: p.id, sku: p.sku, name: p.name, qty, unit_price, price_type: pt, cost_price: p.cost_price, line_total, line_profit: line_total - line_cost, customer_name: cust ? cust.name : 'Umum' };
        });
        const discount = subtotal > 300000 && R() < 0.15 ? pick([2000, 5000, 10000]) : 0;
        const total = subtotal - discount;
        const m = R();
        let method, paid;
        if (grosir) { method = m < 0.4 ? 'hutang' : m < 0.7 ? 'transfer' : 'tunai'; }
        else { method = m < 0.55 ? 'tunai' : m < 0.8 ? 'qris' : 'transfer'; }
        if (method === 'hutang') paid = R() < 0.5 ? 0 : Math.round(total / 2 / 1000) * 1000;
        else if (method === 'tunai') { const step = pick([1000, 5000, 10000, 50000]); paid = Math.ceil(total / step) * step; }
        else paid = total;
        const debt_amount = Math.max(0, total - paid);
        let survey = [];
        if (R() < (d >= 60 ? 0.06 : 0.22)) {
          survey = [{ q: 'Apakah ini pertama kali belanja di Khair Mart?', a: R() < 0.4 ? 'Iya, pertama kali' : 'Tidak, sudah sering' }, { q: 'Tahu Khair Mart dari mana?', a: pick(sources) }];
          if (R() < 0.5) survey.push({ q: 'Apa yang paling Kakak suka di toko kami?', a: pick(likes) });
          const w = pick(wants); if (w) survey.push({ q: 'Ada barang yang Kakak cari tapi tidak ada?', a: w });
        }
        const iso = `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}+07:00`;
        const chRoll = R();
        const channel = chRoll < 0.8 ? 'toko' : chRoll < 0.9 ? 'whatsapp' : chRoll < 0.94 ? 'shopee' : chRoll < 0.97 ? 'tiktok' : chRoll < 0.99 ? 'tokopedia' : 'web';
        const promo_code = d < 45 && R() < 0.07 ? pick(['KHAIR1111', 'KHAIR1111', 'KURMAHEMAT', 'JUMAT10']) : '';
        sales.push({ channel, promo_code, shift_id: '', id: ++seqSale, invoice_no, sale_date: date, sale_time: iso, cashier: R() < 0.7 ? 'Siti' : 'Pemilik', customer_id: cust ? cust.id : null, customer_name: cust ? cust.name : 'Umum', customer_type: cust ? cust.type : 'eceran', subtotal, discount, total, total_cost: totalCost, profit: total - totalCost, payment_method: method, paid_amount: paid, debt_amount, status: 'ok', survey: JSON.stringify(survey), survey_transcript: '', notes: '', client_id: 'seed-' + seqSale });
        items.push(...lines);
        if (cust && debt_amount) debt[cust.id] = (debt[cust.id] || 0) + debt_amount;
      }
      for (const c of customers) {
        if ((debt[c.id] || 0) > 0 && R() < 0.12) {
          const amount = Math.min(debt[c.id], Math.max(10000, Math.round(debt[c.id] * (0.4 + R() * 0.5) / 10000) * 10000));
          debt[c.id] -= amount;
          payments.push({ id: ++seqPay, pay_date: date, customer_id: c.id, customer_name: c.name, amount, method: pick(['tunai', 'transfer']), note: 'Cicilan', cashier: 'Siti' });
        }
      }
      if (d % 5 === 2) {
        const sup = pick(suppliers), seen = new Set();
        for (let k = ri(2, 5); k > 0; k--) {
          const p = pickProduct(); if (seen.has(p.id)) continue; seen.add(p.id);
          const qty = ri(1, 5) * 10;
          purchases.push({ id: ++seqPur, purchase_date: date, supplier: sup, product_id: p.id, name: p.name, qty, cost_price: p.cost_price, total: qty * p.cost_price, note: '', user: 'Pemilik' });
        }
      }
    }
    // a few voided sales (cash, no debt)
    sales.filter(s => s.payment_method === 'tunai').filter((s, i) => i % 97 === 13).slice(0, 3).forEach(s => { s.status = 'void'; s.void_reason = 'Salah input'; s.voided_by = 'Pemilik'; });
    customers.forEach(c => { c.debt_balance = debt[c.id] || 0; });
    // photo control: exit photos for large sales, receipt photos for purchases
    const photos = []; let seqPh = 0;
    const newPhoto = (kind, ref, date, user, extra) => { const ph = Object.assign({ photo_id: 'PH-' + String(++seqPh).padStart(5, '0'), kind, ref, created_at: `${date}T17:00:00+07:00`, photo_date: date, user, drive_url: '', extracted: { items: [] }, match_status: '', match_notes: '' }, extra || {}); photos.push(ph); return ph; };
    const itemsBy = {}; items.forEach(i => (itemsBy[i.invoice_no] = itemsBy[i.invoice_no] || []).push(i));
    let big = 0;
    sales.forEach(s => {
      s.approved_by = s.debt_amount > 0 ? 'Pemilik' : ''; s.exit_match = '';
      const req = s.total >= 1000000 || (itemsBy[s.invoice_no] || []).some(i => i.qty >= 20);
      s.exit_photo = req ? 'required' : '';
      if (!req || s.status === 'void') return;
      big++;
      const recent = daysBetween(s.sale_date, T) <= 2;
      if (recent && big % 3 === 0) return; // still missing
      if (!recent && big % 11 === 5) return;
      const status = big % 9 === 4 ? 'tidak_cocok' : big % 13 === 6 ? 'perlu_cek' : 'cocok';
      const ph = newPhoto('keluar', s.invoice_no, s.sale_date, s.cashier, { match_status: status, match_notes: status === 'cocok' ? 'Semua barang sesuai nota.' : status === 'tidak_cocok' ? 'Jumlah barang di foto berbeda dengan nota.' : 'Foto kurang jelas.' });
      s.exit_photo = ph.photo_id; s.exit_match = status;
    });
    // cash drawer shifts for the cashier, last 30 days (closed), plus one forgotten open shift from yesterday (Rina)
    const shifts = [], cash_moves = []; let seqSh = 0, seqMv = 0;
    for (let d = 30; d >= 1; d--) {
      const date = addDays(T, -d);
      const mine = sales.filter(s => s.sale_date === date && s.cashier === 'Siti');
      if (!mine.length) continue;
      const id = 'SH-' + String(++seqSh).padStart(4, '0');
      mine.forEach(s => s.shift_id = id);
      const okS = mine.filter(s => s.status !== 'void');
      const cash_sales = sum(okS.filter(s => s.payment_method === 'tunai' || s.payment_method === 'hutang'), s => Math.min(s.paid_amount, s.total));
      const cash_out = d % 4 === 0 ? 50000 : 0;
      if (cash_out) cash_moves.push({ id: ++seqMv, shift_id: id, type: 'out', amount: cash_out, note: 'Beli galon & es', user: 'Siti', time: `${date}T13:00:00+07:00` });
      const expected = 500000 + cash_sales - cash_out;
      const diff = d % 9 === 4 ? -25000 : d % 13 === 6 ? 10000 : 0;
      shifts.push({ shift_id: id, cashier: 'Siti', shift_date: date, opened_at: `${date}T07:55:00+07:00`, closed_at: `${date}T21:10:00+07:00`, status: 'closed', opening_cash: 500000, cash_sales, cash_payments: 0, cash_in: 0, cash_out, sales_count: okS.length, sales_total: sum(okS, s => s.total), expected_cash: expected, counted_cash: expected + diff, difference: diff, moves: JSON.stringify(cash_out ? [{ type: 'out', amount: cash_out, note: 'Beli galon & es' }] : []), note: diff ? 'Selisih, sudah dicek ulang' : '' });
    }
    shifts.push({ shift_id: 'SH-' + String(++seqSh).padStart(4, '0'), cashier: 'Rina', shift_date: addDays(T, -1), opened_at: `${addDays(T, -1)}T15:00:00+07:00`, closed_at: '', status: 'open', opening_cash: 300000, counted_cash: null, difference: null, note: '' });
    const batches = {};
    purchases.forEach(pu => { const k = pu.purchase_date + '|' + pu.supplier; (batches[k] = batches[k] || []).push(pu); });
    Object.values(batches).forEach((rows, i) => {
      if (i % 4 === 3) { rows.forEach(r => r.photo_id = ''); return; }
      const ph = newPhoto('masuk', rows[0].supplier, rows[0].purchase_date, 'Pemilik', { extracted: { supplier: rows[0].supplier, items: rows.map(r => ({ name: r.name, qty: r.qty, unit_price: r.cost_price, total: r.total })) } });
      rows.forEach(r => r.photo_id = ph.photo_id);
    });
    // Gudang demo data (no random draws, so the data above stays identical): expiry dates on food batches of the
    // last 12 months, three short-dated batches bought yesterday, and a few manual stock adjustments in the past.
    const SHELF = { Kurma: 300, Kismis: 270, Cokelat: 150, Kacang: 210, Minuman: 365, Bumbu: 365, Sembako: 240 };
    purchases.forEach(pu => { const sh = SHELF[products[pu.product_id - 1].category]; if (sh && pu.purchase_date >= addDays(T, -365)) pu.exp_date = addDays(pu.purchase_date, sh); });
    const prodRe = re => products.find(p => re.test(p.name));
    const addPur = (d, supplier, re, qty, exp, note) => { const p = prodRe(re); purchases.push({ id: ++seqPur, purchase_date: addDays(T, -d), supplier, product_id: p.id, name: p.name, qty, cost_price: p.cost_price, total: supplier === ADJUST_SUPPLIER ? 0 : qty * p.cost_price, note: note || '', user: 'Pemilik', photo_id: '', exp_date: exp == null ? '' : addDays(T, exp) }); };
    addPur(1, 'CV Timur Tengah Food', /Cokelat Arab Kerang/, 12, 5, 'Stok promo, tanggal pendek');
    addPur(1, 'PT Kurma Nusantara', /Kurma Sukkari/, 24, 21);
    addPur(1, 'Grosir Kramat Jati', /Kacang Almond/, 20, 45);
    addPur(4, ADJUST_SUPPLIER, /Kurma Medjool/, -1, null, 'Rusak — kemasan sobek');
    addPur(11, ADJUST_SUPPLIER, /Tasbih/, -2, null, 'Hilang');
    addPur(19, ADJUST_SUPPLIER, /Gula Pasir/, 3, null, 'Hitung ulang — salah input');
    const users = mode === 'empty' ? [] : [
      { name: 'Pemilik', role: 'owner', pin_hash: await pinHash('demo', 'Pemilik', '1234'), active: true },
      { name: 'Siti', role: 'kasir', pin_hash: await pinHash('demo', 'Siti', '1111'), active: true },
      { name: 'Jihan', role: 'manager', pin_hash: await pinHash('demo', 'Jihan', '2222'), active: true },
      { name: 'Rina', role: 'kasir', pin_hash: await pinHash('demo', 'Rina', '3333'), active: true }
    ];
    return {
      users, products, customers, sales, items, payments, purchases, approvals: [], photos, expenses, shifts, cash_moves,
      settings: { store_name: 'Khair Mart', address: 'Jl. Raya Condet No. 27, Balekambang, Kramat Jati, Jakarta Timur', phone: '0812-8000-2700', receipt_footer: 'Terima kasih, semoga berkah!\nBarang yang sudah dibeli tidak dapat ditukar.', paper: '58', survey_questions: DEFAULT_SURVEY.slice(), survey_auto: true, survey_voice: true, wa_shop_number: '', exit_photo_min_total: 1000000, exit_photo_min_qty: 20, require_purchase_photo: true, require_shift: true },
      seq: { product: products.length, customer: customers.length, sale: seqSale, payment: seqPay, purchase: seqPur, photo: seqPh, approval: 0, expense: seqExp, shift: seqSh, move: seqMv }
    };
  }
  return { request, ensure, reset() { try { localStorage.removeItem(DBKEY); } catch (e) { } ready = null; }, DBKEY, log: LOG };
})();
