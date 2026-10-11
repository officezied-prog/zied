// v34 (owner 2026-10-11: "do the upgrade — we will not reach 5,000 searches a month"): Google Places search for the field
// app, made HERE so the Google key never reaches a phone. Places API (New) Text Search with ONLY "Pro" fields (name,
// address, position, types, Maps link, business status — no phone / rating / hours, which are the dearer "Enterprise"
// SKU): Google gives 5,000 of these free each month; the process code stops at 4,500 (pos_api_usage), so the bill stays 0.
// Along a drawn work line: searchAlongRouteParameters with the line as an encoded polyline; if Google refuses that, one
// retry biased to a circle around the line.
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELDS = 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types,places.primaryType,places.googleMapsUri,places.businessStatus';
const okCoord = (la, ln) => isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 && !(la === 0 && ln === 0);

/** Google's encoded polyline (precision 5) for [[lat, lng], …]. */
export function encodePolyline(pts) {
  let out = '', pla = 0, pln = 0;
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, ln] of pts) {
    const a = Math.round(la * 1e5), b = Math.round(ln * 1e5);
    out += enc(a - pla) + enc(b - pln); pla = a; pln = b;
  }
  return out;
}
function meters(a, b) {
  const R = 6371000, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLn = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function call(body, key, fetchImpl) {
  const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetchImpl(ENDPOINT, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS }, body: JSON.stringify(body) });
    const js = await r.json().catch(() => ({}));
    return { status: r.status, js };
  } finally { clearTimeout(tm); }
}
/** req: { q, lat?, lng?, radius?, line? } → { places: [...], mode } ; throws { code: 'GOOGLE', status } when Google refuses. */
export async function placesSearch(req, key, fetchImpl = fetch) {
  const base = { textQuery: String(req.q || '').slice(0, 120), languageCode: 'id', regionCode: 'ID', maxResultCount: 20 };
  const line = Array.isArray(req.line) ? req.line.filter((q) => Array.isArray(q) && okCoord(+q[0], +q[1])).slice(0, 100) : [];
  let res, mode = 'text';
  if (line.length > 1) {
    mode = 'route';
    res = await call(Object.assign({ searchAlongRouteParameters: { polyline: { encodedPolyline: encodePolyline(line) } } }, base), key, fetchImpl);
    if (res.status === 400) { // not accepted along this line: one circle around it instead
      const mid = line[Math.floor(line.length / 2)];
      let len = 0; for (let i = 1; i < line.length; i++) len += meters(line[i - 1], line[i]);
      mode = 'circle';
      res = await call(Object.assign({ locationBias: { circle: { center: { latitude: mid[0], longitude: mid[1] }, radius: Math.min(5000, Math.max(300, len / 2 + 150)) } } }, base), key, fetchImpl);
    }
  } else {
    const lat = Number(req.lat), lng = Number(req.lng);
    if (okCoord(lat, lng)) base.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50000, Math.max(100, Number(req.radius) || 3000)) } };
    res = await call(base, key, fetchImpl);
  }
  if (res.status !== 200) { const e = new Error('google ' + res.status); e.code = 'GOOGLE'; e.status = res.status; e.detail = String((res.js && res.js.error && res.js.error.status) || ''); throw e; }
  const places = ((res.js && res.js.places) || []).map((p) => {
    const lat = p.location && Number(p.location.latitude), lng = p.location && Number(p.location.longitude);
    if (!okCoord(lat, lng)) return null;
    return { id: String(p.id || '').slice(0, 200), name: String((p.displayName && p.displayName.text) || '').slice(0, 100), address: String(p.formattedAddress || p.shortFormattedAddress || '').slice(0, 200),
      lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, types: (Array.isArray(p.types) ? p.types : []).slice(0, 10).map(String), primary: String(p.primaryType || ''),
      url: String(p.googleMapsUri || '').slice(0, 300), status: String(p.businessStatus || '') };
  }).filter((p) => p && p.name && p.status !== 'CLOSED_PERMANENTLY');
  return { places, mode };
}
