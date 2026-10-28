// v75: the self-migrations (ADD COLUMN / CREATE … IF NOT EXISTS, append-only lists in core.js, field.js) run once per DATABASE,
// not once per Worker instance. pos_meta keeps how many statements of a list this database already has ('schema:pos' …):
// an instance reads that one row and runs only the newer statements — before, every new instance sent the whole list again
// (55 D1 calls for POS, past the free plan's limit of 50 a request) on its first request. At most PER_REQUEST statements go
// out in one request; the rest follow with the next one.
export const PER_REQUEST = 40; // + the login gate, this row, the reads, the writes and the meter: under the free plan's 50 calls
const DONE_BEFORE = /duplicate column name/i; // an ADD COLUMN this database already has

/** Runs the statements of `list` this database does not have yet; true when the whole list is in. */
export async function runMigrations(adapter, key, list) {
  let done = 0;
  try {
    const r = await adapter.all('SELECT v FROM pos_meta WHERE k = ?', [key]);
    done = Number((r && r[0] && r[0].v) || 0) || 0;
  } catch (e) { // no pos_meta yet (a new database): made here (as src/tablecache.js makes it), and the list runs from the start
    done = 0;
    try { await adapter.run('CREATE TABLE IF NOT EXISTS pos_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)', []); } catch (e2) { /* then it is not kept */ }
  }
  if (done > list.length || done < 0) done = 0; // a list that got shorter: run it all again (each statement is idempotent)
  if (done === list.length) return true;
  const upTo = Math.min(list.length, done + PER_REQUEST);
  let reached = upTo; // the statements before this index are in; a failure stops it there (that statement is tried again later)
  for (let i = done; i < upTo; i++) {
    try { await adapter.run(list[i], []); } catch (e) {
      if (!DONE_BEFORE.test(String((e && e.message) || '')) && reached === upTo) reached = i;
    }
  }
  if (reached > done) {
    try { await adapter.run('INSERT INTO pos_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [key, reached]); } catch (e) { /* next instance runs them again */ }
  }
  return upTo === list.length;
}
