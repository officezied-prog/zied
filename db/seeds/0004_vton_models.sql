-- =============================================================================
-- SmartStylist seed 0004 — virtual try-on model registry
-- IMPORTANT: `license` / `commercial_ok` values below are starting assumptions.
-- Verify each checkpoint's licence with counsel before enabling it in a paid
-- tier — several leading open VTON models ship under non-commercial terms, and
-- the router reads `commercial_ok` to keep them out of production traffic.
-- =============================================================================
insert into public.vton_models
  (id, display_name, provider, provider_ref, family, license, commercial_ok,
   supports_roles, supports_multi_garment, input_resolution, avg_latency_ms,
   cost_per_call_usd, quality_score, is_enabled, config)
values
 ('mock@1','Deterministic mock (CI/dev)','mock',null,'hybrid','internal',true,
  '{base_top,bottom,full_body,outerwear}',true,'768x1024',50,0.0000,0.100,true,
  '{"note":"returns the body photo with the garment composited flat; used in tests"}'),

 ('idm-vton@1','IDM-VTON','internal_gpu','yisol/IDM-VTON','diffusion','verify-before-commercial-use',false,
  '{base_top,full_body}',false,'768x1024',9000,0.0180,0.860,true,
  '{"steps":30,"guidance":2.0,"needs":["densepose","human_parsing","cloth_mask"]}'),

 ('catvton@1','CatVTON','internal_gpu','zhengchong/CatVTON','diffusion','verify-before-commercial-use',false,
  '{base_top,bottom,full_body}',false,'768x1024',6000,0.0120,0.830,true,
  '{"steps":50,"guidance":2.5,"needs":["cloth_mask"],"note":"lighter VRAM than IDM-VTON"}'),

 ('ootd@1','OOTDiffusion','internal_gpu','levihsu/OOTDiffusion','diffusion','verify-before-commercial-use',false,
  '{base_top,bottom,full_body}',false,'768x1024',8000,0.0150,0.820,false,
  '{"steps":20,"needs":["human_parsing","openpose"]}'),

 ('hosted-commercial@1','Licensed commercial VTON API','replicate','<vendor/model>','diffusion','commercial-saas',true,
  '{base_top,bottom,full_body,outerwear,footwear}',true,'1024x1536',12000,0.0800,0.900,false,
  '{"note":"placeholder row: fill in once a commercially-licensed vendor is selected"}');
