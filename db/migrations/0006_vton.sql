-- =============================================================================
-- SmartStylist — 0006: virtual try-on jobs, model registry, cost accounting
-- =============================================================================

-- -----------------------------------------------------------------------------
-- vton_models — registry of try-on backends. Licence is a first-class column:
-- several strong open VTON checkpoints (IDM-VTON, OOTDiffusion, CatVTON) ship
-- under non-commercial terms, so the router must be able to exclude them in
-- production tiers.
-- -----------------------------------------------------------------------------
create table public.vton_models (
  id                 text primary key,             -- 'idm-vton@v1.1', 'catvton@1.0'
  display_name       text not null,
  provider           public.vton_provider not null,
  provider_ref       text,                         -- replicate slug / endpoint id
  family             text not null check (family in ('diffusion','gan','warp_gan','hybrid')),
  license            text not null,                -- 'CC-BY-NC-SA-4.0', 'Apache-2.0', 'commercial'
  commercial_ok      boolean not null default false,
  supports_roles     public.garment_role[] not null default '{}',
  supports_multi_garment boolean not null default false,
  input_resolution   text,                          -- '768x1024'
  avg_latency_ms     int,
  cost_per_call_usd  numeric(8,4),
  quality_score      numeric(4,3),                  -- internal eval (SSIM/LPIPS/human)
  is_enabled         boolean not null default true,
  config             jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- vton_jobs — one try-on render. Async by construction: the API returns 202
-- with the job id, the worker (or provider webhook) completes it.
-- -----------------------------------------------------------------------------
create table public.vton_jobs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users(id) on delete cascade,
  outfit_id             uuid references public.outfits(id) on delete set null,
  model_id              text not null references public.vton_models(id) on delete restrict,

  -- Inputs
  body_photo_id         uuid not null,              -- private.body_reference_photos.id
  garment_ids           uuid[] not null check (cardinality(garment_ids) between 1 and 5),
  -- Chained renders: each pass drapes one more layer onto the previous result.
  parent_job_id         uuid references public.vton_jobs(id) on delete set null,
  pass_index            smallint not null default 0,

  params                jsonb not null default '{}'::jsonb,
    -- {"steps":30,"guidance":2.0,"seed":42,"repaint":true,"preserve_face":true}
  seed                  bigint,

  -- Execution
  status                public.job_status not null default 'queued',
  provider_job_id       text,
  priority              smallint not null default 5 check (priority between 1 and 9),
  attempts              smallint not null default 0,
  queued_at             timestamptz not null default now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  duration_ms           int,
  gpu_type              text,
  cost_usd              numeric(8,4),
  error_code            text,
  error_detail          text,
  idempotency_key       text,

  -- Output
  result_media_id       uuid references public.media_assets(id) on delete set null,
  preview_media_id      uuid references public.media_assets(id) on delete set null,
  qa_score              numeric(4,3),               -- automated artefact check
  qa_flags              text[] not null default '{}',
  moderation_status     public.moderation_status not null default 'pending',
  expires_at            timestamptz,                -- renders are ephemeral by default

  unique (user_id, idempotency_key)
);
create index vton_jobs_user_idx    on public.vton_jobs (user_id, queued_at desc);
create index vton_jobs_pending_idx on public.vton_jobs (status, priority, queued_at)
  where status in ('queued','running');
create index vton_jobs_provider_idx on public.vton_jobs (provider_job_id) where provider_job_id is not null;
create index vton_jobs_outfit_idx   on public.vton_jobs (outfit_id);
create index vton_jobs_expiry_idx   on public.vton_jobs (expires_at) where expires_at is not null;

alter table public.vton_jobs
  add constraint vton_jobs_body_photo_fk
  foreign key (body_photo_id) references private.body_reference_photos(id) on delete cascade;

-- -----------------------------------------------------------------------------
-- Per-user quota accounting for GPU spend (VTON is the dominant unit cost).
-- -----------------------------------------------------------------------------
create table public.usage_counters (
  user_id       uuid not null references public.users(id) on delete cascade,
  period_start  date not null,                  -- first day of the billing month
  metric        text not null check (metric in
                  ('vton_renders','ingest_images','segmentations','recommendations','llm_tokens')),
  used          bigint not null default 0,
  quota         bigint,
  updated_at    timestamptz not null default now(),
  primary key (user_id, period_start, metric)
);

create or replace function public.consume_quota(
  p_user_id uuid, p_metric text, p_amount bigint default 1
) returns boolean
language plpgsql
as $$
declare
  v_period date := date_trunc('month', now())::date;
  v_row    public.usage_counters%rowtype;
begin
  insert into public.usage_counters (user_id, period_start, metric, used)
  values (p_user_id, v_period, p_metric, 0)
  on conflict (user_id, period_start, metric) do nothing;

  select * into v_row
    from public.usage_counters
   where user_id = p_user_id and period_start = v_period and metric = p_metric
   for update;

  if v_row.quota is not null and v_row.used + p_amount > v_row.quota then
    return false;
  end if;

  update public.usage_counters
     set used = used + p_amount, updated_at = now()
   where user_id = p_user_id and period_start = v_period and metric = p_metric;

  return true;
end;
$$;
