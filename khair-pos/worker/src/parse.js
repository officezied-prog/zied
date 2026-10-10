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
  const salesFrom = action === 'get_sales' && isDate(data.from) ? data.from : (action === 'daily_report' && isDate(data.date) ? data.date : '9999-12-31');
  const salesTo = action === 'get_sales' && isDate(data.to) ? data.to : (action === 'daily_report' && isDate(data.date) ? data.date : '0000-01-01');
  return {
    action: action,
    key: String(body.key || ''),
    user: String(body.user || ''),
    pin_hash: String(body.pin_hash || ''),
    data: data,
    client_id: action === 'save_sale' && data.client_id ? String(data.client_id) : '__none__',
    invoice_no: ['void_sale', 'request_void', 'decide_approval'].indexOf(action) >= 0 && data.invoice_no ? String(data.invoice_no) : '__none__',
    from: salesFrom,
    to: salesTo,
    pay_from: period ? shift(period + '-01', -3) : salesFrom,
    pay_to: period ? shift(periodEnd, 3) : salesTo,
    shift_from: action === 'open_shift' ? twoWeeksAgo : salesFrom,
    shift_to: action === 'open_shift' ? today : salesTo,
    bank_account: bankAction && data.account_id ? String(data.account_id) : '__none__',
    bank_period: period || '__none__',
    approval_id: String(data.approval_id || data.request_id || '__none__'),
    photo_id: ['save_purchase', 'receive_payment', 'pay_supplier'].indexOf(action) >= 0 && data.photo_id ? String(data.photo_id) : '__none__',
    ip: String(headers['x-forwarded-for'] || headers['x-real-ip'] || '').split(',')[0].trim(),
    ua: String(headers['user-agent'] || '').slice(0, 300),
    purchase_no: ['request_purchase_fix', 'decide_approval'].indexOf(action) >= 0 && data.purchase_no ? String(data.purchase_no) : '__none__',
    act_from: action === 'list_activity' && isDate(data.from) ? data.from : (action === 'bootstrap' ? weekAgo : '9999-12-31'),
    act_to: action === 'list_activity' && isDate(data.to) ? data.to : (action === 'bootstrap' ? today : '0000-01-01'),
    party_cid: ['receive_payment', 'allocate_payment', 'party_ledger'].indexOf(action) >= 0 && Number(data.customer_id) > 0 ? Number(data.customer_id) : -1,
    party_supplier: ['pay_supplier', 'allocate_payment', 'party_ledger'].indexOf(action) >= 0 && String(data.supplier || '').trim() ? String(data.supplier).trim().slice(0, 80) : '__none__',
  };
}
