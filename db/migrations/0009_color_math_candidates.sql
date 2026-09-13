-- =============================================================================
-- SmartStylist — 0009: colour science + candidate retrieval in the database
-- These are the primitives the Phase-3 styling engine calls; keeping them in
-- SQL means candidate filtering happens next to the data instead of pulling a
-- whole wardrobe into Python on every request.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sRGB hex -> CIELAB (D65, 2° observer)
-- -----------------------------------------------------------------------------
create or replace function public.hex_to_lab(p_hex text)
returns table (l numeric, a numeric, b numeric)
language plpgsql
immutable
as $$
declare
  r double precision; g double precision; bl double precision;
  x double precision; y double precision; z double precision;
  fx double precision; fy double precision; fz double precision;
  h text := replace(p_hex, '#', '');
begin
  if h !~ '^[0-9A-Fa-f]{6}$' then
    raise exception 'invalid hex colour: %', p_hex;
  end if;

  r  := ('x' || substr(h,1,2))::bit(8)::int / 255.0;
  g  := ('x' || substr(h,3,2))::bit(8)::int / 255.0;
  bl := ('x' || substr(h,5,2))::bit(8)::int / 255.0;

  -- sRGB gamma expansion
  r  := case when r  > 0.04045 then power((r  + 0.055)/1.055, 2.4) else r /12.92 end;
  g  := case when g  > 0.04045 then power((g  + 0.055)/1.055, 2.4) else g /12.92 end;
  bl := case when bl > 0.04045 then power((bl + 0.055)/1.055, 2.4) else bl/12.92 end;

  x := (r*0.4124564 + g*0.3575761 + bl*0.1804375) / 0.95047;
  y := (r*0.2126729 + g*0.7151522 + bl*0.0721750) / 1.00000;
  z := (r*0.0193339 + g*0.1191920 + bl*0.9503041) / 1.08883;

  fx := case when x > 0.008856 then power(x, 1.0/3.0) else (7.787*x + 16.0/116.0) end;
  fy := case when y > 0.008856 then power(y, 1.0/3.0) else (7.787*y + 16.0/116.0) end;
  fz := case when z > 0.008856 then power(z, 1.0/3.0) else (7.787*z + 16.0/116.0) end;

  l := round((116.0*fy - 16.0)::numeric, 4);
  a := round((500.0*(fx - fy))::numeric, 4);
  b := round((200.0*(fy - fz))::numeric, 4);
  return next;
end;
$$;

-- -----------------------------------------------------------------------------
-- CIEDE2000 colour difference. ~0-1 imperceptible, <2.3 "just noticeable",
-- >10 clearly different colours.
-- -----------------------------------------------------------------------------
create or replace function public.ciede2000(
  l1 double precision, a1 double precision, b1 double precision,
  l2 double precision, a2 double precision, b2 double precision
) returns double precision
language plpgsql
immutable
as $$
declare
  deg constant double precision := 180.0 / pi();
  c1 double precision; c2 double precision; cbar double precision; gfac double precision;
  a1p double precision; a2p double precision; c1p double precision; c2p double precision;
  h1p double precision; h2p double precision;
  dlp double precision; dcp double precision; dhp double precision; dhbig double precision;
  lbar double precision; cbarp double precision; hbarp double precision;
  t double precision; dtheta double precision; rc double precision;
  sl double precision; sc double precision; sh double precision; rt double precision;
begin
  c1 := sqrt(a1*a1 + b1*b1);
  c2 := sqrt(a2*a2 + b2*b2);
  cbar := (c1 + c2) / 2.0;
  gfac := 0.5 * (1.0 - sqrt(power(cbar,7) / (power(cbar,7) + power(25.0,7))));

  a1p := (1.0 + gfac) * a1;
  a2p := (1.0 + gfac) * a2;
  c1p := sqrt(a1p*a1p + b1*b1);
  c2p := sqrt(a2p*a2p + b2*b2);

  h1p := case when a1p = 0 and b1 = 0 then 0
              else ((atan2(b1, a1p) * deg + 360.0)::numeric % 360.0)::double precision end;
  h2p := case when a2p = 0 and b2 = 0 then 0
              else ((atan2(b2, a2p) * deg + 360.0)::numeric % 360.0)::double precision end;

  dlp := l2 - l1;
  dcp := c2p - c1p;

  if c1p * c2p = 0 then
    dhp := 0;
  elsif abs(h2p - h1p) <= 180 then
    dhp := h2p - h1p;
  elsif h2p - h1p > 180 then
    dhp := h2p - h1p - 360.0;
  else
    dhp := h2p - h1p + 360.0;
  end if;

  dhbig := 2.0 * sqrt(c1p * c2p) * sin((dhp / 2.0) / deg);

  lbar  := (l1 + l2) / 2.0;
  cbarp := (c1p + c2p) / 2.0;

  if c1p * c2p = 0 then
    hbarp := h1p + h2p;
  elsif abs(h1p - h2p) <= 180 then
    hbarp := (h1p + h2p) / 2.0;
  elsif h1p + h2p < 360 then
    hbarp := (h1p + h2p + 360.0) / 2.0;
  else
    hbarp := (h1p + h2p - 360.0) / 2.0;
  end if;

  t := 1.0
       - 0.17 * cos((hbarp - 30.0) / deg)
       + 0.24 * cos((2.0 * hbarp) / deg)
       + 0.32 * cos((3.0 * hbarp + 6.0) / deg)
       - 0.20 * cos((4.0 * hbarp - 63.0) / deg);

  dtheta := 30.0 * exp(- power((hbarp - 275.0) / 25.0, 2));
  rc     := 2.0 * sqrt(power(cbarp,7) / (power(cbarp,7) + power(25.0,7)));
  sl     := 1.0 + (0.015 * power(lbar - 50.0, 2)) / sqrt(20.0 + power(lbar - 50.0, 2));
  sc     := 1.0 + 0.045 * cbarp;
  sh     := 1.0 + 0.015 * cbarp * t;
  rt     := -sin((2.0 * dtheta) / deg) * rc;

  return sqrt(
      power(dlp / sl, 2)
    + power(dcp / sc, 2)
    + power(dhbig / sh, 2)
    + rt * (dcp / sc) * (dhbig / sh)
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Colour pairing score: curated rule first, hue geometry as the fallback.
-- Returns (score -1..1, harmony).
-- -----------------------------------------------------------------------------
create or replace function public.score_color_pair(
  p_family_a text, p_family_b text,
  p_hue_a numeric default null, p_hue_b numeric default null,
  p_chroma_a numeric default null, p_chroma_b numeric default null
) returns table (score numeric, harmony public.color_harmony)
language plpgsql
stable
as $$
declare
  r record;
  dh numeric;
begin
  select cpr.score, cpr.harmony into r
  from public.color_pair_rules cpr
  where (cpr.family_a = p_family_a and cpr.family_b = p_family_b)
     or (cpr.family_a = p_family_b and cpr.family_b = p_family_a)
  limit 1;

  if found then
    score := r.score; harmony := r.harmony; return next; return;
  end if;

  -- Neutral anchors are safe with anything.
  if exists (select 1 from public.color_families f
              where f.slug in (p_family_a, p_family_b) and f.is_neutral) then
    score := 0.65; harmony := 'neutral_anchor'; return next; return;
  end if;

  if p_hue_a is null or p_hue_b is null then
    score := 0.30; harmony := 'accent_pop'; return next; return;
  end if;

  dh := abs(p_hue_a - p_hue_b);
  if dh > 180 then dh := 360 - dh; end if;

  if dh <= 12 then
    score := 0.80; harmony := 'monochromatic';
  elsif dh <= 45 then
    score := 0.75; harmony := 'analogous';
  elsif dh <= 95 then
    score := 0.35; harmony := 'accent_pop';        -- the awkward middle
  elsif dh <= 135 then
    score := 0.60; harmony := 'triadic';
  elsif dh <= 165 then
    score := 0.70; harmony := 'split_complementary';
  else
    score := 0.78; harmony := 'complementary';
  end if;

  -- Two high-chroma hero colours fight each other.
  if coalesce(p_chroma_a,0) > 55 and coalesce(p_chroma_b,0) > 55 and dh > 45 then
    score := score - 0.25;
  end if;

  return next;
end;
$$;

-- -----------------------------------------------------------------------------
-- Candidate retrieval: everything wearable for an occasion + temperature.
-- The Python engine then scores/combines these into outfits.
-- -----------------------------------------------------------------------------
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
  -- Target warmth band from temperature: 25°C+ wants warmth<=1, below 0°C wants 4+.
  band as (
    select case
             when p_temp_c is null then null
             when p_temp_c >= 26 then int4range(0, 2)
             when p_temp_c >= 18 then int4range(0, 3)
             when p_temp_c >= 10 then int4range(1, 4)
             when p_temp_c >=  2 then int4range(2, 6)
             else int4range(3, 6)
           end as warmth_range,
           case
             when p_temp_c is null then null
             when p_temp_c >= 22 then 'summer'::public.season
             when p_temp_c >= 12 then 'spring'::public.season
             when p_temp_c >=  4 then 'autumn'::public.season
             else 'winter'::public.season
           end as target_season
  )
  select g.id, g.role, g.category_id, g.formality, g.warmth, g.pattern,
         pc.hex, pc.color_family, pc.lch_h, pc.lch_c, coalesce(pc.is_neutral, false),
         g.wear_count,
         coalesce((current_date - g.last_worn_at), 9999) as days_since_worn,
         g.cutout_media_id
    from public.garments g
    cross join band
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
     and (band.warmth_range is null or g.warmth::int <@ band.warmth_range)
     and (band.target_season is null
          or 'all_season' = any(g.seasons)
          or band.target_season = any(g.seasons))
     -- In the rain, exclude non-water-resistant outerwear and suede footwear.
     and (coalesce(p_precip_prob,0) < 0.5
          or g.role not in ('outerwear','footwear')
          or g.water_resistant
          or not ('suede' = any(g.material)))
   order by days_since_worn desc, g.wear_count asc
   limit p_limit;
$$;

-- -----------------------------------------------------------------------------
-- Reporting view used by the wardrobe screen (cost per wear, neglected items).
-- -----------------------------------------------------------------------------
create or replace view public.v_wardrobe_stats as
select g.user_id,
       count(*)                                    as items,
       count(*) filter (where g.wear_count = 0)    as never_worn,
       count(*) filter (where g.last_worn_at > current_date - 30) as worn_last_30d,
       round(avg(nullif(g.purchase_price,0) / nullif(g.wear_count,0)), 2) as avg_cost_per_wear,
       sum(g.purchase_price)                       as closet_value
  from public.garments g
 where g.deleted_at is null and g.is_archived = false
 group by g.user_id;

-- -----------------------------------------------------------------------------
-- CIELAB -> LCh(ab). Hue is normalised to [0,360) — callers must never compute
-- this with a bare degrees(atan2(..)) because negative hues break the
-- garment_colors.lch_h check constraint and the harmony maths.
-- -----------------------------------------------------------------------------
create or replace function public.lab_to_lch(p_a double precision, p_b double precision)
returns table (chroma numeric, hue numeric)
language sql
immutable
as $$
  select round(sqrt(p_a*p_a + p_b*p_b)::numeric, 3),
         round((((degrees(atan2(p_b, p_a)))::numeric % 360) + 360) % 360, 2);
$$;

-- One-shot helper: hex straight to the columns garment_colors expects.
create or replace function public.hex_to_color_row(p_hex text)
returns table (lab_l numeric, lab_a numeric, lab_b numeric, lch_c numeric, lch_h numeric)
language sql
immutable
as $$
  select l.l, l.a, l.b, x.chroma, x.hue
  from public.hex_to_lab(p_hex) l
  cross join lateral public.lab_to_lch(l.a::double precision, l.b::double precision) x;
$$;
