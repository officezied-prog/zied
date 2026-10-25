// v74 (owner 2026-10-25: the store stopped at 15:00 — the free plan's 5,000,000 D1 rows a day were used up; «أريد أصلح هذه نهائياً …
// أريد مجانية وآمنة»). Two parts, both under every endpoint through the D1 adapter (src/index.js d1Adapter):
//
// 1. Whole tables in memory. Every request used to read the tables it loads whole (all 1,873 products, every customer, user,
//    setting, device, chat message …) — about 2,700 rows a request. Now each such table is kept in this Worker's memory with
//    a version number (table pos_meta, one row per table); every write to the table raises its version IN THE SAME D1 CALL
//    (one transaction), so a request that reads the versions (a few rows) knows exactly which kept tables are still current
//    and reads again only those that changed. A random "epoch" row tells one database from another (each test database,
//    a restored copy), and a table is read again at least every 30 minutes anyway (an edit made outside the Worker).
//
// 2. A guard before the limit (today's rows read, kept by recordUsage): from 70 % of the free day, reports and chat wait
//    for tomorrow; from 90 %, only what keeps the shop selling goes on (login, data, sales, payments, the drawer …). The apps
//    take error QUOTA like a lost connection: sales wait in their outbox and go out by themselves.

export const FREE_READS_A_DAY = 5000000;
export const QUOTA_SOFT = Math.round(FREE_READS_A_DAY * 0.7);
export const QUOTA_HARD = Math.round(FREE_READS_A_DAY * 0.9);
const TTL_MS = 30 * 60000;

/** Every table a loader reads whole (`SELECT * FROM t ORDER BY id`). test/v74.test.js checks the loaders against this list. */
export const CACHE_TABLES = new Set([
  'pos_products', 'pos_customers', 'pos_users', 'pos_settings', 'pos_devices', 'pos_chat', 'pos_shops', 'pos_workers', 'pos_att_seals',
  'cold_warehouses', 'cold_products', 'cold_pallets', 'cold_movements', 'cold_orders', 'cold_checks', 'cold_containers',
  'cold_product_requests', 'brad_orders',
]);

// What keeps the shop selling: allowed up to the hard limit. Everything else is refused from QUOTA_HARD on.
const ESSENTIAL = {
  pos: ['login', 'bootstrap', 'save_sale', 'receive_payment', 'save_expense', 'cash_move', 'save_customer', 'open_shift', 'close_shift',
    'check_approval', 'request_discount', 'request_credit', 'device_ping', 'change_pin'],
  field: ['field_bootstrap', 'day_start', 'day_end', 'check_in', 'field_order', 'track'],
};
// Reports and chat: refused from QUOTA_SOFT on (they come back by themselves tomorrow).
const REPORTS = ['get_sales', 'list_activity', 'list_purchases', 'daily_report', 'profit_loss', 'finance_position', 'party_ledger', 'list_returns',
  'list_corrections', 'list_invoice_changes', 'list_disputes', 'list_transfers', 'list_pay_plans', 'list_devices', 'list_tamper_shots', 'bank_recon',
  'list_photos', 'list_field', 'orders_map', 'shop_photos', 'street_returns', 'lists_sent', 'list_reps', 'product_images', 'places_search', 'places_status'];

export class QuotaError extends Error {
  constructor(level) {
    super('QUOTA'); this.code = 'QUOTA'; this.level = level;
    this.response = { ok: false, error: 'QUOTA', level,
      message: level === 'hard'
        ? 'Kuota server hari ini hampir habis: hanya penjualan, pembayaran, dan kas yang dilayani sampai jam 07:00 WIB besok.'
        : 'Kuota server hari ini menipis: laporan dan chat dibuka lagi besok jam 07:00 WIB. Penjualan tetap jalan.' };
  }
}
/** null = served; 'soft' / 'hard' = refused at that level. route: 'pos' | 'field' | 'chat' | 'att' | 'photo' | 'cold' | 'brad'. */
export function quotaRefusal(readsToday, route, action) {
  const n = Number(readsToday) || 0;
  if (n >= QUOTA_HARD) return (ESSENTIAL[route] || []).indexOf(action) >= 0 ? null : 'hard';
  if (n >= QUOTA_SOFT) return route === 'chat' || REPORTS.indexOf(action) >= 0 ? 'soft' : null;
  return null;
}

/** The table an SQL statement writes ('' when it writes none). */
export function writtenTable(sql) {
  const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|ALTER\s+TABLE)\s+["`[]?(\w+)/i.exec(String(sql || ''));
  return m ? m[1].toLowerCase() : '';
}
const WHOLE = /^SELECT \* FROM (\w+) ORDER BY id$/;
const bump = (t) => ({ sql: 'INSERT INTO pos_meta (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1', params: ['ver:' + t], kind: 'run' });
const NO_META = /no such table: (pos_meta|pos_api_usage)/i;
const today = () => new Date().toISOString().slice(0, 10); // the free day is a UTC day (pos_api_usage month = UTC date)

// table → { epoch, v, at, rows } — one per Worker instance, shared by its requests; the epoch keeps databases apart
const KEPT = new Map();
export function _clearTableCacheForTests() { KEPT.clear(); }

/**
 * Adds the kept tables and the version raise to a db.js adapter (all / run / batch), in place: `adapter.tables` is what
 * execSpecs uses; writes to a kept table raise its version in the same D1 call. opts.now for tests.
 */
export function withTableCache(adapter, opts = {}) {
  const now = opts.now || (() => Date.now());
  const run0 = adapter.run.bind(adapter), batch0 = adapter.batch ? adapter.batch.bind(adapter) : null;
  const ensureMeta = async () => { // once per database (the first request after this version): two D1 calls — the tables, then
    // the epoch (a statement is never sent in the same call as the table it needs)
    const make = [
      { sql: 'CREATE TABLE IF NOT EXISTS pos_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)', params: [], kind: 'run' },
      { sql: 'CREATE TABLE IF NOT EXISTS pos_api_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, api TEXT, month TEXT, n INTEGER NOT NULL DEFAULT 0, updated_at TEXT)', params: [], kind: 'run' },
    ];
    if (batch0) await batch0(make); else for (const q of make) await run0(q.sql, q.params);
    await run0('INSERT OR IGNORE INTO pos_meta (k, v) VALUES (?, ?)', ['epoch', 1 + Math.floor(Math.random() * 2e9)]);
  };
  const retryMeta = async (fn) => { try { return await fn(); } catch (e) { if (!NO_META.test(String((e && e.message) || ''))) throw e; await ensureMeta(); return fn(); } };
  adapter.run = async (sql, params) => {
    const t = writtenTable(sql);
    if (!CACHE_TABLES.has(t)) return run0(sql, params);
    if (batch0) return (await retryMeta(() => batch0([{ sql, params, kind: 'run' }, bump(t)])))[0];
    const r = await run0(sql, params);
    await retryMeta(() => run0(bump(t).sql, bump(t).params));
    return r;
  };
  if (batch0) {
    adapter.batch = async (list) => {
      const ts = [...new Set(list.filter((q) => q.kind === 'run').map((q) => writtenTable(q.sql)).filter((t) => CACHE_TABLES.has(t)))];
      if (!ts.length) return batch0(list);
      return (await retryMeta(() => batch0(list.concat(ts.map(bump))))).slice(0, list.length);
    };
  }
  // the epoch, the versions of the tables this request reads whole and today's reads — a few rows by primary key / index
  const versionSpec = (tables) => {
    const keys = ['epoch'].concat((tables || []).map((t) => 'ver:' + t));
    return { sql: `SELECT k, v FROM pos_meta WHERE k IN (${keys.map(() => '?').join(', ')}) UNION ALL SELECT 'reads', n FROM pos_api_usage WHERE api = 'd1_read' AND month = ?`,
      params: keys.concat([today()]), kind: 'all' };
  };
  const readVersions = (rows) => { const v = {}; for (const r of rows || []) v[r.k] = Number(r.v) || 0; return v; };
  adapter.tables = {
    /** a spec this cache answers: a kept table read whole */
    covers(spec) { const m = spec && !(spec.params || []).length && WHOLE.exec(spec.sql); return !!(m && m[1] === spec.table && CACHE_TABLES.has(spec.table)); },
    versionSpec,
    readVersions,
    /** after the versions: refuse (QuotaError) when today's reads passed a limit for this request (adapter.req = { route, action }) */
    guard(versions) {
      const req = adapter.req;
      if (!req) return;
      const level = quotaRefusal(versions.reads, req.route, req.action);
      if (level) throw new QuotaError(level);
    },
    fresh(table, versions) {
      const k = KEPT.get(table);
      return !!(k && versions.epoch && k.epoch === versions.epoch && k.v === (versions['ver:' + table] || 0) && now() - k.at < TTL_MS);
    },
    keep(table, rows, versions) { if (versions.epoch) KEPT.set(table, { epoch: versions.epoch, v: versions['ver:' + table] || 0, at: now(), rows }); },
    /** a copy for this request (process.js changes the rows it is given) */
    rows(table) { return KEPT.get(table).rows.map((r) => Object.assign({}, r)); },
    async versions(tables, extra) { // [versions of these tables, …extra] in one call; the meta table made on first use
      const list = [versionSpec(tables)].concat(extra || []);
      const res = await retryMeta(async () => {
        if (batch0 && list.length > 1) return adapter.batch(list);
        const out = [];
        for (const q of list) out.push(await adapter.all(q.sql, q.params));
        return out;
      });
      let v = readVersions(res[0]);
      if (!v.epoch) { await ensureMeta(); const q = versionSpec(tables); v = readVersions(await adapter.all(q.sql, q.params)); }
      return { v, res: res.slice(1) };
    },
  };
  return adapter;
}
