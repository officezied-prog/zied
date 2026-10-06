# Khair Mart POS — Panduan Operator

Aplikasi kasir (POS) grosir & eceran untuk **Khair Mart, Condet**, pengganti majoo.
Buka di browser: **https://officezied-prog.github.io/zied/khair-pos/**

Data tersimpan di server toko (n8n). Satu aplikasi untuk HP, tablet, dan PC.

---

## 1. Pasang di HP / tablet / PC

| Perangkat | Cara |
|---|---|
| **Android (Chrome)** | Buka alamat di atas → menu ⋮ → **Tambahkan ke layar utama / Instal aplikasi**. |
| **iPhone / iPad (Safari)** | Buka alamat → tombol **Bagikan** → **Tambah ke Layar Utama**. |
| **PC / laptop (Chrome / Edge)** | Buka alamat → ikon **Instal** di kolom alamat (atau menu → *Instal Khair Mart POS*). |

Setelah dibuka sekali, aplikasi tetap bisa dibuka walau internet putus.

## 2. Masuk (login)

1. **Pertama kali di perangkat ini:** isi **Kode toko** (diberikan pemilik; cukup sekali per perangkat). Jangan menyebarkan kode toko.
2. Jika toko belum punya pengguna, aplikasi meminta membuat **akun pemilik** (nama + PIN 4–6 angka, diketik dua kali).
3. Berikutnya: pilih nama → ketik **PIN** → **Masuk**.
4. Tombol **gembok** (kanan atas) = **Kunci**. Aplikasi juga terkunci otomatis jika tidak dipakai 30 menit (bisa diubah di *Pengaturan*).
5. Tombol **ع / ID** mengganti bahasa Indonesia ↔ Arab.

## 3. Menjual (menu **Kasir**)

1. Cari produk di kotak pencarian (nama, SKU, kategori) atau **scan barcode**. Ketuk produk untuk menambah 1.
2. Ubah jumlah dengan **− / +** atau ketik langsung (boleh desimal untuk kg, mis. `0,5`).
3. **Harga grosir otomatis** jika jumlah ≥ *min. grosir* produk, atau jika pelanggan bertipe **Grosir**. Ketuk label **Eceran/Grosir** pada baris untuk mengganti manual (tanda titik biru = manual).
4. **Pelanggan:** default *Umum*. Ketuk kotak pelanggan untuk mencari atau **menambah pelanggan baru** (nama, HP, tipe). Hutang pelanggan terlihat di sana.
5. **Diskon** (Rp), pilih **Tunai / Transfer / QRIS / Hutang**.
   - Tunai: isi uang diterima atau ketuk tombol cepat (*Uang pas, 50rb, 100rb…*) → **kembalian** muncul.
   - **Hutang** atau bayar kurang **wajib memilih pelanggan** — sisanya otomatis jadi hutang pelanggan.
6. **Bayar & Simpan** (atau tombol **F9** di keyboard).
7. **Survei pelanggan** muncul sebelum menyimpan (bisa **Lewati**). Centang *"Pembeli setuju jawabannya dicatat"* dulu. Tombol **mikrofon** mengubah suara menjadi teks (bahasa Indonesia) — **suara tidak direkam, hanya teks yang disimpan**. Survei otomatis bisa dimatikan di Pengaturan.
8. Struk muncul: **Cetak**, **Salin**, **WhatsApp** (dikirim ke nomor pelanggan jika ada), **Transaksi baru**.

### Internet putus?
Transaksi **tidak hilang**. Struk bertanda *BELUM TERKIRIM*, dan di atas muncul **"Belum terkirim (n)"**. Aplikasi mengirim ulang otomatis tiap 30 detik dan saat internet kembali. Bisa juga **Pengaturan → Antrian offline → Kirim ulang**.
**Jangan menghapus data browser** selama masih ada antrian.

## 4. Scan barcode

- **Scanner USB / Bluetooth:** colok/pasangkan, lalu langsung scan di layar Kasir (kotak pencarian selalu aktif). Scanner harus diatur mengirim **Enter** setelah kode (bawaan hampir semua scanner). Produk ditemukan lewat kolom **SKU / Barcode**.
- **Kamera HP:** tombol scan di sebelah kotak pencarian (hanya muncul di browser yang mendukung, mis. Chrome Android).

## 5. Printer struk

- Printer thermal **58 mm** atau **80 mm** — pilih lebar di **Pengaturan → Info toko & struk**.
- Tombol **Cetak** membuka dialog cetak browser; hanya struk yang tercetak. Atur: *Margin: None*, *Header/footer: off*, skala 100%.
- **Printer Bluetooth di Android:** pasang aplikasi layanan cetak (mis. *RawBT* atau *Bluetooth Print Service*), lalu pilih printer itu di dialog cetak.
- **PC:** pasang driver printer, jadikan printer default, ukuran kertas 58/80 mm.
- Alternatif tanpa printer: **WhatsApp** atau **Salin** struk.

## 6. Hutang pelanggan (menu **Pelanggan**)

- Daftar pelanggan bisa diurutkan **hutang terbesar**; total piutang tampil di atas.
- Buka pelanggan → **Terima pembayaran** (jumlah, metode, tanggal, catatan) → hutang berkurang.
- **Tagih via WhatsApp** membuat pesan pengingat yang sopan berisi jumlah hutang.

## 7. Barang masuk (pembelian)

Menu **Barang Masuk**: isi supplier & tanggal → cari/scan produk → isi **qty** dan **harga beli per satuan** → **Simpan**.
Stok bertambah dan **HPP (harga modal) menjadi rata-rata tertimbang** dari stok lama dan barang baru (terlihat oleh pemilik).

## 8. Produk & stok (pemilik)

- **Produk baru / ubah:** nama, SKU/barcode, kategori, satuan, harga modal, eceran, grosir, min. grosir, stok minimum, aktif/nonaktif.
- **Stock opname:** tombol *Stock opname* → isi stok hasil hitung + alasan (rusak, hilang, kedaluwarsa…).
- Kasir hanya bisa melihat produk (tanpa harga modal).

### Impor produk dari majoo (CSV)
1. Di majoo: ekspor daftar produk ke **Excel/CSV**. Jika hasilnya .xlsx, buka di Excel/Google Sheets → *Simpan sebagai CSV*.
2. **Produk → Impor CSV** → pilih file.
3. Kolom dicocokkan otomatis (mis. *Nama Produk, SKU, Kategori, Satuan, Harga Modal/HPP, Harga Jual, Harga Grosir, Min Grosir, Stok*). Periksa pratinjau, ubah pencocokan bila perlu.
4. **Impor** → produk dengan SKU sama (atau nama sama) **diperbarui**, sisanya dibuat baru.

## 9. Riwayat & laporan

- **Riwayat:** pilih tanggal → buka transaksi untuk cetak ulang / salin / WhatsApp. Pemilik bisa **Batalkan transaksi** (wajib alasan) — stok kembali dan hutang terkoreksi.
- **Laporan** (pemilik): Hari ini, Kemarin, 7 hari, Bulan ini, Bulan lalu, atau tanggal bebas. Omzet, laba kotor, margin, jumlah transaksi, rata-rata, eceran vs grosir, metode bayar, piutang, hutang baru vs pembayaran masuk, barang masuk, produk terlaris / paling untung / paling lambat, stok menipis, grafik, dan hasil survei (*Tahu Khair Mart dari mana?*).
- **Salin laporan harian / bulanan** → tempel di grup WhatsApp. **Cetak** untuk kertas A4.
- Kasir hanya melihat omzet & jumlah transaksi hari ini.

## 10. Pengaturan (pemilik)

Info toko & catatan struk, lebar kertas, pertanyaan survei (tambah / hapus / urutkan), pengguna (tambah kasir, ganti PIN, nonaktifkan), bahasa, kunci otomatis, antrian offline.

## Mode DEMO (latihan)

Buka `…/khair-pos/?mock=1` — data contoh tersimpan hanya di browser itu, tidak menyentuh data toko.
Kode toko demo: `demo` · Pemilik PIN `1234` · Siti (kasir) PIN `1111`. Reset di *Pengaturan → Reset data demo*.

## Untuk pengembang

- Satu file `index.html` (tanpa build). `sw.js` + `manifest.webmanifest` + `icon.svg` hanya untuk instalasi/offline.
- Kontrak backend: `API.md`. Alamat API ada di `CONFIG` bagian atas skrip.
- Tes: `cd khair-pos/tests && npm install && npx playwright test` (memakai Chromium di `/opt/pw-browsers`, server `python3 -m http.server`).

---

## ملخص للمالك (بالعربية)

**نظام الكاشير لمتجر خير مارت** — يعمل على الجوال والتابلت والكمبيوتر، ويُثبَّت من المتصفح عبر «إضافة إلى الشاشة الرئيسية».

- **الدخول:** يُدخَل رمز المتجر مرة واحدة على كل جهاز، ثم يختار الموظف اسمه ويكتب رقمه السري (4–6 أرقام). زر القفل يقفل التطبيق، ويُقفل تلقائيًا بعد 30 دقيقة دون استخدام.
- **البيع:** بحث أو مسح باركود، وسعر **الجملة** يُطبَّق تلقائيًا عند بلوغ الحد الأدنى للكمية أو إذا كان العميل «جملة». الدفع نقدًا / تحويل / QRIS / **دَين** (الدَّين يتطلب اختيار عميل).
- **انقطاع الإنترنت:** لا تضيع أي عملية؛ تُحفظ على الجهاز وتُرسل تلقائيًا عند عودة الاتصال.
- **الإيصال:** طباعة (58 أو 80 مم)، نسخ، أو إرسال عبر واتساب.
- **الاستبيان:** أسئلة قصيرة للعميل بعد موافقته، مع إمكانية الإملاء الصوتي — يُحفظ النص فقط ولا يُسجَّل الصوت.
- **العملاء والديون:** رصيد دَين كل عميل، استلام الدفعات، ورسالة تذكير مهذبة عبر واتساب.
- **الوارد:** إدخال البضاعة يزيد المخزون ويحسب **متوسط التكلفة المرجّح** تلقائيًا.
- **التقارير (للمالك فقط):** المبيعات، الربح الإجمالي، هامش الربح، الجملة مقابل التجزئة، طرق الدفع، الديون، الأكثر مبيعًا وربحًا، المخزون المنخفض، ومن أين عرف العملاء المتجر. نسخ تقرير يومي/شهري جاهز لواتساب.
- **الكاشير** لا يرى التكلفة ولا الأرباح إطلاقًا.
- **استيراد المنتجات من majoo** بملف CSV مع مطابقة الأعمدة تلقائيًا.
- زر **ع / ID** في الأعلى يبدّل الواجهة بين العربية والإندونيسية.
