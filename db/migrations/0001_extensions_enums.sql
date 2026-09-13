-- =============================================================================
-- SmartStylist — 0001: extensions, schemas, enums, shared helpers
-- Target: PostgreSQL 15+ (validated on 16.13) / Supabase-compatible
-- =============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid(), digest(), crypt()
create extension if not exists citext;     -- case-insensitive email
create extension if not exists pg_trgm;    -- fuzzy search on brand / name
create extension if not exists btree_gist; -- exclusion constraints (primary photo, etc.)

-- `public`  : PostgREST/Supabase-exposed application data, protected by RLS.
-- `private` : sensitive data (biometrics, OAuth tokens). NEVER exposed to the
--             API layer directly; reachable only by the service role and by
--             SECURITY DEFINER functions in `public`.
-- `audit`   : append-only trails.
create schema if not exists private;
create schema if not exists audit;

revoke all on schema private from public;
revoke all on schema audit   from public;

-- -----------------------------------------------------------------------------
-- Identity helper: resolves the calling user without depending on Supabase.
-- On Supabase, PostgREST sets `request.jwt.claims`.
-- On a self-hosted FastAPI stack, the connection pool sets `app.current_user_id`
-- via `SET LOCAL` at the start of each request transaction.
-- -----------------------------------------------------------------------------
create or replace function public.current_user_id()
returns uuid
language plpgsql
stable
as $$
declare
  v_id uuid;
begin
  begin
    v_id := nullif(current_setting('app.current_user_id', true), '')::uuid;
  exception when others then
    v_id := null;
  end;

  if v_id is null then
    begin
      v_id := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
    exception when others then
      v_id := null;
    end;
  end if;

  return v_id;
end;
$$;

comment on function public.current_user_id() is
  'Current authenticated user id, from app.current_user_id GUC or the JWT sub claim.';

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =============================================================================
-- ENUMS
-- =============================================================================

-- Where an image came from.
create type public.media_source as enum (
  'manual_upload', 'instagram', 'tiktok', 'facebook',
  'vton_output', 'segmentation_output', 'system'
);

create type public.social_provider as enum ('instagram', 'tiktok', 'facebook');

-- Generic lifecycle for every async job (ingest, CV, VTON, recommendation batch).
create type public.job_status as enum (
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'partial', 'expired'
);

create type public.moderation_status as enum ('pending', 'approved', 'rejected', 'needs_review');

-- Outfit slot a garment can occupy. Distinct from the category taxonomy:
-- a "denim jacket" is category outerwear/jacket/denim but fills the OUTERWEAR slot.
create type public.garment_role as enum (
  'base_top', 'mid_layer', 'outerwear', 'bottom', 'full_body',
  'footwear', 'bag', 'headwear', 'eyewear', 'jewelry',
  'belt', 'scarf', 'watch', 'hosiery', 'other_accessory'
);

create type public.season as enum ('spring', 'summer', 'autumn', 'winter', 'all_season');

create type public.pattern_type as enum (
  'solid', 'striped', 'checked', 'plaid', 'floral', 'polka_dot', 'animal',
  'geometric', 'abstract', 'camouflage', 'graphic', 'paisley', 'houndstooth',
  'herringbone', 'tie_dye', 'logo', 'colorblock', 'other'
);

create type public.fit_type as enum (
  'skinny', 'slim', 'regular', 'relaxed', 'loose', 'oversized', 'tailored', 'unspecified'
);

create type public.body_shape as enum (
  'hourglass', 'pear', 'apple', 'rectangle', 'inverted_triangle',
  'oval', 'athletic', 'unspecified'
);

create type public.face_shape as enum (
  'oval', 'round', 'square', 'heart', 'diamond', 'oblong', 'triangle', 'unspecified'
);

create type public.skin_undertone as enum ('cool', 'warm', 'neutral', 'olive', 'unspecified');

-- 12-season professional colour analysis system.
create type public.seasonal_palette as enum (
  'bright_spring', 'true_spring', 'light_spring',
  'light_summer', 'true_summer', 'soft_summer',
  'soft_autumn', 'true_autumn', 'dark_autumn',
  'dark_winter', 'true_winter', 'bright_winter',
  'unspecified'
);

-- Consent is granular and versioned; biometric + social ingest are separate grants.
create type public.consent_type as enum (
  'terms_of_service', 'privacy_policy', 'biometric_processing',
  'social_ingest', 'vton_processing', 'model_training', 'marketing'
);

create type public.vton_provider as enum ('internal_gpu', 'replicate', 'fal', 'runpod', 'mock');

create type public.feedback_kind as enum (
  'like', 'dislike', 'save', 'worn', 'skip', 'shared', 'purchase_intent'
);

create type public.unit_system as enum ('metric', 'imperial');

create type public.color_harmony as enum (
  'monochromatic', 'analogous', 'complementary', 'split_complementary',
  'triadic', 'tetradic', 'neutral_anchor', 'accent_pop'
);

create type public.measurement_source as enum (
  'self_reported', 'photo_estimated', 'smpl_fitted', 'tailor_measured', 'imported'
);
