const a = $('Auth & Route').first().json;
const out = $input.first().json || {};
function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function rand(n) {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < n; i++) r += s[Math.floor(Math.random() * s.length)];
  return r;
}
function findText(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (Array.isArray(o.content)) {
    const t = o.content.filter(function (c) { return c && c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
    if (t) return t;
  }
  if (typeof o.text === 'string') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (typeof o.content === 'string') return o.content;
  if (o.message) return findText(o.message);
  return JSON.stringify(o);
}
let ex = null;
let aiError = '';
if (out.error) aiError = typeof out.error === 'string' ? out.error : JSON.stringify(out.error).slice(0, 300);
const text = findText(out);
function firstObject(t) {
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return null;
}
if (!aiError) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s >= 0 && e > s) { try { ex = JSON.parse(text.slice(s, e + 1)); } catch (err) { ex = null; } }
  if (!ex) { const fo = firstObject(text); if (fo) { try { ex = JSON.parse(fo); } catch (err) { ex = null; } } }
}
if (!ex || typeof ex !== 'object') ex = { items: [], readable: false, notes: aiError ? 'AI gagal membaca: ' + aiError : 'AI tidak mengembalikan data yang bisa dibaca' };
if (!Array.isArray(ex.items)) ex.items = [];
ex.items = ex.items.slice(0, 100).map(function (it) {
  return { name: str(it && it.name), qty: it && it.qty !== null && it.qty !== undefined && isFinite(Number(it.qty)) ? Number(it.qty) : null,
    unit: it && it.unit ? str(it.unit) : null, unit_price: it && isFinite(Number(it.unit_price)) && it.unit_price !== null ? Math.round(Number(it.unit_price)) : null,
    total: it && isFinite(Number(it.total)) && it.total !== null ? Math.round(Number(it.total)) : null };
});

function norm(x) {
  return str(x).toLowerCase().replace(/(\d+)[.,]?(\d*)\s*(kg|gr|gram|g|ml|ltr|l|pcs|pc)\b/g, '$1$2$3').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokens(x) { return norm(x).split(' ').filter(function (t) { return t.length > 1; }); }
function near(a1, b1) {
  if (a1 === b1) return true;
  if (a1.length > 3 && b1.length > 3 && (a1.indexOf(b1) === 0 || b1.indexOf(a1) === 0)) return true;
  if (a1.length < 5 || b1.length < 5 || Math.abs(a1.length - b1.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a1.length && j < b1.length) {
    if (a1[i] === b1[j]) { i++; j++; continue; }
    edits++;
    if (edits > 1) return false;
    if (a1.length > b1.length) i++; else if (b1.length > a1.length) j++; else { i++; j++; }
  }
  return edits + (a1.length - i) + (b1.length - j) <= 1;
}
function score(a1, b1) {
  const ta = tokens(a1), tb = tokens(b1);
  if (!ta.length || !tb.length) return 0;
  let hit = 0;
  ta.forEach(function (t) { if (tb.some(function (u) { return near(t, u); })) hit++; });
  return Math.round(((hit / ta.length + hit / tb.length) / 2) * 100) / 100;
}

const photoId = 'PH' + rand(8);
const now = new Date().toISOString();
const photoDate = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const resp = { ok: true, photo_id: photoId, extracted: ex, drive_url: '' };
let matchStatus = '';
let matchNotes = '';
let saleUpdate = null;

if (a.kind === 'bayar') {
  const amt = Number(ex.amount);
  ex.amount = ex.amount !== null && ex.amount !== undefined && isFinite(amt) ? Math.round(amt) : null;
  ['date', 'time', 'sender_name', 'sender_bank', 'receiver_name', 'receiver_bank', 'bank', 'transfer_ref', 'description'].forEach(function (k) { ex[k] = ex[k] === null || ex[k] === undefined ? null : str(ex[k]).slice(0, 120); });
  if (ex.date && !/^\d{4}-\d{2}-\d{2}$/.test(ex.date)) ex.date = null;
  matchStatus = ex.readable === false || ex.amount === null || ex.status === 'gagal' ? 'perlu_cek' : '';
  matchNotes = str(ex.notes).slice(0, 500);
} else if (a.kind === 'masuk') {
  let products = [];
  try { products = $('Get Products').all().map(function (i) { return i.json; }).filter(function (p) { return p && p.id !== undefined && p.active !== false; }); } catch (err) { products = []; }
  resp.suggestions = ex.items.map(function (it, idx) {
    let best = null;
    products.forEach(function (p) {
      const sc = score(it.name, p.name);
      if (!best || sc > best.score) best = { index: idx, product_id: p.id, product_name: str(p.name), score: sc };
    });
    return best && best.score >= 0.5 ? best : { index: idx, product_id: null, product_name: '', score: 0 };
  });
  matchStatus = ex.readable === false ? 'perlu_cek' : '';
  matchNotes = str(ex.notes).slice(0, 500);
} else if (a.kind === 'retur') {
  // Supplier return (v17): keep the note number in the same shape the return form accepts.
  const doc = str(ex.doc_no).toUpperCase().replace(/\s+/g, ' ').slice(0, 40);
  ex.doc_no = /^[A-Z0-9][A-Z0-9 \/.-]{0,39}$/.test(doc) ? doc : null;
  ex.supplier = ex.supplier === null || ex.supplier === undefined ? null : str(ex.supplier).slice(0, 120);
  if (ex.date && !/^\d{4}-\d{2}-\d{2}$/.test(ex.date)) ex.date = null;
  matchStatus = ex.readable === false ? 'perlu_cek' : '';
  matchNotes = str(ex.notes).slice(0, 500);
} else {
  const m = ex.match && typeof ex.match === 'object' ? ex.match : {};
  let status = ['cocok', 'tidak_cocok', 'perlu_cek'].indexOf(m.status) >= 0 ? m.status : 'perlu_cek';
  const diffs = Array.isArray(m.diffs) ? m.diffs.slice(0, 50) : [];
  // Safety net: the AI may say "cocok" while the totals clearly differ.
  const recordedQty = (a.recorded || []).reduce(function (s1, r) { return s1 + (Number(r.qty) || 0); }, 0);
  const photoQty = ex.items.reduce(function (s1, r) { return s1 + (Number(r.qty) || 0); }, 0);
  if (status === 'cocok' && photoQty > 0 && Math.abs(photoQty - recordedQty) > 0.001) status = 'perlu_cek';
  if (ex.readable === false && status === 'cocok') status = 'perlu_cek';
  matchStatus = status;
  matchNotes = (str(m.notes) || str(ex.notes)).slice(0, 500);
  resp.match = { status: status, notes: matchNotes, diffs: diffs };
  saleUpdate = { id: a.sale_id, exit_photo: photoId, exit_match: status };
}

const photo = {
  photo_id: photoId, kind: a.kind, ref: a.ref || '', created_at: now, photo_date: photoDate, user: a.user,
  drive_file_id: '', drive_url: '', extracted: JSON.stringify(ex).slice(0, 12000), match_status: matchStatus, match_notes: matchNotes
};
return [{ json: { photo: photo, sale_update: saleUpdate, has_sale_update: !!saleUpdate, response: resp } }];
