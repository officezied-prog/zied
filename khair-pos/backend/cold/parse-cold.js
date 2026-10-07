// Code node "Parse Cold" (workflow "Khair Gudang Dingin", POST /webhook/khair-cold): body → request + the date to load checks from.
const raw = $input.first().json;
let body = raw.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
if (!body || typeof body !== 'object') body = {};
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const back = function (d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
return [{ json: {
  action: String(body.action || '').slice(0, 40),
  key: String(body.key || ''),
  user: String(body.user || '').slice(0, 60),
  pin_hash: String(body.pin_hash || '').slice(0, 64),
  data: body.data && typeof body.data === 'object' ? body.data : {},
  checks_from: back(today, 120) // daily checks hold the pasted text: only the last 120 days are loaded
} }];
