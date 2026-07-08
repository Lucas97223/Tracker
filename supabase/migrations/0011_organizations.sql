-- Phase 0.5, step 1: multi-tenancy foundations.
--
-- Introduces:
--   - organizations / org_members (roles: owner | admin | member | contractor,
--     plus 'viewer' to map the legacy read-only profiles.role without changing
--     anyone's effective access)
--   - org_id on every existing table, backfilled to a default organization
--   - per-org uniqueness (years.year_value, categories.name, accounts.code,
--     accounting period ranges) replacing the old global uniques
--   - BEFORE INSERT triggers that fill org_id from the caller's default org so
--     the existing app (which doesn't know about orgs yet) keeps working
--   - org-aware profile bootstrap for new signups
--
-- RLS policy rewrites live in 0012 (this file only adds policies for the two
-- new tables). Legacy → org role mapping: first admin → owner, other admins →
-- admin, editor → member, viewer → viewer.

-- ---------- enums ----------

do $$ begin
  create type org_role as enum ('owner', 'admin', 'member', 'contractor', 'viewer');
exception when duplicate_object then null; end $$;

-- New audit entities (used by triggers created in later migrations; adding
-- values is safe here because the casts only happen when triggers fire).
alter type audit_entity add value if not exists 'organization';
alter type audit_entity add value if not exists 'team_member';
alter type audit_entity add value if not exists 'pay_item';
alter type audit_entity add value if not exists 'account';
alter type audit_entity add value if not exists 'journal_entry';

-- ---------- organizations ----------

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists organizations_updated_at on public.organizations;
create trigger organizations_updated_at
  before update on public.organizations
  for each row execute procedure public.set_updated_at();

-- ---------- org_members ----------

create table if not exists public.org_members (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        org_role not null default 'member',
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on public.org_members(user_id);

-- ---------- profiles.default_org_id ----------

alter table public.profiles
  add column if not exists default_org_id uuid references public.organizations(id) on delete set null;

-- ---------- helpers ----------

create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user() and exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.user_id = auth.uid()
  );
$$;

create or replace function public.org_role_of(p_org uuid)
returns org_role language sql stable security definer set search_path = public as $$
  select m.role from public.org_members m
  where m.org_id = p_org and m.user_id = auth.uid();
$$;

-- owner/admin: full control inside the org (legacy 'admin' powers).
create or replace function public.org_is_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user() and public.org_role_of(p_org) in ('owner', 'admin');
$$;

-- owner/admin/member: can create and edit operational data (legacy 'editor').
create or replace function public.org_can_edit(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user() and public.org_role_of(p_org) in ('owner', 'admin', 'member');
$$;

-- Everyone except contractors may read financial data (viewer = read-only).
-- Contractors will get task-scoped, never-financial access in Phase 2 (I6).
create or replace function public.org_can_view_financials(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user()
     and public.org_role_of(p_org) in ('owner', 'admin', 'member', 'viewer');
$$;

-- The caller's org for inserts that don't specify one (single-org users).
create or replace function public.default_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.default_org_id from public.profiles p where p.id = auth.uid()),
    (select m.org_id from public.org_members m
      where m.user_id = auth.uid()
      order by m.created_at asc limit 1)
  );
$$;

-- ---------- default org + membership backfill ----------

do $$
declare
  v_org uuid;
  v_first_admin uuid;
begin
  if not exists (select 1 from public.organizations) then
    insert into public.organizations (name) values ('My Studio') returning id into v_org;

    select id into v_first_admin
      from public.profiles where role = 'admin'
      order by created_at asc limit 1;

    insert into public.org_members (org_id, user_id, role)
    select
      v_org,
      p.id,
      case
        when p.id = v_first_admin then 'owner'::org_role
        when p.role = 'admin'     then 'admin'::org_role
        when p.role = 'editor'    then 'member'::org_role
        else 'viewer'::org_role
      end
    from public.profiles p
    on conflict do nothing;

    update public.profiles set default_org_id = v_org where default_org_id is null;
  end if;
end $$;

-- ---------- org_id on every existing table ----------

-- Stamping org_id onto EXISTING ledger rows is a structural migration, not a
-- financial correction — but the immutability triggers can't know that (they
-- block every UPDATE on lines of posted entries). Disable exactly those two
-- for the duration of the backfill. Amounts, accounts and dates are untouched.
alter table public.journal_lines  disable trigger journal_lines_immutable;
alter table public.journal_entries disable trigger journal_entries_immutable;

-- The balance check is a DEFERRED constraint trigger; the org_id UPDATE below
-- would queue its events until commit, and ALTER TABLE (SET NOT NULL, ENABLE
-- TRIGGER) cannot run with events pending. Make it fire per-statement for the
-- rest of this transaction — the updates never touch amounts, so it passes.
set constraints journal_lines_balance immediate;

do $$
declare
  v_org uuid;
  t text;
begin
  select id into v_org from public.organizations order by created_at asc limit 1;

  foreach t in array array[
    'years', 'projects', 'categories', 'expenses',
    'accounts', 'journal_entries', 'journal_lines',
    'accounting_periods', 'expense_journal_map'
  ] loop
    execute format(
      'alter table public.%I add column if not exists org_id uuid references public.organizations(id)', t);
    execute format('update public.%I set org_id = %L where org_id is null', t, v_org);
    execute format('alter table public.%I alter column org_id set not null', t);
    execute format('create index if not exists %I on public.%I(org_id)', t || '_org_idx', t);
  end loop;

  -- audit_log: org_id stays NULLABLE. Audit rows are written by security-definer
  -- triggers, sometimes with no user context at all (e.g. the auth signup chain
  -- updating profiles); a hard org requirement there would abort the audited
  -- operation itself. log_audit() stamps org_id explicitly (0012).
  alter table public.audit_log add column if not exists org_id uuid references public.organizations(id);
  execute format('update public.audit_log set org_id = %L where org_id is null', v_org);
  create index if not exists audit_log_org_idx on public.audit_log(org_id);
end $$;

alter table public.journal_lines  enable trigger journal_lines_immutable;
alter table public.journal_entries enable trigger journal_entries_immutable;
-- (project_members intentionally omitted: it is rebuilt as the staffing table
-- in 0013 and receives org_id there.)

-- ---------- per-org uniqueness (replacing global uniques) ----------

alter table public.years drop constraint if exists years_year_value_key;
create unique index if not exists years_org_year_key on public.years(org_id, year_value);

alter table public.categories drop constraint if exists categories_name_key;
create unique index if not exists categories_org_name_key on public.categories(org_id, name);

alter table public.accounts drop constraint if exists accounts_code_key;
create unique index if not exists accounts_org_code_key on public.accounts(org_id, code);

drop index if exists periods_range_idx;
create unique index if not exists periods_org_range_idx
  on public.accounting_periods(org_id, start_date, end_date);

-- ---------- org_id auto-fill triggers ----------

-- Fill from the caller's default org (keeps the org-unaware app working).
create or replace function public.set_org_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    NEW.org_id := public.default_org_id();
  end if;
  if NEW.org_id is null then
    raise exception 'No organization context for insert into %', TG_TABLE_NAME
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

-- Children inherit the parent's org regardless of caller context.
create or replace function public.set_org_id_from_journal_entry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select je.org_id into NEW.org_id from public.journal_entries je
      where je.id = NEW.journal_entry_id;
  end if;
  return NEW;
end $$;

create or replace function public.set_org_id_from_expense()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select e.org_id into NEW.org_id from public.expenses e
      where e.id = NEW.expense_id;
  end if;
  return NEW;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'years', 'projects', 'categories', 'expenses',
    'accounts', 'journal_entries', 'accounting_periods'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_org', t);
    execute format(
      'create trigger %I before insert on public.%I for each row execute procedure public.set_org_id()',
      t || '_set_org', t);
  end loop;
end $$;

drop trigger if exists journal_lines_set_org on public.journal_lines;
create trigger journal_lines_set_org
  before insert on public.journal_lines
  for each row execute procedure public.set_org_id_from_journal_entry();

drop trigger if exists ejm_set_org on public.expense_journal_map;
create trigger ejm_set_org
  before insert on public.expense_journal_map
  for each row execute procedure public.set_org_id_from_expense();

-- ---------- RLS for the new tables ----------

alter table public.organizations enable row level security;
alter table public.org_members   enable row level security;

drop policy if exists orgs_select_member on public.organizations;
create policy orgs_select_member on public.organizations
  for select using (public.is_org_member(id));

drop policy if exists orgs_update_admin on public.organizations;
create policy orgs_update_admin on public.organizations
  for update using (public.org_is_admin(id)) with check (public.org_is_admin(id));

-- Any active user may create an org; a trigger (0012) makes them its owner.
drop policy if exists orgs_insert_active on public.organizations;
create policy orgs_insert_active on public.organizations
  for insert with check (public.is_active_user());

drop policy if exists orgs_delete_owner on public.organizations;
create policy orgs_delete_owner on public.organizations
  for delete using (public.is_active_user() and public.org_role_of(id) = 'owner');

drop policy if exists org_members_select on public.org_members;
create policy org_members_select on public.org_members
  for select using (public.is_org_member(org_id));

drop policy if exists org_members_modify_admin on public.org_members;
create policy org_members_modify_admin on public.org_members
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

-- ---------- org-aware profile bootstrap ----------

-- Same invite-only behaviour as before; additionally, while exactly one org
-- exists (the common single-studio case), new signups join it as inactive
-- viewers so that an admin flipping is_active is still the only step needed.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  user_count int;
  initial_role role := 'viewer';
  initial_active boolean := false;
  v_org uuid;
  v_org_count int;
begin
  select count(*) into user_count from public.profiles;
  if user_count = 0 then
    initial_role := 'admin';
    initial_active := true;
  end if;

  insert into public.profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    initial_role,
    initial_active
  );

  select count(*) into v_org_count from public.organizations;
  if v_org_count = 1 then
    select id into v_org from public.organizations limit 1;
    insert into public.org_members (org_id, user_id, role)
    values (v_org, new.id, case when initial_role = 'admin' then 'owner'::org_role else 'viewer'::org_role end)
    on conflict do nothing;
    update public.profiles set default_org_id = v_org where id = new.id;
  end if;

  return new;
end $$;
