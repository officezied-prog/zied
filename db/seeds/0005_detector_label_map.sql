-- =============================================================================
-- SmartStylist seed 0005 — detector vocabulary -> taxonomy
-- Adds the raw class names emitted by the common fashion detection datasets to
-- each category's `synonyms`, so the label mapper resolves them without code.
-- Extending this to a new detector is an INSERT, not a deploy.
--   DeepFashion2 : 13 classes
--   ModaNet      : 13 classes
--   Fashionpedia : selected apparel classes
-- =============================================================================
update public.garment_categories c
   set synonyms = (select array_agg(distinct s) from unnest(c.synonyms || v.extra) s)
  from (values
    -- DeepFashion2
    ('t_shirt',      array['short sleeved shirt','short_sleeved_shirt','short sleeve top','top']),
    ('shirt',        array['long sleeved shirt','long_sleeved_shirt','long sleeve top']),
    ('jacket',       array['short sleeved outwear','short_sleeved_outwear','long sleeved outwear','long_sleeved_outwear','outer','outwear']),
    ('tank',         array['vest','sling','camisole top']),
    ('shorts',       array['shorts']),
    ('trousers',     array['trousers','pants','long pants']),
    ('skirt',        array['skirt']),
    ('dress',        array['short sleeved dress','short_sleeved_dress','long sleeved dress','long_sleeved_dress','vest dress','vest_dress','sling dress','sling_dress']),
    -- ModaNet / Fashionpedia
    ('handbag',      array['bag','bag wallet','purse']),
    ('belt',         array['belt']),
    ('boots',        array['boots']),
    ('sneakers',     array['footwear','shoe','sneaker']),
    ('sunglasses',   array['sunglasses','glasses']),
    ('hat',          array['headwear','headband head covering hair accessory','cap']),
    ('scarf',        array['scarf tie','neckwear','shawl']),
    ('tie',          array['tie','bow']),
    ('socks',        array['sock','tights stockings']),
    ('jumpsuit',     array['jumpsuit','romper']),
    ('cardigan',     array['cardigan']),
    ('sweater',      array['sweater','jumper']),
    ('hoodie',       array['hood','sweatshirt']),
    ('vest',         array['vest gilet','body warmer'])
  ) as v(slug, extra)
 where c.slug = v.slug;
