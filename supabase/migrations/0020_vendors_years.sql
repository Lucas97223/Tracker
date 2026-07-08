-- Phase 1, step 5: vendor registry + 1099 totals, and the years demotion
-- (approved Recon amendment D-D, slid here from Phase 0.5).
--
-- Vendors: payee dedupe for expenses. The expense form's free-text vendor
-- field keeps working — a trigger find-or-creates the vendor row per org and
-- links expenses.vendor_id, so 1099 totals aggregate over a real registry.
--
-- Years demotion: projects.year_id stops being a user choice. Whenever a
-- project has a start_date, its year row is derived (find-or-create per org)
-- from that date. The years table, sidebar tree and YearPage keep working —
-- year is now a derived navigation dimension, not structural input.

-- ---------- vendors ----------

create table if not exists public.vendors (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  is_1099     boolean not null default false,
  email       text,
  phone       text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists vendors_org_name_key on public.vendors(org_id, lower(name));

drop trigger if exists vendors_updated_at on public.vendors;
create trigger vendors_updated_at
  before update on public.vendors
  for each row execute procedure public.set_updated_at();

drop trigger if exists vendors_set_org on public.vendors;
create trigger vendors_set_org
  before insert on public.vendors
  for each row execute procedure public.set_org_id();

alter table public.expenses
  add column if not exists vendor_id uuid references public.vendors(id) on delete set null;
create index if not exists expenses_vendor_idx on public.expenses(vendor_id);

-- Free-text vendor → registry link. Fires before the org-ref guard (aa < zz)
-- and after set_org (aa? 'expenses_aa_vendor' < 'expenses_set_org' — so we
-- resolve org ourselves rather than rely on trigger order).
create or replace function public.link_expense_vendor()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_vendor uuid;
begin
  if NEW.vendor is null or length(trim(NEW.vendor)) = 0 then
    return NEW;
  end if;
  if NEW.vendor_id is not null
     and (TG_OP = 'INSERT' or NEW.vendor is not distinct from OLD.vendor) then
    return NEW;
  end if;

  v_org := coalesce(NEW.org_id,
                    (select org_id from public.projects where id = NEW.project_id),
                    public.default_org_id());
  if v_org is null then
    return NEW;
  end if;

  select id into v_vendor from public.vendors
    where org_id = v_org and lower(name) = lower(trim(NEW.vendor));
  if v_vendor is null then
    insert into public.vendors (org_id, name) values (v_org, trim(NEW.vendor))
    on conflict (org_id, lower(name)) do update set updated_at = now()
    returning id into v_vendor;
  end if;
  NEW.vendor_id := v_vendor;
  return NEW;
end $$;

drop trigger if exists expenses_vendor_link on public.expenses;
create trigger expenses_vendor_link
  before insert or update of vendor on public.expenses
  for each row execute procedure public.link_expense_vendor();

-- Backfill registry from historical free-text vendors.
do $$
begin
  insert into public.vendors (org_id, name)
  select distinct e.org_id, trim(e.vendor)
  from public.expenses e
  where e.vendor is not null and length(trim(e.vendor)) > 0
  on conflict (org_id, lower(name)) do nothing;

  update public.expenses e
  set vendor_id = v.id
  from public.vendors v
  where e.vendor_id is null
    and e.vendor is not null
    and v.org_id = e.org_id
    and lower(v.name) = lower(trim(e.vendor));
end $$;

-- Year-end 1099 totals (per vendor, per calendar year of the expense date).
create or replace view public.v_vendor_1099_totals as
select
  v.org_id,
  v.id                                   as vendor_id,
  v.name                                 as vendor_name,
  v.is_1099,
  extract(year from e.expense_date)::int as tax_year,
  sum(e.amount)::numeric(14,2)           as total_paid,
  count(*)                               as expense_count
from public.vendors v
join public.expenses e on e.vendor_id = v.id
group by v.org_id, v.id, v.name, v.is_1099, extract(year from e.expense_date)
order by tax_year desc, total_paid desc;

alter view public.v_vendor_1099_totals set (security_invoker = true);
grant select on public.v_vendor_1099_totals to authenticated;

-- ---------- RLS + audit ----------

alter table public.vendors enable row level security;

drop policy if exists vendors_select on public.vendors;
create policy vendors_select on public.vendors
  for select using (public.org_can_view_financials(org_id));

drop policy if exists vendors_modify_editor on public.vendors;
create policy vendors_modify_editor on public.vendors
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop trigger if exists audit_vendors on public.vendors;
create trigger audit_vendors
  after insert or update or delete on public.vendors
  for each row execute procedure public.log_audit('vendor');

-- ---------- years demotion ----------

-- Derive year_id from start_date (find-or-create the per-org year row). Runs
-- BEFORE the org-ref guard; resolves org itself for insert-order safety.
create or replace function public.derive_project_year()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_year int;
  v_year_id uuid;
begin
  if NEW.start_date is null then
    return NEW;  -- keep the caller-supplied year_id (legacy create flow)
  end if;
  v_year := extract(year from NEW.start_date)::int;
  v_org := coalesce(NEW.org_id, public.default_org_id());
  if v_org is null then
    return NEW;
  end if;
  NEW.org_id := v_org;

  select id into v_year_id from public.years
    where org_id = v_org and year_value = v_year;
  if v_year_id is null then
    perform pg_advisory_xact_lock(hashtext('year:' || v_org::text || v_year::text));
    select id into v_year_id from public.years
      where org_id = v_org and year_value = v_year;
    if v_year_id is null then
      insert into public.years (year_value, label, org_id, created_by)
      values (v_year, v_year::text, v_org, auth.uid())
      returning id into v_year_id;
    end if;
  end if;
  NEW.year_id := v_year_id;
  return NEW;
end $$;

drop trigger if exists projects_derive_year on public.projects;
create trigger projects_derive_year
  before insert or update of start_date on public.projects
  for each row execute procedure public.derive_project_year();

-- Re-home existing projects whose start_date disagrees with their year bucket
-- (find-or-create the correct year rows first).
do $$
declare
  r record;
begin
  for r in
    select p.id, p.org_id, extract(year from p.start_date)::int as y
    from public.projects p
    join public.years yr on yr.id = p.year_id
    where p.start_date is not null
      and yr.year_value <> extract(year from p.start_date)::int
  loop
    insert into public.years (year_value, label, org_id)
    values (r.y, r.y::text, r.org_id)
    on conflict (org_id, year_value) do nothing;

    update public.projects
    set year_id = (select id from public.years where org_id = r.org_id and year_value = r.y)
    where id = r.id;
  end loop;
end $$;
