// Real (non-mock) mode against an intercepted n8n webhook: checks the request envelope of API.md
// and that only network failures (not {ok:false}) put a sale in the outbox.
const { test, expect } = require('@playwright/test');
const { sha, confirmQty } = require('./helpers');

const API = 'https://ziedapp.app.n8n.cloud/webhook/khair-pos';
const KEY = 'test-store-key';

function fakeBackend() {
  const st = {
    requests: [], mode: 'ok', sales: [],
    products: [{ id: 7, sku: '111', name: 'Kurma Ajwa 1 kg', category: 'Kurma', unit: 'kg', cost_price: 100000, retail_price: 150000, wholesale_price: 140000, wholesale_min_qty: 5, stock: 10, min_stock: 2, active: true, notes: '' }]
  };
  st.handle = async route => {
    const req = route.request();
    const body = JSON.parse(req.postData());
    st.requests.push({ body, contentType: req.headers()['content-type'] });
    const send = (obj, wrap) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(wrap ? [obj] : obj) });
    if (body.key !== KEY) return send({ ok: false, error: 'BAD_KEY', message: 'unknown key' });
    if (body.action === 'users') return send({ ok: true, users: [{ name: 'Jihan', role: 'owner' }] });
    if (body.pin_hash !== sha(`${KEY}:jihan:4321`)) return send({ ok: false, error: 'BAD_PIN', message: 'bad pin' });
    switch (body.action) {
      case 'login': return send({ ok: true, user: { name: 'Jihan', role: 'owner' } });
      case 'bootstrap': return send({ ok: true, products: st.products, customers: [], settings: { store_name: 'Khair Mart', paper: '80', survey_questions: [] }, users: [{ name: 'Jihan', role: 'owner', active: true }], server_time: new Date().toISOString() }, true);
      case 'save_sale':
        if (st.mode === 'abort') return route.abort('internetdisconnected');
        if (st.mode === 'invalid') return send({ ok: false, error: 'INVALID', message: 'qty' });
        st.sales.push(body.data);
        st.products[0].stock -= body.data.items[0].qty;
        return send({ ok: true, invoice_no: 'KM-REAL-' + st.sales.length, sale: { invoice_no: 'KM-REAL-' + st.sales.length, total: 150000, debt_amount: 0 }, stock: [{ product_id: 7, stock: st.products[0].stock }], duplicate: false });
      default: return send({ ok: true });
    }
  };
  return st;
}

test('real mode: envelope, text/plain, pin_hash, n8n array response, outbox on network failure only', async ({ page }) => {
  const be = fakeBackend();
  await page.route(API, be.handle);
  await page.goto('index.html');
  await expect(page.locator('#lg-key')).toHaveValue('');
  await page.fill('#lg-key', KEY);
  await page.click('[data-act="login-key"]');
  await page.click('[data-act="login-user"][data-name="Jihan"]');
  for (const d of '4321') await page.click(`[data-act="pin-key"][data-k="${d}"]`);
  await page.click('[data-act="pin-key"][data-k="ok"]');
  await expect(page.locator('#view-home')).toBeVisible();
  await page.click('#nav [data-view="pos"]');
  await expect(page.locator('#pos-grid .pcard')).toHaveCount(1);

  const login = be.requests.find(r => r.body.action === 'login');
  expect(login.contentType).toMatch(/^text\/plain/);
  expect(login.body).toEqual({ action: 'login', key: KEY, user: 'Jihan', pin_hash: sha(`${KEY}:jihan:4321`), data: { device: expect.objectContaining({ app: 'owner', loc_status: expect.any(String), id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) }) } });
  expect(be.requests.find(r => r.body.action === 'users').body).toMatchObject({ action: 'users', key: KEY });

  // {ok:false} → message, not queued
  be.mode = 'invalid';
  await page.locator('#pos-grid .pcard').first().click();
  await confirmQty(page);
  await page.click('#btn-checkout');
  await expect(page.locator('.toast.err')).toContainText('Data tidak valid');
  await expect(page.locator('#tb-outbox')).toBeHidden();

  // network failure → outbox, then retried with the same client_id
  be.mode = 'abort';
  await page.click('#btn-checkout');
  await expect(page.locator('.modal #receipt')).toContainText('BELUM TERKIRIM');
  await expect(page.locator('#tb-outbox')).toHaveText('Belum terkirim (1)');
  const queued = be.requests.filter(r => r.body.action === 'save_sale').pop().body.data;
  expect(queued).toMatchObject({ customer_id: null, customer_name: 'Umum', items: [{ product_id: 7, qty: 1, unit_price: 150000, price_type: 'eceran' }], discount: 0, payment_method: 'tunai', paid_amount: 150000, survey: [], survey_consent: false });
  expect(queued.client_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(queued.sale_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(queued.sale_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);

  be.mode = 'ok';
  await page.evaluate(() => KPOS.syncOutbox(true));
  await expect(page.locator('#tb-outbox')).toBeHidden();
  expect(be.sales).toHaveLength(1);
  expect(be.sales[0].client_id).toBe(queued.client_id);
  await expect(page.locator('#pos-grid .pcard .badge')).toContainText('9');
});
