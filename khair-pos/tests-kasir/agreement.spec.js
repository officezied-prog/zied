// Owner decisions (07 Oct): the return limit (return_owner_min_value / _qty, default Rp 2,000,000) changes only by agreement —
// one of owner / manager proposes (propose_agreement), the OTHER confirms in the inbox (approval kind "kesepakatan").
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);
const call = (page, action, data) => page.evaluate(async ([a, d]) => { try { return await api(a, d); } catch (e) { return { error: e.code, message: e.message }; } }, [action, data]);

test('manager proposes, not in her own inbox; the owner confirms; settings + history; save_settings refuses; owner proposal → manager confirms', async ({ page, context }) => {
  await H.login(page, 'Jihan', '2222');
  expect((await H.getDb(page)).settings.return_owner_min_value ?? 2000000).toBe(2000000);
  const r = await call(page, 'propose_agreement', { key: 'return_owner_min_value', value: 1500000, note: 'Retur kurma sering kecil' });
  expect(r.approval).toMatchObject({ kind: 'kesepakatan', approver_role: 'owner', ref: 'return_owner_min_value', total: 1500000, can_decide: false });
  expect(await call(page, 'propose_agreement', { key: 'max_discount_pct', value: 9 })).toEqual({ error: 'INVALID', message: 'Batas tidak dikenal' });
  await page.click('#tb-appr');
  await expect(page.locator(`.apr-card[data-req="${r.request_id}"]`)).toHaveCount(0); // her own proposal waits for the owner
  expect(await call(page, 'decide_approval', { request_id: r.request_id, decision: 'approved' })).toMatchObject({ error: 'NEEDS_OWNER' });
  await H.closeModals(page);

  const p2 = await H.otherPhone(context);
  await H.login(p2, 'Pemilik', '1234');
  await p2.click('#tb-appr');
  const card = p2.locator(`.apr-card[data-req="${r.request_id}"]`);
  await expect(card).toHaveAttribute('data-kind', 'kesepakatan');
  await expect(card).toContainText('Kesepakatan batas retur');
  await expect(card.locator('[data-agree-values]')).toContainText(H.rp(2000000));
  await expect(card.locator('[data-agree-values]')).toContainText(H.rp(1500000));
  await expect(card).toContainText('Diusulkan oleh Jihan — “Retur kurma sering kecil”');
  await H.shot(p2, 'phone-61-agreement-card', false, { noToasts: true });
  await card.locator('[data-d="approved"]').filter({ hasText: 'Konfirmasi' }).click();
  await expect(card).toHaveCount(0);
  let db = await H.getDb(p2);
  expect(db.settings.return_owner_min_value).toBe(1500000);
  expect(db.settings.limit_agreements[0]).toMatchObject({ key: 'return_owner_min_value', value: 1500000, from: 2000000, proposed_by: 'Jihan', confirmed_by: 'Pemilik', note: 'Retur kurma sering kecil' });
  expect(db.activity.find(a => a.kind === 'usul_kesepakatan' && a.ref === r.request_id)).toMatchObject({ user: 'Jihan' });
  expect(db.activity.find(a => a.kind === 'kesepakatan' && a.ref === r.request_id)).toMatchObject({ user: 'Pemilik', level: 'warn' });
  // the limit cannot be changed alone
  expect(await call(p2, 'save_settings', { settings: { return_owner_min_value: 500000 } })).toMatchObject({ error: 'AGREEMENT_REQUIRED' });
  expect(await call(p2, 'save_settings', { settings: { return_owner_min_value: 1500000, report_time: '20:30' } })).toMatchObject({ ok: true });

  // the owner proposes the quantity limit: he cannot confirm it himself; the manager does
  const r2 = await call(p2, 'propose_agreement', { key: 'return_owner_min_qty', value: 30 });
  expect(r2.approval).toMatchObject({ approver_role: 'manager' });
  expect(await call(p2, 'decide_approval', { request_id: r2.request_id, decision: 'approved' })).toMatchObject({ error: 'FORBIDDEN', message: 'Kesepakatan harus dikonfirmasi pihak lain' });
  await page.click('#tb-appr');
  const c2 = page.locator(`.apr-card[data-req="${r2.request_id}"]`);
  await expect(c2.locator('[data-agree-values]')).toContainText('30 barang');
  await c2.locator('[data-d="rejected"]').click();
  await expect(c2).toHaveCount(0);
  db = await H.getDb(page);
  expect(db.settings.return_owner_min_qty || 0).toBe(0);
  expect(db.approvals.find(a => a.request_id === r2.request_id).status).toBe('rejected');
  // a kasir may not propose
  const p3 = await H.otherPhone(context);
  await H.login(p3, 'Siti', '1111');
  expect(await call(p3, 'propose_agreement', { key: 'return_owner_min_qty', value: 5 })).toEqual({ error: 'FORBIDDEN', message: 'Hanya pemilik atau manajer' });
});
