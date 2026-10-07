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
// v20 disputes: refunds (overcharge) paid/released with photo rule; consultations (undercharge) collect/writeoff.
function mkItem(inv, pid, qty, unit, cost, id) { return { id, invoice_no: inv, sale_date: '2026-10-05', product_id: pid, name: 'Kurma Ajwa 1kg', qty, unit_price: unit, cost_price: cost, line_total: Math.round(qty * unit), line_profit: Math.round(qty * unit) - Math.round(qty * cost) }; }
function mkSale(inv, cid, cname, total, paid, cost, cashier, id) { return { id, invoice_no: inv, sale_date: '2026-10-05', cashier, customer_id: cid, customer_name: cname, subtotal: total, discount: 0, send_fee: 0, total, total_cost: cost, profit: total - cost, payment_method: paid >= total ? 'tunai' : 'hutang', paid_amount: paid, debt_amount: Math.max(0, total - paid), status: 'ok' }; }
const C = [{ id: 7, name: 'Toko Berkah', phone: '081200000007', type: 'grosir', debt_balance: 0 }];
const DB = Object.assign({}, db, { customers: C,
  rs: [mkSale('KA1', 0, 'Umum', 185000, 185000, 150000, 'Siti', 31), mkSale('KA2', 7, 'Toko Berkah', 150000, 150000, 150000, 'Siti', 32)],
  ri: [mkItem('KA1', 1, 1, 185000, 150000, 41), mkItem('KA2', 1, 1, 150000, 150000, 42)] });
let r;
// overcharge KA1 (umum, no phone) -> cadangan refund; undercharge KA2 -> consultation
r = run(base('correct_price', 'Jihan', '2222', { product_id: 1, old_price: 185000, new_price: 160000, from: '2026-10-01', to: '2026-10-07', reason: 'x' }), DB);
const refund = r.ops.approvals.find(a => a.kind === 'refund');
console.log('A refund record', !!refund, refund && refund.total, '| channel', refund && JSON.parse(refund.payload).channel, '| expiry?', !!(refund && JSON.parse(refund.payload).expiry));
r = run(base('correct_price', 'Jihan', '2222', { product_id: 1, old_price: 150000, new_price: 170000, from: '2026-10-01', to: '2026-10-07', reason: 'y' }), DB);
const consult = r.ops.approvals.find(a => a.kind === 'konsultasi');
console.log('B consult record', !!consult, consult && consult.total, consult && consult.approver_role);
// inject into DB.ap and test decisions
const future = new Date(Date.now() + 90*86400000).toISOString();
const AP = [
  { id: 60, request_id: 'RF1', kind: 'refund', approver_role: 'manager', status: 'pending', total: 25000, customer_name: 'Umum', ref: 'KA1', created_at: '2026-10-07T00:00:00Z', payload: JSON.stringify({ invoice_no: 'KA1', customer_id: 0, amount: 25000, channel: 'cadangan', expiry: future }) },
  { id: 61, request_id: 'RF2', kind: 'refund', approver_role: 'manager', status: 'pending', total: 25000, customer_name: 'Toko Berkah', ref: 'KA3', created_at: '2026-10-07T00:00:00Z', payload: JSON.stringify({ invoice_no: 'KA3', customer_id: 7, amount: 25000, channel: 'kontak', phone: '0812' }) },
  { id: 62, request_id: 'KS1', kind: 'konsultasi', approver_role: 'owner', status: 'pending', total: 20000, customer_name: 'Toko Berkah', ref: 'KA2', created_at: '2026-10-07T00:00:00Z', payload: JSON.stringify({ invoice_no: 'KA2', customer_id: 7, amount: 20000, phone: '0812' }) }
];
const DBd = Object.assign({}, DB, { ap: AP });
// 1 list_disputes
r = run(base('list_disputes', 'Jihan', '2222', {}), DBd);
console.log('1 disputes', r.response.disputes.length, r.response.disputes.map(d => d.kind + ':' + d.can_decide).join(','));
// 2 pay cadangan without photo -> PHOTO_REQUIRED
r = run(base('decide_refund', 'Jihan', '2222', { request_id: 'RF1', decision: 'paid' }), DBd);
console.log('2 cadangan no photo', r.response.error);
// 3 pay cadangan with photo -> ok
r = run(base('decide_refund', 'Jihan', '2222', { request_id: 'RF1', decision: 'paid', photo_id: 'PH-xyz' }), DBd);
console.log('3 cadangan with photo', r.response.ok, (r.ops.approvals.find(a=>a.request_id==='RF1')||{}).status, 'log=' + (r.ops.activity||[]).some(a=>a.kind==='refund_bayar'));
// 4 release cadangan before expiry -> INVALID
r = run(base('decide_refund', 'Jihan', '2222', { request_id: 'RF1', decision: 'release' }), DBd);
console.log('4 release before 3mo', r.response.error);
// 5 pay kontak refund (no photo needed)
r = run(base('decide_refund', 'Jihan', '2222', { request_id: 'RF2', decision: 'paid' }), DBd);
console.log('5 kontak paid', r.response.ok);
// 6 consult: manager cannot decide
r = run(base('decide_consult', 'Jihan', '2222', { request_id: 'KS1', decision: 'collect' }), DBd);
console.log('6 manager consult', r.response.error);
// 7 owner collect -> debt +20000
r = run(base('decide_consult', 'Pemilik', '1234', { request_id: 'KS1', decision: 'collect' }), DBd);
console.log('7 owner collect', r.response.ok, 'debt', (r.ops.customers.find(c=>c._id===7)||{}).debt_balance, 'log=' + (r.ops.activity||[]).some(a=>a.kind==='musyawarah'));
// 8 owner writeoff
r = run(base('decide_consult', 'Pemilik', '1234', { request_id: 'KS1', decision: 'writeoff' }), DBd);
console.log('8 owner writeoff', r.response.ok, (r.ops.approvals.find(a=>a.request_id==='KS1')||{}).status);
