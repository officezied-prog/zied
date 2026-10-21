// v50 (owner 2026-10-15: «لما فتحت التطبيق على الحاسوب ونزلت صورة الفاتورة التطبيق لم يستطع قراءة ولا دراسة الفاتورة … يجب على التطبيق
// … يستطيع أن يقرأ الفاتورة ويضع الثمن في مكانه … واسم البضاعة في مكانه والمزود في مكانه»): the photo reader's AI call and what the
// apps are told. The AI (Anthropic API) is replaced here by a stand-in fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert, d1Mock } from './shim.js';
import { handlePhoto } from '../src/photo.js';
import worker from '../src/index.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(400);
const body = () => ({ action: 'scan_purchase', key: KEY, user: 'Siti', pin_hash: h('Siti', '1111'), data: { image_base64: IMG, mime: 'image/jpeg' } });
function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_products', { id: 1, sku: 'AZ1', name: 'Air Zam Zam 1 Liter', unit: 'pcs', cost_price: 18000, retail_price: 25000, stock: 61, active: true });
  return db;
}
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('a readable note: the AI gets room to think + answer; supplier, items and prices come back for the form', async () => {
  let sent = null;
  const note = { supplier: 'Sarah Hartati', date: '2026-10-15', invoice_no: 'SH-77', items: [{ name: 'AIR ZAM ZAM 1 LITER', qty: 50, unit: 'pcs', unit_price: 19000, total: 950000 }], total: 950000, readable: true, notes: '' };
  const r = await withFetch(async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(note) }] }), { status: 200 });
  }, () => handlePhoto(sqliteAdapter(seed()), body(), {}, KEY, { ANTHROPIC_API_KEY: 'test-key' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'test-key');
  assert.equal(sent.body.max_tokens, 16000); // was 3000: the thinking + a long note's answer did not fit
  assert.deepEqual(sent.body.output_config, { effort: 'medium' });
  assert.equal(sent.body.messages[0].content[0].type, 'image');
  assert.equal(r.ai, 'ok');
  assert.equal(r.extracted.supplier, 'Sarah Hartati');
  assert.deepEqual(r.extracted.items.map((i) => [i.name, i.qty, i.unit_price]), [['AIR ZAM ZAM 1 LITER', 50, 19000]]);
  assert.equal(r.suggestions[0].product_id, 1); // matched to the shop's product
});

test('the AI fails: the apps are told why (HTTP status, an answer cut off) — never a silent empty result', async () => {
  const run = (res) => withFetch(async () => res, () => handlePhoto(sqliteAdapter(seed()), body(), {}, KEY, { ANTHROPIC_API_KEY: 'bad-key' }));
  const r401 = await run(new Response('{"type":"error"}', { status: 401 }));
  assert.equal(r401.ok, true); assert.equal(r401.ai, 'error'); assert.equal(r401.ai_error, 'AI HTTP 401');
  const cut = await run(new Response(JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"items":[{"name":"A' }] }), { status: 200 }));
  assert.equal(cut.ai, 'error'); assert.equal(cut.ai_error, 'AI_CUT_OFF');
  assert.equal(cut.extracted.items.length, 0);
});

test('bootstrap tells the apps whether the photo reader is on (the AI key is set in the Worker)', async () => {
  const db = seed();
  const call = async (env) => (await (await worker.fetch(new Request('https://w.test/webhook/khair-pos', { method: 'POST', body: JSON.stringify({ action: 'bootstrap', key: KEY, user: 'Pemilik', pin_hash: h('Pemilik', '1234'), data: {} }) }), env)).json());
  assert.equal((await call({ DB: d1Mock(db), STORE_KEY: KEY })).ai_reader, false);
  assert.equal((await call({ DB: d1Mock(db), STORE_KEY: KEY, ANTHROPIC_API_KEY: 'k' })).ai_reader, true);
});

test('v70: an evidence photo (cash paid from the drawer at goods-in, read: false) is kept but never sent to the AI', async () => {
  let calls = 0;
  const db = seed();
  const ev = { action: 'scan_expense', key: KEY, user: 'Siti', pin_hash: h('Siti', '1111'), data: { image_base64: IMG, mime: 'image/jpeg', read: false } };
  const r = await withFetch(async () => { calls++; return new Response('{}', { status: 500 }); },
    () => handlePhoto(sqliteAdapter(db), ev, {}, KEY, { ANTHROPIC_API_KEY: 'test-key' }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(calls, 0, 'no AI call: nothing to read on a photo of the car or the money, and its answer was never used');
  assert.equal(r.ai, 'skipped');
  assert.match(r.photo_id, /^PH/);
  const row = db.prepare('SELECT kind, match_status, match_notes, extracted FROM pos_photos').get();
  assert.equal(row.kind, 'biaya');
  assert.equal(row.match_status, '', 'not "perlu cek": an evidence photo has nothing to check');
  assert.equal(JSON.parse(row.extracted).stored_only, true);
  // an expense receipt sent as before is still read
  const read = await withFetch(async () => { calls++; return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"vendor":"PLN","total":250000,"amount":250000,"items":[],"readable":true,"notes":""}' }] }), { status: 200 }); },
    () => handlePhoto(sqliteAdapter(db), { ...ev, data: { image_base64: IMG, mime: 'image/jpeg' } }, {}, KEY, { ANTHROPIC_API_KEY: 'test-key' }));
  assert.equal(calls, 1); assert.equal(read.ai, 'ok'); assert.equal(read.extracted.amount, 250000);
});
