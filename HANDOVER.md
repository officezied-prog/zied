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
- **Waiting for the owner's paste:** `backend/process.js` v17 = accountant role `akuntan` (read-only) + settings
  `invoice_due_days` (14) and `akuntan_sees_cost` (false). Tests: `harness17.js`; harness16/16base unchanged apart from ids.
  The client part (owner app role, read-only views, settings panel "Faktur & akuntan") is on branch
  `claude/khair-v17-akuntan` and goes to main only after the paste is verified.
- Settings stored 07 Oct: wa_shop_number 6285810454694, wa_owner_number 6281322091202, wa_manager_number 6281190008090.
  Shop hours 08:00–21:00; from two months before Ramadan to Eid 08:00–23:00 (season in Absensi → Jam kerja, not set yet).
- Owner's request still open: cold-storage date warehouses (pallets/containers, daily WhatsApp stock check, pick orders,
  truck call) — waits for the owner's samples.

- Leaflet 1.9.4 is vendored in `vendor/leaflet` (no cdnjs; CSP no longer allows cdnjs). Khair Sales cache is `khair-sales-v3`.
- Khair Sales: swiping in presentation mode on the product photo now works (image drag cancelled the swipe).

## Ideas noted, not built

## Paused until the real launch (07 Oct, owner's decision)
The shop has not started real work yet. Paused: Claude routine "Khair Mart – تقرير الصباح" (trig_01Lj7zLWVfr54bVpHwkEthr5, disabled),
n8n agents "المراقب — Khair Mart Supervisor" (1N9dy9vt13QCVkPM) and "مراقب التواصل — Khair Mart Social Watch" (UEmt2aI5fsUqBWY1),
both unpublished. On launch day: re-enable the routine (update_trigger enabled=true) and publish both agents again (publish_agent).
The marketing brain agent (4OipUFmiFhUN2ADr) stays published (it only answers when asked).
