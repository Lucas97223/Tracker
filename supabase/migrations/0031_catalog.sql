-- Phase 5, step 1: the offer catalog — one source of truth for the lines that
-- appear on proposals, invoices and (Phase 6) money-carrying templates.
-- estimated_cost / estimated_hours per item feed the quote-to-actual loop and
-- the proposal margin guardrail.

do $$ begin
  create type catalog_kind as enum ('service', 'product', 'package');
exception when duplicate_object then null; end $$;

alter type audit_entity add value if not exists 'catalog_item';
alter type audit_entity add value if not exists 'proposal';
alter type audit_entity add value if not exists 'contract';
alter type audit_entity add value if not exists 'booking';

create table if not exists public.catalog_items (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  kind                catalog_kind not null default 'service',
  name                text not null check (length(trim(name)) > 0),
  description         text,
  default_qty         numeric(10,2) not null default 1 check (default_qty > 0),
  unit_price          numeric(14,2) not null default 0 check (unit_price >= 0),
  tax_rate_id         uuid references public.tax_rates(id) on delete set null,
  revenue_account_id  uuid references public.accounts(id),
  estimated_cost      numeric(14,2) check (estimated_cost is null or estimated_cost >= 0),
  estimated_hours     numeric(10,2) check (estimated_hours is null or estimated_hours >= 0),
  is_active           boolean not null default true,
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists catalog_items_org_idx on public.catalog_items(org_id, is_active);

drop trigger if exists catalog_items_updated_at on public.catalog_items;
create trigger catalog_items_updated_at
  before update on public.catalog_items
  for each row execute procedure public.set_updated_at();

drop trigger if exists catalog_items_set_org on public.catalog_items;
create trigger catalog_items_set_org
  before insert on public.catalog_items
  for each row execute procedure public.set_org_id();

create or replace function public.check_catalog_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type account_type;
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.tax_rates where id = NEW.tax_rate_id), 'catalog → tax rate');
  if NEW.revenue_account_id is not null then
    select type into v_type from public.accounts where id = NEW.revenue_account_id;
    perform public.assert_same_org(
      NEW.org_id, (select org_id from public.accounts where id = NEW.revenue_account_id), 'catalog → account');
    if v_type is distinct from 'revenue' then
      raise exception 'Catalog items may only credit revenue accounts' using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists catalog_items_zz_org_refs on public.catalog_items;
create trigger catalog_items_zz_org_refs
  before insert or update of tax_rate_id, revenue_account_id, org_id on public.catalog_items
  for each row execute procedure public.check_catalog_org();

alter table public.catalog_items enable row level security;

drop policy if exists catalog_items_select on public.catalog_items;
create policy catalog_items_select on public.catalog_items
  for select using (public.org_can_view_financials(org_id));
drop policy if exists catalog_items_modify on public.catalog_items;
create policy catalog_items_modify on public.catalog_items
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop trigger if exists audit_catalog_items on public.catalog_items;
create trigger audit_catalog_items
  after insert or update or delete on public.catalog_items
  for each row execute procedure public.log_audit('catalog_item');
