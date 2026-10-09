// Owner monitoring (v?): the OWNER's Absensi screen is monitoring-only — summaries (today + dated report with
// wages and wage-due) plus setting wages (owner-exclusive), but NO operational controls (kiosk, add worker,
// edit/enroll/forget faces). The MANAGER's screen is unchanged (full operational controls, no wages).
// Workers are seeded by the attendance mock: Budi Santoso 120000, Slamet Riyadi 110000, Rahmat Hidayat 130000.
const { test, expect } = require('@playwright/test');
const { login, getDb, nav } = require('./helpers');

test.use({ geolocation: { latitude: -6.27630, longitude: 106.85770 }, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'] });

test('owner: monitoring only — summaries + set wage, no operational controls', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'absensi');
  await expect(page.locator('#att-w-tbl tbody tr')).toHaveCount(3);

  // operational controls are hidden for the owner
  await expect(page.locator('#att-kiosk')).toHaveCount(0);
  await expect(page.locator('#att-add')).toHaveCount(0);
  await expect(page.locator('#att-w-tbl [data-act="att-edit"]')).toHaveCount(0);
  await expect(page.locator('#att-w-tbl [data-act="att-enroll"]')).toHaveCount(0);
  // forget-face stays owner-exclusive (sensitive biometric deletion) — the owner keeps it in monitoring mode; the manager still cannot
  await expect(page.locator('#att-w-tbl [data-act="att-forget"]')).toHaveCount(3);

  // but the monitoring summaries are all there, with wages
  await expect(page.locator('#att-w-tbl [data-wage]')).toHaveCount(3);
  await expect(page.locator('#att-w-tbl tr').filter({ hasText: 'Budi Santoso' }).locator('[data-wage]')).toHaveText('Rp 120.000');
  await expect(page.locator('#att-today #att-k-in')).toBeVisible();
  await expect(page.locator('#att-w-tbl [data-act="att-wage"]')).toHaveCount(3);

  // the dated report keeps the wage + wage-due columns for the owner
  await page.click('[data-act="att-preset"][data-p="7d"]');
  await expect(page.locator('#att-verify')).toHaveAttribute('data-ok', '1');
  await expect(page.locator('#att-tot [data-due]')).toHaveCount(3);
  await expect(page.locator('#att-wage-total')).toBeVisible();

  // setting a wage via the owner's wage control persists
  await page.locator('#att-w-tbl tr').filter({ hasText: 'Budi Santoso' }).locator('[data-act="att-wage"]').click();
  await expect(page.locator('#att-wage-editor')).toBeVisible();
  await page.fill('#att-wage-editor #aw-wage', '150.000');
  await page.click('#att-wage-editor #aw-save');
  await expect(page.locator('.toast.ok')).toBeVisible();
  await expect(page.locator('#att-wage-editor')).toHaveCount(0);
  await expect(page.locator('#att-w-tbl tr').filter({ hasText: 'Budi Santoso' }).locator('[data-wage]')).toHaveText('Rp 150.000');
  const db = await getDb(page);
  expect(db.att.workers.find(w => w.name === 'Budi Santoso').daily_wage).toBe(150000);
});

test('manager: operational controls unchanged — kiosk, add, edit, enroll; no wage control', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true });
  await nav(page, 'absensi');
  await expect(page.locator('#att-w-tbl tbody tr')).toHaveCount(3);
  await expect(page.locator('#att-kiosk')).toBeVisible();
  await expect(page.locator('#att-add')).toBeVisible();
  await expect(page.locator('#att-w-tbl [data-act="att-edit"]')).toHaveCount(3);
  await expect(page.locator('#att-w-tbl [data-act="att-enroll"]')).toHaveCount(3);
  // the manager never sees wages or the owner-only wage control
  await expect(page.locator('#att-w-tbl [data-act="att-wage"]')).toHaveCount(0);
  await expect(page.locator('#att-w-tbl [data-wage]')).toHaveCount(0);
});
