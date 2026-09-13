-- =============================================================================
-- SmartStylist — 0014: try-on work queue, render cache, body-photo preparation
--
-- Added in Phase 4. Mirrors the ingest queue from 0010: PostgreSQL is the
-- broker, claiming is exactly-once via FOR UPDATE SKIP LOCKED, and a claim TTL
-- recovers work from a worker that died mid-render — which matters far more
-- here, because a lost GPU job is 10 seconds of paid compute.
-- =============================================================================

-- Deduplicate identical renders. The key is a hash over (body photo, ordered
-- garment set, model, params, seed): the same request must never cost twice.
alter table public.vton_jobs
  add column cache_key char(64),
  add column pass_total smallint not null default 1;

create index vton_jobs_cache_idx
  on public.vton_jobs (user_id, cache_key)
  where cache_key is not null and status = 'succeeded';

-- Preparation state for a body photo: parsing/pose/agnostic maps are computed
-- once and reused by every render, which is most of the per-render latency.
alter table private.body_reference_photos
  add column prep_status public.job_status not null default 'queued',
  add column prep_error text,
  add column person_bbox numeric(6,5)[4],
  add column zones jsonb;

create index body_ref_prep_idx
  on private.body_reference_photos (prep_status)
  where prep_status in ('queued', 'running');

-- -----------------------------------------------------------------------------
-- Claim try-on work. Priority first (paid tiers jump the queue), then age.
-- -----------------------------------------------------------------------------
create or replace function public.claim_vton_jobs(
  p_worker text,
  p_batch int default 1,
  p_ttl_seconds int default 900,
  p_max_attempts int default 3
)
returns setof public.vton_jobs
language sql
as $$
  with candidate as (
    select id
      from public.vton_jobs
     where (status = 'queued'
            or (status = 'running'
                and started_at < now() - make_interval(secs => p_ttl_seconds)))
       and attempts < p_max_attempts
     order by priority, queued_at
     for update skip locked
     limit p_batch
  )
  update public.vton_jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         started_at = now(),
         gpu_type = coalesce(j.gpu_type, p_worker)
    from candidate c
   where j.id = c.id
  returning j.*;
$$;

-- -----------------------------------------------------------------------------
-- Reaper: jobs that exhausted their attempts are failed, not left running.
-- -----------------------------------------------------------------------------
create or replace function public.expire_stuck_vton_jobs(p_max_attempts int default 3)
returns int
language sql
as $$
  with expired as (
    update public.vton_jobs
       set status = 'failed',
           error_code = coalesce(error_code, 'max_attempts_exceeded'),
           finished_at = now()
     where status = 'running'
       and attempts >= p_max_attempts
       and started_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*)::int from expired;
$$;

-- Renders expire; the maintenance job reads this to know what to purge.
create or replace view public.v_expired_vton_renders as
select j.id as job_id, j.user_id, m.bucket, m.storage_key, j.expires_at
  from public.vton_jobs j
  join public.media_assets m on m.id = j.result_media_id
 where j.expires_at is not null and j.expires_at < now();

alter view public.v_expired_vton_renders set (security_invoker = true);
grant select on public.v_expired_vton_renders to authenticated, service_role;
