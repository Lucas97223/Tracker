-- Demo data. Run AFTER you have:
--   1. Run migrations 0001..0005
--   2. Created at least one admin user (first sign-up becomes admin automatically).
--
-- This script is idempotent: running it again will not duplicate years/projects/categories,
-- but it WILL insert additional expense rows. Truncate expenses first if you re-run.

-- Years
insert into public.years (year_value, label) values
  (2024, '2024'),
  (2025, '2025')
on conflict (year_value) do nothing;

-- Projects (uses the first admin as created_by; safe to leave null if none exists)
with admin_user as (
  select id from public.profiles where role = 'admin' order by created_at asc limit 1
), y2024 as (select id from public.years where year_value = 2024),
   y2025 as (select id from public.years where year_value = 2025)
insert into public.projects (year_id, name, description, client, location, status, start_date, end_date, created_by)
select p.year_id, p.name, p.description, p.client, p.location, p.status, p.start_date, p.end_date, (select id from admin_user)
from (values
  ((select id from y2024), 'Acme Brand Refresh',         'Photography & creative for Acme rebrand', 'Acme Co',       'Berlin',       'completed', '2024-03-01'::date, '2024-04-30'::date),
  ((select id from y2024), 'Q4 Product Launch',          'Hero shots and launch event coverage',    'Globex',        'New York',     'completed', '2024-10-01'::date, '2024-12-15'::date),
  ((select id from y2025), 'Spring Campaign',            'Outdoor lifestyle shoots',                'Initech',       'Lisbon',       'active',    '2025-03-15'::date, null),
  ((select id from y2025), 'Trade Show – Photo Wall',    'Booth photo wall & headshots',            'Soylent Corp',  'San Francisco','active',    '2025-05-01'::date, '2025-05-07'::date),
  ((select id from y2025), 'Internal Brand Library',     'Library refresh, multi-location',         null,            null,           'planning',  '2025-06-01'::date, null)
) as p(year_id, name, description, client, location, status, start_date, end_date)
on conflict do nothing;

-- Helper: pseudo-random expenses across categories and dates.
-- Adjust counts as you like; current settings give ~40 line items.
with cats as (
  select id, name from public.categories where is_archived = false
), projs as (
  select id, location from public.projects
), admin_user as (
  select id from public.profiles where role = 'admin' order by created_at asc limit 1
), generated as (
  select
    p.id        as project_id,
    (select id from cats order by random() limit 1) as category_id,
    case (floor(random() * 8))::int
      when 0 then 'Flight to ' || coalesce(p.location, 'venue')
      when 1 then 'Hotel night'
      when 2 then 'Photographer fee - day rate'
      when 3 then 'Camera rental'
      when 4 then 'Catering for crew'
      when 5 then 'Software subscription'
      when 6 then 'Local taxi'
      else        'Misc supplies'
    end || ' #' || generate_series(1, 8)::text as description,
    round((random() * 800 + 50)::numeric, 2) as amount,
    (current_date - (random() * 365)::int) as expense_date,
    p.location,
    (select id from admin_user) as created_by
  from projs p
)
insert into public.expenses (project_id, category_id, description, amount, expense_date, location, created_by)
select project_id, category_id, description, amount, expense_date, location, created_by from generated;
