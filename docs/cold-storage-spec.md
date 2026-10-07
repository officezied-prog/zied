You are a senior JavaScript developer. Write the COMPLETE code for a new module of an existing shop system. Another engineer will review it and install it, so follow the conventions below exactly. Output every file in full, each in its own code block that starts with its path. Never shorten with "...", "rest unchanged" or "same as before".

# 1. Business context
Khair Mart is a shop in Jakarta (Indonesia) that sells dates (kurma), nuts and Middle-Eastern food, retail and wholesale.
The owner stores bulk stock (mostly dates) in RENTED cold-storage warehouses run by other companies (e.g. [NAMA GUDANG 1], [NAMA GUDANG 2]).
Stock there is kept on PALLETS, and some arrives in CONTAINERS (shipping containers, 20ft/40ft).
Today everything is tracked by WhatsApp messages and memory. The goal is a small web app "Khair Gudang Dingin" that:

1. Keeps a register of what we have in each cold storage: per pallet (pallet code, product, lot/batch, production & expiry date, cartons, kg per carton, position/rack if known, date in) and per container (container no., arrival date, which pallets came from it).
2. Records every movement as an append-only log: IN (from container/supplier), OUT (picked for the shop or a customer), TRANSFER (between warehouses), ADJUST (count correction, needs a reason). A movement is never edited or deleted; a mistake is fixed by a reverse movement that references the original.
3. Daily WhatsApp stock check: each warehouse sends a daily stock message on WhatsApp. The user pastes that message text into the app. The app parses it, compares it with our own balance per pallet/product, and shows: OK lines, differences (red, with the difference in cartons), items they list that we don't have, and items we have that they did not list. The check is saved (who, when, raw text, result) and cannot be changed afterwards.
   Example of the daily message (REPLACE WITH A REAL ONE): 
   ```
   [PASTE A REAL DAILY STOCK MESSAGE FROM THE WAREHOUSE HERE]
   ```
   Because formats differ per warehouse, put the parser in one function per warehouse format (`parsers.<code>(text) → [{pallet?, product?, lot?, cartons, kg?}]`) plus a generic fallback that reads lines like "Sukari 3kg ... 120 ctn". Unparsed lines must be shown to the user, never silently dropped.
4. Pick orders (Surat Pengambilan Barang): the user selects pallets/cartons to take out, the destination (shop / customer name / address), date, pickup person and vehicle. The app produces:
   - an A4 printable document (company header, number like `SPB-YYMMDD-001`, table, signature boxes: Dibuat / Gudang / Sopir / Penerima),
   - a Word file (.doc, made as HTML with Word MIME type, no library),
   - an Excel file (.xls as SpreadsheetML XML or CSV, no library),
   - a WhatsApp text (wa.me link with the order as text) to send to the warehouse.
   When the warehouse confirms, the user marks the order "Diambil" (picked), which creates the OUT movements. Cancelled orders stay visible as cancelled.
5. Truck / Lalamove: on a pick order, a button "Pesan truk" that (a) shows pickup address (warehouse) and drop address (shop/customer) ready to copy, total cartons and estimated weight in kg, and suggests a vehicle size (pickup/van/engkel/CDD by weight), (b) opens the Lalamove app/website, and (c) alternatively sends a WhatsApp to a saved truck driver contact. Record the trip (vehicle, driver, cost in Rupiah, plate number) on the order. No Lalamove API integration in this version.
6. Alerts on the dashboard: pallets expiring in ≤ 60 days (FEFO: when picking, suggest the oldest expiry first), warehouses with a stock check not done today, differences not yet explained, monthly storage cost per warehouse (rate per pallet per day or per month, set per warehouse).

# 2. Users and roles
- `owner`: everything, including costs and settings.
- `manager`: everything except settings and storage costs/prices.
- `akuntan`: read-only (sees everything except it cannot create, change or cancel anything).
The server enforces roles; the UI only hides buttons.

# 3. Technical rules (must follow)
## Frontend
- ONE self-contained file `gudang/index.html`: vanilla JavaScript + CSS inside the file. No frameworks, no build step, no CDN, no external fonts (the page has a strict Content-Security-Policy `default-src 'self'`). 
- Mobile-first (used mostly on Android phones), also good on desktop. Big touch targets.
- UI language Indonesian; all strings in one object `I18N = { id: {...}, ar: {...} }` with an Arabic translation and RTL layout when Arabic is chosen.
- Money format `Rp 1.234.567`; dates shown `07 Okt 2026`; all times Asia/Jakarta (WIB, UTC+7).
- All text the user types is shown with `textContent` (never `innerHTML` with user data).
- `CONFIG = { COLD_URL: 'https://ziedapp.app.n8n.cloud/webhook/khair-cold' }` at the top.
- Login screen: store key (entered once per device, kept in localStorage), user name, PIN. Send `pin_hash = sha256_hex(key + ':' + user.toLowerCase() + ':' + pin)` (use `crypto.subtle`).
- Every API call: `fetch(CONFIG.COLD_URL, {method:'POST', headers:{'Content-Type':'text/plain;charset=UTF-8'}, body: JSON.stringify({action, key, user, pin_hash, data})})`. Response is `{ok:true, ...}` or `{ok:false, error:'CODE', message:'...'}`; show `message` in a toast.
- Demo mode: when the URL has `?mock=1`, all API calls go to an in-browser mock that uses the SAME core logic file (see backend) with data in localStorage, pre-filled with realistic demo data (2 warehouses, 1 container, ~15 pallets of dates: Sukari, Ajwa, Medjool, Khalas; some near expiry; 10 days of movements; one pick order; one stock check with a difference).
- Screens: Dashboard · Stok (per warehouse → pallets, filter by product, search) · Kontainer · Mutasi (movement log, filter by date/type) · Cek stok harian (paste WA text → result → save) · Order ambil (list, create, print/Word/Excel/WA, mark picked, truck) · Pengaturan (owner: warehouses with address, PIC name & WhatsApp number, storage rate; products list; truck driver contacts).

## Backend logic (pure, testable)
- File `cold-core.js`: ONE pure function `KCold.core(state, req, nowIso)` with NO network, NO storage, NO Date.now() (use `nowIso`).
  - `state` = `{ warehouses:[], products:[], containers:[], pallets:[], movements:[], checks:[], orders:[], trips:[], settings:{}, users:[{name, role, pin_hash, active}] }` (arrays of plain rows with an `id`).
  - `req` = the request envelope above (already parsed).
  - Returns `{ response: {ok, ...}, writes: [{table, row}] }` where `writes` are the rows to insert or update (row with existing `id` = update, without = insert; the caller assigns ids). Never return deletes.
  - Check `pin_hash` against `state.users`; errors `BAD_PIN`, `FORBIDDEN`, `INVALID`, `NOT_FOUND`.
  - Pallet balance is ALWAYS computed from movements (sum), never stored as the truth.
  - Actions: `login`, `bootstrap`, `warehouse_save`, `product_save`, `container_save`, `pallet_in` (creates pallets + IN movements), `movement_add` (TRANSFER/ADJUST), `movement_reverse`, `check_save` (raw text + parsed lines → compare → saved result), `order_save`, `order_pick` (creates OUT movements, refuses if not enough stock), `order_cancel`, `trip_save`, `report` (balances per warehouse/product/pallet at a date, expiries, storage cost per month).
- File `cold-parsers.js`: the WhatsApp parsers (pure functions).
- File `test-cold.js`: plain Node test (`node test-cold.js`, no dependencies, uses `assert`) covering every action, roles, reverse movements, not-enough-stock, FEFO suggestion, and the parser on the example message, including unparsed lines.
- Do NOT put any key, password, phone number or token in the code. The store key is checked by the server outside your code.

## Documents
- `docs-cold.js`: builders returning HTML strings for the A4 pick order (`@page { size: A4; margin: 12mm }`), the daily check report, and the stock report; plus `toDoc(html, filename)` and `toXls(rows, filename)` download helpers.

# 4. Output
1. A short list of the assumptions you made.
2. The files in full: `gudang/index.html`, `cold-core.js`, `cold-parsers.js`, `docs-cold.js`, `test-cold.js`.
3. The data tables (name, columns, type) the backend needs.
4. Nothing else. No explanations between the files.
