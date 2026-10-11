// Shop categories (shared/shop-types.js): group → type picker, search (Indonesian + Arabic), "Lainnya" with own words,
// chain (Indomaret, Superindo, …), re-categorising an existing shop, Toko saya filter by group + coloured map,
// the read-only "Jenis toko target" list, offline queue, and the mock following the server rules.
const H = require('./helpers'); const { test, expect } = H;

/** Kunjungi → Toko baru, with the GPS fix in place. */
async function newShopForm(page, context, name, pos = [-6.2601, 106.8622]) {
  await H.setPos(context, pos[0], pos[1], 10);
  await H.tab(page, 'visit');
  await expect(page.locator('#ci-fix')).toHaveAttribute('data-acc', '10');
  await page.click('#ci-new');
  if (name) await page.fill('#ci-name', name);
}
const shopsOf = async page => (await H.getDb(page)).shops;
const outbox = page => page.evaluate(() => JSON.parse(localStorage.getItem('kpos.mock.sales.outbox') || '[]'));

test('new shop: nothing picked → asks for a type; group → type; chain chip Indomaret is saved', async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await H.login(page);
  await newShopForm(page, context, 'Indomaret Kalibata Raya');
  await expect(page.locator('#tp-groups [data-act="tp-group"]')).toHaveCount(9);
  await expect(page.locator('#tp-sel')).toHaveCount(0); // default: nothing selected
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await expect(page.locator('#ci-err')).toHaveText('Pilih jenis toko dulu');
  expect((await shopsOf(page)).some(s => s.name === 'Indomaret Kalibata Raya')).toBe(false);
  await page.locator('#tp').scrollIntoViewIfNeeded();
  await H.shot(page, 'phone-23-shop-type-groups');

  await page.click('#tp-groups [data-g="ritel_modern"]');
  await expect(page.locator('#tp-group')).toHaveAttribute('data-group', 'ritel_modern');
  await expect(page.locator('#tp-types [data-act="tp-type"]')).toHaveCount(4);
  await expect(page.locator('#tp-types [data-t="minimarket"]')).toContainText('Indomaret, Alfamart, Alfamidi, …');
  // back to the groups and in again
  await page.click('#tp-back');
  await expect(page.locator('#tp-groups')).toBeVisible();
  await page.click('#tp-groups [data-g="ritel_modern"]');
  await page.click('#tp-types [data-t="minimarket"]');
  await expect(page.locator('#tp-sel')).toContainText('Minimarket');
  await expect(page.locator('#tp-sel')).toContainText('Ritel modern');
  await expect(page.locator('#tp-other')).toHaveCount(0);
  await expect(page.locator('#tp-chains .chip')).toHaveCount(9);
  await page.click('#tp-chains .chip[data-c="Indomaret"]');
  await expect(page.locator('#tp-chain')).toHaveValue('Indomaret');
  await expect(page.locator('#tp-chains .chip.on')).toHaveText('Indomaret');
  // tapping the chip again clears it, tapping once more sets it
  await page.click('#tp-chains .chip[data-c="Indomaret"]');
  await expect(page.locator('#tp-chain')).toHaveValue('');
  await page.click('#tp-chains .chip[data-c="Indomaret"]');
  await page.locator('#tp').scrollIntoViewIfNeeded();
  await H.shot(page, 'phone-24-shop-type-chain');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.ok', { hasText: 'Indomaret Kalibata Raya' })).toBeVisible();
  const shop = (await shopsOf(page)).find(s => s.name === 'Indomaret Kalibata Raya');
  expect(shop).toMatchObject({ type: 'minimarket', chain: 'Indomaret', type_other: '', created_by: 'Ahmad' });
  // shown with its label + chain in Toko saya
  await H.tab(page, 'shops');
  await expect(page.locator(`#sh-list [data-shop="${shop.shop_id}"] .tl`)).toContainText('Minimarket · Indomaret');
  await expect(page.locator(`#sh-list [data-shop="${shop.shop_id}"] .tl`)).toHaveAttribute('data-group', 'ritel_modern');
  expect(errors).toEqual([]);
});

test('type search matches Indonesian labels, chain names and Arabic labels', async ({ page, context }) => {
  await H.login(page);
  await newShopForm(page, context, 'Toko Uji Cari');
  const ids = async () => page.locator('#tp-results [data-act="tp-type"]').evaluateAll(b => b.map(x => x.dataset.t));
  await page.fill('#tp-q', 'kurma');
  await expect.poll(ids).toContain('toko_kurma');
  await page.fill('#tp-q', 'haji');
  await expect.poll(ids).toEqual(['perlengkapan_haji', 'travel_umrah', 'oleh_oleh_haji']);
  await page.fill('#tp-q', 'superindo');
  await expect.poll(ids).toEqual(['supermarket']);
  await page.fill('#tp-q', 'indomaret');
  await expect.poll(ids).toEqual(['minimarket']);
  await page.fill('#tp-q', 'xyzq');
  await expect(page.locator('#tp-none')).toBeVisible();
  // typing keeps the focus in the search box (only the results are redrawn)
  await page.locator('#tp-q').pressSequentially('  ');
  await expect(page.locator('#tp-q')).toBeFocused();
  await page.fill('#tp-q', 'pesantren');
  await page.click('#tp-results [data-t="pesantren"]');
  await expect(page.locator('#tp-sel')).toHaveAttribute('data-type', 'pesantren');
  await expect(page.locator('#tp-chains')).toHaveCount(0); // no chains for a pesantren

  // Arabic
  await page.click('#tb-menu');
  await page.click('#lang-ar');
  await H.closeModals(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#tp-sel')).toContainText('معهد ديني');
  await page.click('#tp-change');
  await page.fill('#tp-q', 'تمور');
  await expect.poll(ids).toContain('toko_kurma');
  await page.fill('#tp-q', 'الحج');
  await expect.poll(ids).toEqual(['perlengkapan_haji', 'travel_umrah', 'oleh_oleh_haji']);
  await page.fill('#tp-q', 'مسجد'); // matches "مسجد / لجنة المسجد"
  await expect.poll(ids).toContain('masjid');
  await page.fill('#tp-q', 'سوبر');
  await expect.poll(ids).toEqual(['supermarket']);
  await expect(page.locator('#tp-results [data-t="supermarket"]')).toContainText('سوبر ماركت');
  await page.fill('#tp-q', '');
  // "Ganti" keeps the group of the previous type open (pesantren → Lembaga & komunitas); back → all groups
  await expect(page.locator('#tp-group')).toHaveAttribute('data-group', 'lembaga');
  await expect(page.locator('#tp-back')).toContainText('كل المجموعات');
  await page.click('#tp-back');
  await expect(page.locator('#tp-groups [data-g="haji_umrah"]')).toContainText('الحج والعمرة');
  await page.click('#tp-groups [data-g="haji_umrah"]');
  await page.locator('#tp').scrollIntoViewIfNeeded();
  await H.shot(page, 'phone-27-ar-shop-types');
  // the start of the type buttons is on the right in RTL
  const box = await page.locator('#tp-types [data-t="perlengkapan_haji"]').boundingBox(), em = await page.locator('#tp-types [data-t="perlengkapan_haji"] .e').boundingBox();
  expect(em.x).toBeGreaterThan(box.x + box.width / 2);
  await page.click('#tp-types [data-t="perlengkapan_haji"]');
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.ok')).toBeVisible();
  expect((await shopsOf(page)).find(s => s.name === 'Toko Uji Cari')).toMatchObject({ type: 'perlengkapan_haji', type_other: '', chain: '' });
});

test('"Lainnya" needs the rep\'s own words and stores them as type_other', async ({ page, context }) => {
  await H.login(page);
  await newShopForm(page, context, 'Toko Parfum Baru');
  await page.click('#tp-groups [data-g="lainnya"]'); // one type in the group → chosen at once
  await expect(page.locator('#tp-sel')).toHaveAttribute('data-type', 'lainnya');
  await expect(page.locator('label[for="tp-other"]')).toContainText('Jenis toko (tulis sendiri)');
  await expect(page.locator('#tp-other')).toBeFocused();
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await expect(page.locator('#ci-err')).toHaveText('Tulis jenis tokonya (Lainnya)');
  await expect(page.locator('#tp-other')).toBeFocused();
  await page.fill('#tp-other', 'Toko parfum Arab');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.ok', { hasText: 'Toko Parfum Baru' })).toBeVisible();
  const shop = (await shopsOf(page)).find(s => s.name === 'Toko Parfum Baru');
  expect(shop).toMatchObject({ type: 'lainnya', type_other: 'Toko parfum Arab', chain: '' });
  await H.tab(page, 'shops');
  await expect(page.locator(`#sh-list [data-shop="${shop.shop_id}"] .tl`)).toContainText('Toko parfum Arab');
  // searchable by the own words
  await page.fill('#sh-q', 'parfum arab');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(2); // + the seeded "Toko parfum Arab"
});

test('re-categorise an existing shop with the check-in ("Ubah jenis toko")', async ({ page, context }) => {
  await H.login(page);
  const shop = (await shopsOf(page)).find(s => s.shop_id === 'TK-0010'); // Warung Mpok Ipah (warung)
  expect(shop.type).toBe('warung');
  await H.setPos(context, shop.lat, shop.lng, 10);
  await H.tab(page, 'visit');
  await page.click(`#ci-near [data-act="ci-pick"][data-id="${shop.shop_id}"]`);
  await expect(page.locator('#ci-type-now')).toHaveText('Warung kelontong');
  // open and cancel: nothing changes
  await page.click('#ci-recat');
  await expect(page.locator('#ci-recat-box #tp-group')).toHaveAttribute('data-group', 'sembako'); // starts in its own group
  await page.click('#ci-recat-cancel');
  await expect(page.locator('#ci-recat-box')).toHaveCount(0);
  await page.click('#ci-recat');
  await page.click('#tp-back');
  await page.click('#tp-groups [data-g="ritel_modern"]');
  await page.click('#tp-types [data-t="minimarket"]');
  await page.fill('#tp-chain', 'Alfamart'); // free text (also in the chip list)
  await expect(page.locator('#tp-chains .chip.on')).toHaveText('Alfamart');
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await expect(page.locator('#v-today')).toBeVisible(); // saved → back to Hari ini
  let db = await H.getDb(page);
  expect(db.shops.find(s => s.shop_id === shop.shop_id)).toMatchObject({ type: 'minimarket', chain: 'Alfamart', type_other: '', visits: shop.visits + 1 });
  expect(db.shops.length).toBe(25);
  // next visit without "Ubah jenis toko" keeps it; then to "Lainnya" with own words (chain cleared)
  await H.tab(page, 'visit');
  await page.click(`#ci-near [data-act="ci-pick"][data-id="${shop.shop_id}"]`);
  await expect(page.locator('#ci-type-now')).toHaveText('Minimarket · Alfamart');
  await page.click('#oc-tidak'); // (v32: "tutup" now needs a photo of the place — not what this test is about)
  await page.click('#ci-ok');
  await expect(page.locator('#v-today')).toBeVisible(); // saved → back to Hari ini
  db = await H.getDb(page);
  expect(db.shops.find(s => s.shop_id === shop.shop_id)).toMatchObject({ type: 'minimarket', chain: 'Alfamart' });
  await H.tab(page, 'visit');
  await page.click(`#ci-near [data-act="ci-pick"][data-id="${shop.shop_id}"]`);
  await page.click('#ci-recat');
  await page.click('#tp-back');
  await page.click('#tp-groups [data-g="lainnya"]');
  await page.fill('#tp-other', 'Toko jamu & rempah');
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await expect(page.locator('#v-today')).toBeVisible(); // saved → back to Hari ini
  db = await H.getDb(page);
  expect(db.shops.find(s => s.shop_id === shop.shop_id)).toMatchObject({ type: 'lainnya', type_other: 'Toko jamu & rempah', chain: '' });
  await H.tab(page, 'shops');
  await expect(page.locator(`#sh-list [data-shop="${shop.shop_id}"] .tl`)).toContainText('Toko jamu & rempah');
});

test('Toko saya: filter by group with counts, search, map coloured by group with a legend', async ({ page, context }) => {
  await H.login(page);
  await H.setPos(context, -6.2620, 106.8600, 10);
  const counts = await page.evaluate(() => { const c = {}; JSON.parse(localStorage.getItem('kmock.db')).shops.forEach(s => { const g = KhairShopTypes.groupOf(s.type); c[g] = (c[g] || 0) + 1; }); return c; });
  expect(Object.keys(counts).length).toBeGreaterThanOrEqual(8); // the demo shops cover most groups
  await H.tab(page, 'shops');
  await expect(page.locator('#sh-groups [data-g=""]')).toHaveAttribute('data-n', '25');
  for (const [g, n] of Object.entries(counts)) {
    await expect(page.locator(`#sh-groups [data-g="${g}"]`)).toHaveAttribute('data-n', String(n));
    await expect(page.locator(`#sh-groups [data-g="${g}"] .cnt`)).toHaveText(String(n));
  }
  await page.click('#sh-groups [data-g="haji_umrah"]');
  await expect(page.locator('#sh-groups .chip.on')).toHaveAttribute('data-g', 'haji_umrah');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(counts.haji_umrah);
  expect(await page.locator('#sh-list .shop-li .tl').evaluateAll(x => x.map(e => e.dataset.group))).toEqual(Array(counts.haji_umrah).fill('haji_umrah'));
  await page.click('#sh-groups [data-g="ritel_modern"]');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(counts.ritel_modern);
  await expect(page.locator('#sh-list')).toContainText('Supermarket · Superindo');
  await page.click('#sh-groups [data-g=""]');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(25);
  // search keeps working, also by type label / chain
  await page.fill('#sh-q', 'indomaret');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(1);
  await page.fill('#sh-q', 'pesantren');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(1);
  await page.fill('#sh-q', '');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(25);
  // map: one marker per shop, coloured by its group; legend lists the groups
  await page.click('#sh-map-btn');
  await expect(page.locator('#shops-map')).toHaveAttribute('data-mode', 'svg');
  await expect(page.locator('#shops-map [data-shop]')).toHaveCount(25);
  const fills = await page.locator('#shops-map [data-shop]').evaluateAll(gs => gs.map(g => [g.dataset.group, g.querySelector('circle').getAttribute('fill')]));
  const byGroup = {}; fills.forEach(([g, f]) => { (byGroup[g] = byGroup[g] || new Set()).add(f); });
  Object.values(byGroup).forEach(set => expect(set.size).toBe(1)); // one colour per group
  expect(new Set(Object.values(byGroup).map(s2 => [...s2][0])).size).toBe(Object.keys(byGroup).length); // different groups, different colours
  await expect(page.locator('#shops-legend [data-group]')).toHaveCount(Object.keys(counts).length);
  await H.shot(page, 'phone-26-shops-by-group');
  // a group filter also filters the map
  await page.click('#sh-groups [data-g="lembaga"]');
  await expect(page.locator('#shops-map [data-shop]')).toHaveCount(counts.lembaga);
  await expect(page.locator('#shops-legend [data-group]')).toHaveCount(1);
});

test('offline: new shop with type + chain and a re-categorised shop are queued and keep their type after sync', async ({ page, context }) => {
  await H.login(page);
  await H.setPos(context, -6.2620, 106.8570, 12);
  await H.startDay(page);
  await context.setOffline(true);
  await newShopForm(page, context, 'Alfamidi Dewi Sartika', [-6.2620, 106.8570]);
  await H.pickType(page, 'minimarket');
  await page.click('#tp-chains .chip[data-c="Alfamidi"]');
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.warn', { hasText: 'Offline' }).first()).toBeVisible();
  // and an existing shop re-categorised offline
  const shop = (await shopsOf(page)).find(s => s.shop_id === 'TK-0016'); // Warung Sembako Pak Udin
  await H.setPos(context, shop.lat, shop.lng, 10);
  await H.tab(page, 'visit');
  await page.click(`#ci-near [data-act="ci-pick"][data-id="${shop.shop_id}"]`);
  await page.click('#ci-recat');
  await page.click('#tp-types [data-t="grosir_sembako"]');
  await page.click('#oc-tertarik');
  await page.click('#ci-ok');
  await expect(page.locator('.toast.ok', { hasText: shop.name }).last()).toBeVisible();
  const ob = (await outbox(page)).filter(e => e.action === 'check_in');
  expect(ob.length).toBe(2);
  expect(ob[0].data.shop).toMatchObject({ name: 'Alfamidi Dewi Sartika', type: 'minimarket', chain: 'Alfamidi' });
  expect(ob[1].data).toMatchObject({ shop_id: shop.shop_id, shop: { type: 'grosir_sembako', chain: '', type_other: '' } });
  // the phone already shows both
  await H.tab(page, 'shops');
  await expect(page.locator('#sh-list .shop-li', { hasText: 'Alfamidi Dewi Sartika' }).locator('.tl')).toContainText('Minimarket · Alfamidi');
  await expect(page.locator(`#sh-list [data-shop="${shop.shop_id}"] .tl`)).toContainText('Grosir / agen sembako');
  let db = await H.getDb(page);
  expect(db.shops.some(s => s.name === 'Alfamidi Dewi Sartika')).toBe(false);
  expect(db.shops.find(s => s.shop_id === shop.shop_id).type).toBe('warung');

  await context.setOffline(false);
  await expect(page.locator('#tb-outbox')).toBeHidden({ timeout: 15000 });
  db = await H.getDb(page);
  expect(db.shops.find(s => s.name === 'Alfamidi Dewi Sartika')).toMatchObject({ type: 'minimarket', chain: 'Alfamidi', type_other: '' });
  expect(db.shops.find(s => s.shop_id === shop.shop_id)).toMatchObject({ type: 'grosir_sembako', chain: '' });
  await expect(page.locator('#sh-list .shop-li', { hasText: 'Alfamidi Dewi Sartika' }).locator('.tl')).toContainText('Minimarket · Alfamidi');
});

test('"Jenis toko target" lists all 9 groups and 33 types with a hint (ID + AR)', async ({ page }) => {
  await H.login(page);
  await H.tab(page, 'shops');
  await page.click('#sh-mode-target');
  await expect(page.locator('#target-list .tg')).toHaveCount(9);
  await expect(page.locator('#target-list .tg-t')).toHaveCount(33);
  const groups = await page.evaluate(() => KhairShopTypes.GROUPS.map(g => g.id));
  expect(await page.locator('#target-list .tg').evaluateAll(x => x.map(e => e.dataset.group))).toEqual(groups);
  const hints = await page.locator('#target-list .tg-t .s').allTextContents();
  expect(hints.length).toBe(33);
  hints.forEach(h => { expect(h.length).toBeGreaterThan(15); expect(h).not.toMatch(/^hint\./); });
  await expect(page.locator('#target-list [data-type="perlengkapan_haji"] .s')).toContainText('zamzam');
  await expect(page.locator('#target-list [data-type="toko_kurma"] .s')).toContainText('Kurma grosir');
  await expect(page.locator('#target-list [data-type="bakery"] .s')).toContainText('kismis untuk kue');
  await expect(page.locator('#target-list [data-type="masjid"] .s')).toContainText('takjil');
  await expect(page.locator('#target-list [data-type="kantor"] .s')).toContainText('Parsel');
  // chains: the names + "lewat kantor pusat / distributor"
  for (const ty of ['minimarket', 'supermarket', 'hypermarket', 'grosir_modern']) await expect(page.locator(`#target-list [data-type="${ty}"] .note`)).toContainText('kantor pusat / distributor');
  await expect(page.locator('#target-list [data-type="minimarket"] .chn')).toContainText('Indomaret · Alfamart');
  await expect(page.locator('#target-list .note')).toHaveCount(4);
  // how many of my shops per group/type
  const haji = await page.evaluate(() => JSON.parse(localStorage.getItem('kmock.db')).shops.filter(s => KhairShopTypes.groupOf(s.type) === 'haji_umrah').length);
  expect(haji).toBe(4); // 2 perlengkapan haji, a travel umrah, an oleh-oleh haji
  await expect(page.locator('#target-list [data-group="haji_umrah"] h3 .badge')).toHaveText(`${haji} toko saya`);
  await expect(page.locator('#target-list [data-type="perlengkapan_haji"] .t .badge')).toHaveText('2');
  await H.shot(page, 'phone-25-target-list');
  // Arabic
  await page.click('#tb-menu');
  await page.click('#lang-ar');
  await H.closeModals(page);
  await expect(page.locator('#sh-mode-target')).toContainText('أنواع المتاجر المستهدفة');
  await expect(page.locator('#target-list [data-group="haji_umrah"] h3')).toContainText('الحج والعمرة');
  await expect(page.locator('#target-list [data-type="toko_kurma"] .s')).toContainText('تمور بالجملة');
  await expect(page.locator('#target-list [data-type="minimarket"] .note')).toContainText('قسم المشتريات');
  (await page.locator('#target-list .tg-t .s').allTextContents()).forEach(h => expect(h).toMatch(/[؀-ۿ]/));
  // back to my shops
  await page.click('#sh-mode-mine');
  await expect(page.locator('#sh-list .shop-li')).toHaveCount(25);
});

test('mock follows the server rules for type / type_other / chain (also without shop-types.js)', async ({ page }) => {
  await H.login(page);
  const r = await page.evaluate(async () => {
    const ci = (id, extra) => api('check_in', Object.assign({ client_id: id, lat: -6.26, lng: 106.86, acc: 10, outcome: 'tertarik' }, extra));
    const out = {};
    // unknown id → lainnya + the id as own words; type_other/chain are trimmed and capped
    out.unknown = (await ci('m1', { shop: { name: 'Toko A', type: 'toko_parfum' } })).shop;
    out.long = (await ci('m2', { shop: { name: 'Toko B', type: 'lainnya', type_other: ' ' + 'x'.repeat(80), chain: 'y'.repeat(50) } })).shop;
    out.notOther = (await ci('m3', { shop: { name: 'Toko C', type: 'warung', type_other: 'ignored' } })).shop;
    // existing shop: unknown type keeps the type; chain only replaced when sent
    const id = out.notOther.shop_id;
    out.keep = (await ci('m4', { shop_id: id, shop: { type: 'nope' } })).shop;
    out.chain = (await ci('m5', { shop_id: id, shop: { type: 'supermarket', chain: 'Hero' } })).shop;
    out.noChain = (await ci('m6', { shop_id: id, shop: { type: 'hypermarket' } })).shop;
    out.toOther = (await ci('m7', { shop_id: id, shop: { type: 'lainnya', type_other: 'Toko oleh-oleh Turki', chain: '' } })).shop;
    out.back = (await ci('m8', { shop_id: id, shop: { type: 'bakery' } })).shop;
    // the owner app may load field-mock.js without shop-types.js: the built-in id list is used
    const saved = window.KhairShopTypes; window.KhairShopTypes = undefined;
    try { out.fallback = (await ci('m9', { shop: { name: 'Toko D', type: 'perlengkapan_haji' } })).shop; } finally { window.KhairShopTypes = saved; }
    out.sameIds = JSON.stringify(saved.IDS.slice().sort());
    return out;
  });
  expect(r.unknown).toMatchObject({ type: 'lainnya', type_other: 'toko_parfum', chain: '' });
  expect(r.long.type_other).toBe('x'.repeat(60));
  expect(r.long.chain).toBe('y'.repeat(40));
  expect(r.notOther).toMatchObject({ type: 'warung', type_other: '' });
  expect(r.keep).toMatchObject({ type: 'warung' });
  expect(r.chain).toMatchObject({ type: 'supermarket', chain: 'Hero' });
  expect(r.noChain).toMatchObject({ type: 'hypermarket', chain: 'Hero' }); // chain not sent → kept (as the server)
  expect(r.toOther).toMatchObject({ type: 'lainnya', type_other: 'Toko oleh-oleh Turki', chain: '' });
  expect(r.back).toMatchObject({ type: 'bakery', type_other: '' });
  expect(r.fallback).toMatchObject({ type: 'perlengkapan_haji', type_other: '' });
  // the fallback list in field-mock.js is the same as shared/shop-types.js
  const src = require('fs').readFileSync(require('path').join(__dirname, '../shared/field-mock.js'), 'utf8');
  const fb = JSON.parse(src.match(/SHOP_TYPES_FALLBACK = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  expect(JSON.stringify(fb.slice().sort())).toBe(r.sameIds);
  // the demo data: a realistic mix with chains and own words
  const db = await H.getDb(page);
  const seeded = db.shops.filter(s => /^TK-00(0\d|1\d|2[0-5])$/.test(s.shop_id));
  expect(seeded.length).toBe(25);
  expect(seeded.find(s => s.chain === 'Indomaret')).toMatchObject({ type: 'minimarket' });
  expect(seeded.find(s => s.chain === 'Superindo')).toMatchObject({ type: 'supermarket' });
  expect(seeded.find(s => s.type === 'lainnya')).toMatchObject({ type_other: 'Toko parfum Arab' });
  expect(seeded.filter(s => s.type === 'perlengkapan_haji').length).toBe(2);
  ['toko_kurma', 'warung', 'toko', 'grosir_sembako', 'bakery', 'masjid', 'pesantren'].forEach(ty => expect(seeded.some(s => s.type === ty)).toBe(true));
  expect(seeded.slice(0, 3).map(s => s.customer_id)).toEqual([1, 2, 3]); // linked grosir customers kept
});
