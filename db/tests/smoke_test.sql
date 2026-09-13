-- =============================================================================
-- SmartStylist — schema smoke test
-- Exercises: consent gate, biometric accessor, category defaults, colour
-- extraction, candidate retrieval, wear-log triggers and RLS isolation.
-- Run against a freshly migrated + seeded database. Rolls back at the end.
-- =============================================================================
\set ON_ERROR_STOP on
begin;

-- Two users -------------------------------------------------------------------
insert into public.users (id, email, display_name, country_code, timezone)
values ('11111111-1111-1111-1111-111111111111','alia@example.com','Alia','AE','Asia/Dubai'),
       ('22222222-2222-2222-2222-222222222222','sam@example.com','Sam','GB','Europe/London');

set local app.current_user_id = '11111111-1111-1111-1111-111111111111';

-- 1. Biometrics require consent ------------------------------------------------
do $$
begin
  perform public.upsert_biometric_profile('{"height_cm":168}'::jsonb);
  raise exception 'FAIL: biometric write succeeded without consent';
exception
  when insufficient_privilege then
    raise notice 'PASS 1: biometric write blocked without consent';
end $$;

insert into public.user_consents (user_id, consent_type, granted, policy_version)
values ('11111111-1111-1111-1111-111111111111','biometric_processing',true,'privacy-2026-04-01'),
       ('11111111-1111-1111-1111-111111111111','vton_processing',true,'privacy-2026-04-01');

select case when (public.upsert_biometric_profile(
         '{"height_cm":168,"waist_cm":70,"hip_cm":98,"body_shape":"pear",
           "skin_tone_monk":6,"skin_undertone":"warm","seasonal_palette":"true_autumn"}'::jsonb
       )).height_cm = 168
       then 'PASS 2: biometric upsert with consent' else 'FAIL 2' end;

select case when (public.get_biometric_profile()).seasonal_palette = 'true_autumn'
       then 'PASS 3: biometric read + audit' else 'FAIL 3' end;

select case when count(*) = 2 then 'PASS 4: audit rows written' else 'FAIL 4' end
from audit.access_log where subject_user_id = '11111111-1111-1111-1111-111111111111';

-- 2. Media + garments ----------------------------------------------------------
insert into public.media_assets (id, user_id, bucket, storage_key, mime_type, source, sha256)
values ('aaaaaaa1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'ss-user-source','u1/src/ig_001.jpg','image/jpeg','instagram', repeat('a',64));

-- category defaults must flow into the garment (no formality/warmth given)
insert into public.garments (id, user_id, category_id, source_media_id, name, brand, pattern, material)
select 'bbbbbbb1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
       c.id,'aaaaaaa1-0000-0000-0000-000000000001','Navy linen shirt','Uniqlo','solid','{linen}'
from public.garment_categories c where c.slug = 'shirt';

select case when role = 'base_top' and formality = 4 and warmth = 1 and is_layerable
       then 'PASS 5: category defaults inherited' else 'FAIL 5: '||role||'/'||formality||'/'||warmth end
from public.garments where id = 'bbbbbbb1-0000-0000-0000-000000000001';

-- the rest of a look
insert into public.garments (user_id, category_id, name, pattern, material)
select '11111111-1111-1111-1111-111111111111', c.id, v.name, 'solid', v.mat::text[]
from (values ('chinos','Camel chinos','{cotton}'),
             ('minimal_sneakers','White leather sneakers','{leather}'),
             ('blazer','Navy blazer','{wool}'),
             ('puffer','Arctic puffer','{nylon}'),
             ('sandals','Suede sandals','{suede}')) as v(slug,name,mat)
join public.garment_categories c on c.slug = v.slug;

-- colours, computed with the in-database converter
insert into public.garment_colors (garment_id, rank, hex, ratio, lab_l, lab_a, lab_b, lch_h, lch_c, color_family, is_neutral)
select g.id, 1, v.hex, 0.82, c.lab_l, c.lab_a, c.lab_b, c.lch_h, c.lch_c, v.family, v.neutral
from (values ('Navy linen shirt','#1B2A4A','navy',true),
             ('Camel chinos','#B08245','camel',true),
             ('White leather sneakers','#FFFFFF','white',true),
             ('Navy blazer','#1B2A4A','navy',true),
             ('Arctic puffer','#36393F','charcoal',true),
             ('Suede sandals','#6B4A2F','brown',true)) as v(name,hex,family,neutral)
join public.garments g on g.name = v.name and g.user_id = '11111111-1111-1111-1111-111111111111'
cross join lateral public.hex_to_color_row(v.hex) c;

-- 3. Colour scoring -------------------------------------------------------------
select case when (select score from public.score_color_pair('navy','camel')) = 0.95
       then 'PASS 6: curated colour rule hit' else 'FAIL 6' end;
select case when (select harmony from public.score_color_pair('mint','coral', 165, 35, 25, 60)) is not null
       then 'PASS 7: geometric colour fallback' else 'FAIL 7' end;

-- 4. Candidate retrieval ----------------------------------------------------------
-- Warm day (28C): the puffer must drop out on warmth, sandals stay.
select case when count(*) filter (where garment_id in
              (select id from public.garments where name = 'Arctic puffer')) = 0
       then 'PASS 8: puffer filtered out at 28C' else 'FAIL 8' end
from public.wardrobe_candidates('11111111-1111-1111-1111-111111111111','casual_gathering',28,0);

-- Business meeting: sneakers are not banned but formality 3 < min 4 → excluded.
select case when count(*) filter (where garment_id in
              (select id from public.garments where name = 'White leather sneakers')) = 0
       then 'PASS 9: low-formality item excluded for business_meeting' else 'FAIL 9' end
from public.wardrobe_candidates('11111111-1111-1111-1111-111111111111','business_meeting',20,0);

-- Rain: suede footwear is excluded.
select case when count(*) filter (where garment_id in
              (select id from public.garments where name = 'Suede sandals')) = 0
       then 'PASS 10: suede excluded when raining' else 'FAIL 10' end
from public.wardrobe_candidates('11111111-1111-1111-1111-111111111111','casual_gathering',26,0.9);

-- 5. Outfit + wear log triggers ------------------------------------------------
insert into public.outfits (id, user_id, name, origin, total_score, occasion_id)
select 'ccccccc1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
       'Navy + camel', 'ai', 0.8710, o.id
from public.occasions o where o.slug = 'business_meeting' and o.user_id is null;

insert into public.outfit_items (outfit_id, garment_id, role, layer_order)
select 'ccccccc1-0000-0000-0000-000000000001', g.id, g.role,
       case g.role when 'base_top' then 0 when 'bottom' then 0 else 1 end
from public.garments g
where g.user_id = '11111111-1111-1111-1111-111111111111'
  and g.name in ('Navy linen shirt','Camel chinos','Navy blazer');

do $$
begin
  insert into public.outfit_items (outfit_id, garment_id, role)
  select 'ccccccc1-0000-0000-0000-000000000001', id, 'bottom'
    from public.garments
   where name = 'Camel chinos' and user_id = '11111111-1111-1111-1111-111111111111';
  raise exception 'FAIL 11: duplicate bottom role accepted';
exception
  when unique_violation then raise notice 'PASS 11: single-occupancy role enforced';
end $$;

insert into public.wear_log (user_id, garment_id, outfit_id, worn_on)
select '11111111-1111-1111-1111-111111111111', g.id,
       'ccccccc1-0000-0000-0000-000000000001', current_date
from public.garments g
where g.user_id = '11111111-1111-1111-1111-111111111111' and g.name = 'Navy linen shirt';

select case when wear_count = 1 and last_worn_at = current_date
       then 'PASS 12: wear_log trigger updated garment stats' else 'FAIL 12' end
from public.garments where name = 'Navy linen shirt';

-- 6. VTON job ---------------------------------------------------------------------
insert into private.body_reference_photos (id, user_id, media_asset_id, is_primary, pose)
values ('ddddddd1-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
        'aaaaaaa1-0000-0000-0000-000000000001', true, 'front_full');

insert into public.vton_jobs (user_id, model_id, body_photo_id, garment_ids, outfit_id, params)
select '11111111-1111-1111-1111-111111111111','mock@1','ddddddd1-0000-0000-0000-000000000001',
       array_agg(g.id), 'ccccccc1-0000-0000-0000-000000000001', '{"steps":30,"seed":42}'::jsonb
from public.garments g
where g.user_id = '11111111-1111-1111-1111-111111111111' and g.name = 'Navy linen shirt';

select case when count(*) = 1 then 'PASS 13: vton job queued' else 'FAIL 13' end
from public.vton_jobs where status = 'queued';

-- quota gate
insert into public.usage_counters (user_id, period_start, metric, used, quota)
values ('11111111-1111-1111-1111-111111111111', date_trunc('month', now())::date, 'vton_renders', 4, 5);
select case when public.consume_quota('11111111-1111-1111-1111-111111111111','vton_renders',1)
             and not public.consume_quota('11111111-1111-1111-1111-111111111111','vton_renders',1)
       then 'PASS 14: quota enforced at limit' else 'FAIL 14' end;

-- 7. RLS isolation -------------------------------------------------------------
set local role authenticated;
select case when count(*) > 0 then 'PASS 15: owner sees own garments' else 'FAIL 15' end
from public.garments;

set local app.current_user_id = '22222222-2222-2222-2222-222222222222';
select case when count(*) = 0 then 'PASS 16: RLS hides other users'' garments' else 'FAIL 16' end
from public.garments;
select case when count(*) = 0 then 'PASS 17: RLS hides other users'' outfit_items' else 'FAIL 17' end
from public.outfit_items;
select case when count(*) = 15 then 'PASS 18: global occasions still readable' else 'FAIL 18' end
from public.occasions;

do $$
begin
  insert into public.garments (user_id, category_id, name)
  values ('11111111-1111-1111-1111-111111111111', 1, 'smuggled item');
  raise exception 'FAIL 19: cross-user insert accepted';
exception
  when insufficient_privilege then raise notice 'PASS 19: cross-user insert rejected by RLS';
end $$;

do $$
begin
  perform 1 from private.biometric_profiles;
  raise exception 'FAIL 20: private schema readable by authenticated role';
exception
  when insufficient_privilege then raise notice 'PASS 20: private schema not readable by clients';
end $$;

reset role;
rollback;
