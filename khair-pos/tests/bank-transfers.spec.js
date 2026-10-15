// v57 (owner 2026-10-15: «في عملية التحويلات إمكانية اختيار كتابة التحويل لأي بنك تمت مع أن المدير يقوم بإدخال بيانات كل بنك وعند المحاسب عندما يقوم
// بعملية المراجعة أو تصنيف التحويلات فتتم حسب بنك»): the manager keeps the bank accounts; Rekening → "Transfer per rekening" files every
// transfer by store account, and the accountant files the open ones.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { SHOTS, jktToday, login, openApp, enterKey, getDb, nav, editDb, staffSession, switchUser } = require('./helpers');

const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function loginAkuntan(page) {
  await openApp(page);
  const hash = await page.evaluate(() => KPOS.pinHash('demo', 'Lestari', '5555'));
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg, active: true });`, hash);
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
  await enterKey(page);
  await staffSession(page, 'Lestari', '5555');
  await expect(page.locator('#app')).toBeVisible();
  // the demo's data is seeded at the first login: then Mandiri is made active too (two store accounts)
  await editDb(page, `db.settings.bank_accounts.forEach(a => { a.active = true; });`);
  await page.reload();
  await expect(page.locator('#app')).toBeVisible();
  await expect.poll(() => page.evaluate(() => settings().bank_accounts.filter(a => a.active !== false).length)).toBe(2);
}
/** The transfers of the last 30 days as the page lists them (sales by their transfer part, payments by method transfer). */
function transfers(db) {
  const T = jktToday(), from = addDays(T, -29), out = [];
  const trPart = s => { if (s.payment_method === 'campur') { try { return JSON.parse(s.pay_parts || '[]').filter(p => p.m === 'transfer').reduce((a, p) => a + p.a, 0); } catch (e) { return 0; } } return s.payment_method === 'transfer' ? Math.min(s.paid_amount, s.total) : 0; };
  db.sales.forEach(s => { if (s.status !== 'void' && s.sale_date >= from && s.sale_date <= T && trPart(s) > 0) out.push({ key: 'sale:' + s.invoice_no, acc: s.account_id || '' }); });
  db.payments.forEach(p => { if (p.method === 'transfer' && p.pay_date >= from && p.pay_date <= T) out.push({ key: 'payment:' + p.pay_id, acc: p.account_id || '' }); });
  return out;
}

test('the manager keeps the bank accounts (save_bank_accounts): Mandiri active again; the owner and the accountant are told', async ({ page }) => {
  await login(page, 'Jihan', '2222');
  await nav(page, 'settings');
  const mandiri = page.locator('#st-bank-rows .st-bank-row[data-acc="BA2"]');
  await expect(mandiri.locator('[data-k="active"]')).not.toBeChecked();
  await mandiri.locator('[data-k="active"]').check();
  await page.click('[data-act="set-save-bank"]');
  await expect(page.locator('.toast.ok')).toBeVisible();
  const db = await getDb(page);
  expect(db.settings.bank_accounts.find(a => a.id === 'BA2').active).toBe(true);
  const n = db.activity.filter(a => a.kind === 'notifikasi').pop();
  expect(n.ref).toBe('owner,akuntan');
  expect(n.summary).toBe('Rekening bank toko diubah: Mandiri 1560009876543 a.n. Khair Mart aktif lagi — oleh manajer Jihan');
  // a row deleted is kept, inactive
  await page.locator('#st-bank-rows .st-bank-row[data-acc="BA2"] [data-act="st-bank-del"]').click();
  await page.click('[data-act="set-save-bank"]');
  await expect.poll(async () => (await getDb(page)).settings.bank_accounts.map(a => [a.id, a.active !== false])).toEqual([['BA1', true], ['BA2', false]]);
});

test('the accountant: transfers per store account, the open ones in their own card; a tap files one; the owner sees it without filing', async ({ page }) => {
  await loginAkuntan(page);
  await nav(page, 'bank');
  await page.click('[data-act="bk-tab"][data-tab="transfers"]');
  await expect(page.locator('#bt-kpis')).toBeVisible();
  let db = await getDb(page);
  const all = transfers(db), open = all.filter(x => !['BA1', 'BA2'].includes(x.acc));
  expect(open.length).toBeGreaterThan(0);
  await expect(page.locator('#bt-rows .li')).toHaveCount(all.length);
  await expect(page.locator('[data-kpi="bt-_none"] .s')).toContainText(`${open.length} transfer`);
  await expect(page.locator('[data-kpi="bt-BA1"] .s')).toContainText(`${all.filter(x => x.acc === 'BA1').length} transfer`);
  // the open card filters; file the first one under Mandiri
  await page.click('[data-kpi="bt-_none"]');
  await expect(page.locator('#bt-rows .li')).toHaveCount(open.length);
  await page.screenshot({ path: path.join(SHOTS, 'bank-transfers.png') });
  const first = page.locator('#bt-rows .li').first(), key = await first.getAttribute('data-bt');
  await first.locator('select').selectOption('BA2');
  await expect(page.locator('.toast.ok', { hasText: 'Dicatat ke Mandiri 1560009876543' })).toBeVisible();
  await expect(page.locator('#bt-rows .li')).toHaveCount(open.length - 1); // it left the open card
  db = await getDb(page);
  const [kind, ref] = key.split(/:(.*)/s);
  expect(kind === 'sale' ? db.sales.find(s => s.invoice_no === ref).account_id : db.payments.find(p => p.pay_id === ref).account_id).toBe('BA2');
  expect(db.activity.filter(a => a.kind === 'atur_bank').pop().summary).toContain('ke Mandiri 1560009876543 — oleh akuntan Lestari');
  // the Mandiri card now has it
  await page.click('[data-kpi="bt-BA2"]');
  await expect(page.locator(`#bt-rows .li[data-bt="${key}"]`)).toHaveAttribute('data-acc', 'BA2');
  // search + direction
  await page.click('[data-kpi="bt-BA2"]'); // off again
  await page.click('[data-act="bt-dir"][data-d="out"]');
  for (const d of await page.locator('#bt-rows .li').evaluateAll(xs => xs.map(x => x.dataset.dir))) expect(d).toBe('out');
  // the owner monitors: the same list, no filing
  await switchUser(page, 'Pemilik', '1234');
  await nav(page, 'bank');
  await page.click('[data-act="bk-tab"][data-tab="transfers"]');
  await expect(page.locator('#bt-rows .li').first()).toBeVisible();
  await expect(page.locator('#bt-rows select')).toHaveCount(0);
});

test('Arabic: the transfers tab reads in Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await page.evaluate(() => setLang('ar'));
  await nav(page, 'bank');
  await expect(page.locator('[data-act="bk-tab"][data-tab="transfers"]')).toHaveText('التحويلات حسب الحساب');
  await page.click('[data-act="bk-tab"][data-tab="transfers"]');
  await expect(page.locator('#bt-hint')).toContainText('حسب حساب المتجر');
  await expect(page.locator('#bt-dirs')).toContainText('داخل');
  // the demo has one active account (BCA): every transfer not filed yet is BCA's, there is no open card
  await expect(page.locator('[data-kpi="bt-_none"]')).toHaveCount(0);
  const n = transfers(await getDb(page)).filter(x => x.acc !== 'BA2').length;
  await expect(page.locator('[data-kpi="bt-BA1"] .s')).toContainText(`${n} تحويل`);
});
