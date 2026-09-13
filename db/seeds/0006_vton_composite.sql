-- =============================================================================
-- SmartStylist seed 0006 — the geometric compositing renderer
-- Added in Phase 4. Not a diffusion model and labelled as such: it warps and
-- composites garment cutouts onto the body zones, preserving the face. It is
-- commercially unencumbered, so it is the default renderer, the free-tier
-- renderer, and the fallback when GPU capacity is exhausted.
-- =============================================================================
insert into public.vton_models
  (id, display_name, provider, provider_ref, family, license, commercial_ok,
   supports_roles, supports_multi_garment, input_resolution, avg_latency_ms,
   cost_per_call_usd, quality_score, is_enabled, config)
values
  ('composite@1', 'Composite try-on', 'internal_gpu', null, 'hybrid', 'internal', true,
   '{base_top,mid_layer,outerwear,bottom,full_body,footwear,bag,headwear,scarf,belt}',
   true, 'source', 120, 0.0000, 0.450, true,
   '{"technique":"geometric_composite","preserves_face":true}')
on conflict (id) do update
  set commercial_ok = excluded.commercial_ok,
      supports_roles = excluded.supports_roles,
      config = excluded.config;

-- The diffusion checkpoints stay disabled until their licences are cleared and
-- GPU capacity exists; `commercial_ok = false` keeps the router off them anyway.
update public.vton_models set is_enabled = false
 where id in ('idm-vton@1', 'catvton@1', 'ootd@1', 'hosted-commercial@1');
