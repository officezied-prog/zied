/* Khair Mart — shop categories for field sales (Khair Sales, owner app Lapangan, mocks).
   One list, grouped by the kind of business a rep visits. Each type has an Indonesian and an Arabic label;
   modern-retail and wholesale types carry chain names the rep can pick (or type a new one).
   The server keeps the same type ids (backend/field/process-field.js SHOP_TYPES); an unknown id becomes 'lainnya'
   and the rep's own words go to type_other. Old ids (warung, toko, minimarket, bakery, katering, restoran, masjid,
   lainnya) are kept so existing shops stay valid. */
(function (root) {
  var GROUPS = [
    { id: 'haji_umrah', id_label: 'Haji & Umrah', ar: 'الحج والعمرة', types: [
      { id: 'perlengkapan_haji', id_label: 'Toko perlengkapan haji & umrah', ar: 'متجر لوازم الحج والعمرة' },
      { id: 'travel_umrah', id_label: 'Travel umrah / haji (KBIH)', ar: 'وكالة سفر عمرة / حج' },
      { id: 'oleh_oleh_haji', id_label: 'Oleh-oleh haji & umrah', ar: 'هدايا الحج والعمرة' }
    ] },
    { id: 'muslim', id_label: 'Toko Muslim', ar: 'متاجر إسلامية', types: [
      { id: 'toko_kurma', id_label: 'Toko kurma & makanan Timur Tengah', ar: 'متجر تمور ومواد شرق أوسطية' },
      { id: 'herbal', id_label: 'Toko herbal / thibbun nabawi', ar: 'متجر أعشاب / طب نبوي' },
      { id: 'busana_muslim', id_label: 'Busana muslim', ar: 'ملابس إسلامية' },
      { id: 'toko_buku_islam', id_label: 'Toko buku & perlengkapan Islam', ar: 'مكتبة ولوازم إسلامية' }
    ] },
    { id: 'sembako', id_label: 'Sembako & kelontong', ar: 'مواد غذائية أساسية (سنباكو)', types: [
      { id: 'warung', id_label: 'Warung kelontong', ar: 'دكان صغير (وارونغ)' },
      { id: 'toko', id_label: 'Toko sembako', ar: 'متجر مواد غذائية' },
      { id: 'grosir_sembako', id_label: 'Grosir / agen sembako', ar: 'تاجر جملة مواد غذائية' },
      { id: 'pasar', id_label: 'Pedagang pasar tradisional', ar: 'تاجر سوق شعبي' }
    ] },
    { id: 'ritel_modern', id_label: 'Ritel modern', ar: 'متاجر كبرى وسلاسل', types: [
      { id: 'minimarket', id_label: 'Minimarket', ar: 'ميني ماركت',
        chains: ['Indomaret', 'Alfamart', 'Alfamidi', 'Lawson', 'FamilyMart', 'Circle K', 'Yomart', 'Indomaret Point', 'Alfa Express'] },
      { id: 'supermarket', id_label: 'Supermarket', ar: 'سوبر ماركت',
        chains: ['Superindo', 'Hero', 'Ranch Market', 'Farmers Market', 'Grand Lucky', 'The FoodHall', 'Total Buah Segar', 'Hari Hari', 'Yogya', 'Tip Top', 'Naga', 'Diamond', 'Kem Chicks', 'AEON', 'Gelael', 'Sogo Supermarket'] },
      { id: 'hypermarket', id_label: 'Hypermarket', ar: 'هايبر ماركت',
        chains: ['Hypermart', 'Transmart', 'Lotte Mart', 'Lulu Hypermarket', 'Carrefour', 'Giant'] },
      { id: 'grosir_modern', id_label: 'Grosir modern', ar: 'جملة حديثة',
        chains: ['Indogrosir', 'Lotte Grosir', 'Alfagrosir', 'Mitra10', 'Makro'] }
    ] },
    { id: 'kuliner', id_label: 'Kuliner', ar: 'مطاعم ومخابز', types: [
      { id: 'bakery', id_label: 'Bakery & toko bahan kue', ar: 'مخبز ومتجر مواد الحلويات' },
      { id: 'toko_kue', id_label: 'Toko kue & camilan', ar: 'متجر حلويات ووجبات خفيفة' },
      { id: 'katering', id_label: 'Katering', ar: 'خدمات تموين' },
      { id: 'restoran', id_label: 'Restoran (Arab / Timur Tengah)', ar: 'مطعم (عربي / شرق أوسطي)' },
      { id: 'kafe', id_label: 'Kafe / kedai kopi', ar: 'مقهى' },
      { id: 'hotel', id_label: 'Hotel & penginapan', ar: 'فندق ونُزُل' }
    ] },
    { id: 'oleh_oleh', id_label: 'Oleh-oleh, parsel & buah', ar: 'هدايا وسلال وفواكه', types: [
      { id: 'oleh_oleh', id_label: 'Toko oleh-oleh', ar: 'متجر هدايا' },
      { id: 'parsel', id_label: 'Parsel & hampers', ar: 'سلال هدايا (بارسل)' },
      { id: 'toko_buah', id_label: 'Toko buah', ar: 'متجر فواكه' }
    ] },
    { id: 'lembaga', id_label: 'Lembaga & komunitas', ar: 'مؤسسات وجماعات', types: [
      { id: 'masjid', id_label: 'Masjid / DKM', ar: 'مسجد / لجنة المسجد' },
      { id: 'pesantren', id_label: 'Pesantren', ar: 'معهد ديني (بسانترين)' },
      { id: 'sekolah', id_label: 'Sekolah / yayasan Islam', ar: 'مدرسة / مؤسسة إسلامية' },
      { id: 'majelis_taklim', id_label: 'Majelis taklim', ar: 'حلقة تعليم (مجلس تعليم)' },
      { id: 'kantor', id_label: 'Kantor / perusahaan', ar: 'مكتب / شركة' },
      { id: 'koperasi', id_label: 'Koperasi', ar: 'تعاونية' }
    ] },
    { id: 'online', id_label: 'Online & reseller', ar: 'أونلاين وموزعون', types: [
      { id: 'reseller', id_label: 'Reseller / dropshipper', ar: 'موزع / بائع بالوكالة' },
      { id: 'toko_online', id_label: 'Toko online (Shopee, Tokopedia, TikTok)', ar: 'متجر إلكتروني' }
    ] },
    { id: 'lainnya', id_label: 'Lainnya', ar: 'أخرى', types: [
      { id: 'lainnya', id_label: 'Lainnya (tulis sendiri)', ar: 'أخرى (اكتب النوع)' }
    ] }
  ];
  var BY_ID = {};
  GROUPS.forEach(function (g) { g.types.forEach(function (t) { t.group = g.id; BY_ID[t.id] = t; }); });
  var IDS = Object.keys(BY_ID);

  /** Label for a shop: the rep's own words for 'lainnya', else the type label; chain appended when known. */
  function label(shop, lang) {
    var t = BY_ID[(shop && shop.type) || 'lainnya'] || BY_ID.lainnya;
    var base = t.id === 'lainnya' && shop && shop.type_other ? String(shop.type_other) : (lang === 'ar' ? t.ar : t.id_label);
    return shop && shop.chain ? base + ' · ' + shop.chain : base;
  }
  function typeLabel(id, lang) { var t = BY_ID[id] || BY_ID.lainnya; return lang === 'ar' ? t.ar : t.id_label; }
  function groupOf(id) { return (BY_ID[id] || BY_ID.lainnya).group; }
  function groupLabel(gid, lang) { var g = GROUPS.find(function (x) { return x.id === gid; }) || GROUPS[GROUPS.length - 1]; return lang === 'ar' ? g.ar : g.id_label; }
  function chains(id) { return (BY_ID[id] && BY_ID[id].chains) || []; }

  root.KhairShopTypes = { GROUPS: GROUPS, IDS: IDS, BY_ID: BY_ID, label: label, typeLabel: typeLabel, groupOf: groupOf, groupLabel: groupLabel, chains: chains };
})(typeof window !== 'undefined' ? window : this);
