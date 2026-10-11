// v36 (owner 2026-10-11: «صور من يحاول كتابة الكود هذا ضروري جدا»): report_tamper keeps a front-camera photo of whoever
// typed code (or a run of sequential digits in a text field), in two calls with the same shot_id (lock at once, photo after);
// list_tamper_shots is owner-only; the table is created at runtime on a D1 that predates it; sales / akuntan can report.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { newDb, sqliteAdapter, insert } from './shim.js';
import { handleRequest } from '../src/core.js';

const KEY = 'KHAIR-TEST-0000';
const h = (u, p) => crypto.createHash('sha256').update(KEY + ':' + u.toLowerCase() + ':' + p).digest('hex');
const PHOTO = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes-'.repeat(400)).toString('base64');

function seed(opts = {}) {
  const db = newDb();
  if (opts.oldD1) db.exec('DROP TABLE pos_tamper_shots'); // the live D1 was created before v36
  insert(db, 'pos_users', { id: 1, name: 'Pemilik', role: 'owner', pin_hash: h('Pemilik', '1234'), active: true });
  insert(db, 'pos_users', { id: 2, name: 'Siti', role: 'kasir', pin_hash: h('Siti', '1111'), active: true });
  insert(db, 'pos_users', { id: 3, name: 'Wahyu', role: 'sales', pin_hash: h('Wahyu', '3333'), active: true });
  insert(db, 'pos_users', { id: 4, name: 'Dewi', role: 'akuntan', pin_hash: h('Dewi', '5555'), active: true });
  return db;
}
const call = (db, action, user, pin, data = {}) => handleRequest(sqliteAdapter(db), JSON.stringify({ action, key: KEY, user, pin_hash: h(user, pin), data }), {}, KEY);
const shots = db => db.prepare('SELECT * FROM pos_tamper_shots ORDER BY id').all();
const locked = db => JSON.parse((db.prepare("SELECT svalue FROM pos_settings WHERE skey = 'locked_accounts'").get() || { svalue: '[]' }).svalue);

test('tamper: lock at once (photo pending), then the photo for the same shot; table created on an old D1', async () => {
  const db = seed({ oldD1: true });
  const r1 = await call(db, 'report_tamper', 'Siti', '1111', { where: 'cm-note', kind: 'code', shot_id: 'TSABCDEFGH2345', photo_status: 'pending', device: { id: 'dev-1' } });
  assert.equal(r1.ok, true); assert.equal(r1.locked, true); assert.equal(r1.photo_status, 'pending');
  assert.deepEqual(locked(db), ['siti']);
  let s = shots(db);
  assert.equal(s.length, 1);
  assert.equal(s[0].shot_id, 'TSABCDEFGH2345'); assert.equal(s[0].user, 'Siti'); assert.equal(s[0].place, 'cm-note'); assert.equal(s[0].photo_status, 'pending'); assert.equal(s[0].device, 'dev-1'); assert.equal(s[0].photo, '');
  // the account is locked for everything else, but the photo still reaches the owner
  const blocked = await call(db, 'bootstrap', 'Siti', '1111');
  assert.equal(blocked.error, 'TAMPER_LOCKED');
  const r2 = await call(db, 'report_tamper', 'Siti', '1111', { where: 'cm-note', kind: 'code', shot_id: 'TSABCDEFGH2345', photo_status: 'ok', photo: PHOTO });
  assert.equal(r2.ok, true); assert.equal(r2.photo_status, 'ok');
  s = shots(db);
  assert.equal(s.length, 1, 'same row, not a second one');
  assert.equal(s[0].photo, PHOTO); assert.equal(s[0].photo_status, 'ok');
  // a third call cannot replace the photo
  await call(db, 'report_tamper', 'Siti', '1111', { shot_id: 'TSABCDEFGH2345', photo_status: 'ok', photo: 'data:image/jpeg;base64,AAAA' });
  assert.equal(shots(db)[0].photo, PHOTO);
  const acts = db.prepare("SELECT summary, level FROM pos_activity WHERE kind = 'tamper' ORDER BY id").all();
  assert.match(acts[0].summary, /Percobaan menulis kode — akun dikunci \(cm-note\) · foto menyusul/); assert.equal(acts[0].level, 'danger');
  assert.match(acts[1].summary, /Foto percobaan kode tersimpan/);
  assert.equal(acts.length, 2);
});

test('tamper: camera refused → recorded without a photo; digits kind keeps only the digits; a bad photo is dropped', async () => {
  const db = seed();
  await call(db, 'report_tamper', 'Siti', '1111', { where: 'so-note', kind: 'digits', sample: '1234-5678 x', shot_id: 'TSZZZZZZZZ2222', photo_status: 'pending' });
  await call(db, 'report_tamper', 'Siti', '1111', { where: 'so-note', kind: 'digits', shot_id: 'TSZZZZZZZZ2222', photo_status: 'denied' });
  let s = shots(db);
  assert.equal(s[0].kind, 'digits'); assert.equal(s[0].sample, '12345678'); assert.equal(s[0].photo_status, 'denied'); assert.equal(s[0].photo, '');
  const acts = db.prepare("SELECT summary FROM pos_activity WHERE kind = 'tamper' ORDER BY id").all().map(a => a.summary);
  assert.match(acts[0], /^Angka berurutan "12345678" — akun dikunci/);
  assert.match(acts[1], /tanpa foto \(kamera ditolak\)/);
  // not a JPEG data URL → no photo kept (status error), the lock still stands
  const r = await call(db, 'report_tamper', 'Siti', '1111', { where: 'x', photo_status: 'ok', photo: 'data:text/html;base64,PHNjcmlwdD4=' });
  assert.equal(r.ok, true);
  s = shots(db);
  assert.equal(s.length, 2); assert.equal(s[1].photo, ''); assert.equal(s[1].photo_status, 'error');
  assert.deepEqual(locked(db), ['siti']);
});

test('tamper: list_tamper_shots is owner-only, newest first, filter by name; the owner unlocks', async () => {
  const db = seed();
  await call(db, 'report_tamper', 'Siti', '1111', { where: 'a', shot_id: 'TSAAAAAAAAAAAA', photo_status: 'ok', photo: PHOTO });
  await call(db, 'report_tamper', 'Wahyu', '3333', { where: 'ci-notes', shot_id: 'TSBBBBBBBBBBBB', photo_status: 'none' });
  const no = await call(db, 'list_tamper_shots', 'Siti', '1111');
  assert.equal(no.ok, false);
  const all = await call(db, 'list_tamper_shots', 'Pemilik', '1234');
  assert.equal(all.ok, true);
  assert.deepEqual(all.shots.map(x => x.user).sort(), ['Siti', 'Wahyu']);
  const one = await call(db, 'list_tamper_shots', 'Pemilik', '1234', { name: 'siti' });
  assert.equal(one.shots.length, 1); assert.equal(one.shots[0].photo, PHOTO);
  const boot = await call(db, 'bootstrap', 'Pemilik', '1234');
  assert.deepEqual(boot.users.filter(u => u.tamper).map(u => u.name).sort(), ['Siti', 'Wahyu']);
  const un = await call(db, 'clear_tamper', 'Pemilik', '1234', { name: 'Siti' });
  assert.equal(un.ok, true);
  assert.deepEqual(locked(db), ['wahyu']);
});

test('tamper: the field rep (sales) and the accountant can report (was FORBIDDEN before v36); another user cannot fill my shot', async () => {
  const db = seed();
  const s1 = await call(db, 'report_tamper', 'Wahyu', '3333', { where: 'ci-notes', kind: 'digits', sample: '11111111', shot_id: 'TSCCCCCCCCCCCC', photo_status: 'pending' });
  assert.equal(s1.ok, true); assert.equal(s1.locked, true);
  const a1 = await call(db, 'report_tamper', 'Dewi', '5555', { where: 'note', shot_id: 'TSDDDDDDDDDDDD', photo_status: 'pending' });
  assert.equal(a1.ok, true);
  assert.deepEqual(locked(db).sort(), ['dewi', 'wahyu']);
  const steal = await call(db, 'report_tamper', 'Siti', '1111', { shot_id: 'TSCCCCCCCCCCCC', photo_status: 'ok', photo: PHOTO });
  assert.equal(steal.error, 'FORBIDDEN');
  assert.equal(shots(db).find(x => x.shot_id === 'TSCCCCCCCCCCCC').photo, '');
});

test('tamper: a photo arriving after the owner already unlocked does not lock the account again', async () => {
  const db = seed();
  await call(db, 'report_tamper', 'Siti', '1111', { where: 'n', shot_id: 'TSEEEEEEEEEEEE', photo_status: 'pending' });
  assert.deepEqual(locked(db), ['siti']);
  await call(db, 'clear_tamper', 'Pemilik', '1234', { name: 'Siti' });
  assert.deepEqual(locked(db), []);
  const late = await call(db, 'report_tamper', 'Siti', '1111', { where: 'n', shot_id: 'TSEEEEEEEEEEEE', photo_status: 'ok', photo: PHOTO });
  assert.equal(late.ok, true); assert.equal(late.locked, false);
  assert.deepEqual(locked(db), []);
  assert.equal(shots(db)[0].photo, PHOTO);
});
