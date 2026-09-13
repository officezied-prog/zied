-- =============================================================================
-- SmartStylist — 0011: make views respect row-level security
--
-- Found in Phase 2. PostgreSQL evaluates a view with the *owner's* privileges
-- unless `security_invoker` is set. Since these views are owned by the role that
-- owns the tables, a client reading through them would have bypassed RLS
-- entirely and seen every user's rows — the exact leak RLS exists to prevent.
--
-- `security_invoker = true` makes the caller's policies apply, so the views are
-- as safe as the tables underneath. Requires PostgreSQL 15+.
-- =============================================================================

alter view public.v_user_consent_state    set (security_invoker = true);
alter view public.v_garment_primary_color set (security_invoker = true);
alter view public.v_wardrobe_stats        set (security_invoker = true);

grant select on public.v_user_consent_state,
                public.v_garment_primary_color,
                public.v_wardrobe_stats
   to authenticated;
grant select on public.v_user_consent_state,
                public.v_garment_primary_color,
                public.v_wardrobe_stats
   to service_role;

-- Guard against the same mistake in future migrations: any new view added to
-- `public` must opt in explicitly.
do $$
declare
  v record;
begin
  for v in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
       and coalesce((select option_value from pg_options_to_table(c.reloptions)
                      where option_name = 'security_invoker'), 'false') <> 'true'
  loop
    raise exception 'view public.% is not security_invoker — it would bypass RLS', v.relname;
  end loop;
end $$;
