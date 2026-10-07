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
let r;
const it=(pid,qty,price)=>({product_id:pid,qty:qty,unit_price:price});
// Ajwa retail 185000, wholesale 170000 (min 5), cost 150000
// D1: 3% exactly → ok (185000*0.97=179450)
r=run(base('save_sale','Siti','1111',{client_id:'d1',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:5550,payment_method:'tunai',paid_amount:200000}),db); console.log('D1 3% ok',r.response.ok,r.response.sale&&r.response.sale.notes);
// D2: 5% → blocked
r=run(base('save_sale','Siti','1111',{client_id:'d2',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250,payment_method:'tunai',paid_amount:200000}),db); console.log('D2 5% kasir',r.response.error,r.response.message);
// D3: low unit price instead of discount → blocked too
r=run(base('save_sale','Siti','1111',{client_id:'d3',sale_date:'2026-10-06',items:[it(1,1,170000)],payment_method:'tunai',paid_amount:200000}),db); console.log('D3 low price kasir',r.response.error);
// D4: wholesale price at qty 5 → allowed (list = wholesale)
r=run(base('save_sale','Siti','1111',{client_id:'d4',sale_date:'2026-10-06',items:[it(1,5,170000)],payment_method:'tunai',paid_amount:850000}),db); console.log('D4 grosir qty ok',r.response.ok);
// D5: grosir customer, qty 1 at wholesale → allowed
r=run(base('save_sale','Siti','1111',{client_id:'d5',sale_date:'2026-10-06',customer_id:7,items:[it(1,1,170000)],payment_method:'tunai',paid_amount:170000}),db); console.log('D5 grosir cust ok',r.response.ok);
// D6: manager / owner may give more without approval, note records it
r=run(base('save_sale','Jihan','2222',{client_id:'d6',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:18500,payment_method:'tunai',paid_amount:200000}),db); console.log('D6 manager 10%',r.response.ok,r.response.sale.notes);
// D7: request_discount by kasir
r=run(base('request_discount','Siti','1111',{client_id:'d2',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250,reason:'pelanggan tetap'}),db);
const apRow=r.ops.approvals[0]; console.log('D7 request',r.response.ok,apRow.kind,apRow.approver_role,apRow.total,apRow.debt_amount,'| kasir sees laba?',/laba/.test(r.response.approval.summary),'profit' in JSON.parse(r.response.approval.payload||'{}')||'profit_before' in JSON.parse(r.response.approval.payload||'{}'));
console.log('D7 log',r.ops.activity&&r.ops.activity.map(a=>a.kind+': '+a.summary));
// D8: within limit → no request needed
r=run(base('request_discount','Siti','1111',{client_id:'d1',items:[it(1,1,185000)],discount:5550}),db); console.log('D8 within',r.response.error);
const stored=Object.assign({id:50},apRow); delete stored._id;
// D9: owner sees profit before/after; manager does not
r=run(base('list_approvals','Pemilik','1234',{}),Object.assign({},db,{ap:[stored]})); const oa=(r.response.approvals||[])[0]||{}; console.log('D9 owner',/laba/.test(oa.summary),JSON.parse(oa.payload||'{}').margin_before,JSON.parse(oa.payload||'{}').margin_after,JSON.parse(oa.payload||'{}').profit_before,JSON.parse(oa.payload||'{}').profit_after);
r=run(base('list_approvals','Jihan','2222',{}),Object.assign({},db,{ap:[stored]})); const ma=(r.response.approvals||[])[0]||{}; console.log('D9 manager',/laba/.test(ma.summary),ma.summary,Object.keys(JSON.parse(ma.payload||'{}')).join(','), 'can_decide',ma.can_decide);
// D10: manager approves
r=run(base('decide_approval','Jihan','2222',{request_id:stored.request_id,decision:'approved'}),Object.assign({},db,{ap:[stored]})); console.log('D10 decide',r.response.ok,r.ops.approvals.map(a=>a.status));
const approved=Object.assign({},stored,{status:'approved',decided_by:'Jihan'});
// D11: kasir pending → still blocked
r=run(base('save_sale','Siti','1111',{client_id:'d2',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250,payment_method:'tunai',paid_amount:200000,discount_approval_id:stored.request_id}),Object.assign({},db,{ap:[stored]})); console.log('D11 pending',r.response.error,r.response.message);
// D12: approved → sale ok, approval used, note, log
r=run(base('save_sale','Siti','1111',{client_id:'d2',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250,payment_method:'tunai',paid_amount:200000,discount_approval_id:stored.request_id}),Object.assign({},db,{ap:[approved]})); console.log('D12 approved',r.response.ok,r.response.sale.notes,r.ops.approvals.map(a=>[a._id,a.status]),r.ops.activity&&r.ops.activity.map(a=>a.kind+' '+a.level));
// D13: bigger discount than approved → blocked
r=run(base('save_sale','Siti','1111',{client_id:'d2',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:15000,payment_method:'tunai',paid_amount:200000,discount_approval_id:stored.request_id}),Object.assign({},db,{ap:[approved]})); console.log('D13 bigger',r.response.error,r.response.message);
// D14: other client_id → blocked
r=run(base('save_sale','Siti','1111',{client_id:'zz',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250,payment_method:'tunai',paid_amount:200000,discount_approval_id:stored.request_id}),Object.assign({},db,{ap:[approved]})); console.log('D14 other sale',r.response.error);
// D15: rejected
r=run(base('save_sale','Siti','1111',{client_id:'d2',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250,payment_method:'tunai',paid_amount:200000,discount_approval_id:stored.request_id}),Object.assign({},db,{ap:[Object.assign({},stored,{status:'rejected',note:'terlalu besar'})]})); console.log('D15 rejected',r.response.message);
// D16: setting max_discount_pct=10 → 5% ok
r=run(base('save_sale','Siti','1111',{client_id:'d16',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250,payment_method:'tunai',paid_amount:200000}),Object.assign({},db,{settings:[{id:1,skey:'max_discount_pct',svalue:'10'}]})); console.log('D16 setting 10',r.response.ok);
// D17: kasir cannot change max_discount_pct; owner can
r=run(base('save_settings','Siti','1111',{settings:{max_discount_pct:50}}),db); console.log('D17 kasir settings',r.response.error);
r=run(base('save_settings','Pemilik','1234',{settings:{max_discount_pct:5}}),db); console.log('D17 owner settings',r.response.ok,JSON.stringify(r.ops.settings));
r=run(base('bootstrap','Siti','1111',{}),db); console.log('D18 boot setting',r.response.settings.max_discount_pct);
// D19: price higher than list → no discount
r=run(base('save_sale','Siti','1111',{client_id:'d19',sale_date:'2026-10-06',items:[it(1,1,190000)],discount:5000,payment_method:'tunai',paid_amount:200000}),db); console.log('D19 above list',r.response.ok);
// ---- auth v16 ----
const mh=code=>crypto.createHash('sha256').update(KEY+':__master__:'+code).digest('hex');
const dbM=JSON.parse(JSON.stringify(db)); dbM.users[0].master_hash=mh('12345678');
const viaM=(action,user,data)=>Object.assign(base(action,user,'x',data||{}),{pin_hash:mh('12345678')});
r=run(viaM('login','Siti'),dbM); console.log('A1 master login kasir',r.response.ok,r.response.via_master,r.ops.activity.map(a=>a.kind+': '+a.summary+' by '+a.user));
r=run(viaM('login','Pemilik'),dbM); console.log('A2 master login owner',r.response.ok,r.response.via_master);
r=run(viaM('set_master','Pemilik',{master_hash:mh('99999999')}),dbM); console.log('A3 set_master via master',r.response.error);
r=run(base('set_master','Pemilik','1234',{master_hash:mh('99999999')}),dbM); console.log('A4 set_master',r.response.ok,r.ops.users.map(u=>[u._id,u.master_hash===mh('99999999'),u.pin_hash===h('Pemilik','1234')]),r.ops.activity.map(a=>a.summary));
r=run(base('set_master','Jihan','2222',{master_hash:mh('1')}),dbM); console.log('A5 manager set_master',r.response.error);
r=run(Object.assign(base('login','Siti','x',{}),{pin_hash:mh('00000000')}),dbM); console.log('A6 wrong master',r.response.error,r.ops.users.map(u=>[u._id,u.fail_count]));
const dbF=JSON.parse(JSON.stringify(db)); dbF.users[1].fail_count=4;
r=run(base('login','Siti','0000',{}),dbF); console.log('A7 5th wrong → locked',r.response.error,r.response.message,r.ops.users.map(u=>[u.fail_count,!!u.locked_until]));
dbF.users[1].fail_count=0; dbF.users[1].locked_until=new Date(Date.now()+600000).toISOString();
r=run(base('login','Siti','1111',{}),dbF); console.log('A8 locked even right PIN',r.response.error);
dbF.users[1].locked_until=new Date(Date.now()-1000).toISOString(); dbF.users[1].fail_count=2;
r=run(base('login','Siti','1111',{}),dbF); console.log('A9 after lock expiry ok + reset',r.response.ok,r.ops.users.map(u=>[u.fail_count,u.locked_until]));
dbF.users[1].fail_count=2; dbF.users[1].locked_until='';
r=run(base('login','Siti','0000',{}),dbF); console.log('A10 3rd wrong warns',r.response.message);
const dbC=JSON.parse(JSON.stringify(db)); dbC.users[1].must_change=true;
r=run(base('login','Siti','1111',{}),dbC); console.log('A11 must_change login',r.response.ok,r.response.must_change);
r=run(base('bootstrap','Siti','1111',{}),dbC); console.log('A12 blocked',r.response.error);
r=run(base('change_pin','Siti','1111',{new_pin_hash:h('Siti','1111')}),dbC); console.log('A13 same pin',r.response.error);
r=run(base('change_pin','Siti','1111',{new_pin_hash:h('Siti','5678')}),dbC); console.log('A14 change',r.response.ok,r.ops.users.map(u=>[u.pin_hash===h('Siti','5678'),u.must_change,u.role]),r.ops.activity.map(a=>a.summary));
dbC.users[0].master_hash=mh('12345678');
r=run(viaM('bootstrap','Siti'),dbC); console.log('A15 master skips must_change',r.response.ok,r.response.via_master,JSON.stringify(r.response.users[0]));
r=run(viaM('change_pin','Siti',{new_pin_hash:h('Siti','4321')}),dbC); console.log('A16 master resets worker',r.response.ok,r.ops.users.map(u=>u.must_change));
r=run(viaM('change_pin','Pemilik',{new_pin_hash:h('Pemilik','4321')}),dbC); console.log('A17 master owner pin',r.response.error);
r=run(base('save_user','Pemilik','1234',{name:'Budi',role:'kasir',pin_hash:h('Budi','1111')}),db); console.log('A18 new user',JSON.stringify(r.ops.users));
r=run(base('save_user','Pemilik','1234',{name:'Siti',role:'kasir',active:true}),dbM); console.log('A19 edit w/o pin keeps',JSON.stringify(r.ops.users));
r=run(base('save_user','Pemilik','1234',{name:'Pemilik',role:'owner',pin_hash:h('Pemilik','9999')}),dbM); console.log('A20 owner self pin',r.ops.users.map(u=>[u.must_change,u.master_hash===mh('12345678')]));
r=run(base('bootstrap','Jihan','2222',{}),dbM); console.log('A21 manager users',JSON.stringify(r.response.users));
r=run(base('bootstrap','Pemilik','1234',{}),dbM); console.log('A22 owner users',JSON.stringify(r.response.users), JSON.stringify(r.response).includes(mh('12345678')));
// ---- members v16 ----
r=run(base('save_customer','Siti','1111',{name:'Bu Aisyah',phone:'0813 1111 2222',email:'Aisyah@Mail.com',member:true}),db); const nc=r.ops.customers[0]; console.log('M1 kasir registers',r.response.ok,nc.email,nc.member,/^M[0-9A-Z]{6}$/.test(nc.member_no),nc.member_since,nc.visits,JSON.stringify(r.response.member),r.ops.activity.map(a=>a.kind));
r=run(base('save_customer','Siti','1111',{name:'X',phone:'0813',email:'bad@'}),db); console.log('M2 bad email',r.response.error);
const dbMem=JSON.parse(JSON.stringify(db)); dbMem.customers.push({id:8,name:'Bu Aisyah',phone:'6281311112222',type:'eceran',debt_balance:0,email:'aisyah@mail.com',member:true,member_no:'MABC123',member_since:'2026-09-01',visits:4,last_visit:'2026-10-01'});
r=run(base('save_customer','Siti','1111',{id:8,member:false}),dbMem); console.log('M3 kasir removes',r.response.error);
r=run(base('save_customer','Jihan','2222',{id:8,member:false}),dbMem); console.log('M4 manager removes',r.response.ok,r.ops.customers[0].member,r.ops.customers[0].member_no,r.ops.activity.map(a=>a.kind));
r=run(base('save_customer','Siti','1111',{id:8,notes:'suka ajwa'}),dbMem); console.log('M5 edit keeps',JSON.stringify(r.ops.customers[0]));
// visits 4 → this is purchase 5 → 3% member; + 3% cashier = 6% allowed
r=run(base('save_sale','Siti','1111',{client_id:'m1',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:11100,payment_method:'tunai',paid_amount:200000}),dbMem); console.log('M6 member 6% ok',r.response.ok,JSON.stringify(r.response.member),r.response.sale&&r.response.sale.notes,r.ops.customers.map(c=>[c._id,c.visits,c.last_visit,c.debt_balance]));
r=run(base('save_sale','Siti','1111',{client_id:'m2',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:13000,payment_method:'tunai',paid_amount:200000}),dbMem); console.log('M7 member 7% blocked',r.response.error,r.response.message);
r=run(base('request_discount','Siti','1111',{client_id:'m2',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:13000}),dbMem); console.log('M8 request includes member',r.response.ok,JSON.parse(r.ops.approvals[0].payload).member_pct);
r=run(base('request_discount','Siti','1111',{client_id:'m1',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:11100}),dbMem); console.log('M9 within member limit',r.response.error);
// first purchase: 0%
const dbNew=JSON.parse(JSON.stringify(dbMem)); dbNew.customers[1].visits=0;
r=run(base('save_sale','Siti','1111',{client_id:'m3',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:9250,payment_method:'tunai',paid_amount:200000}),dbNew); console.log('M10 first purchase 5% blocked',r.response.error,r.response.message);
dbNew.customers[1].visits=12;
r=run(base('save_sale','Siti','1111',{client_id:'m4',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:14800,payment_method:'tunai',paid_amount:200000}),dbNew); console.log('M11 13th purchase 8% ok',r.response.ok,JSON.stringify(r.response.member));
r=run(base('save_sale','Siti','1111',{client_id:'m5',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:14800,payment_method:'tunai',paid_amount:200000}),Object.assign({},dbNew,{settings:[{id:1,skey:'member_enabled',svalue:'false'}]})); console.log('M12 members off',r.response.error);
r=run(base('save_sale','Siti','1111',{client_id:'m6',sale_date:'2026-10-06',customer_id:8,items:[it(1,1,185000)],discount:18500,payment_method:'tunai',paid_amount:200000}),Object.assign({},dbNew,{settings:[{id:1,skey:'member_tiers',svalue:JSON.stringify([{from:2,pct:7},{from:3,pct:'x'},{from:0,pct:99}])}]})); console.log('M13 custom tiers 7+3=10%',r.response.ok,JSON.stringify(r.response.member));
r=run(base('save_sale','Siti','1111',{client_id:'m7',sale_date:'2026-10-06',customer_id:7,items:[it(1,5,170000)],payment_method:'tunai',paid_amount:850000}),db); console.log('M14 non-member visits counted',r.ops.customers.map(c=>[c._id,c.visits,c.debt_balance]),JSON.stringify(r.response.member));
r=run(base('void_sale','Pemilik','1234',{invoice_no:'KMV',reason:'x'}),Object.assign({},dbMem,{byInv:[{id:9,invoice_no:'KMV',customer_id:8,debt_amount:0,status:'ok',notes:''}],itemsByInv:[{id:1,invoice_no:'KMV',product_id:1,qty:1}]})); console.log('M15 void visits back',r.ops.customers.map(c=>[c._id,c.visits]));
r=run(base('save_settings','Pemilik','1234',{settings:{member_tiers:[{from:3,pct:4}],member_enabled:true}}),db); console.log('M16 settings',r.ops.settings.map(x=>x.skey+'='+x.svalue).join(' '));
// ---- warehouse vs shelf v16 ----
const dbS=JSON.parse(JSON.stringify(db)); dbS.products[0].shop_stock=2; // Ajwa: stock 20 → rak 2, gudang 18
dbS.products[1].stock=0; dbS.products[1].shop_stock=0; // Kismis: nothing received
r=run(base('bootstrap','Siti','1111',{}),dbS); console.log('W1 boot',r.response.products.map(p=>[p.name,p.stock,p.shop_stock,p.gudang_stock]));
r=run(base('save_sale','Siti','1111',{client_id:'w1',sale_date:'2026-10-06',items:[it(1,3,185000)],payment_method:'tunai',paid_amount:600000}),dbS); console.log('W2 more than shelf',r.response.error,r.response.message,JSON.stringify(r.response.items),Object.values(r.ops).reduce((a,v)=>a+v.length,0));
r=run(base('save_sale','Siti','1111',{client_id:'w2',sale_date:'2026-10-06',items:[it(2,1,25000)],payment_method:'tunai',paid_amount:25000}),dbS); console.log('W3 never received',r.response.message);
r=run(base('save_sale','Siti','1111',{client_id:'w3',sale_date:'2026-10-06',items:[it(1,2,185000)],payment_method:'tunai',paid_amount:370000}),dbS); console.log('W4 sell 2 from shelf',r.response.ok,JSON.stringify(r.response.stock),r.ops.products.map(p=>[p.stock,p.shop_stock]));
r=run(base('save_sale','Siti','1111',{client_id:'w4',sale_date:'2026-10-06',items:[it(1,3,185000)],payment_method:'tunai',paid_amount:600000,queued:true}),dbS); console.log('W5 queued offline sale passes + logged',r.response.ok,r.ops.products.map(p=>[p.stock,p.shop_stock]),r.ops.activity.map(a=>a.kind));
r=run(base('move_stock','Siti','1111',{to:'toko',lines:[{product_id:1,qty:5}],note:'rak depan'}),dbS); console.log('W6 move 5 to shelf',r.response.ok,JSON.stringify(r.response.stock),r.ops.products.map(p=>[p.stock,p.shop_stock]),r.ops.activity.map(a=>a.summary));
r=run(base('move_stock','Siti','1111',{to:'toko',lines:[{product_id:1,qty:19}]}),dbS); console.log('W7 more than warehouse',r.response.error,r.response.message);
r=run(base('move_stock','Siti','1111',{to:'toko',lines:[{product_id:2,qty:1}]}),dbS); console.log('W8 no goods-in',r.response.error,r.response.message);
r=run(base('move_stock','Siti','1111',{to:'gudang',lines:[{product_id:1,qty:2}]}),dbS); console.log('W9 back to warehouse',r.response.ok,r.ops.products.map(p=>[p.stock,p.shop_stock]));
r=run(base('move_stock','Siti','1111',{to:'gudang',lines:[{product_id:1,qty:3}]}),dbS); console.log('W10 more than shelf',r.response.error);
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',carrier:{type:'teman',name:'Pak Udin'},items:[{product_id:2,qty:10,cost_price:20000}]}),Object.assign({},dbS,{settings:[{id:1,skey:'require_purchase_photo',svalue:'false'}]})); console.log('W11 goods-in → warehouse',r.response.ok,r.ops.products.map(p=>[p.name,p.stock,p.shop_stock]));
const dbL=JSON.parse(JSON.stringify(db)); // legacy rows: no shop_stock
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',carrier:{type:'umum',kind:'angkot',vehicle:'B 1234 XYZ'},items:[{product_id:1,qty:10,cost_price:150000}]}),Object.assign({},dbL,{settings:[{id:1,skey:'require_purchase_photo',svalue:'false'}]})); console.log('W12 legacy: old stock stays on shelf, new in warehouse',r.ops.products.map(p=>[p.stock,p.shop_stock]));
r=run(base('void_sale','Pemilik','1234',{invoice_no:'KMX',reason:'salah'}),Object.assign({},dbS,{byInv:[{id:9,invoice_no:'KMX',customer_id:0,debt_amount:0,status:'ok',notes:''}],itemsByInv:[{id:1,invoice_no:'KMX',product_id:1,qty:2}]})); console.log('W13 void back to shelf',r.ops.products.map(p=>[p.stock,p.shop_stock]));
r=run(base('stock_count','Pemilik','1234',{counts:[{product_id:1,counted:1}],note:'x'}),dbS); console.log('W14 count below shelf clamps',r.ops.products.map(p=>[p.stock,p.shop_stock]));
r=run(base('save_sale','Siti','1111',{client_id:'w5',sale_date:'2026-10-06',items:[it(1,3,185000)],payment_method:'tunai',paid_amount:600000}),Object.assign({},dbS,{settings:[{id:1,skey:'sell_from_shop_only',svalue:'false'}]})); console.log('W15 setting off',r.response.ok,r.ops.products.map(p=>[p.stock,p.shop_stock]));
r=run(base('save_product','Pemilik','1234',{name:'Madu 250g',sku:'333',unit:'pcs',retail_price:50000,cost_price:35000,stock:12}),dbS); console.log('W16 new product opening stock on shelf',r.ops.products.map(p=>[p.name,p.stock,p.shop_stock]));
const dbR16=Object.assign({},db,{products:[db.products[0],db.products[1],{id:3,sku:'333',name:'Sukkari curah',unit:'kg',cost_price:60000,retail_price:0,stock:30,shop_stock:5,active:true},{id:4,sku:'444',name:'Sukkari 500g',unit:'pak',cost_price:0,retail_price:45000,stock:2,shop_stock:2,active:true,repack_from:3,repack_qty:0.5}]});
r=run(base('repack','Jihan','2222',{to_product_id:4,from_qty:10,to_qty:19}),dbR16); console.log('W17 repack: bulk from warehouse, packs into warehouse',r.response.ok,r.ops.products.map(p=>[p.name,p.stock,p.shop_stock]));
// ---- misc v16 ----
r=run(base('open_shift','Siti','1111',{opening_cash:200000}),Object.assign({},db,{os:[]})); console.log('X1 open_shift returns approval',r.response.ok,/^AP/.test(r.response.request_id),r.response.approval.kind,r.response.approval.request_id===r.response.request_id);
const s7=[{id:1,invoice_no:'KM1',customer_id:7,sale_date:'2026-10-01',debt_amount:60000,status:'ok'},{id:2,invoice_no:'KM2',customer_id:7,sale_date:'2026-10-03',debt_amount:40000,status:'ok'}];
const pays7=[{id:20,pay_id:'PYA',customer_id:7,direction:'in',amount:30000,alloc:JSON.stringify([{ref:'KM2',amount:30000}])},{id:21,pay_id:'PYB',customer_id:7,direction:'in',amount:70000,alloc:'[]'}];
r=run(base('party_ledger','Siti','1111',{party_type:'customer',customer_id:7}),Object.assign({},db,{ps:s7,pp:pays7})); console.log('X2 FIFO',JSON.stringify(r.response.docs.map(d=>[d.ref,d.paid,d.auto,d.remaining])),r.response.unapplied);
const pfA={id:60,request_id:'APPF1',kind:'purchase_fix',approver_role:'manager',status:'pending',cashier:'Siti',total:1200000,summary:'Koreksi barang masuk PB1: Kurma Ajwa 1kg 10→8 (Rp 1500000→1200000)',payload:JSON.stringify({purchase_no:'PB1',reason:'x',changes:[{product_id:1,name:'Kurma Ajwa 1kg',from_qty:10,to_qty:8,from_total:1500000,to_total:1200000,cost_price:150000,d_qty:-2,d_total:-300000}]})};
r=run(base('list_approvals','Jihan','2222',{}),Object.assign({},db,{ap:[pfA]})); const ma2=r.response.approvals[0]; console.log('X3 manager purchase_fix',ma2.summary,ma2.total,ma2.payload);
r=run(base('list_approvals','Pemilik','1234',{}),Object.assign({},db,{ap:[pfA]})); const oa2=r.response.approvals[0]; console.log('X4 owner purchase_fix',oa2.summary,oa2.total,JSON.parse(oa2.payload).changes[0].to_total);
r=run(base('get_sales','Jihan','2222',{from:'2026-10-01',to:'2026-10-06'}),Object.assign({},db,{rpu:[{id:1,purchase_no:'PB1',supplier:'PT',product_id:1,qty:10,cost_price:150000,total:1500000}]})); console.log('X5 manager purchases',JSON.stringify(r.response.purchases));
r=run(base('get_sales','Pemilik','1234',{from:'2026-10-01',to:'2026-10-06'}),Object.assign({},db,{rpu:[{id:1,purchase_no:'PB1',supplier:'PT',product_id:1,qty:10,cost_price:150000,total:1500000}]})); console.log('X6 owner purchases',JSON.stringify(r.response.purchases));
// ---- returns, carrier, validation v16 ----
const saleR={id:9,invoice_no:'KMR1',customer_id:7,customer_name:'Toko Berkah',sale_date:'2026-10-05',subtotal:400000,discount:20000,total:380000,status:'ok'};
const itemsR=[{id:1,invoice_no:'KMR1',product_id:1,qty:2,unit_price:185000,line_total:370000},{id:2,invoice_no:'KMR1',product_id:2,qty:1,unit_price:30000,line_total:30000}];
const dbRet=Object.assign({},db,{byInv:[saleR],itemsByInv:itemsR});
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'rusak',reason_note:'kemasan sobek',returned_by:'Bu Sari',returned_by_phone:'0813 2222 3333',refund_method:'tunai',lines:[{product_id:1,qty:1,condition:'rusak'},{product_id:2,qty:1}]}),dbRet);
const apR=r.ops.approvals[0]; const plR=JSON.parse(apR.payload); console.log('R1 customer return',r.response.ok,r.response.approver_role,apR.kind,apR.total,JSON.stringify(plR.lines.map(l=>[l.name,l.qty,l.condition,l.unit_price,l.value])),plR.refund,plR.returned_by,plR.returned_by_phone,plR.bought_by,r.ops.activity.map(a=>a.kind));
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'rusak',lines:[{product_id:1,qty:3}]}),dbRet); console.log('R2 more than bought',r.response.error,r.response.message);
const pendR=Object.assign({id:70},apR); delete pendR._id;
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'rusak',lines:[{product_id:1,qty:2}]}),Object.assign({},dbRet,{ap:[pendR]})); console.log('R3 pending counted',r.response.message);
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'xx',lines:[{product_id:1,qty:1}]}),dbRet); console.log('R4 bad reason',r.response.error);
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'lainnya',lines:[{product_id:1,qty:1}]}),dbRet); console.log('R5 lainnya needs note',r.response.message);
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'rusak',returned_by:'<script>x</script>',lines:[{product_id:1,qty:1}]}),dbRet); console.log('R6 script name',r.response.ok, r.response.ok?JSON.parse(r.ops.approvals[0].payload).returned_by:r.response.message);
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'rusak',returned_by:'x=1;drop',lines:[{product_id:1,qty:1}]}),dbRet); console.log('R7 code-like name',r.response.ok,r.response.message);
// big value → owner
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'rusak',lines:[{product_id:1,qty:2}]}),Object.assign({},dbRet,{settings:[{id:1,skey:'return_owner_min_value',svalue:'300000'}]})); console.log('R8 big → owner',r.response.approver_role);
// manager approves: rusak not restocked, baik back to warehouse; cash refund from Siti's shift
r=run(base('decide_approval','Jihan','2222',{request_id:pendR.request_id,decision:'approved'}),Object.assign({},dbRet,{ap:[pendR]}));
console.log('R9 approve',r.response.ok,JSON.stringify(r.response.stock),r.ops.products.map(p=>[p.name,p.stock,p.shop_stock]),r.ops.payments.map(p=>[p.direction,p.amount,p.method,p.note]),r.ops.shifts.map(x=>[x.cash_out]),r.ops.returns.map(x=>[x.status,x.approved_by,x.user,x.kind,typeof x.lines]),r.ops.approvals.map(a=>a.status),r.ops.activity.map(a=>a.kind));
r=run(base('decide_approval','Siti','1111',{request_id:pendR.request_id,decision:'approved'}),Object.assign({},dbRet,{ap:[pendR]})); console.log('R10 kasir cannot decide',r.response.error);
const ownR=Object.assign({},pendR,{approver_role:'owner'});
r=run(base('decide_approval','Jihan','2222',{request_id:pendR.request_id,decision:'approved'}),Object.assign({},dbRet,{ap:[ownR]})); console.log('R11 manager on owner-level',r.response.error);
r=run(base('decide_approval','Jihan','2222',{request_id:pendR.request_id,decision:'rejected',note:'barang masih bagus'}),Object.assign({},dbRet,{ap:[pendR]})); console.log('R12 reject',r.ops.returns.map(x=>x.status),r.ops.products.length,r.ops.payments.length,r.ops.approvals.map(a=>a.status));
// potong hutang
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'salah_kirim',refund_method:'potong_hutang',lines:[{product_id:2,qty:1}]}),dbRet); const apH=Object.assign({id:71},r.ops.approvals[0]); delete apH._id;
r=run(base('decide_approval','Pemilik','1234',{request_id:apH.request_id,decision:'approved'}),Object.assign({},dbRet,{ap:[apH]})); console.log('R13 potong hutang',r.ops.customers.map(c=>[c._id,c.debt_balance]),r.ops.payments.length,r.ops.products.map(p=>[p.name,p.stock]));
// supplier return
const purR=[{id:1,purchase_no:'PB9',supplier:'PT Kurma',purchase_date:'2026-10-01',product_id:1,qty:10,cost_price:150000,total:1500000}];
const dbSR=Object.assign({},db,{pbn:purR,ph:[{id:5,photo_id:'PHRET1',kind:'retur'}]});
r=run(base('request_return','Siti','1111',{kind:'pemasok',purchase_no:'PB9',reason_code:'tidak_sesuai',reason_note:'ukuran beda',out_doc_no:'rt-001/x',photo_id:'PHRET1',carrier:{type:'pemasok',name:'Pak Joko',vehicle:'b 9 abc'},lines:[{product_id:1,qty:4}]}),dbSR);
const apS=r.ops.approvals[0]; const plS=JSON.parse(apS.payload); console.log('S1 supplier return',r.response.ok,apS.approver_role,apS.total,plS.out_doc_no,plS.carrier_vehicle,plS.party_name,'| kasir sees value?',JSON.stringify(r.response.approval.payload).includes('600000'), r.response.approval.total);
r=run(base('request_return','Siti','1111',{kind:'pemasok',purchase_no:'PB9',reason_code:'tidak_sesuai',out_doc_no:'RT1',lines:[{product_id:1,qty:4}]}),dbSR); console.log('S2 no photo',r.response.message);
r=run(base('request_return','Siti','1111',{kind:'pemasok',purchase_no:'PB9',reason_code:'tidak_sesuai',photo_id:'PHRET1',lines:[{product_id:1,qty:4}],carrier:{type:'karyawan',name:'Udin'}}),dbSR); console.log('S3 no out doc',r.response.message);
r=run(base('request_return','Siti','1111',{kind:'pemasok',purchase_no:'PB9',reason_code:'tidak_sesuai',out_doc_no:'RT1',photo_id:'PHRET1',lines:[{product_id:1,qty:11}],carrier:{type:'karyawan',name:'Udin'}}),dbSR); console.log('S4 more than bought',r.response.message);
r=run(base('request_return','Siti','1111',{kind:'pemasok',purchase_no:'PB9',reason_code:'tidak_sesuai',out_doc_no:'RT1',photo_id:'PHRET1',lines:[{product_id:2,qty:1}],carrier:{type:'karyawan',name:'Udin'}}),dbSR); console.log('S5 not on note',r.response.message);
const apS2=Object.assign({id:72},apS); delete apS2._id;
r=run(base('decide_approval','Pemilik','1234',{request_id:apS2.request_id,decision:'approved'}),Object.assign({},dbSR,{ap:[apS2]})); console.log('S6 approve supplier',r.ops.products.map(p=>[p.stock]),r.ops.purchases.map(x=>[x.qty,x.total,x.purchase_no.slice(0,2),x.supplier,x.match_status]),r.ops.returns.map(x=>x.status));
r=run(base('list_returns','Jihan','2222',{from:'2026-10-01',to:'2026-10-07'}),Object.assign({},db,{ap:[apS2,pendR],rret:[Object.assign({id:1,at:'2026-10-06T10:00:00Z'},plS,{lines:JSON.stringify(plS.lines),status:'approved'})]})); console.log('S7 manager list',r.response.returns.map(x=>[x.kind,x.status,'value' in x]));
r=run(base('list_returns','Siti','1111',{}),Object.assign({},db,{ap:[apS2,pendR]})); console.log('S8 kasir list',r.response.returns.map(x=>[x.kind,x.status,x.refund]));
// carrier at goods-in
const dbG=Object.assign({},db,{settings:[{id:1,skey:'require_purchase_photo',svalue:'false'}]});
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',items:[{product_id:1,qty:1,cost_price:1}]}),dbG); console.log('C1 no carrier',r.response.error,r.response.message);
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',carrier:{type:'umum',kind:'ojek'},items:[{product_id:1,qty:1,cost_price:1}]}),dbG); console.log('C2 umum no number',r.response.message);
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',carrier:{type:'teman'},items:[{product_id:1,qty:1,cost_price:1}]}),dbG); console.log('C3 teman no name',r.response.message);
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',carrier:{type:'umum',kind:'angkot',vehicle:'M 06'},items:[{product_id:1,qty:1,cost_price:1}]}),dbG); console.log('C4 ok',r.response.ok,r.ops.purchases.map(x=>[x.carrier_type,x.carrier_name,x.carrier_vehicle]),r.ops.activity.map(a=>a.summary));
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',carrier:{type:'teman',name:'Ali; DROP TABLE'},items:[{product_id:1,qty:1,cost_price:1}]}),dbG); console.log('C5 code in name',r.response.message);
// validation
r=run(base('save_customer','Siti','1111',{name:'Toko <b>Maju</b> 2',phone:'0812'}),db); console.log('V1 tags now lock (code)',r.response.error,'locked='+!!(r.ops.settings||[]).find(x=>x.skey==='locked_accounts'));
r=run(base('save_customer','Siti','1111',{name:'Toko {Maju}',phone:'0812'}),db); console.log('V2 braces refused',r.response.error);
r=run(base('save_customer','Siti','1111',{name:'Bu Ani',phone:'0812abc'}),db); console.log('V3 phone letters',r.response.message);
r=run(base('save_product','Pemilik','1234',{name:'Madu "Asli"',sku:'X1'}),db); console.log('V4 product quote',r.response.error);
r=run(base('save_product','Pemilik','1234',{name:'Kurma Ajwa 1kg (Premium) 10%',sku:'89912345;'}),db); console.log('V5 sku',r.response.message);
r=run(base('save_user','Pemilik','1234',{name:'admin<script>',role:'kasir',pin_hash:h('x','1')}),db); console.log('V6 owner code → INVALID',r.response.error,'noUserWrite='+!(r.ops.users||[]).length);
r=run(base('save_user','Pemilik','1234',{name:'a=b',role:'kasir',pin_hash:h('x','1')}),db); console.log('V7 user =',r.response.error);
r=run(Object.assign(base('save_customer','Siti','1111',{}),{data:JSON.parse('{"name":"Bu Ana","__proto__":{"isAdmin":true},"notes":"a\\u0000b\\u202Ec"}')}),db); console.log('V8 proto/control',r.response.ok,JSON.stringify(r.ops.customers[0].notes),({}).isAdmin);
// ---- agent follow-ups ----
const dbSa=JSON.parse(JSON.stringify(db)); dbSa.users.push({id:4,name:'Ahmad',role:'sales',pin_hash:h('Ahmad','4444'),active:true,must_change:true});
r=run(base('change_pin','Ahmad','4444',{new_pin_hash:h('Ahmad','9876')}),dbSa); console.log('F1 sales change_pin',r.response.ok);
dbSa.users[1].locked_until=new Date(Date.now()+60000).toISOString();
r=run(base('login','Siti','1111',{}),dbSa); console.log('F2 locked_until field',r.response.error,!!r.response.locked_until);
r=run(base('get_sale','Siti','1111',{invoice_no:'KMR1'}),Object.assign({},dbRet,{ap:[pendR]})); console.log('F3 get_sale',r.response.ok,r.response.sale.invoice_no,'profit' in r.response.sale,r.response.items.length,'cost_price' in r.response.items[0],JSON.stringify(r.response.returned),r.response.customer_debt);
r=run(base('get_sale','Siti','1111',{invoice_no:'NOPE'}),dbRet); console.log('F4 missing',r.response.error);
// ---- owner answers: manager sees profit, agreed return limit ----
r=run(base('list_approvals','Jihan','2222',{}),Object.assign({},db,{ap:[stored]})); const mg=r.response.approvals[0]; console.log('G1 manager sees profit',/laba/.test(mg.summary),JSON.parse(mg.payload).margin_before);
r=run(base('request_discount','Siti','1111',{client_id:'g2',sale_date:'2026-10-06',items:[it(1,1,185000)],discount:9250}),db); console.log('G2 kasir no profit',/laba/.test(r.response.approval.summary),'margin_before' in JSON.parse(r.response.approval.payload));
r=run(base('save_settings','Pemilik','1234',{settings:{return_owner_min_value:3000000}}),db); console.log('G3 direct change blocked',r.response.error);
r=run(base('save_settings','Pemilik','1234',{settings:{return_owner_min_value:2000000,paper:'80'}}),db); console.log('G4 same value ok',r.response.ok);
r=run(base('propose_agreement','Pemilik','1234',{key:'return_owner_min_value',value:3000000,note:'disepakati di rapat'}),db); const ag=Object.assign({id:80},r.ops.approvals[0]); delete ag._id; console.log('G5 owner proposes',r.response.ok,ag.kind,ag.approver_role,ag.summary);
r=run(base('decide_approval','Pemilik','1234',{request_id:ag.request_id,decision:'approved'}),Object.assign({},db,{ap:[ag]})); console.log('G6 owner self-confirm',r.response.error);
r=run(base('decide_approval','Siti','1111',{request_id:ag.request_id,decision:'approved'}),Object.assign({},db,{ap:[ag]})); console.log('G7 kasir',r.response.error);
r=run(base('decide_approval','Jihan','2222',{request_id:ag.request_id,decision:'approved'}),Object.assign({},db,{ap:[ag]})); console.log('G8 manager confirms',r.response.ok,r.ops.settings.map(x=>x.skey+'='+x.svalue.slice(0,120)),r.ops.activity.map(a=>a.kind));
r=run(base('propose_agreement','Jihan','2222',{key:'return_owner_min_qty',value:50}),db); const ag2=Object.assign({id:81},r.ops.approvals[0]); delete ag2._id; console.log('G9 manager proposes',ag2.approver_role);
r=run(base('decide_approval','Jihan','2222',{request_id:ag2.request_id,decision:'approved'}),Object.assign({},db,{ap:[ag2]})); console.log('G10 manager self',r.response.error);
r=run(base('decide_approval','Pemilik','1234',{request_id:ag2.request_id,decision:'rejected'}),Object.assign({},db,{ap:[ag2]})); console.log('G11 owner rejects',r.response.ok,r.ops.settings.length,r.ops.approvals.map(a=>a.status));
r=run(base('propose_agreement','Siti','1111',{key:'return_owner_min_value',value:1}),db); console.log('G12 kasir propose',r.response.error);
r=run(base('propose_agreement','Pemilik','1234',{key:'max_discount_pct',value:50}),db); console.log('G13 other key',r.response.error);
r=run(base('request_return','Siti','1111',{kind:'pelanggan',invoice_no:'KMR1',reason_code:'rusak',lines:[{product_id:1,qty:2}]}),dbRet); console.log('G14 default limit 2jt: 351500 → manager',r.response.approver_role);
// ---- manager as cashier ----
r=run(base('open_shift','Jihan','2222',{opening_cash:300000}),Object.assign({},db,{os:[]})); console.log('H1 manager opens drawer',r.response.ok,r.response.shift&&r.response.shift.cashier,r.ops.approvals[0]&&r.ops.approvals[0].approver_role);
const mgrShift={id:30,shift_id:'SHM',cashier:'Jihan',status:'open',opening_cash:300000,cash_sales:0,cash_payments:0,cash_in:0,cash_out:0,sales_count:0,sales_total:0,moves:'[]',note:''};
r=run(base('save_sale','Jihan','2222',{client_id:'h2',sale_date:'2026-10-07',items:[it(1,1,185000)],payment_method:'tunai',paid_amount:200000}),Object.assign({},db,{os:[mgrShift]})); console.log('H2 manager cash sale into her drawer',r.response.ok,r.response.sale.shift_id,r.ops.shifts.map(x=>[x.cashier,x.cash_sales]));
r=run(base('save_sale','Jihan','2222',{client_id:'h3',sale_date:'2026-10-07',items:[it(1,1,185000)],payment_method:'tunai',paid_amount:200000}),Object.assign({},db,{os:[]})); console.log('H3 manager without drawer still sells',r.response.ok,r.ops.shifts.length);
r=run(base('close_shift','Jihan','2222',{counted_cash:485000}),Object.assign({},db,{os:[Object.assign({},mgrShift,{cash_sales:185000})]})); console.log('H4 manager closes',r.response.ok,r.response.shift.difference);
const bkM=Object.assign({id:90,request_id:'APBKM',kind:'buka_kas',approver_role:'owner',status:'pending',cashier:'Jihan',total:300000,summary:'Buka kas Jihan'});
r=run(base('decide_approval','Jihan','2222',{request_id:'APBKM',decision:'approved'}),Object.assign({},db,{ap:[bkM]})); console.log('H5 manager cannot approve own',r.response.error);
r=run(base('decide_approval','Pemilik','1234',{request_id:'APBKM',decision:'approved'}),Object.assign({},db,{ap:[bkM]})); console.log('H6 owner approves',r.response.ok);
r=run(base('open_shift','Pemilik','1234',{opening_cash:1}),Object.assign({},db,{os:[]})); console.log('H7 owner drawer',r.response.error);
// ---- receipt fee + rename ----
const dbF2=JSON.parse(JSON.stringify(db)); dbF2.customers.push({id:9,name:'Bu Lina',phone:'6281300001111',type:'eceran',debt_balance:0,receipts_sent:0},{id:10,name:'Pak Doni',phone:'6281300002222',type:'eceran',debt_balance:0,receipts_sent:2});
r=run(base('save_sale','Siti','1111',{client_id:'f1',sale_date:'2026-10-07',customer_id:9,send_receipt:true,items:[it(1,1,185000)],payment_method:'tunai',paid_amount:185000}),dbF2); console.log('K1 first receipt free',r.response.ok,r.response.sale.send_fee,r.response.sale.total,r.ops.customers.map(c=>c.receipts_sent));
r=run(base('save_sale','Siti','1111',{client_id:'f2',sale_date:'2026-10-07',customer_id:10,send_receipt:true,items:[it(1,1,185000)],payment_method:'tunai',paid_amount:185500}),dbF2); console.log('K2 later receipt +500',r.response.ok,r.response.sale.send_fee,r.response.sale.total,r.ops.customers.map(c=>c.receipts_sent),r.ops.shifts.map(s=>s.cash_sales));
r=run(base('save_sale','Siti','1111',{client_id:'f3',sale_date:'2026-10-07',customer_id:10,send_receipt:true,items:[it(1,1,185000)],discount:5550,payment_method:'tunai',paid_amount:200000}),dbF2); console.log('K3 fee not counted as discount offset',r.response.ok,r.response.sale.total);
r=run(base('save_sale','Siti','1111',{client_id:'f4',sale_date:'2026-10-07',customer_id:10,items:[it(1,1,185000)],payment_method:'tunai',paid_amount:185000}),dbF2); console.log('K4 no send no fee',r.response.sale.send_fee,r.response.sale.total);
r=run(base('save_sale','Siti','1111',{client_id:'f5',sale_date:'2026-10-07',send_receipt:true,items:[it(1,1,185000)],payment_method:'tunai',paid_amount:185000}),dbF2); console.log('K5 no customer',r.response.message);
r=run(base('save_sale','Siti','1111',{client_id:'f6',sale_date:'2026-10-07',customer_id:10,send_receipt:true,items:[it(1,1,185000)],payment_method:'tunai',paid_amount:185500}),Object.assign({},dbF2,{settings:[{id:1,skey:'receipt_send_fee',svalue:'0'}]})); console.log('K6 fee 0 setting',r.response.sale.send_fee);
r=run(base('save_user','Pemilik','1234',{name:'Siti',new_name:'Rahma',role:'kasir',pin_hash:h('Rahma','4321')}),Object.assign({},db,{os:[]})); console.log('K7 rename',r.response.ok,JSON.stringify(r.ops.users.map(u=>[u._id,u.name,u.must_change,u.role])),r.ops.activity.map(a=>a.summary));
r=run(base('save_user','Pemilik','1234',{name:'Siti',new_name:'Rahma',role:'kasir',pin_hash:h('Rahma','4321')}),db); console.log('K8 open drawer blocks rename',r.response.message);
r=run(base('save_user','Pemilik','1234',{name:'Siti',new_name:'Jihan',role:'kasir',pin_hash:h('Jihan','4321')}),Object.assign({},db,{os:[]})); console.log('K9 name taken',r.response.message);
r=run(base('save_user','Pemilik','1234',{name:'Siti',new_name:'Rahma',role:'kasir'}),Object.assign({},db,{os:[]})); console.log('K10 rename needs pin',r.response.message);
r=run(base('save_user','Pemilik','1234',{name:'Jihan',new_name:'Nur Aini',role:'manager',pin_hash:h('Nur Aini','111111')}),Object.assign({},db,{os:[]})); console.log('K11 change manager person',r.response.ok,r.ops.users.map(u=>[u.name,u.role,u.must_change]));
