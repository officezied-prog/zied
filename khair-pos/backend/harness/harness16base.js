const fs=require('fs'), crypto=require('crypto');
const KEY=fs.readFileSync(__dirname + '/storekey.txt','utf8').trim();
const code=fs.readFileSync(__dirname + '/../process.js','utf8').replace('__STORE_KEY__',KEY);
const fn=new Function('$', code);
const h=(u,p)=>crypto.createHash('sha256').update(KEY+':'+u.toLowerCase()+':'+p).digest('hex');
const DEFSHIFTS=[{id:21,shift_id:'SHS',cashier:'Siti',status:'open',opening_cash:200000,cash_sales:0,cash_payments:0,cash_in:0,cash_out:0,sales_count:0,sales_total:0,moves:'[]',note:''},{id:22,shift_id:'SHJ',cashier:'Jihan',status:'open',opening_cash:0,cash_sales:0,cash_payments:0,cash_in:0,cash_out:0,sales_count:0,sales_total:0,moves:'[]',note:''}];
function run(req, db){
  const nodes={'Parse Request':[req],'Get Users':db.users,'Get Settings':(db.settings||[]).concat([{id:99,skey:"max_discount_pct",svalue:"100"},{id:98,skey:"require_carrier",svalue:"false"}]),'Get Products':db.products,'Get Customers':db.customers,
   'Get Sale By Client':db.byClient||[{}],'Get Sale By Invoice':db.byInv||[{}],'Get Items By Invoice':db.itemsByInv||[{}],
   'Get Range Sales':db.rs||[{}],'Get Range Items':db.ri||[{}],'Get Range Payments':db.rp||[{}],'Get Range Purchases':db.rpu||[{}],'Get Approvals':db.ap||[{}],'Get Photo':db.ph||[{}],'Get Range Expenses':db.re||[{}],'Get Open Shifts':db.os||DEFSHIFTS,'Get Range Shifts':db.rsh||[{}],'Get Devices':db.dev||[{}],'Get Range Repacks':db.rr||[{}],'Get Purchase By No':db.pbn||[{}],'Get Range Activity':db.act||[{}],'Get Party Payments':db.pp||[{}],'Get Party Sales':db.ps||[{}],'Get Party Purchases':db.pu||[{}],'Get Bank Lines':db.bl||[{}]};
  const $=n=>({first:()=>({json:(nodes[n]||[{}])[0]}),all:()=>(nodes[n]||[]).map(j=>({json:j}))});
  return fn($)[0].json;
}
const db={users:[{id:1,name:'Pemilik',role:'owner',pin_hash:h('Pemilik','1234'),active:true},{id:2,name:'Siti',role:'kasir',pin_hash:h('Siti','1111'),active:true},{id:3,name:'Jihan',role:'manager',pin_hash:h('Jihan','2222'),active:true}],
 products:[{id:1,sku:'111',name:'Kurma Ajwa 1kg',category:'kurma',unit:'kg',cost_price:150000,retail_price:185000,wholesale_price:170000,wholesale_min_qty:5,stock:20,min_stock:3,active:true,notes:''},
           {id:2,sku:'222',name:'Kismis 500g',category:'kismis',unit:'pcs',cost_price:20000,retail_price:25000,wholesale_price:23000,wholesale_min_qty:10,stock:50,min_stock:5,active:true,notes:''}],
 customers:[{id:7,name:'Toko Berkah',phone:'0812',type:'grosir',address:'',notes:'',debt_balance:100000}]};
const base=(action,user,pin,data)=>({ip:'1.2.3.4',ua:'Mozilla/5.0 (Linux; Android 14)',action,key:KEY,user,pin_hash:h(user,pin),data,client_id:data.client_id||'__none__',invoice_no:data.invoice_no||'__none__',from:data.from||'9999-12-31',to:data.to||'0000-01-01'});
let r;
r=run({action:'users',key:KEY,data:{}},db); console.log('users',JSON.stringify(r.response));
r=run({action:'users',key:'x',data:{}},db); console.log('badkey',r.response.error);
r=run(base('login','Siti','0000',{}),db); console.log('badpin',r.response.error);
r=run(base('bootstrap','Siti','1111',{}),db); console.log('boot kasir cost?', 'cost_price' in r.response.products[0], r.response.settings.paper);
r=run(base('save_sale','Siti','1111',{client_id:'c1',sale_date:'2026-10-06',items:[{product_id:1,qty:2,unit_price:185000,price_type:'eceran'},{product_id:2,qty:10,unit_price:23000,price_type:'grosir'}],discount:5000,payment_method:'tunai',paid_amount:600000,survey:[{q:'Tahu dari mana?',a:'TikTok'}],survey_consent:true}),db);
console.log('sale',JSON.stringify(r.response).slice(0,400)); console.log('ops',Object.fromEntries(Object.entries(r.ops).map(([k,v])=>[k,v.length])), r.ops.products.map(p=>[p._id,p.stock]));
r=run(base('save_sale','Siti','1111',{client_id:'c2',sale_date:'2026-10-06',items:[{product_id:1,qty:1,unit_price:185000}],payment_method:'hutang'}),db); console.log('hutang no cust',r.response.error);
r=run(base('save_sale','Pemilik','1234',{client_id:'c3',sale_date:'2026-10-06',customer_id:7,items:[{product_id:1,qty:5,unit_price:170000,price_type:'grosir'}],payment_method:'hutang'}),db); console.log('hutang',r.response.sale.debt_amount, r.ops.customers.map(c=>[c._id,c.debt_balance]));
r=run(Object.assign(base('save_sale','Siti','1111',{client_id:'c1'}),{}),Object.assign({},db,{byClient:[{id:9,client_id:'c1',invoice_no:'KMX',total:1,profit:5}]})); console.log('dup',r.response.duplicate,r.response.invoice_no, 'profit' in r.response.sale);
r=run(base('void_sale','Siti','1111',{invoice_no:'KMX'}),db); console.log('void kasir',r.response.error);
r=run(base('void_sale','Pemilik','1234',{invoice_no:'KMX',reason:'salah'}),Object.assign({},db,{byInv:[{id:9,invoice_no:'KMX',customer_id:7,debt_amount:50000,status:'ok',notes:''}],itemsByInv:[{id:1,invoice_no:'KMX',product_id:1,qty:2}]})); console.log('void',r.response.sale.status,r.ops.products.map(p=>[p._id,p.stock]),r.ops.customers.map(c=>c.debt_balance),r.ops.sales[0]._id);
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',items:[{product_id:1,qty:20,cost_price:160000}]}),db); console.log('purchase no photo',r.response.error);
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',photo_id:'PH1',items:[{product_id:1,qty:20,cost_price:160000}]}),Object.assign({},db,{ph:[{id:1,photo_id:'PH1',kind:'masuk'}]})); console.log('purchase photo_id',r.ops.purchases[0].photo_id); console.log('purchase',JSON.stringify(r.response));
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:30000,method:'tunai'}),db); console.log('pay',r.response.customer.debt_balance,r.ops.payments.length);
r=run(base('import_products','Pemilik','1234',{rows:[{sku:'111',retail_price:190000},{name:'Cokelat Arab',sku:'333',retail_price:30000,stock:10}]}),db); console.log('import',JSON.stringify(r.response), r.ops.products.map(p=>[p._id,p.name,p.retail_price,p.stock]));
r=run(base('save_settings','Pemilik','1234',{settings:{paper:'80',survey_questions:['a','b']}}),db); console.log('settings',JSON.stringify(r.ops.settings));
r=run(base('save_user','Pemilik','1234',{name:'Budi',role:'kasir',pin_hash:h('Budi','2222')}),db); console.log('user',JSON.stringify(r.response));
r=run(base('save_user','Pemilik','1234',{name:'Pemilik',role:'kasir'}),db); console.log('last owner',r.response.error);
r=run(base('get_sales','Siti','1111',{from:'2026-10-01',to:'2026-10-06'}),Object.assign({},db,{rs:[{id:1,total:10,profit:3,total_cost:7}],ri:[{id:1,line_profit:2,cost_price:1}]})); console.log('get_sales kasir',JSON.stringify(r.response));
r=run({action:'setup',key:KEY,data:{owner_name:'X',pin_hash:h('X','1')}},Object.assign({},db,{users:[]})); console.log('setup',JSON.stringify(r.response), r.ops.users.length);
r=run(base('stock_adjust','Pemilik','1234',{product_id:2,new_stock:45,reason:'opname'}),db); console.log('adjust',r.response.product.stock,r.ops.purchases[0].qty);

const hs=(d)=>({client_id:'h1',sale_date:'2026-10-06',customer_id:7,items:[{product_id:1,qty:1,unit_price:185000}],payment_method:'hutang',...d});
r=run(base('save_sale','Siti','1111',hs({})),db); console.log('A kasir hutang',r.response.error);
r=run(base('save_sale','Siti','1111',hs({approver:{user:'Jihan',pin_hash:h('Jihan','9999')}})),db); console.log('B wrong pin',r.response.error);
r=run(base('save_sale','Siti','1111',hs({approver:{user:'Siti',pin_hash:h('Siti','1111')}})),db); console.log('C kasir approver',r.response.error);
r=run(base('save_sale','Siti','1111',hs({approver:{user:'jihan',pin_hash:h('Jihan','2222')}})),db); console.log('D onsite',r.response.ok,r.response.sale.approved_by,r.response.exit_photo_required);
r=run(base('save_sale','Jihan','2222',hs({})),db); console.log('E manager self',r.response.ok,r.response.sale.approved_by,'profit' in r.response.sale);
r=run(base('request_credit','Siti','1111',hs({})),db); console.log('F request',r.response.request_id,r.response.approval.debt_amount,r.ops.approvals.length);
const ap={id:5,request_id:'APX',client_id:'h1',customer_id:7,total:185000,debt_amount:185000,status:'pending',note:''};
r=run(base('list_approvals','Siti','1111',{}),Object.assign({},db,{ap:[ap]})); console.log('G kasir list',r.response.error);
r=run(base('list_approvals','Jihan','2222',{}),Object.assign({},db,{ap:[ap]})); console.log('H list',r.response.approvals.length);
r=run(base('save_sale','Siti','1111',hs({approval_id:'APX'})),Object.assign({},db,{ap:[ap]})); console.log('I pending',r.response.message);
r=run(base('decide_approval','Jihan','2222',{request_id:'APX',decision:'approved'}),Object.assign({},db,{ap:[ap]})); console.log('J decide',r.response.approval.status,r.response.approval.decided_by,r.ops.approvals[0]._id);
const apOk=Object.assign({},ap,{status:'approved',decided_by:'Jihan'});
r=run(base('save_sale','Siti','1111',hs({approval_id:'APX'})),Object.assign({},db,{ap:[apOk]})); console.log('K remote ok',r.response.ok,r.response.sale.approved_by,r.ops.approvals[0].status);
r=run(base('save_sale','Siti','1111',hs({approval_id:'APX',items:[{product_id:1,qty:2,unit_price:185000}]})),Object.assign({},db,{ap:[apOk]})); console.log('L changed',r.response.message);
r=run(base('save_sale','Siti','1111',hs({approval_id:'APX'})),Object.assign({},db,{ap:[Object.assign({},ap,{status:'rejected',note:'limit'})]})); console.log('M rejected',r.response.message);
r=run(base('save_sale','Siti','1111',{client_id:'x9',sale_date:'2026-10-06',items:[{product_id:2,qty:25,unit_price:23000}],payment_method:'tunai',paid_amount:575000}),db); console.log('N exit qty',r.response.exit_photo_required,r.ops.sales[0].exit_photo);
r=run(base('save_sale','Siti','1111',{client_id:'x8',sale_date:'2026-10-06',items:[{product_id:2,qty:1,unit_price:23000}],payment_method:'tunai',paid_amount:23000}),db); console.log('O small',r.response.exit_photo_required,JSON.stringify(r.ops.sales[0].exit_photo));
r=run(base('save_purchase','Siti','1111',{supplier:'PT A',items:[{product_id:1,qty:2,cost_price:1}]}),Object.assign({},db,{settings:[{id:1,skey:'require_purchase_photo',svalue:'false'}]})); console.log('P photo off',r.response.ok);

const sale9={id:9,invoice_no:'KMX',sale_date:'2026-10-01',cashier:'Siti',customer_id:7,customer_name:'Toko Berkah',total:340000,debt_amount:50000,status:'ok',notes:''};
const vdb=Object.assign({},db,{byInv:[sale9],itemsByInv:[{id:1,invoice_no:'KMX',product_id:1,qty:2}]});
r=run(base('request_void','Siti','1111',{invoice_no:'KMX',reason:'salah harga'}),vdb); console.log('V1 req void',r.response.ok,r.response.approval.kind,r.response.approval.approver_role,r.response.approval.can_decide);
const vap={id:11,request_id:'APV',kind:'void',ref:'KMX',approver_role:'owner',status:'pending',note:'salah harga',cashier:'Siti',payload:''};
r=run(base('decide_approval','Jihan','2222',{request_id:'APV',decision:'approved',invoice_no:'KMX'}),Object.assign({},vdb,{ap:[vap]})); console.log('V2 manager void',r.response.error);
r=run(base('list_approvals','Jihan','2222',{}),Object.assign({},vdb,{ap:[vap]})); console.log('V3 list can_decide',r.response.approvals[0].can_decide);
r=run(base('decide_approval','Pemilik','1234',{request_id:'APV',decision:'approved'}),Object.assign({},vdb,{ap:[vap],byInv:[{}]})); console.log('V4 no invoice',r.response.message);
r=run(base('decide_approval','Pemilik','1234',{request_id:'APV',decision:'approved',invoice_no:'KMX'}),Object.assign({},vdb,{ap:[vap]})); console.log('V5 owner void',r.response.sale.status,r.ops.products.map(p=>[p._id,p.stock]),r.ops.customers.map(c=>c.debt_balance),r.ops.approvals[0].status);
r=run(base('void_sale','Pemilik','1234',{invoice_no:'KMX',reason:'x'}),vdb); console.log('V6 direct void',r.response.sale.status);
r=run(base('change_price','Jihan','2222',{product_id:1,wholesale_price:168000,reason:'promo'}),db); console.log('P1 mgr wholesale',r.response.applied,r.response.product.wholesale_price,'cost_price' in r.response.product,r.ops.approvals[0].status);
r=run(base('change_price','Jihan','2222',{product_id:1,cost_price:155000}),db); console.log('P2 mgr cost',r.response.applied,r.response.approval.approver_role,r.response.approval.payload,r.response.approval.summary);
r=run(base('change_price','Siti','1111',{product_id:1,retail_price:190000}),db); console.log('P3 kasir',r.response.applied,r.response.approval.approver_role);
r=run(base('change_price','Siti','1111',{product_id:1,retail_price:185000}),db); console.log('P4 nochange',r.response.error);
const pap={id:12,request_id:'APP',kind:'price',ref:'1',approver_role:'owner',status:'pending',payload:JSON.stringify({changes:{cost_price:{from:150000,to:155000}}})};
r=run(base('decide_approval','Jihan','2222',{request_id:'APP',decision:'approved'}),Object.assign({},db,{ap:[pap]})); console.log('P5 mgr decide cost',r.response.error);
r=run(base('decide_approval','Pemilik','1234',{request_id:'APP',decision:'approved'}),Object.assign({},db,{ap:[pap]})); console.log('P6 owner',r.response.product.cost_price,r.ops.products[0].cost_price);
r=run(base('save_product','Pemilik','1234',{id:1,name:'Kurma Ajwa 1kg',sku:'111',cost_price:150000,retail_price:189000,wholesale_price:170000}),db); console.log('P7 log',r.ops.approvals.length,r.ops.approvals[0]&&r.ops.approvals[0].summary);
r=run(base('save_expense','Siti','1111',{expense_date:'2026-10-06',category:'listrik_air',amount:350000,note:'PLN'}),db); console.log('E1',JSON.stringify(r.response));
r=run(base('save_expense','Siti','1111',{amount:0}),db); console.log('E2',r.response.error);
r=run(base('get_sales','Siti','1111',{from:'2026-01-01',to:'2026-12-31'}),Object.assign({},db,{re:[{id:1,amount:5}]})); console.log('E3',r.response.expenses.length);
r=run(base('save_sale','Siti','1111',hs({approval_id:'APV'})),Object.assign({},db,{ap:[Object.assign({},vap,{status:'approved',client_id:'h1',customer_id:7,total:999999,debt_amount:999999})]})); console.log('C9 wrong kind',r.response.message);

r=run(base('save_sale','Siti','1111',{client_id:'s1',sale_date:'2026-10-06',items:[{product_id:2,qty:1,unit_price:23000}],payment_method:'tunai',paid_amount:23000}),Object.assign({},db,{os:[]})); console.log('S1 no shift',r.response.error, Object.values(r.ops).every(a=>a.length===0));
r=run(base('save_sale','Pemilik','1234',{client_id:'s2',sale_date:'2026-10-06',items:[{product_id:2,qty:1,unit_price:23000}],payment_method:'tunai',paid_amount:23000}),Object.assign({},db,{os:[]})); console.log('S2 owner no shift',r.response.ok);
r=run(base('open_shift','Siti','1111',{opening_cash:200000}),Object.assign({},db,{os:[]})); console.log('S3 open',r.response.shift.status,r.response.shift.opening_cash,r.ops.shifts[0]._id, 'cash_sales' in r.response.shift);
r=run(base('save_sale','Siti','1111',{client_id:'s3',sale_date:'2026-10-06',items:[{product_id:2,qty:2,unit_price:23000}],payment_method:'tunai',paid_amount:50000,channel:'whatsapp',promo_code:'khair-1111 !'}),db); console.log('S4 sale',r.response.sale.channel,r.response.sale.promo_code,r.response.sale.shift_id,JSON.stringify(r.ops.shifts.map(x=>[x._id,x.cash_sales,x.sales_count,x.sales_total])));
r=run(base('save_sale','Siti','1111',{client_id:'s4',sale_date:'2026-10-06',items:[{product_id:2,qty:2,unit_price:23000}],payment_method:'qris',paid_amount:46000}),db); console.log('S5 qris cash',r.ops.shifts[0].cash_sales);
r=run(base('cash_move','Siti','1111',{type:'out',amount:20000,note:'beli plastik'}),db); console.log('S6 move',r.ops.shifts[0].cash_out,JSON.parse(r.ops.shifts[0].moves).length);
r=run(base('save_expense','Siti','1111',{category:'kemasan',amount:15000,note:'lakban'}),db); console.log('S7 exp kas',r.ops.expenses[0].paid_from,r.ops.shifts[0].cash_out);
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:30000,method:'tunai'}),db); console.log('S8 pay',r.ops.shifts[0].cash_payments);
const sOpen=[Object.assign({},DEFSHIFTS[0],{cash_sales:46000,cash_payments:30000,cash_in:0,cash_out:35000})];
r=run(base('close_shift','Siti','1111',{counted_cash:240000}),Object.assign({},db,{os:sOpen})); console.log('S9 close',r.response.shift.expected_cash,r.response.shift.difference,r.response.shift.status);
r=run(base('close_shift','Jihan','2222',{cashier:'Siti',counted_cash:241000}),Object.assign({},db,{os:sOpen})); console.log('S10 mgr close',r.response.shift.difference,r.response.shift.note);
r=run(base('bootstrap','Siti','1111',{}),db); console.log('S11 boot kasir',JSON.stringify(r.response.shift),r.response.open_shifts.length);
r=run(base('bootstrap','Pemilik','1234',{}),db); console.log('S12 boot owner',r.response.shift,r.response.open_shifts.length,'cash_sales' in r.response.open_shifts[0]);
r=run(base('get_sales','Pemilik','1234',{from:'2026-10-01',to:'2026-10-06'}),Object.assign({},db,{rsh:[{id:1,shift_id:'X'}]})); console.log('S13',r.response.shifts.length);
r=run(base('save_sale','Siti','1111',hs({approval_id:'APX'})),Object.assign({},db,{os:[],ap:[Object.assign({},{id:5,request_id:'APX',client_id:'h1',customer_id:7,total:185000,debt_amount:185000,status:'approved',decided_by:'Jihan',kind:'credit'})]})); console.log('S14 shift-first, approval untouched',r.response.error,r.ops.approvals.length);
const sdb=Object.assign({},db,{users:db.users.concat([{id:9,name:'Ahmad',role:'sales',pin_hash:h('Ahmad','4444'),active:true}])});
r=run(base('login','Ahmad','4444',{}),sdb); console.log('Z1 sales login',r.response.user.role);
r=run(base('bootstrap','Ahmad','4444',{}),sdb); console.log('Z2 boot',r.response.ok,'cost_price' in r.response.products[0]);
r=run(base('save_sale','Ahmad','4444',{client_id:'z',sale_date:'2026-10-06',items:[{product_id:2,qty:1,unit_price:1}]}),sdb); console.log('Z3 sale',r.response.error);
r=run(base('save_user','Pemilik','1234',{name:'Ahmad2',role:'sales',pin_hash:h('Ahmad2','1')}),sdb); console.log('Z4 create',r.response.user.role);
// v9: survey transcript + phone capture
const db9=Object.assign({},db,{customers:[{id:7,name:'Toko Berkah',phone:'0812',type:'grosir',address:'',notes:'',debt_balance:100000},{id:8,name:'Bu Rina',phone:'0812-3456-7890',type:'eceran',address:'Condet',notes:'x',debt_balance:0,wa_optin:false}]});
r=run(base('save_sale','Siti','1111',{client_id:'t1',sale_date:'2026-10-06',items:[{product_id:1,qty:1}],payment_method:'tunai',paid_amount:200000,survey:[],survey_consent:true,survey_transcript:'x'.repeat(5000)}),db9); console.log('transcript',r.ops.sales[0].survey_transcript.length);
r=run(base('save_sale','Siti','1111',{client_id:'t2',sale_date:'2026-10-06',items:[{product_id:1,qty:1}],payment_method:'tunai',paid_amount:200000,survey_transcript:'secret'}),db9); console.log('no consent',JSON.stringify(r.ops.sales[0].survey_transcript));
r=run(base('save_customer','Siti','1111',{phone:'0812 3456 7890',wa_optin:true,source:'kasir'}),db9); console.log('dup phone',r.response.existed,r.ops.customers[0]._id,r.ops.customers[0].name,r.ops.customers[0].phone,r.ops.customers[0].wa_optin,r.ops.customers[0].address,r.ops.customers[0].source);
r=run(base('save_customer','Siti','1111',{phone:'+62 857 1111 2222',wa_optin:true,source:'kasir'}),db9); console.log('new phone',r.response.existed,r.ops.customers[0]._id,r.ops.customers[0].name,r.ops.customers[0].phone,r.ops.customers[0].type);
r=run(base('save_customer','Siti','1111',{phone:'12'}),db9); console.log('bad phone no name',r.response.error);
r=run(base('save_customer','Pemilik','1234',{id:8,name:'Bu Rina',phone:'0812-3456-7890',type:'eceran',wa_optin:false}),db9); console.log('owner edit',r.response.existed,r.ops.customers[0]._id,r.ops.customers[0].wa_optin,r.ops.customers[0].phone);
r=run(base('save_customer','Pemilik','1234',{name:'Pak Ali',phone:'0812'}),db9); console.log('short phone kept',r.ops.customers[0].phone,r.ops.customers[0]._id);
r=run(base('save_settings','Pemilik','1234',{settings:{wa_shop_number:'0811-9008-0090',survey_voice:false}}),db9); console.log('settings',r.response.settings.wa_shop_number,r.response.settings.survey_voice,r.ops.settings.length);
r=run(base('bootstrap','Siti','1111',{}),db9); console.log('defaults',JSON.stringify(r.response.settings.wa_shop_number),r.response.settings.survey_voice);
// v10: stock count (opname) + expiry on purchases
r=run(base('stock_count','Pemilik','1234',{counts:[{product_id:1,counted:18},{product_id:2,counted:50}],note:'opname Oktober'}),db); console.log('owner opname',r.response.applied,JSON.stringify(r.ops.products.map(p=>[p._id,p.stock])),r.ops.purchases.length,r.ops.purchases[0].supplier,r.ops.purchases[0].qty,r.ops.purchases[0].note);
r=run(base('stock_count','Siti','1111',{counts:[{product_id:1,counted:17}]}),db); console.log('kasir opname',r.response.applied,r.response.approval.kind,r.response.approval.approver_role,r.ops.products.length,r.response.approval.summary);
const opAp={id:31,request_id:'APOP1',kind:'opname',status:'pending',approver_role:'owner',cashier:'Siti',note:'rak 1',payload:JSON.stringify({lines:[{product_id:1,name:'Kurma Ajwa 1kg',system:20,counted:17,diff:-3}]})};
const dbS=Object.assign({},db,{products:[Object.assign({},db.products[0],{stock:15}),db.products[1]],ap:[opAp]});
r=run(base('decide_approval','Jihan','2222',{request_id:'APOP1',decision:'approved'}),dbS); console.log('manager decide opname',r.response.error);
r=run(base('decide_approval','Pemilik','1234',{request_id:'APOP1',decision:'approved'}),dbS); console.log('owner decide opname',JSON.stringify(r.response.stock),r.ops.approvals[0].status,r.ops.purchases[0].user);
r=run(base('stock_count','Siti','1111',{counts:[{product_id:1,counted:-1}]}),db); console.log('neg',r.response.error);
r=run(base('stock_count','Siti','1111',{counts:[]}),db); console.log('empty',r.response.error);
r=run(base('save_purchase','Pemilik','1234',{items:[{product_id:1,qty:5,cost_price:150000,exp_date:'2027-03-01'},{product_id:2,qty:5,cost_price:20000,exp_date:'bad'}],settings:{}}),Object.assign({},db,{settings:[{id:1,skey:'require_purchase_photo',svalue:'false'}]})); console.log('purchase exp',r.ops.purchases.map(x=>x.exp_date));

// v11: devices
const D='dev_ABCDEFGH12';
r=run(base('device_ping','Siti','1111',{device:{id:D,app:'kasir',label:'Android · Chrome',lat:-6.262,lng:106.861,acc:12,loc_status:'granted',battery:0.8}}),db); console.log('ping new',r.response.ok,r.response.require_location,JSON.stringify(r.ops.devices[0]));
const devRow={id:5,device_id:D,user:'Siti',role:'kasir',app:'kasir',lat:-6.262,lng:106.861,acc:12,loc_status:'granted',last_seen:new Date(Date.now()-60000).toISOString(),first_seen:'2026-10-06T00:00:00Z',pings:3,loc_at:'x'};
r=run(base('bootstrap','Siti','1111',{device:{id:D,app:'kasir',lat:-6.2621,lng:106.8611,acc:10,loc_status:'granted'}}),Object.assign({},db,{dev:[devRow]})); console.log('piggy same place, fresh -> no write',r.ops.devices.length);
r=run(base('bootstrap','Siti','1111',{device:{id:D,app:'kasir',lat:-6.30,lng:106.861,acc:10,loc_status:'granted'}}),Object.assign({},db,{dev:[devRow]})); console.log('moved -> write',r.ops.devices.length,r.ops.devices[0]._id,r.ops.devices[0].pings);
r=run(base('bootstrap','Siti','1111',{device:{id:D,app:'kasir',loc_status:'denied'}}),Object.assign({},db,{dev:[devRow]})); console.log('denied keeps last loc',r.ops.devices[0].loc_status,r.ops.devices[0].lat,r.ops.devices[0].loc_at);
r=run(base('bootstrap','Siti','1111',{device:{id:'x'}}),db); console.log('bad id ignored',r.ops.devices.length,r.response.ok);
r=run(base('list_devices','Jihan','2222',{}),db); console.log('manager list',r.response.error);
r=run(base('list_devices','Pemilik','1234',{}),Object.assign({},db,{dev:[devRow,Object.assign({},devRow,{id:6,device_id:'dev_ZZZZZZZZ',last_seen:new Date().toISOString()})],settings:[{id:1,skey:'store_lat',svalue:'-6.26'},{id:2,skey:'store_lng',svalue:'106.86'}]})); console.log('owner list',r.response.devices.map(d=>d.device_id),JSON.stringify(r.response.store));
r=run(base('device_ping','Siti','1111',{device:{id:'bad'}}),db); console.log('ping bad',r.response.error);
r=run(base('save_sale','Siti','1111',{client_id:'d1',sale_date:'2026-10-06',items:[{product_id:1,qty:0}],device:{id:D,app:'kasir',lat:-6.3,lng:106.8}}),db); console.log('failed action writes no device',r.response.error,r.ops.devices.length);

// v12: repack + supplier
const dbR=Object.assign({},db,{products:[db.products[0],db.products[1],{id:3,sku:'333',name:'Kurma Sukkari curah 10kg',category:'kurma',unit:'kg',cost_price:60000,retail_price:0,wholesale_price:0,stock:30,active:true},{id:4,sku:'444',name:'Kurma Sukkari 500g',category:'kurma',unit:'pak',cost_price:0,retail_price:45000,wholesale_price:40000,stock:2,active:true,repack_from:3,repack_qty:0.5}]});
r=run(base('repack','Jihan','2222',{to_product_id:4,from_qty:10,to_qty:19,packaging_cost:19000,note:'karton A'}),dbR); console.log('repack mgr',JSON.stringify(r.response.repack),JSON.stringify(r.response.stock),r.ops.purchases.map(x=>[x.product_id,x.qty,x.supplier]));
r=run(base('repack','Pemilik','1234',{to_product_id:4,to_qty:20}),dbR); console.log('repack owner default from',r.response.repack.from_qty,r.response.repack.yield_pct,r.response.repack.unit_cost,JSON.stringify(r.response.stock));
r=run(base('repack','Siti','1111',{to_product_id:4,to_qty:2}),dbR); console.log('kasir',r.response.error);
r=run(base('repack','Pemilik','1234',{to_product_id:4,to_qty:100}),dbR); console.log('too much',r.response.error,r.response.message);
r=run(base('repack','Pemilik','1234',{to_product_id:1,to_qty:1}),dbR); console.log('not repack',r.response.error);
r=run(base('save_product','Pemilik','1234',{id:4,name:'Kurma Sukkari 500g',unit:'pak',retail_price:45000,repack_from:3,repack_qty:0.5,supplier:'PT Kurma Jaya'}),dbR); console.log('save link',r.ops.products[0].repack_from,r.ops.products[0].repack_qty,r.ops.products[0].supplier);
r=run(base('save_product','Pemilik','1234',{id:4,name:'X',repack_from:4,repack_qty:1}),dbR); console.log('self link',r.response.error);
r=run(base('save_product','Pemilik','1234',{id:4,name:'X',repack_from:3}),dbR); console.log('no size',r.response.error);
r=run(base('get_sales','Jihan','2222',{from:'2026-10-01',to:'2026-10-06'}),Object.assign({},dbR,{rr:[{id:1,repack_id:'RP1',unit_cost:3000,packaging_cost:100}]})); console.log('get_sales repacks mgr',JSON.stringify(r.response.repacks));

// v12b: goods-in vs note, purchase fix, activity
const ph={id:1,photo_id:'PH1',kind:'masuk',extracted:JSON.stringify({readable:true,items:[{name:'KURMA AJWA 1KG',qty:10},{name:'Kismis 500gr',qty:20}]})};
const dbP=Object.assign({},db,{ph:[ph]});
r=run(base('save_purchase','Siti','1111',{photo_id:'PH1',supplier:'PT Kurma',items:[{product_id:1,qty:10,cost_price:150000},{product_id:2,qty:20,cost_price:20000}]}),dbP); console.log('match ok',r.response.ok,r.response.match.status,r.response.purchase_no,r.ops.purchases[0].match_status,r.ops.activity.length,r.ops.activity[0]&&r.ops.activity[0].level);
r=run(base('save_purchase','Siti','1111',{photo_id:'PH1',items:[{product_id:1,qty:12,cost_price:150000},{product_id:2,qty:20,cost_price:20000}]}),dbP); console.log('mismatch',r.response.error,r.response.message,r.ops.purchases.length,r.ops.activity.length);
r=run(base('save_purchase','Siti','1111',{photo_id:'PH1',mismatch_reason:'2 dus bonus',items:[{product_id:1,qty:12,cost_price:150000},{product_id:2,qty:20,cost_price:20000}]}),dbP); console.log('mismatch with reason',r.response.ok,r.response.match.status,r.ops.purchases[0].match_notes,r.ops.activity[0].level);
r=run(base('save_purchase','Siti','1111',{photo_id:'PH1',items:[{product_id:1,qty:10,cost_price:150000}]}),dbP); console.log('missing line',r.response.error,r.response.match.diffs.length);
const prow=[{id:50,purchase_no:'PB1',product_id:1,name:'Kurma Ajwa 1kg',qty:10,total:1500000,supplier:'PT Kurma'},{id:51,purchase_no:'PB1',product_id:2,name:'Kismis 500g',qty:20,total:400000,supplier:'PT Kurma'}];
const dbF=Object.assign({},db,{pbn:prow});
r=run(base('request_purchase_fix','Siti','1111',{purchase_no:'PB1',lines:[{product_id:1,qty:8}],reason:'salah ketik'}),dbF); console.log('kasir fix',r.response.applied,r.response.approval.kind,r.response.approval.approver_role,JSON.stringify(r.response.changes),r.ops.products.length,r.ops.activity[0].kind);
r=run(base('request_purchase_fix','Siti','1111',{purchase_no:'PB1',lines:[{product_id:1,qty:8}]}),dbF); console.log('no reason',r.response.error);
r=run(base('request_purchase_fix','Siti','1111',{purchase_no:'PB1',lines:[{product_id:1,qty:10}],reason:'x'}),dbF); console.log('no change',r.response.error);
const fixAp={id:40,request_id:'APF1',kind:'purchase_fix',status:'pending',approver_role:'manager',cashier:'Siti',summary:'Koreksi',payload:JSON.stringify({purchase_no:'PB1',lines:[{product_id:1,qty:8}],reason:'salah ketik'})};
r=run(base('decide_approval','Jihan','2222',{request_id:'APF1',decision:'approved',purchase_no:'PB1'}),Object.assign({},dbF,{ap:[fixAp]})); console.log('mgr approves fix',JSON.stringify(r.response.stock),r.ops.purchases.map(x=>[x.qty,x.total,x.match_status]),r.ops.approvals[0].status,r.ops.activity.map(a=>a.kind));
r=run(base('request_purchase_fix','Jihan','2222',{purchase_no:'PB1',lines:[{product_id:2,qty:20,cost_price:19000}],reason:'harga nota'}),dbF); console.log('mgr direct cost fix',r.response.applied,JSON.stringify(r.response.changes.map(c=>[c.d_qty,c.d_total])),r.ops.purchases[0].total);
r=run(base('list_activity','Pemilik','1234',{from:'2026-10-01',to:'2026-10-06'}),Object.assign({},db,{act:[{id:1,at:'2026-10-06T01:00:00Z',kind:'a'},{id:2,at:'2026-10-06T02:00:00Z',kind:'b'}]})); console.log('list act',r.response.activity.map(a=>a.kind));
r=run(base('list_activity','Jihan','2222',{}),db); console.log('mgr list act',r.response.error);
r=run(base('bootstrap','Pemilik','1234',{}),Object.assign({},db,{act:[{id:1,at:'2026-10-06T01:00:00Z',kind:'a'}]})); console.log('boot owner act',r.response.activity_recent.length);
r=run(base('bootstrap','Siti','1111',{}),Object.assign({},db,{act:[{id:1,at:'x'}]})); console.log('boot kasir act',r.response.activity_recent.length);
r=run(base('device_ping','Siti','1111',{device:{id:'dev_NEWDEVICE1',app:'kasir',label:'iPhone'}}),db); console.log('new device act',r.ops.activity.map(a=>a.summary));
r=run(base('void_sale','Pemilik','1234',{invoice_no:'KM1',reason:'salah'}),Object.assign({},db,{byInv:[{id:9,invoice_no:'KM1',status:'ok',total:5000}]})); console.log('void act',r.ops.activity[0].kind,r.ops.activity[0].level);
r=run(base('save_settings','Pemilik','1234',{settings:{store_name:'Khair Mart',paper:'80'}}),db); console.log('settings act',r.ops.activity.map(a=>a.summary));
// v13: payments
const sales7=[{id:1,invoice_no:'KM1',customer_id:7,sale_date:'2026-10-01',debt_amount:60000,status:'ok'},{id:2,invoice_no:'KM2',customer_id:7,sale_date:'2026-10-03',debt_amount:40000,status:'ok'},{id:3,invoice_no:'KM3',customer_id:7,sale_date:'2026-10-04',debt_amount:30000,status:'void'}];
const slip={id:9,photo_id:'PHS',kind:'bayar',extracted:JSON.stringify({amount:50000,transfer_ref:'TRX1',bank:'BCA'})};
const dbPay=Object.assign({},db,{ps:sales7,ph:[slip]});
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:50000,method:'transfer',bank:'BCA',transfer_ref:'TRX1',photo_id:'PHS',alloc:[{ref:'KM1',amount:50000}]}),dbPay); console.log('pay partial',r.response.ok,r.response.payment.match_status,JSON.stringify(r.response.payment.alloc),r.ops.activity[0].kind);
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:60000,method:'transfer',photo_id:'PHS'}),dbPay); console.log('slip mismatch',r.response.error,r.response.slip_amount,r.ops.payments.length);
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:60000,method:'transfer',photo_id:'PHS',mismatch_reason:'2 transfer',alloc:[{ref:'KM1',amount:60000}]}),dbPay); console.log('slip mismatch reason',r.response.ok,r.response.payment.match_status,r.ops.activity[0].level);
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:50000,alloc:[{ref:'KM3',amount:10000}]}),dbPay); console.log('void invoice',r.response.error,r.response.message);
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:50000,alloc:[{ref:'KM2',amount:45000}]}),dbPay); console.log('over remaining',r.response.message);
const prevPay=[{id:20,pay_id:'PYA',customer_id:7,direction:'in',amount:30000,alloc:JSON.stringify([{ref:'KM1',amount:30000}]),transfer_ref:'TRX0'}];
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:30000,alloc:[{ref:'KM1',amount:30000}]}),Object.assign({},dbPay,{pp:prevPay})); console.log('KM1 now lunas',r.response.payment.match_status);
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:20000,transfer_ref:'trx0'}),Object.assign({},dbPay,{pp:prevPay})); console.log('dup ref',r.response.error,r.response.message);
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:20000}),dbPay); console.log('no alloc',r.response.payment.match_status,r.ops.activity[0].level);
r=run(base('allocate_payment','Siti','1111',{pay_id:'PYA',alloc:[]}),Object.assign({},dbPay,{pp:prevPay})); console.log('kasir alloc',r.response.error);
r=run(base('allocate_payment','Jihan','2222',{pay_id:'PYA',customer_id:7,alloc:[{ref:'KM1',amount:10000},{ref:'KM2',amount:20000}]}),Object.assign({},dbPay,{pp:prevPay})); console.log('realloc',r.response.payment.match_status,JSON.stringify(r.response.payment.alloc),r.ops.payments[0]._id);
const purch=[{id:1,purchase_no:'PB1',supplier:'PT Kurma',purchase_date:'2026-10-01',total:1000000},{id:2,purchase_no:'PB1',supplier:'PT Kurma',purchase_date:'2026-10-01',total:500000},{id:3,purchase_no:'PB2',supplier:'PT Kurma',purchase_date:'2026-10-02',total:300000}];
r=run(base('pay_supplier','Jihan','2222',{supplier:'PT Kurma',amount:1500000,method:'transfer',alloc:[{ref:'PB1',amount:1500000}]}),Object.assign({},db,{pu:purch})); console.log('pay supplier',r.response.payment.match_status,r.response.payment.direction,r.ops.activity[0].kind);
r=run(base('pay_supplier','Jihan','2222',{supplier:'PT Kurma',amount:100000,method:'tunai',paid_from:'kas'}),Object.assign({},db,{pu:purch})); console.log('supplier from kas',r.ops.shifts.length,r.ops.shifts[0]&&r.ops.shifts[0].cash_out);
r=run(base('pay_supplier','Siti','1111',{supplier:'PT Kurma',amount:1}),db); console.log('kasir pay supplier',r.response.error);
const supPays=[{id:30,pay_id:'PYS',supplier:'PT Kurma',direction:'out',amount:1000000,alloc:JSON.stringify([{ref:'PB1',amount:1000000}])}];
r=run(base('party_ledger','Jihan','2222',{party_type:'supplier',supplier:'PT Kurma'}),Object.assign({},db,{pu:purch,pp:supPays})); console.log('supplier ledger',JSON.stringify(r.response.docs),r.response.balance);
r=run(base('party_ledger','Siti','1111',{party_type:'customer',customer_id:7}),Object.assign({},dbPay,{pp:prevPay})); console.log('cust ledger',JSON.stringify(r.response.docs.map(d=>[d.ref,d.paid,d.remaining])),r.response.payments.length,r.response.balance);
r=run(base('party_ledger','Siti','1111',{party_type:'supplier',supplier:'PT Kurma'}),db); console.log('kasir supplier ledger',r.response.error);
// v14: bank accounts + statement reconciliation
const accSet=[{id:1,skey:'bank_accounts',svalue:JSON.stringify([{id:'BA1',bank:'BCA',account_no:'1234567890',holder:'Khair Mart',active:true}])}];
const pays14=[
 {id:1,pay_id:'P1',pay_date:'2026-10-02',direction:'in',method:'transfer',amount:500000,transfer_ref:'TRX111',account_id:'BA1',customer_name:'Bu Rina'},
 {id:2,pay_id:'P2',pay_date:'2026-10-05',direction:'out',method:'transfer',amount:1500000,transfer_ref:'',account_id:'BA1',supplier:'PT Kurma'},
 {id:3,pay_id:'P3',pay_date:'2026-10-10',direction:'in',method:'transfer',amount:200000,transfer_ref:'',account_id:'BA1',customer_name:'Pak Ali'},
 {id:4,pay_id:'P4',pay_date:'2026-10-12',direction:'in',method:'tunai',amount:99000},
 {id:5,pay_id:'P5',pay_date:'2026-10-20',direction:'in',method:'transfer',amount:300000,transfer_ref:'TRX555',account_id:'BA1',customer_name:'Toko A'}];
const stmt=[{date:'2026-10-02',description:'TRSF E-BANKING CR TRX111 RINA',credit:500000},{date:'2026-10-08',description:'TRSF DB PT KURMA',debit:1500000},{date:'2026-10-10',description:'SETORAN',credit:250000},{date:'2026-10-21',description:'TRX555 TOKO A',credit:350000},{date:'2026-10-31',description:'BIAYA ADM',debit:15000}];
const db14=Object.assign({},db,{settings:accSet,rp:pays14});
r=run(base('import_statement','Jihan','2222',{account_id:'BA1',period:'2026-10',lines:stmt}),db14);
console.log('import',r.response.ok,JSON.stringify(r.response.lines.map(l=>[l.seq,l.status,l.pay_id,l.diff_days])),r.response.missing.map(m=>m.pay_id),JSON.stringify(r.response.totals),r.ops.bank_lines.length,r.ops.activity[0].summary);
r=run(base('import_statement','Siti','1111',{account_id:'BA1',period:'2026-10',lines:stmt}),db14); console.log('kasir import',r.response.error);
r=run(base('import_statement','Jihan','2222',{account_id:'BAX',period:'2026-10',lines:stmt}),db14); console.log('bad acct',r.response.error);
r=run(base('import_statement','Jihan','2222',{account_id:'BA1',period:'2026-10',lines:[{date:'2026-11-01',credit:1}]}),db14); console.log('out of period',r.response.message);
const stored=stmt.map((l,i)=>({id:100+i,line_id:'BA1-2026-10-'+(i+1),account_id:'BA1',period:'2026-10',seq:i+1,line_date:l.date,description:l.description,amount:(l.credit||0)-(l.debit||0),status:i===4?'diabaikan':'',note:i===4?'biaya bank':''}));
r=run(base('bank_recon','Jihan','2222',{account_id:'BA1',period:'2026-10'}),Object.assign({},db14,{bl:stored})); console.log('recon',JSON.stringify(r.response.counts),r.response.imported);
r=run(base('match_bank_line','Jihan','2222',{line_id:'BA1-2026-10-3',pay_id:'P3',note:'setoran tunai Pak Ali + 50rb ongkir'}),Object.assign({},db14,{bl:stored})); console.log('manual',r.response.line.status,r.response.line.pay_id,r.ops.bank_lines[0]._id);
r=run(base('match_bank_line','Jihan','2222',{line_id:'BA1-2026-10-5',ignore:true}),Object.assign({},db14,{bl:stored})); console.log('ignore no note',r.response.error);
r=run(base('import_statement','Jihan','2222',{account_id:'BA1',period:'2026-10',lines:stmt.slice(0,2)}),Object.assign({},db14,{bl:stored})); console.log('reimport shorter',r.ops.bank_lines.map(b=>[b._id,b.status]));
r=run(base('receive_payment','Siti','1111',{customer_id:7,amount:50000,method:'transfer',photo_id:'PHS2'}),Object.assign({},db,{settings:accSet,ph:[{id:1,photo_id:'PHS2',kind:'bayar',extracted:JSON.stringify({amount:50000,date:'2026-10-01'})}]})); console.log('acct+slip date',r.response.payment.account_id,r.response.payment.slip_date,r.ops.activity[0].level,r.ops.activity[0].summary.slice(-45));
// v15: shift only for kasir, opening approval, shift method split, daily report
r=run(base('save_sale','Jihan','2222',{client_id:'m1',sale_date:'2026-10-06',items:[{product_id:1,qty:1,unit_price:185000}],payment_method:'tunai',paid_amount:185000}),Object.assign({},db,{os:[]})); console.log('manager sells w/o shift',r.response.ok);
r=run(base('save_sale','Siti','1111',{client_id:'k1',sale_date:'2026-10-06',items:[{product_id:1,qty:1,unit_price:185000}],payment_method:'tunai',paid_amount:185000}),Object.assign({},db,{os:[]})); console.log('kasir w/o shift',r.response.error);
r=run(base('open_shift','Jihan','2222',{opening_cash:100000}),Object.assign({},db,{os:[]})); console.log('manager open',r.response.error);
const closed=[{id:30,shift_id:'SHX',cashier:'Rina',status:'closed',closed_at:'2026-10-05T14:00:00Z',counted_cash:450000}];
r=run(base('open_shift','Siti','1111',{opening_cash:500000}),Object.assign({},db,{os:[],rsh:closed})); console.log('kasir open',r.response.ok,r.ops.approvals[0].kind,r.ops.approvals[0].approver_role,r.ops.approvals[0].summary,r.ops.activity[0].level);
r=run(base('save_sale','Siti','1111',{client_id:'k2',sale_date:'2026-10-06',customer_id:7,items:[{product_id:1,qty:2,unit_price:185000}],payment_method:'transfer',paid_amount:300000,approver:{user:'Jihan',pin_hash:h('Jihan','2222')}}),db); console.log('shift split',JSON.stringify((({transfer_sales,qris_sales,debt_sales,items_qty,cash_sales})=>({transfer_sales,qris_sales,debt_sales,items_qty,cash_sales}))(r.ops.shifts[0])));
const apBK={id:50,request_id:'APBK',kind:'buka_kas',status:'pending',approver_role:'manager',cashier:'Siti',summary:'Buka kas'};
r=run(base('decide_approval','Jihan','2222',{request_id:'APBK',decision:'approved'}),Object.assign({},db,{ap:[apBK]})); console.log('approve buka_kas',r.response.approval.status,r.ops.activity[0].kind);
const day='2026-10-06';
const rs=[{invoice_no:'A',sale_date:day,status:'ok',total:100000,paid_amount:100000,payment_method:'tunai',debt_amount:0,discount:0,profit:20000},{invoice_no:'B',sale_date:day,status:'ok',total:200000,paid_amount:200000,payment_method:'transfer',debt_amount:0,discount:5000,profit:40000},{invoice_no:'C',sale_date:day,status:'ok',total:150000,paid_amount:50000,payment_method:'qris',debt_amount:100000,discount:0,profit:30000},{invoice_no:'D',sale_date:day,status:'void',total:70000,paid_amount:70000,payment_method:'tunai',debt_amount:0}].map((x,i)=>Object.assign({id:i+1},x));
const ri=[{id:1,invoice_no:'A',product_id:1,name:'Ajwa',qty:1,line_total:100000},{id:2,invoice_no:'B',product_id:2,name:'Kismis',qty:8,line_total:200000},{id:3,invoice_no:'C',product_id:1,name:'Ajwa',qty:1.5,line_total:150000},{id:4,invoice_no:'D',product_id:2,name:'Kismis',qty:3,line_total:70000}];
const rp15=[{id:1,pay_date:day,direction:'in',method:'transfer',amount:80000},{id:2,pay_date:day,direction:'out',method:'transfer',amount:1000000},{id:3,pay_date:day,method:'tunai',amount:20000}];
const re15=[{id:1,expense_date:day,amount:30000,paid_from:'kas'},{id:2,expense_date:day,amount:10000,paid_from:'lain'}];
const rsh15=[{id:1,shift_id:'S1',cashier:'Siti',shift_date:day,status:'closed',opening_cash:500000,cash_sales:100000,cash_payments:20000,cash_in:0,cash_out:30000,expected_cash:590000,counted_cash:585000,difference:-5000,sales_count:3,sales_total:450000}];
const dbR15=Object.assign({},db,{rs:rs,ri:ri,rp:rp15,re:re15,rsh:rsh15,settings:[{id:1,skey:'wa_manager_number',svalue:'"628111"'}]});
r=run(base('daily_report','Jihan','2222',{date:day}),dbR15); const rr=r.response.report; console.log('report',JSON.stringify(rr.sales),JSON.stringify(rr.bank),JSON.stringify(rr.cash),rr.top_items.map(t=>t.name+':'+t.qty),'profit' in rr,JSON.stringify(r.response.send_to));
r=run(base('daily_report','Pemilik','1234',{date:day}),dbR15); console.log('owner profit',r.response.report.profit);
r=run(base('daily_report','Siti','1111',{date:day}),dbR15); console.log('kasir report',r.response.error);
