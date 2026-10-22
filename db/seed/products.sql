insert into products (name_en, name_lg, name_sw, name_nyn, units) values
  ('Maize',          'Kasooli',              'Mahindi',        'Eshindi',   '{kg,bag,tonne}'),
  ('Beans',          'Ebijanjalo',           'Maharage',       'Ebitooke',  '{kg,bag}'),
  ('Coffee',         'Emmwanyi',             'Kahawa',         'Emwani',    '{kg,bag,tonne}'),
  ('Matooke',        'Matooke',              'Ndizi',          'Matooke',   '{bunch,kg}'),
  ('Cassava',        'Muwogo',               'Muhogo',         'Omuhogo',   '{kg,bag}'),
  ('Rice',           'Omuceere',             'Mchele',         'Omuceere',  '{kg,bag}'),
  ('Groundnuts',     'Binyebwa',             'Karanga',        'Ebinyobwa', '{kg,bag}'),
  ('Sorghum',        'Obuwemba',             'Mtama',          'Omugusha',  '{kg,bag}'),
  ('Millet',         'Obulo',                'Ulezi',          'Eburo',     '{kg,bag}'),
  ('Soya',           'Soya',                 'Soya',           'Soya',      '{kg,bag}'),
  ('Irish potatoes', 'Lumonde',              'Viazi mviringo', 'Ebitookye', '{kg,bag}'),
  ('Sweet potatoes', 'Lumonde lwa kiganda',  'Viazi vitamu',   'Obutuuma',  '{kg,bag}')
on conflict (name_en) do nothing;
