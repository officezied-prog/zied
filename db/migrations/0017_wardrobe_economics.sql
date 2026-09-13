-- =============================================================================
-- SmartStylist — 0017: wardrobe economics
--
-- Purpose: decide whether to suggest buying anything at all, and at what price,
-- from evidence the user already gave us — what they paid for what they own.
--
-- Three rules are built into this design, not bolted on:
--
--  1. NOTHING IS PERSISTED ABOUT THE PERSON. There is no "affluence", "class"
--     or "segment" column anywhere. The spend band is derived on demand from
--     garment rows and thrown away. A label like that is demeaning when shown,
--     wrong often enough to matter, and a liability the moment it is stored,
--     exported or breached.
--  2. THE USER'S OWN SETTING ALWAYS WINS. `style_preferences.budget_tier` and
--     `allow_new_purchases` override every inference. The inference is a
--     default for someone who never set one, never a verdict.
--  3. IT NEVER CHANGES A PRICE. The band decides *what is suggested*, never
--     what anything costs. Charging two people differently for the same item
--     based on inferred means is price discrimination, and this schema gives
--     no way to do it.
-- =============================================================================

-- Brand → price tier. Reference data, regional and extensible; used only when
-- the user recorded no price for an item, which is the common case.
create table public.brand_tiers (
  brand_key    text primary key,          -- normalised: lowercase, no spaces
  display_name text not null,
  -- 1 value / 2 high street / 3 premium high street / 4 designer / 5 luxury
  tier         smallint not null check (tier between 1 and 5),
  region       text not null default 'global',
  note         text
);

create index brand_tiers_tier_idx on public.brand_tiers (tier);

-- Typical spend per tier, per garment role, in a reference currency. Used to
-- suggest a price band the user can actually act on rather than a bare tier.
create table public.price_bands (
  tier        smallint not null check (tier between 1 and 5),
  role        public.garment_role not null,
  low         numeric(10,2) not null,
  high        numeric(10,2) not null,
  currency    char(3) not null default 'USD',
  primary key (tier, role, currency),
  check (high >= low)
);

-- -----------------------------------------------------------------------------
-- Normalise a brand the way a person typed it: "Zara ", "ZARA", "zara" are one.
-- -----------------------------------------------------------------------------
create or replace function public.brand_key(p_brand text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(lower(trim(coalesce(p_brand, ''))), '[^a-z0-9]', '', 'g'), '');
$$;

-- -----------------------------------------------------------------------------
-- The evidence, and nothing but the evidence.
--
-- Returns one row of observable facts about a wardrobe. Deliberately returns
-- raw counts and quantiles rather than a score: the judgement lives in Python
-- where it can be read, tested and argued with, not buried in SQL.
-- -----------------------------------------------------------------------------
create or replace function public.wardrobe_evidence(p_user_id uuid)
returns table (
  items              int,
  priced_items       int,
  median_price       numeric,
  p75_price          numeric,
  max_price          numeric,
  currency           char(3),
  branded_items      int,
  known_brand_items  int,
  mean_brand_tier    numeric,
  max_brand_tier     smallint,
  luxury_items       int,
  value_items        int,
  distinct_brands    int,
  premium_materials  int,
  roles_covered      int
)
language sql
stable
as $$
  with owned as (
    select g.*, public.brand_key(g.brand) as bkey
      from public.garments g
     where g.user_id = p_user_id
       and g.deleted_at is null
       and g.is_archived = false
       and g.ownership in ('owned', 'borrowed')
  ),
  tiered as (
    select o.*, bt.tier
      from owned o
      left join public.brand_tiers bt on bt.brand_key = o.bkey
  )
  select
    count(*)::int,
    count(*) filter (where purchase_price is not null and purchase_price > 0)::int,
    percentile_cont(0.5) within group (order by purchase_price)
      filter (where purchase_price is not null and purchase_price > 0),
    percentile_cont(0.75) within group (order by purchase_price)
      filter (where purchase_price is not null and purchase_price > 0),
    max(purchase_price),
    (array_agg(purchase_currency) filter (where purchase_currency is not null))[1],
    count(*) filter (where bkey is not null)::int,
    count(*) filter (where tier is not null)::int,
    avg(tier) filter (where tier is not null),
    max(tier),
    count(*) filter (where tier >= 4)::int,
    count(*) filter (where tier <= 2)::int,
    count(distinct bkey) filter (where bkey is not null)::int,
    count(*) filter (where material && array['silk','cashmere','wool','leather','linen'])::int,
    count(distinct role)::int
  from tiered;
$$;

-- -----------------------------------------------------------------------------
-- Which occasions the wardrobe cannot dress, and which slot is the blocker.
-- This is what turns "buy more clothes" into "you have nothing to wear on your
-- feet for a formal event" — actionable, and true.
-- -----------------------------------------------------------------------------
create or replace function public.wardrobe_coverage(p_user_id uuid)
returns table (
  occasion_slug text,
  display_name  text,
  wearable      boolean,
  missing_roles text[],
  option_count  int
)
language sql
stable
as $$
  with occ as (
    select * from public.occasions
     where is_active and (user_id is null or user_id = p_user_id)
  ),
  fit as (
    select o.slug, o.display_name, g.role::text as role, count(*)::int as n
      from occ o
      join public.garments g
        on g.user_id = p_user_id
       and g.deleted_at is null
       and g.is_archived = false
       and g.ownership in ('owned','borrowed')
       and g.formality between o.formality_min and o.formality_max
       and not (g.role = any(o.banned_roles))
       and not (g.category_id in (
             select c.id from public.garment_categories c
              where c.slug = any(o.banned_categories)))
     group by o.slug, o.display_name, g.role
  ),
  need as (
    select o.slug, o.display_name, r.role
      from occ o
      cross join unnest(array['footwear','base_top','bottom']) as r(role)
  )
  select n.slug,
         n.display_name,
         bool_and(coalesce(f.n, 0) > 0
                  or (n.role in ('base_top','bottom')
                      and exists (select 1 from fit ff
                                   where ff.slug = n.slug and ff.role = 'full_body'))),
         array_remove(array_agg(case when coalesce(f.n,0) = 0 then n.role end), null),
         coalesce(sum(f.n), 0)::int
    from need n
    left join fit f on f.slug = n.slug and f.role = n.role
   group by n.slug, n.display_name
   order by n.display_name;
$$;

grant select on public.brand_tiers, public.price_bands to authenticated, anon;
grant all    on public.brand_tiers, public.price_bands to service_role;
grant execute on function public.brand_key(text) to authenticated, service_role;
grant execute on function public.wardrobe_evidence(uuid) to authenticated, service_role;
grant execute on function public.wardrobe_coverage(uuid) to authenticated, service_role;
