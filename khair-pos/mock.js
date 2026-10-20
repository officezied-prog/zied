'use strict';
/* Khair Mart POS — demo/mock backend (owner app). Mirrors backend/process.js. Loaded before the main script; used only in ?mock=1 / demo mode. */
const MockServer = (() => {
  const DBKEY = 'kmock.db';
  const COST_KEYS = ['cost_price', 'total_cost', 'profit', 'line_profit', 'cost'];
  const CHANNELS = ['toko', 'whatsapp', 'shopee', 'tiktok', 'tokopedia', 'web', 'lainnya'];
  const READ_ONLY = ['get_sale', 'list_returns', 'users', 'login', 'bootstrap', 'get_sales', 'check_approval', 'list_approvals', 'list_pay_plans', 'list_transfers', 'list_photos', 'photo_file', 'field_bootstrap', 'list_field', 'product_images', 'orders_map', 'shop_photos', 'street_returns', 'list_devices', 'list_activity', 'party_ledger', 'bank_recon', 'profit_loss', 'list_invoice_changes', 'finance_position'];
  class MockErr extends Error { constructor(code, message, extra) { super(message || code); this.code = code; this.extra = extra || null; } }
  const E = (code, msg, extra) => new MockErr(code, msg, extra);
  let ready = null;

  // v36 (owner 2026-10-08: "فعّل حفظ الصور عبر Google Drive") — demo twin of the Worker's R2 photo store. The scanned image is
  // kept in IndexedDB 'kmock-photos' (shared by the demo apps of this site, and never inside kmock.db, so photos can never
  // fill the demo database); the photo gets drive_file_id 'r2:…' + drive_url '<PHOTO_URL>/file/<photo_id>', as on the Worker.
  const PHOTO_IDB = 'kmock-photos', memPhotos = {};
  function photoIdb() {
    return new Promise(res => { try { const rq = indexedDB.open(PHOTO_IDB, 1); rq.onupgradeneeded = () => rq.result.createObjectStore('img'); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); } catch (e) { res(null); } });
  }
  function keepPhotoImg(db, photo, data) {
    const b64 = String((data && data.image_base64) || '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return '';
    const mime = /^image\/(jpeg|png|webp)$/.test(String(data.mime || '')) ? data.mime : 'image/jpeg';
    memPhotos[photo.photo_id] = 'data:' + mime + ';base64,' + b64;
    (db._keepImgs = db._keepImgs || []).push(photo.photo_id);
    photo.drive_file_id = 'r2:photos/' + String(photo.photo_date || '').slice(0, 7) + '/' + photo.photo_id + '.' + ({ 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'jpg');
    photo.drive_url = ((typeof CONFIG !== 'undefined' && CONFIG.PHOTO_URL) || 'https://khair-mart-jumla.officezied.workers.dev/webhook/khair-pos-photo') + '/file/' + photo.photo_id;
    return photo.drive_url;
  }
  async function flushPhotoImgs(ids) {
    if (!ids || !ids.length) return;
    try {
      const idb = await photoIdb(); if (!idb) return;
      await new Promise(res => { const tx = idb.transaction('img', 'readwrite'); ids.forEach(id => { if (memPhotos[id]) tx.objectStore('img').put(memPhotos[id], id); }); tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
    } catch (e) { }
  }
  async function photoImg(id) {
    if (memPhotos[id]) return memPhotos[id];
    try {
      const idb = await photoIdb(); if (!idb) return null;
      return await new Promise(res => { const rq = idb.transaction('img').objectStore('img').get(id); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); });
    } catch (e) { return null; }
  }

  function load() { try { return JSON.parse(localStorage.getItem(DBKEY) || 'null'); } catch (e) { return null; } }
  function save(db) { try { localStorage.setItem(DBKEY, JSON.stringify(db)); } catch (e) { throw E('SERVER', 'mock storage full'); } }
  function ensure() {
    if (!ready) ready = (async () => { if (!load()) save(await seed(new URLSearchParams(location.search).get('seed'))); })();
    return ready;
  }
  function stripPayload(str) {
    try { const pl = JSON.parse(str); if (pl && pl.changes && pl.changes.cost_price) { pl.changes.cost_price = { from: null, to: null }; } return JSON.stringify(pl); } catch (e) { return str; }
  }
  let stripRole = ''; // owner decisions 07 Oct: the manager also sees the profit on discount requests
  function stripProfit(o) {
    // cost prices stay, profit never — but approval payloads (prices / fix / retur values) are still owner-only, as in strip().
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.payload === 'string' && o.kind === 'price') o = Object.assign({}, o, { payload: stripPayload(o.payload) });
    if (o && typeof o === 'object' && !Array.isArray(o) && o.request_id && (o.kind === 'purchase_fix' || (o.kind === 'discount' && stripRole !== 'manager') || o.kind === 'retur')) o = aprOut(o);
    if (Array.isArray(o)) return o.map(stripProfit);
    if (o && typeof o === 'object') { const r = {}; for (const k in o) if (k !== 'profit' && k !== 'line_profit') r[k] = stripProfit(o[k]); return r; }
    return o;
  }
  function strip(o) {
    if (o && typeof o === 'object' && !Array.isArray(o) && typeof o.payload === 'string' && o.kind === 'price') o = Object.assign({}, o, { payload: stripPayload(o.payload) });
    if (o && typeof o === 'object' && !Array.isArray(o) && o.request_id && (o.kind === 'purchase_fix' || (o.kind === 'discount' && stripRole !== 'manager') || o.kind === 'retur' || o.kind === 'product_new')) o = aprOut(o);
    if (Array.isArray(o)) return o.map(strip);
    if (o && typeof o === 'object') { const r = {}; for (const k in o) if (!COST_KEYS.includes(k)) r[k] = strip(o[k]); return r; }
    return o;
  }
  const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const nextId = (db, k) => (db.seq[k] = (db.seq[k] || 0) + 1);
  // v68 (owner 2026-10-20, «20/10/2026/1542/12»): DD/MM/YYYY/HHmm/N — the sale's day and time, N = its number in that day (all cashiers)
  function invoiceNo(db, ymd, iso) {
    const n = db.sales.filter(s => s.sale_date === ymd).length + 1, t0 = Date.parse(iso || ''), d = new Date((isFinite(t0) ? t0 : Date.now()) + 7 * 3600000);
    return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}/${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}/${n}`;
  }
  function productFields(src, base) {
    const p = Object.assign({}, base);
    const str = k => { if (src[k] !== undefined) p[k] = String(src[k] == null ? '' : src[k]).trim(); };
    const money = k => { if (src[k] !== undefined && src[k] !== '') p[k] = Math.max(0, int(src[k])); };
    ['sku', 'name', 'category', 'unit', 'notes', 'supplier', 'size', 'weight'].forEach(str);
    ['cost_price', 'retail_price', 'wholesale_price'].forEach(money);
    if (src.wholesale_min_qty !== undefined && src.wholesale_min_qty !== '') p.wholesale_min_qty = Math.max(0, roundQty(src.wholesale_min_qty));
    if (src.min_stock !== undefined && src.min_stock !== '') p.min_stock = Math.max(0, roundQty(src.min_stock));
    if (src.active !== undefined) p.active = !(src.active === false || src.active === 'false' || src.active === 0);
    // v52: shown loose, sold by weight at the till — only per kg / gram / ons (as the server)
    if (src.loose !== undefined) p.loose = src.loose === true;
    if (p.loose && !['kg', 'kilo', 'g', 'gr', 'gram', 'ons'].includes(String(p.unit !== undefined ? p.unit : '').trim().toLowerCase())) throw E('INVALID', 'Barang curah dijual per kg / gram / ons — ubah satuannya dulu');
    if (src.exp_none !== undefined) p.exp_none = src.exp_none === true || src.exp_none === 'true';
    if (src.exp_date !== undefined) p.exp_date = /^\d{4}-\d{2}-\d{2}$/.test(String(src.exp_date)) ? String(src.exp_date) : '';
    if (p.exp_none) p.exp_date = '';
    return p;
  }
  function priceSale(db, data, quote) {
    if (!Array.isArray(data.items) || !data.items.length) throw E('INVALID', 'items required');
    const split = Array.isArray(data.payments) && data.payments.length; // v51: one sale paid by several methods (shared/pay-split.js)
    if (!quote && !split && !['tunai', 'transfer', 'qris', 'kartu', 'hutang'].includes(data.payment_method)) throw E('INVALID', 'payment_method');
    const cust = data.customer_id ? db.customers.find(c => c.id === Number(data.customer_id)) : null;
    if (data.customer_id && !cust) throw E('NOT_FOUND', 'customer');
    const lines = data.items.map(it => {
      const p = db.products.find(x => x.id === Number(it.product_id));
      if (!p) throw E('NOT_FOUND', 'product ' + it.product_id);
      if (window.KRepackMock && window.KRepackMock.isMaterial(p)) throw E('INVALID', p.name + ' adalah bahan kemasan — tidak dijual'); // v63
      const qty = roundQty(it.qty);
      if (!(qty > 0)) throw E('INVALID', 'qty must be > 0');
      const unit_price = Math.max(0, int(it.unit_price));
      const line_total = Math.round(qty * unit_price), line_cost = Math.round(qty * p.cost_price);
      const grosirOk = int(p.wholesale_price) > 0 && ((cust && cust.type === 'grosir') || (num(p.wholesale_min_qty) > 0 && qty >= num(p.wholesale_min_qty)));
      const list_total = Math.round(qty * (grosirOk ? Math.min(int(p.wholesale_price), int(p.retail_price) || int(p.wholesale_price)) : int(p.retail_price)));
      return { p, qty, unit_price, price_type: it.price_type === 'grosir' ? 'grosir' : 'eceran', line_total, line_cost, list_total };
    });
    const subtotal = sum(lines, l => l.line_total);
    const discount = Math.min(subtotal, Math.max(0, int(data.discount)));
    // receipt sent by WhatsApp / e-mail: the first one per customer is free, later ones add receipt_send_fee (default Rp 500)
    if (data.send_receipt === true && !cust) throw E('INVALID', 'Simpan nomor HP pelanggan dulu untuk kirim struk');
    const feeSet = setting(db, 'receipt_send_fee'), fee = feeSet === undefined || feeSet === null || feeSet === '' ? 500 : Math.max(0, int(feeSet));
    const sendFee = data.send_receipt === true ? (num(cust.receipts_sent) >= 1 ? fee : 0) : 0;
    const total = subtotal - discount + sendFee;
    const total_cost = sum(lines, l => l.line_cost);
    const sp = split ? window.KPay.partsIn(data.payments, total) : null;
    if (sp && sp.error) throw E('INVALID', sp.error);
    const paid = sp ? sp.paid : Math.max(0, int(data.paid_amount));
    const debt = Math.max(0, total - paid);
    if (debt > 0 && !cust && !quote) throw E('INVALID', 'Hutang / bayar kurang wajib pilih pelanggan');
    const qtyBy = new Map(); lines.forEach(l => qtyBy.set(l.p.id, roundQty((qtyBy.get(l.p.id) || 0) + l.qty)));
    return { cust, lines, subtotal, discount, total, total_cost, paid, debt, method: sp ? sp.method : data.payment_method, parts: sp && sp.parts.length ? sp.parts : null, sale_date: isYmd(data.sale_date) ? data.sale_date : jktDate(), listTotal: sum(lines, l => l.list_total), qtyBy, sendFee };
  }
  const openShiftOf = (db, name) => db.shifts.find(x => x.status === 'open' && String(x.cashier).toLowerCase() === String(name).toLowerCase());
  function shiftSummary(db, sh) {
    if (!sh) return null;
    if (sh.status === 'closed') return sh;
    const sales = db.sales.filter(x => x.shift_id === sh.shift_id && x.status !== 'void');
    const cash_sales = sum(sales, x => window.KPay.of(x).tunai); // v51: a split sale's cash part only
    const cash_payments = sum(db.payments.filter(x => x.shift_id === sh.shift_id && x.method === 'tunai' && (x.direction || 'in') === 'in'), x => int(x.amount));
    const supKas = db.payments.filter(x => x.shift_id === sh.shift_id && x.direction === 'out' && x.paid_from === 'kas');
    const paidOf = m => sum(sales, x => window.KPay.of(x)[m]);
    const inv = new Set(sales.map(x => x.invoice_no));
    const moves = db.cash_moves.filter(x => x.shift_id === sh.shift_id);
    const kasExp = db.expenses.filter(x => x.shift_id === sh.shift_id && x.paid_from === 'kas');
    const cash_in = sum(moves.filter(x => x.type === 'in'), x => int(x.amount));
    const cash_out = sum(moves.filter(x => x.type === 'out'), x => int(x.amount)) + sum(kasExp, x => int(x.amount)) + sum(supKas, x => int(x.amount));
    const list = moves.map(m => ({ type: m.type, amount: m.amount, note: m.note, time: m.time })).concat(kasExp.map(x => ({ type: 'out', amount: x.amount, note: 'Pengeluaran: ' + x.category + (x.note ? ' — ' + x.note : ''), time: x.expense_date })), supKas.map(x => ({ type: 'out', amount: x.amount, note: 'Bayar pemasok ' + x.supplier, time: x.pay_time })));
    return Object.assign({}, sh, { sales_count: sales.length, sales_total: sum(sales, x => int(x.total)), cash_sales, cash_payments, cash_in, cash_out, moves: JSON.stringify(list),
      transfer_sales: paidOf('transfer'), qris_sales: paidOf('qris'), card_sales: paidOf('kartu'), debt_sales: sum(sales, x => int(x.debt_amount)), items_qty: roundQty(sum(db.items.filter(i => inv.has(i.invoice_no)), i => num(i.qty))),
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
    db.items.filter(i => i.invoice_no === s.invoice_no).forEach(i => { const p = db.products.find(x => x.id === i.product_id); if (p) { if (db._shopSet) db._shopSet[p.id] = roundQty((db._shopSet[p.id] !== undefined ? db._shopSet[p.id] : shopOf(p)) + i.qty); p.stock = roundQty(p.stock + i.qty); } });
    const c = s.customer_id ? db.customers.find(x => x.id === s.customer_id) : null;
    if (c && s.debt_amount) c.debt_balance = Math.max(0, int(c.debt_balance) - s.debt_amount);
    if (c) c.visits = Math.max(0, Math.round(num(c.visits)) - 1);
    return s;
  }
  function addTransferConfirm(db, u, refType, ref, amount, who, bank, transferRef, extra) {
    if (int(amount) <= 0) return null;
    const acc = extra && strv(extra.account_id) ? bankAccounts(db).find(x => strv(x.id) === strv(extra.account_id)) : null; // v57
    return newApproval(db, u, { kind: 'transfer_confirm', approver_role: 'manager', ref: String(ref), total: int(amount), customer_name: String(who || ''), note: (String(bank || '') ? 'Bank ' + bank : '') + (String(transferRef || '') ? ' ref ' + transferRef : ''), summary: ('Konfirmasi transfer masuk ' + String(who || '') + ' Rp ' + int(amount) + ' (' + refType + ' ' + ref + ')' + (acc ? ' ke ' + acc.bank + ' ' + acc.account_no : '') + ' — pastikan dana sudah masuk').slice(0, 1500), payload: JSON.stringify(Object.assign({ ref_type: refType, ref: String(ref), amount: int(amount), bank: String(bank || ''), transfer_ref: String(transferRef || ''), who: String(who || '') }, extra || {})) });
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
  // v40: a notice for the owner only (kind 'notifikasi', ref 'owner'), as notify(['owner'], …) on the server
  function ownerNotice(db, u, summary, level) {
    db.activity = db.activity || [];
    db.activity.push({ id: nextId(db, 'activity'), act_id: 'AC' + Math.random().toString(36).slice(2, 10).toUpperCase(), at: new Date().toISOString(), act_date: jktDate(), user: u.name, role: u.role, kind: 'notifikasi', summary, ref: 'owner', amount: 0, level: level || 'info' });
  }
  const rpDots = v => (v > 0 ? '+' : v < 0 ? '-' : '') + 'Rp ' + String(Math.round(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const countValueText = (db, lines) => { const ch = (lines || []).filter(l => Number(l.diff)); return ch.length ? ' (nilai modal ' + rpDots(ch.reduce((s, l) => { const p = db.products.find(x => x.id === Number(l.product_id)); return s + Number(l.diff) * Number(p ? p.cost_price : 0); }, 0)) + ')' : ''; };
  function stockCount(db, u, data) {
    if (u.role === 'sales') throw E('FORBIDDEN', 'Sales accounts cannot count stock');
    const counts = data.counts;
    if (!Array.isArray(counts) || !counts.length) throw E('INVALID', 'counts required');
    if (counts.length > 2000) throw E('INVALID', 'max 2000 lines per count');
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
    const chg = lines.filter(l => l.diff !== 0);
    const cnt = 'Stok opname ' + lines.length + ' barang, ' + chg.length + ' selisih: ' + chg.slice(0, 20).map(l => l.name + ' ' + l.system + '→' + l.counted).join('; ');
    const direct = u.role === 'owner' || u.role === 'manager'; // v40: the manager's own count is applied at once; the owner is told
    logAct(db, u, direct ? 'opname' : 'minta_opname', (direct ? '' : 'Minta ') + cnt, '', 0, direct && chg.length ? 'warn' : 'info');
    if (direct) {
      if (u.role === 'manager') ownerNotice(db, u, 'Stok opname oleh manajer ' + u.name + ' langsung diterapkan: ' + lines.length + ' barang, ' + chg.length + ' selisih' + countValueText(db, lines) + (chg.length ? ': ' + chg.slice(0, 10).map(l => l.name + ' ' + l.system + '→' + l.counted).join('; ') : ''), chg.length ? 'warn' : 'info');
      const stock = lines.map(l => {
        const p = db.products.find(x => x.id === l.product_id);
        if (l.diff) opnameLog(db, p, l.diff, l.counted, l.system, note, u.name);
        p.stock = l.counted;
        return { product_id: p.id, stock: p.stock };
      });
      opnameProgress(db, u, lines, u.name); // v37
      return { applied: true, lines, stock, opname: opnameStatus(db) };
    }
    // v40 (owner 2026-10-12): the cashier's / accountant's count goes to the MANAGER (one approval for the whole table) and the
    // owner is told; a new count by the same person joins the table still waiting (as on the server)
    const apRole = 'manager';
    const sumOf = ls => { const diffs = ls.filter(l => l.diff); return `Stok opname ${ls.length} barang, ${diffs.length} selisih` + (diffs.length ? ': ' + diffs.slice(0, 3).map(l => `${l.name} ${fmtQty(l.system)}→${fmtQty(l.counted)}`).join(', ') + (diffs.length > 3 ? ', …' : '') : ''); };
    const prev = db.approvals.find(a => a.kind === 'opname' && a.status === 'pending' && String(a.cashier).toLowerCase() === String(u.name).toLowerCase());
    if (prev) {
      let pl0 = {}; try { pl0 = JSON.parse(prev.payload || '{}'); } catch (e) { }
      const byPid = new Map((pl0.lines || []).map(l => [String(l.product_id), l]));
      lines.forEach(l => byPid.set(String(l.product_id), l));
      const merged = [...byPid.values()];
      Object.assign(prev, { approver_role: apRole, summary: sumOf(merged), payload: JSON.stringify({ lines: merged, counted_at: jktISO(), by: u.name, note: [pl0.note, note].filter(Boolean).join(' | ') }) });
      const approval = prev;
      return { applied: false, merged: true, request_id: prev.request_id, approval, lines: merged };
    }
    const approval = newApproval(db, u, { kind: 'opname', approver_role: apRole, summary: sumOf(lines), payload: JSON.stringify({ lines, counted_at: jktISO(), by: u.name, note }) });
    const nDiff = lines.filter(l => l.diff).length;
    ownerNotice(db, u, `Stok opname dari ${u.name}: ${lines.length} barang, ${nDiff} selisih — menunggu persetujuan manajer (${approval.request_id})`, nDiff ? 'warn' : 'info');
    return { applied: false, request_id: approval.request_id, approval, lines };
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
  function applyOpnameV37(db, u, ap, approver) { // v37: the approved count also moves the full-count cycle on
    let pl = {}; try { pl = JSON.parse(ap.payload || '{}'); } catch (e) { }
    const out = applyOpname(db, ap, approver);
    opnameProgress(db, u, pl.lines || [], approver + ' (dihitung ' + (pl.by || ap.cashier) + ')');
    return out;
  }
  const nameTokens = s => norm(s).replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean).map(w => w === 'gr' ? 'g' : w);
  function nameScore(a, b) { const A = nameTokens(a), B = new Set(nameTokens(b)); return A.length ? A.filter(w => B.has(w)).length / A.length : 0; }
  const blankProduct = () => ({ sku: '', name: '', category: '', unit: 'pcs', cost_price: 0, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0, stock: 0, min_stock: 0, active: true, notes: '', size: '', weight: '', exp_date: '', exp_none: false });

  /* ---- v11–v14 (mirrors backend process.js): devices, activity log, repacking, goods-in vs the photographed note,
     purchase corrections, payments with allocations, company bank account reconciliation ---- */
  const randId = n => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
  const fmtN = v => String(Math.round(num(v) * 1000) / 1000);
  const strv = v => v === undefined || v === null ? '' : String(v).trim();
  const REPACK_SUP = 'KEMAS ULANG';
  const internalSup = s => ['PENYESUAIAN STOK', 'STOK OPNAME', REPACK_SUP].includes(strv(s).toUpperCase());
  const roleOf = u => u.role === 'owner' ? 'owner' : u.role === 'manager' ? 'manager' : u.role === 'sales' ? 'sales' : 'kasir';
  const isAppr = u => u.role === 'owner' || u.role === 'manager';
  // v36 — mirror of the server's canDecide: the owner decides anything; the manager all but owner-only requests; the accountant the
  // shared manager-or-accountant ones (mgr_akuntan); a void of an EARLIER day's sale only the owner ("إصلاح فاتورة قديمة لا يتم إلا بموافقتي الشخصية").
  const voidSaleDate = a => { try { const pl = JSON.parse(a.payload || '{}'); if (pl && isYmd(pl.sale_date)) return pl.sale_date; } catch (e) { } const m = /(\d{4}-\d{2}-\d{2})/.exec(strv(a.summary)); return m ? m[1] : ''; };
  const isOldVoid = a => !!a && a.kind === 'void' && (!voidSaleDate(a) || voidSaleDate(a) < jktDate());
  const isOwnVoid = (u, a) => !!a && a.kind === 'void' && strv(a.cashier).toLowerCase() === strv(u.name).toLowerCase(); // never decide your own void
  const canDecideAp = (u, a) => u.role === 'owner' || (a.approver_role !== 'owner' && !isOldVoid(a) && !isOwnVoid(u, a) && (a.approver_role === 'mgr_akuntan' ? ['manager', 'akuntan'].includes(u.role) : u.role === 'manager'));
  function logAct(db, u, kind, summary, ref, amount, level) {
    db.activity = db.activity || [];
    db.activity.push({ id: nextId(db, 'activity'), act_id: 'AC' + randId(8), at: new Date().toISOString(), act_date: jktDate(), user: u.name, role: roleOf(u), kind,
      summary: strv(summary).slice(0, 1000), ref: strv(ref).slice(0, 60), amount: int(amount), level: level || 'info' });
  }
  /* ---- v37 (owner 2026-10-12: «أي فاتورة … لا يمكن تغييرها إلا بموافقة المدير، وإرسال إشعار إلى المالك: تم تغيير فاتورة، بالتاريخ والوقت،
     بالتدقيق، ومن قام بتغييرها ومن طلب تغييرها»): mirror of the server's invoice-change audit (activity kind 'ubah_faktur' + detail)
     and of the two-monthly full stock count (settings.opname_state / opname_every_days). Keep identical to backend/process.js. ---- */
  const wibStamp = iso => { const t0 = Date.parse(iso); return isFinite(t0) ? new Date(t0 + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' WIB' : ''; };
  const CHG_WHAT = { koreksi_masuk: 'Koreksi barang masuk', batal: 'Faktur dibatalkan', koreksi_harga: 'Koreksi harga faktur', retur: 'Retur atas faktur' };
  function changeText(c) {
    const parts = [];
    if (c.qty_from !== undefined && c.qty_to !== undefined && num(c.qty_from) !== num(c.qty_to)) parts.push('qty ' + fmtN(c.qty_from) + '→' + fmtN(c.qty_to));
    if (c.qty_ret !== undefined) parts.push('retur ' + fmtN(c.qty_ret) + (c.condition === 'rusak' ? ' (rusak)' : ''));
    if (c.price_from !== undefined && c.price_to !== undefined) parts.push(int(c.price_from) === int(c.price_to) ? 'harga Rp ' + int(c.price_to) : 'harga Rp ' + int(c.price_from) + '→' + int(c.price_to));
    if (c.invoices !== undefined) parts.push(fmtN(c.qty) + ' terjual di ' + c.invoices + ' faktur');
    return strv(c.name) + (parts.length ? ' ' + parts.join(', ') : '');
  }
  function invoiceChange(db, u, o) {
    const at = new Date().toISOString();
    const d = { doc: o.doc === 'masuk' ? 'masuk' : 'jual', what: strv(o.what), no: strv(o.no), nos: Array.isArray(o.nos) ? o.nos.slice(0, 200) : undefined, doc_date: strv(o.doc_date), party: strv(o.party),
      changes: (o.changes || []).slice(0, 100), reason: strv(o.reason).slice(0, 300), requested_by: strv(o.requested_by) || u.name, requested_at: strv(o.requested_at) || at, approved_by: strv(o.approved_by) || u.name,
      approved_role: roleOf(u), approved_at: at, request_id: strv(o.request_id), amount: int(o.amount), details: Array.isArray(o.details) ? o.details.slice(0, 200) : undefined };
    const docTxt = (d.doc === 'masuk' ? 'Barang masuk ' : 'Faktur ') + (d.nos && d.nos.length > 1 ? d.nos.slice(0, 8).join(', ') + (d.nos.length > 8 ? ' +' + (d.nos.length - 8) : '') : d.no);
    const same = d.requested_by.toLowerCase() === d.approved_by.toLowerCase();
    const summary = 'FAKTUR DIUBAH — ' + (CHG_WHAT[d.what] || d.what) + ': ' + docTxt + (d.doc_date ? ' (' + d.doc_date + (d.party ? ', ' + d.party : '') + ')' : (d.party ? ' (' + d.party + ')' : '')) +
      (d.changes.length ? ' — ' + d.changes.map(changeText).join('; ') : '') + (d.reason ? ' | alasan: ' + d.reason : '') +
      (same ? ' | diubah langsung oleh ' + d.approved_by + ' ' + wibStamp(at) : ' | diminta ' + d.requested_by + ' ' + wibStamp(d.requested_at) + ', disetujui ' + d.approved_by + ' ' + wibStamp(at));
    logAct(db, u, 'ubah_faktur', summary, d.no || (d.nos || [])[0] || '', d.amount, 'warn');
    db.activity[db.activity.length - 1].detail = JSON.stringify(d);
    return d;
  }
  const mockCostOk = (db, u) => u.role === 'owner' || (['akuntan', 'manager'].includes(u.role) && db.settings.akuntan_sees_cost === true);
  // v59: goods-in note amounts reach the manager and the accountant too (backend/process.js noteTotalOk)
  const mockNoteOk = (db, u) => mockCostOk(db, u) || ['akuntan', 'manager'].includes(u.role);
  function changeOut(db, u, a) {
    let d = {}; try { d = JSON.parse(a.detail || '{}') || {}; } catch (e) { d = {}; }
    const o = Object.assign({}, d, { act_id: a.act_id, at: a.at, act_date: a.act_date, user: a.user, amount: int(a.amount) });
    if (u.role === 'owner') o.summary = a.summary;
    if (d.doc === 'masuk' && !mockNoteOk(db, u)) { o.changes = (d.changes || []).map(c => { const x = Object.assign({}, c); ['price_from', 'price_to', 'total_from', 'total_to', 'total'].forEach(f => delete x[f]); return x; }); delete o.amount; }
    return o;
  }
  const isoDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const dayN = d => Math.round(Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') / 86400000);
  const OPNAME_FULL_PCT = 90;
  const opnameEvery = db => { const v = Math.round(num(db.settings.opname_every_days)); return v >= 7 && v <= 180 ? v : 60; };
  const opnameState = db => db.settings.opname_state && typeof db.settings.opname_state === 'object' ? db.settings.opname_state : {};
  function opnameStatus(db) {
    const s = opnameState(db), every = opnameEvery(db), T = jktDate();
    const base = isYmd(s.last_full) ? s.last_full : (isYmd(s.since) ? s.since : T);
    const next = isoDay(base, every), left = dayN(next) - dayN(T);
    const active = db.products.filter(p => p.active !== false), counted = new Set((s.counted || []).map(String));
    return { every_days: every, last_full: isYmd(s.last_full) ? s.last_full : '', last_full_by: strv(s.last_full_by), last_full_n: num(s.last_full_n), since: isYmd(s.since) ? s.since : '', base, next_due: next, days_left: left,
      status: left < 0 ? 'overdue' : left <= 7 ? 'due' : 'ok', cycle_from: isYmd(s.cycle_from) ? s.cycle_from : '', counted_n: active.filter(p => counted.has(String(p.id))).length, active_n: active.length, full_pct: OPNAME_FULL_PCT };
  }
  function opnameProgress(db, u, lines, byName) {
    const s = Object.assign({}, opnameState(db)), T = jktDate();
    if (!isYmd(s.since)) s.since = T;
    if (!isYmd(s.cycle_from) || dayN(T) - dayN(s.cycle_from) > opnameEvery(db)) { s.cycle_from = T; s.counted = []; }
    const set = new Set((s.counted || []).map(String));
    (lines || []).forEach(l => { if (db.products.some(p => String(p.id) === String(l.product_id))) set.add(String(l.product_id)); });
    const active = db.products.filter(p => p.active !== false), covered = active.filter(p => set.has(String(p.id))).length;
    s.last_count = T;
    if (active.length && covered * 100 >= active.length * OPNAME_FULL_PCT) {
      Object.assign(s, { last_full: T, last_full_at: new Date().toISOString(), last_full_by: strv(byName), last_full_n: covered, cycle_from: '', counted: [], overdue_noted: '' });
      logAct(db, u, 'opname_penuh', 'Stok opname PENUH selesai: ' + covered + ' dari ' + active.length + ' barang aktif (oleh ' + strv(byName) + '). Berikutnya paling lambat ' + isoDay(T, opnameEvery(db)), '', 0, 'info');
    } else s.counted = [...set].map(k => isFinite(Number(k)) ? Number(k) : k);
    db.settings.opname_state = s;
  }
  function settingsOut(db, role) {
    const st = Object.assign({}, V16_DEFAULTS, db.settings);
    st.repack_materials = window.KRepackMock ? window.KRepackMock.catalogOut(db, role) : []; // v50: names only for the cashier / rep
    st.supplier_dir = (Array.isArray(db.settings.supplier_dir) ? db.settings.supplier_dir : []).map(x => ['owner', 'manager', 'akuntan'].includes(role) ? x : { n: x.n }); // v56
    delete st.acct_opening; // v67: the accounts' opening balances reach the Keuangan screen only (finance_position)
    if (st.opname_state && typeof st.opname_state === 'object') { const o = Object.assign({}, st.opname_state); o.counted_n = Array.isArray(o.counted) ? o.counted.length : 0; delete o.counted; st.opname_state = o; }
    return st;
  }
  /** v37: the first bootstrap starts the clock; once overdue the owner and the manager get ONE notice per due date. */
  function opnameBoot(db) {
    let s = opnameState(db);
    if (!isYmd(s.since) && !isYmd(s.last_full)) { s = Object.assign({}, s, { since: jktDate() }); db.settings.opname_state = s; db._dirty = true; }
    const st = opnameStatus(db);
    if (st.status === 'overdue' && strv(s.overdue_noted) !== st.next_due) {
      db.settings.opname_state = Object.assign({}, opnameState(db), { overdue_noted: st.next_due });
      db.activity = db.activity || [];
      db.activity.push({ id: nextId(db, 'activity'), act_id: 'AC' + randId(8), at: new Date().toISOString(), act_date: jktDate(), user: 'Sistem', role: 'system', kind: 'notifikasi',
        summary: 'Stok opname penuh TERLAMBAT ' + (-st.days_left) + ' hari: jatuh tempo ' + st.next_due + ', terakhir ' + (st.last_full || 'belum pernah') + ' (setiap ' + st.every_days + ' hari). Mulai hitung di Gudang → Stok opname.', ref: 'owner,manager', amount: 0, level: 'warn' });
      db._dirty = true;
    }
    return st;
  }
  /* ---- v16: shelf (toko) vs warehouse (gudang), discount limit, members, owner master code, own PINs ---- */
  const isHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const AGREED_KEYS = ['return_owner_min_value', 'return_owner_min_qty']; // changed only by owner–manager agreement
  const wibTime = iso => new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(11, 16) + ' WIB';
  const V16_DEFAULTS = { max_discount_pct: 3, receipt_send_fee: 500, sell_from_shop_only: true, return_owner_min_value: 2000000, return_owner_min_qty: 0, return_fee_pct: 0, require_return_photo: true, require_carrier: true, limit_agreements: [], member_enabled: true, member_tiers: [{ from: 2, pct: 2 }, { from: 5, pct: 3 }, { from: 10, pct: 5 }] };
  const setting = (db, k) => db.settings && db.settings[k] !== undefined ? db.settings[k] : V16_DEFAULTS[k];
  /** stock = total, shop_stock = on the shelf; a row without shop_stock (before v16) counts all its stock as on the shelf */
  const shopOf = p => p.shop_stock === undefined || p.shop_stock === null || p.shop_stock === '' ? num(p.stock) : num(p.shop_stock);
  const prodOut = p => Object.assign({}, p, { shop_stock: shopOf(p), gudang_stock: roundQty(num(p.stock) - shopOf(p)) });
  // v48 (owner 2026-10-14): a pack's materials (sticker, lid, jar …) with their cost per pack — mirrors the server's repackCostsOf;
  // the cashier / rep see the names only (productOut on the server).
  // v50: with the materials list (settings.repack_materials) — one copy for both demo apps in shared/repack-mock.js
  const repackCostsOf = (db, p) => window.KRepackMock.costsOf(db, p);
  const repackCostPer = (db, p) => window.KRepackMock.costPer(db, p);
  const costNamesFor = (db, p, role) => window.KRepackMock.productCosts(db, p, role);
  // v50 (owner 2026-10-15): two-step repacking + the materials list, written once in shared/repack-mock.js, loaded on the first request
  let repackLoad = null;
  function loadRepackMock(src) {
    if (window.KRepackMock) return Promise.resolve();
    return repackLoad || (repackLoad = new Promise(res => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); }));
  }
  /** After every request (like the server's normShop): sales / voids / move_stock set the shelf; any other stock change
   *  keeps the shelf as it was, capped at the total; a new product's opening stock is on the shelf. */
  function normShop(db, snap) {
    const set = db._shopSet || {};
    db.products.forEach(p => {
      const o = snap.get(p.id), st = num(p.stock);
      if (o && st === o.stock && set[p.id] === undefined) return;
      let sh = set[p.id] !== undefined ? set[p.id] : (o ? o.shop : st);
      if (sh > st) sh = st;
      if (sh < 0 && st >= 0) sh = 0;
      p.shop_stock = roundQty(sh);
    });
  }
  const maxDiscountPct = db => { const v = num(setting(db, 'max_discount_pct')); return v > 0 ? v : 3; };
  /** member discount: this sale is purchase number visits + 1; the highest tier with from <= that number */
  function memberInfo(db, cust) {
    if (!cust || cust.member !== true || setting(db, 'member_enabled') === false) return null;
    const n = Math.max(0, Math.round(num(cust.visits))) + 1;
    const tiers = Array.isArray(setting(db, 'member_tiers')) ? setting(db, 'member_tiers') : V16_DEFAULTS.member_tiers;
    let pct = 0;
    tiers.forEach(x => { const f = num(x && x.from), q = num(x && x.pct); if (f >= 1 && f <= n && q > 0 && q <= 50 && q > pct) pct = q; });
    return { pct, purchase_no: n, member_no: strv(cust.member_no) };
  }
  const discountOf = P => { const amount = Math.max(0, P.listTotal - (P.total - (P.sendFee || 0))); return { amount, pct: P.listTotal > 0 ? Math.round(amount / P.listTotal * 1000) / 10 : 0 }; };
  const marginPct = (total, cost) => total > 0 ? Math.round((total - cost) / total * 1000) / 10 : 0;
  const isEmail = v => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(v) && v.length <= 120;
  const qtyOnly = c => { const x = Object.assign({}, c); ['cost_price', 'from_total', 'to_total', 'd_total'].forEach(k => delete x[k]); return x; };
  /** approvals as kasir / manager see them (server approvalOut): no purchase prices, no profit */
  function aprOut(a) {
    if (!a || typeof a !== 'object' || !a.request_id) return a;
    if (a.kind === 'purchase_fix') {
      const o = Object.assign({}, a);
      try { const pl = JSON.parse(a.payload || '{}'); if (Array.isArray(pl.changes)) pl.changes = pl.changes.map(qtyOnly); o.payload = JSON.stringify(pl); } catch (e) { o.payload = ''; }
      o.summary = strv(o.summary).replace(/ \(Rp -?\d+→-?\d+\)/g, ''); o.total = 0;
      return o;
    }
    if (a.kind === 'retur') {
      const o = Object.assign({}, a);
      try { const pl = JSON.parse(a.payload || '{}'); if (pl.kind === 'pemasok') { delete pl.value; delete pl.refund; (pl.lines || []).forEach(l => { delete l.unit_price; delete l.value; }); o.payload = JSON.stringify(pl); o.total = 0; o.summary = strv(o.summary).replace(/ \| nilai Rp -?\d+/g, ''); } } catch (e) { o.payload = ''; }
      return o;
    }
    if (a.kind === 'product_new') { // v36: the supplier-invoice cost of a cashier's new product
      const o = Object.assign({}, a);
      try { const pl = JSON.parse(a.payload || '{}'); delete pl.cost_price; o.payload = JSON.stringify(pl); } catch (e) { o.payload = ''; }
      return o;
    }
    if (a.kind === 'discount') {
      const o = Object.assign({}, a);
      try { const pl = JSON.parse(a.payload || '{}'); ['profit_before', 'profit_after', 'margin_before', 'margin_after', 'cost'].forEach(k => delete pl[k]); o.payload = JSON.stringify(pl); } catch (e) { o.payload = ''; }
      o.summary = strv(o.summary).replace(/ \| laba[^|]*/g, '');
      return o;
    }
    return a;
  }
  /* ---- v16 returns (retur), who brought the goods (carrier), plain-text input — as on the server ---- */
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
  const RETURN_REASONS = ['tidak_sesuai', 'rusak', 'kadaluarsa', 'salah_kirim', 'kualitas_buruk', 'berubah_pikiran', 'lainnya'];
  const RETURN_REASON_TEXT = { tidak_sesuai: 'Tidak sesuai spesifikasi', rusak: 'Rusak / cacat', kadaluarsa: 'Kedaluwarsa', salah_kirim: 'Salah kirim / salah barang', kualitas_buruk: 'Kualitas buruk', berubah_pikiran: 'Pelanggan berubah pikiran', lainnya: 'Lainnya' };
  const personName = v => { const x = strv(v).replace(/\s+/g, ' '); return /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'-]{0,59}$/u.test(x) ? x : ''; };
  const safeName = (v, max) => { const x = strv(v).replace(/\s+/g, ' '); return x.length <= (max || 80) && /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'&()\/%+#-]*$/u.test(x) ? x : ''; };
  const docNo = v => { const x = strv(v).toUpperCase().replace(/\s+/g, ' '); return /^[A-Z0-9][A-Z0-9 \/.-]{0,39}$/.test(x) ? x : ''; };
  const CARRIER_TYPES = ['umum', 'teman', 'pemasok', 'karyawan'];
  function readCarrier(c, required) {
    c = c && typeof c === 'object' ? c : {};
    const type = CARRIER_TYPES.indexOf(c.type) >= 0 ? c.type : '';
    if (!type) return required ? { error: 'Pilih siapa yang membawa barang (kendaraan umum / teman / sopir pemasok / karyawan)' } : { type: '', name: '', vehicle: '', phone: '' };
    const name = strv(c.name) ? personName(c.name) : '';
    if (strv(c.name) && !name) return { error: 'Nama pembawa barang hanya boleh huruf' };
    const vehicle = strv(c.vehicle) ? docNo(c.vehicle) : '';
    if (strv(c.vehicle) && !vehicle) return { error: 'Nomor kendaraan hanya boleh huruf dan angka' };
    const phone = strv(c.phone) ? normPhone(c.phone) : '';
    if (strv(c.phone) && !phone) return { error: 'Nomor HP pembawa tidak valid' };
    if (type === 'umum' && !vehicle) return { error: 'Kendaraan umum: tulis nomor kendaraannya (plat / nomor angkot)' };
    if ((type === 'teman' || type === 'karyawan') && !name) return { error: 'Tulis nama orang yang membawa barang' };
    const kindText = strv(c.kind) ? strv(c.kind).replace(/[^\p{L}\p{N} -]/gu, '').slice(0, 30) : '';
    return { type, name: name || kindText, vehicle, phone };
  }
  const CARRIER_TEXT = { umum: 'kendaraan umum', teman: 'teman', pemasok: 'sopir pemasok', karyawan: 'karyawan' };
  /** quantities already returned (approved returns + pending requests) for one invoice / goods-in note */
  function returnedBefore(db, ref) {
    const q = {};
    const add = lines => (Array.isArray(lines) ? lines : []).forEach(l => { const k = String(l.product_id); q[k] = roundQty((q[k] || 0) + num(l.qty)); });
    (db.returns || []).filter(r => strv(r.ref) === ref && r.status === 'approved').forEach(r => { let l = []; try { l = typeof r.lines === 'string' ? JSON.parse(r.lines || '[]') : r.lines; } catch (e) { l = []; } add(l); });
    db.approvals.filter(a => a.kind === 'retur' && a.status === 'pending').forEach(a => { let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; } if (strv(pl.ref) === ref) add(pl.lines); });
    return q;
  }
  function returnOut(r, role) {
    if (!r) return null;
    const o = JSON.parse(JSON.stringify(r)); delete o.id;
    if (typeof o.lines === 'string') { try { o.lines = JSON.parse(o.lines); } catch (e) { o.lines = []; } }
    if (role === 'kasir' && o.kind === 'pemasok') return null;
    if (role !== 'owner' && o.kind === 'pemasok') { delete o.value; delete o.refund; (o.lines || []).forEach(l => { delete l.unit_price; delete l.value; }); }
    return o;
  }
  /* devices (v11): written only when something changed or every 10 minutes */
  const isCoord = (lat, lng) => lat !== null && lat !== '' && lat !== undefined && lng !== null && lng !== '' && lng !== undefined && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && !(Number(lat) === 0 && Number(lng) === 0);
  function metres(aLat, aLng, bLat, bLng) {
    const R = 6371000, k = Math.PI / 180, dLat = (bLat - aLat) * k, dLng = (bLng - aLng) * k;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * k) * Math.cos(bLat * k) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }
  function deviceTouch(db, u, dev, force) {
    if (!dev || typeof dev !== 'object') return null;
    const id = strv(dev.id);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
    db.devices = db.devices || [];
    const ex = db.devices.find(x => x.device_id === id) || null;
    const now = new Date().toISOString(), hasLoc = isCoord(dev.lat, dev.lng);
    const status = ['granted', 'denied', 'unavailable', 'prompt', 'off'].includes(dev.loc_status) ? dev.loc_status : (hasLoc ? 'granted' : 'unavailable');
    if (ex && !force) {
      const moved = hasLoc && (!isCoord(ex.lat, ex.lng) || metres(num(ex.lat), num(ex.lng), num(dev.lat), num(dev.lng)) > 100);
      const stale = !(Date.parse(ex.last_seen) > Date.now() - 600000);
      if (!moved && !stale && strv(ex.user) === u.name && strv(ex.loc_status) === status) return ex;
    }
    const row = {
      device_id: id, user: u.name, role: roleOf(u), app: ['owner', 'kasir', 'sales'].includes(dev.app) ? dev.app : 'owner',
      label: strv(dev.label).slice(0, 60), ua: strv(navigator.userAgent).slice(0, 300), ip: '',
      lat: hasLoc ? Math.round(num(dev.lat) * 1e6) / 1e6 : (ex ? num(ex.lat) : 0), lng: hasLoc ? Math.round(num(dev.lng) * 1e6) / 1e6 : (ex ? num(ex.lng) : 0),
      acc: hasLoc ? Math.round(num(dev.acc)) : (ex ? num(ex.acc) : 0), loc_status: status, loc_at: hasLoc ? now : (ex ? strv(ex.loc_at) : ''),
      first_seen: ex ? strv(ex.first_seen) || now : now, last_seen: now, pings: (ex ? num(ex.pings) : 0) + 1,
      battery: dev.battery !== null && dev.battery !== '' && dev.battery !== undefined && Number.isFinite(Number(dev.battery)) ? Math.round(Math.min(1, Math.max(0, num(dev.battery))) * 100) / 100 : (ex ? num(ex.battery) : 0)
    };
    if (ex) Object.assign(ex, row); else db.devices.push(Object.assign({ id: nextId(db, 'device') }, row));
    db._dirty = true;
    if (!ex) logAct(db, u, 'perangkat_baru', 'Perangkat baru: ' + (row.label || 'tanpa nama') + ' (' + row.app + ', ' + u.name + ')' + (row.ip ? ' IP ' + row.ip : ''), id, 0, 'info');
    return row;
  }
  /* goods-in vs the photographed supplier note (same algorithm as the server) */
  const normName = x => strv(x).toLowerCase().replace(/(\d+)[.,]?(\d*)\s*(kg|gr|gram|g|ml|ltr|l|pcs|pc)\b/g, '$1$2$3').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const nTokens = x => normName(x).split(' ').filter(t => t.length > 1);
  function nearTok(a1, b1) {
    if (a1 === b1) return true;
    if (a1.length > 3 && b1.length > 3 && (a1.indexOf(b1) === 0 || b1.indexOf(a1) === 0)) return true;
    if (a1.length < 5 || b1.length < 5 || Math.abs(a1.length - b1.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a1.length && j < b1.length) {
      if (a1[i] === b1[j]) { i++; j++; continue; }
      edits++;
      if (edits > 1) return false;
      if (a1.length > b1.length) i++; else if (b1.length > a1.length) j++; else { i++; j++; }
    }
    return edits + (a1.length - i) + (b1.length - j) <= 1;
  }
  function nScore(a1, b1) {
    const ta = nTokens(a1), tb = nTokens(b1);
    if (!ta.length || !tb.length) return 0;
    let hit = 0;
    ta.forEach(t => { if (tb.some(x => nearTok(t, x))) hit++; });
    return Math.round(((hit / ta.length + hit / tb.length) / 2) * 100) / 100;
  }
  const photoEx = ph => { try { const v = typeof ph.extracted === 'string' ? JSON.parse(ph.extracted || '{}') : (ph.extracted || {}); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } };
  function matchNote(lines, photoRow) {
    const ex = photoEx(photoRow);
    const pitems = Array.isArray(ex.items) ? ex.items : [];
    if (ex.readable === false || !pitems.length) return { status: 'perlu_cek', diffs: [], notes: 'Nota tidak terbaca' };
    const used = {}, diffs = [];
    let unsure = false;
    lines.forEach(l => {
      let idx = -1;
      const pi = Number(l.photo_index);
      if (l.photo_index !== undefined && l.photo_index !== null && l.photo_index !== '' && Number.isFinite(pi) && pi >= 0 && pi < pitems.length && !used[pi]) idx = pi;
      if (idx < 0) {
        let best = -1, bs = 0;
        pitems.forEach((it, k) => { if (used[k]) return; const sc = nScore(it.name, l.name); if (sc > bs) { bs = sc; best = k; } });
        if (bs >= 0.5) idx = best;
      }
      if (idx < 0) { diffs.push({ name: l.name, recorded_qty: l.qty, photo_qty: null }); return; }
      used[idx] = true;
      const pq = pitems[idx].qty;
      if (pq === null || pq === undefined || !Number.isFinite(Number(pq))) { unsure = true; return; }
      if (Math.abs(num(pq) - num(l.qty)) > 0.001) diffs.push({ name: l.name, recorded_qty: l.qty, photo_qty: num(pq) });
    });
    pitems.forEach((it, k) => { if (!used[k] && strv(it.name)) diffs.push({ name: strv(it.name), recorded_qty: null, photo_qty: it.qty === null || it.qty === undefined ? null : num(it.qty) }); });
    return { status: diffs.length ? 'tidak_cocok' : (unsure ? 'perlu_cek' : 'cocok'), diffs: diffs.slice(0, 50), notes: '' };
  }
  const diffText = diffs => diffs.map(d => d.name + ': input ' + (d.recorded_qty === null ? '-' : fmtN(d.recorded_qty)) + ' / nota ' + (d.photo_qty === null ? '-' : fmtN(d.photo_qty))).join('; ');
  // v36 (owner 2026-10-11): expense item lines vs the AI-read invoice — the server's expenseLinesIn / expenseCompare.
  function expenseLinesIn(raw) {
    const list = Array.isArray(raw) ? raw.slice(0, 50) : [], out = [];
    for (let i = 0; i < list.length; i++) {
      const l = list[i] || {}, name = strv(l.name).replace(/\s+/g, ' ').slice(0, 80), qty = roundQty(l.qty), price = int(l.unit_price);
      if (!name && !qty && !price) continue;
      if (!name) return { error: 'Nama barang wajib di baris ' + (i + 1) };
      if (!(qty > 0)) return { error: 'Jumlah tidak valid: ' + name };
      if (price < 0) return { error: 'Harga tidak valid: ' + name };
      out.push({ name, qty, unit_price: price, total: Math.round(qty * price) });
    }
    return { lines: out };
  }
  function expenseCompare(lines, amount, ex) {
    ex = ex && typeof ex === 'object' ? ex : {};
    const nn = x => x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
    const items = (Array.isArray(ex.items) ? ex.items : []).filter(it => it && strv(it.name));
    let pamt = nn(ex.amount); if (pamt === null) pamt = nn(ex.total); if (pamt !== null) pamt = Math.round(pamt);
    const invoice = { count: items.length, total: pamt, vendor: ex.vendor ? strv(ex.vendor).slice(0, 120) : '' };
    if (ex.readable === false || (pamt === null && !items.length)) return { status: 'cek_manual', diffs: [], rows: [], invoice };
    const diffs = [], rows = [];
    let unsure = false;
    if (pamt !== null && Math.abs(pamt - int(amount)) > 0.5) diffs.push({ field: 'total', name: '', typed: int(amount), invoice: pamt });
    if (lines.length && !items.length) unsure = true;
    else if (lines.length) {
      if (lines.length !== items.length) diffs.push({ field: 'count', name: '', typed: lines.length, invoice: items.length });
      const used = {}, pair = [];
      lines.forEach((l, i) => { let best = -1, bs = 0; items.forEach((it, k) => { if (used[k]) return; const sc = nScore(it.name, l.name); if (sc > bs) { bs = sc; best = k; } }); if (bs >= 0.5) { used[best] = true; pair[i] = best; } });
      if (lines.length === items.length) lines.forEach((l, i) => { if (pair[i] === undefined && !used[i]) { used[i] = true; pair[i] = i; } });
      lines.forEach((l, i) => {
        const row = { name: l.name, qty: l.qty, unit_price: int(l.unit_price), inv_name: '', inv_qty: null, inv_price: null, bad: [] };
        rows.push(row);
        if (pair[i] === undefined) { row.bad.push('extra'); diffs.push({ field: 'extra', name: l.name, typed: l.total, invoice: null }); return; }
        const it = items[pair[i]], iq = nn(it.qty);
        let ip = nn(it.unit_price);
        if (ip === null && nn(it.total) !== null && iq) ip = Math.round(Number(it.total) / iq);
        row.inv_name = strv(it.name).slice(0, 80); row.inv_qty = iq; row.inv_price = ip === null ? null : Math.round(ip);
        if (iq === null || ip === null) unsure = true;
        if (iq !== null && Math.abs(iq - num(l.qty)) > 0.001) { row.bad.push('qty'); diffs.push({ field: 'qty', name: l.name, typed: l.qty, invoice: iq }); }
        if (ip !== null && Math.abs(Math.round(ip) - int(l.unit_price)) > 0.5) { row.bad.push('price'); diffs.push({ field: 'price', name: l.name, typed: int(l.unit_price), invoice: Math.round(ip) }); }
      });
      items.forEach((it, k) => { if (used[k]) return; const iq = nn(it.qty), ip = nn(it.unit_price); rows.push({ name: '', qty: null, unit_price: null, inv_name: strv(it.name).slice(0, 80), inv_qty: iq, inv_price: ip === null ? null : Math.round(ip), bad: ['missing'] }); diffs.push({ field: 'missing', name: strv(it.name).slice(0, 80), typed: null, invoice: nn(it.total) }); });
    }
    return { status: diffs.length ? 'selisih' : (unsure ? 'cek_manual' : 'cocok'), diffs: diffs.slice(0, 60), rows: rows.slice(0, 60), invoice };
  }
  const expenseDiffText = diffs => diffs.map(d => {
    const v = (f, x) => x === null || x === undefined ? '-' : (f === 'qty' || f === 'count' ? fmtN(x) : 'Rp ' + int(x));
    const what = { total: 'Total', count: 'Jumlah jenis barang', qty: 'Qty ' + strv(d.name), price: 'Harga ' + strv(d.name), extra: 'Tidak ada di nota: ' + strv(d.name), missing: 'Tidak diketik: ' + strv(d.name) }[d.field] || d.field;
    return d.field === 'extra' || d.field === 'missing' ? what : what + ' input ' + v(d.field, d.typed) + ' / nota ' + v(d.field, d.invoice);
  }).join('; ');
  /* corrections of a saved goods-in (purchase_no) */
  function purchaseFixChanges(db, no, lines) {
    const cur = {};
    db.purchases.filter(r => strv(r.purchase_no) === no).forEach(r => {
      const k = String(r.product_id);
      if (!cur[k]) cur[k] = { qty: 0, total: 0, supplier: strv(r.supplier), name: strv(r.name) };
      cur[k].qty = Math.round((cur[k].qty + num(r.qty)) * 1000) / 1000;
      cur[k].total += int(r.total);
    });
    const changes = [];
    (Array.isArray(lines) ? lines : []).slice(0, 100).forEach(l => {
      const c = cur[String(l.product_id)];
      if (!c) return;
      const qty = Math.round(num(l.qty) * 1000) / 1000;
      if (qty < 0) return;
      const cost = l.cost_price === undefined || l.cost_price === null || l.cost_price === '' ? (c.qty > 0 ? Math.round(c.total / c.qty) : 0) : int(l.cost_price);
      const total = Math.round(qty * cost);
      const dq = Math.round((qty - c.qty) * 1000) / 1000, dt = total - c.total;
      if (dq !== 0 || dt !== 0) changes.push({ product_id: Number(l.product_id), name: c.name, supplier: c.supplier, from_qty: c.qty, to_qty: qty, from_total: c.total, to_total: total, cost_price: cost, d_qty: dq, d_total: dt });
    });
    return { found: Object.keys(cur).length > 0, changes };
  }
  function applyPurchaseFix(db, no, changes, reason, byName) {
    const out = [];
    changes.forEach(ch => {
      const p = db.products.find(x => x.id === Number(ch.product_id));
      if (!p) return;
      const st = num(p.stock), ns = Math.round((st + ch.d_qty) * 1000) / 1000;
      const nc = ns > 0 && st + ch.d_qty > 0 ? Math.max(0, Math.round((Math.max(0, st) * int(p.cost_price) + ch.d_total) / Math.max(ns, 0.001))) : int(p.cost_price);
      p.stock = ns; p.cost_price = nc;
      db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: ch.supplier, product_id: p.id, name: p.name, qty: ch.d_qty, cost_price: ch.cost_price, total: ch.d_total,
        note: ('KOREKSI ' + no + ': ' + fmtN(ch.from_qty) + '→' + fmtN(ch.to_qty) + ' | ' + strv(reason)).slice(0, 500), user: byName, photo_id: '', exp_date: '',
        purchase_no: no, match_status: 'koreksi', match_notes: strv(reason).slice(0, 300) });
      out.push({ product_id: p.id, stock: ns, cost_price: nc });
    });
    return out;
  }
  function voidChange(db, u, sale, reason, requestedBy, requestedAt, requestId) {
    return invoiceChange(db, u, { doc: 'jual', what: 'batal', no: sale.invoice_no, doc_date: strv(sale.sale_date), party: strv(sale.customer_name),
      changes: db.items.filter(i => i.invoice_no === sale.invoice_no).map(i => ({ product_id: i.product_id, name: strv(i.name), qty_from: num(i.qty), qty_to: 0, price_from: int(i.unit_price), price_to: int(i.unit_price), total_from: int(i.line_total), total_to: 0 })),
      reason, requested_by: requestedBy, requested_at: requestedAt, request_id: requestId, amount: -int(sale.total) });
  }
  function purchaseFixChange(db, u, no, first, changes, reason, requestedBy, requestedAt, requestId) {
    return invoiceChange(db, u, { doc: 'masuk', what: 'koreksi_masuk', no, doc_date: strv(first.purchase_date), party: strv(first.supplier),
      changes: changes.map(c => ({ product_id: c.product_id, name: c.name, qty_from: c.from_qty, qty_to: c.to_qty, price_from: c.from_qty > 0 ? Math.round(c.from_total / c.from_qty) : c.cost_price, price_to: c.cost_price, total_from: c.from_total, total_to: c.to_total })),
      reason, requested_by: requestedBy, requested_at: requestedAt, request_id: requestId, amount: sum(changes, c => c.d_total) });
  }
  const fixSummary = (no, changes) => 'Koreksi barang masuk ' + no + ': ' + changes.map(c => c.name + ' ' + fmtN(c.from_qty) + '→' + fmtN(c.to_qty) + (c.d_total ? ' (Rp ' + c.from_total + '→' + c.to_total + ')' : '')).join('; ');
  /* payments in / out (v13) */
  const payAlloc = p => { let a = []; try { a = typeof p.alloc === 'string' ? JSON.parse(p.alloc || '[]') : (p.alloc || []); } catch (e) { a = []; } return Array.isArray(a) ? a : []; };
  const payDir = p => strv(p.direction) || 'in';
  const payOut = p => { const o = Object.assign({}, p); delete o.id; o.alloc = payAlloc(p); return o; };
  // v65: goods-in confirmed by the manager / accountant with how it was paid (as on the server)
  const INTERNAL_SUP = ['STOK OPNAME', 'PENYESUAIAN STOK', 'KEMAS ULANG'];
  const rpTxt = v => 'Rp ' + String(Math.round(Math.abs(num(v)))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  function markNotesPaid(db, docs, alloc, payDate) {
    const left = {};
    alloc.forEach(a => { if (docs[a.ref]) left[a.ref] = docs[a.ref].remaining - int(a.amount); });
    db.purchases.forEach(r => { const ref = strv(r.purchase_no); if (left[ref] !== undefined && left[ref] <= 0 && strv(r.check_status) && strv(r.pay_status) !== 'lunas') Object.assign(r, { pay_status: 'lunas', paid_at: payDate }); });
  }
  function purchaseChecks(db) {
    const t0 = jktDate(), since = new Date(Date.parse(t0) - 30 * 86400000).toISOString().slice(0, 10);
    const due3 = new Date(Date.parse(t0) + 3 * 86400000).toISOString().slice(0, 10), by = {}, due = {};
    db.purchases.forEach(r => {
      const no = strv(r.purchase_no); if (!no || INTERNAL_SUP.includes(strv(r.supplier))) return;
      if (strv(r.purchase_date) >= since && !strv(r.check_status)) (by[no] = by[no] || []).push(r);
      if (strv(r.pay_status) === 'tempo' && strv(r.due_date) <= due3) (due[no] = due[no] || []).push(r);
    });
    const one = rs => ({ purchase_no: strv(rs[0].purchase_no), supplier: strv(rs[0].supplier), purchase_date: strv(rs[0].purchase_date), due_date: strv(rs[0].due_date), total: rs.reduce((a, r) => a + int(r.total), 0) });
    return { waiting: Object.values(by).map(one).map(x => ({ purchase_no: x.purchase_no, supplier: x.supplier, purchase_date: x.purchase_date })),
      due: Object.values(due).map(one).map(x => ({ purchase_no: x.purchase_no, supplier: x.supplier, due_date: x.due_date, days: Math.round((Date.parse(x.due_date) - Date.parse(t0)) / 86400000), total: x.total })) };
  }
  const partyPays = (db, pt, key) => db.payments.filter(p => pt === 'customer' ? (Number(p.customer_id) === Number(key) && payDir(p) === 'in') : (strv(p.supplier) === key && payDir(p) === 'out'));
  function partyDocs(db, pt, key, excludePayId) {
    const docs = {};
    if (pt === 'customer') {
      db.sales.filter(x => Number(x.customer_id) === Number(key) && x.status !== 'void' && int(x.debt_amount) > 0).forEach(x => { docs[x.invoice_no] = { ref: x.invoice_no, date: strv(x.sale_date), total: int(x.debt_amount), paid: 0 }; });
    } else {
      db.purchases.filter(x => strv(x.supplier) === key).forEach(x => {
        const ref = strv(x.purchase_no) || ('PB-' + strv(x.purchase_date));
        if (!docs[ref]) docs[ref] = { ref, date: strv(x.purchase_date), total: 0, paid: 0 };
        docs[ref].total += int(x.total);
        if (strv(x.pay_status) === 'tempo' && strv(x.due_date)) docs[ref].due_date = strv(x.due_date); // v65: the agreed date
        if (strv(x.purchase_date) < docs[ref].date) docs[ref].date = strv(x.purchase_date);
      });
    }
    partyPays(db, pt, key).forEach(p => { if (excludePayId && p.pay_id === excludePayId) return; payAlloc(p).forEach(a => { if (docs[a.ref]) docs[a.ref].paid += int(a.amount); }); });
    Object.keys(docs).forEach(k => { docs[k].remaining = Math.max(0, docs[k].total - docs[k].paid); });
    return docs;
  }
  function checkAlloc(list, docs, amount) {
    const out = [], seen = {};
    let total = 0;
    const src = Array.isArray(list) ? list.slice(0, 50) : [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i] || {};
      const ref = strv(a.ref || a.invoice_no || a.purchase_no), amt = int(a.amount);
      if (!ref || !(amt > 0)) throw E('INVALID', 'Alokasi tidak valid');
      if (!docs[ref]) throw E('INVALID', 'Faktur / nota tidak ditemukan untuk pihak ini: ' + ref);
      if (seen[ref]) throw E('INVALID', 'Faktur dobel di alokasi: ' + ref);
      seen[ref] = true;
      if (amt > docs[ref].remaining) throw E('INVALID', 'Alokasi ' + ref + ' melebihi sisa (' + docs[ref].remaining + ')');
      total += amt;
      out.push({ ref, amount: amt });
    }
    if (total > amount) throw E('INVALID', 'Total alokasi melebihi jumlah pembayaran');
    return { alloc: out, sum: total };
  }
  function allocStatus(amount, chk, docs) {
    if (!chk.alloc.length) return 'belum_dialokasi';
    if (chk.alloc.some(a => docs[a.ref].remaining - a.amount > 0)) return 'sebagian';
    if (chk.sum < amount) return 'lebih';
    return 'lunas';
  }
  function slipCheck(db, data, amount) {
    if (!strv(data.photo_id)) return null;
    const ph = db.photos.find(x => x.photo_id === strv(data.photo_id));
    if (!ph || ph.kind !== 'bayar') throw E('INVALID', 'Foto bukti pembayaran tidak ditemukan');
    const ex = photoEx(ph);
    const slip = ex.amount === null || ex.amount === undefined || !Number.isFinite(Number(ex.amount)) ? null : int(ex.amount);
    if (slip !== null && slip !== amount && !strv(data.mismatch_reason)) throw E('MISMATCH', 'Jumlah tidak sama dengan bukti transfer: input ' + amount + ', bukti ' + slip, { slip_amount: slip, extracted: ex });
    return { slip, ex };
  }
  const dupRef = (pays, ref) => !!strv(ref) && pays.some(p => strv(p.transfer_ref) && strv(p.transfer_ref).toLowerCase() === strv(ref).toLowerCase());
  /* company bank accounts + monthly statement (v14) */
  const bankAccounts = db => { const a = (db.settings || {}).bank_accounts; return Array.isArray(a) ? a.filter(x => x && strv(x.id)) : []; };
  function payAccount(db, data, method, ex, dir) {
    if (method !== 'transfer' && method !== 'qris') return '';
    const accs = bankAccounts(db), want = strv(data.account_id);
    if (want && accs.some(x => strv(x.id) === want)) return want;
    const fromSlip = ex && window.KBank ? KBank.slipAccount(accs, ex, dir || 'in') : ''; // v57: the account the slip shows
    if (fromSlip) return fromSlip;
    const act = accs.filter(x => x.active !== false);
    return act.length ? strv(act[0].id) : '';
  }
  const dayNum = d => Math.round(Date.parse(String(d).slice(0, 10) + 'T00:00:00Z') / 86400000);
  function periodRange(period) {
    const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: period + '-01', to: period + '-' + (last < 10 ? '0' : '') + last };
  }
  /** "Get Range Payments" for the bank actions: the month ± 3 days. */
  function rangePays(db, period) { const pr = periodRange(period), f = addDays(pr.from, -3), t2 = addDays(pr.to, 3); return db.payments.filter(p => strv(p.pay_date) >= f && strv(p.pay_date) <= t2); }
  function reconcile(db, lines, accountId, period) {
    const pr = periodRange(period);
    const pays = rangePays(db, period).filter(p => (p.method === 'transfer' || p.method === 'qris') && (!strv(p.account_id) || strv(p.account_id) === accountId));
    const used = {};
    lines.forEach(l => { if (l.status === 'manual' && l.pay_id) used[l.pay_id] = true; });
    const out = lines.filter(l => l.status !== 'dihapus').map(l => {
      const r = { line_id: l.line_id, seq: l.seq, line_date: l.line_date, description: l.description, amount: int(l.amount), ref: l.ref, balance: l.balance, note: strv(l.note) };
      if (l.status === 'manual' || l.status === 'diabaikan') return Object.assign(r, { status: l.status, pay_id: strv(l.pay_id), diff_days: 0 });
      const dir = int(l.amount) > 0 ? 'in' : 'out', abs = Math.abs(int(l.amount));
      const text = (strv(l.description) + ' ' + strv(l.ref)).toLowerCase();
      let best = null;
      pays.forEach(p => {
        if (used[p.pay_id] || payDir(p) !== dir) return;
        const refHit = !!(strv(p.transfer_ref) && strv(p.transfer_ref).length >= 4 && text.indexOf(strv(p.transfer_ref).toLowerCase()) >= 0);
        const diff = Math.abs(dayNum(l.line_date) - dayNum(p.pay_date));
        const same = int(p.amount) === abs;
        if (!same && !refHit) return;
        if (same && !refHit && diff > 3) return;
        const sc = (refHit ? 0 : 10) + (same ? 0 : 100) + diff;
        if (!best || sc < best.sc) best = { sc, p, diff, same };
      });
      if (!best) return Object.assign(r, { status: 'tidak_tercatat', pay_id: '', diff_days: null });
      used[best.p.pay_id] = true;
      return Object.assign(r, { status: !best.same ? 'beda_jumlah' : (best.diff <= 1 ? 'cocok' : 'beda_tanggal'), pay_id: best.p.pay_id, diff_days: best.diff,
        pay_amount: int(best.p.amount), pay_date: strv(best.p.pay_date), party: strv(best.p.customer_name) || strv(best.p.supplier) });
    });
    const inPeriod = pays.filter(p => strv(p.pay_date) >= pr.from && strv(p.pay_date) <= pr.to);
    const missing = inPeriod.filter(p => !used[p.pay_id]).map(payOut);
    const counts = {};
    out.forEach(x => { counts[x.status] = (counts[x.status] || 0) + 1; });
    return {
      lines: out, missing, counts,
      totals: { statement_in: sum(out, x => x.amount > 0 ? x.amount : 0), statement_out: sum(out, x => x.amount < 0 ? -x.amount : 0),
        recorded_in: sum(inPeriod, p => payDir(p) === 'in' ? int(p.amount) : 0), recorded_out: sum(inPeriod, p => payDir(p) === 'out' ? int(p.amount) : 0) }
    };
  }
  function reconText(acc, period, rep) {
    const c = rep.counts;
    return 'Rekening ' + strv(acc.bank) + ' ' + strv(acc.account_no) + ' ' + period + ': ' + rep.lines.length + ' baris — cocok ' + ((c.cocok || 0) + (c.manual || 0)) +
      ', beda tanggal ' + (c.beda_tanggal || 0) + ', beda jumlah ' + (c.beda_jumlah || 0) + ', tidak tercatat di aplikasi ' + (c.tidak_tercatat || 0) +
      ', diabaikan ' + (c.diabaikan || 0) + ', tercatat tapi tidak ada di rekening ' + rep.missing.length;
  }
  const bankLinesOf = (db, accId, period) => (db.bank_lines || []).filter(x => strv(x.account_id) === strv(accId) && strv(x.period) === period).sort((a, b) => num(a.seq) - num(b.seq));
  /** Shop-made packs (v12): bulk → small packs, with the server's yield / loss / unit cost formulas. */
  function repackCalc(from, to, toQty, fromQty, packCost) {
    const size = num(to.repack_qty);
    const expected = Math.round(fromQty / size * 1000) / 1000;
    return { size, expected, yield_pct: expected > 0 ? Math.round(toQty / expected * 1000) / 10 : 0, loss_qty: Math.round((fromQty - toQty * size) * 1000) / 1000,
      unit_cost: Math.round((fromQty * int(from.cost_price) + packCost) / toQty) };
  }

  /* ---- v38 (owner 2026-10-12: «المالك يصله إشعار فقط، والمدير والمحاسب يوافق على الكمية والعملية كلها، والكاشير هو الذي يطلب القيام بها، لكن
     يجب التأكد: ممكن 2 كاشير يقوم بنفس الطلب والتعليب، انتبه منها»): mirror of the server's repack request (request_repack → approval kind
     'repack' for the manager OR the accountant → decide_approval moves the stock; cancel_repack after 24 h), the one-pending-request-per-bulk
     lock, the client-id resend and the owner's notices (activity kind 'notifikasi', target roles in ref). Keep identical to backend/process.js. ---- */
  const REPACK_STALE_MS = 24 * 3600000, REPACK_RECENT_MS = 2 * 3600000;
  const RPX = { E: (c, m, x) => E(c, m, x), nextId: (db, k) => nextId(db, k), logAct: (...a) => logAct(...a), notify: (...a) => notifyR(...a), safeName: (v, m) => safeName(v, m), pending: (db, id) => { const p = pendingRepackFor(db, id); return p ? repackBusy(p) : null; } };
  function notifyR(db, u, roles, summary, level) {
    db.activity = db.activity || [];
    db.activity.push({ id: nextId(db, 'activity'), act_id: 'AC' + randId(8), at: new Date().toISOString(), act_date: jktDate(), user: u.name, role: roleOf(u), kind: 'notifikasi',
      summary: strv(summary).slice(0, 1000), ref: roles.join(',').slice(0, 60), amount: 0, level: level || 'info' });
  }
  function repackPlan(db, toId, toQtyIn, fromQtyIn) {
    const to = db.products.find(p => p.id === Number(toId));
    if (!to) throw E('NOT_FOUND', 'Produk kemasan tidak ditemukan');
    const from = num(to.repack_from) > 0 ? db.products.find(p => p.id === Number(to.repack_from)) : null;
    if (!from || !(num(to.repack_qty) > 0)) throw E('INVALID', 'Produk ini belum diatur sebagai kemasan ulang (asal curah + isi per kemasan)');
    const toQty = roundQty(toQtyIn);
    if (!(toQty > 0)) throw E('INVALID', 'Jumlah kemasan jadi tidak valid');
    const size = num(to.repack_qty);
    const fromQty = fromQtyIn === undefined || fromQtyIn === null || fromQtyIn === '' ? roundQty(toQty * size) : roundQty(fromQtyIn);
    if (!(fromQty > 0)) throw E('INVALID', 'Jumlah curah yang dipakai tidak valid');
    const expected = Math.round(fromQty / size * 1000) / 1000;
    return { to, from, toQty, fromQty, size, expected, yield_pct: expected > 0 ? Math.round(toQty / expected * 1000) / 10 : 0, loss_qty: roundQty(fromQty - toQty * size) };
  }
  const repackText = pl => strv(pl.from_name) + ' ' + fmtN(pl.from_qty) + ' ' + strv(pl.from_unit) + ' → ' + strv(pl.to_name) + ' x' + fmtN(pl.to_qty) + ' (hasil ' + pl.yield_pct + '%, susut ' + fmtN(pl.loss_qty) + ' ' + strv(pl.from_unit) + ')';
  function applyRepack(db, u, P, o) {
    const { from, to, toQty, fromQty } = P;
    const matCost = Math.round(repackCostPer(db, to) * toQty); // v48: the pack's materials × packs made
    const packCost = Math.max(0, int(o.packaging_cost)) + matCost;
    const unitCost = Math.round((fromQty * int(from.cost_price) + packCost) / toQty);
    const date = isYmd(o.date) ? o.date : jktDate();
    const oldTo = Math.max(0, num(to.stock));
    from.stock = roundQty(num(from.stock) - fromQty);
    const toCost = oldTo + toQty > 0 ? Math.round((oldTo * int(to.cost_price) + toQty * unitCost) / (oldTo + toQty)) : unitCost;
    to.stock = roundQty(num(to.stock) + toQty); to.cost_price = toCost;
    const user = strv(o.user) || u.name;
    const rp = { repack_id: 'RP' + randId(6), repack_date: date, repack_time: new Date().toISOString(), user, from_product_id: from.id, from_name: from.name, from_unit: from.unit, from_qty: fromQty,
      to_product_id: to.id, to_name: to.name, to_unit: to.unit, to_qty: toQty, pack_size: P.size, expected_qty: P.expected, yield_pct: P.yield_pct, loss_qty: P.loss_qty, packaging_cost: packCost, unit_cost: unitCost, materials_cost: matCost,
      exp_date: isYmd(o.exp_date) ? o.exp_date : '', note: strv(o.note).slice(0, 300), requested_by: strv(o.requested_by), approved_by: strv(o.approved_by), request_id: strv(o.request_id), client_id: strv(o.client_id) };
    db.repacks.push(Object.assign({ id: nextId(db, 'repack') }, rp));
    const tag = rp.repack_id + (rp.requested_by ? ', diminta ' + rp.requested_by + ', disetujui ' + rp.approved_by : '');
    db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: date, supplier: REPACK_SUP, product_id: from.id, name: from.name, qty: -fromQty, cost_price: int(from.cost_price), total: 0, note: ('→ ' + to.name + ' x' + toQty + ' (' + tag + ') ' + rp.note).trim(), user, photo_id: '', exp_date: '' });
    db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: date, supplier: REPACK_SUP, product_id: to.id, name: to.name, qty: toQty, cost_price: unitCost, total: 0, note: ('dari ' + from.name + ' ' + fromQty + ' ' + from.unit + ' (' + tag + ') ' + rp.note).trim(), user, photo_id: '', exp_date: rp.exp_date });
    logAct(db, u, 'kemas_ulang', 'Kemas ulang ' + repackText(rp) + (rp.requested_by ? ' — diminta ' + rp.requested_by + ', disetujui ' + rp.approved_by : ''), rp.repack_id, 0, o.level || (rp.yield_pct < 95 ? 'warn' : 'info'));
    const out = Object.assign({}, rp);
    if (u.role !== 'owner') { delete out.unit_cost; delete out.packaging_cost; delete out.materials_cost; }
    return { rp, out, stock: [{ product_id: from.id, stock: from.stock }, Object.assign({ product_id: to.id, stock: to.stock }, u.role === 'owner' ? { cost_price: toCost } : {})] };
  }
  const pendingRepackFor = (db, fromId) => db.approvals.find(a => a.kind === 'repack' && a.status === 'pending' && strv(a.ref) === String(fromId)) || null;
  function repackBusy(p) {
    let pl = {}; try { pl = JSON.parse(p.payload || '{}') || {}; } catch (e) { pl = {}; }
    const stale = !(Date.now() - Date.parse(p.created_at) < REPACK_STALE_MS);
    return E('REPACK_PENDING', 'Sudah ada permintaan kemas ulang ' + strv(pl.from_name) + ' oleh ' + strv(p.cashier) + ' (' + wibStamp(p.created_at) + ', ' + strv(p.request_id) + ': ' + strv(pl.to_name) + ' x' + fmtN(pl.to_qty) + ') yang menunggu persetujuan manajer/akuntan. Tunggu keputusannya atau hubungi manajer/akuntan.' +
      (stale ? ' Permintaan itu sudah lebih dari 24 jam: peminta atau manajer/akuntan bisa membatalkannya.' : ''),
      { pending: { request_id: strv(p.request_id), cashier: strv(p.cashier), created_at: strv(p.created_at), from_name: strv(pl.from_name), to_name: strv(pl.to_name), to_qty: num(pl.to_qty), stale } });
  }
  /** The repack actions (direct repack, request, cancel) — the decision is in decide_approval (repackDecide). */
  function repackAction(db, u, action, data, canDecide) {
    // v39 (owner 2026-10-12: «طلب التعليب لا يحتاج إلى موافقات … بس يقوم بإرسال معلومات للمدير ولي أنا وللمحاسب»): the cashier repacks
    // directly (request_repack from an old app is the same); the owner, manager and accountant are told. No double repack: the form's
    // client id records a resend once; the same bulk repacked in the last 2 h asks "another one?" first (confirm_recent).
    if (action === 'repack' || action === 'request_repack') {
      if (['owner', 'manager', 'kasir'].indexOf(u.role) < 0) throw E('FORBIDDEN', 'Tidak diizinkan');
      const cid = strv(data.client_id).slice(0, 60);
      db.repacks = db.repacks || [];
      if (cid) {
        const same = db.repacks.find(r => strv(r.client_id) === cid);
        if (same) { const o = Object.assign({}, same); if (u.role !== 'owner') { delete o.unit_cost; delete o.packaging_cost; delete o.materials_cost; } return { duplicate: true, repack: o }; }
      }
      const P = repackPlan(db, data.to_product_id, data.to_qty, data.from_qty);
      if (P.fromQty > num(P.from.stock) + 1e-9) throw E('INVALID', 'Stok ' + P.from.name + ' tidak cukup (' + num(P.from.stock) + ' ' + P.from.unit + ')');
      const pend = pendingRepackFor(db, P.from.id);
      if (pend) throw repackBusy(pend);
      if (data.confirm_recent !== true) {
        const last = db.repacks.filter(r => Number(r.from_product_id) === Number(P.from.id) && Date.now() - Date.parse(r.repack_time) < REPACK_RECENT_MS).pop();
        if (last) throw E('REPACK_RECENT', strv(last.user) + ' sudah mengemas ulang ' + strv(last.from_name) + ' ' + fmtN(last.from_qty) + ' ' + strv(last.from_unit) + ' → ' + strv(last.to_name) + ' x' + fmtN(last.to_qty) + ' pada ' + wibStamp(last.repack_time) + ' (' + strv(last.repack_id) + '). Kalau ini kemas ulang lain (bukan yang sama), tekan "Ya, ini kemas ulang baru".',
          { recent: { repack_id: strv(last.repack_id), user: strv(last.user), at: strv(last.repack_time), from_name: strv(last.from_name), from_qty: num(last.from_qty), from_unit: strv(last.from_unit), to_name: strv(last.to_name), to_qty: num(last.to_qty) } });
      }
      const fromOld = num(P.from.stock), toOld = num(P.to.stock);
      const R = applyRepack(db, u, P, { packaging_cost: data.packaging_cost, date: data.date, exp_date: data.exp_date, note: data.note, client_id: cid });
      const who = { owner: 'pemilik', manager: 'manajer', kasir: 'kasir' }[u.role] || u.role;
      notifyR(db, u, ['owner', 'manager', 'akuntan'].filter(r => r !== u.role), 'Kemas ulang oleh ' + who + ' ' + u.name + ' (' + wibStamp(R.rp.repack_time) + '): ' + repackText(R.rp) +
        ' | stok ' + P.from.name + ' ' + fmtN(fromOld) + ' → ' + fmtN(R.stock[0].stock) + ' ' + P.from.unit + ', stok ' + P.to.name + ' ' + fmtN(toOld) + ' → ' + fmtN(R.stock[1].stock) + ' ' + P.to.unit +
        (R.rp.yield_pct < 95 ? ' — PERHATIAN: hasil di bawah 95%' : '') + (data.confirm_recent === true ? ' — dikonfirmasi bukan kemas ulang ganda' : ''), R.rp.yield_pct < 95 ? 'warn' : 'info');
      return { repack: R.out, stock: R.stock };
    }
    if (action === 'cancel_repack') {
      const a = db.approvals.find(x => x.request_id === String(data.request_id || ''));
      if (!a || a.kind !== 'repack') throw E('NOT_FOUND', 'Permintaan kemas ulang tidak ditemukan');
      if (a.status !== 'pending') throw E('INVALID', 'Permintaan sudah diputuskan' + (strv(a.decided_by) ? ' oleh ' + strv(a.decided_by) : '') + ': ' + a.status);
      const mine = strv(a.cashier).toLowerCase() === u.name.toLowerCase();
      if (!mine && !canDecide(a)) throw E('FORBIDDEN', 'Hanya peminta atau manajer/akuntan yang bisa membatalkan');
      if (Date.now() - Date.parse(a.created_at) < REPACK_STALE_MS) throw E('TOO_EARLY', 'Bisa dibatalkan setelah 24 jam (mulai ' + wibStamp(new Date(Date.parse(a.created_at) + REPACK_STALE_MS).toISOString()) + '). Sebelum itu manajer/akuntan memutuskannya.');
      Object.assign(a, { status: 'cancelled', decided_by: u.name, decided_at: new Date().toISOString(), note: (strv(data.note) || 'dibatalkan setelah 24 jam menunggu').slice(0, 300) });
      notifyR(db, u, ['owner', 'manager', 'akuntan'], 'Permintaan kemas ulang ' + strv(a.request_id) + ' (diminta ' + strv(a.cashier) + ' ' + wibStamp(a.created_at) + ') DIBATALKAN oleh ' + u.name + ': ' + strv(a.summary).replace(/^Minta kemas ulang /, '').slice(0, 300), 'info');
      return { approval: a };
    }
    return null;
  }
  /** decide_approval for kind 'repack': approve (optionally corrected quantities, bulk stock checked NOW) or reject. */
  function repackDecide(db, u, ap, data, out) {
    let pl = {}; try { pl = JSON.parse(ap.payload || '{}') || {}; } catch (e) { pl = {}; }
    const told = u.role === 'owner' ? ['manager', 'akuntan'] : ['owner', u.role === 'akuntan' ? 'manager' : 'akuntan'];
    const when = ' (diminta ' + strv(ap.cashier) + ' ' + wibStamp(ap.created_at) + ')';
    if (data.decision === 'approved') {
      const given = v => !(v === undefined || v === null || v === '');
      const P = repackPlan(db, pl.to_product_id, given(data.to_qty) ? data.to_qty : pl.to_qty, given(data.from_qty) ? data.from_qty : pl.from_qty);
      if (String(P.from.id) !== strv(pl.from_product_id)) throw E('INVALID', 'Produk kemasan sudah diatur ulang sejak permintaan — tolak dan minta ulang');
      if (P.fromQty > num(P.from.stock) + 1e-9) throw E('REPACK_STOCK', 'Stok ' + P.from.name + ' sekarang ' + fmtN(P.from.stock) + ' ' + P.from.unit + ', permintaan butuh ' + fmtN(P.fromQty) + ' ' + P.from.unit + ' (sudah terpakai kemas ulang lain atau terjual). Koreksi jumlahnya atau tolak.');
      const corrected = P.toQty !== num(pl.to_qty) || P.fromQty !== num(pl.from_qty);
      const R = applyRepack(db, u, P, { packaging_cost: pl.packaging_cost, exp_date: pl.exp_date, note: pl.note, user: strv(ap.cashier), requested_by: strv(ap.cashier), approved_by: u.name, request_id: ap.request_id, level: 'info' });
      pl.final = { to_qty: P.toQty, from_qty: P.fromQty, expected_qty: P.expected, yield_pct: P.yield_pct, loss_qty: P.loss_qty, repack_id: R.rp.repack_id, corrected };
      ap.payload = JSON.stringify(pl);
      out.stock = R.stock; out.repack = R.out;
      notifyR(db, u, told, 'Kemas ulang DISETUJUI oleh ' + u.name + when + ': ' + repackText(R.rp) + (corrected ? ' — dikoreksi dari ' + fmtN(pl.from_qty) + ' ' + strv(pl.from_unit) + ' → x' + fmtN(pl.to_qty) : '') +
        (R.rp.yield_pct < 95 ? ' — PERHATIAN: hasil di bawah 95%' : ''), R.rp.yield_pct < 95 ? 'warn' : 'info');
    } else notifyR(db, u, told, 'Kemas ulang DITOLAK oleh ' + u.name + when + ': ' + repackText(pl) + (strv(data.note) ? ' | ' + strv(data.note) : '') + ' — stok tidak berubah', 'info');
  }

  /* ---- one-time upgrade of the demo data (also for a kmock.db made by an older app version) ---- */
  const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code4 = n => { let s = ''; for (let i = 0; i < 4; i++) { s = B32[n % 32] + s; n = Math.floor(n / 32); } return s; };
  const BANKS = ['BCA', 'BRI', 'Mandiri', 'BSI'];
  function ensureV12(db) {
    let ch = false;
    ['devices', 'activity', 'repacks', 'bank_lines'].forEach(k => { if (!Array.isArray(db[k])) { db[k] = []; ch = true; } });
    if (db.v12 || !db.users || !db.users.length) return ch;
    db.v12 = 1;
    const st = db.settings = db.settings || {};
    if (st.require_device_location === undefined) st.require_device_location = false;
    if (!Array.isArray(st.bank_accounts)) st.bank_accounts = [];
    db.products.forEach(p => { if (p.supplier === undefined) p.supplier = ''; if (p.repack_from === undefined) p.repack_from = 0; if (p.repack_qty === undefined) p.repack_qty = 0; });
    let seqNo = 0;
    const groups = new Map();
    db.purchases.filter(r => !r.purchase_no && !internalSup(r.supplier)).forEach(r => { const k = `${r.purchase_date}|${r.supplier}|${r.photo_id || ''}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    [...groups.values()].sort((a, b) => String(a[0].purchase_date).localeCompare(b[0].purchase_date)).forEach(rows => {
      const no = 'PB' + String(rows[0].purchase_date).replace(/-/g, '').slice(2) + '-' + code4(++seqNo * 7 + 1000);
      rows.forEach(r => Object.assign(r, { purchase_no: no, match_status: r.photo_id ? 'cocok' : 'tanpa_foto', match_notes: '' }));
    });
    db.seq.pbn = seqNo;
    // customer payments → v13 rows, allocated oldest invoice first
    const old = db.payments.filter(p => !p.pay_id);
    old.forEach(p => Object.assign(p, { pay_id: 'PY' + String(p.id).padStart(7, '0'), pay_time: `${p.pay_date}T10:00:00.000Z`, direction: 'in', party_type: 'customer', supplier: '', account_id: '', slip_date: '',
      bank: p.method === 'transfer' ? BANKS[p.id % BANKS.length] : '', transfer_ref: p.method === 'transfer' ? String(4100000000 + (p.id * 7919) % 89999999) : '', proof_photo_id: '', alloc: '[]', match_status: 'belum_dialokasi' }));
    const custIds = [...new Set(old.map(p => p.customer_id))];
    custIds.forEach(cid => {
      const inv = db.sales.filter(s => s.customer_id === cid && s.status !== 'void' && int(s.debt_amount) > 0).sort((a, b) => String(a.sale_time).localeCompare(b.sale_time)).map(s => ({ ref: s.invoice_no, date: s.sale_date, left: int(s.debt_amount) }));
      old.filter(p => p.customer_id === cid).sort((a, b) => String(a.pay_date).localeCompare(b.pay_date) || a.id - b.id).forEach(p => {
        let rest = int(p.amount); const alloc = [];
        for (const d of inv) { if (rest <= 0) break; if (d.left <= 0 || d.date > p.pay_date) continue; const take = Math.min(rest, d.left); d.left -= take; rest -= take; alloc.push({ ref: d.ref, amount: take }); }
        p.alloc = JSON.stringify(alloc);
        p.match_status = !alloc.length ? 'belum_dialokasi' : alloc.some(a => (inv.find(d => d.ref === a.ref) || {}).left > 0) ? 'sebagian' : rest > 0 ? 'lebih' : 'lunas';
      });
    });
    const demo = db.products.length >= 20 && db.users.some(x => x.name === 'Siti') && db.products.some(p => /Kacang Mete Arab/.test(p.name));
    if (demo) seedV12Demo(db);
    else if (st.store_lat === undefined) { st.store_lat = 0; st.store_lng = 0; }
    return true;
  }
  function seedV12Demo(db) {
    const T = jktDate(), D = n => addDays(T, -n), NOW = Date.now(), pad = n => String(n).padStart(2, '0');
    const at = (ymd, hh, mm) => { const t0 = Date.parse(`${ymd}T${pad(hh)}:${pad(mm)}:00+07:00`); return new Date(Math.min(t0, NOW - 60000)).toISOString(); };
    const ago = min => new Date(NOW - min * 60000).toISOString();
    const st = db.settings;
    const STORE = { lat: -6.27630, lng: 106.85770 };
    Object.assign(st, { store_lat: STORE.lat, store_lng: STORE.lng });
    st.bank_accounts = [{ id: 'BA1', bank: 'BCA', account_no: '1234567890', holder: 'Khair Mart', active: true }, { id: 'BA2', bank: 'Mandiri', account_no: '1560009876543', holder: 'Khair Mart', active: false }];
    const P = re => db.products.find(p => re.test(p.name));
    const nextPb = date => 'PB' + date.replace(/-/g, '').slice(2) + '-' + code4((db.seq.pbn = (db.seq.pbn || 0) + 1) * 7 + 1000);
    // main supplier per product = the supplier it was bought from most often
    db.products.forEach(p => {
      const cnt = {}; db.purchases.filter(r => r.product_id === p.id && !internalSup(r.supplier) && r.supplier).forEach(r => { cnt[r.supplier] = (cnt[r.supplier] || 0) + 1; });
      const best = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]; p.supplier = best ? best[0] : '';
    });
    // bulk products repacked in the shop
    const addProd = f => { const p = Object.assign({ id: nextId(db, 'product'), sku: '', category: '', unit: 'pcs', cost_price: 0, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0, stock: 0, min_stock: 0, active: true, notes: '', supplier: '', size: '', weight: '', exp_date: '', exp_none: false, repack_from: 0, repack_qty: 0 }, f); db.products.push(p); return p; };
    const rabia = addProd({ sku: '8991099000011', name: 'Kurma Rabia Curah (karton 10 kg)', category: 'Kurma', unit: 'kg', cost_price: 48000, retail_price: 62000, wholesale_price: 56000, wholesale_min_qty: 10, stock: 34, min_stock: 10, notes: 'Datang per karton 10 kg, dikemas ulang di toko', supplier: 'PT Kurma Nusantara' });
    const r500 = addProd({ sku: '8991099000028', name: 'Kurma Rabia Kemas 500 g', category: 'Kurma', unit: 'pak', cost_price: 25600, retail_price: 35000, wholesale_price: 31000, wholesale_min_qty: 10, stock: 18, min_stock: 10, repack_from: rabia.id, repack_qty: 0.5 });
    const r250 = addProd({ sku: '8991099000035', name: 'Kurma Rabia Kemas 250 g', category: 'Kurma', unit: 'pak', cost_price: 13100, retail_price: 19000, wholesale_price: 17000, wholesale_min_qty: 12, stock: 9, min_stock: 12, repack_from: rabia.id, repack_qty: 0.25 });
    const mete = addProd({ sku: '8991099000042', name: 'Kacang Mete Curah (karung 5 kg)', category: 'Kacang', unit: 'kg', cost_price: 140000, retail_price: 175000, wholesale_price: 160000, wholesale_min_qty: 5, stock: 7.5, min_stock: 5, notes: 'Karung 5 kg, dikemas 250 g di toko', supplier: 'Grosir Kramat Jati' });
    const mete250 = P(/Kacang Mete Arab/);
    Object.assign(mete250, { repack_from: mete.id, repack_qty: 0.25, supplier: '' });
    const pur = (d, sup, p, qty, cost, exp, extra) => { const r = Object.assign({ id: nextId(db, 'purchase'), purchase_date: D(d), supplier: sup, product_id: p.id, name: p.name, qty, cost_price: cost, total: Math.round(qty * cost), note: '', user: 'Pemilik', photo_id: '', exp_date: exp == null ? '' : addDays(T, exp), purchase_no: '', match_status: 'tanpa_foto', match_notes: '' }, extra || {}); db.purchases.push(r); return r; };
    pur(26, 'PT Kurma Nusantara', rabia, 60, 48000, 240).purchase_no = nextPb(D(26));
    pur(6, 'PT Kurma Nusantara', rabia, 40, 48000, 270).purchase_no = nextPb(D(6));
    pur(12, 'Grosir Kramat Jati', mete, 10, 140000, 200).purchase_no = nextPb(D(12));
    // repacks of the last month (one low yield)
    const REP = [[25, rabia, r500, 20, 10, 12000, ''], [20, rabia, r250, 19, 5, 9500, ''], [14, rabia, r500, 19, 10, 11400, ''], [9, mete, mete250, 9, 2.5, 5400, 'Banyak mete pecah'],
      [5, rabia, r250, 20, 5, 10000, ''], [2, rabia, r500, 11, 6, 6600, 'Sebagian kurma penyok, disisihkan'], [1, mete, mete250, 5, 1.25, 3000, '']];
    REP.forEach(([d, from, to, toQty, fromQty, packCost, note], i) => {
      const c = repackCalc(from, to, toQty, fromQty, packCost), date = D(d);
      const rp = { id: nextId(db, 'repack'), repack_id: 'RP' + code4(500 + i * 37) + 'K' + i, repack_date: date, repack_time: at(date, 15, 10 + i), user: i % 3 === 1 ? 'Jihan' : 'Pemilik',
        from_product_id: from.id, from_name: from.name, from_unit: from.unit, from_qty: fromQty, to_product_id: to.id, to_name: to.name, to_unit: to.unit, to_qty: toQty, pack_size: c.size,
        expected_qty: c.expected, yield_pct: c.yield_pct, loss_qty: c.loss_qty, packaging_cost: packCost, unit_cost: c.unit_cost, exp_date: addDays(date, 180), note };
      db.repacks.push(rp);
      db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: date, supplier: REPACK_SUP, product_id: from.id, name: from.name, qty: -fromQty, cost_price: from.cost_price, total: 0, note: ('→ ' + to.name + ' x' + toQty + ' (' + rp.repack_id + ') ' + note).trim(), user: rp.user, photo_id: '', exp_date: '' });
      db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: date, supplier: REPACK_SUP, product_id: to.id, name: to.name, qty: toQty, cost_price: c.unit_cost, total: 0, note: ('dari ' + from.name + ' ' + fromQty + ' ' + from.unit + ' (' + rp.repack_id + ') ' + note).trim(), user: rp.user, photo_id: '', exp_date: rp.exp_date });
    });
    // goods-in notes: one saved with a reason (different from the note), one corrected afterwards
    const notes = new Map();
    db.purchases.filter(r => r.purchase_no && !internalSup(r.supplier)).forEach(r => { if (!notes.has(r.purchase_no)) notes.set(r.purchase_no, []); notes.get(r.purchase_no).push(r); });
    const noteList = [...notes.entries()].map(([no, rows]) => ({ no, rows, date: rows[0].purchase_date, sup: rows[0].supplier, total: sum(rows, r => int(r.total)) })).sort((a, b) => a.date.localeCompare(b.date));
    const withPhoto = noteList.filter(n => n.rows[0].photo_id && n.date >= D(15));
    const nb = withPhoto[withPhoto.length - 1];
    if (nb) { const r = nb.rows[0]; nb.rows.forEach(x => { x.match_status = 'tidak_cocok'; x.match_notes = `${r.name}: input ${fmtN(r.qty)} / nota ${fmtN(r.qty - 2)} | alasan: 2 dus bonus dari sales`; }); }
    const nf = withPhoto[withPhoto.length - 2];
    if (nf) {
      const r = nf.rows[0];
      db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: addDays(nf.date, 1) > T ? T : addDays(nf.date, 1), supplier: r.supplier, product_id: r.product_id, name: r.name, qty: -2, cost_price: r.cost_price, total: -2 * int(r.cost_price),
        note: `KOREKSI ${nf.no}: ${fmtN(r.qty)}→${fmtN(r.qty - 2)} | 2 dus rusak dikembalikan ke pemasok`, user: 'Jihan', photo_id: '', exp_date: '', purchase_no: nf.no, match_status: 'koreksi', match_notes: '2 dus rusak dikembalikan ke pemasok' });
      nf.total -= 2 * int(r.cost_price);
    }
    // supplier payments: older notes paid per month by transfer; a partial and an unallocated payment recently
    const supBank = { 'PT Kurma Nusantara': 'BCA', 'CV Timur Tengah Food': 'Mandiri', 'Agen Sembako Pasar Induk': 'BRI', 'Grosir Kramat Jati': 'BCA' };
    let refN = 5200001;
    const addPay = f => { const p = Object.assign({ id: nextId(db, 'payment'), pay_id: 'PY' + String(db.seq.payment).padStart(7, '0'), pay_time: '', direction: 'out', party_type: 'supplier', customer_id: 0, customer_name: '', supplier: '', amount: 0, method: 'transfer', account_id: '', slip_date: '',
      bank: '', transfer_ref: '', proof_photo_id: '', alloc: '[]', match_status: 'belum_dialokasi', note: '', cashier: 'Pemilik', shift_id: '' }, f); if (!p.pay_time) p.pay_time = at(p.pay_date, 11, 0); if ((p.method === 'transfer' || p.method === 'qris') && !p.account_id) p.account_id = 'BA1'; db.payments.push(p); return p; };
    const bySup = new Map();
    noteList.filter(n => n.total > 0).forEach(n => { if (!bySup.has(n.sup)) bySup.set(n.sup, []); bySup.get(n.sup).push(n); });
    bySup.forEach((list, sup) => {
      const months = new Map();
      list.filter(n => n.date <= D(21)).forEach(n => { const m = n.date.slice(0, 7); if (!months.has(m)) months.set(m, []); months.get(m).push(n); });
      months.forEach((ns, m) => {
        const last = ns[ns.length - 1].date, pd = addDays(last, 10) > D(12) ? D(12) : addDays(last, 10);
        addPay({ pay_date: pd, supplier: sup, account_id: 'BA2', amount: sum(ns, n => n.total), bank: supBank[sup] || 'BCA', transfer_ref: String(refN++), alloc: JSON.stringify(ns.map(n => ({ ref: n.no, amount: n.total }))), match_status: 'lunas', note: 'Pelunasan nota ' + m });
      });
    });
    const recent = sup => (bySup.get(sup) || []).filter(n => n.date > D(21));
    const kn = recent('PT Kurma Nusantara').slice(-1)[0];
    if (kn) addPay({ pay_date: kn.date < D(3) ? D(3) : kn.date, supplier: 'PT Kurma Nusantara', amount: Math.round(kn.total * 0.4 / 1000) * 1000, method: 'tunai', alloc: JSON.stringify([{ ref: kn.no, amount: Math.round(kn.total * 0.4 / 1000) * 1000 }]), match_status: 'sebagian', note: 'DP 40%, sisa minggu depan' });
    if (bySup.has('Agen Sembako Pasar Induk')) addPay({ pay_date: D(2), supplier: 'Agen Sembako Pasar Induk', amount: 1000000, bank: 'BRI', transfer_ref: String(refN++), match_status: 'belum_dialokasi', note: 'Titip bayar, nota menyusul' });
    // customer payments: the newest one of Toko Al-Barokah not allocated yet; transfer slips for recent transfers
    const c3 = db.customers.find(c => /Al-Barokah/.test(c.name));
    const p3 = c3 && db.payments.filter(p => p.customer_id === c3.id && payDir(p) === 'in').sort((a, b) => String(b.pay_date).localeCompare(a.pay_date))[0];
    if (p3) { p3.alloc = '[]'; p3.match_status = 'belum_dialokasi'; }
    db.payments.filter(p => payDir(p) === 'in' && p.method === 'transfer' && !p.account_id).forEach(p => { p.account_id = p.pay_date >= T.slice(0, 8) + '01' ? 'BA1' : 'BA2'; });
    // a month of bank payments on BCA for the reconciliation demo (last month), every status once
    const prev = addDays(T.slice(0, 8) + '01', -1).slice(0, 7), pd = d => `${prev}-${pad(d)}`;
    const custs = db.customers.filter(c => c.type === 'grosir');
    const slip = (pay, sd, amount) => { const ph = { photo_id: 'PH-' + String(nextId(db, 'photo')).padStart(5, '0'), kind: 'bayar', ref: pay.pay_id, created_at: at(pay.pay_date, 16, 0), photo_date: pay.pay_date, user: pay.cashier, drive_url: '', extracted: { date: sd, amount, sender_name: pay.direction === 'in' ? String(pay.customer_name).toUpperCase() : 'KHAIR MART', receiver_name: pay.direction === 'in' ? 'KHAIR MART' : String(pay.supplier).toUpperCase(), bank: pay.bank, transfer_ref: pay.transfer_ref, readable: true, notes: '' }, match_status: '', match_notes: '' }; db.photos.push(ph); pay.proof_photo_id = ph.photo_id; pay.slip_date = sd; };
    const inPay = (d, c, amount, ref, sd, extra) => { c.debt_balance = Math.max(0, int(c.debt_balance) - amount); const p = addPay(Object.assign({ pay_date: pd(d), direction: 'in', party_type: 'customer', customer_id: c.id, customer_name: c.name, supplier: '', amount, bank: 'BCA', transfer_ref: ref, note: 'Transfer cicilan', cashier: 'Jihan' }, extra || {})); slip(p, sd || p.pay_date, amount); return p; };
    const outPay = (d, sup, amount, ref, sd, extra) => { const p = addPay(Object.assign({ pay_date: pd(d), supplier: sup, amount, bank: 'BCA', transfer_ref: ref, note: 'Bayar nota', cashier: 'Jihan' }, extra || {})); slip(p, sd || p.pay_date, amount); return p; };
    const RC = [
      inPay(3, custs[0], 1500000, '7710023001'), inPay(8, custs[1], 850000, '7710023002', pd(8)), outPay(10, 'CV Timur Tengah Food', 3200000, '7710023003'),
      inPay(14, custs[2], 600000, '7710023004', pd(12)), // recorded 2 days after the slip / statement → beda tanggal
      outPay(17, 'Grosir Kramat Jati', 1250000, '7710023005'), // statement shows 1.200.000 → beda jumlah
      inPay(21, custs[0], 975000, '7710023006'), // not on the statement → tercatat, tidak ada di rekening
      outPay(24, 'PT Kurma Nusantara', 2400000, '7710023007', pd(24), { method: 'qris', bank: 'QRIS' }),
      inPay(27, custs[1], 450000, '7710023008'),
      inPay(20, custs[2], 500000, '', pd(20)) // matched by hand with the line of the 26th (6 days apart)
    ];
    const BL = [[3, 'TRSF E-BANKING CR 7710023001 ' + custs[0].name.toUpperCase(), 1500000, '7710023001'], [5, 'BIAYA ADM BULANAN', -10000, ''],
      [8, 'TRSF E-BANKING CR ' + custs[1].name.toUpperCase(), 850000, ''], [10, 'TRSF E-BANKING DB 7710023003 CV TIMUR TENGAH', -3200000, '7710023003'],
      [12, 'TRSF E-BANKING CR ' + custs[2].name.toUpperCase(), 600000, ''], [17, 'TRSF E-BANKING DB 7710023005 GROSIR KJ', -1200000, '7710023005'],
      [19, 'SETORAN TUNAI CABANG CONDET', 2000000, ''], [24, 'QRIS DB PT KURMA NUSANTARA', -2400000, ''], [26, 'TRSF E-BANKING CR CICILAN GABUNGAN', 500000, ''], [27, 'TRSF E-BANKING CR 7710023008', 450000, '7710023008'], [28, 'BUNGA JASA GIRO', 3250, '']];
    let bal = 18500000;
    BL.forEach(([d, desc, amount, ref], i) => { bal += amount; db.bank_lines.push({ id: nextId(db, 'bank_line'), line_id: `BA1-${prev}-${i + 1}`, account_id: 'BA1', period: prev, seq: i + 1, line_date: pd(d), description: desc, amount, ref, balance: bal, status: '', pay_id: '', note: '', imported_at: at(T.slice(0, 8) + '01', 9, 30), imported_by: 'Jihan' }); });
    const man = db.bank_lines.find(l => l.account_id === 'BA1' && l.line_date === pd(26)); if (man) { man.status = 'manual'; man.pay_id = RC[8].pay_id; man.note = 'Transfer gabungan, dicatat tanggal nota'; }
    const rep0 = reconcile(db, bankLinesOf(db, 'BA1', prev), 'BA1', prev);
    rep0.lines.forEach(x => { const l = db.bank_lines.find(y => y.line_id === x.line_id); if (l) { l.status = x.status; l.pay_id = x.pay_id || ''; } });
    const fee = db.bank_lines.find(l => l.line_id === `BA1-${prev}-2`); if (fee) { fee.status = 'diabaikan'; fee.note = 'Biaya admin bank'; }
    // devices (v11) around Condet / Kramat Jati
    const off = (dn, de) => ({ lat: Math.round((STORE.lat + dn / 111320) * 1e6) / 1e6, lng: Math.round((STORE.lng + de / (111320 * Math.cos(STORE.lat * Math.PI / 180))) * 1e6) / 1e6 });
    const UA = { android: 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36', samsung: 'Mozilla/5.0 (Linux; Android 12; SM-A325F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', ipad: 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0' };
    const dev = (id, user, role, app, label, ua, ip, pos, acc, status, lastMin, firstDays, battery, pings) => { const ls = ago(lastMin); db.devices.push({ id: nextId(db, 'device'), device_id: id, user, role, app, label, ua, ip, lat: pos ? pos.lat : 0, lng: pos ? pos.lng : 0, acc: pos ? acc : 0, loc_status: status, loc_at: pos ? ls : '', first_seen: ago(firstDays * 1440 + lastMin + 30), last_seen: ls, pings, battery }); };
    dev('dKSR7Q2M9XA4SITI01', 'Siti', 'kasir', 'kasir', 'Android · Chrome', UA.android, '114.124.168.20', off(15, 20), 12, 'granted', 2, 40, 0.64, 412);
    dev('dKSR8R5P2YB7RINA02', 'Rina', 'kasir', 'kasir', 'Android · Samsung Internet', UA.samsung, '114.124.170.5', off(-560, 270), 18, 'granted', 4, 2, 0.31, 37);
    dev('dMGR3J7K4LC2JIHAN3', 'Jihan', 'manager', 'owner', 'iPhone · Safari', UA.iphone, '182.253.70.14', off(60, -55), 35, 'granted', 7, 25, 0.82, 268);
    dev('dMGR9T2V6MD8JIHAN4', 'Jihan', 'manager', 'owner', 'iPad · Safari', UA.ipad, '182.253.70.14', null, 0, 'denied', 190, 9, 0.57, 21);
    dev('dSLS4H8N3PE6AHMAD5', 'Ahmad', 'sales', 'sales', 'Android · Chrome', UA.android, '36.71.140.88', off(1900, 1450), 9, 'granted', 1, 14, 0.55, 530);
    dev('dOWN6W4C8QF3PEMIL6', 'Pemilik', 'owner', 'owner', 'Windows · Edge', UA.win, '103.147.8.201', off(-650, -720), 1500, 'granted', 50, 60, 0, 95);
    // activity log of the last 7 days, built from the demo data
    const A = [];
    const act = (iso, user, role, kind, summary, ref, amount, level) => A.push({ at: iso, act_date: jktDate(new Date(iso)), user, role, kind, summary, ref: strv(ref).slice(0, 60), amount: int(amount), level: level || 'info' });
    noteList.filter(n => n.date >= D(6)).forEach((n, i) => { const s0 = n.rows[0].match_status; act(at(n.date, 10, 5 + i), 'Pemilik', 'owner', 'masuk', `Barang masuk ${n.no}${n.sup ? ' dari ' + n.sup : ''}: ${n.rows.length} baris, Rp ${n.total} — nota: ${s0}${n.rows[0].match_notes ? ' (' + n.rows[0].match_notes + ')' : ''}`, n.no, n.total, s0 === 'cocok' ? 'info' : 'warn'); });
    if (nf && nf.date >= D(7)) act(at(addDays(nf.date, 1) > T ? T : addDays(nf.date, 1), 9, 40), 'Jihan', 'manager', 'koreksi_masuk', `Koreksi barang masuk ${nf.no}: ${nf.rows[0].name} ${fmtN(nf.rows[0].qty)}→${fmtN(nf.rows[0].qty - 2)} | 2 dus rusak dikembalikan ke pemasok`, nf.no, -2 * int(nf.rows[0].cost_price), 'warn');
    db.expenses.filter(x => x.expense_date >= D(6)).forEach(x => act(at(x.expense_date, 12, 30), x.user || 'Pemilik', 'owner', 'biaya', `Pengeluaran ${x.category} Rp ${x.amount}${x.note ? ': ' + x.note : ''} (${x.paid_from || 'lain'})`, '', x.amount));
    db.shifts.filter(x => x.status === 'closed' && x.shift_date >= D(6)).forEach(x => act(at(x.shift_date, 21, 10), x.cashier, 'kasir', 'tutup_kas', `Tutup kas ${x.cashier}: dihitung Rp ${x.counted_cash}, seharusnya Rp ${x.expected_cash}, selisih Rp ${x.difference}`, x.shift_id, x.difference, x.difference ? 'warn' : 'info'));
    db.sales.filter(s => s.debt_amount > 0 && s.sale_date >= D(2) && s.status !== 'void').slice(-4).forEach(s => act(s.sale_time ? new Date(Math.min(Date.parse(s.sale_time), NOW - 60000)).toISOString() : at(s.sale_date, 12, 0), s.cashier, s.cashier === 'Pemilik' ? 'owner' : 'kasir', 'hutang', `Penjualan hutang ${s.invoice_no} ${s.customer_name} Rp ${s.debt_amount} (disetujui ${s.approved_by || 'Pemilik'})`, s.invoice_no, s.debt_amount));
    db.repacks.filter(r => r.repack_date >= D(6)).forEach(r => act(r.repack_time, r.user, r.user === 'Jihan' ? 'manager' : 'owner', 'kemas_ulang', `Kemas ulang ${r.from_name} ${fmtN(r.from_qty)} ${r.from_unit} → ${r.to_name} x${fmtN(r.to_qty)} (hasil ${r.yield_pct}%, susut ${fmtN(r.loss_qty)} ${r.from_unit})`, r.repack_id, 0, r.yield_pct < 95 ? 'warn' : 'info'));
    db.payments.filter(p => p.pay_date >= D(6) && p.pay_id).forEach(p => act(p.pay_time || at(p.pay_date, 11, 0), p.cashier, p.cashier === 'Pemilik' ? 'owner' : p.cashier === 'Jihan' ? 'manager' : 'kasir', payDir(p) === 'in' ? 'bayar_masuk' : 'bayar_keluar',
      (payDir(p) === 'in' ? `Pembayaran ${p.customer_name}` : `Bayar pemasok ${p.supplier}`) + ` Rp ${p.amount} (${p.method}${p.bank ? ' ' + p.bank : ''}${p.transfer_ref ? ', ref ' + p.transfer_ref : ''})` + (payAlloc(p).length ? ' untuk ' + payAlloc(p).map(a => a.ref + ' Rp ' + a.amount).join(', ') : ' — belum dialokasi'), p.pay_id, p.amount, payAlloc(p).length ? 'info' : 'warn'));
    const med = P(/Kurma Medjool/), gula = P(/Gula Pasir/), ajwa = P(/Kurma Ajwa/);
    act(at(D(2), 9, 12), 'Pemilik', 'owner', 'harga', `Ubah harga ${med.name}: retail_price ${med.retail_price - 5000}→${med.retail_price} | harga dari pemasok naik`, med.id, 0, 'warn');
    act(at(D(1), 16, 45), 'Jihan', 'manager', 'harga', `Ubah harga ${gula.name}: wholesale_price ${gula.wholesale_price - 300}→${gula.wholesale_price} | ikut harga pasar`, gula.id, 0, 'warn');
    act(at(D(3), 13, 20), 'Siti', 'kasir', 'minta_harga', `Minta Ubah harga ${ajwa.name}: wholesale_price ${ajwa.wholesale_price}→${ajwa.wholesale_price - 5000} | pelanggan grosir tetap`, ajwa.id, 0);
    act(at(D(3), 13, 52), 'Jihan', 'manager', 'keputusan', `Ditolak (price, diminta Siti): Ubah harga ${ajwa.name}: wholesale_price ${ajwa.wholesale_price}→${ajwa.wholesale_price - 5000} | harga grosir sudah minimum`, 'APR-0000', 0, 'warn');
    const adj = db.purchases.find(r => r.supplier === ADJUST_SUPPLIER && r.purchase_date >= D(6));
    if (adj) act(at(adj.purchase_date, 17, 5), 'Pemilik', 'owner', 'stok', `Penyesuaian stok ${adj.name}: ${adj.qty} | ${adj.note}`, adj.product_id, 0, 'warn');
    act(at(D(4), 8, 30), 'Pemilik', 'owner', 'pengaturan', 'Pengaturan diubah: store_lat, store_lng, bank_accounts', '', 0);
    act(at(D(5), 19, 0), 'Pemilik', 'owner', 'pengguna', 'Pengguna diubah: Rina (kasir), PIN diganti', 'Rina', 0, 'warn');
    act(ago(2 * 1440 + 4 + 30), 'Rina', 'kasir', 'perangkat_baru', 'Perangkat baru: Android · Samsung Internet (kasir, Rina) IP 114.124.170.5', 'dKSR8R5P2YB7RINA02', 0);
    act(at(T.slice(0, 8) + '01', 9, 30), 'Jihan', 'manager', 'rekening', reconText(st.bank_accounts[0], prev, reconcile(db, bankLinesOf(db, 'BA1', prev), 'BA1', prev)), 'BA1 ' + prev, 0, 'warn');
    A.filter(a => a.act_date >= D(6) && Date.parse(a.at) <= NOW).sort((a, b) => a.at.localeCompare(b.at)).forEach(a => db.activity.push(Object.assign({ id: nextId(db, 'activity'), act_id: 'AC' + code4(db.seq.activity * 13 + 2000) + 'D' + db.seq.activity }, a)));
  }

  /** v16 demo data: some goods still in the warehouse (shelf empty), members with visits. Idempotent (db.v16). */
  function ensureV16(db) {
    if (db.v16 || !db.users || !db.users.length || !Array.isArray(db.products) || !db.products.length) return false;
    db.v16 = 1;
    const T = jktDate(), P = re => db.products.find(p => re.test(p.name));
    [[/Bumbu Kabsah/, 0], [/Za'atar/, 0], [/Rempah Nasi Mandi/, 8], [/Dallah Kuningan/, 2]].forEach(([re, sh]) => { const p = P(re); if (p) p.shop_stock = Math.min(sh, Math.max(0, num(p.stock))); });
    const ais = db.customers.find(c => /Ustadzah Aisyah/.test(c.name));
    if (ais) Object.assign(ais, { email: 'aisyah.kt@gmail.com', member: true, member_no: 'MAIS7K2', member_since: addDays(T, -120), visits: 6, last_visit: addDays(T, -4) });
    [['Ummu Khadijah', '0812-7788-9900', 'ummu.khadijah@yahoo.co.id', 'MUK4H9P', -300, 12, -2], ['Rizky Maulana', '0857-1212-3434', '', 'MRZ8M2Q', -60, 3, -9], ['Dewi Lestari', '0813-9090-1010', 'dewi.l@gmail.com', 'MDW5L3T', -200, 1, -45]]
      .forEach(([name, phone, email, no, since, visits, last]) => { if (!db.customers.some(c => c.name === name)) db.customers.push({ id: nextId(db, 'customer'), name, phone, type: 'eceran', address: 'Condet', notes: '', debt_balance: 0, wa_optin: false, source: '', email, member: true, member_no: no, member_since: addDays(T, since), visits, last_visit: addDays(T, last) }); });
    return true;
  }

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
    const u = db.users.find(x => x.active && x.name.toLowerCase() === String(user || '').toLowerCase());
    if (!u) throw E('BAD_PIN', 'Nama atau PIN salah');
    // v16: 5 wrong PINs in a row lock the account for 15 minutes; the owner's master code opens every account
    if (Date.parse(u.locked_until) > Date.now()) throw E('LOCKED', 'Terlalu banyak PIN salah. Coba lagi jam ' + wibTime(u.locked_until), { locked_until: strv(u.locked_until) });
    const viaMaster = isHash(pin_hash) && u.pin_hash !== pin_hash && db.users.some(x => x.active && x.role === 'owner' && isHash(x.master_hash) && x.master_hash === pin_hash);
    if (u.pin_hash !== pin_hash && !viaMaster) {
      const fc = int(u.fail_count) + 1, until = fc >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : '';
      u.fail_count = until ? 0 : fc; u.locked_until = until; db._saveErr = true;
      if (until) throw E('LOCKED', 'Terlalu banyak PIN salah. Coba lagi jam ' + wibTime(until), { locked_until: until });
      throw E('BAD_PIN', 'Nama atau PIN salah' + (fc >= 3 ? ' (' + (5 - fc) + ' kali lagi, lalu akun dikunci 15 menit)' : ''));
    }
    if ((int(u.fail_count) > 0 || strv(u.locked_until)) && !['change_pin', 'set_master', 'save_user'].includes(action)) { u.fail_count = 0; u.locked_until = ''; db._dirty = true; }
    if (u.must_change === true && !viaMaster && !['login', 'change_pin', 'users', 'device_ping'].includes(action)) throw E('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
    db._role = u.role;
    const owner = u.role === 'owner';
    const needOwner = () => { if (!owner) throw E('FORBIDDEN', 'Owner only'); };
    // v19 anti-tamper: a clear code attempt locks a non-owner account (only the owner opens it); the owner is warned, not locked.
    const lockedSet = () => Array.isArray(db.settings.locked_accounts) ? db.settings.locked_accounts.map(x => String(x).toLowerCase()) : [];
    const isLockedAcct = n => lockedSet().indexOf(String(n).trim().toLowerCase()) >= 0;
    const codeHit = body.__codeHit || '';
    if (codeHit && !owner) { if (!isLockedAcct(u.name)) db.settings.locked_accounts = lockedSet().concat([u.name.toLowerCase()]); logAct(db, u, 'tamper', 'Percobaan menulis kode — akun dikunci: "' + codeHit + '" (aksi ' + action + ')', u.name, 0, 'danger'); const er = E('TAMPER', 'Input tidak sah. Akun dikunci, hanya pemilik yang membuka.'); er.extra = { locked: true }; throw er; }
    if (codeHit && owner) { logAct(db, u, 'tamper', 'Input ditolak (karakter kode): "' + codeHit + '" (aksi ' + action + ')', u.name, 0, 'warn'); db._dirty = true; throw E('INVALID', 'Input tidak sah (karakter kode tidak diperbolehkan)'); }
    if (!owner && isLockedAcct(u.name) && !['login', 'users', 'device_ping', 'change_pin', 'clear_tamper', 'report_tamper'].includes(action)) { const er = E('TAMPER_LOCKED', 'Akun dikunci setelah percobaan tidak sah. Hanya pemilik yang membuka.'); er.extra = { locked: true }; throw er; }
    const prodById = id => db.products.find(p => p.id === Number(id));
    const custById = id => db.customers.find(c => c.id === Number(id));
    if (u.role === 'sales' && !['login', 'bootstrap', 'device_ping', 'change_pin', 'report_tamper'].includes(action)) throw E('FORBIDDEN', 'Akun sales memakai aplikasi Khair Sales');
    if (u.role === 'akuntan' && !['login', 'bootstrap', 'device_ping', 'change_pin', 'report_tamper', 'confirm_purchase', 'repack_finish', 'get_sales', 'get_sale', 'list_returns', 'daily_report', 'party_ledger', 'bank_recon', 'check_approval', 'list_photos', 'photo_file', 'list_corrections', 'save_product', 'list_approvals', 'decide_approval', 'list_invoice_changes', 'cancel_repack', 'save_supplier', 'set_transfer_bank', 'finance_position'].includes(action)) throw E('FORBIDDEN', 'Akun akuntan hanya untuk melihat laporan');
    if (['list_devices', 'list_activity'].includes(action) && !owner) throw E('FORBIDDEN', 'Hanya pemilik');
    if (action !== 'device_ping' && !['scan_purchase', 'scan_exit', 'scan_payment', 'scan_supplier_return', 'scan_expense', 'list_photos', 'photo_file'].includes(action)) deviceTouch(db, u, data.device, false);

    switch (action) {
      case 'att_bootstrap': case 'worker_save': case 'worker_enroll': case 'worker_forget': case 'att_mark': case 'att_report': case 'att_settings':
        if (!window.KAttMock || !window.KAtt) throw E('SERVER', 'Attendance mock not loaded');
        return window.KAttMock.handle(db, u, action, data, E);
      case 'login':
        if (viaMaster) logAct(db, u, 'masuk_master', 'Masuk ke akun ' + u.name + ' (' + roleOf(u) + ') dengan kode pemilik', u.name, 0, 'warn');
        return { user: { name: u.name, role: u.role }, must_change: u.must_change === true && !viaMaster, via_master: viaMaster, tamper_locked: u.role !== 'owner' && isLockedAcct(u.name) };
      case 'change_pin': {
        if (!isHash(data.new_pin_hash)) throw E('INVALID', 'PIN baru tidak valid');
        if (data.new_pin_hash === u.pin_hash) throw E('INVALID', 'PIN baru harus berbeda dari PIN lama');
        if (viaMaster && owner) throw E('FORBIDDEN', 'PIN pemilik hanya bisa diganti dengan PIN pemilik sendiri');
        if (db.users.some(x => x.active && isHash(x.master_hash) && x.master_hash === data.new_pin_hash)) throw E('INVALID', 'PIN baru tidak valid');
        Object.assign(u, { pin_hash: data.new_pin_hash, must_change: viaMaster, fail_count: 0, locked_until: '' });
        logAct(db, u, 'ganti_pin', viaMaster ? 'PIN ' + u.name + ' direset dengan kode pemilik (wajib ganti saat masuk)' : u.name + ' mengganti PIN sendiri', u.name, 0, viaMaster ? 'warn' : 'info');
        return { must_change: viaMaster };
      }
      case 'set_master': {
        if (!owner || viaMaster) throw E('FORBIDDEN', 'Hanya pemilik dengan PIN sendiri');
        if (!isHash(data.master_hash) || data.master_hash === u.pin_hash) throw E('INVALID', 'Kode pemilik tidak valid');
        if (db.users.some(x => x.pin_hash === data.master_hash)) throw E('INVALID', 'Kode pemilik tidak valid');
        const had = isHash(u.master_hash);
        Object.assign(u, { master_hash: data.master_hash, fail_count: 0, locked_until: '' });
        logAct(db, u, 'kode_pemilik', 'Kode pemilik ' + (had ? 'diganti' : 'dibuat'), u.name, 0, 'warn');
        return {};
      }
      case 'move_stock': {
        // warehouse → shelf (to "toko") or back (to "gudang"); the shelf only gets goods that came in with a supplier note
        const toShop = data.to !== 'gudang';
        const mlines = Array.isArray(data.lines) ? data.lines.slice(0, 200) : [];
        if (!mlines.length) throw E('INVALID', 'Pilih barang yang dipindah');
        const agg = new Map();
        for (const l of mlines) {
          const p = prodById(l && l.product_id); if (!p) throw E('NOT_FOUND', 'Produk tidak ditemukan: ' + (l && l.product_id));
          const q = roundQty(l.qty); if (!(q > 0)) throw E('INVALID', 'Jumlah tidak valid: ' + p.name);
          agg.set(p.id, roundQty((agg.get(p.id) || 0) + q));
        }
        const short = [], mv = [];
        agg.forEach((q, pid) => {
          const p = prodById(pid), sh = shopOf(p), gd = roundQty(num(p.stock) - sh);
          if (toShop && q > gd + 1e-9) short.push(p.name + ': gudang ' + fmtN(Math.max(0, gd)) + (gd <= 0 ? ' — belum ada barang masuk dengan nota' : ''));
          else if (!toShop && q > sh + 1e-9) short.push(p.name + ': rak ' + fmtN(Math.max(0, sh)));
          else mv.push({ p, q, sh: roundQty(sh + (toShop ? q : -q)) });
        });
        if (short.length) throw E(toShop ? 'NOT_IN_GUDANG' : 'NOT_ON_SHELF', (toShop ? 'Tidak bisa pindah ke toko — stok gudang kurang: ' : 'Stok rak kurang: ') + short.join('; '));
        mv.forEach(x => { db._shopSet[x.p.id] = x.sh; });
        const mnote = strv(data.note).slice(0, 200);
        logAct(db, u, 'pindah_stok', (toShop ? 'Gudang → toko: ' : 'Toko → gudang: ') + mv.map(x => x.p.name + ' ' + fmtN(x.q) + ' ' + strv(x.p.unit)).join('; ') + (mnote ? ' | ' + mnote : ''), '', 0, 'info');
        return { stock: mv.map(x => ({ product_id: x.p.id, stock: num(x.p.stock), shop_stock: x.sh, gudang_stock: roundQty(num(x.p.stock) - x.sh) })) };
      }
      case 'bootstrap': return { opname: opnameBoot(db), user: { name: u.name, role: roleOf(u) }, products: db.products.map(p => costNamesFor(db, prodOut(p), u.role)), customers: db.customers, settings: settingsOut(db, u.role), ai_reader: (() => { try { return localStorage.getItem('kmock.ai') !== 'off'; } catch (e) { return true; } })(), repacks_open: window.KRepackMock.openList(db, u.role), purchase_checks: isAppr(u) || u.role === 'akuntan' ? purchaseChecks(db) : null, via_master: viaMaster, must_change: u.must_change === true && !viaMaster,
        users: db.users.map(x => owner ? { name: x.name, role: x.role, active: x.active, must_change: x.must_change === true, locked: Date.parse(x.locked_until) > Date.now(), tamper: isLockedAcct(x.name), has_master: x.role === 'owner' && isHash(x.master_hash) } : { name: x.name, role: x.role, active: x.active }), server_time: new Date().toISOString(), approvals_pending: ['owner', 'manager'].includes(u.role) ? db.approvals.filter(x => x.status === 'pending').length : 0,
        shift: blind(shiftSummary(db, openShiftOf(db, u.name)), u.role), open_shifts: ['owner', 'manager'].includes(u.role) ? db.shifts.filter(x => x.status === 'open').map(x => shiftSummary(db, x)) : [],
        activity_recent: owner ? db.activity.filter(a => a.act_date >= addDays(jktDate(), -7) && a.act_date <= jktDate()).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100) : [],
        // v38 (owner 2026-10-12: "For any notice come to me make for me I can reply"): the role-addressed notices, as the server returns them
        notifications: ['owner', 'manager', 'akuntan'].includes(u.role) ? db.activity.filter(a => a.act_date >= addDays(jktDate(), -7) && ((a.kind === 'notifikasi' && String(a.ref || '').split(',').includes(u.role)) || (owner && a.kind === 'ubah_faktur' && String(a.user).toLowerCase() !== String(u.name).toLowerCase()))).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 40) : [] };
      case 'device_ping': {
        if (!deviceTouch(db, u, data.device, true)) throw E('INVALID', 'device.id tidak valid');
        return { require_location: db.settings.require_device_location === true, server_time: new Date().toISOString() };
      }
      case 'list_devices': return { store: { lat: num(db.settings.store_lat), lng: num(db.settings.store_lng) }, devices: db.devices.map(d => { const o = Object.assign({}, d); delete o.id; return o; }).sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen))), server_time: new Date().toISOString() };
      case 'list_activity': {
        if (!isYmd(data.from) || !isYmd(data.to)) throw E('INVALID', 'from/to');
        return { activity: db.activity.filter(a => a.act_date >= data.from && a.act_date <= data.to).sort((a, b) => String(b.at).localeCompare(String(a.at))) };
      }

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
        if (!shift && roleOf(u) === 'kasir' && db.settings.require_shift !== false) throw E('SHIFT_REQUIRED', 'Open the cash drawer (open_shift) first');
        const P = priceSale(db, data);
        // v16: only goods already on the shop shelf can be sold (queued offline sales are never refused)
        const notOnShelf = [];
        P.qtyBy.forEach((q, pid) => { const p = prodById(pid), sh = shopOf(p); if (q > sh + 1e-9) notOnShelf.push({ product_id: p.id, name: p.name, need: q, shop: sh, gudang: roundQty(num(p.stock) - sh) }); });
        if (notOnShelf.length && setting(db, 'sell_from_shop_only') !== false && data.queued !== true) throw E('NOT_ON_SHELF', 'Barang belum ada di rak toko: ' + notOnShelf.map(x => x.name + ' (perlu ' + fmtN(x.need) + ', rak ' + fmtN(x.shop) + ', gudang ' + fmtN(x.gudang) + (x.gudang <= 0 ? ' — belum ada barang masuk dengan nota' : ' — pindahkan dulu dari gudang') + ')').join('; '), { items: notOnShelf });
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
        // v16: discount above max_discount_pct (+ the member discount) needs a manager / owner for a kasir
        const disc = discountOf(P), mem = memberInfo(db, P.cust), discLimit = maxDiscountPct(db) + (mem ? mem.pct : 0);
        let discBy = '', usedDisc = null;
        if (disc.pct > discLimit + 1e-9) {
          if (roleOf(u) === 'kasir') {
            const da = strv(data.discount_approval_id) ? db.approvals.find(x => x.request_id === strv(data.discount_approval_id)) : null;
            if (!da || da.kind !== 'discount') throw E('DISCOUNT_APPROVAL_REQUIRED', 'Diskon ' + disc.pct + '% melebihi batas ' + discLimit + '%: minta persetujuan manajer / pemilik');
            if (da.status !== 'approved') throw E('DISCOUNT_APPROVAL_REQUIRED', da.status === 'rejected' ? 'Diskon ditolak: ' + strv(da.note) : 'Diskon belum disetujui');
            if (da.client_id !== cid || disc.amount > int(da.debt_amount)) throw E('DISCOUNT_APPROVAL_REQUIRED', 'Transaksi berubah setelah diskon disetujui, minta persetujuan lagi');
            discBy = strv(da.decided_by); usedDisc = da;
          } else discBy = u.name;
        }
        const st = db.settings;
        const minTotal = int(st.exit_photo_min_total ?? 1000000), minQty = num(st.exit_photo_min_qty ?? 20);
        const exitReq = (minTotal > 0 && P.total >= minTotal) || (minQty > 0 && P.lines.some(l => l.qty >= minQty));
        const { cust, lines, subtotal, discount, total, total_cost, paid, debt, sale_date } = P;
        const sale = {
          id: nextId(db, 'sale'), invoice_no: invoiceNo(db, sale_date, data.sale_time || jktISO()), day_seq: db.sales.filter(s => s.sale_date === sale_date).length + 1, sale_date, sale_time: data.sale_time || jktISO(),
          cashier: u.name, customer_id: cust ? cust.id : null, customer_name: cust ? cust.name : (data.customer_name || 'Umum'),
          customer_type: cust ? cust.type : 'eceran', subtotal, discount, send_fee: P.sendFee, total, total_cost, profit: total - total_cost,
          payment_method: P.method, pay_parts: P.parts ? JSON.stringify(P.parts) : '', paid_amount: paid, debt_amount: debt, status: 'ok',
          survey: JSON.stringify(data.survey_consent && Array.isArray(data.survey) ? data.survey.filter(x => x && String(x.a || '').trim()).map(x => ({ q: String(x.q), a: String(x.a) })) : []),
          survey_transcript: data.survey_consent === true ? String(data.survey_transcript || '').trim().slice(0, 4000) : '',
          notes: (String(data.notes || '').trim() + (mem && mem.pct > 0 ? ' [member ' + mem.pct + '% · pembelian ke-' + mem.purchase_no + ']' : '') + (discBy ? ' [diskon ' + disc.pct + '% disetujui ' + discBy + ']' : '')).trim(), client_id: cid, approved_by, exit_photo: exitReq ? 'required' : '', exit_match: '',
          channel: CHANNELS.includes(data.channel) ? data.channel : 'toko', promo_code: String(data.promo_code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''), shift_id: shift ? shift.shift_id : ''
        };
        if (usedApproval) usedApproval.status = 'used';
        if (usedDisc) usedDisc.status = 'used';
        const trPart = window.KPay.of(sale).transfer; // v51: a split sale's transfer part is checked too
        let slipAmt = null;
        if (trPart > 0) { // v57 (as on the server): the store account — chosen, else from the slip, else the only active one
          const ph = data.photo_id ? (db.photos || []).find(x => x.photo_id === data.photo_id && x.kind === 'bayar') : null, ex = ph ? ph.extracted || {} : null;
          const accs = bankAccounts(db), act = accs.filter(x => x.active !== false), want = strv(data.account_id);
          sale.account_id = want && accs.some(x => strv(x.id) === want) ? want : ((ex && window.KBank ? KBank.slipAccount(accs, ex, 'in') : '') || (act.length === 1 ? strv(act[0].id) : ''));
          sale.bank = (strv(data.bank) || (ex ? strv(ex.sender_bank) || strv(ex.bank) : '')).slice(0, 60);
          sale.transfer_ref = (strv(data.transfer_ref) || (ex ? strv(ex.transfer_ref) : '')).slice(0, 80);
          sale.proof_photo_id = ex ? strv(data.photo_id) : '';
          slipAmt = ex && ex.amount != null && isFinite(Number(ex.amount)) ? int(ex.amount) : null;
        }
        db.sales.push(sale);
        if (trPart > 0) addTransferConfirm(db, u, 'faktur', sale.invoice_no, trPart, sale.customer_name, sale.bank, sale.transfer_ref, { account_id: sale.account_id, photo_id: sale.proof_photo_id, slip_amount: slipAmt });
        for (const l of lines) {
          db.items.push({ invoice_no: sale.invoice_no, sale_date, product_id: l.p.id, sku: l.p.sku, name: l.p.name, qty: l.qty, unit_price: l.unit_price, price_type: l.price_type, cost_price: l.p.cost_price, line_total: l.line_total, line_profit: l.line_total - l.line_cost, customer_name: sale.customer_name });
        }
        const stockOut = [];
        P.qtyBy.forEach((q, pid) => {
          const p = prodById(pid);
          db._shopSet[p.id] = roundQty(shopOf(p) - q);
          p.stock = roundQty(p.stock - q);
          stockOut.push({ product_id: p.id, stock: p.stock, shop_stock: Math.min(p.stock, db._shopSet[p.id]) });
        });
        if (cust) Object.assign(cust, { debt_balance: int(cust.debt_balance) + debt, visits: Math.max(0, Math.round(num(cust.visits))) + 1, last_visit: sale_date,
          receipts_sent: Math.max(0, Math.round(num(cust.receipts_sent))) + (data.send_receipt === true ? 1 : 0) });
        if (notOnShelf.length) logAct(db, u, 'jual_tanpa_rak', 'Penjualan ' + sale.invoice_no + ' (tersimpan offline) melebihi stok rak: ' + notOnShelf.map(x => x.name + ' perlu ' + fmtN(x.need) + ', rak ' + fmtN(x.shop)).join('; '), sale.invoice_no, 0, 'warn');
        if (discBy) logAct(db, u, 'diskon', 'Diskon ' + disc.pct + '% (Rp ' + disc.amount + ') pada ' + sale.invoice_no + ' oleh ' + u.name + (discBy !== u.name ? ', disetujui ' + discBy : ''), sale.invoice_no, disc.amount, 'warn');
        if (debt > 0) logAct(db, u, 'hutang', 'Penjualan hutang ' + sale.invoice_no + ' ' + sale.customer_name + ' Rp ' + debt + (approved_by ? ' (disetujui ' + approved_by + ')' : ''), sale.invoice_no, debt, 'info');
        const { id: _omit, ...saleOut } = sale;
        return { invoice_no: sale.invoice_no, sale: saleOut, stock: stockOut, duplicate: false, exit_photo_required: exitReq, member: mem };
      }
      case 'request_discount': {
        const cid = String(data.client_id || '');
        if (!cid) throw E('INVALID', 'client_id wajib');
        const P = priceSale(db, data, true);
        const disc = discountOf(P), mem = memberInfo(db, P.cust);
        if (disc.pct <= maxDiscountPct(db) + (mem ? mem.pct : 0) + 1e-9) throw E('INVALID', 'Diskon ' + disc.pct + '% masih dalam batas, tidak perlu persetujuan');
        const pb = P.listTotal - P.total_cost, pa = P.total - P.total_cost, mb = marginPct(P.listTotal, P.total_cost), ma = marginPct(P.total, P.total_cost);
        const reason = strv(data.reason).slice(0, 300);
        const approval = newApproval(db, u, { kind: 'discount', approver_role: 'manager', client_id: cid, ref: cid, customer_id: P.cust ? P.cust.id : 0, customer_name: P.cust ? P.cust.name : strv(data.customer_name || 'Umum'),
          total: P.total, debt_amount: disc.amount, note: reason,
          summary: ('Diskon ' + disc.pct + '% (Rp ' + disc.amount + '): Rp ' + P.listTotal + ' → Rp ' + P.total + ' — ' + P.lines.map(l => l.p.name + ' x' + l.qty + ' @' + l.unit_price).join('; ') + ' | laba ' + mb + '% → ' + ma + '% (Rp ' + pb + ' → Rp ' + pa + ')').slice(0, 1500),
          payload: JSON.stringify({ list_total: P.listTotal, total: P.total, discount: disc.amount, pct: disc.pct, max_pct: maxDiscountPct(db), member_pct: mem ? mem.pct : 0, reason, lines: P.lines.map(l => ({ name: l.p.name, qty: l.qty, unit_price: l.unit_price })), profit_before: pb, profit_after: pa, margin_before: mb, margin_after: ma }) });
        logAct(db, u, 'minta_diskon', 'Minta diskon ' + disc.pct + '% (Rp ' + disc.amount + ') total Rp ' + P.listTotal + ' → Rp ' + P.total + ' | laba ' + mb + '% → ' + ma + '%' + (reason ? ' | ' + reason : ''), approval.request_id, disc.amount, 'warn');
        return { request_id: approval.request_id, approval };
      }
      case 'request_credit': {
        const cid = String(data.client_id || '');
        if (!cid) throw E('INVALID', 'client_id required');
        const P = priceSale(db, data);
        if (!(P.debt > 0)) throw E('INVALID', 'No debt in this sale');
        const open = db.approvals.find(x => x.client_id === cid && x.status === 'pending' && x.total === P.total && x.debt_amount === P.debt && x.customer_id === P.cust.id);
        if (open) return { request_id: open.request_id, approval: open };
        const approval = {
          request_id: 'APR-' + String(nextId(db, 'approval')).padStart(4, '0'), client_id: cid, created_at: jktISO(), cashier: u.name,
          customer_id: P.cust.id, customer_name: P.cust.name, customer_debt_before: int(P.cust.debt_balance), total: P.total, debt_amount: P.debt,
          summary: P.lines.map(l => `${fmtQty(l.qty)}× ${l.p.name}`).join(', '), status: 'pending', decided_by: '', decided_at: '', note: '',
          kind: 'credit', ref: cid, payload: '', approver_role: 'manager'
        };
        db.approvals.push(approval);
        return { request_id: approval.request_id, approval };
      }
      case 'request_return': {
        if (!['owner', 'manager', 'kasir'].includes(u.role)) throw E('FORBIDDEN', 'Tidak diizinkan');
        const kind = data.kind === 'pemasok' ? 'pemasok' : 'pelanggan';
        const st = Object.assign({}, V16_DEFAULTS, db.settings);
        const reasonCode = RETURN_REASONS.indexOf(data.reason_code) >= 0 ? data.reason_code : '';
        if (!reasonCode) throw E('INVALID', 'Pilih alasan retur');
        const reasonNote = strv(data.reason_note).slice(0, 300);
        if (reasonCode === 'lainnya' && !reasonNote) throw E('INVALID', 'Tulis alasan retur');
        const rlines = Array.isArray(data.lines) ? data.lines.slice(0, 100) : [];
        if (!rlines.length) throw E('INVALID', 'Pilih barang yang diretur');
        const agg = {};
        for (const l0 of rlines) {
          const l = l0 || {}, p = prodById(l.product_id);
          if (!p) throw E('NOT_FOUND', 'Produk tidak ditemukan: ' + l.product_id);
          const q = roundQty(l.qty);
          if (!(q > 0)) throw E('INVALID', 'Jumlah tidak valid: ' + strv(p.name));
          const cond = l.condition === 'rusak' ? 'rusak' : 'baik', k = String(p.id) + '|' + (kind === 'pelanggan' ? cond : '');
          if (!agg[k]) agg[k] = { product_id: p.id, name: strv(p.name), unit: strv(p.unit), qty: 0, condition: kind === 'pelanggan' ? cond : '' };
          agg[k].qty = roundQty(agg[k].qty + q);
        }
        const list = Object.keys(agg).map(k => agg[k]), qtyByPid = {};
        list.forEach(l => { qtyByPid[String(l.product_id)] = roundQty((qtyByPid[String(l.product_id)] || 0) + l.qty); });
        const ref = kind === 'pelanggan' ? strv(data.invoice_no) : strv(data.purchase_no);
        if (!ref) throw E('INVALID', kind === 'pelanggan' ? 'Nomor faktur pembelian wajib' : 'Nomor barang masuk (nota pemasok) wajib');
        const before = returnedBefore(db, ref);
        const returnId = 'RT' + jktDate().replace(/-/g, '').slice(2) + '-' + randId(4);
        let rec;
        if (kind === 'pelanggan') {
          const sale = db.sales.find(x => x.invoice_no === ref);
          if (!sale) throw E('NOT_FOUND', 'Faktur tidak ditemukan: ' + ref);
          if (sale.status === 'void') throw E('INVALID', 'Faktur ini sudah dibatalkan');
          const sold = {}, value = {};
          db.items.filter(it => it.invoice_no === ref).forEach(it => { const k = String(it.product_id); sold[k] = (sold[k] || 0) + num(it.qty); value[k] = (value[k] || 0) + int(it.line_total); });
          const discRatio = int(sale.subtotal) > 0 ? Math.min(1, int(sale.discount) / int(sale.subtotal)) : 0;
          const over = [];
          Object.keys(qtyByPid).forEach(pid => { const left = roundQty((sold[pid] || 0) - (before[pid] || 0)); if (qtyByPid[pid] > left + 1e-9) over.push(strv(prodById(pid).name) + ': dibeli ' + fmtN(sold[pid] || 0) + ', sudah diretur ' + fmtN(before[pid] || 0)); });
          if (over.length) throw E('INVALID', 'Jumlah retur melebihi yang dibeli di faktur ini: ' + over.join('; '));
          list.forEach(l => { const pid = String(l.product_id), unitNet = sold[pid] > 0 ? (value[pid] / sold[pid]) * (1 - discRatio) : 0; l.unit_price = Math.round(unitNet); l.value = Math.round(l.qty * unitNet); });
          const gross = sum(list, l => l.value), feePct = Math.min(50, Math.max(0, num(st.return_fee_pct))), fee = Math.round(gross * feePct / 100);
          const method = ['tunai', 'transfer', 'potong_hutang', 'tukar'].includes(data.refund_method) ? data.refund_method : 'tunai';
          const cust = sale.customer_id ? custById(sale.customer_id) || null : null;
          if (method === 'potong_hutang' && !(cust && int(cust.debt_balance) > 0)) throw E('INVALID', 'Pelanggan ini tidak punya hutang untuk dipotong');
          if (strv(data.returned_by) && !personName(data.returned_by)) throw E('INVALID', 'Nama orang yang mengembalikan hanya boleh huruf');
          if (strv(data.returned_by_phone) && !normPhone(data.returned_by_phone)) throw E('INVALID', 'Nomor HP orang yang mengembalikan tidak valid');
          const by = personName(data.returned_by) || (cust ? strv(cust.name) : strv(sale.customer_name));
          if (!by) throw E('INVALID', 'Nama orang yang mengembalikan wajib');
          rec = { return_id: returnId, kind, ref, party_id: cust ? cust.id : 0, party_name: strv(sale.customer_name), bought_by: strv(sale.customer_name), bought_date: strv(sale.sale_date),
            returned_by: by, returned_by_phone: normPhone(data.returned_by_phone), lines: list, qty_total: roundQty(sum(list, l => l.qty)), value: gross, fee_pct: feePct, fee,
            refund: gross - fee, refund_method: method, reason_code: reasonCode, reason_note: reasonNote, photo_id: '', out_doc_no: '', carrier_type: '', carrier_name: '', carrier_vehicle: '', carrier_phone: '' };
        } else {
          const prows = db.purchases.filter(x => strv(x.purchase_no) === ref && num(x.qty) > 0);
          if (!prows.length) throw E('NOT_FOUND', 'Barang masuk tidak ditemukan: ' + ref);
          const bought = {}, cost = {};
          prows.forEach(x => { const k = String(x.product_id); bought[k] = (bought[k] || 0) + num(x.qty); cost[k] = int(x.cost_price); });
          const over = [];
          Object.keys(qtyByPid).forEach(pid => {
            const left = roundQty((bought[pid] || 0) - (before[pid] || 0));
            if (!bought[pid]) over.push(strv(prodById(pid).name) + ': tidak ada di nota ' + ref);
            else if (qtyByPid[pid] > left + 1e-9) over.push(strv(prodById(pid).name) + ': masuk ' + fmtN(bought[pid]) + ', sudah diretur ' + fmtN(before[pid] || 0));
            else if (qtyByPid[pid] > num(prodById(pid).stock) + 1e-9) over.push(strv(prodById(pid).name) + ': stok hanya ' + fmtN(prodById(pid).stock));
          });
          if (over.length) throw E('INVALID', 'Retur ke pemasok tidak bisa: ' + over.join('; '));
          const outDoc = docNo(data.out_doc_no);
          if (!outDoc) throw E('INVALID', 'Nomor nota / surat jalan barang keluar wajib (huruf, angka, / - . saja)');
          const photoId = strv(data.photo_id), ph = photoId ? db.photos.find(x => x.photo_id === photoId) : null;
          if (st.require_return_photo !== false && !ph) throw E('INVALID', 'Foto bukti barang keluar wajib');
          const carrier = readCarrier(data.carrier, true);
          if (carrier.error) throw E('INVALID', carrier.error);
          list.forEach(l => { l.unit_price = cost[String(l.product_id)] || 0; l.value = Math.round(l.qty * l.unit_price); });
          const gross = sum(list, l => l.value);
          rec = { return_id: returnId, kind, ref, party_id: 0, party_name: strv(prows[0].supplier), bought_by: '', bought_date: strv(prows[0].purchase_date), returned_by: carrier.name || u.name, returned_by_phone: carrier.phone,
            lines: list, qty_total: roundQty(sum(list, l => l.qty)), value: gross, fee_pct: 0, fee: 0, refund: gross, refund_method: 'nota_kredit', reason_code: reasonCode, reason_note: reasonNote,
            photo_id: ph ? photoId : '', out_doc_no: outDoc, carrier_type: carrier.type, carrier_name: carrier.name, carrier_vehicle: carrier.vehicle, carrier_phone: carrier.phone };
        }
        const minVal = num(st.return_owner_min_value) > 0 ? num(st.return_owner_min_value) : 2000000, minQty = num(st.return_owner_min_qty);
        const ownerNeeded = rec.value >= minVal || (minQty > 0 && rec.qty_total >= minQty);
        const summary = (kind === 'pelanggan' ? 'Retur pelanggan ' + rec.party_name + ' (dikembalikan ' + rec.returned_by + ') faktur ' + ref : 'Retur ke pemasok ' + rec.party_name + ' dari ' + ref + ', nota keluar ' + rec.out_doc_no) +
          ': ' + list.map(l => l.name + ' ' + fmtN(l.qty) + ' ' + l.unit + (l.condition === 'rusak' ? ' (rusak)' : '')).join('; ') + ' | ' + RETURN_REASON_TEXT[reasonCode] + (reasonNote ? ': ' + reasonNote : '') +
          (kind === 'pelanggan' ? ' | uang kembali Rp ' + rec.refund + ' (' + rec.refund_method + ')' + (rec.fee ? ', potongan retur Rp ' + rec.fee : '') : ' | nilai Rp ' + rec.value);
        const ap = newApproval(db, u, { kind: 'retur', approver_role: ownerNeeded ? 'owner' : 'manager', ref: returnId, client_id: strv(data.client_id).slice(0, 60),
          customer_id: rec.party_id, customer_name: rec.party_name, total: kind === 'pelanggan' ? rec.refund : rec.value, debt_amount: 0, summary: summary.slice(0, 1500), note: reasonNote, payload: JSON.stringify(rec) });
        logAct(db, u, 'minta_retur', summary + (ownerNeeded ? ' — butuh persetujuan pemilik' : ' — menunggu manajer'), returnId, ap.total, 'warn');
        return { request_id: ap.request_id, return_id: returnId, approver_role: ap.approver_role, approval: ap };
      }
      case 'propose_agreement': {
        // owner and manager agree on a limit: one proposes, the other confirms; each agreement is recorded
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const key = AGREED_KEYS.includes(data.key) ? data.key : '';
        if (!key) throw E('INVALID', 'Batas tidak dikenal');
        const value = Math.round(num(data.value));
        if (!(value >= 0) || value > 1000000000 || (key === 'return_owner_min_value' && value < 1)) throw E('INVALID', 'Nilai tidak valid');
        const note = strv(data.note).slice(0, 300), cur = num(setting(db, key));
        const label = key === 'return_owner_min_value' ? 'Batas retur yang perlu persetujuan pemilik: Rp ' : 'Batas jumlah barang retur untuk pemilik: ';
        const ap = newApproval(db, u, { kind: 'kesepakatan', approver_role: owner ? 'manager' : 'owner', ref: key, total: value,
          summary: ('Usul ' + u.name + ': ' + label + value + ' (sekarang ' + cur + ')' + (note ? ' | ' + note : '')).slice(0, 1500), note,
          payload: JSON.stringify({ key, value, from: cur, proposed_by: u.name, proposed_role: roleOf(u) }) });
        logAct(db, u, 'usul_kesepakatan', ap.summary, ap.request_id, value, 'info');
        return { request_id: ap.request_id, approval: ap };
      }
      case 'get_sale': {
        // one invoice by its number (returns at the counter): the sale, its lines and what was already returned or is pending
        const no = strv(data.invoice_no), sale = db.sales.find(x => x.invoice_no === no);
        if (!no || !sale) throw E('NOT_FOUND', 'Faktur tidak ditemukan: ' + no);
        const cust = sale.customer_id ? custById(sale.customer_id) : null;
        const { id: _sid, ...saleOut } = sale;
        return { sale: saleOut, items: db.items.filter(it => it.invoice_no === no), returned: returnedBefore(db, no), customer_debt: cust ? int(cust.debt_balance) : 0 };
      }
      case 'list_returns': {
        if (!['owner', 'manager', 'kasir', 'akuntan'].includes(u.role)) throw E('FORBIDDEN', 'Tidak diizinkan');
        const inR = d => (!isYmd(data.from) || strv(d) >= data.from) && (!isYmd(data.to) || strv(d) <= data.to);
        const done1 = db.returns.filter(r => inR(r.return_date)).map(r => returnOut(r, u.role)).filter(Boolean);
        const pending = db.approvals.filter(a => a.kind === 'retur' && a.status === 'pending').map(a => {
          let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
          return returnOut(Object.assign({}, pl, { status: 'pending', request_id: a.request_id, approver_role: a.approver_role, return_date: strv(a.created_at).slice(0, 10), user: strv(a.cashier) }), u.role);
        }).filter(Boolean);
        return { returns: pending.concat(done1.sort((x, y) => String(y.at).localeCompare(String(x.at)))) };
      }
      case 'check_approval': {
        const ap = db.approvals.find(x => x.request_id === data.request_id);
        if (!ap) throw E('NOT_FOUND', 'approval');
        return { approval: ap };
      }
      case 'list_approvals': {
        if (!['owner', 'manager', 'akuntan'].includes(u.role)) throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        // the accountant only sees the shared manager-or-accountant requests (v29/v36, as on the server)
        const apOut = { approvals: db.approvals.filter(x => x.status === 'pending' && (isAppr(u) || x.approver_role === 'mgr_akuntan')).map(x => Object.assign({}, x, { can_decide: canDecideAp(u, x) })) };
        // v38 the owner's view of the free D1 allowance (demo: db.d1_usage, else small numbers)
        if (u.role === 'owner') apOut.usage = Object.assign({ day: new Date().toISOString().slice(0, 10), read: 182000, write: 950, y_read: 640000, y_write: 2100, read_limit: 5000000, write_limit: 100000 }, db.d1_usage || {});
        return apOut;
      }
      case 'decide_approval': {
        if (!['owner', 'manager', 'akuntan'].includes(u.role)) throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        const ap = db.approvals.find(x => x.request_id === data.request_id);
        if (!ap) throw E('NOT_FOUND', 'approval');
        if (!['approved', 'rejected'].includes(data.decision)) throw E('INVALID', 'decision');
        if (ap.status !== 'pending') throw E('INVALID', 'Permintaan sudah diputuskan' + (strv(ap.decided_by) ? ' oleh ' + strv(ap.decided_by) : '') + ': ' + ap.status);
        if (!canDecideAp(u, ap)) { if (ap.approver_role === 'owner' || isOldVoid(ap)) throw E('NEEDS_OWNER', isOldVoid(ap) ? 'Faktur lama — hanya pemilik yang boleh menyetujui' : 'Only the owner can decide this request'); throw E('FORBIDDEN', isOwnVoid(u, ap) ? 'Permintaan sendiri diputuskan orang lain' : 'Tidak diizinkan memutuskan permintaan ini'); }
        const out = {};
        let planFinal = '';
        if (data.decision === 'approved' && ap.kind === 'void') {
          if (data.invoice_no !== ap.ref) throw E('INVALID', 'invoice_no must equal approval.ref');
          let reason = ''; try { reason = JSON.parse(ap.payload || '{}').reason || ''; } catch (e) { }
          const wasVoid = (db.sales.find(x => x.invoice_no === ap.ref) || {}).status === 'void';
          out.sale = voidSaleNow(db, ap.ref, `${reason} (diminta ${ap.cashier}, disetujui ${u.name})`, u.name);
          if (!wasVoid) voidChange(db, u, out.sale, reason, ap.cashier, ap.created_at, ap.request_id); // v37
        }
        if (data.decision === 'approved' && ap.kind === 'price') {
          const p = prodById(ap.ref); if (!p) throw E('NOT_FOUND', 'product');
          const pl = JSON.parse(ap.payload || '{}');
          for (const [f, ch] of Object.entries(pl.changes || {})) p[f] = int(ch.to);
          out.product = p;
        }
        if (data.decision === 'approved' && ap.kind === 'opname') { out.stock = applyOpnameV37(db, u, ap, u.name); out.opname = opnameStatus(db); }
        if (ap.kind === 'opname' && u.role !== 'owner') { // v40: the owner is told what the manager decided (as on the server)
          let plN = {}; try { plN = JSON.parse(ap.payload || '{}'); } catch (e) { }
          const lsN = plN.lines || [], nD = lsN.filter(l => Number(l.diff)).length;
          ownerNotice(db, u, `Stok opname ${ap.cashier} ${data.decision === 'approved' ? 'DISETUJUI' : 'DITOLAK'} oleh ${u.name}: ${lsN.length} barang, ${nD} selisih${countValueText(db, lsN)} — ${ap.request_id}`, data.decision === 'approved' && nD ? 'warn' : 'info');
        }
        if (data.decision === 'approved' && ap.kind === 'purchase_fix') {
          let pl = {}; try { pl = JSON.parse(ap.payload || '{}'); } catch (e) { }
          const no = strv(pl.purchase_no);
          if (strv(data.purchase_no) !== no) throw E('INVALID', 'Kirim purchase_no barang masuk yang dikoreksi');
          const pf = purchaseFixChanges(db, no, pl.lines);
          if (!pf.found) throw E('INVALID', 'Kirim purchase_no barang masuk yang dikoreksi');
          const first = db.purchases.find(r => strv(r.purchase_no) === no) || {};
          out.stock = applyPurchaseFix(db, no, pf.changes, strv(pl.reason) + ' (diminta ' + ap.cashier + ', disetujui ' + u.name + ')', u.name);
          purchaseFixChange(db, u, no, first, pf.changes, strv(pl.reason), ap.cashier, ap.created_at, ap.request_id); // v37: the owner is told
        }
        if (ap.kind === 'kesepakatan') {
          if (strv(ap.cashier).toLowerCase() === u.name.toLowerCase()) throw E('FORBIDDEN', 'Kesepakatan harus dikonfirmasi pihak lain');
          if (ap.approver_role === 'owner' && !owner) throw E('NEEDS_OWNER', 'Butuh konfirmasi pemilik');
          if (ap.approver_role === 'manager' && u.role !== 'manager') throw E('FORBIDDEN', 'Kesepakatan ini dikonfirmasi oleh manajer');
          let pl = {}; try { pl = JSON.parse(ap.payload || '{}'); } catch (e) { pl = {}; }
          if (data.decision === 'approved' && AGREED_KEYS.includes(pl.key)) {
            const agreed = { key: pl.key, value: num(pl.value), from: num(pl.from), proposed_by: strv(pl.proposed_by), confirmed_by: u.name, at: new Date().toISOString(), note: strv(ap.note) };
            const hist = Array.isArray(setting(db, 'limit_agreements')) ? JSON.parse(JSON.stringify(setting(db, 'limit_agreements'))) : [];
            hist.unshift(agreed);
            db.settings[pl.key] = num(pl.value); db.settings.limit_agreements = hist.slice(0, 50);
            out.agreement = agreed;
          }
          logAct(db, u, 'kesepakatan', (data.decision === 'approved' ? 'Disepakati ' : 'Ditolak ') + strv(pl.proposed_by) + ' & ' + u.name + ': ' + strv(ap.summary).slice(0, 500), ap.request_id, int(ap.total), 'warn');
        }
        if (ap.kind === 'retur') {
          let rec = {}; try { rec = JSON.parse(ap.payload || '{}'); } catch (e) { rec = {}; }
          const rl = Array.isArray(rec.lines) ? rec.lines : [];
          if (data.decision === 'approved') {
            const back = {};
            rl.forEach(l => { const pid = String(l.product_id); if (rec.kind === 'pemasok') back[pid] = (back[pid] || 0) - num(l.qty); else if (l.condition !== 'rusak') back[pid] = (back[pid] || 0) + num(l.qty); });
            // good returned goods go back to the warehouse (checked before they return to the shelf); damaged ones are not stock
            out.stock = [];
            Object.keys(back).forEach(pid => {
              const p = prodById(pid); if (!p || !back[pid]) return;
              const ns = roundQty(num(p.stock) + back[pid]);
              if (back[pid] < 0) db._shopSet[p.id] = Math.min(shopOf(p), Math.max(0, ns));
              p.stock = ns; out.stock.push({ product_id: p.id, stock: ns });
            });
            if (rec.kind === 'pemasok') {
              rl.forEach(l => db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: strv(rec.party_name), product_id: l.product_id, name: strv(l.name), qty: -num(l.qty), cost_price: int(l.unit_price), total: -int(l.value),
                note: 'RETUR ' + strv(rec.return_id) + ' dari ' + strv(rec.ref) + ' — ' + (RETURN_REASON_TEXT[rec.reason_code] || '') + (rec.reason_note ? ': ' + strv(rec.reason_note) : ''), user: strv(ap.cashier), photo_id: strv(rec.photo_id), exp_date: '',
                purchase_no: strv(rec.return_id), match_status: 'retur', match_notes: 'nota keluar ' + strv(rec.out_doc_no) }));
            } else {
              const cust = rec.party_id ? custById(rec.party_id) : null, refund = int(rec.refund);
              if (rec.refund_method === 'potong_hutang' && cust) cust.debt_balance = Math.max(0, int(cust.debt_balance) - refund);
              else if ((rec.refund_method === 'tunai' || rec.refund_method === 'transfer') && refund > 0) {
                db.payments.push({ id: nextId(db, 'payment'), pay_id: 'PY' + randId(7), pay_date: jktDate(), pay_time: new Date().toISOString(), direction: 'out', party_type: 'customer', customer_id: rec.party_id || 0, customer_name: strv(rec.party_name), supplier: '',
                  amount: refund, method: rec.refund_method, account_id: payAccount(db, data, rec.refund_method), slip_date: '', bank: '', transfer_ref: '', proof_photo_id: '', alloc: '[]', match_status: 'retur', note: 'Uang kembali retur ' + strv(rec.return_id) + ' faktur ' + strv(rec.ref), cashier: strv(ap.cashier) });
                const sh = rec.refund_method === 'tunai' ? openShiftOf(db, ap.cashier) : null;
                if (sh) db.cash_moves.push({ id: nextId(db, 'move'), shift_id: sh.shift_id, type: 'out', amount: refund, note: 'Retur ' + strv(rec.return_id), user: u.name, time: jktISO() });
              }
            }
          }
          db.returns.push(Object.assign({}, rec, { id: nextId(db, 'return'), lines: JSON.stringify(rl), status: data.decision, user: strv(ap.cashier), approved_by: u.name, return_date: jktDate(), at: new Date().toISOString(), request_id: ap.request_id }));
          if (data.decision === 'approved') invoiceChange(db, u, { doc: rec.kind === 'pemasok' ? 'masuk' : 'jual', what: 'retur', no: strv(rec.ref), doc_date: strv(rec.bought_date), party: strv(rec.party_name), // v37
            changes: rl.map(l => ({ product_id: l.product_id, name: strv(l.name), qty_ret: num(l.qty), condition: strv(l.condition), price_from: int(l.unit_price), price_to: int(l.unit_price), total: int(l.value) })),
            reason: (RETURN_REASON_TEXT[rec.reason_code] || '') + (rec.reason_note ? ': ' + strv(rec.reason_note) : '') + ' (' + strv(rec.return_id) + ')', requested_by: ap.cashier, requested_at: ap.created_at, request_id: ap.request_id,
            amount: rec.kind === 'pemasok' ? -int(rec.value) : -int(rec.refund) });
          logAct(db, u, 'retur', (data.decision === 'approved' ? 'Retur disetujui ' : 'Retur ditolak ') + u.name + ': ' + strv(ap.summary).slice(0, 600), strv(rec.return_id), int(ap.total), 'warn');
          out.return_id = strv(rec.return_id);
        }
        if (ap.kind === 'pay_plan') {
          // v23 supplier pay plan: the owner ticks which items (data.approve_items) to authorize paying now.
          let pl = {}; try { pl = JSON.parse(ap.payload || '{}'); } catch (e) { pl = {}; }
          const items = Array.isArray(pl.items) ? pl.items : [];
          const picks = {};
          (Array.isArray(data.approve_items) ? data.approve_items : []).forEach(i => { const n = num(i); if (n >= 0 && n === Math.floor(n)) picks[n] = true; });
          let nApproved = 0;
          items.forEach((it, i) => { const yes = data.decision === 'approved' && picks[i] === true; it.approved = yes; if (yes) nApproved++; });
          ap.payload = JSON.stringify({ items });
          planFinal = (data.decision === 'approved' && nApproved > 0) ? 'approved' : 'rejected';
          logAct(db, u, planFinal === 'approved' ? 'setuju_bayar' : 'tolak_bayar', (planFinal === 'approved' ? 'Setuju bayar ' + nApproved + ' pemasok: ' : 'Tolak rencana bayar: ') + strv(ap.summary).slice(0, 500), ap.request_id, int(ap.total), planFinal === 'approved' ? 'info' : 'warn');
        }
        if (ap.kind === 'expense_check') {
          // v36: the expense carries the check result for the reports
          const ex = db.expenses.find(x => strv(x.request_id) === ap.request_id);
          if (ex) Object.assign(ex, { check_status: data.decision === 'approved' ? 'disetujui' : 'ditolak', checked_by: u.name });
        }
        if (ap.kind === 'repack') repackDecide(db, u, ap, data, out); // v38
        if (ap.kind === 'product_new') {
          // v36: confirm a cashier's new product (optionally correcting its selling prices) or switch it off for sale
          const p = db.products.find(x => strv(x.review) === ap.request_id);
          if (!p) throw E('NOT_FOUND', 'Produk baru tidak ditemukan');
          const pr = data.prices && typeof data.prices === 'object' ? data.prices : {};
          if (data.decision === 'approved') {
            ['retail_price', 'wholesale_price'].forEach(f => { if (pr[f] !== undefined && pr[f] !== null && pr[f] !== '' && int(pr[f]) >= 0) p[f] = int(pr[f]); });
            if (!(int(p.retail_price) > 0)) throw E('INVALID', 'Harga jual eceran wajib');
            if (pr.wholesale_min_qty !== undefined && pr.wholesale_min_qty !== null && pr.wholesale_min_qty !== '' && num(pr.wholesale_min_qty) >= 0) p.wholesale_min_qty = num(pr.wholesale_min_qty);
          } else p.active = false;
          p.review = '';
          out.product = p;
          logAct(db, u, data.decision === 'approved' ? 'produk_ok' : 'produk_tolak', (data.decision === 'approved' ? 'Produk baru DIKONFIRMASI ' : 'Produk baru DITOLAK (dinonaktifkan) ') + p.name + ' oleh ' + u.name, String(p.id), 0, data.decision === 'approved' ? 'info' : 'warn');
        }
        if (ap.kind === 'transfer_confirm') logAct(db, u, data.decision === 'approved' ? 'transfer_ok' : 'transfer_gagal', (data.decision === 'approved' ? 'Transfer masuk DIKONFIRMASI oleh ' + u.name : 'Transfer TIDAK diterima — ' + u.name + (String(data.note || '') ? ': ' + data.note : '')) + ' | ' + strv(ap.summary), strv(ap.ref), int(ap.total), data.decision === 'approved' ? 'info' : 'warn');
        if (ap.kind !== 'repack') logAct(db, u, 'keputusan', (data.decision === 'approved' ? 'Disetujui' : 'Ditolak') + ' (' + (ap.kind || 'credit') + ', diminta ' + ap.cashier + '): ' + strv(ap.summary).slice(0, 600) + (strv(data.note) ? ' | ' + strv(data.note) : ''), ap.request_id, int(ap.total), data.decision === 'approved' ? 'info' : 'warn');
        Object.assign(ap, { status: ap.kind === 'pay_plan' ? planFinal : data.decision, decided_by: u.name, decided_at: jktISO(), note: String(data.note || '') });
        return Object.assign({ approval: ap }, out);
      }
      case 'scan_purchase': {
        if (!String(data.image_base64 || '').length) throw E('INVALID', 'image_base64 required');
        let extracted;
        try { extracted = JSON.parse(localStorage.getItem('kmock.scan') || 'null'); } catch (e) { }
        // v50: kmock.scan = "off" plays a Worker without the AI key (the photo is kept, nothing read, ai: 'off')
        const aiOff = extracted === 'off';
        if (aiOff) extracted = { items: [], readable: false, notes: 'AI gagal membaca: AI_DISABLED' };
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
        keepPhotoImg(db, photo, data);
        db.photos.push(photo);
        return { photo_id: photo.photo_id, extracted, suggestions, drive_url: photo.drive_url, ai: aiOff ? 'off' : 'ok' };
      }
      case 'scan_expense': {
        // v29/v36 photo workflow, kind 'biaya' (same demo as Khair Kasir): localStorage kmock.expscan = the extracted JSON,
        // or "off" = the Worker has no AI key (the photo is kept, unreadable → "cek manual").
        if (!String(data.image_base64 || '').length) throw E('INVALID', 'image_base64 required');
        let raw = null; try { raw = localStorage.getItem('kmock.expscan'); } catch (e) { }
        let ex = null;
        if (raw === 'off') ex = { items: [], readable: false, notes: 'AI gagal membaca: AI_DISABLED' };
        else { try { ex = JSON.parse(raw || 'null'); } catch (e) { } }
        if (!ex) ex = { vendor: 'Toko Plastik Jaya', date: jktDate(), items: [{ name: 'Kantong plastik besar', qty: 10, unit_price: 5000, total: 50000 }, { name: 'Lakban coklat', qty: 5, unit_price: 7000, total: 35000 }], total: 85000, amount: 85000, readable: true, notes: '' };
        const photo = { photo_id: 'PH-' + String(nextId(db, 'photo')).padStart(5, '0'), kind: 'biaya', ref: '', created_at: jktISO(), photo_date: jktDate(), user: u.name, drive_url: '', extracted: ex,
          match_status: ex.readable === false || (ex.amount == null && ex.total == null) ? 'perlu_cek' : '', match_notes: strv(ex.notes) };
        db.photos.push(photo);
        return { photo_id: photo.photo_id, extracted: ex, drive_url: '' };
      }
      case 'scan_payment': {
        if (!String(data.image_base64 || '').length) throw E('INVALID', 'image_base64 required');
        let ex = null;
        try { ex = JSON.parse(localStorage.getItem('kmock.pay') || 'null'); } catch (e) { }
        if (!ex) ex = { date: jktDate(), time: jktTime(new Date()), amount: 500000, sender_name: 'TOKO BERKAH CONDET', sender_bank: 'BCA', receiver_name: 'KHAIR MART', receiver_bank: 'BCA', bank: 'BCA', transfer_ref: String(Date.now()).slice(-10), description: 'Pembayaran', status: 'berhasil', readable: true, notes: '' };
        const photo = { photo_id: 'PH-' + String(nextId(db, 'photo')).padStart(5, '0'), kind: 'bayar', ref: '', created_at: jktISO(), photo_date: jktDate(), user: u.name, drive_url: '', extracted: ex,
          match_status: ex.readable === false || ex.amount === null || ex.status === 'gagal' ? 'perlu_cek' : '', match_notes: strv(ex.notes) };
        keepPhotoImg(db, photo, data);
        db.photos.push(photo);
        return { photo_id: photo.photo_id, extracted: ex, drive_url: photo.drive_url };
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
        keepPhotoImg(db, photo, data);
        db.photos.push(photo);
        sale.exit_photo = photo.photo_id; sale.exit_match = match.status;
        return { photo_id: photo.photo_id, extracted: { items: seen }, match, drive_url: photo.drive_url };
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
        keepPhotoImg(db, photo, data);
        db.photos.push(photo);
        return { photo_id: photo.photo_id, extracted: ex, drive_url: photo.drive_url };
      }
      case 'photo_file': {
        // v36: GET <PHOTO_URL>/file/<photo_id> on the Worker — the stored image, owner / manager / akuntan only
        if (!['owner', 'manager', 'akuntan'].includes(u.role)) throw E('FORBIDDEN', 'Hanya pemilik, manajer, atau akuntan');
        const ph = db.photos.find(x => x.photo_id === String(data.photo_id || ''));
        if (!ph || String(ph.drive_file_id || '').indexOf('r2:') !== 0) throw E('NOT_FOUND', 'Foto tidak disimpan');
        return { photo_id: ph.photo_id, _img: ph.photo_id };
      }
      case 'list_photos': {
        if (!isYmd(data.from) || !isYmd(data.to)) throw E('INVALID', 'from/to');
        return { photos: db.photos.filter(x => x.photo_date >= data.from && x.photo_date <= data.to) };
      }
      case 'void_sale': {
        needOwner();
        if (!String(data.reason || '').trim()) throw E('INVALID', 'reason required');
        const vs = db.sales.find(x => x.invoice_no === data.invoice_no);
        const wasOk = vs && vs.status !== 'void';
        if (wasOk) logAct(db, u, 'batal', 'Faktur dibatalkan ' + vs.invoice_no + ' Rp ' + vs.total + ': ' + strv(data.reason), vs.invoice_no, vs.total, 'warn');
        const vsale = voidSaleNow(db, data.invoice_no, String(data.reason), u.name);
        if (wasOk) voidChange(db, u, vsale, String(data.reason), u.name, '', ''); // v37: the owner's own change — logged
        return { sale: vsale };
      }
      case 'request_void': {
        const sale = db.sales.find(x => x.invoice_no === data.invoice_no);
        if (!sale) throw E('NOT_FOUND', 'invoice');
        if (sale.status === 'void') throw E('INVALID', 'Already void');
        const reason = String(data.reason || '').trim();
        if (!reason) throw E('INVALID', 'reason required');
        const open = db.approvals.find(x => x.kind === 'void' && x.ref === sale.invoice_no && x.status === 'pending');
        if (open) return { request_id: open.request_id, approval: open };
        // v36: today's sale → manager OR accountant (mgr_akuntan); an EARLIER day's sale → only the owner
        const oldSale = !isYmd(sale.sale_date) || sale.sale_date < jktDate();
        const approval = newApproval(db, u, { kind: 'void', ref: sale.invoice_no, approver_role: oldSale ? 'owner' : 'mgr_akuntan', customer_id: sale.customer_id, customer_name: sale.customer_name, total: sale.total, debt_amount: sale.debt_amount,
          summary: `${sale.invoice_no} · ${sale.sale_date}`, payload: JSON.stringify({ reason, invoice_no: sale.invoice_no, sale_date: sale.sale_date, total: sale.total, old: oldSale }) });
        logAct(db, u, 'minta_batal', 'Minta batal faktur ' + sale.invoice_no + (oldSale ? ' (faktur lama ' + sale.sale_date + ', butuh persetujuan pemilik)' : '') + ': ' + reason, sale.invoice_no, sale.total, 'warn');
        return { request_id: approval.request_id, approval, approver_role: approval.approver_role, old_invoice: oldSale };
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
        const psum = 'Ubah harga ' + p.name + ': ' + Object.keys(changes).map(f => f + ' ' + changes[f].from + '→' + changes[f].to).join(', ');
        if (direct) {
          for (const [f, ch] of Object.entries(changes)) p[f] = ch.to;
          newApproval(db, u, Object.assign(fields, { status: 'auto', decided_by: u.name, decided_at: jktISO() }));
          logAct(db, u, 'harga', psum + (reason ? ' | ' + reason : ''), String(p.id), 0, 'warn');
          return { applied: true, product: p };
        }
        logAct(db, u, 'minta_harga', 'Minta ' + psum + (reason ? ' | ' + reason : ''), String(p.id), 0, 'info');
        const approval = newApproval(db, u, fields);
        return { applied: false, request_id: approval.request_id, approval };
      }
      case 'open_shift': {
        if (roleOf(u) !== 'kasir' && roleOf(u) !== 'manager') throw E('FORBIDDEN', 'Buka kas hanya dari akun kasir atau manajer (aplikasi Khair Kasir)');
        const ex = openShiftOf(db, u.name);
        if (ex) return { shift: Object.assign(blind(shiftSummary(db, ex), u.role), { already: true }) };
        if (data.opening_cash === undefined || data.opening_cash === '' || int(data.opening_cash) < 0) throw E('INVALID', 'opening_cash');
        const sh = { shift_id: 'SH-' + String(nextId(db, 'shift')).padStart(4, '0'), cashier: u.name, shift_date: isYmd(data.shift_date) ? data.shift_date : jktDate(), opened_at: jktISO(), closed_at: '', status: 'open', opening_cash: int(data.opening_cash), counted_cash: null, difference: null, note: String(data.note || '') };
        db.shifts.push(sh);
        const opening = sh.opening_cash;
        const last = db.shifts.filter(x => x.status === 'closed').sort((a, b) => String(b.closed_at).localeCompare(String(a.closed_at)))[0] || null;
        const lastTxt = last ? ' — kas terakhir ditutup ' + String(last.closed_at).slice(0, 16).replace('T', ' ') + ' oleh ' + strv(last.cashier) + ': dihitung Rp ' + int(last.counted_cash) + ', selisih dengan pembukaan Rp ' + (opening - int(last.counted_cash)) : '';
        // v36: a cashier's opening goes to the manager AND the accountant (either approves, first decision wins)
        const bk = newApproval(db, u, { kind: 'buka_kas', approver_role: roleOf(u) === 'manager' ? 'owner' : 'mgr_akuntan', ref: sh.shift_id, total: opening, summary: ('Buka kas ' + u.name + ': modal awal dihitung Rp ' + opening + lastTxt).slice(0, 1500), note: String(data.note || ''),
          payload: JSON.stringify({ shift_id: sh.shift_id, opening_cash: opening, last_counted: last ? int(last.counted_cash) : null, last_cashier: last ? strv(last.cashier) : '' }) });
        logAct(db, u, 'buka_kas', 'Buka kas ' + u.name + ' Rp ' + opening + lastTxt, sh.shift_id, opening, last && int(last.counted_cash) !== opening ? 'warn' : 'info');
        return { shift: blind(shiftSummary(db, sh), u.role), request_id: bk.request_id, approval: bk };
      }
      case 'cash_move': {
        const sh = openShiftOf(db, u.name); if (!sh) throw E('SHIFT_REQUIRED', 'No open shift');
        if (!['in', 'out'].includes(data.type)) throw E('INVALID', 'type');
        const amount = int(data.amount); if (amount <= 0) throw E('INVALID', 'amount');
        if (!String(data.note || '').trim()) throw E('INVALID', 'note required');
        db.cash_moves.push({ id: nextId(db, 'move'), shift_id: sh.shift_id, type: data.type, amount, note: String(data.note).trim(), user: u.name, time: jktISO() });
        logAct(db, u, 'kas', (data.type === 'in' ? 'Kas masuk' : 'Kas keluar') + ' Rp ' + amount + ': ' + String(data.note).trim().slice(0, 300), sh.shift_id, amount, 'info');
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
        logAct(db, u, 'tutup_kas', 'Tutup kas ' + sh.cashier + ': dihitung Rp ' + sh.counted_cash + ', seharusnya Rp ' + sh.expected_cash + ', selisih Rp ' + sh.difference, sh.shift_id, sh.difference, sh.difference ? 'warn' : 'info');
        return { shift: sh };
      }
      case 'save_expense': {
        const cats = ['sewa', 'gaji', 'listrik_air', 'transport', 'iklan', 'kemasan', 'perawatan', 'lain'];
        if (!cats.includes(data.category)) throw E('INVALID', 'category');
        const amount = int(data.amount);
        if (amount <= 0) throw E('INVALID', 'amount must be > 0');
        // v36 (as the server): optional item lines whose sum = the amount; with an invoice photo, compared line by line
        const xl = expenseLinesIn(data.lines);
        if (xl.error) throw E('INVALID', xl.error);
        const lines = xl.lines, lsum = sum(lines, l => l.total);
        if (lines.length && Math.abs(lsum - amount) > 0.5) throw E('INVALID', 'Total rincian Rp ' + lsum + ' tidak sama dengan jumlah Rp ' + amount);
        const esh = openShiftOf(db, u.name);
        const paid_from = data.paid_from === 'lain' || data.paid_from === 'kas' ? data.paid_from : (esh ? 'kas' : 'lain');
        if (paid_from === 'kas' && !esh) throw E('SHIFT_REQUIRED', 'paid_from kas needs an open shift');
        const photoId = strv(data.photo_id), reason = strv(data.mismatch_reason).slice(0, 300);
        let cmp = null, photoNote = '';
        if (photoId) {
          const ph = db.photos.find(x => x.photo_id === photoId);
          if (!ph || ph.kind !== 'biaya') throw E('INVALID', 'Foto nota pengeluaran tidak ditemukan');
          cmp = expenseCompare(lines, amount, photoEx(ph));
          const pamt = cmp.invoice.total;
          if (cmp.status === 'selisih') {
            if (!reason) throw E('MISMATCH', 'Tidak sama dengan nota: ' + expenseDiffText(cmp.diffs), { photo_amount: pamt, check: cmp });
            photoNote = ' [nota: selisih ' + (pamt !== null && pamt !== amount ? 'input Rp ' + amount + ' / nota Rp ' + pamt : expenseDiffText(cmp.diffs).slice(0, 120)) + ' — alasan: ' + reason + ']';
          } else photoNote = cmp.status === 'cocok' ? ' [nota: cocok Rp ' + pamt + ']' : ' [nota: perlu cek]';
        }
        const expense = { id: nextId(db, 'expense'), expense_date: isYmd(data.expense_date) ? data.expense_date : jktDate(), category: data.category, amount, note: (String(data.note || '') + photoNote).slice(0, 500), user: u.name, photo_id: photoId, paid_from, shift_id: paid_from === 'kas' ? esh.shift_id : '',
          lines: lines.length ? JSON.stringify(lines) : '', check_status: cmp ? cmp.status : '', request_id: '', checked_by: '' };
        let ap = null;
        if (cmp && cmp.status !== 'cocok' && !owner) {
          ap = newApproval(db, u, { kind: 'expense_check', approver_role: u.role === 'kasir' ? 'mgr_akuntan' : 'owner', ref: 'EX' + randId(6), total: amount, note: reason,
            summary: ((cmp.status === 'selisih' ? 'Selisih nota pengeluaran ' : 'Cek manual nota pengeluaran ') + expense.category + ' Rp ' + amount + (cmp.diffs.length ? ': ' + expenseDiffText(cmp.diffs) : '') + (reason ? ' | alasan: ' + reason : '')).slice(0, 1500),
            payload: JSON.stringify({ status: cmp.status, category: expense.category, amount, note: strv(data.note).slice(0, 300), paid_from, expense_date: expense.expense_date, lines, rows: cmp.rows, diffs: cmp.diffs, invoice: cmp.invoice, reason, photo_id: photoId, by: u.name }) });
          expense.request_id = ap.request_id;
        }
        db.expenses.push(expense);
        logAct(db, u, 'biaya', 'Pengeluaran ' + expense.category + ' Rp ' + amount + (expense.note ? ': ' + expense.note : '') + ' (' + paid_from + ')' + (lines.length ? ' — ' + lines.length + ' baris' : ''), expense.request_id, amount, cmp && cmp.status === 'selisih' ? 'warn' : 'info');
        const res = { expense };
        if (cmp) res.check = cmp;
        if (ap) { res.check_request_id = ap.request_id; res.approval = ap; }
        return res;
      }
      case 'save_product': {
        // v36 (owner 2026-10-11): the cashier may ADD a product while receiving goods (from_goods_in), never edit one
        const fromGoodsIn = data.from_goods_in === true && !data.id;
        if (!owner) {
          if (u.role !== 'manager' && u.role !== 'akuntan' && !(u.role === 'kasir' && fromGoodsIn)) throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
          if (data.id) throw E('FORBIDDEN', 'Hanya pemilik yang boleh mengubah produk yang sudah ada');
        }
        const name = safeName(data.name, 80);
        if (!name) throw E('INVALID', strv(data.name) ? 'Nama produk hanya boleh huruf, angka dan . , \' & ( ) / % + # -' : 'Nama produk wajib');
        // v36 (owner: "بضاعة جديدة في فاتورة المزود ← يسأل الحجم والوزن والفئة"): from a supplier invoice, category + size/weight are required
        // v63: a packaging material (sticker, jar …): no selling price, no size — the packs it is used for instead (as on the server)
        const RK = window.KRepackMock, existing = data.id ? prodById(data.id) : null;
        const material = data.material === true || (data.material === undefined && (RK.isMaterial({ category: data.category }) || (!!existing && RK.isMaterial(existing) && data.category === undefined)));
        const useFor = material && data.use_for !== undefined ? RK.useForIn(db, data.use_for) : null;
        if (useFor && useFor.error) throw E('INVALID', useFor.error);
        if (material && fromGoodsIn && !(useFor && useFor.list.length)) throw E('INVALID', 'Bahan kemasan: pilih kemasan yang memakainya');
        if (material) Object.assign(data, { category: RK.MATERIAL_CAT, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0, loose: false });
        if (fromGoodsIn) {
          if (!material && !strv(data.category)) throw E('INVALID', 'Kategori wajib untuk produk baru');
          if (!material && !strv(data.size) && !strv(data.weight)) throw E('INVALID', 'Ukuran atau berat wajib untuk produk baru');
          if (!material && u.role === 'kasir' && !(int(data.retail_price) > 0)) throw E('INVALID', 'Harga jual wajib untuk produk baru');
          if (db.products.some(p => strv(p.name).toLowerCase() === name.toLowerCase())) throw E('INVALID', 'Produk dengan nama ini sudah ada — pilih dari daftar');
        }
        const sku = String(data.sku || '').trim();
        if (sku && !/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw E('INVALID', 'SKU / barcode hanya boleh huruf, angka, titik, garis');
        if (strv(data.category) && !safeName(data.category, 40)) throw E('INVALID', 'Kategori hanya boleh huruf dan angka');
        if (strv(data.unit) && !/^[\p{L}\p{N} .\/-]{1,15}$/u.test(strv(data.unit))) throw E('INVALID', 'Satuan tidak valid');
        if (strv(data.supplier) && !safeName(data.supplier, 80)) throw E('INVALID', 'Nama pemasok hanya boleh huruf dan angka');
        if (sku && db.products.some(p => p.sku === sku && p.id !== Number(data.id))) throw E('INVALID', 'SKU already used');
        if (data.id && !prodById(data.id)) throw E('NOT_FOUND', 'product');
        // repacked in the shop: made from a bulk product (repack_from), repack_qty of the bulk unit per piece
        const rp = { supplier: strv(data.supplier).slice(0, 80), repack_from: 0, repack_qty: 0 };
        if (num(data.repack_from) > 0) {
          const bulk = prodById(data.repack_from);
          if (!bulk || (data.id && bulk.id === Number(data.id))) throw E('INVALID', 'Produk curah (asal kemasan) tidak valid');
          if (!(num(data.repack_qty) > 0)) throw E('INVALID', 'Isi per kemasan wajib diisi');
          rp.repack_from = bulk.id; rp.repack_qty = roundQty(data.repack_qty);
        }
        if (data.id) {
          const p = prodById(data.id);
          const { stock, ...rest } = data;
          const before = { retail_price: p.retail_price, wholesale_price: p.wholesale_price, cost_price: p.cost_price };
          Object.assign(p, productFields(rest, {}), { name }, rp);
          if (useFor) p.use_for = useFor.json; // v63
          const changes = {}; for (const f in before) if (int(before[f]) !== int(p[f])) changes[f] = { from: int(before[f]), to: int(p[f]) };
          if (Object.keys(changes).length) newApproval(db, u, { kind: 'price', ref: p.id, summary: p.name, status: 'auto', decided_by: u.name, decided_at: jktISO(), payload: JSON.stringify({ changes, product_name: p.name, reason: 'save_product' }) });
          const ch = Object.keys(changes);
          logAct(db, u, ch.length ? 'harga' : 'produk', 'Ubah produk ' + name + (ch.length ? ': ' + ch.map(f => f + ' ' + changes[f].from + '→' + changes[f].to).join(', ') : ''), String(p.id), 0, ch.length ? 'warn' : 'info');
          return { product: p };
        }
        const p = Object.assign(productFields(data, blankProduct()), { id: nextId(db, 'product'), name, stock: roundQty(data.stock || 0) }, rp);
        if (useFor) p.use_for = useFor.json; // v63
        let rap = null;
        if (u.role === 'kasir') { // v36: a cashier's new product is flagged "new — check" for the manager / accountant
          p.stock = 0;
          rap = newApproval(db, u, { kind: 'product_new', approver_role: 'mgr_akuntan', ref: sku || name.slice(0, 40), total: p.retail_price,
            summary: ('Produk baru dari kasir ' + u.name + ': ' + name + ' (' + p.category + (p.size ? ', ' + p.size : '') + (p.weight ? ', ' + p.weight : '') + ', ' + p.unit + ') eceran Rp ' + p.retail_price).slice(0, 1500),
            payload: JSON.stringify({ product_name: name, category: p.category, size: p.size, weight: p.weight, unit: p.unit, sku, supplier: p.supplier, retail_price: p.retail_price, wholesale_price: p.wholesale_price, wholesale_min_qty: p.wholesale_min_qty, cost_price: p.cost_price, by: u.name }) });
          p.review = rap.request_id;
        }
        db.products.push(p);
        logAct(db, u, 'produk_baru', 'Produk baru: ' + name + ' (stok ' + fmtN(p.stock) + ' ' + p.unit + ')' + (rap ? ' — dibuat kasir saat barang masuk, menunggu cek' : ''), sku, 0, rap ? 'warn' : 'info');
        return Object.assign({ product: p }, rap ? { review_request_id: rap.request_id } : {});
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
          if (p && data.only_new === true) { skipped++; continue; } // v44: existing products stay exactly as they are (as on the server)
          if (p) {
            Object.assign(p, productFields(clean, {}));
            if (r.stock !== undefined && r.stock !== '') {
              // v39: nothing in the warehouse → the imported quantity is all on the shelf (as on the server)
              if (shopOf(p) >= num(p.stock)) { db._shopSet = db._shopSet || {}; db._shopSet[p.id] = Math.max(0, roundQty(r.stock)); }
              p.stock = roundQty(r.stock);
            }
            updated++;
          } else if (name) {
            db.products.push(Object.assign(productFields(clean, blankProduct()), { id: nextId(db, 'product'), name, stock: roundQty(r.stock || 0) }));
            created++;
          } else skipped++;
        }
        logAct(db, u, 'impor', 'Impor produk: ' + created + ' baru, ' + updated + ' diubah' + (skipped ? ', ' + skipped + ' dilewati (sudah ada)' : ''), '', 0, 'info');
        return { created, updated, skipped };
      }
      case 'save_supplier': { // v56 (as backend/process.js): the accountant / manager adds a supplier to the directory, or edits one (the name stays)
        if (!['owner', 'manager', 'akuntan'].includes(u.role)) throw E('FORBIDDEN', 'Hanya akuntan / manajer / pemilik');
        const x = data.supplier && typeof data.supplier === 'object' ? data.supplier : {};
        const name = safeName(x.name, 60);
        if (!name) throw E('INVALID', 'Nama pemasok wajib (huruf / angka, maks. 60)');
        const field = (v, max) => strv(v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
        const co = field(x.company, 80), pl = field(x.place, 120), tr = field(x.trade, 60), gd = field(x.goods, 400), nt = field(x.note, 300);
        const ph = strv(x.phone) ? normPhone(x.phone) : '';
        if (strv(x.phone) && !ph) throw E('INVALID', 'Nomor telepon pemasok tidak valid');
        if (!gd) throw E('INVALID', 'Isi barang yang dijual pemasok ini');
        const list = Array.isArray(db.settings.supplier_dir) ? db.settings.supplier_dir : [], at = list.findIndex(y => strv(y.n).toLowerCase() === name.toLowerCase());
        const now = new Date().toISOString(), who = (u.role === 'manager' ? 'manajer ' : u.role === 'akuntan' ? 'akuntan ' : 'pemilik ') + u.name;
        let entry, txt;
        if (data.edit) {
          if (at < 0) throw E('NOT_FOUND', 'Pemasok ' + name + ' tidak ada di daftar');
          const b = list[at], ch = [];
          [['co', co, 'perusahaan'], ['pl', pl, 'tempat'], ['tr', tr, 'usaha'], ['gd', gd, 'barang'], ['ph', ph, 'telepon'], ['nt', nt, 'catatan']].forEach(f => { if (strv(b[f[0]]) !== f[1]) ch.push(f[2] + ': ' + (f[1] || '—')); });
          if (!ch.length) return { unchanged: true, supplier: b };
          entry = Object.assign({}, b, { co, pl, tr, gd, ph, nt, ub: u.name, ua: now });
          list[at] = entry;
          txt = 'Data pemasok ' + b.n + ' diubah — ' + ch.join('; ') + ' — oleh ' + who;
        } else {
          if (at >= 0) throw E('DUPLICATE', 'Pemasok ' + list[at].n + ' sudah ada di daftar');
          if (list.length >= 500) throw E('INVALID', 'Paling banyak 500 pemasok');
          entry = { n: name, co, pl, tr, gd, ph, nt, by: u.name, at: now };
          list.push(entry);
          txt = 'Pemasok baru: ' + name + [co, pl, tr].filter(Boolean).map(v => ' · ' + v).join('') + ' — menjual: ' + gd + ' — oleh ' + who;
        }
        db.settings.supplier_dir = list;
        logAct(db, u, 'pemasok', txt.slice(0, 1000), name, 0, 'info');
        notifyR(db, u, ['owner', 'manager', 'akuntan'].filter(r => r !== u.role), txt, 'info');
        return { supplier: entry };
      }
      case 'set_loose': { // v52 (as backend/process.js): the owner / manager marks a product as shown loose, sold by weight
        if (!['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Hanya pemilik / manajer');
        const lp = db.products.find(x => x.id === Number(data.product_id));
        if (!lp) throw E('NOT_FOUND', 'Produk tidak ditemukan');
        const on = data.loose === true;
        if (on && !['kg', 'kilo', 'g', 'gr', 'gram', 'ons'].includes(String(lp.unit || '').trim().toLowerCase())) throw E('INVALID', lp.name + ': barang curah dijual per kg / gram / ons — satuannya sekarang ' + (lp.unit || 'pcs'));
        if ((lp.loose === true) === on) return { unchanged: true, product: lp };
        lp.loose = on;
        logAct(db, u, 'atur_curah', (on ? 'Dijual curah (timbang di kasir): ' : 'Tidak lagi dijual curah: ') + lp.name + ' — oleh ' + (u.role === 'manager' ? 'manajer ' : 'pemilik ') + u.name, String(lp.id), 0, 'info');
        return { product: lp };
      }
      case 'set_repack': { // v43 + v48: the manager (or owner) chooses the pack product (or makes a NEW one), its bulk source, the size and the pack's materials; the others are told (as on the server)
        if (!owner && u.role !== 'manager') throw E('FORBIDDEN', 'Hanya pemilik / manajer');
        const nw = data.new_product && typeof data.new_product === 'object' ? data.new_product : null;
        const pk = nw ? null : prodById(data.product_id); if (!nw && !pk) throw E('NOT_FOUND', 'Produk tidak ditemukan');
        const bid = num(data.repack_from) > 0 ? num(data.repack_from) : 0, bulk = bid ? prodById(bid) : null;
        if (bid && (!bulk || (pk && bulk.id === pk.id))) throw E('INVALID', 'Produk curah (asal kemasan) tidak valid');
        if (nw && !bulk) throw E('INVALID', 'Pilih produk curah untuk kemasan baru');
        if (pk && bulk && num(bulk.repack_from) === num(pk.id)) throw E('INVALID', 'Produk curah itu sendiri dibuat dari produk ini');
        if (bulk && !(num(data.repack_qty) > 0)) throw E('INVALID', 'Isi per kemasan wajib diisi');
        const qty = bulk ? roundQty(data.repack_qty) : 0;
        let cIn = null;
        if (data.materials !== undefined) { cIn = window.KRepackMock.matsIn(db, data.materials); if (cIn.error) throw E('INVALID', cIn.error); } // v50: chosen from the list
        else if (data.costs !== undefined) {
          if (!Array.isArray(data.costs)) throw E('INVALID', 'Daftar bahan kemasan tidak valid');
          const list = [];
          for (const x0 of data.costs) {
            const x = x0 || {}, raw = strv(x.name), c = Number(x.cost === '' || x.cost == null ? 0 : x.cost);
            if (!raw && !c) continue;
            const nm = safeName(raw, 40); if (!nm) throw E('INVALID', raw ? 'Nama bahan kemasan hanya boleh huruf dan angka (maks. 40)' : 'Nama bahan kemasan wajib diisi');
            if (!Number.isFinite(c) || c < 0 || c > 10000000) throw E('INVALID', 'Biaya ' + nm + ' tidak valid');
            list.push({ n: nm, c: Math.round(c) });
          }
          if (list.length > 12) throw E('INVALID', 'Paling banyak 12 bahan kemasan');
          cIn = { json: list.length ? JSON.stringify(list) : '', list };
        }
        const rpT = v => 'Rp ' + String(Math.round(Math.abs(num(v)))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        const costsText = window.KRepackMock.costsText;
        const desc = (b, q, unit) => b ? `${b.name}, ${fmtN(q)} ${b.unit || ''} per ${unit || 'pcs'}` : 'tidak dikemas ulang';
        const who = ` — oleh ${u.role === 'manager' ? 'manajer' : 'pemilik'} ${u.name}`;
        const tell = txt => { db.activity = db.activity || []; db.activity.push({ id: nextId(db, 'activity'), act_id: 'AC' + Math.random().toString(36).slice(2, 10).toUpperCase(), at: new Date().toISOString(), act_date: jktDate(), user: u.name, role: u.role, kind: 'notifikasi', summary: txt, ref: ['owner', 'manager', 'akuntan'].filter(r => r !== u.role).join(','), amount: 0, level: 'info' }); };
        if (nw) {
          const name = safeName(nw.name, 80);
          if (!name) throw E('INVALID', strv(nw.name) ? 'Nama kemasan hanya boleh huruf, angka dan . , \' & ( ) / % + # -' : 'Nama kemasan baru wajib diisi');
          if (db.products.some(x => strv(x.name).toLowerCase() === name.toLowerCase())) throw E('INVALID', 'Produk dengan nama ini sudah ada — pilih dari daftar');
          const sku = strv(nw.sku);
          if (sku && !/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw E('INVALID', 'SKU / barcode hanya boleh huruf, angka, titik, garis');
          if (sku && db.products.some(x => strv(x.sku) === sku)) throw E('INVALID', 'SKU/barcode sudah dipakai');
          const unit = strv(nw.unit) || 'pcs';
          if (!/^[\p{L}\p{N} .\/-]{1,15}$/u.test(unit)) throw E('INVALID', 'Satuan tidak valid');
          const price = int(nw.retail_price); if (!(price > 0)) throw E('INVALID', 'Harga jual kemasan baru wajib diisi');
          const np = { id: nextId(db, 'product'), sku, name, category: strv(bulk.category), unit, cost_price: 0, retail_price: price, wholesale_price: 0, wholesale_min_qty: 0, stock: 0, min_stock: 0, active: true, notes: '', supplier: '', size: strv(nw.size).slice(0, 40), weight: '', exp_date: '', exp_none: bulk.exp_none === true, repack_from: bulk.id, repack_qty: qty, repack_costs: cIn ? cIn.json : '' };
          db.products.push(np);
          const txt = `Kemasan baru dibuat: ${name} (${unit}${sku ? ', barcode ' + sku : ''}, harga jual ${rpT(price)}) dibuat dari ${desc(bulk, qty, unit)}; ${costsText(cIn ? cIn.list : [], unit)}${who}`;
          logAct(db, u, 'atur_kemas', txt, sku || name.slice(0, 40), 0, 'info'); tell(txt);
          return { created: true, product: np };
        }
        const was = num(pk.repack_from) > 0 ? prodById(pk.repack_from) : null, wasQty = num(pk.repack_qty);
        const wasCosts = strv(pk.repack_costs), costs = !bulk ? '' : (cIn ? cIn.json : wasCosts);
        if ((was ? was.id : 0) === (bulk ? bulk.id : 0) && wasQty === qty && wasCosts === costs) return { unchanged: true, product: pk };
        const sameSetup = (was ? was.id : 0) === (bulk ? bulk.id : 0) && wasQty === qty;
        let txt = bulk ? (sameSetup ? `Biaya kemasan diubah: ${pk.name}` : `Kemas ulang diatur: ${pk.name} dibuat dari ${desc(bulk, qty, pk.unit)}` + (was ? ` (sebelumnya ${desc(was, wasQty, pk.unit)})` : ''))
          : `Kemas ulang dihapus: ${pk.name} tidak lagi dibuat dari ${was ? was.name : '—'}`;
        if (bulk && costs !== wasCosts) txt += '; ' + costsText(cIn ? cIn.list : [], pk.unit) + (wasCosts ? ` (sebelumnya ${costsText(repackCostsOf(db, pk).map(x => ({ n: x.name, q: x.qty, c: x.cost })), pk.unit)})` : '');
        txt += who;
        pk.repack_from = bulk ? bulk.id : 0; pk.repack_qty = qty; pk.repack_costs = costs;
        logAct(db, u, 'atur_kemas', txt, String(pk.id), 0, 'info'); tell(txt);
        return { product: pk };
      }
      case 'stock_adjust': {
        if (!owner && u.role !== 'manager') throw E('FORBIDDEN', 'Owner / manager only'); // v40: the manager too; the owner is told
        const p = prodById(data.product_id); if (!p) throw E('NOT_FOUND', 'product');
        if (!String(data.reason || '').trim()) throw E('INVALID', 'reason required');
        if (!Number.isFinite(Number(data.new_stock))) throw E('INVALID', 'new_stock');
        const diff = roundQty(roundQty(data.new_stock) - num(p.stock));
        if (!owner) ownerNotice(db, u, 'Stok ' + p.name + ' diubah oleh manajer ' + u.name + ': ' + fmtN(p.stock) + '→' + fmtN(roundQty(data.new_stock)) + (diff ? ' (nilai modal ' + rpDots(diff * Number(p.cost_price || 0)) + ')' : '') + ' | ' + String(data.reason), diff ? 'warn' : 'info');
        db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: ADJUST_SUPPLIER, product_id: p.id, name: p.name, qty: diff, cost_price: p.cost_price, total: 0, note: String(data.reason), user: u.name });
        logAct(db, u, 'stok', 'Penyesuaian stok ' + p.name + ': ' + fmtN(p.stock) + '→' + fmtN(roundQty(data.new_stock)) + ' | ' + String(data.reason), String(p.id), 0, 'warn');
        p.stock = roundQty(data.new_stock);
        return { product: p };
      }
      case 'save_customer': {
        // name is optional with a phone ("Pelanggan 1234"); without an id, the same normalised phone updates that customer
        const phone = String(data.phone || '').trim(), pn = normPhone(phone);
        if (data.id && !custById(data.id)) throw E('NOT_FOUND', 'Pelanggan tidak ditemukan');
        if (strv(data.name) && !safeName(data.name, 80)) throw E('INVALID', 'Nama pelanggan hanya boleh huruf, angka dan . , \' & ( ) / -');
        if (strv(data.phone) && !/^[0-9+ ().-]{3,20}$/.test(strv(data.phone))) throw E('INVALID', 'Nomor HP hanya boleh angka (contoh 0812xxxxxxx)');
        if (strv(data.address).length > 200 || strv(data.notes).length > 300) throw E('INVALID', 'Alamat / catatan terlalu panjang');
        const name = safeName(data.name, 80);
        if (!name && !pn && !data.id) throw E('INVALID', 'Nama pelanggan wajib');
        const defName = pn ? 'Pelanggan ' + pn.slice(-4) : '';
        const optin = data.wa_optin === undefined || data.wa_optin === null ? undefined : (data.wa_optin === true || data.wa_optin === 'true');
        const source = String(data.source || '').trim().slice(0, 20);
        const fields = { name: name || defName, phone, type: data.type === 'grosir' ? 'grosir' : 'eceran', address: String(data.address || ''), notes: String(data.notes || '') };
        // v16: e-mail and membership; any user may register a member, only owner / manager may end a membership
        const memberFields = ex => {
          const email = data.email !== undefined ? strv(data.email).toLowerCase() : (ex ? strv(ex.email) : '');
          if (email && !isEmail(email)) throw E('INVALID', 'Alamat e-mail tidak valid');
          const was = !!(ex && ex.member === true), member = typeof data.member === 'boolean' ? data.member : was;
          if (was && !member && !isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik / manajer yang bisa menghapus member');
          return { was, f: { email, member, member_no: ex && strv(ex.member_no) ? strv(ex.member_no) : (member ? 'M' + randId(6) : ''),
            member_since: member ? (ex && strv(ex.member_since) && was ? strv(ex.member_since) : jktDate()) : (ex ? strv(ex.member_since) : ''),
            visits: ex ? Math.max(0, Math.round(num(ex.visits))) : 0, receipts_sent: ex ? Math.max(0, Math.round(num(ex.receipts_sent))) : 0, last_visit: ex ? strv(ex.last_visit) : '' } };
        };
        const memLog = (c, was) => {
          if (c.member && !was) logAct(db, u, 'member_baru', 'Member baru: ' + c.name + ' (' + c.member_no + ')' + (c.phone ? ' ' + c.phone : '') + (c.email ? ' ' + c.email : ''), c.member_no, 0, 'info');
          if (!c.member && was) logAct(db, u, 'member_berhenti', 'Member dihapus: ' + c.name + ' (' + c.member_no + ')', c.member_no, 0, 'warn');
          return { customer: c, member: memberInfo(db, c) };
        };
        if (data.id) {
          const c = custById(data.id); if (!c) throw E('NOT_FOUND', 'customer');
          const m = memberFields(c);
          // fields the app did not send keep their stored value (a partial edit, e.g. only "member", must not wipe the rest)
          ['phone', 'type', 'address', 'notes'].forEach(k => { if (data[k] === undefined) delete fields[k]; });
          Object.assign(c, fields, { name: name || c.name || defName }, m.f);
          if (optin !== undefined) c.wa_optin = optin;
          if (source) c.source = source;
          return memLog(c, m.was);
        }
        const same = pn ? db.customers.find(c => normPhone(c.phone) === pn) : null;
        if (same) {
          const m = memberFields(same);
          if (name && name !== defName) same.name = name;
          if (optin) same.wa_optin = true;
          if (source && !same.source) same.source = source;
          Object.assign(same, m.f);
          return Object.assign(memLog(same, m.was), { existed: true });
        }
        const m = memberFields(null);
        const c = Object.assign({ id: nextId(db, 'customer') }, fields, { debt_balance: 0, wa_optin: !!optin, source }, m.f);
        db.customers.push(c);
        return memLog(c, false);
      }
      case 'receive_payment': {
        const c = custById(data.customer_id); if (!c) throw E('NOT_FOUND', 'Pelanggan tidak ditemukan');
        const amount = int(data.amount);
        if (!(amount > 0)) throw E('INVALID', 'Jumlah pembayaran tidak valid');
        if (amount > int(c.debt_balance)) throw E('INVALID', 'Pembayaran melebihi hutang');
        const pays = partyPays(db, 'customer', c.id);
        if (dupRef(pays, data.transfer_ref)) throw E('INVALID', 'Nomor transfer ini sudah pernah dipakai: ' + strv(data.transfer_ref));
        const sc = slipCheck(db, data, amount);
        const docs = partyDocs(db, 'customer', c.id, '');
        const chk = checkAlloc(data.alloc, docs, amount);
        const psh = openShiftOf(db, u.name);
        const method = ['tunai', 'transfer', 'qris'].includes(data.method) ? data.method : 'tunai';
        const payment = { id: nextId(db, 'payment'), pay_id: 'PY' + randId(7), pay_date: isYmd(data.pay_date) ? data.pay_date : jktDate(), pay_time: new Date().toISOString(),
          direction: 'in', party_type: 'customer', customer_id: c.id, customer_name: c.name, supplier: '', amount, method,
          account_id: payAccount(db, data, data.method, sc && sc.ex, 'in'), slip_date: sc && sc.ex && sc.ex.date ? strv(sc.ex.date) : '',
          bank: strv(data.bank).slice(0, 60), transfer_ref: strv(data.transfer_ref).slice(0, 80), proof_photo_id: strv(data.photo_id).slice(0, 40),
          alloc: JSON.stringify(chk.alloc), match_status: allocStatus(amount, chk, docs),
          note: (strv(data.note) + (strv(data.mismatch_reason) ? ' | beda dengan bukti: ' + strv(data.mismatch_reason) : '')).slice(0, 500), cashier: u.name, shift_id: psh ? psh.shift_id : '' };
        db.payments.push(payment);
        c.debt_balance = Math.max(0, int(c.debt_balance) - amount);
        if (method === 'transfer') addTransferConfirm(db, u, 'pembayaran', payment.pay_id, amount, c.name, payment.bank, payment.transfer_ref);
        const dateOff = payment.slip_date && payment.slip_date !== payment.pay_date;
        logAct(db, u, 'bayar_masuk', 'Pembayaran ' + c.name + ' Rp ' + amount + ' (' + method + (payment.bank ? ' ' + payment.bank : '') + (payment.transfer_ref ? ', ref ' + payment.transfer_ref : '') + ')' +
          (chk.alloc.length ? ' untuk ' + chk.alloc.map(a => a.ref + ' Rp ' + a.amount).join(', ') : ' — belum dialokasi') + (strv(data.mismatch_reason) ? ' | beda dengan bukti: ' + strv(data.mismatch_reason) : '') +
          (dateOff ? ' | tanggal bukti ' + payment.slip_date + ' ≠ dicatat ' + payment.pay_date : ''), payment.pay_id, amount, strv(data.mismatch_reason) || dateOff || payment.match_status === 'belum_dialokasi' ? 'warn' : 'info');
        return { payment: payOut(payment), customer: c };
      }
      case 'confirm_purchase': { // v65 (owner 2026-10-20: «المدير و المحاسب يصادق عليها و يكتب هل تم الدفع … او تاريخ الدفع المتفق عليه»)
        if (!(isAppr(u) || u.role === 'akuntan')) throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        const no = strv(data.purchase_no), lines = db.purchases.filter(r => strv(r.purchase_no) === no);
        if (!no || !lines.length) throw E('NOT_FOUND', 'Nota barang masuk tidak ditemukan');
        const done0 = lines.find(r => strv(r.check_status));
        if (done0) throw E('INVALID', 'Nota ' + no + ' sudah dikonfirmasi oleh ' + strv(done0.checked_by));
        const sup = strv(lines[0].supplier);
        if (INTERNAL_SUP.includes(sup)) throw E('INVALID', 'Bukan nota pemasok');
        if (strv(data.supplier) !== sup) throw E('INVALID', 'Pemasok tidak cocok dengan nota ' + no);
        const kind = data.pay === 'tempo' ? 'tempo' : data.pay === 'lunas' ? 'lunas' : '';
        if (!kind) throw E('INVALID', 'Pilih: sudah dibayar, atau bayar nanti (tempo)');
        const today = jktDate(), nowIso = new Date().toISOString(), total = lines.reduce((a, r) => a + int(r.total), 0);
        let due = '', method = '', pay = null, fromKas = false, before = false;
        if (kind === 'tempo') {
          due = strv(data.due_date);
          const maxDue = new Date(Date.parse(today) + 180 * 86400000).toISOString().slice(0, 10);
          if (!isYmd(due) || due < today || due > maxDue) throw E('INVALID', 'Tanggal bayar yang disepakati: hari ini sampai 180 hari lagi');
        } else {
          method = ['tunai', 'transfer', 'qris'].includes(data.method) ? data.method : '';
          if (!method) throw E('INVALID', 'Pilih cara bayar: tunai, transfer atau QRIS');
          const myShift = openShiftOf(db, u.name);
          before = data.paid_before === true; // v66: paid and recorded earlier (a note from before the confirmation existed)
          fromKas = !before && data.paid_from === 'kas' && method === 'tunai';
          if (fromKas && !myShift) throw E('SHIFT_REQUIRED', 'Buka kasir (shift) dulu untuk bayar dari kas');
          if (!before && dupRef(partyPays(db, 'supplier', sup), data.transfer_ref)) throw E('INVALID', 'Nomor transfer ini sudah pernah dipakai: ' + strv(data.transfer_ref));
          const docs = partyDocs(db, 'supplier', sup, ''), doc = docs[no], amount = before ? 0 : doc ? doc.remaining : total;
          if (amount > 0) {
            const sc = slipCheck(db, data, amount);
            pay = { id: nextId(db, 'payment'), pay_id: 'PY' + randId(7), pay_date: today, pay_time: nowIso, direction: 'out', party_type: 'supplier', customer_id: 0, customer_name: '', supplier: sup, amount, method,
              account_id: payAccount(db, data, method, sc && sc.ex, 'out'), slip_date: sc && sc.ex && sc.ex.date ? strv(sc.ex.date) : '',
              bank: strv(data.bank).slice(0, 60), transfer_ref: strv(data.transfer_ref).slice(0, 80), proof_photo_id: strv(data.photo_id).slice(0, 40),
              alloc: JSON.stringify(doc ? [{ ref: no, amount }] : []), match_status: doc ? 'lunas' : 'belum_dialokasi',
              note: ('Barang masuk ' + no + ' dikonfirmasi ' + u.name + (fromKas ? ' [dari kas]' : '') + (strv(data.note) ? ' | ' + strv(data.note) : '')).slice(0, 500), cashier: u.name,
              paid_from: fromKas ? 'kas' : 'lain', shift_id: fromKas ? myShift.shift_id : '' };
            db.payments.push(pay);
          }
        }
        lines.forEach(r => Object.assign(r, { check_status: 'dikonfirmasi', checked_by: u.name, checked_at: nowIso, pay_status: kind, pay_method: method, due_date: due, paid_at: kind === 'lunas' ? today : '' }));
        const who = (owner ? 'pemilik ' : u.role === 'manager' ? 'manajer ' : 'akuntan ') + u.name;
        const txt = 'Barang masuk ' + no + ' dari ' + sup + ' (' + strv(lines[0].purchase_date) + ', diterima ' + strv(lines[0].user) + ', ' + rpTxt(total) + ') dikonfirmasi ' + who + ': ' +
          (kind === 'tempo' ? 'BAYAR NANTI — jatuh tempo ' + due + ' (hutang ke pemasok)' : 'sudah dibayar ' + method + (fromKas ? ' dari kas' : '') + (pay ? ' ' + rpTxt(pay.amount) + (pay.bank ? ' ' + pay.bank : '') + (pay.transfer_ref ? ' ref ' + pay.transfer_ref : '') : before ? ' (dibayar sebelumnya, tanpa pembayaran baru)' : ' (sudah lunas sebelumnya)')) +
          (strv(data.note) ? ' | ' + strv(data.note).slice(0, 200) : '');
        logAct(db, u, 'konfirmasi_masuk', txt, no, total, 'info');
        notifyR(db, u, ['owner', 'manager', 'akuntan'].filter(x => x !== roleOf(u)), txt, kind === 'tempo' ? 'warn' : 'info');
        return { purchase_no: no, check: { check_status: 'dikonfirmasi', checked_by: u.name, checked_at: nowIso, pay_status: kind, pay_method: method, due_date: due }, payment: pay ? payOut(pay) : null };
      }
      case 'pay_supplier': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const sup = safeName(data.supplier, 80);
        if (!sup) throw E('INVALID', 'Nama pemasok wajib (huruf dan angka saja)');
        const amount = int(data.amount);
        if (!(amount > 0)) throw E('INVALID', 'Jumlah pembayaran tidak valid');
        // v23 owner monitoring: the manager may only record a supplier payment the owner authorized in a pay plan.
        let planAp = null, planIdx = -1, planItems = null;
        if (u.role === 'manager') {
          planAp = db.approvals.find(x => x.request_id === strv(data.plan_request_id)) || null;
          planIdx = num(data.item_index);
          let ppl = {}; try { ppl = JSON.parse(planAp ? planAp.payload : '{}'); } catch (e) { ppl = {}; }
          planItems = planAp && Array.isArray(ppl.items) ? ppl.items : null;
          const it = planItems && planIdx >= 0 && planIdx < planItems.length && planIdx === Math.floor(planIdx) ? planItems[planIdx] : null;
          if (!planAp || planAp.kind !== 'pay_plan' || planAp.status !== 'approved' || !it || it.approved !== true || it.paid === true
            || safeName(it.supplier, 80) !== sup || int(it.amount) !== amount) {
            throw E('NEEDS_OWNER', 'Pembayaran pemasok butuh persetujuan pemilik (rencana bayar)');
          }
        }
        const method = ['tunai', 'transfer', 'qris'].includes(data.method) ? data.method : 'transfer';
        const myShift = openShiftOf(db, u.name);
        const fromKas = data.paid_from === 'kas' && method === 'tunai';
        if (fromKas && !myShift) throw E('SHIFT_REQUIRED', 'Buka kasir (shift) dulu untuk bayar dari kas');
        if (dupRef(partyPays(db, 'supplier', sup), data.transfer_ref)) throw E('INVALID', 'Nomor transfer ini sudah pernah dipakai: ' + strv(data.transfer_ref));
        const sc = slipCheck(db, data, amount);
        const docs = partyDocs(db, 'supplier', sup, '');
        const chk = checkAlloc(data.alloc, docs, amount);
        const pay = { id: nextId(db, 'payment'), pay_id: 'PY' + randId(7), pay_date: isYmd(data.pay_date) ? data.pay_date : jktDate(), pay_time: new Date().toISOString(),
          direction: 'out', party_type: 'supplier', customer_id: 0, customer_name: '', supplier: sup, amount, method,
          account_id: payAccount(db, data, method, sc && sc.ex, 'out'), slip_date: sc && sc.ex && sc.ex.date ? strv(sc.ex.date) : '',
          bank: strv(data.bank).slice(0, 60), transfer_ref: strv(data.transfer_ref).slice(0, 80), proof_photo_id: strv(data.photo_id).slice(0, 40),
          alloc: JSON.stringify(chk.alloc), match_status: allocStatus(amount, chk, docs),
          note: (strv(data.note) + (fromKas ? ' [dari kas]' : '') + (strv(data.mismatch_reason) ? ' | beda dengan bukti: ' + strv(data.mismatch_reason) : '')).slice(0, 500), cashier: u.name,
          paid_from: fromKas ? 'kas' : 'lain', shift_id: fromKas ? myShift.shift_id : '' };
        db.payments.push(pay);
        markNotesPaid(db, docs, chk.alloc, pay.pay_date); // v65
        const dateOff = pay.slip_date && pay.slip_date !== pay.pay_date;
        logAct(db, u, 'bayar_keluar', 'Bayar pemasok ' + sup + ' Rp ' + amount + ' (' + method + (pay.bank ? ' ' + pay.bank : '') + (pay.transfer_ref ? ', ref ' + pay.transfer_ref : '') + (fromKas ? ', dari kas' : '') + ')' +
          (chk.alloc.length ? ' untuk ' + chk.alloc.map(a => a.ref + ' Rp ' + a.amount).join(', ') : ' — belum dialokasi') + (strv(data.mismatch_reason) ? ' | beda dengan bukti: ' + strv(data.mismatch_reason) : '') +
          (dateOff ? ' | tanggal bukti ' + pay.slip_date + ' ≠ dicatat ' + pay.pay_date : ''), pay.pay_id, amount, strv(data.mismatch_reason) || dateOff ? 'warn' : 'info');
        if (u.role === 'manager' && planAp && planItems) {
          planItems[planIdx].paid = true; planItems[planIdx].pay_id = pay.pay_id;
          const allPaid = planItems.filter(x => x.approved === true).every(x => x.paid === true);
          planAp.payload = JSON.stringify({ items: planItems }); planAp.status = allPaid ? 'done' : 'approved';
          return { payment: payOut(pay), plan: { request_id: planAp.request_id, item_index: planIdx, status: planAp.status } };
        }
        return { payment: payOut(pay) };
      }
      case 'propose_payment': {
        // v23 owner monitoring: the manager proposes a LIST of supplier bills to pay; the owner authorizes which to pay now.
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const src = Array.isArray(data.items) ? data.items : [];
        if (!src.length) throw E('INVALID', 'Tambah minimal satu tagihan pemasok');
        if (src.length > 50) throw E('INVALID', 'Terlalu banyak tagihan (maks 50)');
        const items = [];
        for (let i = 0; i < src.length; i++) {
          const it = src[i] || {};
          const sup = safeName(it.supplier, 80);
          if (!sup) throw E('INVALID', 'Nama pemasok wajib (huruf dan angka saja)');
          const amt = int(it.amount);
          if (!(amt > 0)) throw E('INVALID', 'Jumlah pembayaran tidak valid: ' + sup);
          items.push({ supplier: sup, amount: amt, priority: Math.round(num(it.priority)), note: strv(it.note).slice(0, 200), approved: false, paid: false, pay_id: '' });
        }
        const total = sum(items, it => it.amount);
        const summary = items.map(it => it.supplier + ' Rp ' + it.amount).join(', ').slice(0, 1500);
        const approval = newApproval(db, u, { kind: 'pay_plan', approver_role: 'owner', total, summary, payload: JSON.stringify({ items }) });
        logAct(db, u, 'minta_bayar', summary, approval.request_id, total, 'warn');
        return { applied: false, request_id: approval.request_id, approval };
      }
      case 'list_pay_plans': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const plans = db.approvals.filter(a => {
          if (a.kind !== 'pay_plan' || a.status !== 'approved') return false;
          if (u.role === 'manager' && strv(a.cashier).toLowerCase() !== u.name.toLowerCase()) return false;
          return true;
        }).map(a => {
          let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
          const items = (Array.isArray(pl.items) ? pl.items : []).map((it, i) => ({ index: i, supplier: strv(it.supplier), amount: int(it.amount), priority: num(it.priority), note: strv(it.note), approved: it.approved === true, paid: it.paid === true, pay_id: strv(it.pay_id) }));
          return { request_id: a.request_id, created_at: strv(a.created_at), by: strv(a.cashier), summary: strv(a.summary), total: int(a.total), status: a.status, items };
        }).filter(p => p.items.some(it => it.approved && !it.paid));
        return { pay_plans: plans };
      }
      case 'request_transfer': {
        // Owner-approved bank transfers: the manager raises a transfer request for the owner to approve (money leaves via BNI).
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const payee = safeName(data.payee, 80);
        if (!payee) throw E('INVALID', 'Nama penerima wajib (huruf dan angka saja)');
        const amount = int(data.amount);
        if (!(amount > 0)) throw E('INVALID', 'Jumlah transfer tidak valid');
        const reason = strv(data.reason).slice(0, 300);
        const account_id = strv(data.account_id);
        if (account_id && !bankAccounts(db).some(x => strv(x.id) === account_id)) throw E('INVALID', 'Rekening bank tidak dikenal');
        const summary = payee + ' Rp ' + amount + (reason ? ' — ' + reason : '');
        const approval = newApproval(db, u, { kind: 'transfer', approver_role: 'owner', total: amount, summary, payload: JSON.stringify({ payee, amount, reason, account_id, paid: false, pay_id: '' }) });
        logAct(db, u, 'minta_transfer', summary, approval.request_id, amount, 'warn');
        return { applied: false, request_id: approval.request_id, approval };
      }
      case 'save_bank_accounts': { // v57 (as on the server): the store's bank accounts, kept by the manager (or the owner); one left out stays, inactive
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik / manajer');
        if (!Array.isArray(data.accounts)) throw E('INVALID', 'Daftar rekening tidak valid');
        const before = bankAccounts(db), out = [], seen = {};
        before.forEach(b => { seen['#' + strv(b.id)] = false; });
        for (const x0 of data.accounts) {
          const x = x0 || {}, bank = safeName(x.bank, 40), no = strv(x.account_no).replace(/[\s.-]/g, '');
          if (!bank && !no) continue;
          if (!bank) throw E('INVALID', 'Isi nama bank tiap rekening');
          if (!/^\d{5,20}$/.test(no)) throw E('INVALID', 'Nomor rekening ' + bank + ' harus 5–20 angka');
          let id = strv(x.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
          if (!id) { let n = 1; while (seen['#BA' + n] !== undefined) n++; id = 'BA' + n; }
          if (seen['#' + id] === true) throw E('INVALID', 'Rekening ganda');
          if (out.some(o => o.account_no === no && KBank.key(o.bank) === KBank.key(bank))) throw E('INVALID', bank + ' ' + no + ' ada dua kali');
          seen['#' + id] = true;
          out.push({ id, bank, account_no: no, holder: safeName(x.holder, 80) || '', active: x.active !== false });
        }
        before.forEach(b => { if (seen['#' + strv(b.id)] !== true) out.push(Object.assign({}, b, { active: false })); });
        if (out.length > 30) throw E('INVALID', 'Paling banyak 30 rekening');
        const label = a => a.bank + ' ' + a.account_no + (a.holder ? ' a.n. ' + a.holder : ''), ch = [];
        out.forEach(a => {
          const b = before.find(y => strv(y.id) === a.id);
          if (!b) ch.push('+ ' + label(a) + (a.active ? '' : ' (nonaktif)'));
          else if (label(b) !== label(a)) ch.push(label(b) + ' → ' + label(a));
          if (b && (b.active !== false) !== a.active) ch.push(label(a) + (a.active ? ' aktif lagi' : ' nonaktif'));
        });
        if (!ch.length) return { unchanged: true, bank_accounts: out };
        db.settings.bank_accounts = out;
        const txt = 'Rekening bank toko diubah: ' + ch.join('; ') + ' — oleh ' + (u.role === 'manager' ? 'manajer ' : 'pemilik ') + u.name;
        logAct(db, u, 'atur_bank', txt.slice(0, 1000), 'rekening', 0, 'info');
        notifyR(db, u, ['owner', 'manager', 'akuntan'].filter(r => r !== u.role), txt, 'info');
        return { bank_accounts: out };
      }
      case 'set_transfer_bank': { // v57 (as on the server): the accountant / manager / owner files a transfer under the store account it went to (or came from)
        if (!['owner', 'manager', 'akuntan'].includes(u.role)) throw E('FORBIDDEN', 'Hanya akuntan / manajer / pemilik');
        const accId = strv(data.account_id), acc = bankAccounts(db).find(x => strv(x.id) === accId);
        if (!acc) throw E('INVALID', 'Pilih rekening toko');
        const who = (u.role === 'manager' ? 'manajer ' : u.role === 'akuntan' ? 'akuntan ' : 'pemilik ') + u.name, accTxt = a => a ? a.bank + ' ' + a.account_no : '';
        if (data.kind === 'sale') {
          const s0 = db.sales.find(x => x.invoice_no === strv(data.invoice_no));
          if (!s0) throw E('NOT_FOUND', 'Faktur tidak ditemukan');
          const tr = window.KPay.of(s0).transfer;
          if (!(tr > 0) || s0.status === 'void') throw E('INVALID', 'Faktur ini tidak dibayar dengan transfer');
          if (strv(s0.account_id) === accId) return { unchanged: true, account_id: accId };
          const prev = bankAccounts(db).find(x => strv(x.id) === strv(s0.account_id));
          s0.account_id = accId;
          logAct(db, u, 'atur_bank', 'Transfer faktur ' + s0.invoice_no + ' (' + strv(s0.customer_name) + ') Rp ' + tr + ' masuk ke ' + accTxt(acc) + (prev ? ' (sebelumnya ' + accTxt(prev) + ')' : '') + ' — oleh ' + who, s0.invoice_no, tr, 'info');
          return { invoice_no: s0.invoice_no, account_id: accId };
        }
        if (data.kind === 'payment') {
          const p0 = db.payments.find(x => x.pay_id === strv(data.pay_id) && (!isYmd(data.pay_date) || x.pay_date === data.pay_date));
          if (!p0) throw E('NOT_FOUND', 'Pembayaran tidak ditemukan (kirim pay_id + pay_date)');
          if (!['transfer', 'qris'].includes(p0.method)) throw E('INVALID', 'Pembayaran ini bukan transfer');
          if (strv(p0.account_id) === accId) return { unchanged: true, account_id: accId };
          const prev = bankAccounts(db).find(x => strv(x.id) === strv(p0.account_id)), out = payDir(p0) === 'out';
          p0.account_id = accId;
          logAct(db, u, 'atur_bank', 'Transfer ' + (out ? 'keluar ' : 'masuk ') + p0.pay_id + ' (' + (strv(p0.customer_name) || strv(p0.supplier) || strv(p0.payee)) + ') Rp ' + int(p0.amount) + (out ? ' dari ' : ' ke ') + accTxt(acc) + (prev ? ' (sebelumnya ' + accTxt(prev) + ')' : '') + ' — oleh ' + who, p0.pay_id, int(p0.amount), 'info');
          return { pay_id: p0.pay_id, account_id: accId };
        }
        throw E('INVALID', 'Jenis tidak dikenal (sale / payment)');
      }
      case 'record_transfer': {
        // The manager records a bank transfer once the owner approved the request; the owner may record directly.
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const payee = safeName(data.payee, 80);
        if (!payee) throw E('INVALID', 'Nama penerima wajib (huruf dan angka saja)');
        const amount = int(data.amount);
        if (!(amount > 0)) throw E('INVALID', 'Jumlah transfer tidak valid');
        let reqAp = null, reqPl = {};
        if (u.role === 'manager') {
          reqAp = db.approvals.find(x => x.request_id === strv(data.request_id)) || null;
          try { reqPl = JSON.parse(reqAp ? reqAp.payload : '{}'); } catch (e) { reqPl = {}; }
          if (!reqAp || reqAp.kind !== 'transfer' || reqAp.status !== 'approved' || reqPl.paid === true
            || safeName(reqPl.payee, 80) !== payee || int(reqPl.amount) !== amount) {
            throw E('NEEDS_OWNER', 'Transfer butuh persetujuan pemilik');
          }
        }
        if (dupRef(db.payments.filter(p => payDir(p) === 'out'), data.transfer_ref)) throw E('INVALID', 'Nomor transfer ini sudah pernah dipakai: ' + strv(data.transfer_ref));
        const reason = (reqAp ? strv(reqPl.reason) : strv(data.reason)).slice(0, 300);
        const pay = { id: nextId(db, 'payment'), pay_id: 'PY' + randId(7), pay_date: isYmd(data.pay_date) ? data.pay_date : jktDate(), pay_time: new Date().toISOString(),
          direction: 'out', party_type: 'other', customer_id: 0, customer_name: '', supplier: '', payee, amount, method: 'transfer',
          account_id: strv(data.account_id) || payAccount(db, data, 'transfer', ((db.photos || []).find(x => x.photo_id === strv(data.photo_id) && x.kind === 'bayar') || {}).extracted, 'out'), bank: strv(data.bank).slice(0, 60), transfer_ref: strv(data.transfer_ref).slice(0, 80),
          proof_photo_id: strv(data.photo_id).slice(0, 40), alloc: '[]', match_status: '',
          note: (reason + (strv(data.note) ? ' | ' + strv(data.note) : '')).slice(0, 500), cashier: u.name };
        db.payments.push(pay);
        logAct(db, u, 'transfer_keluar', 'Transfer ' + payee + ' Rp ' + amount + (pay.bank ? ' ' + pay.bank : '') + (pay.transfer_ref ? ', ref ' + pay.transfer_ref : ''), pay.pay_id, amount, 'info');
        if (u.role === 'manager' && reqAp) {
          reqPl.paid = true; reqPl.pay_id = pay.pay_id;
          reqAp.payload = JSON.stringify(reqPl); reqAp.status = 'done';
          return { payment: payOut(pay), transfer: { request_id: reqAp.request_id, status: 'done' } };
        }
        return { payment: payOut(pay) };
      }
      case 'list_transfers': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const transfers = db.approvals.filter(a => {
          if (a.kind !== 'transfer' || a.status !== 'approved') return false;
          if (u.role === 'manager' && strv(a.cashier).toLowerCase() !== u.name.toLowerCase()) return false;
          let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
          return pl.paid !== true;
        }).map(a => {
          let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
          return { request_id: a.request_id, created_at: strv(a.created_at), by: strv(a.cashier), payee: strv(pl.payee), amount: int(pl.amount), reason: strv(pl.reason), status: a.status };
        });
        return { transfers };
      }
      case 'allocate_payment': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const p0 = db.payments.find(x => x.pay_id === strv(data.pay_id) && (data.customer_id ? Number(x.customer_id) === Number(data.customer_id) : data.supplier !== undefined ? strv(x.supplier) === strv(data.supplier) : true));
        if (!p0) throw E('NOT_FOUND', 'Pembayaran tidak ditemukan (kirim juga customer_id / supplier)');
        const pt = payDir(p0) === 'out' ? 'supplier' : 'customer';
        const docs = partyDocs(db, pt, pt === 'customer' ? p0.customer_id : strv(p0.supplier), p0.pay_id);
        const chk = checkAlloc(data.alloc, docs, int(p0.amount));
        if (pt === 'supplier') markNotesPaid(db, docs, chk.alloc, strv(p0.pay_date) || jktDate()); // v65
        Object.assign(p0, { alloc: JSON.stringify(chk.alloc), match_status: allocStatus(int(p0.amount), chk, docs), note: (strv(p0.note) + (strv(data.note) ? ' | alokasi: ' + strv(data.note) : '')).slice(0, 500) });
        logAct(db, u, 'alokasi', 'Alokasi pembayaran ' + p0.pay_id + ' (' + (pt === 'customer' ? p0.customer_name : p0.supplier) + ' Rp ' + int(p0.amount) + '): ' +
          (chk.alloc.length ? chk.alloc.map(a => 'bagian dari ' + a.ref + ' Rp ' + a.amount).join(', ') : 'dikosongkan') + (strv(data.note) ? ' | ' + strv(data.note) : ''), p0.pay_id, int(p0.amount), 'info');
        return { payment: payOut(p0) };
      }
      case 'party_ledger': {
        const pt = data.party_type === 'supplier' ? 'supplier' : 'customer';
        if (pt === 'supplier' && !isAppr(u) && u.role !== 'akuntan') throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        let key, balance;
        if (pt === 'customer') { const c = custById(data.customer_id); if (!c) throw E('NOT_FOUND', 'Pelanggan tidak ditemukan'); key = c.id; balance = int(c.debt_balance); }
        else { key = strv(data.supplier); if (!key) throw E('INVALID', 'Nama pemasok wajib'); }
        const docs = partyDocs(db, pt, key, '');
        const pays = partyPays(db, pt, key).map(payOut).sort((a, b) => String(b.pay_date + b.pay_time).localeCompare(String(a.pay_date + a.pay_time)));
        const list = Object.values(docs).sort((a, b) => String(a.date).localeCompare(String(b.date)));
        if (pt === 'supplier') balance = sum(list, d => d.total) - sum(pays, p => int(p.amount));
        let free = sum(partyPays(db, pt, key), p => Math.max(0, int(p.amount) - sum(payAlloc(p), a => int(a.amount))));
        list.forEach(d => { const take = Math.min(free, Math.max(0, d.total - d.paid)); d.auto = take; free -= take; d.remaining = Math.max(0, d.total - d.paid - take); });
        return { party_type: pt, docs: list, payments: pays, balance, unapplied: free };
      }
      case 'import_statement': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const acc = bankAccounts(db).find(x => strv(x.id) === strv(data.account_id));
        if (!acc) throw E('INVALID', 'Pilih rekening bank toko (atur di Pengaturan)');
        const period = strv(data.period);
        if (!/^\d{4}-\d{2}$/.test(period)) throw E('INVALID', 'Periode harus YYYY-MM');
        const pr = periodRange(period);
        const src = Array.isArray(data.lines) ? data.lines : [];
        if (!src.length || src.length > 1500) throw E('INVALID', 'Baris rekening kosong atau terlalu banyak (maks 1500)');
        const existing = bankLinesOf(db, acc.id, period);
        const now = new Date().toISOString(), lines = [];
        for (let i = 0; i < src.length; i++) {
          const l = src[i] || {};
          if (!isYmd(l.date) || l.date < pr.from || l.date > pr.to) throw E('INVALID', 'Baris ' + (i + 1) + ': tanggal di luar periode ' + period);
          const amt = l.amount !== undefined && l.amount !== null && l.amount !== '' ? int(l.amount) : int(l.credit) - int(l.debit);
          if (!amt) throw E('INVALID', 'Baris ' + (i + 1) + ': jumlah kosong');
          lines.push({ line_id: strv(acc.id) + '-' + period + '-' + (i + 1), account_id: strv(acc.id), period, seq: i + 1, line_date: l.date, description: strv(l.description).slice(0, 300), amount: amt,
            ref: strv(l.ref).slice(0, 80), balance: l.balance === undefined || l.balance === null || l.balance === '' ? 0 : int(l.balance), status: '', pay_id: '', note: '', imported_at: now, imported_by: u.name });
        }
        const rep = reconcile(db, lines, strv(acc.id), period);
        const byId = {}; rep.lines.forEach(x => { byId[x.line_id] = x; });
        lines.forEach((l, i) => {
          const row = Object.assign({}, l, { status: byId[l.line_id].status, pay_id: byId[l.line_id].pay_id || '' });
          if (existing[i]) Object.assign(existing[i], row); else db.bank_lines.push(Object.assign({ id: nextId(db, 'bank_line') }, row));
        });
        existing.slice(lines.length).forEach(x => { x.status = 'dihapus'; });
        const bad = (rep.counts.beda_tanggal || 0) + (rep.counts.beda_jumlah || 0) + (rep.counts.tidak_tercatat || 0) + rep.missing.length;
        logAct(db, u, 'rekening', reconText(acc, period, rep), strv(acc.id) + ' ' + period, rep.totals.statement_in - rep.totals.statement_out, bad ? 'warn' : 'info');
        return Object.assign({ account: acc, period }, rep);
      }
      case 'bank_recon': {
        if (!isAppr(u) && u.role !== 'akuntan') throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        const acc = bankAccounts(db).find(x => strv(x.id) === strv(data.account_id));
        if (!acc) throw E('INVALID', 'Pilih rekening bank toko');
        const period = strv(data.period);
        if (!/^\d{4}-\d{2}$/.test(period)) throw E('INVALID', 'Periode harus YYYY-MM');
        const lines = bankLinesOf(db, acc.id, period);
        return Object.assign({ account: acc, period, imported: lines.length > 0 }, reconcile(db, lines, strv(acc.id), period));
      }
      case 'match_bank_line': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const l = (db.bank_lines || []).find(x => x.line_id === strv(data.line_id));
        if (!l) throw E('NOT_FOUND', 'Baris rekening tidak ditemukan (kirim account_id + period)');
        let upd;
        if (data.ignore === true) upd = { status: 'diabaikan', pay_id: '' };
        else if (strv(data.pay_id)) {
          const pp = rangePays(db, strv(l.period)).find(x => x.pay_id === strv(data.pay_id));
          if (!pp) throw E('NOT_FOUND', 'Pembayaran tidak ditemukan di sekitar periode ini');
          upd = { status: 'manual', pay_id: pp.pay_id };
        } else upd = { status: 'tidak_tercatat', pay_id: '' };
        const note = strv(data.note).slice(0, 300);
        if (upd.status !== 'tidak_tercatat' && !note) throw E('INVALID', 'Catatan wajib diisi');
        Object.assign(l, upd, { note });
        logAct(db, u, 'rekening', 'Baris rekening ' + strv(l.line_date) + ' Rp ' + int(l.amount) + ' (' + strv(l.description).slice(0, 80) + '): ' +
          (upd.status === 'manual' ? 'dicocokkan manual dengan ' + upd.pay_id : (upd.status === 'diabaikan' ? 'diabaikan' : 'dibuka lagi')) + (note ? ' | ' + note : ''), strv(l.line_id), int(l.amount), 'info');
        const o = Object.assign({}, l); delete o.id;
        return { line: o };
      }
      case 'daily_report': {
        if (!isAppr(u) && u.role !== 'akuntan') throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        if (!isYmd(data.date)) throw E('INVALID', 'Tanggal tidak valid');
        const day = data.date;
        const allSales = db.sales.filter(x => x.sale_date === day), okSales = allSales.filter(x => x.status !== 'void'), voids = allSales.filter(x => x.status === 'void');
        const okInv = new Set(okSales.map(x => x.invoice_no));
        const items = db.items.filter(x => okInv.has(x.invoice_no));
        const byMethod = { tunai: 0, transfer: 0, qris: 0, kartu: 0 };
        okSales.forEach(x => { const sp = window.KPay.of(x); byMethod.tunai += sp.tunai; byMethod.transfer += sp.transfer; byMethod.qris += sp.qris; byMethod.kartu += sp.kartu; });
        const prod = {};
        items.forEach(it => { const k = String(it.product_id); if (!prod[k]) prod[k] = { name: strv(it.name), qty: 0, total: 0 }; prod[k].qty = roundQty(prod[k].qty + num(it.qty)); prod[k].total += int(it.line_total); });
        const pays = db.payments.filter(p => p.pay_date === day), pin = pays.filter(p => payDir(p) === 'in'), pout = pays.filter(p => payDir(p) === 'out');
        const mSum = (arr, m) => sum(arr.filter(p => p.method === m), p => int(p.amount));
        const exps = db.expenses.filter(e => e.expense_date === day);
        const shifts = db.shifts.filter(x => x.shift_date === day).map(x0 => {
          const x = shiftSummary(db, x0);
          const exp = int(x.opening_cash) + int(x.cash_sales) + int(x.cash_payments) + int(x.cash_in) - int(x.cash_out);
          return { shift_id: x.shift_id, cashier: x.cashier, status: x.status, opening_cash: int(x.opening_cash), cash_sales: int(x.cash_sales), cash_payments: int(x.cash_payments), cash_in: int(x.cash_in), cash_out: int(x.cash_out),
            expected_cash: x.status === 'closed' ? int(x.expected_cash) : exp, counted_cash: x.status === 'closed' ? int(x.counted_cash) : null, difference: x.status === 'closed' ? int(x.difference) : null, sales_count: num(x.sales_count), sales_total: int(x.sales_total) };
        });
        const rep = {
          date: day,
          sales: { count: okSales.length, total: sum(okSales, x => int(x.total)), discount: sum(okSales, x => int(x.discount)), items_qty: roundQty(sum(items, x => num(x.qty))), by_method: byMethod, debt: sum(okSales, x => int(x.debt_amount)), voids: { count: voids.length, total: sum(voids, x => int(x.total)) } },
          top_items: Object.values(prod).sort((a, b) => b.total - a.total).slice(0, 10),
          payments_in: { count: pin.length, total: sum(pin, p => int(p.amount)), tunai: mSum(pin, 'tunai'), transfer: mSum(pin, 'transfer'), qris: mSum(pin, 'qris') },
          payments_out: { count: pout.length, total: sum(pout, p => int(p.amount)), tunai: mSum(pout, 'tunai'), transfer: mSum(pout, 'transfer'), qris: mSum(pout, 'qris') },
          expenses: { count: exps.length, total: sum(exps, e => int(e.amount)), from_kas: sum(exps.filter(e => e.paid_from === 'kas'), e => int(e.amount)),
            // v36: invoice checks — open (difference / check by hand), approved and rejected
            flagged: exps.filter(e => e.check_status === 'selisih' || e.check_status === 'cek_manual').length, approved: exps.filter(e => e.check_status === 'disetujui').length,
            rejected: exps.filter(e => e.check_status === 'ditolak').length, flagged_total: sum(exps.filter(e => ['selisih', 'cek_manual', 'ditolak'].includes(e.check_status)), e => int(e.amount)) },
          shifts
        };
        rep.bank = { sales_transfer: byMethod.transfer, sales_qris: byMethod.qris, sales_card: byMethod.kartu, payments_transfer: rep.payments_in.transfer, payments_qris: rep.payments_in.qris, out_transfer: rep.payments_out.transfer + rep.payments_out.qris };
        rep.bank.in_total = rep.bank.sales_transfer + rep.bank.sales_qris + rep.bank.sales_card + rep.bank.payments_transfer + rep.bank.payments_qris;
        rep.cash = { sales: byMethod.tunai, payments_in: rep.payments_in.tunai, payments_out: rep.payments_out.tunai, expenses_from_kas: rep.expenses.from_kas,
          expected_total: sum(shifts, x => x.expected_cash), counted_total: sum(shifts.filter(x => x.status === 'closed'), x => x.counted_cash), difference_total: sum(shifts.filter(x => x.status === 'closed'), x => x.difference) };
        if (owner) rep.profit = sum(okSales, x => int(x.profit));
        // v37 every cashier's own day (mirrors backend/process.js daily_report)
        const per = {}, invWho = {};
        const who = n => { const k = strv(n) || '-'; if (!per[k]) per[k] = { name: k, sales: { count: 0, total: 0, discount: 0, items_qty: 0, by_method: { tunai: 0, transfer: 0, qris: 0, kartu: 0 }, debt: 0 }, voids: { count: 0, total: 0 },
          payments_in: { count: 0, total: 0, tunai: 0, transfer: 0, qris: 0 }, payments_out: { count: 0, total: 0, tunai: 0 }, expenses: { count: 0, total: 0, from_kas: 0 }, shifts: [] }; return per[k]; };
        okSales.forEach(x => { const c = who(x.cashier), s1 = c.sales, sp = window.KPay.of(x); invWho[x.invoice_no] = c; s1.count++; s1.total += int(x.total); s1.discount += int(x.discount); s1.debt += int(x.debt_amount);
          s1.by_method.tunai += sp.tunai; s1.by_method.transfer += sp.transfer; s1.by_method.qris += sp.qris; s1.by_method.kartu += sp.kartu; });
        items.forEach(it => { const c = invWho[it.invoice_no]; if (c) c.sales.items_qty = roundQty(c.sales.items_qty + num(it.qty)); });
        voids.forEach(x => { const c = who(x.cashier); c.voids.count++; c.voids.total += int(x.total); });
        pin.forEach(p => { const c = who(p.cashier); c.payments_in.count++; c.payments_in.total += int(p.amount); if (c.payments_in[p.method] !== undefined) c.payments_in[p.method] += int(p.amount); });
        pout.forEach(p => { const c = who(p.cashier); c.payments_out.count++; c.payments_out.total += int(p.amount); if (p.method === 'tunai') c.payments_out.tunai += int(p.amount); });
        exps.forEach(e => { const c = who(e.user); c.expenses.count++; c.expenses.total += int(e.amount); if (e.paid_from === 'kas') c.expenses.from_kas += int(e.amount); });
        shifts.forEach(x => who(x.cashier).shifts.push(x.shift_id));
        rep.cashiers = Object.keys(per).map(k => {
          const c = per[k], mine = shifts.filter(x => strv(x.cashier) === k || (k === '-' && !strv(x.cashier))), closed = mine.filter(x => x.status === 'closed');
          c.drawer = mine.length ? { count: mine.length, open: mine.length - closed.length, opening_cash: sum(mine, x => x.opening_cash), cash_sales: sum(mine, x => x.cash_sales), cash_payments: sum(mine, x => x.cash_payments),
            cash_in: sum(mine, x => x.cash_in), cash_out: sum(mine, x => x.cash_out), expected_cash: sum(mine, x => x.expected_cash),
            counted_cash: closed.length ? sum(closed, x => x.counted_cash) : null, difference: closed.length ? sum(closed, x => x.difference) : null } : null;
          return c;
        }).sort((a, b) => b.sales.total - a.sales.total || String(a.name).localeCompare(String(b.name)));
        const wibDayOf = iso => iso ? new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(0, 10) : '';
        const corrDay = db.approvals.filter(a => a.kind === 'koreksi' && wibDayOf(a.decided_at) === day);
        const refPaid = db.approvals.filter(a => a.kind === 'refund' && a.status === 'approved' && wibDayOf(a.decided_at) === day);
        const wrOff = db.approvals.filter(a => a.kind === 'konsultasi' && a.status === 'rejected' && wibDayOf(a.decided_at) === day);
        rep.corrections = { count: corrDay.length, net: sum(corrDay, x => int(x.total)), refund_paid: sum(refPaid, x => int(x.total)), writeoff: sum(wrOff, x => int(x.total)) };
        const rets = (db.returns || []).filter(x => x.status === 'approved' && x.return_date === day), custRets = rets.filter(x => x.kind !== 'pemasok');
        rep.returns = { customer: { count: custRets.length, refund: sum(custRets, x => int(x.refund)), tunai: sum(custRets.filter(x => x.refund_method === 'tunai'), x => int(x.refund)) }, supplier: { count: rets.length - custRets.length } };
        if (owner) rep.returns.supplier.value = sum(rets.filter(x => x.kind === 'pemasok'), x => int(x.value));
        // v37 (owner: «المتابعة اليومية للفواتير التي تم تنزيلها مع الكميات الموجودة»): the day's goods-in notes and invoice changes
        const dayAct = (db.activity || []).filter(a => a.act_date === day), inAt = {};
        dayAct.forEach(a => { if (a.kind === 'masuk' && a.ref && !inAt[a.ref]) inAt[a.ref] = a.at; });
        const gin = new Map(), cOk = mockNoteOk(db, u);
        db.purchases.filter(r => r.purchase_date === day && strv(r.purchase_no) && !['koreksi', 'retur'].includes(strv(r.match_status)) && !internalSup(r.supplier) && num(r.qty) > 0).forEach(r => {
          const no = strv(r.purchase_no);
          if (!gin.has(no)) gin.set(no, { purchase_no: no, supplier: strv(r.supplier), at: inAt[no] || '', by: strv(r.user), match_status: strv(r.match_status) || 'tanpa_foto', match_notes: strv(r.match_notes),
            carrier_type: strv(r.carrier_type), carrier_name: strv(r.carrier_name), carrier_vehicle: strv(r.carrier_vehicle), photo_id: strv(r.photo_id), note: strv(r.note), lines: [], qty: 0, total: 0 });
          const g = gin.get(no), p = prodById(r.product_id);
          const l = { product_id: Number(r.product_id), name: strv(r.name) || (p ? p.name : ''), unit: p ? strv(p.unit) : '', qty: roundQty(r.qty), exp_date: strv(r.exp_date), stock_now: p ? roundQty(p.stock) : null, shop_now: p ? roundQty(shopOf(p)) : null };
          if (cOk) { l.cost_price = int(r.cost_price); l.total = int(r.total); }
          g.lines.push(l); g.qty = roundQty(g.qty + l.qty); g.total += int(r.total);
        });
        const changesDay = dayAct.filter(a => a.kind === 'ubah_faktur').map(a => changeOut(db, u, a)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
        const notes = [...gin.values()].map(g => { g.changes_today = changesDay.filter(c => c.no === g.purchase_no || (c.nos || []).includes(g.purchase_no)).length; if (!cOk) delete g.total; return g; })
          .sort((a, b) => String(a.at || '~').localeCompare(String(b.at || '~')));
        rep.goods_in = { count: notes.length, lines: sum(notes, g => g.lines.length), qty: roundQty(sum(notes, g => g.qty)), mismatch: notes.filter(g => ['tidak_cocok', 'perlu_cek'].includes(g.match_status)).length, notes };
        if (cOk) rep.goods_in.total = sum(notes, g => int(g.total));
        rep.invoice_changes = { count: changesDay.length, list: changesDay };
        const st = db.settings;
        return { report: rep, send_to: { company: strv(st.wa_shop_number), manager: strv(st.wa_manager_number), owner: strv(st.wa_owner_number) } };
      }
      case 'save_purchase': {
        if (!Array.isArray(data.items) || !data.items.length) throw E('INVALID', 'Tidak ada barang');
        if (strv(data.supplier) && !safeName(data.supplier, 80)) throw E('INVALID', 'Nama pemasok hanya boleh huruf dan angka');
        // who brought the goods: public transport (+ its number), a friend (name), the supplier's driver or our staff
        const carrier = readCarrier(data.carrier, setting(db, 'require_carrier') !== false);
        if (carrier.error) throw E('CARRIER_REQUIRED', carrier.error);
        const photo = data.photo_id ? db.photos.find(x => x.photo_id === data.photo_id && x.kind === 'masuk') : null;
        if (data.photo_id && !photo) throw E('INVALID', 'Foto barang masuk tidak ditemukan');
        if (!photo && db.settings.require_purchase_photo !== false) throw E('PHOTO_REQUIRED', 'Barang masuk wajib foto nota / barang');
        const pdate = isYmd(data.purchase_date) ? data.purchase_date : jktDate();
        // check what was typed against the photographed supplier note before anything is saved
        const typed = data.items.map(it => { const p0 = prodById(it.product_id); return { name: p0 ? p0.name : strv(it.product_id), qty: roundQty(it.qty), photo_index: it.photo_index }; });
        const match = photo ? matchNote(typed, photo) : { status: 'tanpa_foto', diffs: [], notes: '' };
        const reason = strv(data.mismatch_reason).slice(0, 300);
        if (match.status === 'tidak_cocok' && !reason) throw E('MISMATCH', 'Jumlah tidak sama dengan nota: ' + diffText(match.diffs), { match });
        const checked = data.items.map(it => {
          const p = prodById(it.product_id); if (!p) throw E('NOT_FOUND', 'product ' + it.product_id);
          const qty = roundQty(it.qty); if (!(qty > 0)) throw E('INVALID', 'qty must be > 0');
          const expNone = it.exp_none === true;
          const exp = isYmd(it.exp_date) ? it.exp_date : '';
          if (!expNone && !exp) throw E('INVALID', 'Tanggal kedaluwarsa wajib untuk ' + p.name + ' (isi tanggal atau tandai "tak ada")');
          return { p, qty, cost: Math.max(0, int(it.cost_price)), exp, expNone };
        });
        const purchase_no = 'PB' + pdate.replace(/-/g, '').slice(2) + '-' + randId(4);
        const matchNotes = (match.diffs.length ? diffText(match.diffs) : '') + (reason ? ' | alasan: ' + reason : '');
        const out = [];
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
            purchase_no, match_status: match.status, match_notes: matchNotes.slice(0, 500), carrier_type: carrier.type, carrier_name: carrier.name, carrier_vehicle: carrier.vehicle, carrier_phone: carrier.phone });
          const o = out.find(x => x.product_id === p.id); if (o) Object.assign(o, { stock: p.stock, cost_price: p.cost_price, exp_date: p.exp_date, exp_none: p.exp_none }); else out.push({ product_id: p.id, stock: p.stock, cost_price: p.cost_price, exp_date: p.exp_date, exp_none: p.exp_none });
        }
        if (photo) photo.ref = [photo.ref, String(data.supplier || '')].filter(Boolean).join(' ') || 'masuk';
        const sumTotal = sum(checked, x => Math.round(x.qty * x.cost));
        logAct(db, u, 'masuk', 'Barang masuk ' + purchase_no + (strv(data.supplier) ? ' dari ' + strv(data.supplier) : '') + ': ' + data.items.length + ' baris, Rp ' + sumTotal + ' — nota: ' + match.status + (matchNotes ? ' (' + matchNotes + ')' : '') + (carrier.type ? ' — dibawa ' + CARRIER_TEXT[carrier.type] + (carrier.name ? ' ' + carrier.name : '') + (carrier.vehicle ? ' ' + carrier.vehicle : '') : ''), purchase_no, sumTotal, match.status === 'cocok' ? 'info' : 'warn');
        return { stock: out, purchase_no, match };
      }
      case 'request_purchase_fix': {
        const no = strv(data.purchase_no);
        if (!no) throw E('INVALID', 'purchase_no wajib');
        const reason = strv(data.reason).slice(0, 300);
        if (!reason) throw E('INVALID', 'Alasan koreksi wajib diisi');
        const pf = purchaseFixChanges(db, no, data.lines);
        if (!pf.found) throw E('NOT_FOUND', 'Barang masuk tidak ditemukan');
        if (!pf.changes.length) throw E('INVALID', 'Tidak ada perubahan');
        const summary = fixSummary(no, pf.changes);
        // Owner monitoring: only the owner applies a goods-in correction directly.
        // The manager REQUESTS it (owner approves); the cashier requests it (manager approves).
        if (u.role === 'owner') {
          const first = db.purchases.find(r => strv(r.purchase_no) === no) || {};
          const stock = applyPurchaseFix(db, no, pf.changes, reason, u.name);
          logAct(db, u, 'koreksi_masuk', summary + ' | ' + reason, no, sum(pf.changes, c => c.d_total), 'warn');
          purchaseFixChange(db, u, no, first, pf.changes, reason, u.name, '', ''); // v37
          return { applied: true, changes: pf.changes, stock };
        }
        const need = u.role === 'manager' ? 'owner' : 'manager';
        const approval = newApproval(db, u, { kind: 'purchase_fix', approver_role: need, ref: no, note: reason, summary: summary.slice(0, 1500), total: sum(pf.changes, c => c.to_total),
          payload: JSON.stringify({ purchase_no: no, lines: data.lines, reason, changes: pf.changes }) });
        logAct(db, u, 'minta_koreksi', 'Minta ' + summary + ' | ' + reason, no, 0, 'warn');
        return { applied: false, request_id: approval.request_id, approval, approver_role: need, changes: isAppr(u) ? pf.changes : pf.changes.map(qtyOnly) };
      }
      case 'list_invoice_changes': { // v37: the "Perubahan faktur" audit list
        if (!(isAppr(u) || u.role === 'akuntan')) throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        if (!isYmd(data.from) || !isYmd(data.to) || data.from > data.to) throw E('INVALID', 'Rentang tanggal tidak valid');
        return { changes: (db.activity || []).filter(a => a.kind === 'ubah_faktur' && a.act_date >= data.from && a.act_date <= data.to).map(a => changeOut(db, u, a)).sort((a, b) => String(b.at).localeCompare(String(a.at))) };
      }
      case 'set_opname_every': { // v37: owner or manager, 7–180 days
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const dd = Math.round(num(data.days));
        if (!(dd >= 7 && dd <= 180) || String(data.days == null ? '' : data.days).trim() === '') throw E('INVALID', 'Stok opname setiap 7–180 hari');
        const before = opnameEvery(db);
        db.settings.opname_every_days = dd;
        if (before !== dd) logAct(db, u, 'pengaturan', 'Stok opname penuh setiap ' + before + ' → ' + dd + ' hari (' + u.name + ')', '', 0, 'info');
        return { opname_every_days: dd, opname: opnameStatus(db) };
      }
      case 'list_corrections': {
        if (!(isAppr(u) || u.role === 'akuntan')) throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        return { corrections: db.approvals.filter(a => a.kind === 'koreksi').map(a => { let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; } return { request_id: a.request_id, at: String(a.decided_at || a.created_at), by: String(a.decided_by || a.cashier), total: int(a.total), summary: String(a.summary || ''), payload: pl }; }).sort((x, y) => String(y.at).localeCompare(String(x.at))) };
      }
      case 'list_disputes': {
        if (!(isAppr(u) || u.role === 'akuntan')) throw E('FORBIDDEN', 'Hanya pemilik, manajer atau akuntan');
        const canDec = a => u.role === 'owner' || (u.role === 'manager' && a.approver_role !== 'owner');
        const now = Date.now();
        return { disputes: db.approvals.filter(a => (a.kind === 'refund' || a.kind === 'konsultasi') && a.status === 'pending').map(a => { let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; } return { request_id: a.request_id, kind: a.kind, at: String(a.created_at), amount: int(a.total), customer_name: String(a.customer_name || ''), summary: String(a.summary || ''), can_decide: canDec(a), expired: !!(pl.expiry && Date.parse(pl.expiry) < now), payload: pl }; }).sort((x, y) => String(x.at).localeCompare(String(y.at))) };
      }
      case 'decide_refund': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const a = db.approvals.find(x => x.request_id === String(data.request_id || '')); if (!a || a.kind !== 'refund') throw E('NOT_FOUND', 'Permintaan refund tidak ditemukan');
        if (a.status !== 'pending') throw E('INVALID', 'Sudah diputuskan: ' + a.status);
        if (!(u.role === 'owner' || a.approver_role !== 'owner')) throw E('NEEDS_OWNER', 'Butuh persetujuan pemilik');
        let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
        if (data.decision === 'release') {
          if (pl.channel === 'cadangan' && pl.expiry && Date.parse(pl.expiry) > Date.now()) throw E('INVALID', 'Belum lewat 3 bulan — belum bisa dilepas');
          a.status = 'released'; a.decided_by = u.name; a.decided_at = jktISO(); a.note = String(data.note || '') || 'dana dilepas (3 bln lewat)';
          logAct(db, u, 'refund_lepas', 'Cadangan refund DILEPAS ' + String(a.customer_name) + ' Rp ' + int(a.total) + ' (3 bln lewat, jadi pemasukan)', String(a.ref), int(a.total), 'info');
          return { released: true };
        }
        if (pl.channel === 'cadangan' && !String(data.photo_id || '')) throw E('PHOTO_REQUIRED', 'Cadangan: foto faktur pelanggan dulu untuk verifikasi');
        a.status = 'approved'; a.decided_by = u.name; a.decided_at = jktISO(); a.note = 'refund dibayar' + (String(data.photo_id || '') ? ' (foto ' + String(data.photo_id).slice(0, 40) + ')' : '');
        logAct(db, u, 'refund_bayar', 'Refund DIBAYAR ' + String(a.customer_name) + ' Rp ' + int(a.total) + ' (faktur ' + String(pl.invoice_no) + ')' + (String(data.photo_id || '') ? ' — terverifikasi foto' : ''), String(a.ref), int(a.total), 'warn');
        return { approval: Object.assign({}, a) };
      }
      case 'decide_consult': {
        if (u.role !== 'owner') throw E('NEEDS_OWNER', 'Keputusan musyawarah oleh pemilik');
        const a = db.approvals.find(x => x.request_id === String(data.request_id || '')); if (!a || a.kind !== 'konsultasi') throw E('NOT_FOUND', 'Musyawarah tidak ditemukan');
        if (a.status !== 'pending') throw E('INVALID', 'Sudah diputuskan: ' + a.status);
        let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; }
        const dec = ['collect', 'writeoff', 'return'].includes(data.decision) ? data.decision : '';
        if (!dec) throw E('INVALID', 'Pilih: collect / writeoff / return');
        let extra = '';
        if (dec === 'collect') { const cust = Number(pl.customer_id) > 0 ? custById(pl.customer_id) : null; if (cust) { cust.debt_balance = int(cust.debt_balance) + int(a.total); extra = ' (ditambah ke hutang ' + String(cust.name) + ')'; } else extra = ' (pelanggan umum — hubungi ' + (String(pl.phone || '') || 'tanpa nomor') + ')'; }
        a.status = dec === 'collect' ? 'approved' : (dec === 'writeoff' ? 'rejected' : 'used'); a.decided_by = u.name; a.decided_at = jktISO(); a.note = (dec + (String(data.note || '') ? ': ' + String(data.note) : '')).slice(0, 500);
        logAct(db, u, 'musyawarah', 'Musyawarah kurang bayar ' + String(a.customer_name) + ' Rp ' + int(a.total) + ' → ' + (dec === 'collect' ? 'tagih' : dec === 'writeoff' ? 'direlakan (rugi)' : 'barang dikembalikan') + extra, String(a.ref), int(a.total), 'warn');
        return { decision: dec };
      }
      case 'correct_price': {
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        if (!isYmd(data.from) || !isYmd(data.to) || data.from > data.to) throw E('INVALID', 'Rentang tanggal tidak valid');
        const p = prodById(data.product_id); if (!p) throw E('NOT_FOUND', 'Produk tidak ditemukan');
        const oldPrice = int(data.old_price), newPrice = int(data.new_price);
        if (oldPrice < 0 || newPrice < 0) throw E('INVALID', 'Harga tidak valid');
        if (oldPrice === newPrice) throw E('INVALID', 'Harga lama dan baru sama');
        if (!String(data.reason || '').trim()) throw E('INVALID', 'Alasan wajib diisi');
        const inR = d => d >= data.from && d <= data.to;
        const saleByInv = {};
        db.sales.filter(s => s.status !== 'void' && inR(s.sale_date)).forEach(s => { saleByInv[s.invoice_no] = s; });
        const hits = db.items.filter(it => Number(it.product_id) === Number(p.id) && int(it.unit_price) === oldPrice && saleByInv[it.invoice_no]);
        if (!hits.length) throw E('NOT_FOUND', 'Tidak ada penjualan ' + p.name + ' dengan harga ' + oldPrice + ' pada rentang itu');
        const perInv = {};
        hits.forEach(it => {
          const qty = num(it.qty), cost = int(it.cost_price), newLineTotal = Math.round(qty * newPrice), dd = newLineTotal - int(it.line_total);
          (perInv[it.invoice_no] = perInv[it.invoice_no] || { diff: 0, qty: 0 });
          perInv[it.invoice_no].diff += dd; perInv[it.invoice_no].qty += qty;
          if (newPrice < oldPrice) { it.unit_price = newPrice; it.line_total = newLineTotal; it.line_profit = newLineTotal - Math.round(qty * cost); }
          else { it.corrected_price = newPrice; it.corrected_note = 'harga seharusnya ' + newPrice + ' (menunggu musyawarah)'; }
        });
        let netDiff = 0, refundTotal = 0, underTotal = 0;
        const cashiers = {}, details = [], refunds = [], consults = [], debtDelta = {};
        Object.keys(perInv).forEach(inv => {
          const s = saleByInv[inv], d = perInv[inv].diff; netDiff += d; cashiers[String(s.cashier)] = true;
          const cust = Number(s.customer_id) > 0 ? custById(s.customer_id) : null;
          const phone = cust ? String(cust.phone || '') : '';
          details.push({ invoice_no: inv, date: String(s.sale_date), cashier: String(s.cashier), customer_id: Number(s.customer_id) || 0, customer_name: String(s.customer_name), phone, qty: perInv[inv].qty, diff: d });
          if (d < 0) {
            const paid = int(s.paid_amount), newTotal = int(s.total) + d, oldDebt = int(s.debt_amount), newDebt = Math.max(0, newTotal - paid);
            s.subtotal = int(s.subtotal) + d; s.total = newTotal; s.profit = newTotal - int(s.total_cost); s.debt_amount = newDebt;
            if (cust) debtDelta[String(cust.id)] = (debtDelta[String(cust.id)] || 0) + (newDebt - oldDebt);
            const refund = Math.max(0, paid - newTotal);
            if (refund > 0) { refundTotal += refund; refunds.push({ invoice_no: inv, customer_id: Number(s.customer_id) || 0, customer_name: String(s.customer_name), phone, amount: refund, has_account: !!cust, channel: phone ? 'kontak' : (cust ? 'kontak' : 'cadangan') }); }
          } else {
            underTotal += d;
            consults.push({ invoice_no: inv, customer_id: Number(s.customer_id) || 0, customer_name: String(s.customer_name), phone, amount: d });
          }
        });
        Object.keys(debtDelta).forEach(cid => { const cust = custById(cid); if (cust && debtDelta[cid]) cust.debt_balance = Math.max(0, int(cust.debt_balance) + debtDelta[cid]); });
        const setters = db.approvals.filter(a => { if (a.kind !== 'price' || String(a.ref) !== String(p.id)) return false; try { const pl = JSON.parse(a.payload || '{}'); return pl.changes && Object.keys(pl.changes).some(f => int(pl.changes[f].to) === oldPrice); } catch (e) { return false; } }).map(a => ({ by: String(a.decided_by || a.cashier), at: String(a.decided_at || a.created_at) }));
        let catalog = null;
        if (data.update_catalog === true) {
          const ch = {};
          if (int(p.retail_price) === oldPrice) { ch.retail_price = { from: oldPrice, to: newPrice }; p.retail_price = newPrice; }
          if (int(p.wholesale_price) === oldPrice) { ch.wholesale_price = { from: oldPrice, to: newPrice }; p.wholesale_price = newPrice; }
          if (Object.keys(ch).length) { catalog = p; logAct(db, u, 'harga', 'Koreksi harga katalog ' + p.name + ': ' + Object.keys(ch).map(f => f + ' ' + ch[f].from + '→' + ch[f].to).join(', '), String(p.id), 0, 'warn'); }
        }
        const payload = JSON.stringify({ product_id: p.id, product_name: p.name, old_price: oldPrice, new_price: newPrice, from: data.from, to: data.to, invoices: details.length, qty: details.reduce((a1, x) => a1 + x.qty, 0), net_diff: netDiff, refund_total: refundTotal, under_total: underTotal, cashiers: Object.keys(cashiers), price_setters: setters, details: details.slice(0, 500), refunds: refunds.slice(0, 500), consults: consults.slice(0, 500), reason: String(data.reason).trim(), by: u.name });
        const summary = 'Koreksi harga ' + p.name + ' ' + oldPrice + '→' + newPrice + ': ' + details.length + ' faktur, selisih ' + netDiff + (refundTotal ? ', refund ' + refundTotal : '') + (underTotal ? ', kurang bayar ' + underTotal : '');
        const ap = newApproval(db, u, { kind: 'koreksi', ref: p.id, approver_role: 'owner', status: 'done', decided_by: u.name, decided_at: jktISO(), total: netDiff, summary: summary.slice(0, 1500), note: String(data.reason).trim(), payload });
        const expiry90 = new Date(Date.now() + 90 * 86400000).toISOString();
        refunds.forEach(rf => newApproval(db, u, { kind: 'refund', approver_role: 'manager', ref: rf.invoice_no, total: rf.amount, customer_id: rf.customer_id, customer_name: rf.customer_name, summary: ('Refund ' + rf.customer_name + ' Rp ' + rf.amount + ' (' + (rf.channel === 'cadangan' ? 'cadangan 3 bln' : 'hubungi') + ') — faktur ' + rf.invoice_no).slice(0, 1500), payload: JSON.stringify({ invoice_no: rf.invoice_no, customer_id: rf.customer_id, customer_name: rf.customer_name, phone: rf.phone, amount: rf.amount, channel: rf.channel, has_account: rf.has_account, expiry: rf.channel === 'cadangan' ? expiry90 : '', correction: ap.request_id, product_name: p.name }) }));
        consults.forEach(cs => newApproval(db, u, { kind: 'konsultasi', approver_role: 'owner', ref: cs.invoice_no, total: cs.amount, customer_id: cs.customer_id, customer_name: cs.customer_name, summary: ('Musyawarah (kurang bayar) ' + cs.customer_name + ' Rp ' + cs.amount + ' — faktur ' + cs.invoice_no).slice(0, 1500), payload: JSON.stringify({ invoice_no: cs.invoice_no, customer_id: cs.customer_id, customer_name: cs.customer_name, phone: cs.phone, amount: cs.amount, correction: ap.request_id, product_name: p.name }) }));
        logAct(db, u, 'koreksi', summary.slice(0, 1000) + ' | ' + String(data.reason).trim(), String(p.id), netDiff, 'warn');
        invoiceChange(db, u, { doc: 'jual', what: 'koreksi_harga', no: details.length === 1 ? details[0].invoice_no : '', nos: details.map(x => x.invoice_no), doc_date: data.from === data.to ? data.from : data.from + ' s/d ' + data.to, // v37
          changes: [{ product_id: p.id, name: p.name, price_from: oldPrice, price_to: newPrice, qty: details.reduce((a1, x) => a1 + x.qty, 0), invoices: details.length }],
          details: details.map(x => ({ invoice_no: x.invoice_no, date: x.date, customer_name: x.customer_name, qty: x.qty, diff: x.diff })), reason: String(data.reason).trim(), request_id: ap.request_id, amount: netDiff });
        return { correction: { request_id: ap.request_id, product_name: p.name, old_price: oldPrice, new_price: newPrice, invoices: details.length, net_diff: netDiff, refund_total: refundTotal, under_total: underTotal, refunds, consults, cashiers: Object.keys(cashiers), price_setters: setters }, product: catalog ? prodOut(catalog) : undefined };
      }
      case 'repack': case 'request_repack': case 'cancel_repack': return repackAction(db, u, action, data, x => canDecideAp(u, x)); // v38
      // v50 (owner 2026-10-15): start → the manager confirms the packs made + the bulk left over; the materials list
      case 'repack_start': return window.KRepackMock.start(db, u, data, RPX);
      case 'repack_finish': return window.KRepackMock.finish(db, u, data, RPX);
      case 'set_repack_materials': return window.KRepackMock.materials(db, u, data, RPX);
      case 'stock_count': return stockCount(db, u, data);
      case 'profit_loss': {
        // v36 (owner 2026-10-11: "الكشف الشهري يكتب الربح والخسارة") — same lines as the server's profit_loss
        needOwner();
        if (!isYmd(data.from) || !isYmd(data.to) || data.from > data.to) throw E('INVALID', 'Rentang tanggal tidak valid');
        const inP = d => strv(d) >= data.from && strv(d) <= data.to;
        const wibDay = iso => iso ? new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(0, 10) : '';
        const pS = db.sales.filter(x => inP(x.sale_date)), okS = pS.filter(x => x.status !== 'void'), voidS = pS.filter(x => x.status === 'void');
        const salesTotal = sum(okS, x => int(x.total)), gross = sum(okS, x => int(x.profit));
        const pExp = db.expenses.filter(e => inP(e.expense_date)), byCat = {};
        pExp.forEach(e => { const k = strv(e.category) || 'lain'; byCat[k] = (byCat[k] || 0) + int(e.amount); });
        const adj = db.purchases.filter(x => inP(x.purchase_date) && ['STOK OPNAME', 'PENYESUAIAN STOK'].includes(strv(x.supplier).toUpperCase()));
        const stockDiff = sum(adj, x => Math.round(num(x.qty) * int(x.cost_price)));
        const custRet = (db.returns || []).filter(x => x.status === 'approved' && x.kind !== 'pemasok' && inP(x.return_date));
        let restock = 0;
        custRet.forEach(x => { let lines = []; try { lines = typeof x.lines === 'string' ? JSON.parse(x.lines || '[]') : (x.lines || []); } catch (e) { lines = []; } (Array.isArray(lines) ? lines : []).forEach(l => { if (l && l.condition !== 'rusak') { const p = prodById(l.product_id); restock += Math.round(num(l.qty) * int(p ? p.cost_price : 0)); } }); });
        const retRefund = sum(custRet, x => int(x.refund));
        const corr = db.approvals.filter(a => a.kind === 'koreksi' && inP(wibDay(a.decided_at || a.created_at)));
        let over = 0, under = 0;
        corr.forEach(a => { let pl = {}; try { pl = JSON.parse(a.payload || '{}'); } catch (e) { pl = {}; } const un = int(pl.under_total); under += un; over += int(a.total) - un; });
        const decidedIn = (kind, status) => db.approvals.filter(a => a.kind === kind && a.status === status && inP(wibDay(a.decided_at)));
        const collected = sum(decidedIn('konsultasi', 'approved'), a => int(a.total)), writeoff = sum(decidedIn('konsultasi', 'rejected'), a => int(a.total)), refundPaid = sum(decidedIn('refund', 'approved'), a => int(a.total));
        const expTotal = sum(pExp, e => int(e.amount)), retNet = restock - retRefund;
        const pl = { from: data.from, to: data.to, sales: { count: okS.length, total: salesTotal, discount: sum(okS, x => int(x.discount)) }, voids: { count: voidS.length, total: sum(voidS, x => int(x.total)) },
          cogs: salesTotal - gross, gross_profit: gross, expenses: { count: pExp.length, total: expTotal, by_category: byCat }, returns: { count: custRet.length, refund: retRefund, restock, net: retNet },
          stock_diff: { count: adj.length, value: stockDiff }, corrections: { count: corr.length, net: over + under, overcharge: over, undercharge: under, refund_paid: refundPaid, collected, writeoff } };
        pl.net_profit = gross - expTotal + retNet + stockDiff + collected;
        return { pl };
      }
      case 'finance_position': { // v67 (as backend/process.js): the Keuangan screen — drawers, accounts, money with no account, position, P&L extras
        if (!(owner || u.role === 'akuntan' || (u.role === 'manager' && mockCostOk(db, u)))) throw E('FORBIDDEN', 'Hanya pemilik, akuntan, atau manajer yang boleh melihat modal');
        const ff = strv(data.from), ft = strv(data.to);
        if (!isYmd(ff) || !isYmd(ft) || ff > ft) throw E('INVALID', 'Rentang tanggal tidak valid');
        const seeCost = mockCostOk(db, u), T = jktDate(), accs = bankAccounts(db), known = new Set(accs.map(a => strv(a.id)));
        const zero = () => ({ in: 0, out: 0, n: 0 }), period = {}, since = {};
        accs.forEach(a => { period[strv(a.id)] = zero(); since[strv(a.id)] = zero(); });
        const accOf = id => known.has(strv(id)) ? strv(id) : '';
        const opv = db.settings.acct_opening, opening = opv && typeof opv === 'object' && !Array.isArray(opv) ? opv : {};
        const opDate = id => opening[id] && typeof opening[id] === 'object' && isYmd(strv(opening[id].date)) ? strv(opening[id].date) : '';
        const none = { tf_sales: 0, qris_sales: 0, card_sales: 0, cash_nodrawer: 0, bank_in: 0, bank_out: 0, sup_cash: 0, exp_other: 0 };
        const inP = d => strv(d) >= ff && strv(d) <= ft;
        const add = (acc, date, dir, amt) => { if (!acc) return; if (inP(date)) { period[acc][dir] += amt; period[acc].n++; } const od = opDate(acc); if (od && strv(date) >= od && strv(date) <= T) { since[acc][dir] += amt; since[acc].n++; } };
        db.sales.filter(x => x.status !== 'void').forEach(x => {
          const sp = window.KPay.of(x), acc = accOf(x.account_id);
          if (sp.transfer) add(acc, x.sale_date, 'in', sp.transfer);
          if (!inP(x.sale_date)) return;
          if (sp.transfer && !acc) none.tf_sales += sp.transfer;
          none.qris_sales += sp.qris; none.card_sales += sp.kartu;
          if (!strv(x.shift_id)) none.cash_nodrawer += sp.tunai;
        });
        db.payments.forEach(p => {
          const amt = int(p.amount), acc = accOf(p.account_id), out = payDir(p) === 'out';
          if (p.method === 'transfer' || p.method === 'qris') { add(acc, p.pay_date, out ? 'out' : 'in', amt); if (!acc && inP(p.pay_date)) none[out ? 'bank_out' : 'bank_in'] += amt; }
          else if (out && strv(p.party_type) === 'supplier' && inP(p.pay_date) && !(p.paid_from === 'kas' || /\[dari kas\]/.test(strv(p.note)))) none.sup_cash += amt;
        });
        db.expenses.filter(x => inP(x.expense_date) && strv(x.paid_from) !== 'kas').forEach(x => { none.exp_other += int(x.amount); });
        const accounts = accs.map(a => {
          const id = strv(a.id), o = { id, bank: strv(a.bank), account_no: strv(a.account_no), holder: strv(a.holder), active: a.active !== false, period: period[id], opening: null };
          if (opDate(id)) { const op = opening[id]; o.opening = { date: strv(op.date), amount: int(op.amount), by: strv(op.by), at: strv(op.at) }; o.since = since[id]; o.balance = o.opening.amount + since[id].in - since[id].out; }
          return o;
        });
        const drawers = db.shifts.filter(x => x.status === 'open').map(x => shiftSummary(db, x)).map(x => ({ shift_id: strv(x.shift_id), cashier: strv(x.cashier), shift_date: strv(x.shift_date), opened_at: strv(x.opened_at), opening_cash: int(x.opening_cash),
          cash_sales: int(x.cash_sales), cash_payments: int(x.cash_payments), cash_in: int(x.cash_in), cash_out: int(x.cash_out), expected: int(x.opening_cash) + int(x.cash_sales) + int(x.cash_payments) + int(x.cash_in) - int(x.cash_out) }));
        const owing = db.customers.filter(c => int(c.debt_balance) > 0).map(c => ({ id: c.id, name: strv(c.name), debt: int(c.debt_balance) })).sort((a, b) => b.debt - a.debt);
        let stock = null;
        if (seeCost) {
          const cat = {}, isMat = p => window.KRepackMock ? window.KRepackMock.isMaterial(p) : strv(p.category).toLowerCase() === 'bahan kemasan';
          stock = { value: 0, items: 0, materials: 0, materials_n: 0 };
          db.products.filter(p => p.active !== false).forEach(p => { const v = Math.max(0, num(p.stock)) * int(p.cost_price), k = strv(p.category) || '—'; stock.value += v; stock.items++; cat[k] = (cat[k] || 0) + v; if (isMat(p)) { stock.materials += v; stock.materials_n++; } });
          stock.value = Math.round(stock.value); stock.materials = Math.round(stock.materials);
          stock.by_cat = Object.keys(cat).map(k => ({ category: k, value: Math.round(cat[k]) })).sort((a, b) => b.value - a.value).slice(0, 30);
        }
        const sup = {}, supOf = k => sup[k] || (sup[k] = { supplier: k, notes: 0, bought: 0, paid: 0, last: '', _no: new Set() });
        db.purchases.forEach(r => { const k = strv(r.supplier); if (INTERNAL_SUP.includes(k.toUpperCase())) return; const x = supOf(k); x.bought += int(r.total); x._no.add(strv(r.purchase_no)); if (strv(r.purchase_date) > x.last) x.last = strv(r.purchase_date); });
        db.payments.forEach(p => { const k = strv(p.supplier); if (k && payDir(p) === 'out') supOf(k).paid += int(p.amount); });
        Object.values(sup).forEach(x => { x.notes = [...x._no].filter(Boolean).length; delete x._no; x.balance = x.bought - x.paid; });
        const nameless = sup[''] || null; delete sup[''];
        const owed = Object.values(sup).filter(x => x.balance > 0).sort((a, b) => b.balance - a.balance), ahead = Object.values(sup).filter(x => x.balance < 0).sort((a, b) => a.balance - b.balance);
        const rets = (db.returns || []).filter(x => x.status === 'approved' && x.kind !== 'pemasok' && inP(x.return_date)).map(x => {
          let lines = []; try { lines = typeof x.lines === 'string' ? JSON.parse(x.lines || '[]') : (x.lines || []); } catch (e) { lines = []; }
          let back = 0; (Array.isArray(lines) ? lines : []).forEach(l => { if (l && l.condition !== 'rusak') { const p = prodById(l.product_id); back += Math.round(num(l.qty) * int(p ? p.cost_price : 0)); } });
          return Object.assign({ date: strv(x.return_date), refund: int(x.refund) }, seeCost ? { restock: back } : {});
        });
        const wibDay = iso => iso ? new Date(Date.parse(iso) + 7 * 3600000).toISOString().slice(0, 10) : '';
        const col = db.approvals.filter(a => a.kind === 'konsultasi' && a.status === 'approved' && inP(wibDay(a.decided_at)));
        return { as_of: T, from: ff, to: ft, see_cost: seeCost, drawers, accounts, none,
          receivables: { total: sum(db.customers, c => int(c.debt_balance)), count: owing.length, top: owing.slice(0, 30) }, stock,
          suppliers: { payable: sum(owed, x => x.balance), prepaid: -sum(ahead, x => x.balance), owed_n: owed.length, ahead_n: ahead.length, owed: owed.slice(0, 50), ahead: ahead.slice(0, 50), nameless: nameless ? { bought: nameless.bought, paid: nameless.paid, notes: nameless.notes } : null },
          pl_extra: { returns: Object.assign({ count: rets.length, refund: sum(rets, x => x.refund), list: rets }, seeCost ? { restock: sum(rets, x => x.restock) } : {}), collected: { count: col.length, total: sum(col, a => int(a.total)) } } };
      }
      case 'set_account_opening': { // v67 (as backend/process.js): the owner's opening balance of a store account; the accountant is told
        needOwner();
        const accId = strv(data.account_id), acc = bankAccounts(db).find(x => strv(x.id) === accId);
        if (!acc) throw E('INVALID', 'Rekening toko tidak dikenal');
        const cur0 = db.settings.acct_opening, cur = cur0 && typeof cur0 === 'object' && !Array.isArray(cur0) ? Object.assign({}, cur0) : {};
        const before = cur[accId] && typeof cur[accId] === 'object' ? cur[accId] : null, label = strv(acc.bank) + ' ' + strv(acc.account_no);
        let txt;
        if (data.clear === true) {
          if (!before) return { unchanged: true, account_id: accId, opening: null };
          delete cur[accId];
          txt = 'Saldo awal ' + label + ' dihapus (sebelumnya ' + rpTxt(before.amount) + ' per ' + strv(before.date) + ') — oleh pemilik ' + u.name;
        } else {
          const date = strv(data.date), amt = Number(data.amount);
          if (!isYmd(date) || date > jktDate() || date < '2000-01-01') throw E('INVALID', 'Tanggal saldo awal: paling lambat hari ini');
          if (data.amount === null || data.amount === undefined || String(data.amount).trim() === '' || !isFinite(amt) || amt < 0 || amt > 1e13) throw E('INVALID', 'Saldo awal tidak valid (0 atau lebih)');
          if (before && strv(before.date) === date && int(before.amount) === Math.round(amt)) return { unchanged: true, account_id: accId, opening: before };
          cur[accId] = { date, amount: Math.round(amt), by: u.name, at: new Date().toISOString() };
          txt = 'Saldo awal ' + label + ': ' + rpTxt(amt) + ' per awal ' + date + (before ? ' (sebelumnya ' + rpTxt(before.amount) + ' per ' + strv(before.date) + ')' : '') + ' — oleh pemilik ' + u.name;
        }
        db.settings.acct_opening = cur;
        logAct(db, u, 'atur_bank', txt, accId, data.clear === true ? 0 : Math.round(Number(data.amount)), 'info');
        notifyR(db, u, ['akuntan'], txt, 'info');
        return { account_id: accId, opening: cur[accId] || null };
      }
      case 'get_sales': {
        if (!isYmd(data.from) || !isYmd(data.to)) throw E('INVALID', 'from/to');
        const inR = d => d >= data.from && d <= data.to;
        const sales = db.sales.filter(s => inR(s.sale_date));
        const inv = new Set(sales.map(s => s.invoice_no));
        return { sales, items: db.items.filter(i => inv.has(i.invoice_no)), payments: db.payments.filter(p => inR(p.pay_date)), purchases: db.purchases.filter(p => inR(p.purchase_date)).map(p => { if (mockCostOk(db, u)) return p; const o = Object.assign({}, p); delete o.cost_price; if (!mockNoteOk(db, u)) delete o.total; return o; }), expenses: db.expenses.filter(x => inR(x.expense_date)), shifts: db.shifts.filter(x => inR(x.shift_date)).map(x => blind(shiftSummary(db, x), u.role)),
          repacks: (db.repacks || []).filter(r => inR(r.repack_date)).map(r => window.KRepackMock.out(r, mockCostOk(db, u) ? 'owner' : u.role)) }; // v67: + the manager / accountant the owner lets see costs
      }
      case 'save_settings': {
        needOwner();
        const s = data.settings || {};
        if (s.paper !== undefined && !['58', '80'].includes(String(s.paper))) throw E('INVALID', 'paper');
        if (s.exit_photo_min_total !== undefined) s.exit_photo_min_total = Math.max(0, int(s.exit_photo_min_total));
        if (s.exit_photo_min_qty !== undefined) s.exit_photo_min_qty = Math.max(0, num(s.exit_photo_min_qty));
        if (s.wa_shop_number !== undefined) s.wa_shop_number = String(s.wa_shop_number || '').replace(/[^\d+]/g, '').slice(0, 20);
        if (s.survey_voice !== undefined) s.survey_voice = !(s.survey_voice === false || s.survey_voice === 'false');
        ['wa_manager_number', 'wa_owner_number'].forEach(k => { if (s[k] !== undefined) s[k] = String(s[k] || '').replace(/[^\d+]/g, '').slice(0, 20); });
        if (s.report_time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.report_time))) throw E('INVALID', 'report_time HH:MM');
        if (s.invoice_due_days !== undefined) { const dd = Math.round(num(s.invoice_due_days)); if (!(dd >= 0 && dd <= 120)) throw E('INVALID', 'Jatuh tempo faktur 0–120 hari'); s.invoice_due_days = dd; }
        if (s.akuntan_sees_cost !== undefined) s.akuntan_sees_cost = s.akuntan_sees_cost === true;
        if (s.opname_every_days !== undefined) { const od = Math.round(num(s.opname_every_days)); if (!(od >= 7 && od <= 180)) throw E('INVALID', 'Stok opname setiap 7–180 hari'); s.opname_every_days = od; }
        ['store_lat', 'store_lng'].forEach(k => { if (s[k] !== undefined) s[k] = num(s[k]); });
        if (s.require_device_location !== undefined) s.require_device_location = s.require_device_location === true;
        if (s.bank_accounts !== undefined) s.bank_accounts = (Array.isArray(s.bank_accounts) ? s.bank_accounts : []).map(a => ({ id: strv(a.id), bank: strv(a.bank).slice(0, 40), account_no: strv(a.account_no).slice(0, 40), holder: strv(a.holder).slice(0, 80), active: a.active !== false })).filter(a => a.id);
        if (AGREED_KEYS.some(k => s[k] !== undefined && JSON.stringify(s[k]) !== JSON.stringify(setting(db, k)))) throw E('AGREEMENT_REQUIRED', 'Batas retur diubah lewat kesepakatan pemilik dan manajer (propose_agreement)');
        const changedKeys = Object.keys(s).filter(k => JSON.stringify(s[k]) !== JSON.stringify(db.settings[k]));
        Object.assign(db.settings, s);
        if (changedKeys.length) logAct(db, u, 'pengaturan', 'Pengaturan diubah: ' + changedKeys.join(', '), '', 0, 'info');
        return { settings: db.settings };
      }
      case 'set_discount_limit': { // v64: the manager sets it too; the owner is told (as on the server)
        if (!isAppr(u)) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        const pct = Math.round(num(data.max_discount_pct) * 10) / 10;
        if (!(pct > 0 && pct <= 50)) throw E('INVALID', 'Batas diskon 0,1–50 %');
        const before = maxDiscountPct(db);
        db.settings.max_discount_pct = pct;
        if (pct !== before) {
          const txt = 'Batas diskon tanpa persetujuan diubah oleh ' + (owner ? 'pemilik ' : 'manajer ') + u.name + ': ' + fmtN(before) + '% → ' + fmtN(pct) + '%';
          logAct(db, u, 'pengaturan', txt, 'max_discount_pct', 0, 'warn');
          if (!owner) notifyR(db, u, ['owner'], txt, 'warn');
        }
        return { settings: db.settings };
      }
      case 'report_tamper': {
        // v36: with the front-camera photo (two calls, same shot_id) — shared/tamper-guard.js keeps the demo servers identical
        if (!window.KGuard) throw E('SERVER', 'tamper-guard not loaded');
        const r = KGuard.mock.report(db, u, data, body.__shotPhoto || '', { owner, now: new Date().toISOString(), date: jktDate(), lock: () => { if (!isLockedAcct(u.name)) db.settings.locked_accounts = lockedSet().concat([u.name.toLowerCase()]); }, logAct: (k, sm, lv) => logAct(db, u, k, sm, u.name, 0, lv) });
        db._dirty = true;
        return r;
      }
      case 'list_tamper_shots': {
        needOwner();
        return { shots: window.KGuard ? KGuard.mock.list(db, data) : [] };
      }
      case 'clear_tamper': {
        needOwner();
        const tn = String(data.name || '').trim().toLowerCase();
        const tu = db.users.find(v => v.name.toLowerCase() === tn);
        if (!tu) throw E('NOT_FOUND', 'Pengguna tidak ditemukan');
        db.settings.locked_accounts = lockedSet().filter(x => x !== tn);
        tu.fail_count = 0; tu.locked_until = '';
        logAct(db, u, 'tamper', 'Pemilik membuka kunci akun ' + tu.name, tu.name, 0, 'warn'); db._dirty = true;
        return { user: { name: tu.name, role: tu.role, active: tu.active !== false } };
      }
      // v28: owner + manager may SUSPEND any non-owner account; only the owner re-enables. No one suspends their own account.
      case 'set_account_active': {
        if (!(owner || u.role === 'manager')) throw E('FORBIDDEN', 'Hanya pemilik atau manajer');
        if (typeof data.active !== 'boolean') throw E('INVALID', 'Status aktif wajib true atau false');
        let target = null;
        if (data.id !== undefined && data.id !== null && String(data.id) !== '') target = db.users.find(v => String(v.id) === String(data.id));
        else { const tn = String(data.name || '').trim().toLowerCase(); if (tn) target = db.users.find(v => v.name.toLowerCase() === tn); }
        if (!target) throw E('NOT_FOUND', 'Pengguna tidak ditemukan');
        const selfTarget = target === u || target.name.toLowerCase() === u.name.toLowerCase();
        if (data.active === false) {
          if (selfTarget) throw E('FORBIDDEN', 'Tidak bisa menonaktifkan akun sendiri');
          if (u.role === 'manager' && target.role === 'owner') throw E('FORBIDDEN', 'Manajer tidak boleh menonaktifkan akun pemilik');
          if (target.role === 'owner' && db.users.filter(v => v.role === 'owner' && v.active !== false).length <= 1) throw E('INVALID', 'Harus ada minimal satu pemilik aktif');
        } else {
          if (!owner) throw E('FORBIDDEN', 'Hanya pemilik yang boleh mengaktifkan kembali akun');
        }
        target.active = data.active; db._dirty = true;
        logAct(db, u, data.active ? 'akun_aktif' : 'akun_nonaktif', (data.active ? 'Mengaktifkan kembali akun ' : 'Menonaktifkan akun ') + target.name + ' (' + target.role + ') oleh ' + u.name, target.name, 0, 'warn');
        return { user: { name: target.name, role: target.role, active: data.active, must_change: target.must_change === true } };
      }
      case 'save_user': {
        if (u.role !== 'owner') {
          if (u.role !== 'manager') throw E('FORBIDDEN', 'Owner only');
          const t0 = db.users.find(v => v.name.toLowerCase() === String(data.name || '').trim().toLowerCase());
          // v36: the manager may also RENAME the existing accountant account (name only — not its role, active state or a new account)
          const akRename = t0 && t0.role === 'akuntan' && data.role === 'akuntan' && strv(data.new_name) !== '' && (data.active === undefined || (data.active !== false) === (t0.active !== false));
          if (!akRename && (!['kasir', 'sales'].includes(data.role) || (t0 && !['kasir', 'sales'].includes(t0.role)))) throw E('FORBIDDEN', 'Manajer hanya mengatur akun kasir dan sales (akun akuntan: hanya ganti nama)');
        }
        const name = personName(data.name);
        if (!name) throw E('INVALID', strv(data.name) ? 'Nama pengguna hanya boleh huruf, spasi dan . \' -' : 'Nama wajib');
        const role = ['owner', 'manager', 'sales', 'akuntan'].includes(data.role) ? data.role : 'kasir';
        if (data.pin_hash && !/^[0-9a-f]{64}$/.test(data.pin_hash)) throw E('INVALID', 'pin_hash');
        let x = db.users.find(v => v.name.toLowerCase() === name.toLowerCase());
        const active = data.active === undefined ? true : !!data.active;
        // v28: re-enabling a suspended account is owner-only, and no one suspends their own account, even through save_user.
        if (x && x.active === false && active && u.role !== 'owner') throw E('FORBIDDEN', 'Hanya pemilik yang boleh mengaktifkan kembali akun');
        if (x && x === u && !active && x.active !== false) throw E('FORBIDDEN', 'Tidak bisa menonaktifkan akun sendiri');
        // another person takes this account / role (new name): a new temporary PIN made with the new name
        let newName = '';
        if (strv(data.new_name)) {
          newName = personName(data.new_name);
          if (!x) throw E('NOT_FOUND', 'Pengguna tidak ditemukan');
          if (!newName) throw E('INVALID', 'Nama baru hanya boleh huruf, angka, spasi dan . , \' -');
          if (db.users.some(v => v !== x && v.name.toLowerCase() === newName.toLowerCase())) throw E('INVALID', 'Nama sudah dipakai');
          if (!isHash(data.pin_hash)) throw E('INVALID', 'Ganti nama butuh PIN sementara baru');
          if (openShiftOf(db, x.name)) throw E('INVALID', 'Tutup kas ' + x.name + ' dulu sebelum ganti nama');
        }
        const ownersLeft = db.users.filter(v => v !== x && v.role === 'owner' && v.active).length + (role === 'owner' && active ? 1 : 0);
        if (!ownersLeft) throw E('INVALID', 'At least one active owner required');
        if (db.users.some(v => isHash(v.master_hash) && v.master_hash === data.pin_hash)) throw E('INVALID', 'PIN tidak valid');
        // v16: a PIN set by the owner for someone else is temporary — that person chooses their own at the next login
        const newPin = isHash(data.pin_hash) && (!x || data.pin_hash !== x.pin_hash), self = !!x && x === u;
        if (!x) {
          if (!data.pin_hash) throw E('INVALID', 'pin_hash required');
          x = { name, role, pin_hash: data.pin_hash, active, must_change: !self };
          db.users.push(x);
          logAct(db, u, 'pengguna', 'Pengguna baru: ' + x.name + ' (' + x.role + (x.active ? '' : ', nonaktif') + ')', x.name, 0, 'warn');
        } else {
          const oldName = x.name;
          x.role = role; x.active = active; if (data.pin_hash) x.pin_hash = data.pin_hash; if (newName) x.name = newName;
          if (newPin) Object.assign(x, { must_change: !self, fail_count: 0, locked_until: '' });
          if (newName) logAct(db, u, 'pengguna', 'Ganti orang: ' + oldName + ' → ' + newName + ' (' + role + '), PIN sementara baru', newName, 0, 'warn');
          else logAct(db, u, 'pengguna', 'Pengguna diubah: ' + x.name + ' (' + x.role + (x.active ? '' : ', nonaktif') + ')' + (data.pin_hash ? ', PIN diganti' : ''), x.name, 0, 'warn');
        }
        return { user: { name: x.name, role: x.role, active: x.active, must_change: x.must_change === true } };
      }
      default: throw E('INVALID', 'Unknown action ' + action);
    }
  }

  /* ---- Field sales (v8): handled by shared/field-mock.js (loaded in mock mode only) ---- */
  const FIELD_ACTIONS = ['field_bootstrap', 'day_start', 'day_end', 'track', 'check_in', 'field_order', 'list_field', 'update_order', 'set_product_image', 'product_images', 'link_shop', 'orders_map', 'shop_photos', 'street_returns', 'street_return_set']; // v36
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
      const sc = document.createElement('script'); sc.src = 'shared/field-mock.js';
      const done = () => res(); sc.onload = done; sc.onerror = done; setTimeout(done, 3000);
      document.head.appendChild(sc);
    });
  }
  let extLoad = null;
  // v17 attendance: the same core as the server (backend/attendance/att-core.js) + demo data (shared/att-mock.js), loaded on first use
  let attLoad = null;
  function loadAttMock() {
    if (window.KAttMock && window.KAtt) return Promise.resolve();
    const one = src => new Promise(res => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
    return attLoad || (attLoad = one('backend/attendance/att-core.js').then(() => one('shared/att-mock.js')));
  }
  // Phase 3 chat: the same core as the server (backend/chat/chat-core.js) + demo handler (shared/chat-mock.js)
  const CHAT_ACTIONS = ['chat_bootstrap', 'chat_poll', 'chat_send', 'chat_set_retention', 'notice_close']; // v38: + notice_close (Tutup)
  let chatLoad = null;
  function loadChatMock() {
    if (window.KChat && window.KChatMock) return Promise.resolve();
    const one = src => new Promise(res => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
    return chatLoad || (chatLoad = one('backend/chat/chat-core.js').then(() => one('shared/chat-mock.js')));
  }
  async function request(body, opts = {}) {
    await ensure();
    if (!extLoad) extLoad = loadExtFieldMock();
    await extLoad;
    await loadRepackMock('shared/repack-mock.js');
    if (/^(att_|worker_)/.test(body.action)) await loadAttMock();
    await sleep(30 + Math.random() * 50);
    let forced = false; try { forced = localStorage.getItem('kmock.offline') === '1'; } catch (e) { }
    if (!navigator.onLine || forced) throw new NetError('offline (mock)');
    const db = load();
    db.approvals = db.approvals || []; db.photos = db.photos || []; db.expenses = db.expenses || []; db.shifts = db.shifts || []; db.cash_moves = db.cash_moves || [];
    // chat is append-only text/images: it bypasses the POS tamper scan (a message may legitimately contain symbols)
    if (CHAT_ACTIONS.includes(body.action)) {
      await loadChatMock();
      if (!window.KChatMock) throw E('SERVER', 'Chat mock not loaded');
      const cdb = load(); // fresh read AFTER the async load: the background chat poll must never save a stale snapshot over another call's writes
      const out = window.KChatMock.handle(cdb, body, E);
      if (cdb._dirty) { delete cdb._dirty; save(cdb); }
      return out;
    }
    if (ensureField(db)) save(db);
    if (ensureV12(db)) save(db);
    if (ensureV16(db)) save(db);
    let res;
    let __codeHit = '';
    const __tp = window.KGuard ? KGuard.mock.takePhoto(body) : { body, photo: '' }; body = __tp.body; // v36: the tamper photo is not text
    if (body.data && typeof body.data === 'object' && !/^(scan_|att_mark|worker_enroll)/.test(body.action)) { __codeHit = scanCodeAttempt(body.data, 0); body = Object.assign({}, body, { data: JSON.parse(JSON.stringify(body.data)) }); cleanInput(body.data, 0); }
    body.__codeHit = __codeHit; body.__shotPhoto = __tp.photo;
    db.returns = db.returns || [];
    const snap = new Map((db.products || []).map(p => [p.id, { stock: num(p.stock), shop: shopOf(p) }]));
    db._shopSet = {};
    try {
      res = opts.field || FIELD_ACTIONS.includes(body.action) ? fieldHandle(db, body) : handle(db, body);
      const keepImgs = db._keepImgs; delete db._keepImgs; // v36: scanned images → IndexedDB (demo twin of R2)
      if (keepImgs) await flushPhotoImgs(keepImgs);
      if (res && res._img) { const src = await photoImg(res._img); if (!src) throw E('NOT_FOUND', 'Foto tidak ditemukan'); res = { photo_id: res.photo_id, mime: (src.match(/^data:([^;,]+)/) || [])[1] || 'image/jpeg', data_url: src }; }
      const role = db._role || (db.users.find(x => x.name.toLowerCase() === String(body.user || '').toLowerCase() && x.pin_hash === body.pin_hash) || {}).role;
      normShop(db, snap);
      if (res && res.product && res.product.id != null && ['change_price', 'stock_adjust', 'set_repack', 'decide_approval'].includes(body.action)) res.product = prodOut(res.product);
      const dirty = db._dirty; ['_dirty', '_role', '_shopSet', '_saveErr'].forEach(k => delete db[k]);
      if (!READ_ONLY.includes(body.action) || dirty) save(db);
      stripRole = role || '';
      // v17: the accountant AND the manager see purchase prices only when the owner allows it; profit never
      const akCost = (role === 'akuntan' || role === 'manager') && (load().settings || {}).akuntan_sees_cost === true;
      res = Object.assign({ ok: true }, role === 'owner' || ['users', 'setup'].includes(body.action) ? res : akCost ? stripProfit(res) : strip(res));
    } catch (e) {
      if (e.attState) { const fresh = load(); fresh.att = e.attState; save(fresh); } // v17: refused check-ins stay recorded
      if (e.code === 'TAMPER') { const fresh = load(); fresh.settings = fresh.settings || {}; fresh.settings.locked_accounts = db.settings.locked_accounts; save(fresh); }
      if (db._saveErr) { // wrong PIN: the counter / lock is kept (only the user row changed)
        const fresh = load(); const uu = (fresh.users || []).find(x => x.name.toLowerCase() === String(body.user || '').toLowerCase());
        const src = db.users.find(x => x.name.toLowerCase() === String(body.user || '').toLowerCase());
        if (uu && src) { uu.fail_count = src.fail_count; uu.locked_until = src.locked_until; save(fresh); }
      }
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
    const products = P.map((r, i) => ({ id: i + 1, sku: '89910' + String(70001 + i * 37).padStart(7, '0') + (i % 10), name: r[0], category: r[1], unit: r[2], cost_price: r[3], retail_price: r[4], wholesale_price: r[5], wholesale_min_qty: r[6], stock: r[7], min_stock: r[8], active: true, notes: '' }));
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
        const invoice_no = `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}/${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}/${++inv}`; // v68
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
    // Showcase the shelf-life colour in demo: one short-dated food (red) and one no-expiry item (gelas/madu style).
    const cokShort = prodRe(/Cokelat Arab Kerang/); if (cokShort) cokShort.exp_date = addDays(T, 100);
    const noExp = prodRe(/Tasbih/); if (noExp) noExp.exp_none = true;
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
  return { request, ensure, reset() { try { localStorage.removeItem(DBKEY); } catch (e) { } ready = null; }, DBKEY };
})();
