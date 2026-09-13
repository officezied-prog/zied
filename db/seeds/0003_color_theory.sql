-- =============================================================================
-- SmartStylist seed 0003 — colour families, curated pairings, palette affinity
-- Hue/chroma bounds are LCh(ab) values; the ingestion pipeline assigns a family
-- by nearest anchor under CIEDE2000, then validates against these bounds.
-- =============================================================================
insert into public.color_families
  (slug, display_name, anchor_hex, hue_min, hue_max, chroma_min, chroma_max,
   lightness_min, lightness_max, is_neutral, is_hero, warm_cool)
values
 ('black','Black','#111111',null,null,0,12,0,22,true,false,'neutral'),
 ('charcoal','Charcoal','#36393F',null,null,0,12,22,40,true,false,'cool'),
 ('grey','Grey','#9AA0A6',null,null,0,10,40,72,true,false,'neutral'),
 ('white','White','#FFFFFF',null,null,0,6,92,100,true,false,'cool'),
 ('cream','Cream','#F5EFE0',null,null,4,18,88,98,true,false,'warm'),
 ('beige','Beige','#D9C7A7',40,80,8,28,72,88,true,false,'warm'),
 ('camel','Camel','#B08245',45,75,25,45,50,70,true,false,'warm'),
 ('brown','Brown','#6B4A2F',35,70,15,40,25,50,true,false,'warm'),
 ('navy','Navy','#1B2A4A',260,300,15,40,10,30,true,false,'cool'),
 ('denim','Denim','#4A6FA5',255,290,20,40,40,60,true,false,'cool'),
 ('blue','Blue','#2563EB',255,295,45,90,35,60,false,true,'cool'),
 ('light_blue','Light blue','#A5C8E8',240,285,12,32,72,88,false,false,'cool'),
 ('teal','Teal','#0F766E',180,215,25,50,35,55,false,false,'cool'),
 ('mint','Mint','#A8E6CF',150,185,15,35,80,92,false,false,'cool'),
 ('green','Green','#16A34A',130,165,45,80,50,70,false,true,'neutral'),
 ('olive','Olive','#6B7238',95,130,25,45,40,55,true,false,'warm'),
 ('forest','Forest','#1F3D2B',140,175,20,40,20,35,true,false,'cool'),
 ('yellow','Yellow','#FACC15',85,105,70,100,80,92,false,true,'warm'),
 ('mustard','Mustard','#C99A2E',75,95,45,70,60,75,false,false,'warm'),
 ('orange','Orange','#F97316',45,70,60,95,60,75,false,true,'warm'),
 ('coral','Coral','#FF7F6B',25,45,45,70,65,78,false,true,'warm'),
 ('red','Red','#DC2626',25,45,65,100,45,60,false,true,'warm'),
 ('burgundy','Burgundy','#6E1B2E',5,30,35,60,20,38,false,false,'cool'),
 ('pink','Pink','#EC4899',340,10,50,80,55,72,false,true,'cool'),
 ('blush','Blush','#F3C9C6',10,30,10,25,80,90,false,false,'warm'),
 ('purple','Purple','#7C3AED',300,325,55,90,40,58,false,true,'cool'),
 ('lavender','Lavender','#C7B8EA',295,320,15,32,72,86,false,false,'cool'),
 ('gold','Gold','#C9A227',80,100,40,65,65,78,true,false,'warm'),
 ('silver','Silver','#C0C4C8',null,null,0,8,74,84,true,false,'cool');

-- Curated pairings (override the geometric fallback in score_color_pair) ------
insert into public.color_pair_rules (family_a, family_b, harmony, score, formality_min, formality_max, note) values
 ('navy','camel','complementary',0.95,2,5,'Signature smart-casual pairing'),
 ('navy','white','neutral_anchor',0.94,2,5,'Crisp, always works'),
 ('navy','burgundy','analogous',0.82,3,5,'Rich autumn/evening combination'),
 ('navy','black','neutral_anchor',0.45,3,5,'Divisive; needs clear texture contrast'),
 ('black','white','neutral_anchor',0.92,2,5,'Maximum contrast, high formality'),
 ('black','cream','neutral_anchor',0.88,3,5,'Softer than black/white'),
 ('black','gold','accent_pop',0.90,4,5,'Evening / formal'),
 ('black','red','complementary',0.85,3,5,'Bold, high impact'),
 ('charcoal','burgundy','accent_pop',0.86,3,5,null),
 ('grey','blush','neutral_anchor',0.88,2,4,'Soft modern pairing'),
 ('grey','navy','neutral_anchor',0.84,2,5,null),
 ('grey','yellow','accent_pop',0.80,2,4,'Grey mutes a hero yellow'),
 ('white','denim','neutral_anchor',0.93,1,3,'Weekend default'),
 ('white','light_blue','monochromatic',0.85,2,4,null),
 ('cream','camel','analogous',0.90,3,5,'Tonal neutral layering'),
 ('cream','olive','analogous',0.84,2,4,null),
 ('beige','forest','complementary',0.86,2,4,null),
 ('camel','burgundy','analogous',0.84,3,5,null),
 ('camel','forest','complementary',0.83,2,4,null),
 ('brown','blue','complementary',0.80,2,4,'Warm/cool balance'),
 ('olive','coral','complementary',0.82,1,3,null),
 ('olive','mustard','analogous',0.78,1,3,null),
 ('denim','coral','complementary',0.84,1,3,null),
 ('denim','mustard','complementary',0.80,1,3,null),
 ('teal','coral','complementary',0.86,2,4,null),
 ('pink','red','analogous',0.72,3,5,'Deliberate tonal clash, high fashion'),
 ('pink','green','complementary',0.62,2,4,'Needs one desaturated'),
 ('purple','yellow','complementary',0.55,2,4,'Very high contrast; use small accents'),
 ('red','orange','analogous',0.50,1,3,'Both heroes — risky'),
 ('red','green','complementary',0.25,1,5,'Reads as festive; usually avoid'),
 ('brown','black','neutral_anchor',0.40,2,5,'Traditionally avoided; works only tonally'),
 ('mint','lavender','analogous',0.74,2,4,'Pastel pairing'),
 ('silver','light_blue','monochromatic',0.82,3,5,null),
 ('gold','burgundy','analogous',0.86,4,5,null);

-- Seasonal palette affinity (representative subset; extend per colour-analysis
-- vendor. -1 = actively unflattering, +1 = signature colour for that palette).
insert into public.palette_affinity (palette, family, affinity) values
 ('true_winter','black',0.95),('true_winter','white',0.95),('true_winter','navy',0.90),
 ('true_winter','red',0.88),('true_winter','pink',0.80),('true_winter','purple',0.85),
 ('true_winter','silver',0.80),('true_winter','camel',-0.40),('true_winter','olive',-0.55),
 ('true_winter','mustard',-0.60),('true_winter','beige',-0.45),
 ('true_summer','navy',0.85),('true_summer','grey',0.88),('true_summer','lavender',0.86),
 ('true_summer','blush',0.82),('true_summer','light_blue',0.90),('true_summer','teal',0.78),
 ('true_summer','black',-0.30),('true_summer','orange',-0.65),('true_summer','gold',-0.50),
 ('true_autumn','olive',0.92),('true_autumn','camel',0.94),('true_autumn','brown',0.90),
 ('true_autumn','mustard',0.88),('true_autumn','forest',0.86),('true_autumn','burgundy',0.84),
 ('true_autumn','cream',0.80),('true_autumn','pink',-0.45),('true_autumn','silver',-0.55),
 ('true_autumn','black',-0.35),
 ('true_spring','coral',0.92),('true_spring','yellow',0.88),('true_spring','mint',0.82),
 ('true_spring','light_blue',0.80),('true_spring','camel',0.84),('true_spring','gold',0.86),
 ('true_spring','black',-0.50),('true_spring','charcoal',-0.40),('true_spring','burgundy',-0.35);
