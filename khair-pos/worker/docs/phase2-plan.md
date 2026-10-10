# Phase 2 plan — cold storage inline + WhatsApp + Lalamove dispatch

Phase 1 (all five POS workflows on code as **Khair Mart Jumla**) is built and tested; Phase 2
runs **after** the Phase-1 cut-over, on the same Cloudflare Worker + D1 backend. This captures
the owner's requirements so they aren't lost, and maps them onto the code backend. Reliability
first, then cost (owner's standing rule).

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
