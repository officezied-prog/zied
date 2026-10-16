// Khair Mart Android apps (v45, owner 2026-10-13: «أريده أن يكون ينزل تنزيل … التنزيل المجاني»).
// Each app is a Trusted Web Activity: the same web app, opened full screen in the phone's Chrome (camera, GPS, printing,
// offline and every update keep working exactly as in the browser). Built from each app's web manifest with Bubblewrap.
//   node build.mjs --generate-only        → only the Android projects (no Android SDK needed; used to check the set-up)
//   node build.mjs                        → projects + signed APKs in ./out (needs JDK 17 + ANDROID_HOME, KEYSTORE, ANDROID_KEY_PASSWORD)
// Env: KHAIR_ORIGIN (default https://officezied-prog.github.io), KHAIR_BASE (/zied/khair-pos/), VERSION_CODE, VERSION_NAME.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TwaManifest, TwaGenerator, ConsoleLog } from '@bubblewrap/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // khair-pos/
const ORIGIN = (process.env.KHAIR_ORIGIN || 'https://officezied-prog.github.io').replace(/\/$/, '');
const BASE = process.env.KHAIR_BASE || '/zied/khair-pos/';
const ONLY_GENERATE = process.argv.includes('--generate-only');
const OUT = path.join(HERE, 'out');
const WORK = path.join(HERE, 'work');
export const APPS = [
  { id: 'owner', dir: '', pkg: 'com.khairmart.owner', name: 'Khair Mart', launcher: 'Khair Mart', print: true },
  { id: 'kasir', dir: 'kasir/', pkg: 'com.khairmart.kasir', name: 'Khair Kasir', launcher: 'Khair Kasir', print: true },
  { id: 'sales', dir: 'sales/', pkg: 'com.khairmart.sales', name: 'Khair Sales', launcher: 'Khair Sales' },
  { id: 'gudang', dir: 'gudang/', pkg: 'com.khairmart.gudang', name: 'Khair Gudang Dingin', launcher: 'Khair Gudang' }
];

function twaFor(app) {
  const manifestUrl = new URL(ORIGIN + BASE + app.dir + 'manifest.webmanifest');
  const json = JSON.parse(fs.readFileSync(path.join(ROOT, app.dir, 'manifest.webmanifest'), 'utf8'));
  const twa = TwaManifest.fromWebManifestJson(manifestUrl, json);
  twa.packageId = app.pkg;
  twa.name = app.name;
  twa.launcherName = app.launcher;
  twa.signingKey = { path: process.env.KEYSTORE || path.join(HERE, 'khair-release.p12'), alias: 'khair' };
  twa.appVersionCode = Number(process.env.VERSION_CODE || 1);
  twa.appVersionName = process.env.VERSION_NAME || String(twa.appVersionCode);
  twa.minSdkVersion = 24; // Android 7.0+: the Chrome helper library (androidbrowserhelper 2.7) needs it; Bubblewrap still defaults to 21
  twa.enableNotifications = false;
  twa.fallbackType = 'customtabs'; // a phone without a recent Chrome still opens the app (in a Chrome tab)
  twa.features = { locationDelegation: { enabled: true } }; // GPS for the field reps and the device-location rules
  twa.enableSiteSettingsShortcut = true;
  return twa;
}

// v58 (owner 2026-10-16: «يجب ان يتثبت مع تثبيت التطبيق مباشر لا يثبت لحاله»): the owner and cashier apps print on a paired Bluetooth
// receipt printer by themselves (native/KhairPrintActivity.java, opened by the page with an intent: link, scheme khairprint) —
// no RawBT to install. Added to the generated project: the activity, its intent filter and the Bluetooth permissions.
function addPrinting(dir, app) {
  const src = fs.readFileSync(path.join(HERE, 'native', 'KhairPrintActivity.java'), 'utf8').replace('__PACKAGE__', app.pkg);
  const javaDir = path.join(dir, 'app/src/main/java', ...app.pkg.split('.'));
  fs.mkdirSync(javaDir, { recursive: true });
  fs.writeFileSync(path.join(javaDir, 'KhairPrintActivity.java'), src);
  const mf = path.join(dir, 'app/src/main/AndroidManifest.xml');
  let xml = fs.readFileSync(mf, 'utf8');
  const perms = `
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-feature android:name="android.hardware.bluetooth" android:required="false" />
`;
  const activity = `
        <activity android:name="${app.pkg}.KhairPrintActivity"
            android:exported="true"
            android:theme="@android:style/Theme.Translucent.NoTitleBar">
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="khairprint" />
            </intent-filter>
        </activity>
    </application>`;
  const open = xml.match(/<manifest[^>]*>/);
  if (!open || xml.split('</application>').length !== 2) throw new Error('AndroidManifest.xml: unexpected layout, printing not added');
  xml = xml.replace(open[0], open[0] + perms).replace('</application>', activity.trimStart());
  fs.writeFileSync(mf, xml);
}

function sh(cmd, args, opts = {}) { execFileSync(cmd, args, { stdio: 'inherit', ...opts }); }
function buildTools() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('ANDROID_HOME is not set');
  const dir = path.join(sdk, 'build-tools');
  const v = fs.readdirSync(dir).filter(x => /^\d/.test(x)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
  return path.join(dir, v);
}

const log = new ConsoleLog('khair-android');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const app of APPS) {
  const dir = path.join(WORK, app.id);
  fs.mkdirSync(dir, { recursive: true });
  const twa = twaFor(app);
  log.info(`${app.pkg}: ${twa.host}${twa.startUrl}`);
  await new TwaGenerator().createTwaProject(dir, twa, log);
  if (app.print) addPrinting(dir, app);
  fs.writeFileSync(path.join(dir, 'twa-manifest.json'), JSON.stringify(twa.toJson(), null, 2));
  if (ONLY_GENERATE) continue;
  sh(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['assembleRelease', '--no-daemon', '--stacktrace'], { cwd: dir });
  const unsigned = path.join(dir, 'app/build/outputs/apk/release/app-release-unsigned.apk');
  const aligned = path.join(dir, 'aligned.apk'), out = path.join(OUT, `khair-${app.id}.apk`), bt = buildTools();
  sh(path.join(bt, 'zipalign'), ['-f', '-p', '4', unsigned, aligned]);
  sh(path.join(bt, 'apksigner'), ['sign', '--ks', twa.signingKey.path, '--ks-type', 'PKCS12', '--ks-key-alias', 'khair',
    '--ks-pass', 'env:ANDROID_KEY_PASSWORD', '--key-pass', 'env:ANDROID_KEY_PASSWORD', '--out', out, aligned]);
  sh(path.join(bt, 'apksigner'), ['verify', out]);
  log.info(`built ${out}`);
}
