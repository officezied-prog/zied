const raw = $input.first().json;
let body = raw.body;
if (typeof body === 'string') {
  try { body = JSON.parse(body); } catch (e) { body = {}; }
}
if (!body || typeof body !== 'object') body = {};
const data = body.data && typeof body.data === 'object' ? body.data : {};
const isDate = function (s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); };
const action = String(body.action || '');
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const pid = Number(data.product_id);
const since30 = new Date(Date.now() + 7 * 3600000 - 30 * 86400000).toISOString().slice(0, 10);
return [{ json: {
  action: action,
  key: String(body.key || ''),
  user: String(body.user || ''),
  pin_hash: String(body.pin_hash || ''),
  data: data,
  today: today,
  client_id: (action === 'check_in' || action === 'field_order') && data.client_id ? String(data.client_id) : '__none__',
  order_id: action === 'update_order' && data.order_id ? String(data.order_id) : '__none__',
  from: action === 'list_field' && isDate(data.from) ? data.from : '9999-12-31',
  to: action === 'list_field' && isDate(data.to) ? data.to : '0000-01-01',
  recent_from: action === 'field_bootstrap' ? since30 : '9999-12-31',
  img_lo: action === 'product_images' ? 0 : (action === 'set_product_image' && pid > 0 ? pid : 1),
  img_hi: action === 'product_images' ? 1000000000 : (action === 'set_product_image' && pid > 0 ? pid : 0)
} }];
