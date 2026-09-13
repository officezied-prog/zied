-- =============================================================================
-- SmartStylist — 0008: roles, audit trail, row-level security
-- =============================================================================

-- Supabase already provides these roles; create them for self-hosted parity.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
-- `private` stays closed: only the service role (backend workers) may touch it.
grant usage on schema private to service_role;
grant usage on schema audit   to service_role;

-- -----------------------------------------------------------------------------
-- audit.access_log — every read/write of special-category data.
-- Written by SECURITY DEFINER accessors, never by clients.
-- -----------------------------------------------------------------------------
create table audit.access_log (
  id             bigint primary key generated always as identity,
  at             timestamptz not null default now(),
  actor_user_id  uuid,
  actor_role     text,
  subject_user_id uuid,
  action         text not null,       -- 'read_biometrics','write_biometrics','vton_render'
  object_type    text,
  object_id      text,
  request_id     text,
  ip_address     inet,
  details        jsonb not null default '{}'::jsonb
);
create index access_log_subject_idx on audit.access_log (subject_user_id, at desc);
create index access_log_action_idx  on audit.access_log (action, at desc);

-- -----------------------------------------------------------------------------
-- Biometric accessors — the ONLY sanctioned path into private.biometric_profiles.
-- Each call checks consent and writes an audit row.
-- -----------------------------------------------------------------------------
create or replace function public.get_biometric_profile(p_user_id uuid default null)
returns private.biometric_profiles
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_target uuid := coalesce(p_user_id, public.current_user_id());
  v_row    private.biometric_profiles%rowtype;
begin
  if v_target is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if v_target <> public.current_user_id() and current_user <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_row from private.biometric_profiles where user_id = v_target;

  insert into audit.access_log (actor_user_id, actor_role, subject_user_id, action, object_type)
  values (public.current_user_id(), current_user, v_target, 'read_biometrics', 'biometric_profile');

  return v_row;
end;
$$;

create or replace function public.upsert_biometric_profile(p_patch jsonb)
returns private.biometric_profiles
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := public.current_user_id();
  v_row  private.biometric_profiles%rowtype;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if not public.has_consent(v_user, 'biometric_processing') then
    raise exception 'biometric_processing consent required' using errcode = '42501';
  end if;

  insert into private.biometric_profiles (user_id)
  values (v_user)
  on conflict (user_id) do nothing;

  -- jsonb_populate_record merges only the keys present in the patch.
  update private.biometric_profiles b
     set (height_cm, weight_kg, chest_bust_cm, underbust_cm, waist_cm, hip_cm,
          shoulder_width_cm, inseam_cm, arm_length_cm, neck_cm, foot_length_cm,
          shoe_size_eu, body_shape, measurement_source, skin_tone_hex,
          skin_tone_monk, skin_undertone, hair_color_hex, eye_color_hex,
          contrast_level, seasonal_palette, face_shape, sizing_profile, size_labels)
       = (select p.height_cm, p.weight_kg, p.chest_bust_cm, p.underbust_cm, p.waist_cm,
                 p.hip_cm, p.shoulder_width_cm, p.inseam_cm, p.arm_length_cm, p.neck_cm,
                 p.foot_length_cm, p.shoe_size_eu, p.body_shape, p.measurement_source,
                 p.skin_tone_hex, p.skin_tone_monk, p.skin_undertone, p.hair_color_hex,
                 p.eye_color_hex, p.contrast_level, p.seasonal_palette, p.face_shape,
                 p.sizing_profile, p.size_labels
            from jsonb_populate_record(b, p_patch) p)
   where b.user_id = v_user
   returning * into v_row;

  insert into audit.access_log (actor_user_id, actor_role, subject_user_id, action, object_type, details)
  values (v_user, current_user, v_user, 'write_biometrics', 'biometric_profile',
          jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)));

  return v_row;
end;
$$;

revoke all on function public.get_biometric_profile(uuid)    from public;
revoke all on function public.upsert_biometric_profile(jsonb) from public;
grant execute on function public.get_biometric_profile(uuid)    to authenticated, service_role;
grant execute on function public.upsert_biometric_profile(jsonb) to authenticated, service_role;

-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================

-- Owner-scoped tables: a row is visible iff user_id = current_user_id().
do $$
declare
  t text;
  owner_tables text[] := array[
    'users','user_devices','user_consents','style_preferences','social_accounts',
    'media_assets','ingest_jobs','social_posts','detections','garments',
    'wear_log','outfits','outfit_feedback','recommendation_runs','vton_jobs',
    'usage_counters','deletion_requests','garment_embeddings',
    'user_style_embeddings','outfit_embeddings'
  ];
  id_col text;
begin
  foreach t in array owner_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    id_col := case when t = 'users' then 'id' else 'user_id' end;

    execute format($p$
      create policy %1$I_owner_select on public.%1$I
        for select to authenticated
        using (%2$I = public.current_user_id())
    $p$, t, id_col);

    execute format($p$
      create policy %1$I_owner_modify on public.%1$I
        for all to authenticated
        using (%2$I = public.current_user_id())
        with check (%2$I = public.current_user_id())
    $p$, t, id_col);

    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

-- Child tables scoped through their parent.
alter table public.garment_colors enable row level security;
alter table public.garment_colors force row level security;
create policy garment_colors_owner on public.garment_colors
  for all to authenticated
  using (exists (select 1 from public.garments g
                  where g.id = garment_id and g.user_id = public.current_user_id()))
  with check (exists (select 1 from public.garments g
                  where g.id = garment_id and g.user_id = public.current_user_id()));

alter table public.outfit_items enable row level security;
alter table public.outfit_items force row level security;
create policy outfit_items_owner on public.outfit_items
  for all to authenticated
  using (exists (select 1 from public.outfits o
                  where o.id = outfit_id and o.user_id = public.current_user_id()))
  with check (exists (select 1 from public.outfits o
                  where o.id = outfit_id and o.user_id = public.current_user_id()));

grant select, insert, update, delete on public.garment_colors, public.outfit_items to authenticated;
grant all on public.garment_colors, public.outfit_items to service_role;

-- Occasions: global catalogue readable by all, custom rows owner-scoped.
alter table public.occasions enable row level security;
create policy occasions_read on public.occasions
  for select to authenticated
  using (user_id is null or user_id = public.current_user_id());
create policy occasions_write on public.occasions
  for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
grant select, insert, update, delete on public.occasions to authenticated;

-- Reference data: read-only to clients, writable only by the service role.
do $$
declare t text;
begin
  foreach t in array array['garment_categories','color_families','color_pair_rules',
                           'palette_affinity','vton_models','style_references',
                           'weather_snapshots'] loop
    execute format('grant select on public.%I to authenticated, anon', t);
    execute format('grant all    on public.%I to service_role', t);
  end loop;
end $$;

-- webhook_events / audit are service-role only (no grants to authenticated).
grant all on public.webhook_events to service_role;
grant all on all tables in schema private to service_role;
grant all on all tables in schema audit   to service_role;
grant usage, select on all sequences in schema public  to service_role;
grant usage, select on all sequences in schema private to service_role;
grant usage, select on all sequences in schema audit   to service_role;
