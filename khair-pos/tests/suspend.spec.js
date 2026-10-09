// v28 — account SUSPEND / RE-ENABLE (set_account_active).
// Owner + manager may SUSPEND any non-owner (never their own account; the manager never the owner). Only the OWNER
// re-enables. A suspended account cannot log in. UI: Suspend / Re-enable controls wired to set_account_active.
const { test, expect } = require('@playwright/test');
const { login, nav, getDb, staffSession, asUser, editDb } = require('./helpers');

test('owner suspends and re-enables a staff account from Settings (badge + owner-only re-enable)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  await nav(page, 'settings');

  const siti = page.locator('#st-users tr[data-user="Siti"]');
  await expect(siti.locator('[data-act="user-suspend"]')).toBeVisible();
  await expect(siti.locator('[data-suspended]')).toHaveCount(0);
  await expect(siti.locator('[data-act="user-reenable"]')).toHaveCount(0);
  // the owner never has a Suspend control on their own account
  await expect(page.locator('#st-users tr[data-user="Pemilik"] [data-act="user-suspend"]')).toHaveCount(0);

  // suspend Siti → confirm
  await siti.locator('[data-act="user-suspend"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('.toast.ok')).toBeVisible();
  const siti2 = page.locator('#st-users tr[data-user="Siti"]');
  await expect(siti2.locator('[data-suspended]')).toBeVisible();
  await expect(siti2.locator('[data-act="user-reenable"]')).toBeVisible();   // owner sees re-enable
  await expect(siti2.locator('[data-act="user-suspend"]')).toHaveCount(0);
  let db = await getDb(page);
  expect(db.users.find(u => u.name === 'Siti').active).toBe(false);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'akun_nonaktif', level: 'warn' });

  // re-enable (owner only) → badge gone, active again
  await siti2.locator('[data-act="user-reenable"]').click();
  await expect(page.locator('#st-users tr[data-user="Siti"] [data-suspended]')).toHaveCount(0);
  await expect(page.locator('#st-users tr[data-user="Siti"] [data-act="user-suspend"]')).toBeVisible();
  db = await getDb(page);
  expect(db.users.find(u => u.name === 'Siti').active).not.toBe(false);
  expect(db.activity.slice(-1)[0]).toMatchObject({ kind: 'akun_aktif', level: 'warn' });
});

test('manager suspends any non-owner from Settings; re-enable control is owner-only (absent for the manager)', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  // add an accountant and a second manager to the shop
  const [lest, nadia] = await page.evaluate(async () => [await KPOS.pinHash('demo', 'Lestari', '5555'), await KPOS.pinHash('demo', 'Nadia', '2223')]);
  await editDb(page, `db.users.push({ name: 'Lestari', role: 'akuntan', pin_hash: arg[0], active: true });
    db.users.push({ name: 'Nadia', role: 'manager', pin_hash: arg[1], active: true });`, [lest, nadia]);

  // become the manager (session hand-off from Khair Kasir), open Settings
  await staffSession(page, 'Jihan', '2222');
  await expect(page.locator('#app')).toBeVisible();
  await nav(page, 'settings');

  // the owner group is hidden from the manager; the non-owner groups are visible so any can be suspended
  await expect(page.locator('#st-users [data-role-group="owner"]')).toHaveCount(0);
  await expect(page.locator('#st-users [data-role-group="akuntan"] tr[data-user="Lestari"]')).toBeVisible();
  await expect(page.locator('#st-users [data-role-group="manager"] tr[data-user="Nadia"]')).toBeVisible();
  // the manager never edits (role/swap/PIN) a non-kasir/sales account, and never suspends its own account
  await expect(page.locator('#st-users tr[data-user="Lestari"] [data-user-role]')).toHaveCount(0);
  await expect(page.locator('#st-users tr[data-user="Jihan"] [data-act="user-suspend"]')).toHaveCount(0);

  // manager suspends the accountant
  await page.locator('#st-users tr[data-user="Lestari"] [data-act="user-suspend"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('#st-users tr[data-user="Lestari"] [data-suspended]')).toBeVisible();
  // the manager has NO re-enable control for a suspended account (owner only)
  await expect(page.locator('#st-users tr[data-user="Lestari"] [data-act="user-reenable"]')).toHaveCount(0);
  let db = await getDb(page);
  expect(db.users.find(u => u.name === 'Lestari').active).toBe(false);

  // manager suspends another manager
  await page.locator('#st-users tr[data-user="Nadia"] [data-act="user-suspend"]').click();
  await page.click('#cf-ok');
  await expect(page.locator('#st-users tr[data-user="Nadia"] [data-suspended]')).toBeVisible();
  db = await getDb(page);
  expect(db.users.find(u => u.name === 'Nadia').active).toBe(false);

  // the manager cannot re-enable through the API either
  expect(await asUser(page, 'Jihan', '2222', 'set_account_active', { name: 'Lestari', active: true })).toMatchObject({ error: 'FORBIDDEN' });
});

test('set_account_active gates: manager cannot suspend the owner; kasir/self refused; suspended cannot authenticate', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });

  // a manager may not suspend the owner
  expect(await asUser(page, 'Jihan', '2222', 'set_account_active', { name: 'Pemilik', active: false })).toMatchObject({ error: 'FORBIDDEN' });
  // a kasir may not call it at all
  expect(await asUser(page, 'Siti', '1111', 'set_account_active', { name: 'Rina', active: false })).toMatchObject({ error: 'FORBIDDEN' });
  // no one suspends their own account (owner and manager)
  expect(await asUser(page, 'Pemilik', '1234', 'set_account_active', { name: 'Pemilik', active: false })).toMatchObject({ error: 'FORBIDDEN' });
  expect(await asUser(page, 'Jihan', '2222', 'set_account_active', { name: 'Jihan', active: false })).toMatchObject({ error: 'FORBIDDEN' });

  // owner suspends a kasir → that account can no longer authenticate (login or any action)
  expect(await asUser(page, 'Pemilik', '1234', 'set_account_active', { name: 'Rina', active: false })).toMatchObject({ user: { active: false } });
  expect(await asUser(page, 'Rina', '3333', 'login')).toMatchObject({ error: 'BAD_PIN' });
  expect(await asUser(page, 'Rina', '3333', 'bootstrap')).toMatchObject({ error: 'BAD_PIN' });

  // a manager cannot re-enable a suspended account through save_user either (owner-only there too)
  expect(await asUser(page, 'Jihan', '2222', 'save_user', { name: 'Rina', role: 'kasir', active: true })).toMatchObject({ error: 'FORBIDDEN' });

  // the owner re-enables it → active again
  expect(await asUser(page, 'Pemilik', '1234', 'set_account_active', { name: 'Rina', active: true })).toMatchObject({ user: { active: true } });
  expect(await asUser(page, 'Rina', '3333', 'login')).toMatchObject({ user: { name: 'Rina' } });
});
