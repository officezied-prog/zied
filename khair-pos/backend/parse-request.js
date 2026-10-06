const raw = $input.first().json;
let body = raw.body;
if (typeof body === 'string') {
  try { body = JSON.parse(body); } catch (e) { body = {}; }
}
if (!body || typeof body !== 'object') body = {};
const data = body.data && typeof body.data === 'object' ? body.data : {};
const isDate = function (s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); };
const action = String(body.action || '');
return [{ json: {
  action: action,
  key: String(body.key || ''),
  user: String(body.user || ''),
  pin_hash: String(body.pin_hash || ''),
  data: data,
  client_id: action === 'save_sale' && data.client_id ? String(data.client_id) : '__none__',
  invoice_no: ['void_sale', 'request_void', 'decide_approval'].indexOf(action) >= 0 && data.invoice_no ? String(data.invoice_no) : '__none__',
  from: action === 'get_sales' && isDate(data.from) ? data.from : '9999-12-31',
  to: action === 'get_sales' && isDate(data.to) ? data.to : '0000-01-01',
  approval_id: String(data.approval_id || data.request_id || '__none__'),
  photo_id: action === 'save_purchase' && data.photo_id ? String(data.photo_id) : '__none__'
} }];
