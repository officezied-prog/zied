# Phase 2 plan — cold storage inline + WhatsApp + Lalamove dispatch

Phase 1 (all five POS workflows on code as **Khair Mart Jumla**) is built and tested; Phase 2
runs **after** the Phase-1 cut-over, on the same Cloudflare Worker + D1 backend. This captures
the owner's requirements so they aren't lost, and maps them onto the code backend. Reliability
first, then cost (owner's standing rule).

## Update 2026-10-18 — the owner's real process, the cold store's hours, the recommended design

Status: A (cold storage on the Worker) and the inline UI are done (Batch C, PR #22). The dispatch
automation below is proposed to the owner and **awaits his go** (stage 1 needs no accounts).

### The process today (owner 2026-10-17, all by WhatsApp by hand)
1. Write the order: quantity, product, pallet number, product code.
2. Send it to the cold store (البراد). 3. The cold store approves. 4. It prepares and says so.
5. Book a car in the Lalamove app; send its plate + the driver's number to the cold store.
6. Confirm the car arrived — or it is cancelled and another is searched for.
7. Tell the car which door (رقم الباب) to drive to. 8. Loading.
9. Tell the customer / the shop the car has left.

The gudang app already models these as order states (open → sent → approved → ready → dispatch →
driver → picked → delivered, `backend/cold/cold-core.js` FLOW); every step is a manual tap plus a
`wa.me` message someone sends and a reply someone reads.

### The cold store's hours (owner 2026-10-18) — every timing rule follows from these
- Normal hours 09:00–17:00, break 12:00–13:00. **Last order in normal time: 16:00.**
- **Overtime: Rp 300,000 per hour**, counted when the car has not entered and registered by 17:00.
- So the app must prevent overtime before it happens:
  - an order made after 16:00 is queued and sent at 09:00 on the next working day, unless the
    manager accepts overtime with its estimated cost shown;
  - the car is booked to reach the cold store outside the 12:00–13:00 break (Lalamove scheduled
    order) and well before 17:00; a booking whose expected arrival is too late is held, and the
    manager chooses between tomorrow 09:00 and accepted overtime;
  - alerts to the manager / owner: a ready order with no car by ~15:30; a car not arrived by ~16:30;
    a car cancelled after 16:00 is re-booked at once with the overtime risk named;
  - overtime that happens anyway is recorded on the order (hours × Rp 300,000, and why: late order,
    cold store late, car late / cancelled) so the owner sees what it cost and who caused it.
- Still to ask the owner: working days / public holidays; is a started overtime hour charged in
  full; how long a Lalamove car usually takes to reach the cold store; how many cold stores, loading
  doors and minutes of loading per car (to space the cars so they do not queue at the doors).

### Volume and what it costs (owner 2026-10-18: up to **200 orders a day** across all cold stores)
≈ 5,200 orders a month. Manual WhatsApp work cannot keep up; the design has to be automatic and cheap per order.
- **n8n agent:** ~15 executions an order → ~78,000 a month, beyond n8n Business (40,000). Ruled out.
- **WhatsApp Cloud API:** since 1 Oct 2026 every business-sent message is charged (service replies are no
  longer free beyond 1,000 a month per number): Indonesia utility ≈ Rp 357 (US$0.025) a message; incoming
  messages cost nothing. All steps by WhatsApp ≈ 4–5 sends an order ≈ Rp 7–8 M a month. So:
  - **the cold store works on a link page** (its own orders today, buttons: setuju / tolak, siap, door
    number, sudah dimuat; a secret link per cold store, any phone, no install, no cost) and WhatsApp is kept
    for the driver's door message and the customer's departure message (≈ 2 sends an order ≈ Rp 2–4 M a
    month), plus batched alerts to the cold store;
  - unofficial WhatsApp gateways (flat cheap monthly) are rejected: the number can be banned and the whole
    flow stops — against the reliability rule.
- **AI:** customer messages / order photos read with `claude-haiku-5-5` first (≈ $0.0005 a photo) and only
  unclear ones with `claude-sonnet-5-5` (≈ $0.01) → ≈ US$15 (≈ Rp 250 k) a month at this volume.
- **Lalamove:** trip fees as today; the app should also propose grouping orders for the same cold store and
  area into one bigger vehicle (it already sizes vehicles by weight: `KCold.vehicleFor`) — likely the
  largest saving of all at 200 orders a day.

### Recommended design (reliability first, then cost)
- **Code on this Worker**, not an n8n AI agent: no monthly execution wall (an order is ~15 n8n
  executions — WhatsApp messages + Lalamove updates — so ~900 orders/month would pass the 10,000
  of n8n Pro; that kind of wall is what took every app down before), and money decisions (booking
  a car) stay fixed rules, never an agent's judgement. n8n itself stays untouched (reference).
- **The cold store's link page** for its buttons (Setuju / Tolak, Siap, door number, Sudah dimuat) and the
  **WhatsApp Cloud API** for the sends that must reach a phone (see "Volume and what it costs");
  **Lalamove API** for booking, driver/plate, arrival, cancel → rebook.
- **AI only where there is no button**: free-text replies (e.g. a door number in a sentence), a photo
  of a handwritten order, a customer's order message → a draft order the manager confirms.
  `claude-haiku-5-5` for short replies (≈ $0.0003 a reply), `claude-sonnet-5-5` for photos
  (≈ $0.01 a photo). A message the AI cannot read goes to the manager.
- Manual buttons stay as the fallback when WhatsApp or Lalamove is down.

### Stages (each one works on its own)
1. **Now, no accounts needed:** order from a photo / a customer message (AI), the hours rules
   above (16:00 cut-off → next morning, break, 17:00 deadline alerts, overtime recorded), door
   number, car cancelled → another car, departure message to the customer; messages stay one-tap.
2. **After the owner's WhatsApp business number is verified (Meta):** automatic sends, buttons,
   replies read.
3. **After Lalamove grants API access:** car booked, tracked and re-booked automatically.

## Owner's requirements (verbatim intent)

1. **Cold storage inline.** The cold-storage app (`gudang/`, "Khair Gudang Dingin") is today a
   separate app with its own login. It must open and close **inside** the main app like any
   other section — no jumping to a separate page and back, no second login.
2. **Automated dispatch flow:**
   - an order message is watched; the cold store is notified, prepares, and replies;
   - when the reply says the order is **ready in the cold store**, the app automatically asks
     the transport company **Lalamove** for a vehicle (sender = cold store, recipient = the
     delivery address);
   - Lalamove assigns a driver; the app reads the **plate number** and sends it back to the
     cold store so the goods are handed to that exact vehicle.
3. Messaging is over **WhatsApp**, using the official, reliable channel.

## A. Cold storage → code (same pattern as Phase 1)

The cold backend (`backend/cold/`: `cold-core.js` = `KCold.core`, `process-cold.js` wrapper,
`$('Parse Cold')`, `{response, ops/writes}`) ports exactly like the other four:
- add its tables (cold warehouses / pallets / containers / movements / orders / trips …) to
  `worker/tables.js`, regenerate `schema.sql`;
- add `cold` to `build.js` PROCESSES (wrap `cold-core.js` + `process-cold.js`);
- add `src/cold.js` (parse + loaders + ops map) and a `/webhook/khair-cold` route;
- parity-test it the same way (transform-equivalence + loaders + writers).

**Inline UI:** fold the `gudang/` screens into the main app as a section (like the other
pages), reusing the single session/login instead of `kcold.session`. The cold section calls
the same backend host (one CSP entry, one login). This removes the extra window and the second
login the owner dislikes.

## B. WhatsApp — official Cloud API (reliable, not the cheap-but-bannable route)

- **Use** WhatsApp Business **Cloud API** (Meta). Official, stable, no monthly wall; messages
  are cheap (service replies within 24h free up to a monthly cap, utility templates a few
  cents). **Do not** use unofficial libraries (free but violate WhatsApp terms and get the
  number banned — the opposite of "must not stop").
- **Receive:** a new Worker route `/webhook/wa` verifies Meta's signature and ingests inbound
  messages (the cold store's replies, customer order messages).
- **Send:** a small `sendWhatsApp(to, text)` helper calls the Graph API with a secret token.
- **Owner provides:** a Meta Business account + a dedicated business number (not his personal
  WhatsApp) + business verification (can take a few days) → secrets `WA_TOKEN`, `WA_PHONE_ID`,
  `WA_VERIFY_TOKEN`.

## C. Lalamove dispatch — the state machine

Verified: Lalamove has a v3 API in Indonesia (`https://rest.lalamove.com/v3`, HMAC-SHA256
signed, `Market: ID`): quotation → place order → **get driver details incl. `plateNumber`** →
webhook status updates. That matches the flow exactly.

A `cold_orders` row carries a `dispatch_status`; the Worker advances it:

```
NEW ──notify cold store (WhatsApp)──▶ PREPARING
PREPARING ──cold replies "ready"──▶ READY
READY ──Lalamove quotation + place order (sender=cold store, recipient=address)──▶ CAR_REQUESTED
CAR_REQUESTED ──Lalamove webhook: driver assigned──▶ CAR_ASSIGNED
          └─ read plateNumber + driver name/phone, WhatsApp them to the cold store
CAR_ASSIGNED ──delivered / Lalamove COMPLETED──▶ DONE   (CANCELED/REJECTED → back to READY, retry)
```

- Transitions are driven by inbound events (the cold store's WhatsApp reply; Lalamove's
  webhook), so nothing polls and nothing stalls — it runs unattended while the owner travels.
- **Owner provides:** a Lalamove business API account → secrets `LALAMOVE_KEY`,
  `LALAMOVE_SECRET`. Delivery fees are paid to Lalamove per trip as usual; the code adds no fee.

## Cost summary (reliability first, then cost)

| Piece | Reliability | Monthly cost |
|---|---|---|
| Cold storage on the Worker/D1 | same no-wall backend as Phase 1 | within the free tier |
| WhatsApp Cloud API | official, stable | ~free for the shop's volume (per-message, cheap) |
| Lalamove API | official + webhook status | only the per-trip delivery fee (no software fee) |

## Sequence

1. Finish the Phase-1 cut-over (apps on Khair Mart Jumla, n8n kept as reference).
2. Port cold storage to the Worker + fold its UI inline.
3. Add WhatsApp (receive + send) once the Meta business number is verified.
4. Add the Lalamove dispatch state machine.

Nothing here is built yet; it is the agreed Phase-2 scope recorded for when Phase 1 is live.
