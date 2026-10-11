// v16 plain-text inputs: each field takes only what the server accepts (names, phone, e-mail, numbers, document numbers),
// every text field has a maxlength, < > never get in, and the server's INVALID message is shown as it is.
const { test, expect } = require('@playwright/test');
const H = require('./helpers');

test.use(H.PHONE);

/** Every visible text field on the page has a maxlength (and a rule). */
const unlimited = page => page.evaluate(() => [...document.querySelectorAll('input, textarea')]
  .filter(el => el.offsetParent !== null && !['checkbox', 'radio', 'file', 'date', 'hidden'].includes(el.type))
  .filter(el => !(el.maxLength > 0) || !el.dataset.rule).map(el => el.id || el.outerHTML.slice(0, 60)));

test('names, phone, e-mail and quantities refuse what the server refuses; maxlength everywhere; the server message is shown', async ({ page }) => {
  await H.login(page);
  expect(await unlimited(page)).toEqual([]);
  // quantity: digits only (Arabic-Indic digits become 0-9)
  await page.fill('#q', 'ajwa');
  await page.locator('#grid .pc').first().click();
  await page.fill('#qs-qty', '2x');
  await expect(page.locator('#qs-qty')).toHaveValue('2');
  await expect(page.locator('#rule-hint')).toHaveText('Angka saja');
  await page.fill('#qs-qty', '٣');
  await expect(page.locator('#qs-qty')).toHaveValue('3');
  expect(await unlimited(page)).toEqual([]);
  await H.closeModals(page);
  await page.fill('#q', '');

  // a new customer at the counter (Batch A: the cashier adds customers from the payment window; members only by the manager)
  await H.addItem(page, 'ajwa');
  await H.pay(page);
  await page.click('#pay-cust');
  await page.click('#cp-new summary');
  await page.fill('#cn-name', 'Toko Baru; <b>');
  await expect(page.locator('#cn-name')).toHaveValue('Toko Baru b');
  await page.fill('#cn-phone', 'abc 0812-33x44 55');
  await expect(page.locator('#cn-phone')).toHaveValue('0812334455');
  await page.fill('#cn-email', ' ali @ contoh.id ');
  await expect(page.locator('#cn-email')).toHaveValue('ali@contoh.id');
  await expect(page.locator('#cn-name')).toHaveAttribute('maxlength', '80');
  await expect(page.locator('#cn-phone')).toHaveAttribute('maxlength', '20');
  await expect(page.locator('#cn-email')).toHaveAttribute('maxlength', '120');
  expect(await unlimited(page)).toEqual([]);
  await H.shot(page, 'phone-59-input-rules', false);
  // the input allows "-" but not as the first character: the server says what is allowed
  await page.fill('#cn-name', '-Toko Baru');
  await page.click('#cp-save');
  await expect(page.locator('#cp-err')).toContainText("Nama pelanggan hanya boleh huruf, angka dan . , ' & ( ) / -");
  await H.closeModals(page);

  // goods-in, kas and payment windows
  await H.tab(page, 'masuk');
  expect(await unlimited(page)).toEqual([]);
  await page.fill('#pu-sup', 'CV <Maju> Jaya; Abadi');
  await expect(page.locator('#pu-sup')).toHaveValue('CV Maju Jaya Abadi');
  await H.tab(page, 'kas');
  await page.click('#kas-out');
  await page.fill('#cm-amt', 'Rp 20.000');
  await expect(page.locator('#cm-amt')).toHaveValue('20.000');
  await page.fill('#cm-note', 'Es <batu>');
  await expect(page.locator('#cm-note')).toHaveValue('Es batu');
  expect(await unlimited(page)).toEqual([]);
});

test('field checks (INVALID), a clean note is saved, and a code attempt now LOCKS the account (v19)', async ({ page }) => {
  await H.login(page);
  const db0 = await H.getDb(page);
  const sale = db0.sales.filter(s => s.status === 'ok').pop(), it = db0.items.find(i => i.invoice_no === sale.invoice_no);
  const r = await page.evaluate(async ([inv, pid]) => {
    const one = async d => { try { return await api('request_return', d); } catch (e) { return { error: e.code, message: e.message }; } };
    return {
      badName: await one({ kind: 'pelanggan', invoice_no: inv, lines: [{ product_id: pid, qty: 0.5 }], reason_code: 'rusak', returned_by: '123 Ani' }),
      badPhone: await one({ kind: 'pelanggan', invoice_no: inv, lines: [{ product_id: pid, qty: 0.5 }], reason_code: 'rusak', returned_by_phone: '12ab' }),
      noReason: await one({ kind: 'pelanggan', invoice_no: inv, lines: [{ product_id: pid, qty: 0.5 }], reason_code: 'bosan' }),
      ok: await one({ kind: 'pelanggan', invoice_no: inv, lines: [{ product_id: pid, qty: 0.5 }], reason_code: 'lainnya', reason_note: 'Rusak kemasan 100%, 2 pcs', returned_by: 'Ibu Ani' }),
      code: await one({ kind: 'pelanggan', invoice_no: inv, lines: [{ product_id: pid, qty: 0.5 }], reason_code: 'rusak', reason_note: '<script>alert(1)</script>' })
    };
  }, [sale.invoice_no, it.product_id]);
  expect(r.badName).toEqual({ error: 'INVALID', message: 'Nama orang yang mengembalikan hanya boleh huruf' });
  expect(r.badPhone).toEqual({ error: 'INVALID', message: 'Nomor HP orang yang mengembalikan tidak valid' });
  expect(r.noReason).toEqual({ error: 'INVALID', message: 'Pilih alasan retur' });
  const db = await H.getDb(page);
  const ap = db.approvals.find(a => a.request_id === r.ok.request_id);
  expect(ap.note).toBe('Rusak kemasan 100%, 2 pcs');
  expect(JSON.parse(ap.payload).returned_by).toBe('Ibu Ani');
  // a code attempt locks this cashier (server), and the app logs straight out to the lock screen
  expect(r.code.error).toBe('TAMPER');
  expect((await H.getDb(page)).settings.locked_accounts).toContain('siti');
  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('#login')).toContainText('dikunci');
});

test('Arabic: the hint for a refused character', async ({ page }) => {
  await H.login(page, 'Jihan', '2222'); // member registration is the manager's (Batch A)
  await H.tab(page, 'more');
  await page.click('#lang-ar');
  await page.click('#m-member');
  await page.fill('#cn-phone', '٠٨١٢ abc');
  await expect(page.locator('#cn-phone')).toHaveValue('0812');
  await expect(page.locator('#rule-hint')).toHaveText('رقم الهاتف: أرقام فقط');
  await H.shot(page, 'phone-60-input-rules-ar', false);
});
