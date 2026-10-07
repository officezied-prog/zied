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
// v18: the manager adds and manages staff accounts (kasir, sales, akuntan) — never a manager or the owner, nor their accounts.
const ok = (tag, r) => console.log(tag, r.response.ok ? 'ok' : r.response.error, r.ops && r.ops.users ? r.ops.users.map(u => u.name + ':' + u.role + (u.must_change ? ':must' : '')).join(',') : '');
ok('M1 manager adds kasir', run(base('save_user', 'Jihan', '2222', { name: 'Budi', role: 'kasir', pin_hash: h('Budi', '4321') }), db));
ok('M2 manager adds sales', run(base('save_user', 'Jihan', '2222', { name: 'Wahyu', role: 'sales', pin_hash: h('Wahyu', '4321') }), db));
ok('M3 manager adds akuntan', run(base('save_user', 'Jihan', '2222', { name: 'Rina', role: 'akuntan', pin_hash: h('Rina', '4321') }), db));
ok('M4 manager resets Siti PIN', run(base('save_user', 'Jihan', '2222', { name: 'Siti', role: 'kasir', pin_hash: h('Siti', '9876'), active: true }), db));
ok('M5 manager deactivates Siti', run(base('save_user', 'Jihan', '2222', { name: 'Siti', role: 'kasir', active: false }), db));
ok('M6 manager makes a manager (refused)', run(base('save_user', 'Jihan', '2222', { name: 'Budi', role: 'manager', pin_hash: h('Budi', '4321') }), db));
ok('M7 manager makes an owner (refused)', run(base('save_user', 'Jihan', '2222', { name: 'Budi', role: 'owner', pin_hash: h('Budi', '4321') }), db));
ok('M8 manager promotes Siti to manager (refused)', run(base('save_user', 'Jihan', '2222', { name: 'Siti', role: 'manager', active: true }), db));
ok('M9 manager edits the owner (refused)', run(base('save_user', 'Jihan', '2222', { name: 'Pemilik', role: 'kasir', active: false }), db));
ok('M10 manager edits himself (refused)', run(base('save_user', 'Jihan', '2222', { name: 'Jihan', role: 'kasir', pin_hash: h('Jihan', '1111') }), db));
ok('M11 manager unknown role (refused)', run(base('save_user', 'Jihan', '2222', { name: 'Budi', role: 'boss', pin_hash: h('Budi', '4321') }), db));
ok('M12 kasir adds a user (refused)', run(base('save_user', 'Siti', '1111', { name: 'Budi', role: 'kasir', pin_hash: h('Budi', '4321') }), db));
ok('M13 owner adds a manager', run(base('save_user', 'Pemilik', '1234', { name: 'Nadia', role: 'manager', pin_hash: h('Nadia', '135790') }), db));
ok('M14 rename refused while Siti has an open kas (same as owner)', run(base('save_user', 'Jihan', '2222', { name: 'Siti', new_name: 'Ani', role: 'kasir', pin_hash: h('Ani', '4321') }), Object.assign({}, db, { shifts: [] })));
