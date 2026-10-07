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
// v19: manager cannot create/manage akuntan; code attempts lock the account (setting locked_accounts); owner clears.
let r;
const lockedOut = r => { const s = (r.ops && r.ops.settings || []).find(x => x.skey === 'locked_accounts'); return s ? JSON.parse(s.svalue) : null; };
const tamperLog = r => (r.ops && r.ops.activity || []).some(a => a.kind === 'tamper');
r = run(base('save_user', 'Jihan', '2222', { name: 'Rina', role: 'akuntan', pin_hash: h('Rina', '4321') }), db); console.log('1 manager+akuntan refused', r.response.error);
r = run(base('save_user', 'Jihan', '2222', { name: 'Budi', role: 'kasir', pin_hash: h('Budi', '4321') }), db); console.log('2 manager+kasir ok', r.response.ok);
r = run(base('save_user', 'Pemilik', '1234', { name: 'Rina', role: 'akuntan', pin_hash: h('Rina', '4321') }), db); console.log('3 owner+akuntan ok', r.response.ok);
for (const [act, d] of [['save_customer', { name: 'A<script>x</script>' }], ['save_customer', { name: 'B', notes: '${a}' }], ['save_customer', { name: 'C', notes: 'x=>y' }], ['save_customer', { name: 'D', notes: 'a;;;b' }], ['save_customer', { name: 'E', notes: 'window.name' }]]) {
  r = run(base(act, 'Siti', '1111', JSON.parse(JSON.stringify(d))), db);
  console.log('4 code kasir →', r.response.error, 'locked=' + JSON.stringify(lockedOut(r)), 'log=' + tamperLog(r));
}
r = run(base('save_customer', 'Siti', '1111', { name: 'Toko Maju', notes: 'beli 3 (tiga) + 2, 100% ok, 0812-3' }), db); console.log('5 normal note ok', r.response.ok, r.response.error || '', 'nolock=' + (lockedOut(r) === null));
r = run(base('save_customer', 'Pemilik', '1234', { name: 'X', notes: '${evil}' }), db); console.log('6 owner code INVALID, nolock', r.response.error, lockedOut(r) === null);
const L = Object.assign({}, db, { settings: [{ id: 9, skey: 'locked_accounts', svalue: JSON.stringify(['siti']) }] });
r = run(base('save_sale', 'Siti', '1111', { client_id: 'z', items: [], payment_method: 'tunai', paid_amount: 0 }), L); console.log('7 locked blocked', r.response.error);
r = run(base('login', 'Siti', '1111', {}), L); console.log('8 locked login ok flag', r.response.ok, r.response.tamper_locked);
r = run(base('login', 'Jihan', '2222', {}), L); console.log('9 other login not locked', r.response.ok, r.response.tamper_locked);
r = run(base('clear_tamper', 'Pemilik', '1234', { name: 'Siti' }), L); console.log('10 owner clears', r.response.ok, 'remaining=' + JSON.stringify(lockedOut(r)));
r = run(base('clear_tamper', 'Jihan', '2222', { name: 'Siti' }), L); console.log('11 manager cannot clear', r.response.error);
r = run(base('bootstrap', 'Pemilik', '1234', {}), L); console.log('12 bootstrap tamper flag', (r.response.users.find(u => u.name === 'Siti') || {}).tamper);
