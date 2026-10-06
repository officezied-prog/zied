// v16 members: badge "Member · pembelian ke-N · diskon X%", the member discount as its own line (tier of visits + 1),
// a member registered at the counter, and the receipt sent by WhatsApp / e-mail (wa.me, mailto).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
const jkt = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

test('member badge + automatic member discount; receipt to WhatsApp and e-mail; walk-in number typed', async ({ page }) => {
  await H.openKasir(page);
  await H.setDb(page, `const c = db.customers.find(x => x.name === 'Ibu Fatimah'); Object.assign(c, { member: true, member_no: 'M7KQ2PX', member_since: '2026-01-02', visits: 4, email: 'fatimah@contoh.id' });`);
  await H.login(page, 'Siti', '1111', { noGoto: true });
  await H.addItem(page, 'ajwa'); // 175.000
  await H.pay(page);
  await page.click('#pay-cust');
  await expect(page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).locator('[data-member]')).toHaveText('Member');
  await expect(page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' })).toContainText('M7KQ2PX');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Ibu Fatimah' }).click();
  // 5th purchase → tier "from 5" → 3 %; the limit becomes 3 % + 3 %
  await expect(page.locator('#member-badge')).toContainText('Member · pembelian ke-5 · diskon 3%');
  await expect(page.locator('#member-badge')).toContainText('M7KQ2PX');
  await expect(page.locator('#pay-mdisc')).toContainText('Diskon member 3%');
  await expect(page.locator('#pay-mdisc')).toContainText(H.rp(5250));
  await expect(page.locator('#pay-disc-pct')).toHaveText('Diskon 3% (batas 6%)');
  await expect(page.locator('#pay-total')).toHaveText(H.rp(169750));
  await page.fill('#pay-disc', '5000'); // + 2,9 % on top: 5,9 % ≤ 6 %
  await expect(page.locator('#pay-disc-pct')).toHaveText('Diskon 5,9% (batas 6%)');
  await expect(page.locator('#pay-ok')).toHaveText('SELESAI');
  await H.shot(page, 'phone-43-member-badge', false, { noToasts: true });
  await page.click('#pay-ok');
  const rc = page.locator('#rc-modal');
  await expect(rc.locator('#receipt')).toBeVisible();
  await expect(rc.locator('#rc-mdisc')).toContainText('Diskon member 3%');
  await expect(rc.locator('#rc-member')).toHaveText('Member M7KQ2PX · pembelian ke-5');
  const wa = await rc.locator('#rcs-wa').getAttribute('href');
  expect(wa).toMatch(/^https:\/\/wa\.me\/6281244445566\?text=/);
  const text = decodeURIComponent(wa.split('?text=')[1]);
  for (const s of ['Khair Mart', 'Kurma Ajwa Al-Madinah 1 kg', 'Subtotal: Rp 175.000', 'Diskon member 3%: -Rp 5.250', 'Diskon: -Rp 5.000', 'Total: Rp 164.750', 'Bayar (Tunai): Rp 164.750', 'Member M7KQ2PX · pembelian ke-5', 'Terima kasih']) expect(text).toContain(s);
  expect(text).not.toMatch(/\*/);
  const mail = await rc.locator('#rcs-mail').getAttribute('href');
  const db = await H.getDb(page);
  const sale = db.sales[db.sales.length - 1];
  expect(mail.startsWith(`mailto:fatimah@contoh.id?subject=${encodeURIComponent('Struk Khair Mart ' + sale.invoice_no)}&body=`)).toBe(true);
  expect(decodeURIComponent(mail.split('&body=')[1])).toBe(text);
  await H.shot(page, 'phone-44-receipt-send', false, { noToasts: true });
  expect(sale).toMatchObject({ discount: 10250, total: 164750, customer_name: 'Ibu Fatimah' });
  expect(sale.notes).toContain('[member 3% · pembelian ke-5]');
  expect(sale.notes).not.toContain('disetujui'); // within member + 3 %
  expect(db.customers.find(c => c.name === 'Ibu Fatimah')).toMatchObject({ visits: 5, last_visit: jkt() });

  // walk-in: no customer → type the number (08… → 628…), no e-mail button
  await page.click('#rc-new');
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-ok');
  await expect(rc.locator('#rcs-wa')).toHaveAttribute('aria-disabled', 'true');
  await expect(rc.locator('#rcs-mail')).toHaveCount(0);
  await rc.locator('#rcs-phone').fill('0812 9876 5432');
  await expect(rc.locator('#rcs-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/6281298765432\?text=/);
});

test('register a member at the counter (name, phone, e-mail, consent); a kasir cannot end a membership', async ({ page }) => {
  await H.login(page);
  await H.tab(page, 'more');
  await page.click('#m-member');
  await expect(page.locator('#cn-member')).toBeChecked();
  await expect(page.locator('#cn-member-l')).toContainText('struk & promo (UU PDP)');
  await page.fill('#cn-name', 'Bu Salma');
  await page.fill('#cn-phone', '0813 1111 9999');
  await page.fill('#cn-email', 'salma@contoh');
  await page.click('#cp-save');
  await expect(page.locator('#cp-err')).toContainText('e-mail tidak valid');
  await page.fill('#cn-email', 'Salma@Contoh.ID');
  await page.click('#cp-save');
  await expect(page.locator('.toast.ok', { hasText: 'Member tersimpan M' })).toHaveCount(1);
  const db = await H.getDb(page);
  const c = db.customers.find(x => x.name === 'Bu Salma');
  expect(c).toMatchObject({ member: true, email: 'salma@contoh.id', phone: '6281311119999', visits: 0, member_since: jkt() });
  expect(c.member_no).toMatch(/^M[A-Z0-9]{6}$/);
  expect(db.activity.find(a => a.kind === 'member_baru' && a.ref === c.member_no)).toMatchObject({ user: 'Siti', level: 'info' });
  const r = await page.evaluate(async id => { try { await api('save_customer', { id, member: false }); return 'ok'; } catch (e) { return e.code; } }, c.id);
  expect(r).toBe('FORBIDDEN');
  // first purchase as a member: 0 %; the badge still says which purchase it is
  await H.tab(page, 'sell');
  await H.addItem(page, 'tasbih');
  await H.pay(page);
  await page.click('#pay-cust');
  await page.fill('#cp-q', 'salma');
  await page.locator('#cp-list [data-pick]').filter({ hasText: 'Bu Salma' }).click();
  await expect(page.locator('#member-badge')).toContainText('pembelian ke-1 · diskon 0%');
  await expect(page.locator('#pay-mdisc')).toHaveCount(0);
});
