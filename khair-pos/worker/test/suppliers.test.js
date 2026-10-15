// v56 (owner 2026-10-15) — the supplier directory, on the real backend (backend/process.js through the Worker's loaders) on an
// in-memory SQLite:
//   «الموردون يمكن للمحاسب والمدير إضافة المورد جديد مع الاسم اسم الشركة اسم المكان المهنة المواد التي يقدمها التي يبيعها»
//   the accountant / manager add a supplier (name, company, place, trade, goods it sells), edit it (the name stays: the goods-in
//   notes and payments are filed under it); the owner is told; the cashier gets the names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PIN = { Pemilik: '1234', Siti: '1111', Jihan: '2222', Aqil: '4444' };
const call = (ad, user, action, data) => handleRequest(ad, { action, key: KEY, user, pin_hash: h(user, PIN[user]), data }, {}, KEY);

function seed() {
  const db = newDb();
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Jihan', role: 'manager', pin_hash: h('Jihan', '2222'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Aqil', role: 'akuntan', pin_hash: h('Aqil', '4444'), active: true });
  return db;
}
const notices = (db) => db.prepare("SELECT summary, ref FROM pos_activity WHERE kind = 'notifikasi' ORDER BY id").all();
const AJWA = { name: 'CV Kurma Madinah', company: 'CV Kurma Madinah Sejahtera', place: 'Tanah Abang, Jakarta Pusat', trade: 'Importir kurma', goods: 'Kurma Ajwa, Kurma Sukkari, Kurma Medjool', phone: '0812-3456-7890', note: 'Kirim tiap Senin' };

test('the accountant adds a supplier with its company, place, trade and goods; the owner and the manager are told', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  const r = await call(ad, 'Aqil', 'save_supplier', { supplier: AJWA });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual({ ...r.supplier, at: undefined }, { n: 'CV Kurma Madinah', co: 'CV Kurma Madinah Sejahtera', pl: 'Tanah Abang, Jakarta Pusat', tr: 'Importir kurma', gd: 'Kurma Ajwa, Kurma Sukkari, Kurma Medjool', ph: '6281234567890', nt: 'Kirim tiap Senin', by: 'Aqil', at: undefined });
  const n = notices(db).at(-1);
  assert.equal(n.ref, 'owner,manager');
  assert.match(n.summary, /^Pemasok baru: CV Kurma Madinah · CV Kurma Madinah Sejahtera · Tanah Abang, Jakarta Pusat · Importir kurma — menjual: Kurma Ajwa, Kurma Sukkari, Kurma Medjool — oleh akuntan Aqil$/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM pos_activity WHERE kind = 'pemasok'").get().n, 1);
  // the same name again (any case) is refused; the manager adds another one
  assert.equal((await call(ad, 'Jihan', 'save_supplier', { supplier: { ...AJWA, name: 'cv kurma madinah' } })).error, 'DUPLICATE');
  assert.equal((await call(ad, 'Jihan', 'save_supplier', { supplier: { name: 'Toko Kacang Haji Umar', goods: 'Kacang almond, pistachio' } })).ok, true);
  assert.equal(notices(db).at(-1).ref, 'owner,akuntan');
  // bootstrap: the full directory for the owner / manager / accountant, the names only for the cashier
  const own = (await call(ad, 'Pemilik', 'bootstrap', {})).settings.supplier_dir;
  assert.deepEqual(own.map((x) => [x.n, x.tr || '']), [['CV Kurma Madinah', 'Importir kurma'], ['Toko Kacang Haji Umar', '']]);
  assert.equal((await call(ad, 'Aqil', 'bootstrap', {})).settings.supplier_dir[0].ph, '6281234567890');
  assert.deepEqual((await call(ad, 'Siti', 'bootstrap', {})).settings.supplier_dir, [{ n: 'CV Kurma Madinah' }, { n: 'Toko Kacang Haji Umar' }]);
});

test('editing keeps the name; only the cashier is refused; bad input is refused', async () => {
  const db = seed(), ad = sqliteAdapter(db);
  await call(ad, 'Jihan', 'save_supplier', { supplier: AJWA });
  const e = await call(ad, 'Aqil', 'save_supplier', { edit: true, supplier: { ...AJWA, name: 'CV KURMA MADINAH', place: 'Bekasi', goods: 'Kurma Ajwa, Kurma Khalas' } });
  assert.equal(e.ok, true, JSON.stringify(e));
  assert.equal(e.supplier.n, 'CV Kurma Madinah'); // the name it is filed under stays
  assert.equal(e.supplier.pl, 'Bekasi');
  assert.equal(e.supplier.by, 'Jihan');
  assert.equal(e.supplier.ub, 'Aqil');
  assert.match(notices(db).at(-1).summary, /^Data pemasok CV Kurma Madinah diubah — tempat: Bekasi; barang: Kurma Ajwa, Kurma Khalas — oleh akuntan Aqil$/);
  assert.equal((await call(ad, 'Aqil', 'save_supplier', { edit: true, supplier: { ...AJWA, name: 'CV Kurma Madinah', place: 'Bekasi', goods: 'Kurma Ajwa, Kurma Khalas' } })).unchanged, true);
  assert.equal((await call(ad, 'Aqil', 'save_supplier', { edit: true, supplier: { ...AJWA, name: 'PT Lain' } })).error, 'NOT_FOUND');
  assert.equal((await call(ad, 'Siti', 'save_supplier', { supplier: { name: 'X', goods: 'y' } })).error, 'FORBIDDEN');
  for (const bad of [{ goods: 'Kurma' }, { name: '<b>', goods: 'Kurma' }, { name: 'A'.repeat(61), goods: 'Kurma' }, { name: 'PT Baru' }, { name: 'PT Baru', goods: 'Kurma', phone: '12' }]) {
    assert.equal((await call(ad, 'Jihan', 'save_supplier', { supplier: bad })).error, 'INVALID', JSON.stringify(bad));
  }
  assert.equal((await call(ad, 'Pemilik', 'bootstrap', {})).settings.supplier_dir.length, 1);
  // the general settings save cannot overwrite the directory
  await call(ad, 'Pemilik', 'save_settings', { settings: { supplier_dir: [] } });
  assert.equal((await call(ad, 'Pemilik', 'bootstrap', {})).settings.supplier_dir.length, 1);
});
