// Code node "Parse Att" (workflow "Khair Mart POS – Absensi", POST /webhook/khair-att): body → request + the date range to load.
const raw = $input.first().json;
let body = raw.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
if (!body || typeof body !== 'object') body = {};
const data = body.data && typeof body.data === 'object' ? body.data : {};
const isDate = function (s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); };
const today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const back = function (d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - n); return x.toISOString().slice(0, 10); };
const action = String(body.action || '');
// Writes need today (state, duplicates) and the last days (to seal finished days); a report needs its range too.
let from = back(today, 7);
if (action === 'att_report' && isDate(data.from) && data.from < from) from = data.from;
return [{ json: {
  action: action,
  key: String(body.key || ''),
  user: String(body.user || ''),
  pin_hash: String(body.pin_hash || ''),
  data: data,
  load_from: from,
  load_to: today
} }];
