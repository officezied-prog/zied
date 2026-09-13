-- =============================================================================
-- SmartStylist — 0019: shop mode
--
-- A photograph taken in a shop, judged against the wardrobe at home before the
-- money is spent. The scan is kept because the decision is rarely made on the
-- spot: people photograph three things, walk around, and come back.
--
-- What is deliberately NOT here: no shop identity, no geolocation, no price
-- scraping, no link to a retailer. The feature answers "does this go with what
-- I own", and collecting where somebody shops would serve a different purpose
-- than the one the user asked for.
-- =============================================================================

create type public.scan_verdict as enum (
  'fills_a_gap',        -- unlocks an occasion or a colour the wardrobe lacks
  'adds_variety',       -- works with a lot of what is owned, nothing is blocked
  'have_similar',       -- close to something already owned
  'hard_to_wear'        -- pairs with very little of the wardrobe
);

create table public.shop_scans (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  media_asset_id   uuid references public.media_assets(id) on delete set null,
  detection_id     uuid references public.detections(id) on delete set null,

  -- What the photo turned out to be.
  category_id      int references public.garment_categories(id) on delete set null,
  role             public.garment_role,
  pattern          public.pattern_type,
  primary_hex      char(7),
  color_family     text,
  confidence       numeric(4,3),

  -- The judgement, kept so the card can be reopened without recomputing.
  verdict          public.scan_verdict,
  new_pairings     int not null default 0,
  duplicate_count  int not null default 0,
  unlocked         text[] not null default '{}',
  headline         text,
  detail           jsonb not null default '{}'::jsonb,

  -- Set when the user says they bought it; the scan then seeds a garment.
  purchased_at     timestamptz,
  garment_id       uuid references public.garments(id) on delete set null,
  dismissed_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index shop_scans_user_idx on public.shop_scans (user_id, created_at desc);
create index shop_scans_open_idx on public.shop_scans (user_id)
  where purchased_at is null and dismissed_at is null;

alter table public.shop_scans enable row level security;
alter table public.shop_scans force row level security;
create policy shop_scans_owner on public.shop_scans
  for all to authenticated
  using (user_id = public.current_user_id())
  with check (user_id = public.current_user_id());
grant select, insert, update, delete on public.shop_scans to authenticated;
grant all on public.shop_scans to service_role;

-- -----------------------------------------------------------------------------
-- How much of the wardrobe is already this colour, in this role.
--
-- The question a shopper actually needs answered is not "do I own navy" but
-- "do I own another navy shirt" — saturation is per role, not global.
-- -----------------------------------------------------------------------------
create or replace function public.wardrobe_saturation(
  p_user_id uuid, p_role public.garment_role, p_family text
)
returns table (
  items_total       int,
  items_in_role     int,
  items_in_family   int,
  items_role_family int,
  family_share      numeric,
  role_family_share numeric
)
language sql
stable
as $$
  with owned as (
    select g.id, g.role, pc.color_family
      from public.garments g
      left join public.v_garment_primary_color pc on pc.garment_id = g.id
     where g.user_id = p_user_id
       and g.deleted_at is null and g.is_archived = false
       and g.ownership in ('owned','borrowed')
  )
  select count(*)::int,
         count(*) filter (where role = p_role)::int,
         count(*) filter (where color_family = p_family)::int,
         count(*) filter (where role = p_role and color_family = p_family)::int,
         round(count(*) filter (where color_family = p_family)::numeric
               / nullif(count(*), 0), 3),
         round(count(*) filter (where role = p_role and color_family = p_family)::numeric
               / nullif(count(*) filter (where role = p_role), 0), 3)
    from owned;
$$;

grant execute on function public.wardrobe_saturation(uuid, public.garment_role, text)
   to authenticated, service_role;
