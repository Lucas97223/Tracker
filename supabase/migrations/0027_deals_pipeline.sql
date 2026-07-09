-- Phase 4, step 1: deals + pipeline.
--
-- A deal is FORECAST money (I2): estimated_value lives here and only here —
-- it never posts, never joins a ledger view, and the UI labels it "forecast".
-- Winning a deal flips the contact's lifecycle to client; the money itself
-- still arrives exclusively through invoices → payments (Phase 1 rails).
-- The one-click Win action (proposal → contract → deposit invoice → project)
-- is Phase 5 per the spec; here Won can link a project manually.

do $$ begin
  create type deal_status as enum ('open', 'won', 'lost');
exception when duplicate_object then null; end $$;

alter type audit_entity add value if not exists 'deal';
alter type audit_entity add value if not exists 'pipeline_stage';
alter type audit_entity add value if not exists 'form';

-- ---------- pipeline_stages ----------

create table if not exists public.pipeline_stages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pipeline_stages_org_idx on public.pipeline_stages(org_id, sort_order);

drop trigger if exists pipeline_stages_updated_at on public.pipeline_stages;
create trigger pipeline_stages_updated_at
  before update on public.pipeline_stages
  for each row execute procedure public.set_updated_at();

drop trigger if exists pipeline_stages_set_org on public.pipeline_stages;
create trigger pipeline_stages_set_org
  before insert on public.pipeline_stages
  for each row execute procedure public.set_org_id();

create or replace function public.provision_pipeline(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.pipeline_stages where org_id = p_org) then
    return;
  end if;
  insert into public.pipeline_stages (org_id, name, sort_order) values
    (p_org, 'Lead In',       1),
    (p_org, 'Contacted',     2),
    (p_org, 'Proposal Sent', 3),
    (p_org, 'Booked',        4);
end $$;

-- Existing orgs get the default pipeline; new orgs via handle_new_org.
do $$
declare v uuid;
begin
  for v in select id from public.organizations loop
    perform public.provision_pipeline(v);
  end loop;
end $$;

create or replace function public.handle_new_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    insert into public.org_members (org_id, user_id, role)
    values (NEW.id, auth.uid(), 'owner')
    on conflict do nothing;
    update public.profiles set default_org_id = NEW.id
      where id = auth.uid() and default_org_id is null;
  end if;
  perform public.provision_org(NEW.id);
  perform public.provision_org_extras_0018(NEW.id);
  perform public.provision_pipeline(NEW.id);
  return NEW;
end $$;

-- ---------- deals ----------

create table if not exists public.deals (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  contact_id       uuid not null references public.contacts(id) on delete restrict,
  stage_id         uuid references public.pipeline_stages(id) on delete set null,
  status           deal_status not null default 'open',
  title            text not null check (length(trim(title)) > 0),
  -- FORECAST ONLY (I2): never posted, never summed with actuals.
  estimated_value  numeric(14,2) check (estimated_value is null or estimated_value >= 0),
  expected_date    date,
  project_id       uuid references public.projects(id) on delete set null,
  source           text,
  notes            text,
  won_at           timestamptz,
  lost_at          timestamptz,
  lost_reason      text,
  sort_order       int not null default 0,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists deals_org_idx on public.deals(org_id, status);
create index if not exists deals_contact_idx on public.deals(contact_id);
create index if not exists deals_stage_idx on public.deals(stage_id);

drop trigger if exists deals_updated_at on public.deals;
create trigger deals_updated_at
  before update on public.deals
  for each row execute procedure public.set_updated_at();

drop trigger if exists deals_set_org on public.deals;
create trigger deals_set_org
  before insert on public.deals
  for each row execute procedure public.set_org_id();

-- Status bookkeeping + org guards + lifecycle: winning makes the contact a client.
create or replace function public.deals_bookkeeping()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.contacts where id = NEW.contact_id), 'deal → contact');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.pipeline_stages where id = NEW.stage_id), 'deal → stage');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'deal → project');

  if NEW.stage_id is null and NEW.status = 'open' then
    select id into NEW.stage_id from public.pipeline_stages
      where org_id = NEW.org_id order by sort_order asc limit 1;
  end if;

  if NEW.status = 'won' and (TG_OP = 'INSERT' or OLD.status <> 'won') then
    NEW.won_at := now();
    NEW.lost_at := null;
    update public.contacts set lifecycle = 'client'
      where id = NEW.contact_id and lifecycle = 'lead';
  elsif NEW.status = 'lost' and (TG_OP = 'INSERT' or OLD.status <> 'lost') then
    NEW.lost_at := now();
    NEW.won_at := null;
  elsif NEW.status = 'open' then
    NEW.won_at := null;
    NEW.lost_at := null;
  end if;
  return NEW;
end $$;

drop trigger if exists deals_zz_bookkeeping on public.deals;
create trigger deals_zz_bookkeeping
  before insert or update on public.deals
  for each row execute procedure public.deals_bookkeeping();

-- ---------- RLS ----------

alter table public.pipeline_stages enable row level security;
alter table public.deals           enable row level security;

drop policy if exists pipeline_stages_select on public.pipeline_stages;
create policy pipeline_stages_select on public.pipeline_stages
  for select using (public.org_can_view_financials(org_id));
drop policy if exists pipeline_stages_modify on public.pipeline_stages;
create policy pipeline_stages_modify on public.pipeline_stages
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

drop policy if exists deals_select on public.deals;
create policy deals_select on public.deals
  for select using (public.org_can_view_financials(org_id));
drop policy if exists deals_modify on public.deals;
create policy deals_modify on public.deals
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

-- ---------- audit + realtime ----------

drop trigger if exists audit_deals on public.deals;
create trigger audit_deals
  after insert or update or delete on public.deals
  for each row execute procedure public.log_audit('deal');

drop trigger if exists audit_pipeline_stages on public.pipeline_stages;
create trigger audit_pipeline_stages
  after insert or update or delete on public.pipeline_stages
  for each row execute procedure public.log_audit('pipeline_stage');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.deals;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.pipeline_stages;
    exception when duplicate_object then null; end;
  end if;
end $$;
