-- =============================================================================
-- SmartStylist — 0003: media assets, ingestion jobs, social posts,
--                      CV detections/segmentation output
-- =============================================================================

-- -----------------------------------------------------------------------------
-- media_assets — the single registry for every binary the system stores.
-- Bytes live in object storage (S3/R2/Supabase Storage); rows carry the pointer.
-- Buckets by sensitivity:
--   ss-user-source   original uploads / social pulls  (private, presigned reads)
--   ss-cutouts       transparent PNG garment cutouts  (private)
--   ss-body          body reference photos for VTON   (private, short-lived URLs)
--   ss-vton          generated try-on results         (private)
--   ss-public        catalogue/CDN-safe derivatives    (public read)
-- -----------------------------------------------------------------------------
create table public.media_assets (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  bucket             text not null,
  storage_key        text not null,
  cdn_url            text,
  mime_type          text not null,
  byte_size          bigint check (byte_size > 0),
  width              int   check (width  > 0),
  height             int   check (height > 0),
  source             public.media_source not null default 'manual_upload',
  -- Dedup: sha256 of the raw bytes; phash for near-duplicate social re-posts.
  sha256             char(64),
  phash              bigint,
  exif_stripped      boolean not null default false,
  captured_at        timestamptz,
  moderation_status  public.moderation_status not null default 'pending',
  moderation_labels  jsonb not null default '{}'::jsonb,
  -- Set for derived assets (cutout of X, VTON render of Y).
  parent_asset_id    uuid references public.media_assets(id) on delete set null,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (bucket, storage_key)
);

create unique index media_assets_user_sha_uidx
  on public.media_assets (user_id, sha256)
  where sha256 is not null and deleted_at is null;
create index media_assets_user_created_idx on public.media_assets (user_id, created_at desc);
create index media_assets_phash_idx on public.media_assets (user_id, phash) where phash is not null;
create index media_assets_parent_idx on public.media_assets (parent_asset_id);

alter table public.users
  add constraint users_avatar_media_fk
  foreign key (avatar_media_id) references public.media_assets(id) on delete set null;

-- -----------------------------------------------------------------------------
-- private.body_reference_photos — the person images used by the VTON engine.
-- Kept out of `public` so no API key can list them by accident.
-- -----------------------------------------------------------------------------
create table private.body_reference_photos (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  media_asset_id   uuid not null references public.media_assets(id) on delete cascade,
  pose             text not null default 'front_full'
                   check (pose in ('front_full','front_half','side','back','custom')),
  is_primary       boolean not null default false,
  -- Cached CV pre-processing so each try-on doesn't redo it.
  parsing_map_key  text,     -- human parsing (SCHP/ATR) label map
  densepose_key    text,
  pose_keypoints   jsonb,    -- OpenPose/ViTPose 18/25-point COCO format
  agnostic_key     text,     -- cloth-agnostic person representation
  quality_score    numeric(4,3) check (quality_score between 0 and 1),
  quality_issues   text[] not null default '{}',  -- blurry, occluded, cropped...
  consent_version  text,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz
);
create index body_ref_user_idx on private.body_reference_photos (user_id);
create unique index body_ref_primary_uidx
  on private.body_reference_photos (user_id) where is_primary;

-- -----------------------------------------------------------------------------
-- ingest_jobs — one row per "pull my Instagram" / "upload 30 photos" operation.
-- -----------------------------------------------------------------------------
create table public.ingest_jobs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  social_account_id  uuid references public.social_accounts(id) on delete set null,
  source             public.media_source not null,
  status             public.job_status not null default 'queued',
  -- Provider pagination cursor so a re-run is incremental, not a full refetch.
  cursor             text,
  requested_limit    int not null default 50 check (requested_limit between 1 and 500),
  items_discovered   int not null default 0,
  items_downloaded   int not null default 0,
  items_processed    int not null default 0,
  items_failed       int not null default 0,
  garments_created   int not null default 0,
  error_code         text,
  error_detail       text,
  idempotency_key    text,
  queued_at          timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  unique (user_id, idempotency_key)
);
create index ingest_jobs_user_idx   on public.ingest_jobs (user_id, queued_at desc);
create index ingest_jobs_status_idx on public.ingest_jobs (status) where status in ('queued','running');

-- -----------------------------------------------------------------------------
-- social_posts — provenance for anything pulled from a platform.
-- Only OAuth-authorised, first-party content (the user's own posts) is stored.
-- -----------------------------------------------------------------------------
create table public.social_posts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  social_account_id  uuid not null references public.social_accounts(id) on delete cascade,
  provider           public.social_provider not null,
  provider_post_id   text not null,
  provider_media_id  text,
  permalink          text,
  caption            text,
  hashtags           text[] not null default '{}',
  media_type         text check (media_type in ('image','video','carousel','story')),
  media_asset_id     uuid references public.media_assets(id) on delete set null,
  posted_at          timestamptz,
  ingest_job_id      uuid references public.ingest_jobs(id) on delete set null,
  raw_payload        jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (provider, provider_post_id, provider_media_id)
);
create index social_posts_user_idx on public.social_posts (user_id, posted_at desc);

-- -----------------------------------------------------------------------------
-- detections — raw output of the detection/segmentation pass, one row per
-- garment instance found in an image. A detection becomes a wardrobe garment
-- only after it passes confidence thresholds (or the user confirms it).
-- -----------------------------------------------------------------------------
create table public.detections (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  media_asset_id     uuid not null references public.media_assets(id) on delete cascade,
  ingest_job_id      uuid references public.ingest_jobs(id) on delete set null,

  -- Model provenance — every inference is reproducible.
  detector_model     text not null,             -- 'yolo11x-seg-deepfashion2'
  detector_version   text not null,
  classifier_model   text,                      -- 'marqo-fashionSigLIP'
  classifier_version text,

  label              text not null,             -- raw model label
  category_id        int,                       -- FK added in 0004 (mapped taxonomy)
  confidence         numeric(4,3) not null check (confidence between 0 and 1),
  -- Normalised bbox [x, y, w, h] in 0..1 so it survives resizing.
  bbox               numeric(6,5)[4] not null,
  mask_rle           jsonb,                     -- COCO RLE, kept for re-cropping
  mask_asset_id      uuid references public.media_assets(id) on delete set null,
  cutout_asset_id    uuid references public.media_assets(id) on delete set null,
  area_ratio         numeric(5,4),
  occlusion_score    numeric(4,3),
  attributes         jsonb not null default '{}'::jsonb,  -- sleeve, neckline, length...
  status             text not null default 'pending'
                     check (status in ('pending','accepted','rejected','merged','duplicate')),
  garment_id         uuid,                      -- FK added in 0004
  created_at         timestamptz not null default now()
);
create index detections_media_idx  on public.detections (media_asset_id);
create index detections_user_idx   on public.detections (user_id, created_at desc);
create index detections_status_idx on public.detections (status) where status = 'pending';

-- -----------------------------------------------------------------------------
-- webhook_events — idempotency ledger for every inbound provider callback
-- (Meta deauthorize/deletion, TikTok, Replicate/fal VTON completion).
-- -----------------------------------------------------------------------------
create table public.webhook_events (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null,
  event_type     text not null,
  external_id    text not null,
  signature_ok   boolean not null default false,
  payload        jsonb not null,
  processed_at   timestamptz,
  process_error  text,
  received_at    timestamptz not null default now(),
  unique (provider, external_id)
);
create index webhook_events_unprocessed_idx
  on public.webhook_events (received_at) where processed_at is null;
