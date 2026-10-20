// Port of the live n8n "Parse Request" code node (verified against the live workflow, not
// the stale repo backend/parse-request.js). Normalises the webhook body + headers into the
// `req` object that every "Get X" loader and process.js read. Logic is byte-faithful to the
// node; only the n8n input accessor (`$input.first().json`) is replaced by function args.
export function parseRequest(body, headers) {
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const isDate = function (s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); };
  const action = String(body.action || '');
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() + 7 * 3600000 - 7 * 86400000).toISOString().slice(0, 10);
  const twoWeeksAgo = new Date(Date.now() + 7 * 3600000 - 14 * 86400000).toISOString().slice(0, 10);
  headers = headers && typeof headers === 'object' ? headers : {};
  // Bank statement actions work on one account + month; payments are loaded for the month ± 3 days.
  const bankAction = ['import_statement', 'bank_recon', 'match_bank_line'].indexOf(action) >= 0;
  const period = bankAction && /^\d{4}-\d{2}$/.test(String(data.period || '')) ? String(data.period) : '';
  const shift = function (d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); };
  const periodEnd = period ? new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)).toISOString().slice(0, 10) : '';
  // get_sales: a range; daily_report: one day.
  // v36: profit_loss (the monthly profit & loss statement) reads the same ranges as get_sales.
  // v37: correct_price too — it re-prices the sales of its date range, but its range was never loaded on the Worker, so every
  // price correction of sold goods answered NOT_FOUND ("Tidak ada penjualan … pada rentang itu").
  const rangeAction = action === 'get_sales' || action === 'profit_loss' || action === 'correct_price';
  const salesFrom = rangeAction && isDate(data.from) ? data.from : (action === 'daily_report' && isDate(data.date) ? data.date : '9999-12-31');
  const salesTo = rangeAction && isDate(data.to) ? data.to : (action === 'daily_report' && isDate(data.date) ? data.date : '0000-01-01');
  return {
    action: action,
    key: String(body.key || ''),
    user: String(body.user || ''),
    pin_hash: String(body.pin_hash || ''),
    data: data,
    client_id: action === 'save_sale' && data.client_id ? String(data.client_id) : '__none__',
    // v57: set_transfer_bank on a sale reads that sale
    invoice_no: (['void_sale', 'request_void', 'decide_approval'].indexOf(action) >= 0 || (action === 'set_transfer_bank' && data.kind === 'sale')) && data.invoice_no ? String(data.invoice_no) : '__none__',
    from: salesFrom,
    to: salesTo,
    // v57: set_transfer_bank on a payment reads the payments of its day
    pay_from: period ? shift(period + '-01', -3) : (action === 'set_transfer_bank' && data.kind === 'payment' && isDate(data.pay_date) ? data.pay_date : salesFrom),
    pay_to: period ? shift(periodEnd, 3) : (action === 'set_transfer_bank' && data.kind === 'payment' && isDate(data.pay_date) ? data.pay_date : salesTo),
    shift_from: action === 'open_shift' ? twoWeeksAgo : salesFrom,
    shift_to: action === 'open_shift' ? today : salesTo,
    bank_account: bankAction && data.account_id ? String(data.account_id) : '__none__',
    bank_period: period || '__none__',
    approval_id: String(data.approval_id || data.request_id || '__none__'),
    // v38: a resent repack request (double tap / retry / offline resend) is found by its client id, decided or not.
    // v39: a direct repack reads the repacks of yesterday + today (a resend by its client id; "someone just repacked this bulk").
    rp_from: action === 'repack' || action === 'request_repack' || action === 'repack_start' ? new Date(Date.now() + 7 * 3600000 - 86400000).toISOString().slice(0, 10) : '9999-12-31',
    approval_client: action === 'request_repack' && data.client_id ? String(data.client_id).slice(0, 60) : '__none__',
    // v68: the photo of the cash a goods-in paid from the drawer (the car, the receipt or what was paid)
    pay_photo_id: action === 'save_purchase' && data.drawer_pay && typeof data.drawer_pay === 'object' && data.drawer_pay.photo_id ? String(data.drawer_pay.photo_id).slice(0, 40) : '__none__',
    photo_id: ['save_purchase', 'receive_payment', 'pay_supplier', 'save_expense', 'save_sale', 'record_transfer', 'confirm_purchase'].indexOf(action) >= 0 && data.photo_id ? String(data.photo_id) : '__none__', // v57: + a sale's / transfer's slip
    ip: String(headers['x-forwarded-for'] || headers['x-real-ip'] || '').split(',')[0].trim(),
    ua: String(headers['user-agent'] || '').slice(0, 300),
    purchase_no: ['request_purchase_fix', 'decide_approval', 'confirm_purchase'].indexOf(action) >= 0 && data.purchase_no ? String(data.purchase_no) : '__none__',
    // v65: goods-in waiting for its confirmation (the last 30 days; v66: also the notes from before the feature) / on credit due within 3 days
    check_since: shift(today, -30),
    due_until: shift(today, 3),
    act_from: action === 'list_activity' && isDate(data.from) ? data.from : (action === 'bootstrap' ? weekAgo : '9999-12-31'),
    act_to: action === 'list_activity' && isDate(data.to) ? data.to : (action === 'bootstrap' ? today : '0000-01-01'),
    // v37: invoice changes (activity kind 'ubah_faktur') for the audit list (its period) and the daily report (its day; there also
    // the goods-in entries 'masuk' of that day, for the time each note was entered).
    chg_from: action === 'list_invoice_changes' && isDate(data.from) ? data.from : (action === 'daily_report' && isDate(data.date) ? data.date : '9999-12-31'),
    chg_to: action === 'list_invoice_changes' && isDate(data.to) ? data.to : (action === 'daily_report' && isDate(data.date) ? data.date : '0000-01-01'),
    chg_kind2: action === 'daily_report' ? 'masuk' : '__none__',
    party_cid: ['receive_payment', 'allocate_payment', 'party_ledger'].indexOf(action) >= 0 && Number(data.customer_id) > 0 ? Number(data.customer_id) : -1,
    party_supplier: ['pay_supplier', 'allocate_payment', 'party_ledger', 'confirm_purchase'].indexOf(action) >= 0 && String(data.supplier || '').trim() ? String(data.supplier).trim().slice(0, 80) : '__none__',
  };
}
