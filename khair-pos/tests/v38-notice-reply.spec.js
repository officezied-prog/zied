// v38 (owner 2026-10-12: "For any notice come to me make for me I can reply" + «نعم زر رد او اغلق مباشر ما في مشكل»)
//   every notice the owner sees has "Balas" (a private chat message to the person behind it, with the notice quoted) and
//   "Tutup" (one tap: gone from the bell, the count drops, kept in the history marked); the state is server-side (chat backend),
//   so it survives a reload / another device; system notices → he picks the person (default: the manager).
const { test, expect } = require('@playwright/test');
const { login, openApp, getDb, editDb, asUser, nav, jktToday } = require('./helpers');

function chatAs(page, user, pin, action, data = {}) {
  return page.evaluate(async ({ user, pin, action, data }) => {
    const pin_hash = await KPOS.pinHash('demo', user, pin);
    try { return await apiRawInner(action, data, { key: 'demo', user, pin_hash }, { chat: true }); }
    catch (e) { return { error: e.code, message: e.message }; }
  }, { user, pin, action, data });
}
/** A notice row as the server writes it (activity kind 'notifikasi', the target roles in ref). */
function addNotice(page, n) {
  return editDb(page, `db.activity = db.activity || []; const d = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    db.activity.push(Object.assign({ id: 9000 + db.activity.length, at: new Date().toISOString(), act_date: d, kind: 'notifikasi', amount: 0, level: 'warn' }, arg));`, n);
}
const bellN = page => page.evaluate(() => { const b = document.querySelector('#tb-bell b'); return b ? Number(b.textContent) : 0; });
/** The attention list is computed in the background after the app opens: wait until the bell count stops moving. */
async function settledBell(page) {
  await page.waitForFunction(() => ATT.items.length > 0);
  let a = await bellN(page), b;
  for (let i = 0; i < 20; i++) { await page.waitForTimeout(400); b = await bellN(page); if (a === b) return b; a = b; }
  return b;
}
async function reopen(page, clearLocal) {
  if (clearLocal) await page.evaluate(() => Object.keys(localStorage).filter(k => /^kpos\.mock\.nt\./.test(k)).forEach(k => localStorage.removeItem(k))); // "another device": no local copy
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
}

test('owner replies to a cashier\'s notice → quoted private message to that cashier; marked "dibalas" on every device; her answer comes back in the chat', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await addNotice(page, { act_id: 'ACV38SITI', user: 'Siti', role: 'kasir', ref: 'owner,manager', summary: 'Permintaan batal faktur KM261012-AB123 Rp 50.000 oleh Siti: salah input' });
  await reopen(page);
  await page.waitForFunction(() => ntServerOpen().some(a => a.act_id === 'ACV38SITI'));
  const before = await settledBell(page);
  await page.click('#tb-bell');
  const row = page.locator('#bell-srv [data-nt-row="a:ACV38SITI"]');
  await expect(row).toContainText('Permintaan batal faktur KM261012-AB123');
  await expect(row.locator('[data-act="nt-reply"]')).toHaveText('↩ Balas');
  await expect(row.locator('[data-act="nt-close"]')).toHaveText('✕ Tutup');
  await row.locator('[data-act="nt-reply"]').click();
  const dlg = page.locator('#nt-reply');
  await expect(dlg.locator('#nt-to')).toHaveValue('Siti'); // the person who caused it
  await expect(dlg.locator('#nt-to')).toHaveAttribute('data-mode', 'actor');
  await expect(dlg.locator('#nt-quote')).toContainText('KM261012-AB123');
  await dlg.locator('#nt-send').click();
  await expect(dlg.locator('#nt-err')).toHaveText('Tulis pesannya dulu.');
  await dlg.locator('#nt-msg').fill('Salah input apa, Siti?');
  await dlg.locator('#nt-send').click();
  await expect(page.locator('#nt-reply')).toHaveCount(0);
  await expect(page.locator('.toast').last()).toContainText('Terkirim ke Siti');
  await expect(page.locator('#bell-srv [data-nt-row="a:ACV38SITI"]')).toHaveCount(0); // answered = handled
  expect(await bellN(page)).toBe(before - 1);
  // the cashier: the message in her private room with the owner, the notice quoted; she answers
  const sb = await chatAs(page, 'Siti', '1111', 'chat_bootstrap', {});
  const room = sb.team.find(t => t.name === 'Pemilik').channel;
  const sp = await chatAs(page, 'Siti', '1111', 'chat_poll', { cursors: { [room]: '' }, seen: {} });
  const msg = sp.messages[room].find(m => m.body === 'Salah input apa, Siti?');
  expect(msg.quote.text).toContain('KM261012-AB123');
  expect(msg.quote.no).toBe('KM261012-AB123');
  expect(msg.ref).toBe('a:ACV38SITI');
  expect((await chatAs(page, 'Siti', '1111', 'chat_send', { channel: room, body: 'Barang tertukar, Pak.', cid: 'v38-ans' })).ok).toBe(true);
  // privacy: nobody else
  expect(JSON.stringify(await chatAs(page, 'Jihan', '2222', 'chat_poll', { cursors: { [room]: '' }, seen: {} }))).not.toContain('Salah input apa');
  // the activity history keeps the row, marked "dibalas" — also after a reload without the local copy (server state)
  await page.locator('.modal-bg [data-act="modal-close"]').first().click();
  await reopen(page, true);
  await page.waitForFunction(() => ntHandled('a:ACV38SITI'));
  await page.click('#tb-act');
  const ar = page.locator('#act-list .act-row', { hasText: 'KM261012-AB123' });
  await expect(ar.locator('[data-nt-mark="r"]')).toContainText('dibalas');
  await expect(ar.locator('[data-nt-mark="r"]')).toContainText('Siti');
  await expect(ar.locator('[data-act="nt-close"]')).toHaveCount(0);
  // her answer is an ordinary chat message for the owner, under the quoted question
  await page.locator('.kchat-fab').click();
  await page.locator('.kchat-tab[data-ch="team"]').click();
  await page.locator('.kchat-member[data-name="Siti"]').click();
  await expect(page.locator('.kchat-msg.me .kchat-quote').last()).toContainText('KM261012-AB123');
  await expect(page.locator('.kchat-list')).toContainText('Barang tertukar, Pak.');
  await expect(page.locator('.kchat-list')).toContainText('cek harga minyak goreng'); // an old message (no quote) still renders
});

test('a system notice → the owner picks the person, the manager by default; Arabic labels', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await addNotice(page, { act_id: 'ACV38SYS', user: 'Sistem', role: 'system', ref: 'owner,manager', summary: 'Stok opname penuh TERLAMBAT 3 hari: jatuh tempo 2026-10-09' });
  await reopen(page);
  await page.waitForFunction(() => ntServerOpen().some(a => a.act_id === 'ACV38SYS'));
  await page.click('#tb-bell');
  await page.locator('#bell-srv [data-nt-row="a:ACV38SYS"] [data-act="nt-reply"]').click();
  const to = page.locator('#nt-reply #nt-to');
  await expect(to).toHaveValue('Jihan');
  await expect(to).toHaveAttribute('data-mode', 'pick');
  await expect(page.locator('#nt-to-hint')).toContainText('pilih orangnya');
  expect(await to.locator('option').allTextContents()).toEqual(expect.arrayContaining(['Jihan', 'Siti', 'Rina']));
  await page.locator('#nt-msg').fill('Tolong mulai hitung stok besok pagi.');
  await page.locator('#nt-send').click();
  await expect(page.locator('#nt-reply')).toHaveCount(0);
  const jb = await chatAs(page, 'Jihan', '2222', 'chat_bootstrap', {});
  const room = jb.team.find(t => t.name === 'Pemilik').channel;
  const jp = await chatAs(page, 'Jihan', '2222', 'chat_poll', { cursors: { [room]: '' }, seen: {} });
  expect(jp.unread[room]).toBe(1);
  expect(jp.messages[room].find(m => m.body === 'Tolong mulai hitung stok besok pagi.').quote.text).toContain('TERLAMBAT 3 hari');
  // Arabic
  await page.locator('.modal-bg [data-act="modal-close"]').first().click();
  await page.evaluate(() => setLang('ar'));
  await page.click('#tb-bell');
  await expect(page.locator('#bell-att [data-act="nt-reply"]').first()).toHaveText('↩ رد');
  await expect(page.locator('#bell-att [data-act="nt-close"]').first()).toHaveText('✕ إغلاق');
});

test('Tutup closes a notice with one tap: gone from the bell, the count drops, still in the history; it stays closed after a reload / on another device', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await addNotice(page, { act_id: 'ACV38CLS', user: 'Jihan', role: 'manager', ref: 'owner', summary: 'Manajer Jihan menyetujui pembatalan KM261012-ZZ999' });
  await reopen(page);
  await page.waitForFunction(() => ntServerOpen().some(a => a.act_id === 'ACV38CLS'));
  const before = await settledBell(page);
  await page.click('#tb-bell');
  await page.locator('#bell-srv [data-nt-row="a:ACV38CLS"] [data-act="nt-close"]').click(); // no confirmation
  await expect(page.locator('#bell-srv [data-nt-row="a:ACV38CLS"]')).toHaveCount(0);
  await expect(page.locator('.modal-bg')).toHaveCount(1);
  expect(await bellN(page)).toBe(before - 1);
  // a "Perlu perhatian" item closes the same way
  const att = page.locator('#bell-att .nt-wrap').first();
  const attId = await att.getAttribute('data-nt-row');
  await att.locator('[data-act="nt-close"]').click();
  await expect(page.locator(`#bell-att [data-nt-row="${attId}"]`)).toHaveCount(0);
  expect(await bellN(page)).toBe(before - 2);
  // server-side: the mock server holds the two closes; a reload with no local copy (= another device) keeps them closed
  await expect.poll(async () => (await getDb(page)).chat.filter(m => String(m.channel).startsWith('nt:')).map(m => m.ref).sort()).toEqual([attId, 'a:ACV38CLS'].sort());
  await page.locator('.modal-bg [data-act="modal-close"]').first().click();
  await reopen(page, true);
  await page.waitForFunction(() => ntHandled('a:ACV38CLS'));
  expect(await settledBell(page)).toBe(before - 2);
  await page.click('#tb-bell');
  await expect(page.locator('#bell-srv [data-nt-row="a:ACV38CLS"]')).toHaveCount(0);
  await expect(page.locator(`#bell-att [data-nt-row="${attId}"]`)).toHaveCount(0);
  await page.locator('.modal-bg [data-act="modal-close"]').first().click();
  // the full history still lists it, marked closed
  await page.click('#tb-act');
  const ar = page.locator('#act-list .act-row', { hasText: 'KM261012-ZZ999' });
  await expect(ar).toHaveCount(1);
  await expect(ar.locator('[data-nt-mark="c"]')).toContainText('ditutup');
});

test('invoice-change rows: Balas goes to who asked for the change; Tutup takes it off the "Faktur diubah" count', async ({ page }) => {
  await openApp(page);
  await editDb(page, `db.settings.require_purchase_photo = false;`);
  const db = await getDb(page);
  const p1 = db.products[0];
  const sp = await asUser(page, 'Siti', '1111', 'save_purchase', { supplier: 'PT Sumber Rejeki', purchase_date: jktToday(), carrier: { type: 'pemasok', name: 'Sopir' }, items: [{ product_id: p1.id, qty: 10, cost_price: 20000, exp_date: '2027-06-01' }] });
  const rq = await asUser(page, 'Siti', '1111', 'request_purchase_fix', { purchase_no: sp.purchase_no, reason: 'salah hitung', lines: [{ product_id: p1.id, qty: 8 }] });
  expect((await asUser(page, 'Jihan', '2222', 'decide_approval', { request_id: rq.request_id, decision: 'approved', purchase_no: sp.purchase_no })).error).toBeUndefined();
  const rec = (await getDb(page)).activity.find(a => a.kind === 'ubah_faktur' && a.ref === sp.purchase_no);
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.waitForFunction(() => ATT.items.some(x => x.key === 'invchg'));
  await page.evaluate(() => go('invchg'));
  const tr = page.locator(`#ic-table tr[data-chg="${rec.act_id}"]`);
  await expect(tr.locator('[data-act="nt-reply"]')).toBeVisible();
  await tr.locator('[data-act="nt-reply"]').click();
  await expect(page.locator('#nt-to')).toHaveValue('Siti'); // she asked for it (Jihan approved)
  await expect(page.locator('#nt-quote')).toContainText(sp.purchase_no);
  await page.locator('[data-act="modal-close"]').last().click();
  await tr.locator('[data-act="nt-close"]').click();
  await expect(tr.locator('[data-nt-mark="c"]')).toContainText('ditutup');
  await expect(tr.locator('[data-act="nt-close"]')).toHaveCount(0);
  expect(await page.evaluate(() => invChgUnread().length)).toBe(0);
});

test('the manager gets Balas / Tutup on the notices addressed to him (owner app)', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await addNotice(page, { act_id: 'ACV38MGR', user: 'Siti', role: 'kasir', ref: 'owner,manager', summary: 'Selisih penerimaan barang PB-261012-0007 oleh Siti' });
  await reopen(page);
  await page.waitForFunction(() => ntServerOpen().some(a => a.act_id === 'ACV38MGR'));
  await page.click('#tb-bell');
  await page.locator('#bell-srv [data-nt-row="a:ACV38MGR"] [data-act="nt-reply"]').click();
  await expect(page.locator('#nt-to')).toHaveValue('Siti');
  await expect(page.locator('#nt-quote')).toContainText('PB-261012-0007');
  await page.locator('#nt-msg').fill('Cek lagi notanya ya.');
  await page.locator('#nt-send').click();
  await expect(page.locator('#bell-srv [data-nt-row="a:ACV38MGR"]')).toHaveCount(0);
  const sb = await chatAs(page, 'Siti', '1111', 'chat_bootstrap', {});
  const room = sb.team.find(t => t.name === 'Jihan').channel;
  const sp = await chatAs(page, 'Siti', '1111', 'chat_poll', { cursors: { [room]: '' }, seen: {} });
  expect(sp.messages[room].find(m => m.body === 'Cek lagi notanya ya.').quote.no).toBe('PB-261012-0007');
});
