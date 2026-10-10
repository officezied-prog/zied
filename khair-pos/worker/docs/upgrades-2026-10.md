# Owner upgrade requests — October 2026

Two batches from the owner (zied). Reliability-first, then cost. Backend logic lives in
`khair-pos/backend/*` (single source of truth, wrapped into the Worker at build time); apps are
`khair-pos/kasir/` (cashier), `khair-pos/sales/` (field rep), `khair-pos/index.html` (owner).
n8n is kept as reference — never touched.

## Approver / notification model (shared by #1, #6, #7 below)

- New `approver_role` value **`mgr_akuntan`** = manager OR accountant may decide. Owner can
  always decide. Accountant (`akuntan`, read-only till now) gains `list_approvals` +
  `decide_approval` but ONLY for `mgr_akuntan` approvals.
- Notifications = the activity log (`logAct`) the owner already watches, plus the approvals
  inbox the manager watches. When the ACCOUNTANT decides a `mgr_akuntan` item, an extra activity
  line is written addressed to the manager ("notify manager"); the owner sees the log either way.
- Owner app (`index.html`) must let `akuntan` see + decide the `mgr_akuntan` approvals (poll gate
  + `can_decide`). Manager already has the approvals inbox in the cashier app.

## Batch A — Cashier app (kasir/) 8 features

1. **Goods-receipt review + mismatch approval.** Invoice photo (AI reads items/qty via
   `scan_purchase`), receiver types the qty THEY counted. If counted ≠ invoice → raise a
   `purchase_mismatch` approval to manager+accountant (`mgr_akuntan`); accountant approve →
   notify manager. Stock-in is recorded at the counted qty immediately (goods physically present);
   the approval documents the discrepancy. Match → auto-accept, no approval. (Backend `save_purchase`
   already runs `matchNote`; add the approval + routing.)
2. **Carrier "friend" (teman).** When carrier = friend, add transport kind (motor/mobil) + plate
   number. `readCarrier` already stores type/name/vehicle/kind/phone — frontend adds the picker.
3. **Close drawer by denomination.** Enter count per banknote (100k/50k/20k/10k/5k/2k/1k + coins);
   app sums → counted_cash. Store breakdown in the shift `note` (no schema migration).
4. **Expenses: optional invoice photo + AI verify.** New photo action `scan_expense` (kind `biaya`)
   reads the invoice total; `save_expense` compares to the entered amount, flags mismatch (reason
   required), mirrors the debt-payment slip pattern.
5. **Remove member registration from the cashier.** Cashier cannot create members (remove
   `member-new` from More + the inline "make member" checkbox for role kasir). Backend `save_customer`
   rejects `member:true` from kasir. Registration by manager/accountant; owner+manager notified.
6. **Void today's invoice.** Cashier requests → manager OR accountant (`mgr_akuntan`). Manager
   approve → notify owner; accountant approve → notify manager + owner. (`request_void` approver_role
   owner → mgr_akuntan.)
7. **Price change.** Request → manager AND accountant (`mgr_akuntan`); owner notified. cost_price
   change stays owner-only. (`change_price` non-cost approver_role manager → mgr_akuntan.)
8. **Last receipt → last 4.** `last-rc` shows the last four receipts with times (picker), tap to
   open. `rememberReceipt` already keeps 40 locally.

## Batch B — Field-sales app (sales/) — NEW (owner msg 2026-10-10)

1. **Bigger map** on the daily route (currently small).
2. **Pre-start route plan (8am).** Before starting, the rep marks the route/start point/streets to
   work. App records streets already worked so they aren't repeated for a long time; reminds the rep
   to return to the best streets (those with customers + good response). The return interval to a good
   street is agreed with the manager; owner gets a notification.
3. **Visits table.** Columns: name, place, shop type, shop owner, rep's impression (star rating
   good/bad), optional note. A copy of the table goes to manager + accountant + owner for monitoring.
4. **New-shop registration.** Space to register a new shop with all data: location (GPS), photo,
   photo with the worker/owner, phone number, shop photo; any orders written in a dedicated place; app
   organizes it into the table.
5. **Order organization toggle.** Organize orders by region (to batch deliveries per region), by
   quantity, and by payment method — rep picks the grouping via a button.
6. **Orders on the map (numbered markers).** Each accepted order drops a marker at its shop's GPS
   location with a sequence number (acceptance order), so the owner sees which area/region has the
   most orders and who ordered first. Feasible with Leaflet markers + per-area count (same map as #1).

## Batch C — Cold-storage app (gudang/) — NEW (owner msg 2026-10-10)

1. **Customer registry.** Always register the customer with full details (name, address, phone) →
   a reusable customer list; tapping a customer auto-fills the rest of the entry.
2. **Home page = coolers.** Named coolers (e.g. Bosco, DP, BP). Each cooler shows the date type
   (نوع التمر) and its mode: chilling (تبريد) / storage (تخزين) / freezing (تجميد) / normal (براد عادي).
   Under each cooler name show the totals: how many pallets (palet), how many cartons (karton), how
   many kilograms (kg).

Order of work: finish Batch A (cashier) first (in progress), then Batch B (field), then Batch C
(cold storage). Phase 2 proper (cold inline + WhatsApp Cloud API + Lalamove dispatch) folds into
Batch C. gudang/ is still on n8n today — moves to the Worker as part of this.
