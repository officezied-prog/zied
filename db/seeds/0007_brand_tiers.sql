-- =============================================================================
-- SmartStylist seed 0007 — brand price tiers and typical spend bands
--
-- Used only as a fallback when the user recorded no price for an item. Tiers
-- are a rough retail segmentation, not a judgement of taste or of the person
-- wearing them, and they are regional: extend the table per market rather than
-- assuming this list travels.
--
--   1 value · 2 high street · 3 premium high street · 4 designer · 5 luxury
-- =============================================================================
insert into public.brand_tiers (brand_key, display_name, tier, region, note) values
  ('primark','Primark',1,'eu',null),
  ('shein','SHEIN',1,'global',null),
  ('hm','H&M',2,'global',null),
  ('zara','Zara',2,'global',null),
  ('uniqlo','Uniqlo',2,'global',null),
  ('mango','Mango',2,'global',null),
  ('gap','Gap',2,'global',null),
  ('marksandspencer','Marks & Spencer',2,'uk',null),
  ('nextt','Next',2,'uk',null),
  ('americaneagle','American Eagle',2,'us',null),
  ('levis','Levi''s',2,'global',null),
  ('cos','COS',3,'global',null),
  ('arket','Arket',3,'eu',null),
  ('massimodutti','Massimo Dutti',3,'global',null),
  ('reiss','Reiss',3,'uk',null),
  ('bananarepublic','Banana Republic',3,'us',null),
  ('jcrew','J.Crew',3,'us',null),
  ('sandro','Sandro',3,'eu',null),
  ('maje','Maje',3,'eu',null),
  ('theory','Theory',3,'us',null),
  ('adidas','Adidas',3,'global',null),
  ('nike','Nike',3,'global',null),
  ('newbalance','New Balance',3,'global',null),
  ('acnestudios','Acne Studios',4,'global',null),
  ('apc','A.P.C.',4,'eu',null),
  ('ganni','Ganni',4,'eu',null),
  ('paulsmith','Paul Smith',4,'uk',null),
  ('hugoboss','Hugo Boss',4,'global',null),
  ('ralphlauren','Ralph Lauren',4,'global',null),
  ('maxmara','Max Mara',4,'eu',null),
  ('burberry','Burberry',5,'global',null),
  ('gucci','Gucci',5,'global',null),
  ('prada','Prada',5,'global',null),
  ('saintlaurent','Saint Laurent',5,'global',null),
  ('bottegaveneta','Bottega Veneta',5,'global',null),
  ('hermes','Hermès',5,'global',null),
  ('chanel','Chanel',5,'global',null),
  ('dior','Dior',5,'global',null),
  ('loropiana','Loro Piana',5,'global',null),
  ('brunellocucinelli','Brunello Cucinelli',5,'global',null)
on conflict (brand_key) do update set tier = excluded.tier;

-- Typical spend per tier and role. Deliberately wide: these are the bounds of
-- a suggestion the user can act on, not a price the app charges.
insert into public.price_bands (tier, role, low, high, currency)
select v.tier, v.role::public.garment_role, v.low, v.high, 'USD'
from (values
  (1,'base_top',5,20),    (1,'bottom',10,30),   (1,'full_body',12,35),
  (1,'outerwear',20,55),  (1,'footwear',15,40), (1,'bag',8,25),
  (2,'base_top',15,45),   (2,'bottom',25,70),   (2,'full_body',30,90),
  (2,'outerwear',50,140), (2,'footwear',35,90), (2,'bag',20,60),
  (3,'base_top',40,110),  (3,'bottom',60,160),  (3,'full_body',80,220),
  (3,'outerwear',120,340),(3,'footwear',90,230),(3,'bag',60,190),
  (4,'base_top',100,280), (4,'bottom',150,400), (4,'full_body',200,600),
  (4,'outerwear',300,900),(4,'footwear',200,600),(4,'bag',150,700),
  (5,'base_top',250,900), (5,'bottom',350,1200),(5,'full_body',600,3000),
  (5,'outerwear',900,4000),(5,'footwear',500,1800),(5,'bag',800,6000)
) as v(tier, role, low, high)
on conflict (tier, role, currency) do update
  set low = excluded.low, high = excluded.high;
