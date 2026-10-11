// v33 (owner 2026-10-11): Google Maps short links (maps.app.goo.gl/…) → the position of the place, for free.
// A phone cannot follow these links itself (the browser blocks reading another site's redirect), so the Worker does
// what a browser does when the link is opened: follows the redirects (without reading any page) until the full
// google.com/maps link, which carries the place pin (!3d…!4d…) or at least the view (@lat,lng) and the name.
// No Google key, no page scraping. Only Google Maps hosts; ≤ 8 links per call, ≤ 3 hops each = ≤ 24 fetches, well under the
// Workers subrequest cap (50 on the free plan) together with the D1 calls of the same request.
const HOST = /^(?:maps\.app\.goo\.gl|goo\.gl|(?:www\.)?google\.[a-z.]+|maps\.google\.[a-z.]+)$/i;

export function coordsFromUrl(u) {
  let s = String(u || '');
  try { s = decodeURIComponent(s); } catch (e) { /* keep */ }
  const ok = (la, ln) => isFinite(la) && isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180 && !(la === 0 && ln === 0);
  let m;
  if ((m = s.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/)) && ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2], exact: true };
  if ((m = s.match(/[?&](?:q|ll|query|destination|center)=(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/)) && ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2], exact: true };
  if ((m = s.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/)) && ok(+m[1], +m[2])) return { lat: +m[1], lng: +m[2], exact: false };
  return null;
}
export function nameFromUrl(u) {
  const s = String(u || ''), m = s.match(/\/maps\/place\/([^/@?]+)/);
  let v = m ? m[1] : ((s.match(/[?&]q=([^&]+)/) || [])[1] || '');
  try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { v = v.replace(/\+/g, ' '); }
  v = v.replace(/[<>\u0000-\u001F]/g, '').trim().slice(0, 200);
  return /^-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(v) ? '' : v;
}
export const allowedMapsUrl = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') && HOST.test(x.hostname); } catch (e) { return false; } };

async function follow(url, fetchImpl) {
  let cur = url;
  for (let hop = 0; hop < 3; hop++) {
    if (coordsFromUrl(cur)) break;
    let r;
    const ctrl = new AbortController(), tm = setTimeout(() => ctrl.abort(), 6000);
    try { r = await fetchImpl(cur, { method: 'GET', redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) KhairMart/1.0', 'Accept-Language': 'id,en' } }); }
    finally { clearTimeout(tm); }
    const loc = r && r.status >= 300 && r.status < 400 ? r.headers.get('location') : '';
    if (r && r.body && r.body.cancel) { try { await r.body.cancel(); } catch (e) { /* ignore */ } } // never read the page
    if (!loc) break;
    const next = new URL(loc, cur).toString();
    if (!allowedMapsUrl(next)) { cur = next; break; } // e.g. a consent page: stop, keep what the link said
    cur = next;
  }
  return cur;
}

/** urls → [{ url, final, lat, lng, exact, name, ok }] (same order). Never throws: a link that fails comes back ok:false. */
export async function resolveMapsLinks(urls, fetchImpl = fetch) {
  const list = (Array.isArray(urls) ? urls : []).slice(0, 8);
  return Promise.all(list.map(async (u) => {
    const url = String(u || '').slice(0, 300);
    if (!allowedMapsUrl(url)) return { url, ok: false };
    try {
      const fin = await follow(url, fetchImpl), c = coordsFromUrl(fin);
      return { url, final: fin.slice(0, 600), ok: !!c, lat: c ? c.lat : null, lng: c ? c.lng : null, exact: c ? c.exact : false, name: nameFromUrl(fin) };
    } catch (e) { return { url, ok: false }; }
  }));
}
