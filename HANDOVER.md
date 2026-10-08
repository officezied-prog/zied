# Khair Mart — handover (07 Oct 2026, v16 live + v17 parts)

Start a new session with: "Read HANDOVER.md and continue." Everything needed is in this repo and in n8n; the old chat is not needed.

## Owner
- Khair Mart, Jl. Raya Condet No.4, Jakarta Timur (wholesale: Khair Grosir). Owner account: **zied salah**.
- Writes in Arabic. In Arabic replies put every English/Latin word on its own line.
- Never commit the store key (it lives only inside the n8n code nodes) or anyone's PIN. Never clear live tables.
- Don't name or blame the previous owner publicly (UU ITE). Consent (UU PDP) for surveys, location, photos. No health claims (BPOM).

## Links (GitHub Pages, branch `main`)
| App | Link | Who |
|---|---|---|
| Owner / manager | https://officezied-prog.github.io/zied/khair-pos/ | zied salah (owner), Jihan (manager) |
| Cashier | https://officezied-prog.github.io/zied/khair-pos/kasir/ | Emma, Najwa, Edit, Diun (+ Jihan when cashiering) |
| Field sales | https://officezied-prog.github.io/zied/khair-pos/sales/ | Wahyu (temporarily; owner changes his role kasir → sales in Users) |
| Trial (demo data) | add `?demo=1` to any link; `khair-pos/demo.json` `{"open": true}` closes/opens trials | anyone |

Accounts were created on 07 Oct with temporary PINs (given to the owner in chat, not stored here); everyone must choose a new PIN at first
login. The owner sets his 8-digit master code in his app → Settings → Kode pemilik (opens every account; every use is logged).

## n8n (ziedapp.app.n8n.cloud, project w58qjNXPtPmWJPB6)
| Workflow | ID | Source in repo |
|---|---|---|
| POS API `/webhook/khair-pos` | gAa6F12DXjVKJXSN | `khair-pos/backend/process.js` (Process node), `parse-request.js`, `finalize.js` |
| Photo `/webhook/khair-pos-photo` | A7XeUITjTJRU9RYB | `khair-pos/backend/photo/` |
| Field `/webhook/khair-field` | BzPYKlfdk6tY2Ui5 | `khair-pos/backend/field/` |
| Chat `/webhook/khair-chat` (Phase 3) | GaUrZBH6Xb9RRcgE | `khair-pos/backend/chat/` (Process Chat node), `parse-chat.js` |

- **Process code:** the safety system blocks me from writing the big Process node myself (and from loader tricks). The owner pastes it:
  build the file = `backend/process.js` with `'__STORE_KEY__'` replaced by the real key (read the key from the live Process node via
  `get_workflow_details`), send it privately with SendUserFile, he pastes into the Process node (Esc / Ctrl+S to save), then verify the
  deployed jsCode equals the file before publishing. Small nodes, filters and data tables can be edited directly (`update_workflow`).
- **Deployed 07 Oct:** `backend/field/process-field.js` v16 auth (master code, lock, must_change, input cleaning) in the Field workflow.
  The MCP transport writes the four direction characters of the cleanInput regex (\u202A-\u202E, \u2066-\u2069) literally:
  compare with those four normalised; behaviour is identical.
- Data tables: pos_* (users, products, customers, sales, sale_items, payments, purchases, settings, approvals, photos, expenses, shifts,
  devices, repacks, activity, bank_lines, returns, shops, visits, tracks, field_days, field_orders, product_images).
- Settings already stored: bank account BNI 1229517397 (zied salah). Return limit for owner approval Rp 2,000,000 (changes only by
  owner–manager agreement in Settings).

## Contract and tests
- API contract: `khair-pos/API.md` (v16 sections at the end).
- Server tests: `khair-pos/backend/harness/` — put the key in `storekey.txt` there (git-ignored), then `node harness16.js` (v16 rules)
  and `node harness16base.js` (old suite; compare with `expected-v15-suite.txt`, only intended differences).
- App tests (Playwright): `khair-pos/tests` (owner, 124), `tests-kasir` (86), `tests-sales` (29) — `npx playwright test` in each.
  Last full run 07 Oct: all green.

## Open questions for the owner
1. WhatsApp numbers (company, manager, owner) and report time (default 21:00).
2. Shop location for the device map: press "use my location" in Settings while in the shop (map short links are blocked here).
3. Automatic receipt e-mail: recommended option is connecting Gmail in n8n (free); Google Drive credential for full-size photos (owner said yes —
   he must connect both in n8n → Credentials, then add the nodes).
4. Accountant role and the final rep: not decided yet.

## v17 (07 Oct, second session)
- **Live:** supplier-return photos have their own kind (`scan_supplier_return`, kind `retur`; photo workflow published).
- **Live:** A4 documents from `shared/docs.js` — Faktur (grosir/eceran, due date + banks when there is debt), Surat jalan,
  Penawaran (from the cart), Tanda terima barang masuk, Rekap tagihan (owner customer detail). Both apps.
- **Live:** face attendance. Workflow "Khair Mart POS – Absensi" `g0O8lG5tqlRD9WPs` (`/webhook/khair-att`), tables pos_workers,
  pos_attendance, pos_att_seals; code `backend/attendance/` (`node test-core.js`), deployed Process Att = att-core.js + process-att.js
  with the key (verify equality after any change). Face library vendored in `vendor/face-api`. Owner app menu "Absensi";
  Khair Kasir "Lainnya → Absensi pekerja". Records are append-only and hash-chained; never "clean" these tables.
  No workers added yet: the owner adds them and registers faces with the worker's consent.
- **Deployed 07 Oct (owner pasted, verified equal, published):** `backend/process.js` v17 = accountant role `akuntan` (read-only) + settings
  `invoice_due_days` (14) and `akuntan_sees_cost` (false). Tests: `harness17.js`; harness16/16base unchanged apart from ids.
  The client part (owner app role, read-only views, settings panel "Faktur & akuntan") is on main.
- Settings stored 07 Oct: wa_shop_number 6285810454694, wa_owner_number 6281322091202, wa_manager_number 6281190008090.
  Shop hours 08:00–21:00; from two months before Ramadan to Eid 08:00–23:00 (season in Absensi → Jam kerja, not set yet).
- 07 Oct, owner's decision (two doors): the owner app `khair-pos/` lists ONLY the owner on its login screen. All staff
  (manager, accountant, cashier, sales) log in at Khair Kasir `khair-pos/kasir/` (owner not listed there). After the PIN:
  cashier and manager stay in Khair Kasir; the accountant is handed on to the management screens (owner app, read-only);
  sales to Khair Sales; a manager opens the management screens with "Menu manajemen" (Lainnya). Hand-off = the session
  written for the target app in this tab (`kpos.session` / `kpos.sales.session`, pin_hash only in sessionStorage), no
  second PIN. Names only, no role words next to people, in all apps (role pickers in Settings → Users stay).
  `khair-pos/zied/` is a plain redirect to the owner app. Display only — the server checks PIN and role as before.
- 07 Oct: locked screen sends nothing (`api()` throws NetError without pin_hash) — background calls had been counted as
  wrong PINs and locked the owner. Photo-control panel has its own title key `photoc.title` (clashed with the new-PIN title).
- v18 (07 Oct, owner's decision): the manager adds/manages staff accounts — roles kasir, sales, akuntan only, never manager/owner
  nor their accounts (server `save_user` + mock; `harness18.js`). Settings → Users for the manager shows only those groups.
  First choice "Pekerja harian" makes no account: it opens the Absensi worker form (face, no PIN). Process v18 pasted by the
  owner 07 Oct, verified equal (139,990 chars, only the Process node changed), published: active version b2de79d6.
- **v19 (07 Oct, owner's decisions) — needs a Process paste:** (1) the manager creates/manages only kasir and sales accounts
  (never akuntan, manager or owner); (2) a clear code attempt in any field (a run of 3+ of `< > { } [ ] ; $ = | \ \``
  or a code token like `</`, `${`, `=>`, `script`, `document.`) locks that non-owner account — the name is kept in the
  setting `locked_accounts` (no schema change), the server returns TAMPER / TAMPER_LOCKED, the owner opens it with the new
  action `clear_tamper` (owner-only) from Settings → Users; the owner is warned (INVALID), never locked. New action
  `report_tamper` (the app reports a code attempt it caught). All three apps detect code client-side and instantly log the
  user out to the lock screen; the owner sees a banner on open. Server: `backend/process.js`, harness `harness19.js`
  (+ harness16 V1/V6, harness18 M3 updated). Process v19 pasted by the owner 07 Oct, verified equal (144,306 chars, only
  the Process node changed), published: active version 69aa1dc0. Camera capture of people was declined (UU PDP); the lock + owner alert is the
  deterrent instead. Decided but NOT yet built: Phase 2 = manager-performed price correction of already-sold goods with an
  owner banner and the difference in reports + customer debt.
- **v20 Phase 2 IN PROGRESS (price correction) — server engine built + tested, NOT deployed, no UI yet:** new action
  `correct_price` (owner/manager): data {product_id, old_price, new_price, from, to, reason, update_catalog?}. Re-prices every
  non-void sale line of the product sold at old_price in the range. Overcharge (new<old, we owe the customer): the sale total
  is lowered, an account customer's debt is reduced (one accumulated write per customer), any cash overpaid becomes a refund
  record (channel kontak if there's a phone/account, else cadangan = 3-month reserve). Undercharge (new>old, customer paid
  less): NOT auto-billed — a consultation record (manager+owner decide); the item is annotated corrected_price, totals unchanged.
  Records one 'koreksi' approval (status 'done') with per-invoice details, cashiers, and price_setters (who set the wrong price,
  from the 'price' log) for the Errors section. Harness `harness20.js` (overcharge account/umum, undercharge, matching, voids,
  roles, catalog). DONE now: mock parity + owner 'Kesalahan' view to run a correction + Errors list with responsibility +
  action `list_corrections` (owner/manager run; akuntan sees the list). Tests: `tests/correct-price.spec.js` (engine, UI,
  akuntan read-only); akuntan audit-views list updated. Paste file ready at scratchpad `Process-v20.js` — NOT pasted/published.
  COMPLETE (not yet published): reports loss/gain block (daily_report.corrections), refund disputes with photo-verified
  reserve (decide_refund), undercharge consultations (decide_consult: collect/writeoff/return), list_disputes, and every
  incoming transfer payment needs the manager to confirm receipt (transfer_confirm in receive_payment/save_sale +
  decide_approval; a card in both approval inboxes). UI: owner 'Kesalahan' view (run a correction + open refunds/consultations),
  reports 'Koreksi harga' block. Harnesses 20/21/22. Paste file rebuilt: scratchpad Process-v20.js (161,181 chars) — the owner
  must paste it into the POS API Process node and it must be verified-equal + published. Still open for LATER: Phase 3 in-app
  chat; Phase 4 barcode reader in the cashier. A date-dependent payments.spec fixture is guarded with test.skip (seed task filed).
- **v20 paste caution (07 Oct):** the owner's first v20 paste was run through Gemini / a formatter first — it turned `'`→`"`, reflowed every
  line, grew to 191,240 chars and broke the syntax (unexpected `}` ~line 1095). It saved only as a draft (c261c6f7); the live active version
  stayed v19 (69aa1dc0), so nothing broke in production. He must paste `scratchpad/Process-v20.js` **raw, no Gemini / no formatter**; verify the
  deployed Process node equals the file (md5), confirm only that node changed, then publish. Still pending as of this writing.

- **Phase 3 in-app chat (07 Oct, DONE client-side; backend built, 1 owner paste to go live):** a chat between everyone who holds an app
  (phones/tablets/computers). Two channels: `general` (owner, manager, kasir, sales, akuntan) and `owner_mgr` (owner + manager only, private).
  Text + an image (client downscales to ≤180 KB; img-src already allows data:). Retention is owner-set (`chat_set_retention`, setting
  `chat_retention_days`, default 0 = keep forever); messages are append-only. Names only — never a role word.
  - Separate sibling workflow "Khair Mart POS – Chat" `GaUrZBH6Xb9RRcgE` (`/webhook/khair-chat`), new data table **pos_chat** `n7U5yDEesJVkvH2U`.
    Reuses pos_users (auth: same key, PIN, master code, must_change, temporary lock, and the tamper `locked_accounts` list) and pos_settings.
  - Source: `backend/chat/` — `chat-core.js` (pure core, shared with the demo), `parse-chat.js`, `process-chat.js`, `build-chat.js`
    (`node build-chat.js process` = Process Chat code; `node build-chat.js ops` = the update_workflow ops that built it), `test-chat.js`
    (`node test-chat.js`, 37 checks). The store key lives inside **Process Chat** (`__STORE_KEY__`, swapped for the real key on paste, exactly
    like the POS Process node) — the owner pastes ONE node. Verify deployed == `node build-chat.js process` with the key, then publish.
    Process Chat pasted by the owner 08 Oct, checked by a wrong-key test execution (returned BAD_KEY cleanly — no syntax error, real code not the placeholder), **published: active version e05e34c1**. Chat is live.
  - Client: shared floating panel `shared/chat-ui.js` (loaded in all three apps + cached by each SW), demo handler `shared/chat-mock.js`
    (loaded with `backend/chat/chat-core.js` only in `?mock=1`). Each app adds `CONFIG.CHAT_URL`, an `apiChat` wrapper, a chat branch in
    MockServer.request (bypasses the tamper scan — a message may contain symbols), and KChatUI start/stop/setLang on login/lock/logout/lang.
    Tests: `tests/chat.spec.js`, `tests-kasir/chat.spec.js`, `tests-sales/chat.spec.js`. SW caches bumped: owner v4, kasir v2, sales v4.
- **Cold storage "Khair Gudang Dingin" (07 Oct, third session)** — see below.

- Leaflet 1.9.4 is vendored in `vendor/leaflet` (no cdnjs; CSP no longer allows cdnjs). Khair Sales cache is `khair-sales-v3`.
- Khair Sales: swiping in presentation mode on the product photo now works (image drag cancelled the swipe).

## Khair Gudang Dingin (cold storage, v1, 07 Oct)
- Page `khair-pos/gudang/` (owner app menu "Gudang Dingin" for owner / manager / akuntan; same login reused in the same tab). Demo `gudang/?mock=1`.
- The owner's company at the warehouses: PT. SAIDA REZEKI ABADI (default document header, Pengaturan can change it). Warehouses: DPP, Bosko, Kawanishi.
- Code: `backend/cold/` — `cold-core.js` (pure core), `cold-parsers.js` (report readers), `test-cold.js` (`node test-cold.js`), `parse-cold.js`,
  `check-key.js`, `process-cold.js`, `build-workflow.js` (`node build-workflow.js process` = the Process Cold code). Front: `gudang/index.html`,
  `shared/cold-mock.js`, `shared/docs-cold.js`. Tests: `tests/cold.spec.js`. API: `API.md` last section.
- Gemini's code (07 Oct) was only a login stub (key typed into the page each time, no core / parser / documents / tests), so the module was written here
  from `docs/cold-storage-spec.md`; Gemini's login idea (sha256 key:user:pin) was kept.
- n8n workflow "Khair Gudang Dingin" `1QRX6A1FU0PqRtTP` (`/webhook/khair-cold`), tables cold_warehouses, cold_products, cold_containers,
  cold_pallets, cold_movements (append-only, never clean), cold_checks, cold_orders; users from pos_users, settings in pos_settings (`cold_drivers`, `cold_company`).
  The store key lives only in the small node **Check Key** (owner pastes `check-key.js` with his key). **Process Cold** has no key: it is
  `node build-workflow.js process`; after any change verify the deployed jsCode equals that output, then publish.
- Real DPP report (Excel, 3 sheets: STOCK, PID FROZEN, PID CHILLER) is read exactly (checked on the owner's 26 Apr 2025 file: 11 pallets, 2,444 ctn,
  nothing unread). The real file is NOT in the repo (`sample-dpp.tsv/.xlsx` are made-up numbers in the same layout). PID = our pallet code.
  **Status 07 Oct 11:30 WIB:** published (version e7214d43). Check Key holds the key (owner pasted); Process Cold verified equal to
  `node build-workflow.js process` at commit bb24e80 (phase 1). Login works live; no warehouses / products entered yet.
  **Phase 1 of the owner's big prompt (07 Oct, decided with the owner):** stay on GitHub Pages + n8n; a person sends the WhatsApp messages
  (ready texts, Indonesian for warehouses / Arabic for the owner) and books the truck; the app records each step (order flow and inbound flow,
  `log` on each row), zone rates (frozen/chiller/dry), cartons per pallet, container origin/product/cartons, share-file on Android.
  Later phases (Meta WhatsApp Business API, Lalamove API through n8n) wait for the owner's accounts — the full Next.js rebuild in his prompt was declined
  for cost (estimate given: ~Rp 1–4 juta/month to run at 100 orders/day, plus build time).
  n8n edits: never update the workflow while the owner has it open (his save then fails with "someone else updated").
  First use: Cek stok harian → DPP → choose the .xlsx → "Masukkan palet ini sebagai stok awal" (owner). Bosko / Kawanishi: no sample yet;
  they use the generic reader (WhatsApp lines); write `parsers.bosko` / `parsers.kawanishi` when a real message arrives.

## Ideas noted, not built

## Paused until the real launch (07 Oct, owner's decision)
The shop has not started real work yet. Paused: Claude routine "Khair Mart – تقرير الصباح" (trig_01Lj7zLWVfr54bVpHwkEthr5, disabled),
n8n agents "المراقب — Khair Mart Supervisor" (1N9dy9vt13QCVkPM) and "مراقب التواصل — Khair Mart Social Watch" (UEmt2aI5fsUqBWY1),
both unpublished. On launch day: re-enable the routine (update_trigger enabled=true) and publish both agents again (publish_agent).
The marketing brain agent (4OipUFmiFhUN2ADr) stays published (it only answers when asked).
