-- =============================================================================
-- SmartStylist — 0013: correct the temperature model in candidate retrieval
--
-- Found in Phase 3 by a test asserting that sub-zero weather produces a layered
-- outfit — it produced nothing at all.
--
-- The original `wardrobe_candidates` filtered each garment into a two-sided
-- warmth *band*. That is wrong: in cold weather you still wear a light shirt —
-- as a base layer under a coat. The band excluded every light top and bottom
-- below 2°C, leaving a pool of nothing but outerwear and no buildable outfit.
--
-- The correct model:
--   * temperature imposes a warmth CEILING (no parka at 30°C), never a floor;
--   * the floor belongs to the *total* warmth of the assembled look, which the
--     scorer already handles (`weather_fit`), because layering is what makes a
--     light garment appropriate in winter;
--   * seasons are matched against an adjacency set, not a single season — an
--     autumn jacket is fine on a cold spring day.
-- =============================================================================

create or replace function public.wardrobe_candidates(
  p_user_id      uuid,
  p_occasion     text,
  p_temp_c       numeric default null,
  p_precip_prob  numeric default 0,
  p_roles        public.garment_role[] default null,
  p_limit        int default 400
)
returns table (
  garment_id   uuid,
  role         public.garment_role,
  category_id  int,
  formality    smallint,
  warmth       smallint,
  pattern      public.pattern_type,
  primary_hex  char(7),
  color_family text,
  lch_h        numeric,
  lch_c        numeric,
  is_neutral   boolean,
  wear_count   int,
  days_since_worn int,
  cutout_media_id uuid
)
language sql
stable
as $$
  with occ as (
    select * from public.occasions
     where slug = p_occasion and (user_id is null or user_id = p_user_id)
     order by user_id nulls last
     limit 1
  ),
  climate as (
    select
      -- Ceiling only. A base layer is never "too light" — that is what layers fix.
      case
        when p_temp_c is null then 5
        when p_temp_c >= 26 then 2
        when p_temp_c >= 18 then 3
        when p_temp_c >= 10 then 4
        else 5
      end::smallint as warmth_max,
      -- Adjacent seasons, not one exact season.
      case
        when p_temp_c is null then array['spring','summer','autumn','winter','all_season']
        when p_temp_c >= 22 then array['summer','spring','all_season']
        when p_temp_c >= 12 then array['spring','autumn','summer','all_season']
        when p_temp_c >=  4 then array['autumn','spring','winter','all_season']
        else array['winter','autumn','all_season']
      end::public.season[] as ok_seasons
  )
  select g.id, g.role, g.category_id, g.formality, g.warmth, g.pattern,
         pc.hex, pc.color_family, pc.lch_h, pc.lch_c, coalesce(pc.is_neutral, false),
         g.wear_count,
         coalesce((current_date - g.last_worn_at), 9999) as days_since_worn,
         g.cutout_media_id
    from public.garments g
    cross join climate
    left join occ on true
    left join public.v_garment_primary_color pc on pc.garment_id = g.id
   where g.user_id = p_user_id
     and g.deleted_at is null
     and g.is_archived = false
     and g.in_laundry = false
     and g.ownership in ('owned','borrowed')
     and (g.available_from is null or g.available_from <= current_date)
     and (p_roles is null or g.role = any(p_roles))
     and (occ.id is null or g.formality between occ.formality_min and occ.formality_max)
     and (occ.id is null or not (g.role = any(occ.banned_roles)))
     and (occ.id is null or not (g.pattern = any(occ.banned_patterns)))
     -- Outerwear is exempt from the ceiling: a coat is chosen by the scorer, and
     -- excluding warm coats in mild weather would remove the option of a layer.
     and (g.warmth <= climate.warmth_max
          or g.role in ('outerwear','mid_layer','scarf','headwear'))
     and (g.seasons && climate.ok_seasons)
     -- In the rain, no suede and no non-water-resistant outer layers.
     and (coalesce(p_precip_prob,0) < 0.5
          or g.role not in ('outerwear','footwear')
          or g.water_resistant
          or not ('suede' = any(g.material)))
   order by days_since_worn desc, g.wear_count asc
   limit p_limit;
$$;
