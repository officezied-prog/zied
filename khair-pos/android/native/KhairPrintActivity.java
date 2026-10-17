package __PACKAGE__;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothClass;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.widget.Toast;

import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * Khair Mart (v58, owner 2026-10-16: «كيف أثبت تطبيق RawBT على الهاتف؟ و يجب ان يتثبت مع تثبيت التطبيق مباشر لا يثبت لحاله»):
 * the app prints on a paired Bluetooth receipt printer by itself — ESC/POS bytes over the classic Bluetooth serial port (SPP),
 * which every small receipt printer has (VSC TM-58D, RPP02, POS-58 …). No other app to install. The web page opens
 *   intent:base64,<bytes>#Intent;scheme=khairprint;package=<this app>;end   → print these bytes
 *   intent:choose#Intent;scheme=khairprint;package=<this app>;end           → choose the printer (again)
 *   intent:site-settings#Intent;scheme=khairprint;package=<this app>;end    → Chrome's settings of this site (v59: the camera)
 * The printer chosen once is remembered on this phone; the first print (or "choose") shows the paired devices, printers first.
 * Copied into the owner and cashier apps by ../build.mjs (the package line is filled in there).
 */
public class KhairPrintActivity extends Activity {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    private static final int REQ_PERM = 41, REQ_ENABLE = 42;
    private byte[] data;
    private boolean choose;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Uri u = getIntent() != null ? getIntent().getData() : null;
        String s = u != null && u.getSchemeSpecificPart() != null ? u.getSchemeSpecificPart() : "";
        if (s.startsWith("site-settings")) { openSiteSettings(); return; }
        if (s.startsWith("base64,")) {
            try { data = Base64.decode(s.substring(7), Base64.DEFAULT); } catch (IllegalArgumentException e) { data = null; }
        }
        choose = s.startsWith("choose");
        if ((data == null || data.length == 0) && !choose) { toast("Tidak ada data untuk dicetak"); finish(); return; }
        step();
    }

    /** Permission → Bluetooth on → a paired printer (remembered, or chosen now) → print. */
    private void step() {
        if (Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, REQ_PERM);
            return;
        }
        BluetoothAdapter ad = adapter();
        if (ad == null) { toast("HP ini tidak punya Bluetooth"); finish(); return; }
        try {
            if (!ad.isEnabled()) { startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE); return; }
            List<BluetoothDevice> paired = new ArrayList<>(ad.getBondedDevices());
            if (paired.isEmpty()) { askToPair(); return; }
            String mac = prefs().getString("mac", "");
            BluetoothDevice dev = null;
            if (!choose) for (BluetoothDevice d : paired) if (d.getAddress().equals(mac)) dev = d;
            if (dev == null) { pick(paired); return; }
            print(dev);
        } catch (SecurityException e) {
            toast("Izin Bluetooth belum diberikan");
            finish();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        if (code != REQ_PERM) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) step();
        else { toast("Izinkan \"Perangkat sekitar\" (Bluetooth) agar bisa mencetak"); finish(); }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent i) {
        super.onActivityResult(code, result, i);
        if (code != REQ_ENABLE) return;
        if (result == RESULT_OK) step(); else { toast("Bluetooth belum dinyalakan"); finish(); }
    }

    private void askToPair() {
        new AlertDialog.Builder(this)
            .setTitle("Printer Bluetooth")
            .setMessage("Belum ada printer yang dipasangkan dengan HP ini. Nyalakan printer, lalu pasangkan di pengaturan Bluetooth (PIN biasanya 0000 atau 1234), kemudian cetak lagi.\n\nلا توجد طابعة مقترنة بهذا الهاتف. شغّل الطابعة ثم اقرنها من إعدادات البلوتوث (الرمز غالبًا 0000 أو 1234) ثم اطبع مرة أخرى.")
            .setPositiveButton("Buka Bluetooth", (d, w) -> { try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); } catch (Exception ignored) { } finish(); })
            .setNegativeButton("Batal", (d, w) -> finish())
            .setOnCancelListener(d -> finish())
            .show();
    }

    /** The paired devices, receipt printers (Bluetooth class "imaging") first; the one chosen is remembered. */
    private void pick(final List<BluetoothDevice> paired) {
        Collections.sort(paired, (a, b) -> Boolean.compare(!isPrinter(a), !isPrinter(b)));
        String[] names = new String[paired.size()];
        for (int i = 0; i < names.length; i++) names[i] = name(paired.get(i)) + (isPrinter(paired.get(i)) ? "  🖨" : "") + "\n" + paired.get(i).getAddress();
        new AlertDialog.Builder(this)
            .setTitle("Pilih printer struk / اختر الطابعة")
            .setItems(names, (d, which) -> {
                BluetoothDevice dev = paired.get(which);
                prefs().edit().putString("mac", dev.getAddress()).putString("name", name(dev)).apply();
                if (data == null || data.length == 0) { toast("Printer: " + name(dev)); finish(); } else print(dev);
            })
            .setNeutralButton("Pasangkan printer baru", (d, w) -> { try { startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); } catch (Exception ignored) { } finish(); })
            .setNegativeButton("Batal", (d, w) -> finish())
            .setOnCancelListener(d -> finish())
            .show();
    }

    private void print(final BluetoothDevice dev) {
        final String who = name(dev);
        toast("Mencetak ke " + who + "…");
        new Thread(() -> {
            String error = null;
            BluetoothSocket sock = null;
            try {
                BluetoothAdapter ad = adapter();
                if (ad != null && ad.isDiscovering()) ad.cancelDiscovery();
                sock = connect(dev);
                OutputStream out = sock.getOutputStream();
                for (int i = 0; i < data.length; i += 512) { out.write(data, i, Math.min(512, data.length - i)); out.flush(); Thread.sleep(15); }
                Thread.sleep(400); // the printer takes the last bytes before the link closes
            } catch (Exception e) {
                error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            } finally {
                try { if (sock != null) sock.close(); } catch (Exception ignored) { }
            }
            final String err = error;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (err == null) toast("Struk tercetak di " + who);
                else toast("Gagal mencetak ke " + who + " — pastikan printer menyala dan dekat. (" + err + ")");
                finish();
            });
        }).start();
    }

    /** The serial-port socket; some printers only answer the insecure one, or channel 1 directly. */
    private BluetoothSocket connect(BluetoothDevice dev) throws Exception {
        Exception last;
        try { BluetoothSocket s = dev.createRfcommSocketToServiceRecord(SPP); s.connect(); return s; } catch (Exception e) { last = e; }
        try { BluetoothSocket s = dev.createInsecureRfcommSocketToServiceRecord(SPP); s.connect(); return s; } catch (Exception e) { last = e; }
        try {
            Method m = dev.getClass().getMethod("createRfcommSocket", int.class);
            BluetoothSocket s = (BluetoothSocket) m.invoke(dev, 1);
            s.connect();
            return s;
        } catch (Exception e) { last = e; }
        throw last;
    }

    private boolean isPrinter(BluetoothDevice d) {
        try { BluetoothClass c = d.getBluetoothClass(); return c != null && c.getMajorDeviceClass() == BluetoothClass.Device.Major.IMAGING; } catch (Exception e) { return false; }
    }

    private String name(BluetoothDevice d) {
        try { String n = d.getName(); return n != null && !n.isEmpty() ? n : d.getAddress(); } catch (SecurityException e) { return d.getAddress(); }
    }

    /**
     * v59 (owner 2026-10-17: «لا يمكن استعمال الكميرا في تسجيل الحضور»): a camera refused once stays refused for the site, and the
     * app has no address bar to change it. The Chrome helper library's ManageDataLauncherActivity (in every Bubblewrap app) opens
     * Chrome's site settings for this app's site: Kamera → Izinkan. The attendance screen opens intent:site-settings…
     */
    private void openSiteSettings() {
        try {
            startActivity(new Intent().setClassName(this, "com.google.androidbrowserhelper.trusted.ManageDataLauncherActivity"));
        } catch (Exception e) {
            toast("Buka Chrome → Setelan → Setelan situs → Kamera → Izinkan");
        }
        finish();
    }

    private BluetoothAdapter adapter() {
        BluetoothManager m = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        return m != null ? m.getAdapter() : null;
    }

    private SharedPreferences prefs() { return getSharedPreferences("khair_print", MODE_PRIVATE); }

    private void toast(String s) { Toast.makeText(getApplicationContext(), s, Toast.LENGTH_LONG).show(); }
}
