-- =============================================================================
-- SmartStylist — 0010: per-image work queue for the ingestion pipeline
--
-- Added during Phase 2. `ingest_jobs` tracks the user-visible operation ("import
-- these 40 photos"); this table tracks the unit of work the vision worker
-- actually claims. Postgres is the queue: SELECT … FOR UPDATE SKIP LOCKED gives
-- exactly-once claiming across N workers with no extra infrastructure, and a
-- crashed worker's rows are recovered by their claim TTL rather than lost.
-- Swapping in Redis Streams or SQS later means changing the claim function only.
-- =============================================================================

create table public.ingest_job_items (
  id               bigint primary key generated always as identity,
  job_id           uuid not null references public.ingest_jobs(id) on delete cascade,
  user_id          uuid not null references public.users(id) on delete cascade,
  media_asset_id   uuid not null references public.media_assets(id) on delete cascade,
  status           public.job_status not null default 'queued',
  attempts         smallint not null default 0,
  claimed_by       text,
  claimed_at       timestamptz,
  claim_expires_at timestamptz,
  detections       int not null default 0,
  garments_created int not null default 0,
  needs_review     int not null default 0,
  duplicates       int not null default 0,
  error_detail     text,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz,
  unique (job_id, media_asset_id)
);

-- The claim query's covering index: only rows still to do are in it.
create index ingest_job_items_claimable_idx
  on public.ingest_job_items (created_at)
  where status in ('queued', 'running');
create index ingest_job_items_job_idx on public.ingest_job_items (job_id);

alter table public.ingest_jobs
  add column needs_review int not null default 0,
  add column auto_accept  boolean not null default true;

-- -----------------------------------------------------------------------------
-- Claim a batch of work. Atomic: the UPDATE … RETURNING means two workers can
-- never take the same row, and rows whose claim has expired (worker crashed,
-- pod evicted) become claimable again automatically.
-- -----------------------------------------------------------------------------
create or replace function public.claim_ingest_items(
  p_worker text,
  p_batch  int default 8,
  p_ttl_seconds int default 600,
  p_max_attempts int default 3
)
returns setof public.ingest_job_items
language sql
as $$
  with candidate as (
    select id
      from public.ingest_job_items
     where (status = 'queued'
            or (status = 'running' and claim_expires_at < now()))
       and attempts < p_max_attempts
     order by created_at
     for update skip locked
     limit p_batch
  )
  update public.ingest_job_items i
     set status = 'running',
         attempts = i.attempts + 1,
         claimed_by = p_worker,
         claimed_at = now(),
         claim_expires_at = now() + make_interval(secs => p_ttl_seconds)
    from candidate c
   where i.id = c.id
  returning i.*;
$$;

-- -----------------------------------------------------------------------------
-- Roll item outcomes up to the parent job and close it when the last item lands.
-- -----------------------------------------------------------------------------
create or replace function public.tg_ingest_item_rollup()
returns trigger
language plpgsql
as $$
declare
  v_remaining int;
begin
  if new.status is distinct from old.status
     and new.status in ('succeeded', 'failed', 'cancelled') then

    update public.ingest_jobs j
       set items_processed  = j.items_processed + 1,
           items_failed     = j.items_failed + (case when new.status = 'failed' then 1 else 0 end),
           garments_created = j.garments_created + new.garments_created,
           needs_review     = j.needs_review + new.needs_review,
           started_at       = coalesce(j.started_at, now())
     where j.id = new.job_id;

    select count(*) into v_remaining
      from public.ingest_job_items
     where job_id = new.job_id and status not in ('succeeded', 'failed', 'cancelled');

    if v_remaining = 0 then
      update public.ingest_jobs j
         set status = case
                        when j.items_failed = 0 then 'succeeded'::public.job_status
                        when j.items_failed >= j.items_discovered then 'failed'::public.job_status
                        else 'partial'::public.job_status
                      end,
             finished_at = now()
       where j.id = new.job_id;
    end if;
  end if;
  return null;
end;
$$;

create trigger ingest_item_rollup
  after update on public.ingest_job_items
  for each row execute function public.tg_ingest_item_rollup();

-- RLS: owner-scoped like every other user table.
alter table public.ingest_job_items enable row level security;
alter table public.ingest_job_items force row level security;
create policy ingest_job_items_owner on public.ingest_job_items
  for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
grant select, insert, update, delete on public.ingest_job_items to authenticated;
grant all on public.ingest_job_items to service_role;
grant usage, select on all sequences in schema public to service_role;
