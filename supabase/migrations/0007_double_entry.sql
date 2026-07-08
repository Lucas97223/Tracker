-- Milestone 12, Phase 12a: Double-entry general-ledger engine.
--
-- This migration introduces a proper accounting backbone:
--   - accounts                (the Chart of Accounts)
--   - journal_entries         (atomic accounting events)
--   - journal_lines           (the debits and credits per entry)
--   - accounting_periods      (fiscal periods for closing)
--   - expense_journal_map     (links existing expenses to their journal entries)
--
-- All double-entry invariants are enforced in the database:
--   * sum(debit) = sum(credit) for every journal entry (deferred constraint trigger)
--   * each line is either a debit or a credit, never both, never neither
--   * posted entries are immutable (only reversed_by may be set)
--
-- 0008_backfill_journal.sql migrates existing expense rows into journal entries
-- and turns on auto-sync triggers so the existing UI keeps working unchanged.

-- ---------- enums ----------

do $$ begin
  create type account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense', 'cogs');
exception when duplicate_object then null; end $$;

do $$ begin
  create type balance_side as enum ('debit', 'credit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type period_status as enum ('open', 'closed', 'locked');
exception when duplicate_object then null; end $$;

-- ---------- accounts ----------

create table if not exists public.accounts (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name            text not null,
  type            account_type not null,
  normal_balance  balance_side not null,
  parent_id       uuid references public.accounts(id),
  currency        text not null default 'USD',
  is_active       boolean not null default true,
  is_system       boolean not null default false,   -- e.g. Retained Earnings: can't be deleted
  description     text,
  created_at      timestamptz not null default now()
);
create index if not exists accounts_parent_idx on public.accounts(parent_id);
create index if not exists accounts_type_idx on public.accounts(type);

-- ---------- accounting_periods ----------

create table if not exists public.accounting_periods (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  start_date  date not null,
  end_date    date not null,
  status      period_status not null default 'open',
  closed_at   timestamptz,
  closed_by   uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  check (end_date >= start_date)
);
create unique index if not exists periods_range_idx on public.accounting_periods(start_date, end_date);

-- ---------- journal_entries ----------

create table if not exists public.journal_entries (
  id            uuid primary key default gen_random_uuid(),
  entry_date    date not null,
  reference     text,
  memo          text,
  source_type   text not null default 'manual',     -- manual | expense | invoice | bill | payment | adjustment | reversal
  source_id     uuid,                                -- nullable FK to originating row (no DB FK, polymorphic)
  project_id    uuid references public.projects(id) on delete set null,
  period_id     uuid references public.accounting_periods(id) on delete set null,
  posted        boolean not null default true,
  reversed_by   uuid references public.journal_entries(id) on delete set null,
  created_by    uuid references public.profiles(id) on delete set null,
  posted_at     timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists je_date_idx on public.journal_entries(entry_date desc);
create index if not exists je_source_idx on public.journal_entries(source_type, source_id);
create index if not exists je_project_idx on public.journal_entries(project_id);
create index if not exists je_period_idx on public.journal_entries(period_id);

-- ---------- journal_lines ----------

create table if not exists public.journal_lines (
  id                uuid primary key default gen_random_uuid(),
  journal_entry_id  uuid not null references public.journal_entries(id) on delete cascade,
  account_id        uuid not null references public.accounts(id),
  description       text,
  debit             numeric(14,2) not null default 0,
  credit            numeric(14,2) not null default 0,
  project_id        uuid references public.projects(id) on delete set null,
  category_id       uuid references public.categories(id) on delete set null,
  line_number       int not null default 1,
  check (debit >= 0 and credit >= 0),
  check (not (debit > 0 and credit > 0)),           -- never both
  check (debit > 0 or credit > 0)                   -- never neither
);
create index if not exists jl_entry_idx on public.journal_lines(journal_entry_id);
create index if not exists jl_account_idx on public.journal_lines(account_id);
create index if not exists jl_project_idx on public.journal_lines(project_id);

-- ---------- balance invariant: sum(debit) = sum(credit) per entry ----------

create or replace function public.check_journal_balance()
returns trigger language plpgsql as $$
declare
  je_id  uuid;
  d_sum  numeric(14,2);
  c_sum  numeric(14,2);
begin
  je_id := coalesce(new.journal_entry_id, old.journal_entry_id);
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into d_sum, c_sum
    from public.journal_lines
    where journal_entry_id = je_id;
  if d_sum <> c_sum then
    raise exception 'Journal entry % is unbalanced: debits=% credits=%', je_id, d_sum, c_sum
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

drop trigger if exists journal_lines_balance on public.journal_lines;
create constraint trigger journal_lines_balance
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute procedure public.check_journal_balance();

-- ---------- immutability: posted entries can only have reversed_by updated ----------

create or replace function public.enforce_journal_immutability()
returns trigger language plpgsql as $$
begin
  if OLD.posted = true then
    -- Allow only reversed_by to change on posted entries.
    if NEW.entry_date is distinct from OLD.entry_date
       or NEW.reference is distinct from OLD.reference
       or NEW.memo is distinct from OLD.memo
       or NEW.source_type is distinct from OLD.source_type
       or NEW.source_id is distinct from OLD.source_id
       or NEW.project_id is distinct from OLD.project_id
       or NEW.posted is distinct from OLD.posted
       or NEW.created_by is distinct from OLD.created_by then
      raise exception 'Posted journal entry % is immutable; create a reversal instead', OLD.id
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists journal_entries_immutable on public.journal_entries;
create trigger journal_entries_immutable
  before update on public.journal_entries
  for each row execute procedure public.enforce_journal_immutability();

-- Disallow updating journal_lines that belong to a posted entry.
create or replace function public.enforce_journal_lines_immutability()
returns trigger language plpgsql as $$
declare
  is_posted boolean;
begin
  select posted into is_posted from public.journal_entries
    where id = coalesce(NEW.journal_entry_id, OLD.journal_entry_id);
  if is_posted then
    raise exception 'Cannot modify lines of a posted journal entry; create a reversal entry instead'
      using errcode = 'check_violation';
  end if;
  return coalesce(NEW, OLD);
end $$;

drop trigger if exists journal_lines_immutable on public.journal_lines;
create trigger journal_lines_immutable
  before update or delete on public.journal_lines
  for each row execute procedure public.enforce_journal_lines_immutability();

-- ---------- categories.account_id link ----------

alter table public.categories
  add column if not exists account_id uuid references public.accounts(id) on delete set null;

-- ---------- expense ↔ journal mapping table ----------

create table if not exists public.expense_journal_map (
  expense_id        uuid primary key references public.expenses(id) on delete cascade,
  journal_entry_id  uuid not null references public.journal_entries(id) on delete restrict,
  created_at        timestamptz not null default now()
);

-- ---------- RLS ----------

alter table public.accounts            enable row level security;
alter table public.journal_entries     enable row level security;
alter table public.journal_lines       enable row level security;
alter table public.accounting_periods  enable row level security;
alter table public.expense_journal_map enable row level security;

-- accounts: viewable by any active user; mutated by admin only.
drop policy if exists accounts_select_active on public.accounts;
create policy accounts_select_active on public.accounts
  for select using (public.is_active_user());

drop policy if exists accounts_modify_admin on public.accounts;
create policy accounts_modify_admin on public.accounts
  for all using (public.is_admin()) with check (public.is_admin());

-- journal_entries: viewable by active users; insert/update by editor; delete by admin.
drop policy if exists je_select_active on public.journal_entries;
create policy je_select_active on public.journal_entries
  for select using (public.is_active_user());

drop policy if exists je_insert_editor on public.journal_entries;
create policy je_insert_editor on public.journal_entries
  for insert with check (public.can_edit());

drop policy if exists je_update_editor on public.journal_entries;
create policy je_update_editor on public.journal_entries
  for update using (public.can_edit()) with check (public.can_edit());

drop policy if exists je_delete_admin on public.journal_entries;
create policy je_delete_admin on public.journal_entries
  for delete using (public.is_admin());

-- journal_lines: same shape as journal_entries.
drop policy if exists jl_select_active on public.journal_lines;
create policy jl_select_active on public.journal_lines
  for select using (public.is_active_user());

drop policy if exists jl_insert_editor on public.journal_lines;
create policy jl_insert_editor on public.journal_lines
  for insert with check (public.can_edit());

drop policy if exists jl_update_admin on public.journal_lines;
create policy jl_update_admin on public.journal_lines
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists jl_delete_admin on public.journal_lines;
create policy jl_delete_admin on public.journal_lines
  for delete using (public.is_admin());

-- accounting_periods: viewable by active; modified by admin.
drop policy if exists periods_select_active on public.accounting_periods;
create policy periods_select_active on public.accounting_periods
  for select using (public.is_active_user());

drop policy if exists periods_modify_admin on public.accounting_periods;
create policy periods_modify_admin on public.accounting_periods
  for all using (public.is_admin()) with check (public.is_admin());

-- expense_journal_map: viewable by active; insert by editor (triggers); update/delete by admin.
drop policy if exists ejm_select_active on public.expense_journal_map;
create policy ejm_select_active on public.expense_journal_map
  for select using (public.is_active_user());

drop policy if exists ejm_insert_editor on public.expense_journal_map;
create policy ejm_insert_editor on public.expense_journal_map
  for insert with check (public.can_edit());

drop policy if exists ejm_modify_admin on public.expense_journal_map;
create policy ejm_modify_admin on public.expense_journal_map
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists ejm_delete_admin on public.expense_journal_map;
create policy ejm_delete_admin on public.expense_journal_map
  for delete using (public.is_admin());

-- ---------- seed: default Chart of Accounts ----------

insert into public.accounts (code, name, type, normal_balance, is_system, description) values
  -- Assets
  ('1000', 'Cash',                       'asset',     'debit',  true,  'Operating cash account; default credit-side for cash-basis expenses'),
  ('1100', 'Accounts Receivable',        'asset',     'debit',  true,  'Amounts owed to us by customers'),
  ('1200', 'Inventory',                  'asset',     'debit',  false, 'Goods held for sale'),
  ('1500', 'Fixed Assets',               'asset',     'debit',  false, 'Equipment, furniture, vehicles'),
  -- Liabilities
  ('2000', 'Accounts Payable',           'liability', 'credit', true,  'Amounts we owe to vendors'),
  ('2100', 'Accrued Liabilities',        'liability', 'credit', false, 'Expenses incurred but not yet paid'),
  ('2200', 'Sales Tax Payable',          'liability', 'credit', false, 'Sales tax collected pending remittance'),
  -- Equity
  ('3000', 'Owner''s Equity',            'equity',    'credit', true,  'Contributed capital'),
  ('3100', 'Retained Earnings',          'equity',    'credit', true,  'Cumulative net income retained in the business'),
  -- Revenue
  ('4000', 'Sales Revenue',              'revenue',   'credit', false, 'Income from product sales'),
  ('4100', 'Service Revenue',            'revenue',   'credit', false, 'Income from services rendered'),
  ('4900', 'Other Income',               'revenue',   'credit', false, 'Miscellaneous income'),
  -- COGS
  ('5000', 'Cost of Goods Sold',         'cogs',      'debit',  false, 'Direct costs of goods sold'),
  -- Expenses (parent)
  ('6000', 'Operating Expenses',         'expense',   'debit',  true,  'Parent account for category-level expense accounts'),
  ('7000', 'Payroll Expense',            'expense',   'debit',  false, 'Wages, salaries, payroll taxes'),
  ('8000', 'Other Expenses',             'expense',   'debit',  false, 'Miscellaneous expenses'),
  ('9000', 'Depreciation & Amortization','expense',   'debit',  false, 'Non-cash periodic charges')
on conflict (code) do nothing;

-- Mark 1200, 1500, 5000 inactive by default — most users won't need them on day one.
update public.accounts set is_active = false where code in ('1200', '1500', '5000');

-- ---------- views ----------

-- v_trial_balance: every account with total debits, total credits, and signed balance.
create or replace view public.v_trial_balance as
select
  a.id            as account_id,
  a.code,
  a.name,
  a.type,
  a.normal_balance,
  coalesce(sum(jl.debit), 0)::numeric(14,2)  as total_debit,
  coalesce(sum(jl.credit), 0)::numeric(14,2) as total_credit,
  case a.normal_balance
    when 'debit'  then coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0)
    when 'credit' then coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0)
  end::numeric(14,2) as balance
from public.accounts a
left join public.journal_lines jl on jl.account_id = a.id
left join public.journal_entries je on je.id = jl.journal_entry_id and je.posted = true
group by a.id, a.code, a.name, a.type, a.normal_balance;

-- v_account_ledger: every posted line per account, with a running balance.
create or replace view public.v_account_ledger as
select
  jl.id                as line_id,
  jl.account_id,
  a.code               as account_code,
  a.name               as account_name,
  a.normal_balance,
  je.id                as entry_id,
  je.entry_date,
  je.reference,
  je.memo,
  je.source_type,
  je.source_id,
  je.project_id,
  jl.description,
  jl.debit,
  jl.credit,
  case a.normal_balance
    when 'debit'  then sum(jl.debit - jl.credit) over (
                         partition by jl.account_id
                         order by je.entry_date, je.id, jl.line_number
                         rows between unbounded preceding and current row)
    when 'credit' then sum(jl.credit - jl.debit) over (
                         partition by jl.account_id
                         order by je.entry_date, je.id, jl.line_number
                         rows between unbounded preceding and current row)
  end::numeric(14,2) as running_balance,
  jl.line_number
from public.journal_lines jl
join public.journal_entries je on je.id = jl.journal_entry_id
join public.accounts a on a.id = jl.account_id
where je.posted = true;

-- v_project_pnl: revenue, expense, COGS, net margin per project.
create or replace view public.v_project_pnl as
select
  p.id                                                      as project_id,
  p.name                                                    as project_name,
  p.year_id,
  coalesce(sum(case when a.type = 'revenue' then jl.credit - jl.debit else 0 end), 0)::numeric(14,2) as revenue,
  coalesce(sum(case when a.type = 'cogs'    then jl.debit  - jl.credit else 0 end), 0)::numeric(14,2) as cogs,
  coalesce(sum(case when a.type = 'expense' then jl.debit  - jl.credit else 0 end), 0)::numeric(14,2) as expense,
  coalesce(sum(case when a.type = 'revenue' then jl.credit - jl.debit
                    when a.type in ('expense','cogs') then -(jl.debit - jl.credit)
                    else 0 end), 0)::numeric(14,2) as net_margin
from public.projects p
left join public.journal_lines jl on jl.project_id = p.id
left join public.journal_entries je on je.id = jl.journal_entry_id and je.posted = true
left join public.accounts a on a.id = jl.account_id
group by p.id, p.name, p.year_id;

grant select on public.v_trial_balance to authenticated;
grant select on public.v_account_ledger to authenticated;
grant select on public.v_project_pnl   to authenticated;

-- ---------- auto-create expense account when a new category is added ----------

create or replace function public.create_account_for_category()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  parent_id   uuid;
  next_code   text;
  last_code   int;
begin
  if NEW.account_id is not null then
    return NEW;
  end if;
  select id into parent_id from public.accounts where code = '6000' limit 1;
  select coalesce(max((code)::int), 6099) + 1
    into last_code
    from public.accounts
    where parent_id = parent_id and code ~ '^[0-9]+$';
  next_code := last_code::text;
  insert into public.accounts (code, name, type, normal_balance, parent_id, is_active, description)
  values (next_code, NEW.name, 'expense', 'debit', parent_id, not NEW.is_archived, NEW.description)
  returning id into NEW.account_id;
  return NEW;
end $$;

drop trigger if exists categories_auto_account on public.categories;
create trigger categories_auto_account
  before insert on public.categories
  for each row execute procedure public.create_account_for_category();
