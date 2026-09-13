-- =============================================================================
-- SmartStylist — 0005: colour-theory reference data, occasions, weather,
--                      outfits and feedback
-- =============================================================================

-- -----------------------------------------------------------------------------
-- color_families — the vocabulary the engine reasons in. Hue ranges are LCh
-- degrees; neutrals are matched by low chroma instead of hue.
-- -----------------------------------------------------------------------------
create table public.color_families (
  slug           text primary key,          -- 'navy', 'camel', 'burgundy'
  display_name   text not null,
  anchor_hex     char(7) not null check (anchor_hex ~ '^#[0-9A-Fa-f]{6}$'),
  hue_min        numeric(6,2),
  hue_max        numeric(6,2),
  chroma_min     numeric(6,2),
  chroma_max     numeric(6,2),
  lightness_min  numeric(6,2),
  lightness_max  numeric(6,2),
  is_neutral     boolean not null default false,
  -- A neutral pairs with anything; a "hero" colour should appear at most once.
  is_hero        boolean not null default false,
  warm_cool      text check (warm_cool in ('warm','cool','neutral'))
);

-- Curated pairings that override the geometric hue maths (fashion beats theory:
-- navy+camel scores high, red+pink is a deliberate "unexpected" pairing).
create table public.color_pair_rules (
  id             int primary key generated always as identity,
  family_a       text not null references public.color_families(slug) on delete cascade,
  family_b       text not null references public.color_families(slug) on delete cascade,
  harmony        public.color_harmony not null,
  -- -1.0 (clashes, hard veto) .. 1.0 (signature pairing)
  score          numeric(3,2) not null check (score between -1 and 1),
  formality_min  smallint not null default 1 check (formality_min between 1 and 5),
  formality_max  smallint not null default 5 check (formality_max between 1 and 5),
  note           text,
  unique (family_a, family_b)
);
create index color_pair_rules_b_idx on public.color_pair_rules (family_b);

-- Which colour families flatter which 12-season palette / undertone.
create table public.palette_affinity (
  id               int primary key generated always as identity,
  palette          public.seasonal_palette not null,
  family           text not null references public.color_families(slug) on delete cascade,
  affinity         numeric(3,2) not null check (affinity between -1 and 1),
  unique (palette, family)
);

-- -----------------------------------------------------------------------------
-- occasions — the "event type" catalogue driving the recommendation request.
-- Global rows (user_id null) are the built-in catalogue; users may add their own.
-- -----------------------------------------------------------------------------
create table public.occasions (
  id                int primary key generated always as identity,
  user_id           uuid references public.users(id) on delete cascade,
  slug              text not null,
  display_name      text not null,
  description       text,
  formality_min     smallint not null check (formality_min between 1 and 5),
  formality_max     smallint not null check (formality_max between 1 and 5),
  required_roles    public.garment_role[] not null default '{}',
  optional_roles    public.garment_role[] not null default '{}',
  banned_roles      public.garment_role[] not null default '{}',
  banned_categories text[] not null default '{}',
  banned_patterns   public.pattern_type[] not null default '{}',
  -- Engine weight overrides, e.g. {"color_harmony":1.4,"novelty":0.6}
  scoring_weights   jsonb not null default '{}'::jsonb,
  typical_duration_h numeric(4,1),
  is_outdoor        boolean,
  icon              text,
  sort_order        int not null default 0,
  is_active         boolean not null default true,
  check (formality_max >= formality_min)
);
create unique index occasions_global_slug_uidx on public.occasions (slug) where user_id is null;
create unique index occasions_user_slug_uidx   on public.occasions (user_id, slug) where user_id is not null;

-- -----------------------------------------------------------------------------
-- weather_snapshots — cached provider responses (geohash-5 ≈ 5 km cell, hourly),
-- shared across users so one API call serves a whole city block.
-- -----------------------------------------------------------------------------
create table public.weather_snapshots (
  id               bigint primary key generated always as identity,
  geohash5         char(5) not null,
  valid_at         timestamptz not null,
  provider         text not null default 'openweather',
  temp_c           numeric(5,2) not null,
  feels_like_c     numeric(5,2),
  temp_min_c       numeric(5,2),
  temp_max_c       numeric(5,2),
  humidity_pct     smallint check (humidity_pct between 0 and 100),
  wind_kph         numeric(5,2),
  precip_prob      numeric(4,3) check (precip_prob between 0 and 1),
  precip_mm        numeric(6,2),
  uv_index         numeric(4,2),
  condition        text,                    -- clear/clouds/rain/snow/storm/fog
  is_daylight      boolean,
  fetched_at       timestamptz not null default now(),
  unique (geohash5, valid_at, provider)
);
create index weather_snapshots_lookup_idx on public.weather_snapshots (geohash5, valid_at desc);

-- -----------------------------------------------------------------------------
-- recommendation_runs — one row per /outfits/recommend call. Stores the exact
-- inputs, engine version and weights so any suggestion can be replayed and
-- A/B tests can be attributed.
-- -----------------------------------------------------------------------------
create table public.recommendation_runs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.users(id) on delete cascade,
  occasion_id        int references public.occasions(id) on delete set null,
  occasion_slug      text,
  scheduled_for      timestamptz,
  geohash5           char(5),
  weather_snapshot_id bigint references public.weather_snapshots(id) on delete set null,
  engine_version     text not null,
  strategy           text not null default 'hybrid'
                     check (strategy in ('rules','embedding','hybrid','llm_reranked')),
  weights            jsonb not null default '{}'::jsonb,
  filters            jsonb not null default '{}'::jsonb,
  candidate_count    int,
  returned_count     int,
  latency_ms         int,
  status             public.job_status not null default 'succeeded',
  error_detail       text,
  created_at         timestamptz not null default now()
);
create index recommendation_runs_user_idx on public.recommendation_runs (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- outfits — a saved or suggested combination of garments.
-- -----------------------------------------------------------------------------
create table public.outfits (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.users(id) on delete cascade,
  recommendation_run_id uuid references public.recommendation_runs(id) on delete set null,
  occasion_id         int references public.occasions(id) on delete set null,
  name                text,
  origin              text not null default 'ai'
                      check (origin in ('ai','user','template','import')),
  -- Score breakdown so the UI can explain *why* ("great colour harmony,
  -- slightly warm for today").
  total_score         numeric(5,4) check (total_score between 0 and 1),
  score_breakdown     jsonb not null default '{}'::jsonb,
  rationale           text,
  weather_snapshot_id bigint references public.weather_snapshots(id) on delete set null,
  planned_for         date,
  formality           smallint check (formality between 1 and 5),
  dominant_colors     char(7)[] not null default '{}',
  cover_media_id      uuid references public.media_assets(id) on delete set null,
  is_favorite         boolean not null default false,
  is_archived         boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index outfits_user_idx      on public.outfits (user_id, created_at desc);
create index outfits_planned_idx   on public.outfits (user_id, planned_for) where planned_for is not null;
create index outfits_favorite_idx  on public.outfits (user_id) where is_favorite;

create trigger outfits_set_updated_at
  before update on public.outfits
  for each row execute function public.tg_set_updated_at();

alter table public.wear_log
  add constraint wear_log_outfit_fk
  foreign key (outfit_id) references public.outfits(id) on delete set null;

-- -----------------------------------------------------------------------------
-- outfit_items — garments in an outfit. One garment per role, except the
-- accessory roles which may repeat (two rings, a ring and a bracelet).
-- -----------------------------------------------------------------------------
create table public.outfit_items (
  outfit_id     uuid not null references public.outfits(id) on delete cascade,
  garment_id    uuid not null references public.garments(id) on delete cascade,
  role          public.garment_role not null,
  layer_order   smallint not null default 0,   -- 0 = closest to body
  is_optional   boolean not null default false,
  substitutable boolean not null default true,
  note          text,
  primary key (outfit_id, garment_id)
);
create index outfit_items_garment_idx on public.outfit_items (garment_id);

-- Enforce single-occupancy roles (you wear one pair of trousers).
create unique index outfit_items_single_role_uidx
  on public.outfit_items (outfit_id, role)
  where role in ('bottom','full_body','footwear','outerwear','base_top','belt','bag','headwear');

-- -----------------------------------------------------------------------------
-- outfit_feedback — the implicit/explicit signal loop that personalises scoring.
-- -----------------------------------------------------------------------------
create table public.outfit_feedback (
  id           bigint primary key generated always as identity,
  user_id      uuid not null references public.users(id) on delete cascade,
  outfit_id    uuid not null references public.outfits(id) on delete cascade,
  kind         public.feedback_kind not null,
  reason       text,                     -- 'too formal','color clash','disliked_item'
  garment_id   uuid references public.garments(id) on delete set null,
  rating       smallint check (rating between 1 and 5),
  created_at   timestamptz not null default now(),
  unique (user_id, outfit_id, kind, garment_id)
);
create index outfit_feedback_user_idx   on public.outfit_feedback (user_id, created_at desc);
create index outfit_feedback_outfit_idx on public.outfit_feedback (outfit_id);

-- -----------------------------------------------------------------------------
-- Keep garments.wear_count / last_worn_at in sync with wear_log.
-- -----------------------------------------------------------------------------
create or replace function public.tg_wear_log_sync()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    update public.garments
       set wear_count   = wear_count + 1,
           last_worn_at = greatest(coalesce(last_worn_at, new.worn_on), new.worn_on)
     where id = new.garment_id;
  elsif tg_op = 'DELETE' then
    update public.garments g
       set wear_count   = greatest(g.wear_count - 1, 0),
           last_worn_at = (select max(w.worn_on) from public.wear_log w
                            where w.garment_id = g.id and w.id <> old.id)
     where g.id = old.garment_id;
  end if;
  return null;
end;
$$;

create trigger wear_log_sync_ins after insert on public.wear_log
  for each row execute function public.tg_wear_log_sync();
create trigger wear_log_sync_del after delete on public.wear_log
  for each row execute function public.tg_wear_log_sync();
