# Khair Mart POS — project notes

Self-contained HTML PWAs under `khair-pos/` (owner `index.html`, cashier `kasir/`,
field-sales `sales/`, cold-storage `gudang/`), served via GitHub Pages from `main`.
Tests: Playwright under `khair-pos/tests*`.

**Live app links (GitHub Pages):**
- Owner / manager / accountant (المالك/المدير/المحاسب): https://officezied-prog.github.io/zied/khair-pos/
- Cashier (الكاشير): https://officezied-prog.github.io/zied/khair-pos/kasir/
- Field sales rep (المندوب): https://officezied-prog.github.io/zied/khair-pos/sales/
- Cold storage (البرادات): https://officezied-prog.github.io/zied/khair-pos/gudang/
- Cold-store orders, trial app (طلبيات البراد — تجريبي): https://officezied-prog.github.io/zied/khair-pos/brad/ (demo: `?mock=1`)

**Installing on phones (v45–v46):** recommended = Chrome install (a WebAPK Google signs: no warning). Each login card
shows a green "Pasang / تثبيت" card from `shared/install-btn.js` (Chrome's `beforeinstallprompt`; iPhone: Share → Add to
Home Screen hint). Alternative = APKs (Trusted Web Activities) on the release `android`
(`…/releases/download/android/khair-<owner|kasir|sales|gudang>.apk`), built by `.github/workflows/android.yml`
from `khair-pos/android/`; the signing key is `khair-pos/android/khair-release.p12.enc`, encrypted with the repo secret
`ANDROID_KEY_PASSWORD` (never lose it: a new key means everyone reinstalls). Digital Asset Links live in the repo
`officezied-prog/officezied-prog.github.io` (`.well-known/assetlinks.json`, copied from `khair-pos/android/assetlinks.json`).
The owner APK (also the manager's and the accountant's app) and the kasir APK also print on a paired Bluetooth receipt printer by themselves (v58: `khair-pos/android/native/KhairPrintActivity.java`,
added by `build.mjs`; the page opens `intent:…;scheme=khairprint`; v59: `intent:site-settings…` opens Chrome's site settings, where the
attendance camera is allowed again after a refusal); a Chrome install prints through RawBT / BLE / USB instead.

**Printer + scanner fix (v64, owner 2026-10-20: «لا يمكن تواصل التطبيق بآلة استخراج فاتورة الدفع الصغيرة ولا يمكن التواصل مع قارئ الباركود»):**
the APK print activity called `isDiscovering()` / `cancelDiscovery()`, which need `BLUETOOTH_SCAN` on Android 12+ (not declared, not
needed: it never searches) — every print failed before the printer was called; now best effort, a failed print shows why with "Coba
lagi" / "Pilih printer lain", a refused permission opens the app's settings. **The APKs must be reinstalled once** (same key: over the
old one, data kept). `printer.js` keeps the APK's own printer way (`kprint.cfg.app`) and its package per app (`kprint.app:<package>`), so
a Chrome tab's choice or the other Khair app no longer hijacks it. Scanners: `shared/scan-wedge.js` (KWedge) reads keyboard-type
(USB / Bluetooth HID) scanners on every screen with nothing focused, over the last receipt / quantity sheet, in goods-in one item after
another (a burst typed into a number box is put back and read as a scan); UPC-A ↔ EAN-13 leading zeros match; "Pemindai barcode"
(Lainnya / Pengaturan) = the steps + a test scan.

**Daily summary + goods-in confirmation (v65, owner 2026-10-20):** Laporan → Harian lists EVERY invoice of the day (each opens with all its
lines, discount, fee, how it was paid, the debt) and EVERY product sold, with "Cetak / PDF" and two CSV files; the accountant sees it too.
Sales are kept for good (nothing deletes a sale; a void only marks it). Goods-in: every supplier note of the last 30 days (v66: also the ones from before 2026-10-20) waits for the manager /
accountant (`confirm_purchase`, Perhatian), who mark it paid now (cash / transfer / QRIS → a supplier payment allocated to the note, money
out of the day; "from my drawer" only with an open shift) or on credit until an agreed date (`pay_status 'tempo'`, `due_date` on the note's
lines = the supplier's debt; due ≤ 3 days / late in Perhatian and in the supplier's ledger; a later payment covering it marks it 'lunas').
An older note already paid and recorded is confirmed "Sudah dibayar sebelumnya" (`paid_before`: no second payment). Not an expense (the goods' cost counts when sold). Paying a debt later still goes through the owner's pay plan.

**majoo-like screens (v67, owner app 3.0.0; owner 2026-10-20, four majoo screenshots: «اضف هذه المميزات»):** Laporan modes "Detail"
(every invoice of a range: cards total / transaksi / bersih / pembayaran / piutang, search, filters, eye → the receipt, CSV) and "Grafik"
(sales / transaksi / produk per day / week / month, SVG line chart + table + CSV) — owner, manager, accountant, from `get_sales` only.
View "Keuangan" (owner + accountant; the manager only with the owner's cost setting): laba rugi chart + table (same numbers as Laporan),
saldo kas & bank (open drawers' cash; each store account = the owner's "saldo awal" `acct_opening` via `set_account_opening` + money in −
out on that account since; money tied to no account shown apart), neraca (receivables, stock at cost, supplier debt / prepaid) — one
aggregate-SQL call `finance_position`. Gudang tabs "Bahan baku" (bulk goods + packaging materials + price list, CSV, import) and "Produksi
stok" (repacks of a range incl. open / cancelled, CSV, "Tambah" → Kemas ulang). A repack's costs follow the owner's cost setting.

**v68 (owner 3.1.0, kasir 1.8.0; owner 2026-10-20):** the accountant opens Gudang with "Bahan baku" + "Produksi stok" only (`gdTabs()`).
Receipt printers print the store logo (logo.png → black / white GS v 0 raster, small: 160 dots on 58 mm, 192 on 80 mm, centred by blank
dots; "Cetak logo toko" in Printer struk) and a SHORT receipt («اريد عدم اضاعة الورق»: one line an item, the number with the employee,
no Umum / Kasir lines, ESC 3 26). **Invoice number `DD/MM/YYYY/HHmm/N`** (owner's choice «20/10/2026/1542/12»): the sale's day + time
(Jakarta), N = its number in that day for the whole store (`pos_sales.day_seq`, unique (sale_date, day_seq); the day's older KM… count;
a void keeps its number); two cashiers at the same moment → the Worker runs the later request again (`handleRequest` retry); the
employee's name is printed beside it. Goods-in "Dibayar dari laci kasir" (cashier app): cash paid at delivery with amount, why
(barang → a supplier payment `[dari kas]` allocated to the note; ongkos kirim / bongkar / lainnya → a drawer expense), time, note and a
required photo, all inside the same `save_purchase` (`data.drawer_pay`, `pos_purchases.drawer_pay`); the confirmation then records no
second payment.

**New versions reach phones by themselves (v49):** `shared/app-update.js` (KUpdate) re-reads the app's own page
(`cache:'no-cache'`, a 304 when unchanged) on open, on return to the screen (≥5 min) and every 30 min; another
`APP_VERSION` there → it reloads itself on the login screen / when untouched since it opened, otherwise a green
"Perbarui / تحديث" bar (one tap, the session stays); never twice for the same version. The service workers fetch pages
and code with `cache:'no-cache'` too. So **always bump `APP_VERSION`** with every app change: it is the update signal.
**The version is always on screen (v69, owner 2026-10-20: «عند فتح التطبيق اريد ان ارى عدد الإصدار»):** on every login screen and in
every app's top bar, phones included (owner `#tb-sub` "POS · v…", the store key only on computers; kasir `#tb-ver`; sales `#tb-user`;
gudang (now `APP_VERSION` + KUpdate too) and Brad `#hd-ver` under the title). The first time a new version opens on a phone, KUpdate
shows a short green note "Aplikasi diperbarui ke versi …" (`#kupd-ok`, `localStorage kupd.seen:<app folder>`; never on a first
install, never blocks a tap).
**v70 (owner 3.1.2, kasir 1.8.2, sales 1.9.9):** text keys defined twice with different texts showed the later text on both
screens (Beranda "Semua aman" → "Belum ada pekerja…", the drawer-opening approval → the bank help, the field orders map → "Penjualan &
faktur hari ini", the photo list's "Referensi"); each screen now has its own key, and `tests/i18n-keys.spec.js` fails on any new such
clash (add a deliberate replacement to its `REPLACED` list). Photo API `scan_expense` with `data.read === false` = an evidence photo
(the cashier's drawer payment at goods-in): stored in R2 + `pos_photos` without the AI call (`ai: 'skipped'`, `extracted.stored_only`,
no "perlu cek").
**Security (v71, owner 2026-10-21: «حماية التطبيق حتى لا يتمكن أي شخص من اختراقه … سرية تامة»):** one login gate in front of EVERY
endpoint (`worker/src/authgate.js`, called by `index.js` for POS / field / chat / att / photo + its file GET / cold / Brad): the store key
first (constant time, no D1 read when wrong — a flood cannot use up the free reads), then the PIN against `pos_users` only; wrong PINs
are counted on all endpoints together and lock longer each time (5 → 15 min, 10 → 1 h, 15 → 6 h, 20+ → 24 h), each lock logged for the
owner (activity kind `keamanan`, danger); a refusal writes nothing else. Data per role: no POS bootstrap for sales reps; a cashier's
settings without `brad_*` / `cold_*` / `att_*` / lala / `locked_accounts` / `limit_agreements`; a cashier's `get_sales` = 62 days of
sales / items / goods-in + own drawer via `shiftOut`; `list_photos` owner / manager / accountant only (supplier unit prices per
`akuntan_sees_cost`); notices and the "Balas" quote hide cost prices / margins (`noticeOut`, `ntSafeText`); a master-code session never
edits an owner account. Never put personal data (names, phones, bank accounts, addresses) or anything about the store key (length,
hashes) in the repo: it is PUBLIC.

**Backend = "Khair Mart Jumla" (الخير مارت جملة) — LIVE since 2026-10-10.** The owner, cashier
and field-sales apps point at the Cloudflare Worker `https://khair-mart-jumla.officezied.workers.dev`
(D1 database `khair_mart_jumla`, account `c82e2561b81c97de7c59166d7a915924`). Source under
`khair-pos/worker/`: all five workflows (POS, Field, Chat, Attendance, Photo) built from
`khair-pos/backend/*` (the single source of truth, wrapped at build time) — so edit backend
logic in `backend/*`. **Deploy is automatic (v36):** `.github/workflows/worker-deploy.yml` tests and deploys the
Worker on every push to `main` that touches `khair-pos/backend/**` or `khair-pos/worker/**`, once the owner has added
the repo secret `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + D1:Edit + Workers R2 Storage:Edit); it creates/binds
the R2 photo bucket `khair-mart-photos` when it can, smoke-tests and rolls back on failure. Without the secret it
skips with a notice (manual fallback: `cd khair-pos/worker && npm run build && npx wrangler deploy`). New D1
columns/tables are added by the Worker itself at runtime (no migration step). `.github/workflows/tests.yml` runs
the worker tests + the three Playwright suites on every PR. This removed n8n's monthly execution wall (the outage cause).

- **n8n (ziedapp.app.n8n.cloud) is KEPT PERMANENTLY as a reference — NEVER delete or modify it**
  (owner's standing instruction). It also stands as instant rollback: revert the apps' host
  swap (`ziedapp.app.n8n.cloud` ↔ the Worker host) in `index.html`/`kasir/`/`sales/` + CSP.
- Google Places search (field app, v34) runs ONLY in the Worker with the secret `GOOGLE_PLACES_KEY` (set by the owner in the
  Cloudflare dashboard — never in the repo/apps); hard cap 4,500 calls/month (`pos_api_usage`) < Google's free 5,000 →
  bill 0; over the cap / no key → the apps keep the free OpenStreetMap search. Only "Pro" fields (no phone/rating/hours).
- `gudang/` (cold storage, `/webhook/khair-cold`) moved to the Worker in Batch C (PR #22) and is shown inside the owner
  app; Phase 2 proper (WhatsApp + Lalamove) is still to do (plan in `khair-pos/worker/docs/phase2-plan.md`).
  Products (v62, owner 2026-10-19: «المدير يعدل و المحاسب بإذن من المدير»): owner and manager edit them (`product_save`); the accountant
  only proposes (`product_request` → table `cold_product_requests`), applied when the manager / owner approves (`request_decide`). The
  manager and the accountant see a "Produk" tab (products only — the rest of the settings stay the owner's).
- **Packaging materials (v63, owner 2026-10-20):** a sticker / jar / box is received at goods-in like any goods (cashier "Produk baru" →
  "Bahan kemasan"): category `Bahan kemasan`, no selling price, `use_for` = JSON `[{p: packId, q: pieces per pack}]`; its price per piece is
  its goods-in cost (weighted average). Never sold (`computeSale` refuses it). The pack's cost includes `cost_price × q` of each material;
  a confirmed repack (`repack_finish` / `applyRepack`) takes `q × made` out of its stock (never below 0, "STOK KURANG" in the notice) with
  a `KEMAS ULANG` purchase row. The manager OR the accountant confirms the packs made (the accountant from her approvals screen); the
  owner's notice carries the cost of one pack (curah, bahan, upah & lain).
- **Khair Order Brad (`brad/`, v60) = stage 1 of that plan as its OWN app until the owner has proven it** (owner 2026-10-18: «في تطبيق
  اخر الان منفصل حتى نتأكد منه قبل دمجه مع القديم»; the gudang app stays exactly as before — do not add the order process to it until he
  says so). Logic `backend/brad/brad-core.js` (KBrad, loaded after cold-parsers + cold-core), Worker `/webhook/khair-brad` (`worker/src/brad.js`).
  Own table `brad_orders` + `pos_settings` keys `brad_*`; it only READS the gudang tables, except the OUT movements written when a car
  leaves (`depart`). The owner's 9 steps with one-tap `wa.me` messages (the cold stores accept only WhatsApp), the order read from a photo /
  message (`claude-haiku-5-5`, unclear photo lines once more by `claude-sonnet-5-5`; no key → rules), the coolers' hours (last order 16:00,
  overtime Rp 300k per started hour after 17:00, Sunday by arrangement with an agreed cost, holidays, Lalamove minutes + 20 %, loading
  30 min a pallet). Time-dependent, so its Playwright tests (`tests/brad.spec.js`) fix the page clock. Own `APP_VERSION` in `brad/index.html`.
  **Stage 2 (v61): automatic WhatsApp** through Meta's official Cloud API (`worker/src/wa.js`, webhook `/webhook/wa`, log `brad_wa_log`):
  the order / car / door / departure go out as approved templates; the cold store's quick-reply buttons and replies ("pintu 12") move the
  order only from its own number (`KBrad.waEvent`, fixed rules). Secrets `WA_TOKEN`, `WA_PHONE_ID`, `WA_WABA_ID`, `WA_APP_SECRET`,
  `WA_VERIFY_TOKEN` (owner, Cloudflare dashboard — never in the repo); without them, over the monthly cap (`brad_wa_cap`, default 3,000)
  or on a refusal, the app sends by hand (wa.me) as in stage 1. Setup steps: `worker/docs/whatsapp-setup.md`. Demo of the whole
  automatic process: `brad/?mock=1&wa=1` (v61.1: on each order a simulated phone of the cold store / driver / customer, with the
  cold store's buttons and a "pintu N" reply to tap). **v62 (app 1.2.0):** the customer books the car himself ("Dipesan pelanggan",
  `via 'pelanggan'`): his WhatsApp message is pasted, `KBrad.parseCarMsg` proposes driver / plate / WhatsApp / vehicle / minutes /
  tracking link (fixed rules), the trip keeps `customer_msg` + `track_url`; the hand-sent car text carries the link, the approved car
  template keeps its six values (no link).
  **Stage 3 (v63 Brad 1.3.0): the Lalamove car booked automatically** (owner 2026-10-20: «ابدأ المرحلة الثالثة: طلب سيارة لالاموف تلقائيًا»),
  Lalamove's official Partner API v3 (`worker/src/lalamove.js`, HMAC-signed like its SDK `@lalamove/lalamove-js` 1.1.0): a fourth
  way in the car step, "Pesan Lalamove otomatis" — `lala_quote` (the cooler → `dest_lat`/`dest_lng` of the order, else the shop's
  `brad_store_geo`) → `lala_book` (priced again; > 5 % above what staff saw = `PRICE_CHANGED`; the month's cap `brad_lala_cap`,
  default Rp 10 jt, 0 = off; a booking lock `brad_lala_locks`) → the trip in `car` (`via 'lalamove_api'`, `lala_order_id`,
  `share_link`, `lala_status` …). The pure core decides everything (`lala_plan`, and system requests `req.__sys === 'lalamove'`
  that only the Worker sets: `lala_booked`, `lala_sync`, `lala_cancelled`, `lala_due`, `lala_services`); the Worker only talks to
  Lalamove. Followed by a cron every 2 min (`wrangler.toml [triggers]`, no-op without keys), the app's refresh (≥ 90 s, ≤ 5 trips)
  and `/webhook/lalamove` (body never trusted: it only triggers a signed re-read): driver found → driver/plate to the cold store
  (the stage-2 car template); picked up at door/loading → `depart`; completed → delivered; cancelled/expired → back to ready.
  "Batalkan Lalamove" = DELETE at Lalamove first. Places pasted as Maps links / WhatsApp locations / "lat,lng" (`KBrad.geoOf`;
  short links via `gmaps.js`). Secrets `LALAMOVE_KEY`, `LALAMOVE_SECRET`; plain var `LALAMOVE_ENV=production` to go live
  (sandbox by default) — dashboard only, never `[vars]` in `wrangler.toml`. Without them / over the cap / refused → the three
  manual ways. Setup: `worker/docs/lalamove-setup.md`; demo `brad/?mock=1` (a simulated Lalamove on the card's demo phone).

## Owner standing rules — ALWAYS honor

- **Reliability FIRST, then cost (recommend best + cheapest, proactively).** The owner
  (Khair Mart, Jakarta) wants a system that is **strong, stable, and always-on**, that
  does NOT stop and does NOT depend on staff being present — he travels a lot and cannot
  babysit it or rely on employees to keep it running. So the top priority is a solution
  that keeps working on its own. He is still cost-conscious, but cost is the tie-breaker
  AMONG reliable options, not the first filter. For EVERY technical choice, state the
  **most reliable** option AND the **cheapest** option together, flag the trade-offs,
  and recommend BEFORE the owner decides — do not wait to be asked. (Owner's standing
  rules, set 2026-10-10, refined 2026-10-10: reliability over pure cost.)

- **Watch execution/running cost — but never at the expense of uptime.** The POS once
  hit the n8n Starter plan's monthly execution limit because the apps polled too often,
  and that one quota wall took down ALL apps (login failed for everyone) until support
  reset it. That "whole business stops at once, owner must intervene from abroad" failure
  mode is exactly what the owner wants gone. Keep backend calls lean (polls are throttled
  and pause when the tab is hidden; device ping is hourly), and when adding features,
  consider their recurring-cost impact — but prefer architectures with no hard monthly
  cap that can halt everything.

- **Merge it yourself — never ask.** Once a change is built, tested (the app's Playwright suites
  green) and pushed, open the PR and squash-merge it into `main` yourself; do not ask the owner
  "shall I merge?" (owner's standing instruction, 2026-10-11: "لا تسألني عن الدمج بعد الآن يجب أن
  تدمج أنت كل شيء"). Then tell him the new app version to check on the login screen.

- **Mixed Arabic/English text:** when writing Arabic and a word/term is English, put each
  English token on its own line, then continue the Arabic on a new line (keeps the
  right-to-left reading order clean).
