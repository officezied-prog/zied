// Katalog: product images (product_images, cached by image_updated), prices, stock level only, presentation mode, share.
const H = require('./helpers'); const { test, expect } = H;

test('catalog with images, stock levels (no exact stock, no cost), presentation mode, WhatsApp share', async ({ page }) => {
  await H.login(page);
  await H.tab(page, 'catalog');
  const imgs = page.locator('#cat-grid img[data-img]');
  await expect.poll(() => imgs.count()).toBeGreaterThanOrEqual(15);
  expect(await imgs.first().getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
  expect(await imgs.first().evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);
  const db = await H.getDb(page);
  const ajwa = db.products.find(p => /Ajwa/.test(p.name));
  const card = page.locator(`#cat-grid .pcard[data-id="${ajwa.id}"]`);
  await expect(card).toContainText(H.rp(ajwa.retail_price));
  await expect(card).toContainText(`Grosir ${H.rp(ajwa.wholesale_price)} (min ${ajwa.wholesale_min_qty} kg)`);
  await expect(card.locator('[data-stock]')).toHaveText('Tersedia');
  const text = await page.locator('#cat-grid').innerText();
  expect(text).not.toMatch(new RegExp(`Stok\\s*${ajwa.stock}\\b`));
  await expect(card).not.toContainText(new Intl.NumberFormat('id-ID').format(ajwa.cost_price));
  expect(await page.evaluate(() => window.SALES.S.products.some(p => 'cost_price' in p))).toBe(false);
  expect(text).not.toMatch(/modal|cost|HPP|laba/i);
  // a low-stock product shows "Sedikit", none shows the exact count
  const low = db.products.find(p => p.stock > 0 && p.stock <= p.min_stock);
  await expect(page.locator(`#cat-grid .pcard[data-id="${low.id}"] [data-stock]`)).toHaveText('Sedikit');
  await H.shot(page, 'phone-12-catalog');
  // category filter + search
  await page.click('#cat-chips [data-c="Kurma"]');
  expect(await page.locator('#cat-grid .pcard').count()).toBe(db.products.filter(p => p.category === 'Kurma' && p.active !== false).length);
  await page.fill('#cat-q', 'sukkari');
  await expect(page.locator('#cat-grid .pcard')).toHaveCount(1);
  await page.fill('#cat-q', '');
  await page.click('#cat-chips [data-c=""]');

  // presentation mode: swipe / next / prev
  await page.click('#cat-present');
  const pr = page.locator('#present');
  await expect(pr).toBeVisible();
  const first = await page.locator('#pr-name').textContent();
  await expect(page.locator('#pr-pos')).toHaveText(/^1 \//);
  await H.shot(page, 'phone-13-presentation');
  const box = await pr.boundingBox();
  await page.mouse.move(box.width * 0.8, box.height * 0.5); await page.mouse.down(); await page.mouse.move(box.width * 0.2, box.height * 0.5, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('#pr-pos')).toHaveText(/^2 \//);
  expect(await page.locator('#pr-name').textContent()).not.toBe(first);
  await page.click('[data-act="present-prev"]');
  await expect(page.locator('#pr-name')).toHaveText(first);
  const href = await page.locator('#pr-share').getAttribute('href');
  expect(href.startsWith('https://wa.me/?text=')).toBe(true);
  const msg = decodeURIComponent(href.split('text=')[1]);
  expect(msg).toContain(first);
  expect(msg).toMatch(/Rp/);
  expect(msg).not.toMatch(/modal|cost/i);
  await page.click('#pr-add');
  await expect(page.locator('.toast.ok', { hasText: 'masuk pesanan' })).toBeVisible();
  await page.click('[data-act="present-close"]');
  await expect(pr).toHaveCount(0);

  // images come from the cache next time (fetched once per image_updated)
  const fetches = await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.sales.img_fetches')));
  await page.reload();
  await H.tab(page, 'catalog');
  await expect.poll(() => page.locator('#cat-grid img[data-img]').count()).toBeGreaterThanOrEqual(15);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.sales.img_fetches')))).toBe(fetches);
  // owner changes one image → only that one is fetched again
  await H.setDb(page, `const p = db.products.find(x => x.image_updated); const row = db.product_images.find(x => x.product_id === p.id); row.image_base64 = btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" fill="red"/></svg>'); p.image_updated = row.image_updated = new Date().toISOString();`);
  await page.reload();
  await H.tab(page, 'catalog');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.sales.img_fetches')))).toBe(fetches + 1);
});
