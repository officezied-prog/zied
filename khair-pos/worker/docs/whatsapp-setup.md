# Automatic WhatsApp for Khair Order Brad — setup (stage 2, v61)

Owner 2026-10-18: «ابدأ المرحلة الثانية: إرسال الواتساب تلقائيًا». The code is built and inactive until the five secrets
below exist on the Worker. Until then (and whenever WhatsApp refuses a message, or the month's cap is reached) the app keeps
sending by hand with one tap (wa.me), exactly as in stage 1 — nothing stops.

## What it does
| Step | Message (template, Indonesian, UTILITY) | To | Buttons → effect in the app |
|---|---|---|---|
| 2 sent | `khair_order_brad` — order no, date, cooler, destination, lines, total | the cold store | Setuju → approved · Tolak → rejected · Barang siap → ready |
| 5 car | `khair_mobil_brad` — plate, driver, ETA | the cold store | Mobil sudah masuk → car in (not after closing: the overtime cause is chosen in the app). A reply "pintu 12" → in at door 12 |
| 7 door | `khair_pintu_brad` — the door | the driver | — (also sent by itself when the cold store's reply gives the door) |
| 9 left | `khair_berangkat_brad` — plate, driver, time | the customer | — |

Only a message from the order's cold store number (its WhatsApp in Pengaturan, else the PIC number of the gudang app)
moves an order; anything else is logged and shown. Every message's state (sent / delivered / read / failed) shows on its
order. Cost: Meta charges each business-sent message (Indonesia utility ≈ Rp 357 + VAT since 1 Oct 2026); incoming
messages and button taps are free. ≈ 4 messages an order → ≈ Rp 1,1 juta a month at 25 orders a day. Monthly cap
(Pengaturan, default 3,000) → above it, the app sends by hand.

**Try it first in the demo** (no WhatsApp needed): https://officezied-prog.github.io/zied/khair-pos/brad/?mock=1&wa=1 — Jihan 2222.
Each order shows the phone that got its message; tap the cold store's buttons (Setuju / Tolak / Barang siap, Mobil sudah masuk,
"pintu N") and the order moves by itself, as it will once the steps below are done. The home card switches it off (= by hand).

## The owner's steps (once)
1. **A new phone number** for the business (a SIM that is not used in the WhatsApp app), able to receive an SMS or a call.
2. **Meta Business account** (business.facebook.com) for PT. SAIDA REZEKI ABADI → **Business verification** (documents;
   can take a few days).
3. **developers.facebook.com → Create app → Business → add "WhatsApp"**. In WhatsApp → API Setup: add the new number,
   verify it, set the display name (Khair Mart). Note the **Phone number ID** and the **WhatsApp Business Account ID**.
4. **Payment method** in WhatsApp Manager (Meta bills per message).
5. **Permanent token**: Business settings → Users → System users → add (Admin) → assign the app and the WhatsApp account
   (full control) → Generate token with `whatsapp_business_messaging` + `whatsapp_business_management`, never expiring.
6. **Cloudflare dashboard → Workers → khair-mart-jumla → Settings → Variables and secrets → add (type Secret)**:
   - `WA_TOKEN` = the token of step 5
   - `WA_PHONE_ID` = the Phone number ID
   - `WA_WABA_ID` = the WhatsApp Business Account ID
   - `WA_APP_SECRET` = the app's App secret (App settings → Basic)
   - `WA_VERIFY_TOKEN` = any long random text you choose
7. **Webhook**: developers.facebook.com → the app → WhatsApp → Configuration → Webhook: Callback URL
   `https://khair-mart-jumla.officezied.workers.dev/webhook/wa`, Verify token = the same `WA_VERIFY_TOKEN` → Verify and save
   → subscribe to the field **messages**.
8. **Khair Order Brad → Pengaturan → WhatsApp otomatis**: "Cek status" (all ✓) → "Daftarkan template ke Meta" (Meta reviews
   them, usually within a day) → when the four show APPROVED, "Kirim tes" to your own number.
9. Tell each cold store the new number, and that they can answer with the buttons (or "pintu N").

## The Audit harian reminder (v79)
Owner 2026-11-08: «اجعل المدير ووحيه هو من يرسل هذه الورقة الأخيرة. كل يوم إذا تم إرسالها من واحد فيهما لا يرسلها الثاني. إلى الواتساب يجب
أن يأتي إشعار لهم بإرسالها الساعة 9 بالليل». The same number, token and secrets as above (only `WA_TOKEN`, `WA_PHONE_ID`, `WA_WABA_ID`
are needed for this; the webhook is not). At the report hour (Pengaturan → Laporan harian → "Pengingat kirim laporan", 21:00 by default)
the manager and the accountant each get one message while nobody has sent that day's Audit harian:

| Template (Indonesian, UTILITY) | Text | To |
|---|---|---|
| `khair_audit_harian` | Halo {{1}}, audit harian Khair Mart tanggal {{2}} belum dikirim. Buka aplikasi Khair Mart: Laporan, Harian, lalu tekan Kirim audit harian. Terima kasih. | the manager (`wa_manager_number`) and the accountant (`wa_akuntan_number`) |

Steps: owner app → Pengaturan → fill "WhatsApp manajer" and "WhatsApp akuntan" → panel "Pengingat WhatsApp audit harian" → "Periksa"
(API ✓) → "Daftarkan template ke Meta" → when it shows "disetujui Meta", "Kirim tes ke WhatsApp saya" (to "WhatsApp pemilik").
Cost: at most 2 messages a day (none on a day the paper was sent before the hour) ≈ Rp 25.000 a month. Without the secrets the
manager's and the accountant's apps still show the reminder at that hour (nothing else changes). Code: `worker/src/audit.js`.

## Code
`backend/brad/brad-core.js` (`WA_TEMPLATES`, `waOut`, `waEvent`, `stampOf`), `worker/src/wa.js` (Graph API calls, signature,
monthly counter `pos_api_usage` api `wa_send`), `worker/src/brad.js` (sending after each step, `wa_admin`, `handleWaWebhook`),
route `/webhook/wa` in `worker/src/index.js`, log table `brad_wa_log`. Graph API version `v24.0` (override with the
secret/var `WA_GRAPH_VERSION`, e.g. `v26.0`, when Meta retires it).
