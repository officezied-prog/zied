// Column names + types for every pos_* data table, transcribed exactly from the live
// n8n data-table definitions (search_data_tables, project w58qjNXPtPmWJPB6). This is the
// single source of truth for the D1 schema (schema.sql) AND for runtime coercion:
//  - 'boolean' columns are read back as real true/false and written as 1/0 so process.js
//    boolean checks (u.active !== false, x === true, …) behave exactly as under n8n.
//  - 'number' columns are REAL (qty can be fractional, e.g. 0.5 kg).
//  - every table has an implicit INTEGER PRIMARY KEY `id` (the n8n system row id).
// Column ORDER here is irrelevant (all access is by name); it follows the n8n index order.

export const TABLES = {
  pos_users: {
    name: 'string', role: 'string', pin_hash: 'string', active: 'boolean',
    must_change: 'boolean', master_hash: 'string', fail_count: 'number', locked_until: 'string',
  },
  pos_settings: {
    skey: 'string', svalue: 'string',
  },
  pos_products: {
    sku: 'string', name: 'string', category: 'string', unit: 'string', cost_price: 'number',
    retail_price: 'number', wholesale_price: 'number', wholesale_min_qty: 'number',
    stock: 'number', min_stock: 'number', active: 'boolean', notes: 'string',
    image_updated: 'string', supplier: 'string', repack_from: 'number', repack_qty: 'number',
    shop_stock: 'number', size: 'string', weight: 'string', exp_date: 'string', exp_none: 'boolean',
  },
  pos_customers: {
    name: 'string', phone: 'string', type: 'string', address: 'string', notes: 'string',
    debt_balance: 'number', wa_optin: 'boolean', source: 'string', email: 'string',
    member: 'boolean', member_no: 'string', member_since: 'string', visits: 'number',
    last_visit: 'string', receipts_sent: 'number',
  },
  pos_sales: {
    invoice_no: 'string', sale_date: 'string', sale_time: 'string', cashier: 'string',
    customer_id: 'number', customer_name: 'string', customer_type: 'string', subtotal: 'number',
    discount: 'number', total: 'number', total_cost: 'number', profit: 'number',
    payment_method: 'string', paid_amount: 'number', debt_amount: 'number', status: 'string',
    survey: 'string', notes: 'string', client_id: 'string', approved_by: 'string',
    exit_photo: 'string', exit_match: 'string', channel: 'string', promo_code: 'string',
    shift_id: 'string', survey_transcript: 'string', send_fee: 'number',
  },
  pos_sale_items: {
    invoice_no: 'string', sale_date: 'string', product_id: 'number', sku: 'string',
    name: 'string', qty: 'number', unit_price: 'number', price_type: 'string',
    cost_price: 'number', line_total: 'number', line_profit: 'number', customer_name: 'string',
  },
  pos_payments: {
    pay_date: 'string', customer_id: 'number', customer_name: 'string', amount: 'number',
    method: 'string', note: 'string', cashier: 'string', pay_id: 'string', direction: 'string',
    party_type: 'string', supplier: 'string', bank: 'string', transfer_ref: 'string',
    proof_photo_id: 'string', alloc: 'string', match_status: 'string', pay_time: 'string',
    account_id: 'string', slip_date: 'string',
  },
  pos_purchases: {
    purchase_date: 'string', supplier: 'string', product_id: 'number', name: 'string',
    qty: 'number', cost_price: 'number', total: 'number', note: 'string', user: 'string',
    photo_id: 'string', exp_date: 'string', purchase_no: 'string', match_status: 'string',
    match_notes: 'string', carrier_type: 'string', carrier_name: 'string',
    carrier_vehicle: 'string', carrier_phone: 'string',
  },
  pos_approvals: {
    request_id: 'string', client_id: 'string', created_at: 'string', cashier: 'string',
    customer_id: 'number', customer_name: 'string', customer_debt_before: 'number',
    total: 'number', debt_amount: 'number', summary: 'string', status: 'string',
    decided_by: 'string', decided_at: 'string', note: 'string', kind: 'string', ref: 'string',
    payload: 'string', approver_role: 'string',
  },
  pos_expenses: {
    expense_date: 'string', category: 'string', amount: 'number', note: 'string',
    user: 'string', photo_id: 'string', paid_from: 'string',
  },
  pos_shifts: {
    shift_id: 'string', cashier: 'string', shift_date: 'string', opened_at: 'string',
    closed_at: 'string', status: 'string', opening_cash: 'number', cash_sales: 'number',
    cash_payments: 'number', cash_in: 'number', cash_out: 'number', sales_count: 'number',
    sales_total: 'number', expected_cash: 'number', counted_cash: 'number',
    difference: 'number', moves: 'string', note: 'string', transfer_sales: 'number',
    qris_sales: 'number', debt_sales: 'number', items_qty: 'number',
  },
  pos_devices: {
    device_id: 'string', user: 'string', role: 'string', app: 'string', label: 'string',
    ua: 'string', ip: 'string', lat: 'number', lng: 'number', acc: 'number',
    loc_status: 'string', loc_at: 'string', first_seen: 'string', last_seen: 'string',
    pings: 'number', battery: 'number',
  },
  pos_repacks: {
    repack_id: 'string', repack_date: 'string', repack_time: 'string', user: 'string',
    from_product_id: 'number', from_name: 'string', from_unit: 'string', from_qty: 'number',
    to_product_id: 'number', to_name: 'string', to_unit: 'string', to_qty: 'number',
    pack_size: 'number', expected_qty: 'number', yield_pct: 'number', loss_qty: 'number',
    packaging_cost: 'number', unit_cost: 'number', exp_date: 'string', note: 'string',
  },
  pos_activity: {
    act_id: 'string', at: 'string', act_date: 'string', user: 'string', role: 'string',
    kind: 'string', summary: 'string', ref: 'string', amount: 'number', level: 'string',
  },
  pos_bank_lines: {
    line_id: 'string', account_id: 'string', period: 'string', seq: 'number',
    line_date: 'string', description: 'string', amount: 'number', ref: 'string',
    balance: 'number', status: 'string', pay_id: 'string', note: 'string',
    imported_at: 'string', imported_by: 'string',
  },
  pos_returns: {
    return_id: 'string', kind: 'string', status: 'string', return_date: 'string', at: 'string',
    user: 'string', approved_by: 'string', request_id: 'string', ref: 'string',
    party_id: 'number', party_name: 'string', bought_by: 'string', bought_date: 'string',
    returned_by: 'string', returned_by_phone: 'string', lines: 'string', qty_total: 'number',
    value: 'number', fee_pct: 'number', fee: 'number', refund: 'number', refund_method: 'string',
    reason_code: 'string', reason_note: 'string', photo_id: 'string', out_doc_no: 'string',
    carrier_type: 'string', carrier_name: 'string', carrier_vehicle: 'string', carrier_phone: 'string',
  },
  pos_photos: {
    photo_id: 'string', kind: 'string', ref: 'string', created_at: 'string',
    photo_date: 'string', user: 'string', drive_file_id: 'string', drive_url: 'string',
    extracted: 'string', match_status: 'string', match_notes: 'string',
  },
  // ---- field / sales-lapangan (loaded by the separate Field workflow; included so the
  //      single D1 database is complete for later migration of that workflow) ----
  pos_shops: {
    shop_id: 'string', name: 'string', owner_name: 'string', phone: 'string', address: 'string',
    area: 'string', type: 'string', lat: 'number', lng: 'number', created_by: 'string',
    created_at: 'string', last_visit_at: 'string', visits: 'number', status: 'string',
    customer_id: 'number', next_visit: 'string', type_other: 'string', chain: 'string',
  },
  pos_visits: {
    visit_id: 'string', client_id: 'string', user: 'string', visit_date: 'string',
    visit_time: 'string', shop_id: 'string', shop_name: 'string', lat: 'number', lng: 'number',
    acc: 'number', distance_m: 'number', outcome: 'string', notes: 'string', next_visit: 'string',
    photo_thumb: 'string', drive_url: 'string', rating: 'number',
  },
  pos_tracks: {
    user: 'string', track_date: 'string', t: 'string', lat: 'number', lng: 'number',
    acc: 'number', speed: 'number', battery: 'number',
  },
  pos_field_days: {
    user: 'string', day_date: 'string', started_at: 'string', ended_at: 'string',
    start_lat: 'number', start_lng: 'number', end_lat: 'number', end_lng: 'number',
    km: 'number', visits: 'number', orders: 'number', note: 'string',
  },
  pos_field_orders: {
    order_id: 'string', client_id: 'string', user: 'string', order_date: 'string',
    shop_id: 'string', shop_name: 'string', items: 'string', total: 'number', notes: 'string',
    delivery_date: 'string', status: 'string', invoice_no: 'string', updated_by: 'string',
    order_time: 'string', status_note: 'string', payment_method: 'string',
  },
  pos_product_images: {
    product_id: 'number', image_base64: 'string', updated_at: 'string',
  },
  // v31 (owner 2026-10-11): the rep's route plan for a day, made before setting off. stops = JSON text.
  pos_route_plans: {
    plan_id: 'string', user: 'string', plan_date: 'string', start_label: 'string', start_lat: 'number',
    start_lng: 'number', stops: 'string', note: 'string', created_at: 'string', updated_at: 'string',
    end_label: 'string', end_lat: 'number', end_lng: 'number', streets: 'string',
  },
  // v32: permanent log of every planned street / drawn work line (one row per street per plan) — the shared map
  pos_street_log: {
    skey: 'string', user: 'string', name: 'string', plan_date: 'string', plan_id: 'string', drawn: 'number', ref: 'string',
    lines: 'string', min_lat: 'number', max_lat: 'number', min_lng: 'number', max_lng: 'number', removed: 'number', updated_at: 'string',
  },
  // v33: shop lists (Google Maps places of a street) the office sends to a rep
  pos_shop_lists: {
    list_id: 'string', from_user: 'string', from_role: 'string', to_user: 'string', plan_date: 'string', street: 'string',
    places: 'string', note: 'string', status: 'string', created_at: 'string', received_at: 'string',
  },
  // ---- chat / attendance (separate workflows; included for a complete database) ----
  pos_chat: {
    channel: 'string', cid: 'string', from_user: 'string', from_name: 'string',
    from_role: 'string', body: 'string', image: 'string', created_at: 'string', deleted: 'boolean',
  },
  pos_workers: {
    worker_id: 'string', name: 'string', phone: 'string', job: 'string', daily_wage: 'number',
    active: 'boolean', face_desc: 'string', face_thumb: 'string', consent_at: 'string',
    consent_by: 'string', created_at: 'string', created_by: 'string',
  },
  pos_attendance: {
    seq: 'number', at: 'string', att_date: 'string', worker_id: 'string', worker_name: 'string',
    kind: 'string', score: 'string', face_ok: 'boolean', device_id: 'string', by_user: 'string',
    lat: 'string', lng: 'string', dist_m: 'string', note: 'string', client_id: 'string',
    prev_hash: 'string', hash: 'string',
  },
  pos_att_seals: {
    period: 'string', kind: 'string', count: 'number', first_seq: 'number', last_seq: 'number',
    last_hash: 'string', summary: 'string', created_at: 'string', prev_hash: 'string', hash: 'string',
  },
  // ---- cold storage / gudang (the "Khair Gudang Dingin" workflow, POST /webhook/khair-cold).
  //      Ported from n8n; cold reuses pos_users + pos_settings, all else is its own cold_* tables.
  //      Columns transcribed from backend/cold/build-workflow.js. `mode` on a warehouse (the
  //      cooler) is the owner's Batch-C addition: tabrid/takhzin/tajmid/biasa.
  cold_warehouses: {
    code: 'string', name: 'string', address: 'string', pic_name: 'string', pic_wa: 'string',
    customer_id: 'string', rate: 'number', rate_unit: 'string', parser: 'string', active: 'boolean',
    created_at: 'string', created_by: 'string', rate_frozen: 'number', rate_chiller: 'number',
    rate_dry: 'number', mode: 'string',
  },
  cold_products: {
    code: 'string', name: 'string', kg_per_ctn: 'number', aliases: 'string', active: 'boolean',
    created_at: 'string', created_by: 'string', ctn_per_pallet: 'number',
  },
  cold_containers: {
    container_no: 'string', size: 'string', arrival_date: 'string', supplier: 'string',
    warehouse: 'string', note: 'string', created_at: 'string', created_by: 'string', origin: 'string',
    product: 'string', cartons: 'number', kind: 'string', status: 'string', log: 'string',
  },
  cold_pallets: {
    pallet_code: 'string', product: 'string', lot: 'string', prod_date: 'string', exp_date: 'string',
    kg_per_ctn: 'number', position: 'string', zone: 'string', container_no: 'string', date_in: 'string',
    ext_item: 'string', warehouse: 'string', created_at: 'string', created_by: 'string',
  },
  cold_movements: {
    seq: 'number', move_date: 'string', at: 'string', type: 'string', pallet_code: 'string',
    warehouse: 'string', cartons: 'number', ref_seq: 'number', grp: 'number', order_no: 'string',
    reason: 'string', by_user: 'string',
  },
  cold_checks: {
    check_no: 'string', check_date: 'string', warehouse: 'string', at: 'string', by_user: 'string',
    raw_text: 'string', result: 'string', n_diff: 'number', explained_note: 'string',
    explained_by: 'string', explained_at: 'string',
  },
  cold_orders: {
    order_no: 'string', order_date: 'string', warehouse: 'string', dest_type: 'string',
    dest_name: 'string', dest_address: 'string', pickup_person: 'string', vehicle: 'string',
    note: 'string', lines: 'string', status: 'string', created_at: 'string', created_by: 'string',
    picked_at: 'string', picked_by: 'string', pick_date: 'string', cancel_reason: 'string',
    cancelled_at: 'string', cancelled_by: 'string', trip: 'string', log: 'string', customer_id: 'number',
  },
};

// Convenience: boolean column lookup per table (used by the D1 read/write coercion).
export const BOOL_COLS = Object.fromEntries(
  Object.entries(TABLES).map(([t, cols]) => [t, Object.keys(cols).filter((c) => cols[c] === 'boolean')])
);

// The ops-object key → data-table name. process.js emits ops keyed by these short names;
// the live workflow has one Ops/Has/Upsert chain per key. (ops also has sale_items.)
export const OPS_TABLE = {
  sales: 'pos_sales', sale_items: 'pos_sale_items', payments: 'pos_payments',
  purchases: 'pos_purchases', products: 'pos_products', customers: 'pos_customers',
  users: 'pos_users', settings: 'pos_settings', approvals: 'pos_approvals',
  expenses: 'pos_expenses', shifts: 'pos_shifts', devices: 'pos_devices',
  repacks: 'pos_repacks', activity: 'pos_activity', bank_lines: 'pos_bank_lines',
  returns: 'pos_returns',
};

// Field (sales-lapangan) workflow ops key → table. `product_flags` is a partial UPDATE of
// pos_products.image_updated (the live "Update product_flags" node); the writer only touches
// the columns present in the row, so a {_id, image_updated} row updates just that column.
export const OPS_TABLE_FIELD = {
  shops: 'pos_shops', visits: 'pos_visits', tracks: 'pos_tracks',
  days: 'pos_field_days', orders: 'pos_field_orders', images: 'pos_product_images',
  product_flags: 'pos_products', plans: 'pos_route_plans', street_log: 'pos_street_log', shop_lists: 'pos_shop_lists',
};

// Chat workflow ops key → table.
export const OPS_TABLE_CHAT = { chat: 'pos_chat', settings: 'pos_settings' };

// Attendance workflow ops key → table.
export const OPS_TABLE_ATT = {
  workers: 'pos_workers', records: 'pos_attendance', seals: 'pos_att_seals', settings: 'pos_settings',
};

// Cold-storage (gudang) workflow ops key → table. process-cold.js emits ops keyed by the short
// name; settings (cold_company / cold_drivers) live in the shared pos_settings. customers is the
// Batch-C registry, reusing pos_customers (same table the POS + Field apps share).
export const OPS_TABLE_COLD = {
  warehouses: 'cold_warehouses', products: 'cold_products', containers: 'cold_containers',
  pallets: 'cold_pallets', movements: 'cold_movements', checks: 'cold_checks',
  orders: 'cold_orders', customers: 'pos_customers', settings: 'pos_settings',
};
