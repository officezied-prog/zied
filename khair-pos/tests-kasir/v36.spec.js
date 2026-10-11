// v36 (owner 2026-10-11) in Khair Kasir (mock backend = same rules as backend/process.js):
//  «إصلاح فاتورة قديمة لا يتم إلا بموافقتي الشخصية» — the manager's inbox shows a void of an EARLIER day's sale locked to the owner;
//  today's void stays hers (or the accountant's). «إشعار فتح الصندوق للمدير والمحاسب» — the opening goes to both (mgr_akuntan).
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

const call = (page, action, data) => page.evaluate(async ([a, d]) => { try { return await api(a, d); } catch (e) { return { error: e.code, message: e.message }; } }, [action, data]);
const jkToday = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);

test('manager inbox: an old invoice\'s void is locked to the owner; today\'s she approves — but never her own request', async ({ page }) => {
  await H.login(page, 'Jihan', '2222');
  const db = await H.getDb(page);
  const old = db.sales.filter(s => s.sale_date < jkToday() && s.status !== 'void')[0];
  const r1 = await call(page, 'request_void', { invoice_no: old.invoice_no, reason: 'salah harga' });
  expect(r1).toMatchObject({ approver_role: 'owner', old_invoice: true });
  expect(r1.approval.can_decide).toBe(false);
  const p = db.products.find(x => x.active !== false && x.stock > 3 && (x.shop_stock === undefined || x.shop_stock > 3));
  const s = await call(page, 'save_sale', { client_id: 'k36-v', sale_date: jkToday(), items: [{ product_id: p.id, qty: 1, unit_price: p.retail_price }], payment_method: 'tunai', paid_amount: p.retail_price });
  const r2 = await call(page, 'request_void', { invoice_no: s.invoice_no, reason: 'dobel' });
  expect(r2).toMatchObject({ approver_role: 'mgr_akuntan', old_invoice: false });
  expect(r2.approval.can_decide).toBe(false); // her own request: the accountant (or the owner) decides
  expect(await call(page, 'decide_approval', { request_id: r2.request_id, decision: 'approved', invoice_no: s.invoice_no })).toMatchObject({ error: 'FORBIDDEN' });
  // a cashier's request for a today's invoice: hers to decide
  const p2 = db.products.filter(x => x.active !== false && x.stock > 3 && (x.shop_stock === undefined || x.shop_stock > 3))[1];
  const s2 = await call(page, 'save_sale', { client_id: 'k36-v2', sale_date: jkToday(), items: [{ product_id: p2.id, qty: 1, unit_price: p2.retail_price }], payment_method: 'tunai', paid_amount: p2.retail_price });
  await H.setDb(page, `db.approvals.push({ request_id: 'APR-K36', client_id: '', created_at: new Date().toISOString(), cashier: 'Siti', customer_id: 0, customer_name: 'Umum', customer_debt_before: 0, total: 1, debt_amount: 0, summary: arg + ' · today', status: 'pending', decided_by: '', decided_at: '', note: '', kind: 'void', ref: arg, payload: JSON.stringify({ reason: 'salah', invoice_no: arg, sale_date: new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10) }), approver_role: 'mgr_akuntan' });`, s2.invoice_no);
  await page.click('#tb-appr');
  const c1 = page.locator(`.apr-card[data-req="${r1.request_id}"]`);
  await expect(c1.locator('[data-old-invoice]')).toContainText('Nota lama');
  await expect(c1.locator('[data-owner-only]')).toBeVisible();
  expect(await call(page, 'decide_approval', { request_id: r1.request_id, decision: 'approved', invoice_no: old.invoice_no })).toMatchObject({ error: 'NEEDS_OWNER' });
  const own = page.locator(`.apr-card[data-req="${r2.request_id}"]`);
  await expect(own.locator('[data-owner-only]')).toContainText('Permintaan Anda');
  await expect(own.locator('[data-d="approved"]')).toBeDisabled();
  const c2 = page.locator('.apr-card[data-req="APR-K36"]');
  await expect(c2.locator('[data-old-invoice]')).toHaveCount(0);
  await c2.locator('[data-d="approved"]').click();
  await expect(c2).toHaveCount(0);
  expect((await H.getDb(page)).sales.find(x => x.invoice_no === s2.invoice_no).status).toBe('void');
  expect((await H.getDb(page)).sales.find(x => x.invoice_no === s.invoice_no).status).not.toBe('void');
  expect((await H.getDb(page)).sales.find(x => x.invoice_no === old.invoice_no).status).not.toBe('void');
});
