const fs=require('fs'), crypto=require('crypto');
const KEY=fs.readFileSync(__dirname + '/storekey.txt','utf8').trim();
const code=fs.readFileSync(__dirname + '/../process.js','utf8').replace('__STORE_KEY__',KEY);
const fn=new Function('$', code);
const h=(u,p)=>crypto.createHash('sha256').update(KEY+':'+u.toLowerCase()+':'+p).digest('hex');
const DEFSHIFTS=[{id:21,shift_id:'SHS',cashier:'Siti',status:'open',opening_cash:200000,cash_sales:0,cash_payments:0,cash_in:0,cash_out:0,sales_count:0,sales_total:0,moves:'[]',note:''},{id:22,shift_id:'SHJ',cashier:'Jihan',status:'open',opening_cash:0,cash_sales:0,cash_payments:0,cash_in:0,cash_out:0,sales_count:0,sales_total:0,moves:'[]',note:''}];
function run(req, db){
  const nodes={'Parse Request':[req],'Get Users':db.users,'Get Settings':db.settings||[],'Get Products':db.products,'Get Customers':db.customers,
   'Get Sale By Client':db.byClient||[{}],'Get Sale By Invoice':db.byInv||[{}],'Get Items By Invoice':db.itemsByInv||[{}],
   'Get Range Sales':db.rs||[{}],'Get Range Items':db.ri||[{}],'Get Range Payments':db.rp||[{}],'Get Range Purchases':db.rpu||[{}],'Get Approvals':db.ap||[{}],'Get Photo':db.ph||[{}],'Get Range Expenses':db.re||[{}],'Get Open Shifts':db.os||DEFSHIFTS,'Get Range Shifts':db.rsh||[{}],'Get Devices':db.dev||[{}],'Get Range Repacks':db.rr||[{}],'Get Purchase By No':db.pbn||[{}],'Get Range Activity':db.act||[{}],'Get Party Payments':db.pp||[{}],'Get Party Sales':db.ps||[{}],'Get Party Purchases':db.pu||[{}],'Get Bank Lines':db.bl||[{}],'Get Returns By Ref':db.rbr||[{}],'Get Range Returns':db.rret||[{}]};
  const $=n=>({first:()=>({json:(nodes[n]||[{}])[0]}),all:()=>(nodes[n]||[]).map(j=>({json:j}))});
  return fn($)[0].json;
}
const db={users:[{id:1,name:'Pemilik',role:'owner',pin_hash:h('Pemilik','1234'),active:true},{id:2,name:'Siti',role:'kasir',pin_hash:h('Siti','1111'),active:true},{id:3,name:'Jihan',role:'manager',pin_hash:h('Jihan','2222'),active:true}],
 products:[{id:1,sku:'111',name:'Kurma Ajwa 1kg',category:'kurma',unit:'kg',cost_price:150000,retail_price:185000,wholesale_price:170000,wholesale_min_qty:5,stock:20,min_stock:3,active:true,notes:''},
           {id:2,sku:'222',name:'Kismis 500g',category:'kismis',unit:'pcs',cost_price:20000,retail_price:25000,wholesale_price:23000,wholesale_min_qty:10,stock:50,min_stock:5,active:true,notes:''}],
 customers:[{id:7,name:'Toko Berkah',phone:'0812',type:'grosir',address:'',notes:'',debt_balance:100000}]};
const base=(action,user,pin,data)=>({ip:'1.2.3.4',ua:'Mozilla/5.0 (Linux; Android 14)',action,key:KEY,user,pin_hash:h(user,pin),data,client_id:data.client_id||'__none__',invoice_no:data.invoice_no||'__none__',from:data.from||'9999-12-31',to:data.to||'0000-01-01'});

const it=(pid,qty,price)=>({product_id:pid,qty:qty,unit_price:price});
// v17 accountant (akuntan): read-only; purchase prices only when the owner allows; profit never.
let r;
const A = Object.assign({}, db, { users: db.users.concat([{ id: 4, name: 'Rina', role: 'akuntan', pin_hash: h('Rina', '5555'), active: true }]) });
const sale = { id: 31, invoice_no: 'KM1', sale_date: '2026-10-06', cashier: 'Siti', customer_id: 7, customer_name: 'Toko Berkah', subtotal: 185000, total: 185000, total_cost: 150000, profit: 35000, payment_method: 'hutang', debt_amount: 185000, status: 'ok' };
const item = { id: 41, invoice_no: 'KM1', product_id: 1, name: 'Kurma Ajwa 1kg', qty: 1, unit_price: 185000, cost_price: 150000, line_total: 185000, line_profit: 35000 };
const pur = { id: 51, purchase_no: 'PB1', purchase_date: '2026-10-06', supplier: 'PT A', product_id: 1, name: 'Kurma Ajwa 1kg', qty: 10, cost_price: 150000, total: 1500000, match_status: 'cocok' };
const R = Object.assign({}, A, { rs: [sale], ri: [item], rpu: [pur] });
r = run(base('save_user', 'Pemilik', '1234', { name: 'Rina', role: 'akuntan', pin_hash: h('Rina', '5555') }), db); console.log('A1 owner creates akuntan', r.response.ok, r.ops.users.map(u => u.role).join(','));
r = run(base('login', 'Rina', '5555', {}), A); console.log('A2 login', r.response.ok, r.response.user && r.response.user.role);
for (const [act, data] of [['save_sale', { client_id: 'a1', items: [it(1, 1, 185000)], payment_method: 'tunai', paid_amount: 185000 }], ['save_purchase', { supplier: 'X', items: [] }], ['receive_payment', { customer_id: 7, amount: 1000 }], ['save_settings', { settings: { store_name: 'X' } }], ['request_return', { kind: 'pelanggan' }], ['decide_approval', { request_id: 'x' }], ['list_approvals', {}], ['save_customer', { name: 'A B' }], ['stock_count', {}]]) {
  r = run(base(act, 'Rina', '5555', data), A); console.log('A3 forbidden', act, r.response.error, r.ops && Object.values(r.ops).some(x => Array.isArray(x) && x.length) ? 'WRITES!' : 'no writes');
}
r = run(base('get_sales', 'Rina', '5555', { from: '2026-10-01', to: '2026-10-07' }), R);
console.log('A4 default: cost hidden', r.response.ok, 'purchase cost' in Object.assign({}, r.response.purchases[0]) ? r.response.purchases[0].cost_price : 'none', 'item cost' , r.response.items[0].cost_price, 'profit', r.response.sales[0].profit, r.response.items[0].line_profit);
const RC = Object.assign({}, R, { settings: [{ id: 9, skey: 'akuntan_sees_cost', svalue: 'true' }] });
r = run(base('get_sales', 'Rina', '5555', { from: '2026-10-01', to: '2026-10-07' }), RC);
console.log('A5 allowed: cost shown, profit hidden', r.response.purchases[0].cost_price, r.response.items[0].cost_price, r.response.sales[0].profit, r.response.items[0].line_profit);
r = run(base('get_sales', 'Jihan', '2222', { from: '2026-10-01', to: '2026-10-07' }), RC); console.log('A6 manager still no cost', r.response.purchases[0].cost_price, r.response.items[0].cost_price);
r = run(base('daily_report', 'Rina', '5555', { date: '2026-10-06' }), R); console.log('A7 daily report', r.response.ok, 'profit' in (r.response.report || {}) ? 'PROFIT!' : 'no profit');
r = run(base('party_ledger', 'Rina', '5555', { party_type: 'supplier', supplier: 'PT A' }), R); console.log('A8 supplier ledger', r.response.ok || r.response.error);
r = run(base('party_ledger', 'Rina', '5555', { party_type: 'customer', customer_id: 7 }), R); console.log('A8 customer ledger', r.response.ok || r.response.error);
r = run(base('list_returns', 'Rina', '5555', { from: '2026-10-01', to: '2026-10-07' }), R); console.log('A9 returns', r.response.ok || r.response.error);
r = run(base('bootstrap', 'Rina', '5555', {}), A); console.log('A10 bootstrap', r.response.ok, r.response.user.role, 'product cost', r.response.products[0].cost_price, 'approvals_pending', r.response.approvals_pending);
r = run(base('save_settings', 'Pemilik', '1234', { settings: { invoice_due_days: 200 } }), db); console.log('A11 due 200', r.response.error);
r = run(base('save_settings', 'Pemilik', '1234', { settings: { invoice_due_days: '30', akuntan_sees_cost: 'yes' } }), db); console.log('A12 saved', r.response.ok, r.ops.settings.map(x => x.skey + '=' + x.svalue).join(' '));
r = run(base('bootstrap', 'Pemilik', '1234', {}), db); console.log('A13 defaults', r.response.settings.invoice_due_days, r.response.settings.akuntan_sees_cost);
