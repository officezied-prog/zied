-- =============================================================================
-- SmartStylist seed 0001 — garment taxonomy
-- Level 1 = supercategory, 2 = category, 3 = subcategory.
-- `synonyms` feed the mapper that turns raw detector labels (DeepFashion2 /
-- ModaNet / open-vocabulary text) into taxonomy ids.
-- =============================================================================

-- Level 1 -------------------------------------------------------------------
insert into public.garment_categories
  (parent_id, slug, display_name, level, default_role, default_formality, default_warmth,
   default_seasons, is_layerable, size_system, synonyms, sort_order)
values
  (null,'tops','Tops',1,'base_top',3,1,'{all_season}',true,'alpha','{top,shirt,blouse}',10),
  (null,'bottoms','Bottoms',1,'bottom',3,2,'{all_season}',false,'waist_inseam','{pants,trousers,bottom}',20),
  (null,'one_pieces','One-pieces',1,'full_body',3,1,'{all_season}',false,'alpha','{dress,jumpsuit,overall}',30),
  (null,'outerwear','Outerwear',1,'outerwear',3,4,'{autumn,winter}',true,'alpha','{coat,jacket,outer}',40),
  (null,'footwear','Footwear',1,'footwear',3,1,'{all_season}',false,'shoe_eu','{shoes,boots,sneakers}',50),
  (null,'bags','Bags',1,'bag',3,0,'{all_season}',false,null,'{bag,purse,backpack}',60),
  (null,'accessories','Accessories',1,'other_accessory',3,0,'{all_season}',false,null,'{accessory}',70);

-- Level 2 -------------------------------------------------------------------
insert into public.garment_categories
  (parent_id, slug, display_name, level, default_role, default_formality, default_warmth,
   default_seasons, is_layerable, size_system, synonyms, sort_order)
select p.id, v.slug, v.name, 2, v.role::public.garment_role, v.formality, v.warmth,
       v.seasons::public.season[], v.layerable, v.size_system, v.synonyms::text[], v.sort_order
from (values
  -- parent,       slug,            display,           role,        form, warm, seasons,                 layer, sizes,          synonyms,                              order
  ('tops','t_shirt','T-shirt','base_top',2,1,'{spring,summer,all_season}',true,'alpha','{tee,tshirt,short sleeve top}',10),
  ('tops','shirt','Shirt','base_top',4,1,'{all_season}',true,'alpha','{button-down,button up,oxford,dress shirt}',20),
  ('tops','blouse','Blouse','base_top',4,1,'{all_season}',true,'alpha','{silk top}',30),
  ('tops','polo','Polo shirt','base_top',3,1,'{spring,summer}',true,'alpha','{polo}',40),
  ('tops','tank','Tank top','base_top',2,0,'{summer}',true,'alpha','{camisole,vest top,sleeveless}',50),
  ('tops','sweater','Sweater','mid_layer',3,3,'{autumn,winter}',true,'alpha','{jumper,pullover,knit}',60),
  ('tops','cardigan','Cardigan','mid_layer',3,3,'{autumn,winter,spring}',true,'alpha','{knit jacket}',70),
  ('tops','hoodie','Hoodie','mid_layer',1,3,'{autumn,winter,spring}',true,'alpha','{sweatshirt,hooded}',80),
  ('tops','bodysuit','Bodysuit','base_top',3,1,'{all_season}',false,'alpha','{body}',90),
  ('bottoms','jeans','Jeans','bottom',2,2,'{all_season}',false,'waist_inseam','{denim pants,denim trousers}',10),
  ('bottoms','trousers','Trousers','bottom',4,2,'{all_season}',false,'waist_inseam','{slacks,dress pants}',20),
  ('bottoms','shorts','Shorts','bottom',2,0,'{summer}',false,'waist_inseam','{short pants}',30),
  ('bottoms','skirt','Skirt','bottom',3,1,'{all_season}',false,'alpha','{midi skirt,mini skirt}',40),
  ('bottoms','leggings','Leggings','bottom',1,2,'{all_season}',false,'alpha','{tights,yoga pants}',50),
  ('bottoms','joggers','Joggers','bottom',1,2,'{all_season}',false,'alpha','{sweatpants,track pants}',60),
  ('one_pieces','dress','Dress','full_body',4,1,'{all_season}',false,'alpha','{gown,frock}',10),
  ('one_pieces','jumpsuit','Jumpsuit','full_body',3,1,'{all_season}',false,'alpha','{romper,playsuit,overall}',20),
  ('one_pieces','suit','Suit','full_body',5,2,'{all_season}',false,'alpha','{two-piece suit,tuxedo}',30),
  ('one_pieces','abaya','Abaya / Kaftan','full_body',4,1,'{all_season}',false,'alpha','{kaftan,jalabiya,thobe}',40),
  ('outerwear','coat','Coat','outerwear',4,5,'{winter}',true,'alpha','{overcoat,wool coat,parka}',10),
  ('outerwear','jacket','Jacket','outerwear',3,3,'{autumn,spring}',true,'alpha','{windbreaker,anorak}',20),
  ('outerwear','blazer','Blazer','outerwear',5,2,'{all_season}',true,'alpha','{sport coat,suit jacket}',30),
  ('outerwear','puffer','Puffer','outerwear',2,5,'{winter}',true,'alpha','{down jacket,padded jacket}',40),
  ('outerwear','trench','Trench coat','outerwear',4,3,'{autumn,spring}',true,'alpha','{raincoat,mac}',50),
  ('outerwear','vest','Gilet / Vest','mid_layer',2,2,'{autumn,spring}',true,'alpha','{bodywarmer,gilet}',60),
  ('footwear','sneakers','Sneakers','footwear',2,1,'{all_season}',false,'shoe_eu','{kicks,plimsolls}',10),
  ('footwear','dress_shoes','Dress shoes','footwear',5,1,'{all_season}',false,'shoe_eu','{oxfords,derby,loafers,brogues}',20),
  ('footwear','heels','Heels','footwear',5,1,'{all_season}',false,'shoe_eu','{pumps,stilettos,high heels}',30),
  ('footwear','boots','Boots','footwear',3,3,'{autumn,winter}',false,'shoe_eu','{bootie}',40),
  ('footwear','sandals','Sandals','footwear',2,0,'{summer}',false,'shoe_eu','{flip flops,slides,birkenstocks}',50),
  ('footwear','flats','Flats','footwear',3,1,'{all_season}',false,'shoe_eu','{ballet flats,espadrilles}',60),
  ('bags','handbag','Handbag','bag',4,0,'{all_season}',false,null,'{purse,shoulder bag,tote}',10),
  ('bags','backpack','Backpack','bag',1,0,'{all_season}',false,null,'{rucksack}',20),
  ('bags','clutch','Clutch','bag',5,0,'{all_season}',false,null,'{evening bag,minaudiere}',30),
  ('bags','crossbody','Crossbody bag','bag',3,0,'{all_season}',false,null,'{sling bag,messenger}',40),
  ('accessories','belt','Belt','belt',3,0,'{all_season}',false,'alpha','{waist belt}',10),
  ('accessories','hat','Hat','headwear',2,1,'{all_season}',false,'alpha','{cap,beanie,fedora,bucket hat}',20),
  ('accessories','hijab','Headscarf / Hijab','headwear',3,1,'{all_season}',false,null,'{scarf headcover,shayla,turban}',25),
  ('accessories','scarf','Scarf','scarf',3,2,'{autumn,winter}',false,null,'{muffler,shawl,pashmina}',30),
  ('accessories','sunglasses','Sunglasses','eyewear',3,0,'{spring,summer}',false,null,'{shades,eyewear}',40),
  ('accessories','watch','Watch','watch',4,0,'{all_season}',false,null,'{wristwatch}',50),
  ('accessories','jewelry','Jewelry','jewelry',4,0,'{all_season}',false,null,'{necklace,earrings,bracelet,ring}',60),
  ('accessories','tie','Tie / Bow tie','other_accessory',5,0,'{all_season}',false,null,'{necktie,bowtie}',70),
  ('accessories','socks','Socks / Hosiery','hosiery',2,1,'{all_season}',false,'alpha','{tights,stockings,socks}',80),
  ('accessories','gloves','Gloves','other_accessory',3,3,'{winter}',false,'alpha','{mittens}',90)
) as v(parent_slug, slug, name, role, formality, warmth, seasons, layerable, size_system, synonyms, sort_order)
join public.garment_categories p on p.slug = v.parent_slug;

-- Level 3 (only where the distinction changes styling behaviour) -------------
insert into public.garment_categories
  (parent_id, slug, display_name, level, default_role, default_formality, default_warmth,
   default_seasons, is_layerable, size_system, synonyms, sort_order)
select p.id, v.slug, v.name, 3, v.role::public.garment_role, v.formality, v.warmth,
       v.seasons::public.season[], v.layerable, p.size_system, v.synonyms::text[], v.sort_order
from (values
  ('dress','cocktail_dress','Cocktail dress','full_body',5,1,'{all_season}',false,'{party dress,evening dress}',10),
  ('dress','maxi_dress','Maxi dress','full_body',3,1,'{spring,summer}',false,'{long dress}',20),
  ('dress','shirt_dress','Shirt dress','full_body',3,1,'{spring,summer,autumn}',false,'{shirtdress}',30),
  ('dress','knit_dress','Knit dress','full_body',3,3,'{autumn,winter}',false,'{sweater dress}',40),
  ('trousers','chinos','Chinos','bottom',3,2,'{all_season}',false,'{khakis,chinos}',10),
  ('trousers','wide_leg','Wide-leg trousers','bottom',4,2,'{all_season}',false,'{palazzo}',20),
  ('trousers','tailored_trousers','Tailored trousers','bottom',5,2,'{all_season}',false,'{suit pants}',30),
  ('boots','ankle_boots','Ankle boots','footwear',4,3,'{autumn,winter}',false,'{booties,chelsea,chelsea boots,ankle boots}',10),
  ('boots','knee_boots','Knee-high boots','footwear',4,4,'{winter}',false,'{tall boots}',20),
  ('boots','combat_boots','Combat boots','footwear',2,3,'{autumn,winter}',false,'{doc martens,lug sole,combat boots}',30),
  ('sneakers','minimal_sneakers','Minimal sneakers','footwear',3,1,'{all_season}',false,'{white sneakers,court shoes}',10),
  ('sneakers','running_shoes','Running shoes','footwear',1,1,'{all_season}',false,'{trainers,athletic shoes,running shoes}',20),
  ('jacket','denim_jacket','Denim jacket','outerwear',2,3,'{spring,autumn}',true,'{jean jacket,trucker jacket}',10),
  ('jacket','leather_jacket','Leather jacket','outerwear',3,3,'{autumn,spring}',true,'{biker jacket,moto jacket}',20),
  ('jacket','bomber','Bomber jacket','outerwear',2,3,'{autumn,spring}',true,'{ma-1,varsity,bomber,bomber jacket}',30),
  ('sweater','turtleneck','Turtleneck','mid_layer',4,3,'{autumn,winter}',true,'{roll neck,polo neck}',10),
  ('jewelry','necklace','Necklace','jewelry',4,0,'{all_season}',false,'{pendant,chain}',10),
  ('jewelry','earrings','Earrings','jewelry',4,0,'{all_season}',false,'{studs,hoops}',20),
  ('jewelry','bracelet','Bracelet','jewelry',4,0,'{all_season}',false,'{bangle,cuff}',30)
) as v(parent_slug, slug, name, role, formality, warmth, seasons, layerable, synonyms, sort_order)
join public.garment_categories p on p.slug = v.parent_slug;
