-- Aggregation views for fast rollups. Used by the sidebar tree, year & project
-- pages, and the dashboard's unfiltered KPIs. The dashboard's filtered widgets
-- aggregate on the client from a single filtered query so totals always reconcile.

create or replace view public.v_year_rollup as
select
  y.id            as year_id,
  y.year_value,
  y.label,
  coalesce(sum(e.amount), 0)::numeric(14,2)  as total_amount,
  count(distinct p.id)                       as project_count,
  count(e.id)                                as expense_count
from public.years y
left join public.projects p on p.year_id = y.id
left join public.expenses e on e.project_id = p.id
group by y.id, y.year_value, y.label
order by y.year_value desc;

create or replace view public.v_project_rollup as
select
  p.id            as project_id,
  p.year_id,
  p.name,
  p.status,
  coalesce(sum(e.amount), 0)::numeric(14,2)  as total_amount,
  count(e.id)                                as expense_count
from public.projects p
left join public.expenses e on e.project_id = p.id
group by p.id, p.year_id, p.name, p.status;

create or replace view public.v_category_rollup as
select
  c.id            as category_id,
  c.name,
  c.color,
  coalesce(sum(e.amount), 0)::numeric(14,2)  as total_amount,
  count(e.id)                                as expense_count
from public.categories c
left join public.expenses e on e.category_id = c.id
group by c.id, c.name, c.color;

create or replace view public.v_location_rollup as
select
  coalesce(nullif(trim(e.location), ''), nullif(trim(p.location), ''), 'Unspecified') as location,
  sum(e.amount)::numeric(14,2)              as total_amount,
  count(*)                                  as expense_count
from public.expenses e
join public.projects p on p.id = e.project_id
group by 1
order by total_amount desc;

create or replace view public.v_monthly_rollup as
select
  date_trunc('month', e.expense_date)::date  as month,
  sum(e.amount)::numeric(14,2)               as total_amount,
  count(*)                                   as expense_count
from public.expenses e
group by 1
order by 1;

-- Grant select on views to authenticated users (RLS on base tables still applies).
grant select on public.v_year_rollup     to authenticated;
grant select on public.v_project_rollup  to authenticated;
grant select on public.v_category_rollup to authenticated;
grant select on public.v_location_rollup to authenticated;
grant select on public.v_monthly_rollup  to authenticated;
