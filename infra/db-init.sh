#!/bin/bash
# Runs once, on first start of an empty database volume.
# Applies migrations then seeds in numeric order, then creates a demo user so
# the interactive docs are usable immediately.
set -euo pipefail

psql() { command psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"; }

echo "── migrations ─────────────────────────────"
for f in /sql/migrations/*.sql; do
  printf '  %-46s' "$(basename "$f")"; psql -f "$f"; echo "ok"
done

echo "── seeds ──────────────────────────────────"
for f in /sql/seeds/*.sql; do
  printf '  %-46s' "$(basename "$f")"; psql -f "$f"; echo "ok"
done

echo "── demo user ──────────────────────────────"
psql <<'SQL'
insert into public.users (id, email, display_name, onboarding_stage)
values ('00000000-0000-4000-8000-000000000001', 'demo@smartstylist.local', 'Demo', 'ready')
on conflict (id) do nothing;

insert into public.user_consents (user_id, consent_type, granted, policy_version)
values ('00000000-0000-4000-8000-000000000001', 'terms_of_service', true,      'privacy-2026-04-01'),
       ('00000000-0000-4000-8000-000000000001', 'vton_processing', true,       'privacy-2026-04-01'),
       ('00000000-0000-4000-8000-000000000001', 'biometric_processing', true,  'privacy-2026-04-01');
SQL
echo "  demo user 00000000-0000-4000-8000-000000000001 ready"
