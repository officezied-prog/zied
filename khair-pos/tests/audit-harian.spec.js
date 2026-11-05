// v76 (owner 2026-11-05, his daily paper «AUDIT HARIAN» sent as a PDF: «كل يوم نقوم بوجهين ورقة مثل هذه … اريدك ان تجهز مثل هذه كل يوم و
// ترسلها الى الواتس مع شعار الخير مارت», his choice «أ», «أرسلها لي وللمدير»): Laporan → Harian shows the shop's paper filled from the day's
// records — what left the drawer (PEMBAYARAN TUNDA), each cash / transfer / Shopee / EDC receipt, the cash taken to the bank, Zero pagi
// and Zero malam, the store's and the online income — and one tap shares it as a PDF with the logo (WhatsApp); a computer downloads it.
const { test, expect } = require('@playwright/test');
const { jktToday, login, getDb, nav, editDb } = require('./helpers');

const NF = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const n = v => NF.format(Math.round(v));
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

async function openDaily(page, day) {
  await nav(page, 'reports');
  if (await page.locator('#rp-daily-btn').isVisible().catch(() => false)) await page.click('#rp-daily-btn');
  else await page.click('[data-act="rp-mode"][data-m="daily"]');
  await expect(page.locator('#dr-body')).toBeVisible();
  await page.fill('#dr-date', day);
  await page.locator('#dr-date').dispatchEvent('change');
}
// what the day brought in by method, by the same rules as the paper (a marketplace order in its own column, an old debt paid today too)
function expected(db, day) {
  const sales = db.sales.filter(s => s.sale_date === day && s.status !== 'void');
  const of = s => {
    const o = { tunai: 0, transfer: 0, qris: 0, kartu: 0 };
    let parts = s.payment_method === 'campur' ? s.pay_parts : null;
    if (typeof parts === 'string') { try { parts = JSON.parse(parts); } catch (e) { parts = null; } }
    if (Array.isArray(parts) && parts.length) { parts.forEach(p => { if (o[p.m] !== undefined) o[p.m] += Number(p.a) || 0; }); return o; }
    o[o[s.payment_method] !== undefined ? s.payment_method : 'tunai'] += Math.min(Number(s.paid_amount) || 0, Number(s.total) || 0);
    return o;
  };
  const e = { cash: 0, transfer: 0, edc: 0, shopee: 0 };
  sales.forEach(s => {
    if (s.channel === 'shopee' || s.channel === 'tokopedia') { e[s.channel === 'shopee' ? 'shopee' : 'tokopedia'] = (e[s.channel] || 0) + Number(s.total); return; }
    const p = of(s); e.cash += p.tunai; e.transfer += p.transfer; e.edc += p.qris + p.kartu;
  });
  db.payments.filter(p => p.pay_date === day && Number(p.customer_id) > 0 && (p.direction || 'in') !== 'out' && Number(p.amount) > 0).forEach(p => {
    if (p.method === 'transfer') e.transfer += Number(p.amount); else if (p.method === 'qris' || p.method === 'kartu') e.edc += Number(p.amount); else e.cash += Number(p.amount);
  });
  e.toko = e.cash + e.transfer + e.edc + e.shopee + (e.tokopedia || 0);
  return e;
}

test('the day\'s paper from the records: drawer outflows, receipts by method, deposit, zero pagi / malam, income; PDF with the logo', async ({ page }) => {
  await login(page, 'Jihan', '2222', '', { stay: true }); // the manager
  const day = jktToday(-1);
  // the day's drawer: an expense, a staff advance, cash taken to the bank, cash added; one order is a Shopee order
  await editDb(page, `
    const sh = db.shifts.find(x => x.shift_date === arg && x.status === 'closed') || db.shifts.find(x => x.shift_date === arg);
    sh.moves = JSON.stringify([
      { type: 'out', amount: 71000, note: 'Pengeluaran Makan: nasi dan ayam bakar' },
      { type: 'out', amount: 150000, note: 'Kasbon Adit' },
      { type: 'out', amount: 500000, note: 'Setor tunai ke BNI' },
      { type: 'out', amount: 30000, note: 'Bayar pemasok CV Sumber Makmur (PB-1)' },
      { type: 'in', amount: 100000, note: 'Tambah modal' }]);
    const s = db.sales.find(x => x.sale_date === arg && x.status !== 'void' && x.payment_method !== 'campur');
    s.channel = 'shopee';`, day);
  const db = await getDb(page), E = expected(db, day);
  const shifts = db.shifts.filter(x => x.shift_date === day);
  expect(E.cash).toBeGreaterThan(0); expect(E.shopee).toBeGreaterThan(0);
  await openDaily(page, day);
  const card = page.locator('#au-card');
  await expect(card).toBeVisible();
  const sheet = card.locator('.au-sheet');
  await expect(card.locator('.au-head img')).toHaveAttribute('src', 'logo.png');
  await expect(card).toContainText('AUDIT HARIAN ' + MONTHS[+day.slice(5, 7) - 1].toUpperCase() + ' ' + day.slice(0, 4));
  await expect(card).toContainText(`${day.slice(8, 10)} ${MONTHS[+day.slice(5, 7) - 1]} ${day.slice(0, 4)}`);
  // what left the drawer: everything but the bank deposit
  await expect(sheet).toContainText('MAKAN: NASI DAN AYAM BAKAR');
  await expect(sheet).toContainText('KASBON ADIT');
  await expect(sheet).toContainText('BAYAR PEMASOK CV SUMBER MAKMUR (PB-1)');
  await expect(sheet).not.toContainText('SETOR TUNAI KE BNI');
  await expect(sheet).toContainText('KAS MASUK TAMBAH MODAL 100.000');
  // the totals row: drawer outflows, cash, transfer, Shopee, EDC
  const foot = sheet.locator('tr.ft');
  const total = foot.nth(0).locator('td');
  await expect(total.nth(1)).toHaveText('Rp' + n(71000 + 150000 + 30000));
  await expect(total.nth(3)).toHaveText('Rp' + n(E.cash));
  await expect(total.nth(5)).toHaveText('Rp' + n(E.transfer));
  await expect(total.nth(6)).toHaveText('Rp' + n(E.shopee));
  await expect(total.nth(8)).toHaveText('Rp' + n(E.edc));
  await expect(foot.nth(1).locator('td').nth(1)).toHaveText('Rp' + n(500000)); // STOR TUNAI KE BANK
  await expect(foot.nth(2).locator('td').nth(1)).toHaveText('Rp' + n(shifts.reduce((a, x) => a + Number(x.opening_cash), 0))); // Zero Pagi
  const closed = shifts.filter(x => x.status === 'closed');
  if (closed.length === shifts.length) await expect(foot.nth(3).locator('td').nth(1)).toHaveText('Rp' + n(closed.reduce((a, x) => a + Number(x.counted_cash), 0))); // Zero Malam
  await expect(foot.nth(4).locator('td').nth(1)).toHaveText('Rp' + n(E.toko)); // PENDAPATAN TOKO
  await expect(foot.nth(5).locator('td').nth(8)).toHaveText('Rp' + n(E.edc)); // PENDAPATAN ONLINE
  // the PDF: downloaded on a computer (no share sheet here)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#au-pdf')]);
  const name = `AUDIT_HARIAN_${day.slice(8, 10)}_${MONTHS[+day.slice(5, 7) - 1].toUpperCase()}_${day.slice(0, 4)}.pdf`;
  expect(dl.suggestedFilename()).toBe(name);
  const pdf = require('fs').readFileSync(await dl.path());
  expect(pdf.slice(0, 8).toString('latin1')).toBe('%PDF-1.4');
  expect(pdf.toString('latin1')).toContain('/Filter /DCTDecode');
  expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
  const xref = Number(/startxref\n(\d+)/.exec(pdf.toString('latin1'))[1]);
  expect(pdf.slice(xref, xref + 4).toString('latin1')).toBe('xref'); // the cross-reference table sits where the PDF says
  // one tap on a phone: the share sheet gets the PDF (then WhatsApp → the owner's and the manager's chats)
  await page.evaluate(() => {
    window.__shared = null;
    navigator.canShare = d => !!(d && d.files && d.files.length);
    navigator.share = async d => { window.__shared = { name: d.files[0].name, type: d.files[0].type, size: d.files[0].size, text: d.text }; };
  });
  await page.click('#dr-au-send');
  await expect.poll(() => page.evaluate(() => window.__shared)).not.toBeNull();
  const sh = await page.evaluate(() => window.__shared);
  expect(sh.name).toBe(name); expect(sh.type).toBe('application/pdf'); expect(sh.size).toBeGreaterThan(20000);
  expect(sh.text).toContain('Pendapatan toko: Rp ' + n(E.toko));
  await expect(page.locator('.toast').last()).toContainText('Audit harian dikirim');
  // the owner's and the manager's chats are named on the card
  await expect(card).toContainText('Pemilik');
  await expect(card).toContainText('Manajer');
});

test('today\'s paper sent marks the evening reminder done; an open drawer says so; Arabic', async ({ page }) => {
  await login(page, 'Pemilik', '1234', '', { stay: true });
  const day = jktToday(0);
  await openDaily(page, day);
  const card = page.locator('#au-card');
  await expect(card).toBeVisible();
  const db = await getDb(page);
  if (db.shifts.some(x => x.shift_date === day && x.status === 'open')) {
    await expect(card).toContainText('Kasir masih buka');
    await expect(card.locator('tr.ft').nth(3)).toContainText('KAS MASIH BUKA');
  }
  await page.evaluate(() => {
    navigator.canShare = d => !!(d && d.files && d.files.length);
    navigator.share = async () => {};
    localStorage.removeItem('kpos.daily_sent');
  });
  await page.click('#au-send');
  await expect(page.locator('.toast').last()).toContainText('Audit harian dikirim');
  expect(await page.evaluate(() => store.get('daily_sent', ''))).toBe(day);
  // cancelled in the share sheet: nothing is marked, nothing downloaded
  await page.evaluate(() => { store.set('daily_sent', ''); navigator.share = async () => { const e = new Error('cancel'); e.name = 'AbortError'; throw e; }; });
  await page.click('#au-send');
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => store.get('daily_sent', ''))).toBe('');
  await page.evaluate(() => setLang('ar'));
  await expect(page.locator('#au-card')).toContainText('ورقة التدقيق اليومي');
  await expect(page.locator('#au-card .au-sheet')).toContainText('PEMBAYARAN TUNDA'); // the paper itself stays as the shop writes it
});
