'use strict';
/* Khair Sales — demo/mock backend (field rep app). Mirrors backend/process.js; same localStorage DB key. Loaded before the main script; used only in ?mock=1 / demo mode. */
const MockServer = (() => {
  const DBKEY = 'kmock.db';
  const COST_KEYS = ['cost_price', 'total_cost', 'profit', 'line_profit', 'cost'];
  const CHANNELS = ['toko', 'whatsapp', 'shopee', 'tiktok', 'tokopedia', 'web', 'lainnya'];
  const READ_ONLY = ['users', 'login', 'bootstrap', 'get_sales', 'check_approval', 'list_approvals', 'list_photos'];
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
  function priceSale(db, data) {
    if (!Array.isArray(data.items) || !data.items.length) throw E('INVALID', 'items required');
    if (!['tunai', 'transfer', 'qris', 'hutang'].includes(data.payment_method)) throw E('INVALID', 'payment_method');
    const cust = data.customer_id ? db.customers.find(c => c.id === Number(data.customer_id)) : null;
    if (data.customer_id && !cust) throw E('NOT_FOUND', 'customer');
    const lines = data.items.map(it => {
      const p = db.products.find(x => x.id === Number(it.product_id));
      if (!p) throw E('NOT_FOUND', 'product ' + it.product_id);
      const qty = roundQty(it.qty);
      if (!(qty > 0)) throw E('INVALID', 'qty must be > 0');
      const unit_price = Math.max(0, int(it.unit_price));
      const line_total = Math.round(qty * unit_price), line_cost = Math.round(qty * p.cost_price);
      return { p, qty, unit_price, price_type: it.price_type === 'grosir' ? 'grosir' : 'eceran', line_total, line_cost };
    });
    const subtotal = sum(lines, l => l.line_total);
    const discount = Math.min(subtotal, Math.max(0, int(data.discount)));
    const total = subtotal - discount;
    const total_cost = sum(lines, l => l.line_cost);
    const paid = Math.max(0, int(data.paid_amount));
    const debt = Math.max(0, total - paid);
    if (debt > 0 && !cust) throw E('INVALID', 'Debt requires customer_id');
    return { cust, lines, subtotal, discount, total, total_cost, paid, debt, sale_date: isYmd(data.sale_date) ? data.sale_date : jktDate() };
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
    return Object.assign({}, sh, { sales_count: sales.length, sales_total: sum(sales, x => int(x.total)), cash_sales, cash_payments, cash_in, cash_out, moves: JSON.stringify(list),
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
    db.items.filter(i => i.invoice_no === s.invoice_no).forEach(i => { const p = db.products.find(x => x.id === i.product_id); if (p) p.stock = roundQty(p.stock + i.qty); });
    const c = s.customer_id ? db.customers.find(x => x.id === s.customer_id) : null;
    if (c && s.debt_amount) c.debt_balance = Math.max(0, int(c.debt_balance) - s.debt_amount);
    return s;
  }
  function newApproval(db, u, f) {
    const ap = Object.assign({ request_id: 'APR-' + String(nextId(db, 'approval')).padStart(4, '0'), client_id: '', created_at: jktISO(), cashier: u.name, customer_id: null, customer_name: '', customer_debt_before: 0, total: 0, debt_amount: 0, summary: '', status: 'pending', decided_by: '', decided_at: '', note: '', kind: 'credit', ref: '', payload: '', approver_role: 'manager' }, f);
    db.approvals.push(ap);
    return ap;
  }
  const nameTokens = s => norm(s).replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean).map(w => w === 'gr' ? 'g' : w);
  function nameScore(a, b) { const A = nameTokens(a), B = new Set(nameTokens(b)); return A.length ? A.filter(w => B.has(w)).length / A.length : 0; }
  const blankProduct = () => ({ sku: '', name: '', category: '', unit: 'pcs', cost_price: 0, retail_price: 0, wholesale_price: 0, wholesale_min_qty: 0, stock: 0, min_stock: 0, active: true, notes: '' });

  /* ---- v11 as on the server (same code as the cashier app's mock): data.device rows, activity row for a new device ---- */
  const str = v => v === undefined || v === null ? '' : String(v).trim();
  const money = v => Math.round(num(v));
  const fmtN = v => String(Math.round(num(v) * 1000) / 1000);
  function rand(n) { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }
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
    const u = db.users.find(x => x.active !== false && x.name.toLowerCase() === String(user || '').trim().toLowerCase());
    if (window.KhairFieldMock && KhairFieldMock.actions.includes(action)) {
      // the field workflow (backend/field, v16): lock, owner master code and own-PIN rules; input cleaned (data: URLs kept)
      if (!u) throw E('BAD_PIN', 'Nama atau PIN salah');
      if (Date.parse(u.locked_until) > Date.now()) throw E('LOCKED', 'Akun dikunci sementara karena PIN salah berkali-kali');
      const fMaster = /^[a-f0-9]{64}$/.test(String(pin_hash || '')) && db.users.some(x => x.active !== false && x.role === 'owner' && x.master_hash && x.master_hash === pin_hash);
      if (u.pin_hash !== pin_hash && !fMaster) throw E('BAD_PIN', 'Nama atau PIN salah');
      if (u.must_change === true && !fMaster) throw E('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
      const fdata = JSON.parse(JSON.stringify(data)); cleanFieldInput(fdata, 0); // (a copy: the server gets it over the network)
      return KhairFieldMock.handle(action, fdata, { name: u.name, role: u.role }, db, { jktDate: d => jktDate(d == null ? new Date() : d), jktISO: d => jktISO(d == null ? new Date() : d) });
    }
    // v16 main API, as on the server: lock after 5 wrong PINs (15 min), owner master code, own PIN at first login
    if (!u) throw E('BAD_PIN', 'Nama atau PIN salah');
    const isHex64 = h => /^[0-9a-f]{64}$/.test(String(h || ''));
    const lockMsg = until => 'Terlalu banyak PIN salah. Coba lagi jam ' + new Date(Date.parse(until) + 7 * 3600000).toISOString().slice(11, 16) + ' WIB';
    if (Date.parse(u.locked_until) > Date.now()) throw E('LOCKED', lockMsg(u.locked_until), { locked_until: String(u.locked_until) });
    const viaMaster = isHex64(pin_hash) && u.pin_hash !== pin_hash && db.users.some(x => x.active !== false && x.role === 'owner' && isHex64(x.master_hash) && x.master_hash === pin_hash);
    if (u.pin_hash !== pin_hash && !viaMaster) {
      const fc = num(u.fail_count) + 1, until = fc >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : '';
      u.fail_count = until ? 0 : fc; u.locked_until = until; save(db);
      if (until) throw E('LOCKED', lockMsg(until), { locked_until: until });
      throw E('BAD_PIN', 'Nama atau PIN salah' + (fc >= 3 ? ' (' + (5 - fc) + ' kali lagi, lalu akun dikunci 15 menit)' : ''));
    }
    if ((num(u.fail_count) > 0 || str(u.locked_until)) && !['change_pin', 'set_master', 'save_user'].includes(action)) { u.fail_count = 0; u.locked_until = ''; dirty = true; }
    if (u.must_change === true && !viaMaster && !['login', 'change_pin', 'users', 'device_ping'].includes(action)) throw E('PIN_CHANGE_REQUIRED', 'Buat PIN baru dulu sebelum memakai aplikasi');
    if (action === 'change_pin') {
      const h = data.new_pin_hash;
      if (!isHex64(h)) throw E('INVALID', 'PIN baru tidak valid');
      if (h === u.pin_hash) throw E('INVALID', 'PIN baru harus berbeda dari PIN lama');
      if (viaMaster && u.role === 'owner') throw E('FORBIDDEN', 'PIN pemilik hanya bisa diganti dengan PIN pemilik sendiri');
      if (db.users.some(x => x.active !== false && isHex64(x.master_hash) && x.master_hash === h)) throw E('INVALID', 'PIN baru tidak valid');
      Object.assign(u, { pin_hash: h, must_change: viaMaster, fail_count: 0, locked_until: '' });
      logAct(db, u, 'ganti_pin', viaMaster ? 'PIN ' + u.name + ' direset dengan kode pemilik (wajib ganti saat masuk)' : u.name + ' mengganti PIN sendiri', u.name, 0, viaMaster ? 'warn' : 'info');
      return { must_change: viaMaster };
    }
    if (action === 'login') {
      if (viaMaster) logAct(db, u, 'masuk_master', 'Masuk ke akun ' + u.name + ' (' + u.role + ') dengan kode pemilik', u.name, 0, 'warn');
      return { user: { name: u.name, role: u.role }, must_change: u.must_change === true && !viaMaster, via_master: viaMaster };
    }
    if (action !== 'device_ping') deviceTouch(db, u, data.device, false);
    const owner = u.role === 'owner';
    // v19 anti-tamper: a clear code attempt locks a non-owner (sales) account; only the owner opens it, from the owner app.
    db.settings = db.settings || {};
    const lockedSet = () => Array.isArray(db.settings.locked_accounts) ? db.settings.locked_accounts.map(x => String(x).toLowerCase()) : [];
    const isLockedAcct = n => lockedSet().indexOf(String(n).trim().toLowerCase()) >= 0;
    const codeHit = body.__codeHit || '';
    if (codeHit && !owner) { if (!isLockedAcct(u.name)) db.settings.locked_accounts = lockedSet().concat([u.name.toLowerCase()]); logAct(db, u, 'tamper', 'Percobaan menulis kode — akun dikunci: "' + codeHit + '" (aksi ' + body.action + ')', u.name, 0, 'danger'); const er = E('TAMPER', 'Input tidak sah. Akun dikunci, hanya pemilik yang membuka.'); er.extra = { locked: true }; throw er; }
    if (codeHit && owner) { logAct(db, u, 'tamper', 'Input ditolak (karakter kode) (aksi ' + body.action + ')', u.name, 0, 'warn'); dirty = true; throw E('INVALID', 'Input tidak sah (karakter kode tidak diperbolehkan)'); }
    if (!owner && isLockedAcct(u.name) && !['login', 'users', 'device_ping', 'change_pin', 'report_tamper'].includes(body.action)) { const er = E('TAMPER_LOCKED', 'Akun dikunci setelah percobaan tidak sah. Hanya pemilik yang membuka.'); er.extra = { locked: true }; throw er; }
    const needOwner = () => { if (!owner) throw E('FORBIDDEN', 'Owner only'); };
    const prodById = id => db.products.find(p => p.id === Number(id));
    const custById = id => db.customers.find(c => c.id === Number(id));

    switch (action) {
      case 'login': return { user: { name: u.name, role: u.role }, tamper_locked: u.role !== 'owner' && isLockedAcct(u.name) };
      case 'report_tamper':
        if (owner) { logAct(db, u, 'tamper', 'Pemilik: percobaan kode terdeteksi', u.name, 0, 'warn'); dirty = true; return { locked: false }; }
        if (!isLockedAcct(u.name)) db.settings.locked_accounts = lockedSet().concat([u.name.toLowerCase()]);
        logAct(db, u, 'tamper', 'Percobaan menulis kode — akun dikunci (' + String(data.where || '').slice(0, 60) + ')', u.name, 0, 'danger'); dirty = true;
        return { locked: true };
      case 'device_ping': {
        if (!deviceTouch(db, u, data.device, true)) throw E('INVALID', 'device.id tidak valid');
        return { require_location: db.settings.require_device_location === true, server_time: new Date().toISOString() };
      }
      case 'bootstrap': return { products: db.products, customers: db.customers, settings: db.settings, users: db.users.map(x => ({ name: x.name, role: x.role, active: x.active })), server_time: new Date().toISOString(), approvals_pending: ['owner', 'manager'].includes(u.role) ? db.approvals.filter(x => x.status === 'pending').length : 0,
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
        if (!shift && u.role !== 'owner' && db.settings.require_shift !== false) throw E('SHIFT_REQUIRED', 'Open the cash drawer (open_shift) first');
        const P = priceSale(db, data);
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
        const st = db.settings;
        const minTotal = int(st.exit_photo_min_total ?? 1000000), minQty = num(st.exit_photo_min_qty ?? 20);
        const exitReq = (minTotal > 0 && P.total >= minTotal) || (minQty > 0 && P.lines.some(l => l.qty >= minQty));
        const { cust, lines, subtotal, discount, total, total_cost, paid, debt, sale_date } = P;
        const sale = {
          id: nextId(db, 'sale'), invoice_no: invoiceNo(db, sale_date), sale_date, sale_time: data.sale_time || jktISO(),
          cashier: u.name, customer_id: cust ? cust.id : null, customer_name: cust ? cust.name : (data.customer_name || 'Umum'),
          customer_type: cust ? cust.type : 'eceran', subtotal, discount, total, total_cost, profit: total - total_cost,
          payment_method: data.payment_method, paid_amount: paid, debt_amount: debt, status: 'ok',
          survey: JSON.stringify(data.survey_consent && Array.isArray(data.survey) ? data.survey.filter(x => x && String(x.a || '').trim()).map(x => ({ q: String(x.q), a: String(x.a) })) : []),
          notes: String(data.notes || ''), client_id: cid, approved_by, exit_photo: exitReq ? 'required' : '', exit_match: '',
          channel: CHANNELS.includes(data.channel) ? data.channel : 'toko', promo_code: String(data.promo_code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''), shift_id: shift ? shift.shift_id : ''
        };
        if (usedApproval) usedApproval.status = 'used';
        db.sales.push(sale);
        const touched = new Map();
        for (const l of lines) {
          db.items.push({ invoice_no: sale.invoice_no, sale_date, product_id: l.p.id, sku: l.p.sku, name: l.p.name, qty: l.qty, unit_price: l.unit_price, price_type: l.price_type, cost_price: l.p.cost_price, line_total: l.line_total, line_profit: l.line_total - l.line_cost, customer_name: sale.customer_name });
          l.p.stock = roundQty(l.p.stock - l.qty);
          touched.set(l.p.id, l.p);
        }
        if (cust) cust.debt_balance = int(cust.debt_balance) + debt;
        const { id: _omit, ...saleOut } = sale;
        return { invoice_no: sale.invoice_no, sale: saleOut, stock: [...touched.values()].map(p => ({ product_id: p.id, stock: p.stock })), duplicate: false, exit_photo_required: exitReq };
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
      case 'check_approval': {
        const ap = db.approvals.find(x => x.request_id === data.request_id);
        if (!ap) throw E('NOT_FOUND', 'approval');
        return { approval: ap };
      }
      case 'list_approvals': {
        if (!['owner', 'manager'].includes(u.role)) throw E('FORBIDDEN', 'Owner/manager only');
        return { approvals: db.approvals.filter(x => x.status === 'pending').map(x => Object.assign({}, x, { can_decide: x.approver_role !== 'owner' || u.role === 'owner' })) };
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
        Object.assign(ap, { status: data.decision, decided_by: u.name, decided_at: jktISO(), note: String(data.note || '') });
        return Object.assign({ approval: ap }, out);
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
      case 'list_photos': {
        if (!isYmd(data.from) || !isYmd(data.to)) throw E('INVALID', 'from/to');
        return { photos: db.photos.filter(x => x.photo_date >= data.from && x.photo_date <= data.to) };
      }
      case 'void_sale': {
        needOwner();
        if (!String(data.reason || '').trim()) throw E('INVALID', 'reason required');
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
        return { request_id: approval.request_id, approval };
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
        if (direct) {
          for (const [f, ch] of Object.entries(changes)) p[f] = ch.to;
          newApproval(db, u, Object.assign(fields, { status: 'auto', decided_by: u.name, decided_at: jktISO() }));
          return { applied: true, product: p };
        }
        const approval = newApproval(db, u, fields);
        return { applied: false, request_id: approval.request_id, approval };
      }
      case 'open_shift': {
        const ex = openShiftOf(db, u.name);
        if (ex) return { shift: Object.assign(blind(shiftSummary(db, ex), u.role), { already: true }) };
        if (data.opening_cash === undefined || data.opening_cash === '' || int(data.opening_cash) < 0) throw E('INVALID', 'opening_cash');
        const sh = { shift_id: 'SH-' + String(nextId(db, 'shift')).padStart(4, '0'), cashier: u.name, shift_date: isYmd(data.shift_date) ? data.shift_date : jktDate(), opened_at: jktISO(), closed_at: '', status: 'open', opening_cash: int(data.opening_cash), counted_cash: null, difference: null, note: String(data.note || '') };
        db.shifts.push(sh);
        return { shift: blind(shiftSummary(db, sh), u.role) };
      }
      case 'cash_move': {
        const sh = openShiftOf(db, u.name); if (!sh) throw E('SHIFT_REQUIRED', 'No open shift');
        if (!['in', 'out'].includes(data.type)) throw E('INVALID', 'type');
        const amount = int(data.amount); if (amount <= 0) throw E('INVALID', 'amount');
        if (!String(data.note || '').trim()) throw E('INVALID', 'note required');
        db.cash_moves.push({ id: nextId(db, 'move'), shift_id: sh.shift_id, type: data.type, amount, note: String(data.note).trim(), user: u.name, time: jktISO() });
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
          return { product: p };
        }
        const p = Object.assign(productFields(data, blankProduct()), { id: nextId(db, 'product'), name, stock: roundQty(data.stock || 0) });
        db.products.push(p);
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
        return { created, updated, skipped };
      }
      case 'stock_adjust': {
        needOwner();
        const p = prodById(data.product_id); if (!p) throw E('NOT_FOUND', 'product');
        if (!String(data.reason || '').trim()) throw E('INVALID', 'reason required');
        if (!Number.isFinite(Number(data.new_stock))) throw E('INVALID', 'new_stock');
        const diff = roundQty(roundQty(data.new_stock) - num(p.stock));
        db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: jktDate(), supplier: ADJUST_SUPPLIER, product_id: p.id, name: p.name, qty: diff, cost_price: p.cost_price, total: 0, note: String(data.reason), user: u.name });
        p.stock = roundQty(data.new_stock);
        return { product: p };
      }
      case 'save_customer': {
        const name = String(data.name || '').trim();
        if (!name) throw E('INVALID', 'name required');
        const fields = { name, phone: String(data.phone || '').trim(), type: data.type === 'grosir' ? 'grosir' : 'eceran', address: String(data.address || ''), notes: String(data.notes || '') };
        if (data.id) { const c = custById(data.id); if (!c) throw E('NOT_FOUND', 'customer'); Object.assign(c, fields); return { customer: c }; }
        const c = Object.assign({ id: nextId(db, 'customer') }, fields, { debt_balance: 0 });
        db.customers.push(c);
        return { customer: c };
      }
      case 'receive_payment': {
        const c = custById(data.customer_id); if (!c) throw E('NOT_FOUND', 'customer');
        const amount = int(data.amount);
        if (amount <= 0) throw E('INVALID', 'amount must be > 0');
        if (amount > int(c.debt_balance)) throw E('INVALID', 'amount exceeds debt');
        const psh = openShiftOf(db, u.name);
        const payment = { id: nextId(db, 'payment'), pay_date: isYmd(data.pay_date) ? data.pay_date : jktDate(), customer_id: c.id, customer_name: c.name, amount, method: String(data.method || 'tunai'), note: String(data.note || ''), cashier: u.name, shift_id: psh ? psh.shift_id : '' };
        db.payments.push(payment);
        c.debt_balance = int(c.debt_balance) - amount;
        return { payment, customer: c };
      }
      case 'save_purchase': {
        if (!Array.isArray(data.items) || !data.items.length) throw E('INVALID', 'items required');
        const photo = data.photo_id ? db.photos.find(x => x.photo_id === data.photo_id && x.kind === 'masuk') : null;
        if (data.photo_id && !photo) throw E('INVALID', 'photo_id not found');
        if (!photo && db.settings.require_purchase_photo !== false) throw E('INVALID', 'Purchase photo (photo_id) required');
        const pdate = isYmd(data.purchase_date) ? data.purchase_date : jktDate();
        const checked = data.items.map(it => {
          const p = prodById(it.product_id); if (!p) throw E('NOT_FOUND', 'product ' + it.product_id);
          const qty = roundQty(it.qty); if (!(qty > 0)) throw E('INVALID', 'qty must be > 0');
          return { p, qty, cost: Math.max(0, int(it.cost_price)) };
        });
        const out = [];
        for (const { p, qty, cost } of checked) {
          const old = Math.max(0, num(p.stock));
          p.cost_price = old + qty > 0 ? Math.round((old * p.cost_price + qty * cost) / (old + qty)) : cost;
          p.stock = roundQty(p.stock + qty);
          db.purchases.push({ id: nextId(db, 'purchase'), purchase_date: pdate, supplier: String(data.supplier || ''), product_id: p.id, name: p.name, qty, cost_price: cost, total: Math.round(qty * cost), note: String(data.note || ''), user: u.name, photo_id: photo ? photo.photo_id : '' });
          out.push({ product_id: p.id, stock: p.stock, cost_price: p.cost_price });
        }
        if (photo) photo.ref = [photo.ref, String(data.supplier || '')].filter(Boolean).join(' ') || 'masuk';
        return { stock: out };
      }
      case 'get_sales': {
        if (!isYmd(data.from) || !isYmd(data.to)) throw E('INVALID', 'from/to');
        const inR = d => d >= data.from && d <= data.to;
        const sales = db.sales.filter(s => inR(s.sale_date));
        const inv = new Set(sales.map(s => s.invoice_no));
        return { sales, items: db.items.filter(i => inv.has(i.invoice_no)), payments: db.payments.filter(p => inR(p.pay_date)), purchases: db.purchases.filter(p => inR(p.purchase_date)), expenses: db.expenses.filter(x => inR(x.expense_date)), shifts: db.shifts.filter(x => inR(x.shift_date)).map(x => blind(shiftSummary(db, x), u.role)) };
      }
      case 'save_settings': {
        needOwner();
        const s = data.settings || {};
        if (s.paper !== undefined && !['58', '80'].includes(String(s.paper))) throw E('INVALID', 'paper');
        if (s.exit_photo_min_total !== undefined) s.exit_photo_min_total = Math.max(0, int(s.exit_photo_min_total));
        if (s.exit_photo_min_qty !== undefined) s.exit_photo_min_qty = Math.max(0, num(s.exit_photo_min_qty));
        Object.assign(db.settings, s);
        return { settings: db.settings };
      }
      case 'save_user': {
        needOwner();
        const name = String(data.name || '').trim();
        if (!name) throw E('INVALID', 'name required');
        const role = ['owner', 'manager'].includes(data.role) ? data.role : 'kasir';
        if (data.pin_hash && !/^[0-9a-f]{64}$/.test(data.pin_hash)) throw E('INVALID', 'pin_hash');
        let x = db.users.find(v => v.name.toLowerCase() === name.toLowerCase());
        const active = data.active === undefined ? true : !!data.active;
        const ownersLeft = db.users.filter(v => v !== x && v.role === 'owner' && v.active).length + (role === 'owner' && active ? 1 : 0);
        if (!ownersLeft) throw E('INVALID', 'At least one active owner required');
        if (!x) {
          if (!data.pin_hash) throw E('INVALID', 'pin_hash required');
          x = { name, role, pin_hash: data.pin_hash, active };
          db.users.push(x);
        } else { x.role = role; x.active = active; if (data.pin_hash) x.pin_hash = data.pin_hash; }
        return { user: { name: x.name, role: x.role, active: x.active } };
      }
      default: throw E('INVALID', 'Unknown action ' + action);
    }
  }

  /* v16 as on the server (process.js): everything sent is plain text — control / direction-override characters and < >
     (and tags) removed, __proto__ / constructor / prototype keys dropped, strings cut at 4000 characters.
     (The field actions go to backend/field, which has no such step.) */
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
      if (typeof v === 'string') o[k] = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '').slice(0, 4000);
      else if (v && typeof v === 'object') cleanInput(v, depth + 1);
    });
  }
  /** backend/field/process-field.js: the same cleaning without the 4000-character cut; photos (data: URLs) left as they are. */
  function cleanFieldInput(o, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    Object.keys(o).forEach(k => {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') { delete o[k]; return; }
      const v = o[k];
      if (typeof v === 'string' && v.indexOf('data:') !== 0) o[k] = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
      else if (v && typeof v === 'object') cleanFieldInput(v, depth + 1);
    });
  }
  // Phase 3 chat: same core as the server (backend/chat/chat-core.js) + demo handler (shared/chat-mock.js)
  const CHAT_ACTIONS = ['chat_bootstrap', 'chat_poll', 'chat_send', 'chat_set_retention'];
  let chatLoad = null;
  function loadChatMock() {
    if (window.KChat && window.KChatMock) return Promise.resolve();
    const one = src => new Promise(res => { const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
    return chatLoad || (chatLoad = one('../backend/chat/chat-core.js').then(() => one('../shared/chat-mock.js')));
  }
  async function request(body) {
    await ensure();
    await sleep(30 + Math.random() * 50);
    let forced = false; try { forced = localStorage.getItem('kmock.offline') === '1'; } catch (e) { }
    if (!navigator.onLine || forced) throw new NetError('offline (mock)');
    const db = load();
    let fieldSeeded = false;
    try { fieldSeeded = !!(window.KhairFieldMock && KhairFieldMock.seed(db)); } catch (e) { console.error(e); }
    db.approvals = db.approvals || []; db.photos = db.photos || []; db.expenses = db.expenses || []; db.shifts = db.shifts || []; db.cash_moves = db.cash_moves || [];
    db.devices = db.devices || []; db.activity = db.activity || [];
    // chat is append-only text/images; it bypasses the POS tamper scan (a message may legitimately contain symbols)
    if (CHAT_ACTIONS.includes(body.action)) {
      await loadChatMock();
      const cdb = load(); // fresh read AFTER the async load: the background chat poll must never save a stale snapshot over another call's writes
      let out;
      try { out = window.KChatMock ? window.KChatMock.handle(cdb, body, E) : { ok: false, error: 'SERVER', message: 'Chat mock not loaded' }; }
      catch (e) { out = { ok: false, error: e.code || 'SERVER', message: e.message }; }
      if (cdb._dirty) { delete cdb._dirty; save(cdb); }
      return JSON.parse(JSON.stringify(out));
    }
    LOG.push({ action: body.action, user: body.user || '', device: body.data && body.data.device ? JSON.parse(JSON.stringify(body.data.device)) : null, at: Date.now() });
    if (LOG.length > 300) LOG.shift();
    dirty = false;
    let res;
    try {
      const role = (db.users.find(x => x.name.toLowerCase() === String(body.user || '').toLowerCase() && x.pin_hash === body.pin_hash) || {}).role;
      let __codeHit = '';
      if (body.data && typeof body.data === 'object' && !/^scan_/.test(body.action) && !(window.KhairFieldMock && KhairFieldMock.actions.includes(body.action))) { __codeHit = scanCodeAttempt(body.data, 0); body = Object.assign({}, body, { data: JSON.parse(JSON.stringify(body.data)) }); cleanInput(body.data, 0); }
      body.__codeHit = __codeHit;
      res = handle(db, body);
      if (fieldSeeded || dirty || !(READ_ONLY.includes(body.action) || ['field_bootstrap', 'list_field', 'product_images'].includes(body.action))) save(db);
      res = Object.assign({ ok: true }, role === 'owner' || ['users', 'setup'].includes(body.action) ? res : strip(res));
    } catch (e) {
      if (e.code === 'TAMPER') { const fresh = load() || db; fresh.settings = fresh.settings || {}; fresh.settings.locked_accounts = db.settings.locked_accounts; save(fresh); }
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
    ].map((c, i) => ({ id: i + 1, name: c[0], phone: c[1], type: c[2], address: c[3], notes: '', debt_balance: 0 }));
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
        sales.push({ channel, promo_code, shift_id: '', id: ++seqSale, invoice_no, sale_date: date, sale_time: iso, cashier: R() < 0.7 ? 'Siti' : 'Pemilik', customer_id: cust ? cust.id : null, customer_name: cust ? cust.name : 'Umum', customer_type: cust ? cust.type : 'eceran', subtotal, discount, total, total_cost: totalCost, profit: total - totalCost, payment_method: method, paid_amount: paid, debt_amount, status: 'ok', survey: JSON.stringify(survey), notes: '', client_id: 'seed-' + seqSale });
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
    const users = mode === 'empty' ? [] : [
      { name: 'Pemilik', role: 'owner', pin_hash: await pinHash('demo', 'Pemilik', '1234'), active: true },
      { name: 'Siti', role: 'kasir', pin_hash: await pinHash('demo', 'Siti', '1111'), active: true },
      { name: 'Jihan', role: 'manager', pin_hash: await pinHash('demo', 'Jihan', '2222'), active: true },
      { name: 'Rina', role: 'kasir', pin_hash: await pinHash('demo', 'Rina', '3333'), active: true }
    ];
    return {
      users, products, customers, sales, items, payments, purchases, approvals: [], photos, expenses, shifts, cash_moves,
      settings: { store_name: 'Khair Mart', address: 'Jl. Raya Condet No. 27, Balekambang, Kramat Jati, Jakarta Timur', phone: '0812-8000-2700', receipt_footer: 'Terima kasih, semoga berkah!\nBarang yang sudah dibeli tidak dapat ditukar.', paper: '58', survey_questions: DEFAULT_SURVEY.slice(), survey_auto: true, exit_photo_min_total: 1000000, exit_photo_min_qty: 20, require_purchase_photo: true, require_shift: true },
      seq: { product: products.length, customer: customers.length, sale: seqSale, payment: seqPay, purchase: seqPur, photo: seqPh, approval: 0, expense: seqExp, shift: seqSh, move: seqMv }
    };
  }
  return { request, ensure, reset() { try { localStorage.removeItem(DBKEY); } catch (e) { } ready = null; }, DBKEY, log: LOG };
})();
