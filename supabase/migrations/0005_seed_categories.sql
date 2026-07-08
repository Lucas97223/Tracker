-- Default category set. Safe to run repeatedly.

insert into public.categories (name, color, description) values
  ('Travel',            '#3b82f6', 'Flights, trains, intercity travel'),
  ('Transportation',    '#06b6d4', 'Local transit, taxis, rentals, fuel'),
  ('Accommodation',     '#8b5cf6', 'Hotels, lodging, short-term rentals'),
  ('Photographer Pay',  '#ec4899', 'Fees paid to photographers/talent'),
  ('Equipment Rental',  '#f59e0b', 'Cameras, lighting, AV, props'),
  ('Catering',          '#10b981', 'Food and drink during shoots/events'),
  ('Software',          '#a855f7', 'Subscriptions and licenses'),
  ('Marketing',         '#ef4444', 'Ads, paid promotion'),
  ('Misc',              '#64748b', 'Everything else')
on conflict (name) do nothing;
