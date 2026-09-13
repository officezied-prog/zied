-- =============================================================================
-- SmartStylist — 0002: users, devices, consent ledger, biometric profile,
--                      social account links
-- =============================================================================

-- -----------------------------------------------------------------------------
-- users
-- On Supabase, `id` mirrors auth.users(id) (populated by an on-signup trigger).
-- On a self-hosted stack this is the authoritative identity row.
-- -----------------------------------------------------------------------------
create table public.users (
  id                  uuid primary key default gen_random_uuid(),
  email               citext unique,
  phone               text unique,
  display_name        text,
  avatar_media_id     uuid,                      -- FK added in 0003 (media_assets)
  locale              text not null default 'en',
  country_code        char(2),
  timezone            text not null default 'UTC',
  units               public.unit_system not null default 'metric',
  onboarding_stage    text not null default 'created'
                      check (onboarding_stage in
                        ('created','profile','biometrics','wardrobe','ready')),
  is_active           boolean not null default true,
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Soft delete first, hard purge by a scheduled job (GDPR erasure window).
  deleted_at          timestamptz,
  purge_after         timestamptz
);

create index users_active_idx on public.users (id) where deleted_at is null;
create index users_purge_idx  on public.users (purge_after) where purge_after is not null;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Push / device registry
-- -----------------------------------------------------------------------------
create table public.user_devices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  platform       text not null check (platform in ('ios','android','web')),
  push_token     text,
  app_version    text,
  os_version     text,
  device_model   text,
  last_active_at timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (user_id, push_token)
);
create index user_devices_user_idx on public.user_devices (user_id);

-- -----------------------------------------------------------------------------
-- Consent ledger — append-only. Never UPDATE a grant; insert a revocation row.
-- Required for GDPR Art. 9 (biometric data) and Meta/TikTok platform terms.
-- -----------------------------------------------------------------------------
create table public.user_consents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id) on delete cascade,
  consent_type    public.consent_type not null,
  granted         boolean not null,
  policy_version  text not null,              -- e.g. 'privacy-2026-04-01'
  source          text not null default 'app' check (source in ('app','web','support','import')),
  ip_address      inet,
  user_agent      text,
  created_at      timestamptz not null default now()
);
create index user_consents_lookup_idx
  on public.user_consents (user_id, consent_type, created_at desc);

-- Latest state per (user, consent_type).
create or replace view public.v_user_consent_state as
select distinct on (user_id, consent_type)
       user_id, consent_type, granted, policy_version, created_at as decided_at
from   public.user_consents
order by user_id, consent_type, created_at desc;

-- Guard used by every biometric / VTON write path.
create or replace function public.has_consent(p_user_id uuid, p_type public.consent_type)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select granted
       from public.user_consents
      where user_id = p_user_id and consent_type = p_type
      order by created_at desc
      limit 1),
    false);
$$;

-- -----------------------------------------------------------------------------
-- Style preferences (non-sensitive, drives the recommendation engine)
-- -----------------------------------------------------------------------------
create table public.style_preferences (
  user_id            uuid primary key references public.users(id) on delete cascade,
  style_archetypes   text[] not null default '{}',   -- classic, streetwear, minimal, boho...
  preferred_colors   text[] not null default '{}',   -- hex
  avoided_colors     text[] not null default '{}',
  avoided_categories text[] not null default '{}',
  avoided_patterns   public.pattern_type[] not null default '{}',
  modesty_rules      jsonb not null default '{}'::jsonb,
    -- e.g. {"min_sleeve":"elbow","cover_knees":true,"headwear_required":true}
  fit_preference     public.fit_type not null default 'unspecified',
  budget_tier        smallint check (budget_tier between 1 and 5),
  favourite_brands   text[] not null default '{}',
  allow_new_purchases boolean not null default true,   -- suggest items not owned?
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger style_preferences_set_updated_at
  before update on public.style_preferences
  for each row execute function public.tg_set_updated_at();

-- =============================================================================
-- PRIVATE SCHEMA — biometric + credential material
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.biometric_profiles
-- Special-category data under GDPR Art. 9 / BIPA-style statutes. Rules:
--   * one row per user, written only through public.upsert_biometric_profile()
--   * requires an active 'biometric_processing' consent
--   * numeric measurements stored in metric; the API converts for display
--   * face/skin descriptors are derived attributes, NOT raw face templates
-- -----------------------------------------------------------------------------
create table private.biometric_profiles (
  user_id             uuid primary key references public.users(id) on delete cascade,

  -- Body
  height_cm           numeric(5,1) check (height_cm between 80 and 260),
  weight_kg           numeric(5,1) check (weight_kg between 25 and 350),
  chest_bust_cm       numeric(5,1) check (chest_bust_cm between 40 and 200),
  underbust_cm        numeric(5,1) check (underbust_cm between 40 and 200),
  waist_cm            numeric(5,1) check (waist_cm between 40 and 200),
  hip_cm              numeric(5,1) check (hip_cm between 40 and 220),
  shoulder_width_cm   numeric(4,1) check (shoulder_width_cm between 20 and 80),
  inseam_cm           numeric(4,1) check (inseam_cm between 40 and 120),
  arm_length_cm       numeric(4,1) check (arm_length_cm between 30 and 100),
  neck_cm             numeric(4,1) check (neck_cm between 20 and 70),
  foot_length_cm      numeric(4,1) check (foot_length_cm between 15 and 40),
  shoe_size_eu        numeric(4,1),
  body_shape          public.body_shape not null default 'unspecified',
  measurement_source  public.measurement_source not null default 'self_reported',

  -- Parametric body model (SMPL-X betas) when estimated from photos.
  smpl_betas          real[],
  smpl_gender         text check (smpl_gender in ('neutral','male','female')),

  -- Colour analysis
  skin_tone_hex       char(7) check (skin_tone_hex ~ '^#[0-9A-Fa-f]{6}$'),
  skin_tone_monk      smallint check (skin_tone_monk between 1 and 10), -- Monk Skin Tone Scale
  skin_undertone      public.skin_undertone not null default 'unspecified',
  hair_color_hex      char(7) check (hair_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  eye_color_hex       char(7) check (eye_color_hex ~ '^#[0-9A-Fa-f]{6}$'),
  contrast_level      smallint check (contrast_level between 1 and 5),
  seasonal_palette    public.seasonal_palette not null default 'unspecified',
  face_shape          public.face_shape not null default 'unspecified',

  -- Self-described identity used only for garment sizing/fit heuristics.
  sizing_profile      text check (sizing_profile in ('womenswear','menswear','unisex')),
  size_labels         jsonb not null default '{}'::jsonb,  -- {"tops":"M","eu_jeans":"31"}

  consent_version     text,
  computed_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create trigger biometric_profiles_set_updated_at
  before update on private.biometric_profiles
  for each row execute function public.tg_set_updated_at();

comment on table private.biometric_profiles is
  'GDPR Art.9 special-category data. Access via SECURITY DEFINER accessors only; '
  'deployments should additionally wrap this table with pgsodium/TDE column encryption.';

-- -----------------------------------------------------------------------------
-- private.social_credentials — OAuth material.
-- Store a *reference* to a secrets manager (AWS Secrets Manager / Supabase Vault),
-- never the raw token, so a DB dump alone cannot impersonate the user.
-- -----------------------------------------------------------------------------
create table private.social_credentials (
  social_account_id    uuid primary key,        -- FK added below
  access_token_ref     text not null,
  refresh_token_ref    text,
  token_expires_at     timestamptz,
  refresh_expires_at   timestamptz,
  scopes               text[] not null default '{}',
  encrypted_payload    bytea,                   -- optional pgcrypto fallback
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Social account links (public metadata only)
-- -----------------------------------------------------------------------------
create table public.social_accounts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  provider           public.social_provider not null,
  provider_user_id   text not null,
  handle             text,
  account_type       text,                     -- business / creator / personal
  status             text not null default 'connected'
                     check (status in ('connected','expired','revoked','error','disconnected')),
  scopes             text[] not null default '{}',
  last_synced_at     timestamptz,
  last_error         text,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (provider, provider_user_id),
  unique (user_id, provider)
);
create index social_accounts_user_idx on public.social_accounts (user_id);

alter table private.social_credentials
  add constraint social_credentials_account_fk
  foreign key (social_account_id) references public.social_accounts(id) on delete cascade;

create trigger social_accounts_set_updated_at
  before update on public.social_accounts
  for each row execute function public.tg_set_updated_at();

-- -----------------------------------------------------------------------------
-- Platform-mandated erasure requests (Meta "Data Deletion Callback", TikTok DSR)
-- -----------------------------------------------------------------------------
create table public.deletion_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references public.users(id) on delete set null,
  provider        public.social_provider,
  external_ref    text,                        -- confirmation code returned to the platform
  scope           text not null default 'provider_data'
                  check (scope in ('provider_data','account','biometrics','media')),
  status          public.job_status not null default 'queued',
  requested_at    timestamptz not null default now(),
  completed_at    timestamptz,
  details         jsonb not null default '{}'::jsonb
);
create index deletion_requests_status_idx on public.deletion_requests (status, requested_at);
