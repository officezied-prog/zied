const raw = $input.first().json;
let body = raw.body;
if (typeof body === 'string') {
  try { body = JSON.parse(body); } catch (e) { body = {}; }
}
if (!body || typeof body !== 'object') body = {};
const data = body.data && typeof body.data === 'object' ? body.data : {};
const isDate = function (s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); };
const action = String(body.action || '');
let img = typeof data.image_base64 === 'string' ? data.image_base64.replace(/^data:[^,]*,/, '').replace(/\s/g, '') : '';
const tooBig = img.length > 8000000;
if (tooBig) img = '';
return [{ json: {
  action: action,
  key: String(body.key || ''),
  user: String(body.user || ''),
  pin_hash: String(body.pin_hash || ''),
  img: img,
  too_big: tooBig,
  mime: /^image\/(jpeg|png|webp)$/.test(String(data.mime || '')) ? data.mime : 'image/jpeg',
  invoice_no: action === 'scan_exit' && data.invoice_no ? String(data.invoice_no) : '__none__',
  from: action === 'list_photos' && isDate(data.from) ? data.from : '9999-12-31',
  to: action === 'list_photos' && isDate(data.to) ? data.to : '0000-01-01'
} }];
