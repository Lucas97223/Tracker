-- Phase 0.5, step 5: sensitive rates, GL audit coverage, CoA mapping guards.
--
--   member_rates   cost_rate / bill_rate per team member. A separate table —
--                  not columns on profiles as first sketched — because RLS is
--                  row-level: only a dedicated table can make rates readable
--                  by owner/admin ONLY while names stay visible to everyone
--                  (acceptance: rates unreadable by member/contractor). Keyed
--                  to team_members so people without logins can have rates.
--   audit          accounts + journal_entries now audit-logged (recon gap).
--   CoA guard      categories.account_id may only point at an expense/COGS
--                  account of the same org (enables the Photographer-Pay →
--                  COGS remap safely).

-- ---------- member_rates ----------

alter type audit_entity add value if not exists 'member_rate';

create table if not exists public.member_rates (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  team_member_id  uuid not null references public.team_members(id) on delete cascade,
  cost_rate       numeric(10,2) check (cost_rate is null or cost_rate >= 0),
  bill_rate       numeric(10,2) check (bill_rate is null or bill_rate >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (team_member_id)
);
create index if not exists member_rates_org_idx on public.member_rates(org_id);

drop trigger if exists member_rates_updated_at on public.member_rates;
create trigger member_rates_updated_at
  before update on public.member_rates
  for each row execute procedure public.set_updated_at();

-- org always follows the team member.
create or replace function public.set_org_id_from_team_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select tm.org_id into NEW.org_id from public.team_members tm
      where tm.id = NEW.team_member_id;
  end if;
  return NEW;
end $$;

drop trigger if exists member_rates_set_org on public.member_rates;
create trigger member_rates_set_org
  before insert on public.member_rates
  for each row execute procedure public.set_org_id_from_team_member();

alter table public.member_rates enable row level security;

-- Owner/admin only — in BOTH directions. Members, viewers and contractors
-- must never read margin inputs (I6).
drop policy if exists member_rates_admin_only on public.member_rates;
create policy member_rates_admin_only on public.member_rates
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

drop trigger if exists audit_member_rates on public.member_rates;
create trigger audit_member_rates
  after insert or update or delete on public.member_rates
  for each row execute procedure public.log_audit('member_rate');

-- ---------- GL audit coverage ----------

drop trigger if exists audit_accounts on public.accounts;
create trigger audit_accounts
  after insert or update or delete on public.accounts
  for each row execute procedure public.log_audit('account');

drop trigger if exists audit_journal_entries on public.journal_entries;
create trigger audit_journal_entries
  after insert or update or delete on public.journal_entries
  for each row execute procedure public.log_audit('journal_entry');

-- ---------- category → account mapping guard ----------

create or replace function public.validate_category_account()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type account_type;
  v_acct_org uuid;
begin
  if NEW.account_id is null then
    return NEW;
  end if;
  select a.type, a.org_id into v_type, v_acct_org
    from public.accounts a where a.id = NEW.account_id;
  if v_type is null then
    raise exception 'Account % does not exist', NEW.account_id
      using errcode = 'check_violation';
  end if;
  if v_acct_org is distinct from NEW.org_id then
    raise exception 'Category and account belong to different organizations'
      using errcode = 'check_violation';
  end if;
  if v_type not in ('expense', 'cogs') then
    raise exception 'Expense categories must map to an expense or COGS account (got %)', v_type
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

-- Fires AFTER the auto-account/org-fill triggers (alphabetical ordering:
-- categories_auto_account < categories_set_org < categories_validate_account).
drop trigger if exists categories_validate_account on public.categories;
create trigger categories_validate_account
  before insert or update of account_id, org_id on public.categories
  for each row execute procedure public.validate_category_account();

-- ---------- cross-org reference guards ----------

-- RLS stops cross-org READS, but a caller who knows a foreign row's uuid could
-- still point their own rows at it (the FK check runs as table owner). Every
-- cross-table reference must stay inside one org (I6: zero cross-org writes).

create or replace function public.assert_same_org(p_child uuid, p_parent uuid, p_what text)
returns void language plpgsql as $$
begin
  if p_parent is not null and p_child is distinct from p_parent then
    raise exception 'Cross-organization reference rejected: %', p_what
      using errcode = 'check_violation';
  end if;
end $$;

create or replace function public.check_project_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.years where id = NEW.year_id), 'project → year');
  return NEW;
end $$;

drop trigger if exists projects_zz_org_refs on public.projects;
create trigger projects_zz_org_refs
  before insert or update of year_id, org_id on public.projects
  for each row execute procedure public.check_project_org();

create or replace function public.check_expense_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'expense → project');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.categories where id = NEW.category_id), 'expense → category');
  return NEW;
end $$;

drop trigger if exists expenses_zz_org_refs on public.expenses;
create trigger expenses_zz_org_refs
  before insert or update of project_id, category_id, org_id on public.expenses
  for each row execute procedure public.check_expense_org();

create or replace function public.check_project_member_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'membership → project');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.team_members where id = NEW.team_member_id), 'membership → team member');
  return NEW;
end $$;

drop trigger if exists project_members_zz_org_refs on public.project_members;
create trigger project_members_zz_org_refs
  before insert or update of project_id, team_member_id, org_id on public.project_members
  for each row execute procedure public.check_project_member_org();

create or replace function public.check_pay_item_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'pay item → project');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.team_members where id = NEW.team_member_id), 'pay item → team member');
  return NEW;
end $$;

drop trigger if exists pay_items_zz_org_refs on public.pay_items;
create trigger pay_items_zz_org_refs
  before insert or update of project_id, team_member_id, org_id on public.pay_items
  for each row execute procedure public.check_pay_item_org();

create or replace function public.check_journal_entry_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'journal entry → project');
  return NEW;
end $$;

drop trigger if exists journal_entries_zz_org_refs on public.journal_entries;
create trigger journal_entries_zz_org_refs
  before insert or update of project_id, org_id on public.journal_entries
  for each row execute procedure public.check_journal_entry_org();

create or replace function public.check_journal_line_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.journal_entries where id = NEW.journal_entry_id), 'line → entry');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.accounts where id = NEW.account_id), 'line → account');
  return NEW;
end $$;

drop trigger if exists journal_lines_zz_org_refs on public.journal_lines;
create trigger journal_lines_zz_org_refs
  before insert or update of journal_entry_id, account_id, org_id on public.journal_lines
  for each row execute procedure public.check_journal_line_org();
