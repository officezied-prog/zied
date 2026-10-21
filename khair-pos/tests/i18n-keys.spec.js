// v70: a text key defined twice with two different texts shows the LATER text on BOTH screens — the attention panel said
// "Belum ada pekerja…" (the attendance screen's text) instead of "Semua aman", the drawer-opening approval showed the bank page's
// help, the photo list's "Referensi" column read "No. transfer / referensi", the field page's orders map was titled "Penjualan &
// faktur hari ini" (the owner's sales list). Each feature adds its own Object.assign(I18N.…)
// block, so this guard reads the apps' sources: a key may be defined again only with the same text, or when it is listed
// below as a deliberate replacement (the newer text for the same screen).
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const REPLACED = {
  'index.html': ['pc.title', 'pc.hint', 'pc.save', 'set.bank_hint'], // the PIN-change screen's (the goods-in confirmation uses pcf.*); a newer bank text
  'kasir/index.html': ['apr.inbox_s', 'kas.owner_none', 'ex.mm_title', 'rk.more_s', 'rk.hint', 'rk.hint_mgr'], // newer texts, same screens
  'sales/index.html': []
};

/** { 'id|key': [[line, text], …] } for every 'a.b': '…' definition inside the id / ar dictionaries. */
function definitions(file) {
  const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n');
  const defs = {}; let lang = null;
  lines.forEach((l, i) => {
    const m = /Object\.assign\(I18N\.(id|ar)\b/.exec(l) || /^\s*(id|ar):\s*\{/.exec(l);
    if (m) lang = m[1];
    if (!lang) return;
    for (const d of l.matchAll(/(['"])([a-z_]+\.[A-Za-z0-9_.]+)\1:\s*(['"`])((?:\\.|(?!\3).)*)\3/g)) (defs[lang + '|' + d[2]] = defs[lang + '|' + d[2]] || []).push([i + 1, d[4]]);
  });
  return defs;
}

for (const file of Object.keys(REPLACED)) {
  test(`${file}: no text key is defined twice with two different texts`, () => {
    const defs = definitions(file);
    expect(Object.keys(defs).length).toBeGreaterThan(300); // the parser found the dictionaries
    const clashes = Object.entries(defs)
      .filter(([k, v]) => new Set(v.map(x => x[1])).size > 1 && !REPLACED[file].includes(k.split('|')[1]))
      .map(([k, v]) => k + ' @ ' + v.map(x => x[0]).join(', '));
    expect(clashes).toEqual([]);
  });
}

test('the four screens that showed another screen\'s text now show their own', async ({ page }) => {
  await page.goto('index.html?mock=1');
  const T = await page.evaluate(() => Object.fromEntries(['att.none', 'att.no_workers', 'bk.hint', 'bk.open_hint', 'pc.ref', 'pcf.ref', 'om.title', 'om.map_title'].map(k => [k, t(k)])));
  expect(T['att.none']).toBe('Semua aman, tidak ada yang perlu dicek.');
  expect(T['att.no_workers']).toContain('Belum ada pekerja');
  expect(T['bk.open_hint']).toContain('laci');
  expect(T['bk.hint']).toContain('rekening koran');
  expect(T['pc.ref']).toBe('Referensi');
  expect(T['pcf.ref']).toBe('No. transfer / referensi');
  expect(T['om.title']).toBe('Penjualan & faktur hari ini'); // the owner's sales list
  expect(T['om.map_title']).toBe('Peta pesanan'); // the field page's orders map (it was titled like the sales list)
});
