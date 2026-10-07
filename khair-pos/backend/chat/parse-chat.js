// Code node "Parse Chat" (workflow "Khair Mart POS – Chat", POST /webhook/khair-chat): body (JSON or text/plain) -> request.
const raw = $input.first().json;
let body = raw.body;
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
if (!body || typeof body !== 'object') body = {};
return [{ json: {
  action: String(body.action || '').slice(0, 40),
  key: String(body.key || ''),
  user: String(body.user || '').slice(0, 60),
  pin_hash: String(body.pin_hash || '').slice(0, 64),
  data: body.data && typeof body.data === 'object' ? body.data : {}
} }];
