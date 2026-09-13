#!/usr/bin/env bash
# Apply migrations + seeds to a database, then run the smoke test.
#   ./scripts/db_bootstrap.sh "postgresql://user:pass@host:5432/smartstylist" [--no-seed] [--no-test]
set -euo pipefail

DB_URL="${1:?usage: db_bootstrap.sh <postgres-url> [--no-seed] [--no-test]}"
shift || true
SEED=1; TEST=1
for arg in "$@"; do
  case "$arg" in
    --no-seed) SEED=0 ;;
    --no-test) TEST=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
psql_run() { psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$1"; }

echo "── migrations ─────────────────────────────"
for f in "$ROOT"/db/migrations/*.sql; do
  printf '  %-46s' "$(basename "$f")"; psql_run "$f"; echo "ok"
done

if [ "$SEED" -eq 1 ]; then
  echo "── seeds ──────────────────────────────────"
  for f in "$ROOT"/db/seeds/*.sql; do
    printf '  %-46s' "$(basename "$f")"; psql_run "$f"; echo "ok"
  done
fi

if [ "$TEST" -eq 1 ]; then
  echo "── smoke test ─────────────────────────────"
  psql "$DB_URL" -X -q -f "$ROOT/db/tests/smoke_test.sql" 2>&1 \
    | grep -E 'PASS|FAIL|ERROR' | sed 's/^psql:.*NOTICE:  //' | sed 's/^/  /'
  echo "  (the test transaction rolls back; seeded reference data is untouched)"
fi

echo "done."
