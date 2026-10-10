// Field (sales-lapangan) API — replaces the n8n "Khair Mart POS – Field" workflow
// (POST .../webhook/khair-field). Same pipeline as POS but its own Parse/loaders/process
// and no Finalize node (the live Respond returns the Process Field response directly).
import { execSpecs, makeAccessor, applyOps, Q } from './db.js';
import { OPS_TABLE_FIELD } from '../tables.js';
import { runProcessField } from './generated/process-field.gen.js';

// Port of the live "Parse Field" code node.
export function parseField(body, headers) {
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const action = String(body.action || '');
  const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
  const pid = Number(data.product_id);
  const since30 = new Date(Date.now() + 7 * 3600000 - 30 * 86400000).toISOString().slice(0, 10);
  return {
    action,
    key: String(body.key || ''),
    user: String(body.user || ''),
    pin_hash: String(body.pin_hash || ''),
    data,
    today,
    client_id: (action === 'check_in' || action === 'field_order') && data.client_id ? String(data.client_id) : '__none__',
    order_id: action === 'update_order' && data.order_id ? String(data.order_id) : '__none__',
    from: action === 'list_field' && isDate(data.from) ? data.from : '9999-12-31',
    to: action === 'list_field' && isDate(data.to) ? data.to : '0000-01-01',
    recent_from: action === 'field_bootstrap' ? since30 : '9999-12-31',
    img_lo: action === 'product_images' ? 0 : (action === 'set_product_image' && pid > 0 ? pid : 1),
    img_hi: action === 'product_images' ? 1000000000 : (action === 'set_product_image' && pid > 0 ? pid : 0),
  };
}

function fieldSpecs(req) {
  return {
    'Get Users': Q.all('pos_users'),
    'Get Products': Q.all('pos_products'),
    'Get Shops': Q.all('pos_shops'),
    'Get Customers': Q.all('pos_customers'),
    'Get Today Days': Q.eq('pos_field_days', 'day_date', req.today),
    'Get Today Tracks': Q.eq('pos_tracks', 'track_date', req.today),
    'Get Today Visits': Q.eq('pos_visits', 'visit_date', req.today),
    'Get Today Orders': Q.eq('pos_field_orders', 'order_date', req.today),
    'Get Visit By Client': Q.eq('pos_visits', 'client_id', req.client_id),
    'Get Order By Client': Q.eq('pos_field_orders', 'client_id', req.client_id),
    'Get Order By Id': Q.eq('pos_field_orders', 'order_id', req.order_id),
    'Get Range Tracks': Q.range('pos_tracks', 'track_date', req.from, req.to),
    'Get Range Visits': Q.range('pos_visits', 'visit_date', req.from, req.to),
    'Get Range Orders': Q.range('pos_field_orders', 'order_date', req.from, req.to),
    'Get Open Orders': Q.eq('pos_field_orders', 'status', 'baru'),
    'Get Range Days': Q.range('pos_field_days', 'day_date', req.from, req.to),
    'Get Images': Q.range('pos_product_images', 'product_id', req.img_lo, req.img_hi),
    'Get Recent Orders': Q.gte('pos_field_orders', 'order_date', req.recent_from),
  };
}

export async function loadFieldNodes(adapter, req) {
  const nodes = await execSpecs(adapter, fieldSpecs(req));
  nodes['Parse Field'] = [req];
  return nodes;
}

export async function handleField(adapter, body, headers, STORE_KEY) {
  const req = parseField(body, headers);
  const nodes = await loadFieldNodes(adapter, req);
  const $ = makeAccessor(nodes);
  const out = runProcessField($, STORE_KEY)[0].json; // { response, ops, action }
  await applyOps(adapter, out.ops || {}, OPS_TABLE_FIELD);
  return out.response; // field workflow has no Finalize node
}
