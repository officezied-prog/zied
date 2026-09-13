-- =============================================================================
-- SmartStylist — 0018: coverage asks about body parts, not layering roles
--
-- Two faults found while reading real advice output.
--
--  1. The function hardcoded footwear, a top and a bottom as required for
--     *every* occasion, so it reported that the user could not be dressed "at
--     home" for want of shoes. The occasions table already says home_lounge
--     requires no footwear; coverage now asks the occasion what it needs.
--
--  2. It compared outfit *roles* when the question is really about the body.
--     A hoodie's role is mid_layer, so a wardrobe of a hoodie and joggers was
--     reported as having no top. Roles describe layering — which the styling
--     engine needs — but coverage is about whether the torso, the legs and the
--     feet are covered at all. A hoodie covers a torso. So does a coat, and so
--     does a jilbab, which covers the legs at the same time.
-- =============================================================================

-- Which body region each role can cover on its own.
create or replace function public.role_covers(p_role public.garment_role)
returns text[]
language sql
immutable
as $$
  select case p_role
    when 'base_top'  then array['torso']
    when 'mid_layer' then array['torso']
    when 'outerwear' then array['torso']
    when 'full_body' then array['torso','legs']
    when 'bottom'    then array['legs']
    when 'hosiery'   then array['legs']
    when 'footwear'  then array['feet']
    else array[]::text[]
  end;
$$;

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
  wearable_items as (
    select o.slug, g.role, unnest(public.role_covers(g.role)) as region
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
  ),
  covered_regions as (
    select slug, region, count(*)::int as n from wearable_items group by slug, region
  ),
  covered_roles as (
    select o.slug, g.role::text as role, count(*)::int as n
      from occ o
      join public.garments g
        on g.user_id = p_user_id
       and g.deleted_at is null
       and g.is_archived = false
       and g.ownership in ('owned','borrowed')
       and g.formality between o.formality_min and o.formality_max
       and not (g.role = any(o.banned_roles))
     group by o.slug, g.role
  ),
  -- The body must be covered; on top of that, whatever the occasion asks for.
  requirement as (
    select o.slug, o.display_name, 'region'::text as kind, r.name as what
      from occ o cross join (values ('torso'), ('legs')) as r(name)
    union all
    select o.slug, o.display_name, 'role', unnest(o.required_roles)::text
      from occ o
  ),
  resolved as (
    select q.slug, q.display_name, q.kind, q.what,
           case q.kind
             when 'region' then exists (select 1 from covered_regions cr
                                         where cr.slug = q.slug and cr.region = q.what)
             else exists (select 1 from covered_roles cl
                           where cl.slug = q.slug and cl.role = q.what)
           end as covered
      from requirement q
  )
  select r.slug,
         r.display_name,
         bool_and(r.covered),
         array_remove(array_agg(distinct case when not r.covered then
             -- Report the missing thing the way a person would name it.
             case r.what when 'torso' then 'base_top'
                         when 'legs'  then 'bottom'
                         else r.what end
           end), null),
         coalesce((select sum(n) from covered_roles c where c.slug = r.slug), 0)::int
    from resolved r
   group by r.slug, r.display_name
   order by r.display_name;
$$;

grant execute on function public.role_covers(public.garment_role) to authenticated, service_role;
grant execute on function public.wardrobe_coverage(uuid) to authenticated, service_role;
