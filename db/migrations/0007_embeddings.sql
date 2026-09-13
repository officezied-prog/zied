-- =============================================================================
-- SmartStylist — 0007: vector embeddings (pgvector)
-- Requires the `vector` extension (built into Supabase; `apt install
-- postgresql-16-pgvector` self-hosted). Validated against pgvector 0.6.0.
-- =============================================================================

create extension if not exists vector;

-- Image/text embeddings come from a fashion-domain CLIP variant
-- (Marqo-FashionSigLIP, 768-d) so garments, text queries ("something for a
-- rooftop dinner") and taste vectors all live in one comparable space.
create table public.garment_embeddings (
  garment_id     uuid primary key references public.garments(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  model          text not null,
  model_version  text not null,
  image_embedding vector(768) not null,
  text_embedding  vector(768),
  created_at     timestamptz not null default now()
);

-- Cosine HNSW: fast top-k over a user's closet and over the global catalogue.
create index garment_embeddings_hnsw_idx
  on public.garment_embeddings using hnsw (image_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
create index garment_embeddings_user_idx on public.garment_embeddings (user_id);

-- Long-lived taste vector: EMA over embeddings of liked/worn garments,
-- minus disliked ones. Read on every recommendation call.
create table public.user_style_embeddings (
  user_id        uuid primary key references public.users(id) on delete cascade,
  model          text not null,
  model_version  text not null,
  taste_vector   vector(768) not null,
  sample_count   int not null default 0,
  updated_at     timestamptz not null default now()
);

-- Outfit-level embedding enables "more like this" and duplicate suppression.
create table public.outfit_embeddings (
  outfit_id      uuid primary key references public.outfits(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  embedding      vector(768) not null,
  created_at     timestamptz not null default now()
);
create index outfit_embeddings_hnsw_idx
  on public.outfit_embeddings using hnsw (embedding vector_cosine_ops);
create index outfit_embeddings_user_idx on public.outfit_embeddings (user_id);

-- Trend/inspiration corpus (editorial looks, runway, curated Pinterest-style
-- boards licensed for use). Not user data — no RLS, read-only to clients.
create table public.style_references (
  id             uuid primary key default gen_random_uuid(),
  title          text,
  source         text not null,
  source_url     text,
  license        text not null,
  season_tag     text,                        -- 'SS26'
  occasion_slugs text[] not null default '{}',
  formality      smallint check (formality between 1 and 5),
  palette        char(7)[] not null default '{}',
  media_url      text,
  embedding      vector(768),
  popularity     numeric(6,3) not null default 0,
  created_at     timestamptz not null default now()
);
create index style_references_hnsw_idx
  on public.style_references using hnsw (embedding vector_cosine_ops);
create index style_references_occasion_idx on public.style_references using gin (occasion_slugs);
