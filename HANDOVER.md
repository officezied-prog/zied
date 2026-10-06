# Khair Mart — handover (07 Oct 2026, v16 live)

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
- **Not yet deployed:** `backend/field/process-field.js` v16 auth (master code, lock, must_change, input cleaning) — deploy when reps start.
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

## Ideas noted, not built
- Separate photo kind for supplier-return exit receipts (now uses scan_purchase).
- Leaflet SRI hashes (cdnjs was unreachable from the build container).
