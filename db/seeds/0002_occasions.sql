-- =============================================================================
-- SmartStylist seed 0002 — global occasion catalogue
-- scoring_weights override the engine defaults declared in
-- docs/03-recommendation-engine.md (multiplicative on the base weight).
-- =============================================================================
insert into public.occasions
  (user_id, slug, display_name, description, formality_min, formality_max,
   required_roles, optional_roles, banned_roles, banned_categories, banned_patterns,
   scoring_weights, typical_duration_h, is_outdoor, icon, sort_order)
values
 (null,'date_night','Date Night','Evening out, impression matters',3,5,
  '{footwear}','{outerwear,bag,jewelry,watch}','{}','{joggers,leggings}','{camouflage,logo}',
  '{"color_harmony":1.25,"novelty":1.2,"personal_taste":1.3,"formality_fit":0.9}',4,false,'sparkles',10),

 (null,'business_meeting','Business Meeting','Office / client-facing',4,5,
  '{footwear}','{outerwear,bag,watch,belt}','{}','{shorts,joggers,hoodie,sandals}','{graphic,tie_dye,camouflage,animal}',
  '{"formality_fit":1.6,"color_harmony":1.1,"novelty":0.5,"pattern_balance":1.3}',8,false,'briefcase',20),

 (null,'job_interview','Job Interview','Conservative, polished',4,5,
  '{footwear}','{outerwear,bag,watch}','{}','{shorts,joggers,hoodie,sneakers,sandals}','{graphic,tie_dye,camouflage,animal,logo}',
  '{"formality_fit":1.8,"color_harmony":1.0,"novelty":0.3,"pattern_balance":1.5}',2,false,'id-card',25),

 (null,'casual_gathering','Casual Gathering','Friends, coffee, hanging out',2,3,
  '{footwear}','{outerwear,bag,headwear}','{}','{}','{}',
  '{"comfort":1.4,"novelty":1.1,"formality_fit":0.8}',4,false,'users',30),

 (null,'formal_event','Formal Event','Black tie / gala',5,5,
  '{footwear}','{bag,jewelry,outerwear}','{}','{sneakers,joggers,shorts,hoodie,t_shirt,backpack}','{graphic,camouflage,tie_dye,logo}',
  '{"formality_fit":2.0,"color_harmony":1.3,"novelty":0.7}',5,false,'star',40),

 (null,'wedding_guest','Wedding Guest','Celebration, avoid white',4,5,
  '{footwear}','{bag,jewelry,headwear,outerwear}','{}','{joggers,hoodie}','{camouflage}',
  '{"formality_fit":1.5,"color_harmony":1.4,"avoid_bridal_white":3.0}',8,null,'heart',50),

 (null,'night_out','Night Out','Bars, clubs, live music',3,5,
  '{footwear}','{outerwear,bag,jewelry}','{}','{}','{}',
  '{"novelty":1.5,"personal_taste":1.4,"color_harmony":1.1,"comfort":0.7}',6,false,'moon',60),

 (null,'brunch','Brunch','Daytime social',2,4,
  '{footwear}','{outerwear,bag,eyewear}','{}','{}','{}',
  '{"color_harmony":1.2,"comfort":1.1}',3,null,'coffee',70),

 (null,'workout','Workout','Gym / training',1,2,
  '{footwear}','{headwear,bag}','{jewelry,belt}','{dress_shoes,heels,blazer,suit,dress}','{}',
  '{"comfort":2.0,"breathability":1.8,"formality_fit":0.3}',1.5,null,'dumbbell',80),

 (null,'travel_day','Travel Day','Airport / long transit',1,3,
  '{footwear}','{outerwear,bag,headwear}','{}','{heels}','{}',
  '{"comfort":1.9,"layerability":1.6,"novelty":0.6}',10,null,'plane',90),

 (null,'beach_day','Beach Day','Sun, sand, water',1,2,
  '{footwear}','{headwear,eyewear,bag}','{}','{blazer,suit,coat,boots}','{}',
  '{"comfort":1.5,"breathability":2.0,"uv_protection":1.4}',6,true,'sun',100),

 (null,'religious_service','Religious Service','Modest, respectful',3,5,
  '{footwear}','{headwear,bag,scarf}','{}','{shorts,tank}','{graphic,animal}',
  '{"modesty":2.0,"formality_fit":1.3,"novelty":0.5}',2,false,'building',110),

 (null,'funeral','Funeral','Sombre, muted palette',4,5,
  '{footwear}','{outerwear,bag}','{}','{shorts,sneakers}','{floral,graphic,animal,tie_dye,polka_dot}',
  '{"formality_fit":1.6,"muted_palette":2.5,"novelty":0.1}',3,null,'cloud',120),

 (null,'conference','Conference','Smart casual, long day on foot',3,4,
  '{footwear}','{outerwear,bag,watch}','{}','{shorts,heels}','{tie_dye}',
  '{"comfort":1.3,"formality_fit":1.2,"layerability":1.3}',9,false,'presentation',130),

 (null,'home_lounge','At Home','Comfort first',1,2,
  '{}','{footwear}','{}','{suit,blazer,heels}','{}',
  '{"comfort":2.2,"formality_fit":0.2}',12,false,'home',140);
