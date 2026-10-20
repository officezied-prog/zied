# Automatic Lalamove for Khair Order Brad — setup (stage 3, v63, app 1.3.0)

Owner 2026-10-20: «ابدأ المرحلة الثالثة: طلب سيارة لالاموف تلقائيًا». The code is built and **inactive until the two secrets below exist
on the Worker**. Until then — and whenever Lalamove refuses a booking, the month's cap is reached, or Lalamove does not answer —
the three manual ways of the car step stay exactly as before: "Lalamove" (booked in Lalamove's own app, typed in), "Sopir
sendiri" (our driver), "Dipesan pelanggan" (the customer's car). Nothing stops.

**Try it first in the demo** (no Lalamove account needed): https://officezied-prog.github.io/zied/khair-pos/brad/?mock=1 —
Jihan 2222. An order at "Barang siap" → **Pesan Lalamove otomatis** → **Cek harga** → **Pesan sekarang**; the card then shows a
simulated Lalamove phone: **Sopir ditemukan**, **Barang diambil**, **Selesai**, **Dibatalkan** move the order as Lalamove will.

## What it does

| Moment | What the server does (Lalamove Partner API v3) | What the order shows |
|---|---|---|
| Pengaturan → Lalamove otomatis → **Tes koneksi** | `GET /v3/cities` → the vehicles of Jakarta (or `LALAMOVE_CITY`) kept for the car form | "Terhubung: N jenis kendaraan" |
| Step 5 → **Pesan Lalamove otomatis** → **Cek harga** | `POST /v3/quotations`: the cooler → where the goods go, the vehicle, now or a pickup time | price, km, valid until (≈ 5 min), the car at the cooler ± HH:MM |
| **Pesan sekarang** | priced again (fresh); **> 5 % above** what staff saw → asked again; the **month's cap**; then `POST /v3/orders` | 5/9 Mobil dipesan · *mencari sopir* · price · **Lacak di Lalamove** (tracking link, new tab) |
| Lalamove finds a driver | `GET /v3/orders/{id}` + `GET …/drivers/{driverId}` → driver, plate, WhatsApp on the order | the car's details go to the cold store by the stage-2 WhatsApp template (or a reminder to send them by hand) |
| Picked up, while the car is at the door / loading | the departure: the goods out of the gudang stock, the customer told | 9/9 Berangkat |
| Completed | — | Sampai |
| Cancelled / rejected / no driver found by Lalamove | — | back to 4/9 Barang siap ("mobil batal N×"), book again |
| **Batalkan Lalamove** (a reason) | `DELETE /v3/orders/{id}` (only before pickup) | back to 4/9 Barang siap. Refused or unreachable → cancel it in Lalamove's app, then **Sudah dibatalkan di aplikasi Lalamove** |

- **The trip's places:** sender = the cooler (its place from Pengaturan, its name, its WhatsApp — Pengaturan, else the gudang
  PIC); recipient = the customer (the order's place, address, phone) or, for "Toko Khair Mart", the shop's place and phone.
  The driver's remarks carry the order number, cartons, pallets and kg.
- **The order's place:** in the order form, "Lokasi tujuan" — paste a Google Maps link, a WhatsApp location, or "lat,lng"
  (a short `maps.app.goo.gl` link is followed by the Worker). The same customer's next order gets it by itself.
- **Hours:** the car's arrival = now + the minutes (40 by default) + the ETA margin (20 %), or the pickup time chosen;
  after the cooler's closing time the overtime is asked first, as for a car typed by hand.
- **Following a trip, no staff needed:** a cron every 2 minutes (`wrangler.toml` `[triggers]`), each app refresh (a trip not
  looked at for 90 s, at most 5 a request) and Lalamove's webhook. The webhook's signature format is not confirmed, so its body
  is **never trusted**: it only makes the Worker read that order from Lalamove's API with our own key.
- **One car at a time:** a second tap / phone cannot book a second car for the same order (a lock), and a car booked by the
  server cannot be typed over or cancelled by hand without saying it was cancelled in Lalamove's app.

## Cost (reliability first, then cost)
- Lalamove: the per-trip fee only, paid from the Lalamove business wallet — the same trips as today, no software fee.
- Cloudflare: the cron is 720 runs a day (the free plan allows 100,000 requests a day). Without the keys it does nothing at all;
  with them and no open trip it is one small D1 read. A booking is under 10 D1 calls, far under the free plan's 50 per request.
- **Monthly cap** (Pengaturan → Lalamove otomatis, default **Rp 10.000.000**): the trips booked by the server this month (a
  cancelled one costs nothing); above it the server books nothing more and staff book by hand. **0** = the server never books.
- Most reliable and cheapest are the same here: Lalamove's own API (no middleman), with the manual ways as the fallback.

## The owner's steps (once)
1. **Lalamove business account + API access:** sign up at the Lalamove Partner Portal (`partnerportal.lalamove.com`, market
   Indonesia) for PT. SAIDA REZEKI ABADI. Its developer section gives a **sandbox** API key + secret at once.
2. **Cloudflare dashboard → Workers & Pages → khair-mart-jumla → Settings → Variables and Secrets → Add** (type **Secret**):
   - `LALAMOVE_KEY` = the API key
   - `LALAMOVE_SECRET` = the API secret

   → Deploy. Without `LALAMOVE_ENV` the Worker talks to the **sandbox** (`rest.sandbox.lalamove.com`, no real cars).
3. **Khair Order Brad → Pengaturan → Lalamove otomatis** (owner): it shows "Aktif — SANDBOX". **Tes koneksi** (the vehicles of
   Jakarta). Fill in **the shop's place** and **each cooler's place** (open the place in Google Maps → Share → copy the link, or
   type "lat,lng") and the monthly cap → **Simpan**. Check each cooler has its WhatsApp number (the driver calls it).
4. **A sandbox test:** an order at "Barang siap" → Pesan Lalamove otomatis → Cek harga → Pesan sekarang. Sandbox orders are not
   real cars; cancel it with **Batalkan Lalamove**.
5. **Go live:** ask Lalamove for the **production** API key + secret in the portal (they review the account), **top up the
   business wallet** (the portal's wallet / top-up page — production trips are paid from it; an empty wallet makes Lalamove
   refuse the booking, the app shows Lalamove's message and staff book by hand). Then in Cloudflare replace `LALAMOVE_KEY` /
   `LALAMOVE_SECRET` with the production pair and add **`LALAMOVE_ENV` = `production`** (a plain variable, type Text — **not**
   in `wrangler.toml`, which would put its own value back on every deploy) → Deploy. The settings card shows
   "Aktif — PRODUCTION".
6. **Webhook** (optional, makes the updates instant — the cron reads every 2 minutes anyway): in the Partner Portal set the
   webhook URL `https://khair-mart-jumla.officezied.workers.dev/webhook/lalamove` (sandbox and production).
7. Optional: `LALAMOVE_CITY` (e.g. `ID_JKT`) when the coolers are in another city; `LALAMOVE_MARKET` stays `ID`.

To switch it off at once: Pengaturan → cap **0** (the server books nothing; open trips are still followed), or delete the two
secrets in Cloudflare (everything goes back to the manual ways).

## What could not be checked before going live
- The calls follow the interface of Lalamove's official SDK `@lalamove/lalamove-js` 1.1.0 (hosts, `hmac` signature, `Market`
  header, `{ data }` bodies, the endpoints and statuses); the tests run against a stand-in. The first sandbox booking is the
  real check.
- `item` (Lalamove's weight band, e.g. `LESS_THAN_3_KG`) is **not sent**: it is a market-specific list, not kilograms, and a wrong
  value fails the quotation. The order's kg proposes the vehicle (by its load) and goes into the driver's remarks.
- Whether Lalamove charges a fee for a cancellation after a driver accepted; the cap counts a cancelled trip as 0.
- The webhook's signature (not confirmed) — the body is never trusted, so this does not matter for safety.

## Code
`backend/brad/brad-core.js` (`geoOf`, `lalaPlan`, `lala_plan` / `lala_booked` / `lala_sync` / `lala_cancel` /
`lala_cancelled` / `lala_due` / `lala_services`, the cap, `lalaServiceFor`), `worker/src/lalamove.js` (the signed calls),
`worker/src/brad.js` (`lala_quote`, `lala_book`, `lala_cancel`, `lala_admin`, the sync on refresh, `handleLalaCron`,
`handleLalaWebhook`, the booking lock `brad_lala_locks`), `worker/src/index.js` (route `/webhook/lalamove`, `scheduled`),
`worker/wrangler.toml` (`[triggers] crons`), settings `brad_coolers` (lat/lng), `brad_store_geo`, `brad_lala_cap`,
`brad_lala_services`; `brad_orders.dest_lat` / `dest_lng` (added by the Worker itself). Demo: `shared/brad-mock.js`.
Tests: `backend/brad/test-brad.js`, `worker/test/brad-lala.test.js`, `tests/brad-lalamove.spec.js`.

## ملخص بالعربية

المرحلة الثالثة: الخادم يحجز سيارة
Lalamove
بنفسه عبر الواجهة الرسمية، ثم يتابع الرحلة: السائق واللوحة يصلان للبراد بالواتساب، وعند استلام البضاعة تنطلق الطلبية وتخرج من المخزون، وعند
الانتهاء تُسجّل «وصلت». إذا لم يكن مفعّلًا أو تجاوز حد الشهر أو رفضت
Lalamove
أو لم تُجب، تبقى الطرق اليدوية الثلاث كما هي — لا شيء يتوقف.

خطوات المالك (مرة واحدة):
1. حساب أعمال في
Lalamove Partner Portal
والحصول على مفتاح التجربة
(sandbox).
2. في
Cloudflare → Workers & Pages → khair-mart-jumla → Settings → Variables and Secrets
أضف سرّين:
LALAMOVE_KEY
و
LALAMOVE_SECRET
3. في التطبيق: الإعدادات ← لالاموف تلقائي ← «اختبار الاتصال»، ثم أدخل موقع المحل وموقع كل براد (رابط خرائط جوجل أو
lat,lng)
والحد الشهري (الافتراضي 10 ملايين روبية؛ 0 = لا حجز تلقائي).
4. للتشغيل الحقيقي: مفاتيح
production
من البوابة، وشحن محفظة
Lalamove
ثم أضف المتغير
LALAMOVE_ENV = production
في
Cloudflare
5. اختياري: عنوان
webhook
في البوابة:
https://khair-mart-jumla.officezied.workers.dev/webhook/lalamove

التجربة الآن بلا حساب:
https://officezied-prog.github.io/zied/khair-pos/brad/?mock=1
