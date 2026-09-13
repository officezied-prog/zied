-- =============================================================================
-- SmartStylist — 0004: garment taxonomy, wardrobe items, colour extraction,
--                      wear log
-- =============================================================================

-- -----------------------------------------------------------------------------
-- garment_categories — 3-level global taxonomy (supercategory > category >
-- subcategory). Shared by all users; seeded in db/seeds/0001_taxonomy.sql.
-- Defaults here (role/formality/warmth) act as priors the CV pipeline and the
-- styling engine fall back to when an item has no explicit value.
-- -----------------------------------------------------------------------------
create table public.garment_categories (
  id                 int primary key generated always as identity,
  parent_id          int references public.garment_categories(id) on delete restrict,
  slug               text not null unique,
  display_name       text not null,
  level              smallint not null check (level between 1 and 3),
  default_role       public.garment_role not null,
  -- 1 = loungewear … 5 = black tie
  default_formality  smallint not null default 3 check (default_formality between 1 and 5),
  -- 0 = no thermal contribution … 5 = arctic. Used against the weather input.
  default_warmth     smallint not null default 2 check (default_warmth between 0 and 5),
  default_seasons    public.season[] not null default '{all_season}',
  is_layerable       boolean not null default false,
  size_system        text,                       -- 'alpha','eu_numeric','shoe_eu','waist_inseam'
  synonyms           text[] not null default '{}',
  sort_order         int not null default 0,
  is_active          boolean not null default true
);
create index garment_categories_parent_idx on public.garment_categories (parent_id);
create index garment_categories_role_idx   on public.garment_categories (default_role);
create index garment_categories_syn_idx    on public.garment_categories using gin (synonyms);

alter table public.detections
  add constraint detections_category_fk
  foreign key (category_id) references public.garment_categories(id) on delete set null;

-- Materialised ancestry helper for "give me everything under 'tops'".
create or replace function public.category_descendants(p_root text)
returns table (id int)
language sql
stable
as $$
  with recursive tree as (
    select c.id from public.garment_categories c where c.slug = p_root
    union all
    select c.id from public.garment_categories c join tree t on c.parent_id = t.id
  )
  select id from tree;
$$;

-- -----------------------------------------------------------------------------
-- garments — the digital wardrobe. One row per physical item the user owns
-- (or a wishlist/virtual item when `ownership = 'wishlist'`).
-- -----------------------------------------------------------------------------
create table public.garments (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.users(id) on delete cascade,
  category_id          int  not null references public.garment_categories(id) on delete restrict,
  role                 public.garment_role not null,

  -- Imagery
  source_media_id      uuid references public.media_assets(id) on delete set null,
  cutout_media_id      uuid references public.media_assets(id) on delete set null,  -- flat-lay PNG for VTON
  thumbnail_media_id   uuid references public.media_assets(id) on delete set null,
  detection_id         uuid references public.detections(id) on delete set null,

  -- Descriptive
  name                 text,                      -- auto-generated: "Navy linen shirt"
  brand                text,
  description          text,
  pattern              public.pattern_type not null default 'solid',
  material             text[] not null default '{}',      -- cotton, linen, wool...
  fit                  public.fit_type not null default 'unspecified',
  size_label           text,
  length_class         text,     -- mini/midi/maxi, cropped/regular/longline
  sleeve_class         text,     -- sleeveless/short/three_quarter/long
  neckline             text,
  heel_height_cm       numeric(4,1),

  -- Styling signals (overridable defaults from the category)
  -- No column defaults on purpose: NULL on insert means "inherit the category
  -- prior", which the BEFORE INSERT trigger below resolves.
  formality            smallint not null check (formality between 1 and 5),
  warmth               smallint not null check (warmth between 0 and 5),
  water_resistant      boolean not null default false,
  seasons              public.season[] not null,
  occasion_tags        text[] not null default '{}',
  is_layerable         boolean not null,

  -- Ownership / lifecycle
  ownership            text not null default 'owned'
                       check (ownership in ('owned','wishlist','borrowed','sold','donated')),
  purchase_price       numeric(10,2),
  purchase_currency    char(3),
  purchased_at         date,
  condition            smallint check (condition between 1 and 5),
  care_instructions    text,
  in_laundry           boolean not null default false,
  available_from       date,                      -- e.g. back from the cleaners

  -- Usage stats (denormalised for fast sorting; maintained by trigger in 0005)
  wear_count           int not null default 0,
  last_worn_at         date,

  -- Provenance & QA
  source               public.media_source not null default 'manual_upload',
  auto_tagged          boolean not null default false,
  tag_confidence       numeric(4,3) check (tag_confidence between 0 and 1),
  user_verified        boolean not null default false,

  is_archived          boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create index garments_user_active_idx
  on public.garments (user_id, category_id)
  where deleted_at is null and is_archived = false;
create index garments_user_role_idx
  on public.garments (user_id, role)
  where deleted_at is null and is_archived = false;
create index garments_seasons_idx    on public.garments using gin (seasons);
create index garments_occasion_idx   on public.garments using gin (occasion_tags);
create index garments_material_idx   on public.garments using gin (material);
create index garments_brand_trgm_idx on public.garments using gin (brand gin_trgm_ops);
create index garments_name_trgm_idx  on public.garments using gin (name  gin_trgm_ops);
create index garments_wear_idx       on public.garments (user_id, last_worn_at nulls first);

create trigger garments_set_updated_at
  before update on public.garments
  for each row execute function public.tg_set_updated_at();

alter table public.detections
  add constraint detections_garment_fk
  foreign key (garment_id) references public.garments(id) on delete set null;

-- Inherit category priors when the caller leaves them unset.
create or replace function public.tg_garment_apply_category_defaults()
returns trigger
language plpgsql
as $$
declare
  c record;
begin
  select * into c from public.garment_categories where id = new.category_id;
  if not found then
    raise exception 'unknown category_id %', new.category_id;
  end if;

  new.role         := coalesce(new.role,         c.default_role);
  new.formality    := coalesce(new.formality,    c.default_formality);
  new.warmth       := coalesce(new.warmth,       c.default_warmth);
  new.seasons      := coalesce(new.seasons,      c.default_seasons);
  new.is_layerable := coalesce(new.is_layerable, c.is_layerable);
  return new;
end;
$$;

create trigger garments_category_defaults
  before insert on public.garments
  for each row execute function public.tg_garment_apply_category_defaults();

-- -----------------------------------------------------------------------------
-- garment_colors — dominant palette per item, stored in both sRGB and CIELAB.
-- LAB is what the styling engine actually compares (CIEDE2000 distance);
-- LCh hue drives the harmony rules.
-- -----------------------------------------------------------------------------
create table public.garment_colors (
  id             bigint primary key generated always as identity,
  garment_id     uuid not null references public.garments(id) on delete cascade,
  rank           smallint not null check (rank between 1 and 8),
  hex            char(7) not null check (hex ~ '^#[0-9A-Fa-f]{6}$'),
  ratio          numeric(5,4) not null check (ratio between 0 and 1),
  lab_l          numeric(6,3) not null,
  lab_a          numeric(6,3) not null,
  lab_b          numeric(6,3) not null,
  lch_h          numeric(6,2) check (lch_h between 0 and 360),
  lch_c          numeric(6,3),
  color_family   text not null,        -- FK to color_families (0005)
  is_neutral     boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (garment_id, rank)
);
create index garment_colors_garment_idx on public.garment_colors (garment_id);
create index garment_colors_family_idx  on public.garment_colors (color_family);
create index garment_colors_hue_idx      on public.garment_colors (lch_h) where lch_h is not null;

-- Convenience: the primary colour of each garment.
create or replace view public.v_garment_primary_color as
select distinct on (garment_id)
       garment_id, hex, lab_l, lab_a, lab_b, lch_h, lch_c, color_family, is_neutral
from   public.garment_colors
order by garment_id, rank;

-- -----------------------------------------------------------------------------
-- wear_log — ground truth for "what do you actually wear", feeds the
-- recommendation engine's novelty/rotation term and cost-per-wear analytics.
-- -----------------------------------------------------------------------------
create table public.wear_log (
  id           bigint primary key generated always as identity,
  user_id      uuid not null references public.users(id) on delete cascade,
  garment_id   uuid not null references public.garments(id) on delete cascade,
  outfit_id    uuid,                     -- FK added in 0005
  worn_on      date not null default current_date,
  occasion     text,
  source       text not null default 'user' check (source in ('user','auto','import')),
  created_at   timestamptz not null default now(),
  unique (garment_id, worn_on, outfit_id)
);
create index wear_log_user_date_idx on public.wear_log (user_id, worn_on desc);
create index wear_log_garment_idx   on public.wear_log (garment_id, worn_on desc);
