// Prints the Digital Asset Links file that lets Android open the Khair Mart apps without an address bar: it proves the
// apps (signed with our key, fingerprint below) and the web site belong together. It must be served at
// https://officezied-prog.github.io/.well-known/assetlinks.json  (usage: node assetlinks.mjs "AB:CD:…")
const fp = (process.argv[2] || '').trim();
if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(fp)) { console.error('usage: node assetlinks.mjs <SHA-256 fingerprint>'); process.exit(1); }
const pkgs = ['com.khairmart.owner', 'com.khairmart.kasir', 'com.khairmart.sales', 'com.khairmart.gudang'];
console.log(JSON.stringify(pkgs.map(p => ({ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: p, sha256_cert_fingerprints: [fp.toUpperCase()] } })), null, 2));
