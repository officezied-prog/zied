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
// v20 correct_price: overcharge (account full-paid / account credit / umum), undercharge (consultation), matching, voids, roles, catalog.
function mkItem(inv, pid, qty, unit, cost, id) { return { id, invoice_no: inv, sale_date: '2026-10-05', product_id: pid, name: 'Kurma Ajwa 1kg', qty, unit_price: unit, cost_price: cost, line_total: Math.round(qty * unit), line_profit: Math.round(qty * unit) - Math.round(qty * cost) }; }
function mkSale(inv, cid, cname, total, paid, cost, cashier, id, status) { return { id, invoice_no: inv, sale_date: '2026-10-05', cashier, customer_id: cid, customer_name: cname, subtotal: total, discount: 0, send_fee: 0, total, total_cost: cost, profit: total - cost, payment_method: paid >= total ? 'tunai' : 'hutang', paid_amount: paid, debt_amount: Math.max(0, total - paid), status: status || 'ok' }; }
const C = [{ id: 7, name: 'Toko Berkah', phone: '081200000007', type: 'grosir', debt_balance: 300000 }];
const sales = [
  mkSale('KM1', 7, 'Toko Berkah', 185000, 185000, 150000, 'Siti', 31),   // account, paid full
  mkSale('KM2', 7, 'Toko Berkah', 370000, 100000, 300000, 'Siti', 32),   // account, credit
  mkSale('KM3', 0, 'Umum', 185000, 185000, 150000, 'Rina', 33),          // walk-in cash, no phone
  mkSale('KM4', 7, 'Toko Berkah', 150000, 150000, 150000, 'Siti', 34),   // undercharge target (sold at 150000)
  mkSale('KM5', 7, 'Toko Berkah', 185000, 185000, 150000, 'Siti', 35, 'void') // void: excluded
];
const items = [
  mkItem('KM1', 1, 1, 185000, 150000, 41),
  mkItem('KM2', 1, 2, 185000, 150000, 42),
  mkItem('KM3', 1, 1, 185000, 150000, 43),
  mkItem('KM4', 1, 1, 150000, 150000, 44),
  mkItem('KM5', 1, 1, 185000, 150000, 45),
  mkItem('KM1', 2, 1, 999, 500, 46) // a different product/price in KM1: must be untouched
];
const DB = Object.assign({}, db, { customers: C, rs: sales, ri: items, ap: [
  { id: 90, request_id: 'AP1', kind: 'price', ref: '1', decided_by: 'Jihan', decided_at: '2026-10-01T03:00:00Z', payload: JSON.stringify({ changes: { retail_price: { from: 160000, to: 185000 } } }) }
] });
let r;
// 1) overcharge 185000 -> 160000 across the range (manager)
r = run(base('correct_price', 'Jihan', '2222', { product_id: 1, old_price: 185000, new_price: 160000, from: '2026-10-01', to: '2026-10-07', reason: 'salah input' }), DB);
const co = r.response.correction || {};
console.log('1 ok', r.response.ok, 'invoices', co.invoices, 'netDiff', co.net_diff, 'refundTotal', co.refund_total, 'underTotal', co.under_total);
console.log('  refunds', JSON.stringify(co.refunds));
console.log('  setters', JSON.stringify(co.price_setters), 'cashiers', JSON.stringify(co.cashiers));
const items2 = r.ops.sale_items.map(x => x.invoice_no + ':' + x.product_id + ':u' + x.unit_price + ':t' + x.line_total);
console.log('  re-priced items', JSON.stringify(items2));
const cust2 = r.ops.customers.map(x => x.name + ':debt' + x.debt_balance);
console.log('  customer debt writes', JSON.stringify(cust2));
const sale1 = r.ops.sales.find(x => x.invoice_no === 'KM1'), sale2 = r.ops.sales.find(x => x.invoice_no === 'KM2');
console.log('  KM1 total', sale1 && sale1.total, 'debt', sale1 && sale1.debt_amount, '| KM2 total', sale2 && sale2.total, 'debt', sale2 && sale2.debt_amount);
console.log('  KM5(void) touched?', r.ops.sales.some(x => x.invoice_no === 'KM5'), '| KM1 prod2 touched?', r.ops.sale_items.some(x => x.invoice_no === 'KM1' && x.product_id === 2));
console.log('  koreksi record', (r.ops.approvals.find(a => a.kind === 'koreksi') || {}).summary);
// 2) undercharge 150000 -> 160000 (consultation, no debt change)
r = run(base('correct_price', 'Jihan', '2222', { product_id: 1, old_price: 150000, new_price: 160000, from: '2026-10-01', to: '2026-10-07', reason: 'harga naik tidak diubah' }), DB);
const cu = r.response.correction || {};
console.log('2 undercharge ok', r.response.ok, 'netDiff', cu.net_diff, 'consults', JSON.stringify(cu.consults), 'debtWrites', r.ops.customers.length);
console.log('  KM4 item', JSON.stringify(r.ops.sale_items.map(x => x.invoice_no + ':u' + x.unit_price + ':corr' + (x.corrected_price || '-'))));
// 3) kasir forbidden
r = run(base('correct_price', 'Siti', '1111', { product_id: 1, old_price: 185000, new_price: 160000, from: '2026-10-01', to: '2026-10-07', reason: 'x' }), DB);
console.log('3 kasir forbidden', r.response.error);
// 4) no match
r = run(base('correct_price', 'Jihan', '2222', { product_id: 1, old_price: 123456, new_price: 1, from: '2026-10-01', to: '2026-10-07', reason: 'x' }), DB);
console.log('4 no match', r.response.error);
// 5) same price
r = run(base('correct_price', 'Jihan', '2222', { product_id: 1, old_price: 185000, new_price: 185000, from: '2026-10-01', to: '2026-10-07', reason: 'x' }), DB);
console.log('5 same price', r.response.error);
// 6) catalog update
r = run(base('correct_price', 'Jihan', '2222', { product_id: 1, old_price: 185000, new_price: 160000, from: '2026-10-01', to: '2026-10-07', reason: 'x', update_catalog: true }), DB);
console.log('6 catalog', r.response.product ? r.response.product.retail_price : 'none');
