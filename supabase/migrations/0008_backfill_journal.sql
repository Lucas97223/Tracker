-- Milestone 12, Phase 12a: Backfill existing expenses into journal entries,
-- then install triggers so future expense INSERT/UPDATE/DELETE keep the
-- general ledger in sync automatically. Idempotent — safe to re-run.
--
-- Strategy:
--   1. Create one expense account per existing category (under 6000).
--      Categories then point at their account via categories.account_id.
--   2. For each unmapped expense row, create a journal entry + 2 lines
--      (Dr: category's expense account, Cr: Cash). Record in expense_journal_map.
--   3. Install triggers on `expenses` so future INSERT/UPDATE/DELETE generate
--      the corresponding ledger activity (creates, reversals).

-- ---------- Step 1: create one expense account per existing category ----------

-- Generate codes 6100, 6101, 6102, … under 6000 for categories that lack one.
with parent as (
  select id from public.accounts where code = '6000' limit 1
),
to_create as (
  select
    c.id           as category_id,
    c.name,
    c.description,
    c.is_archived,
    -- Numeric code allocated in deterministic name order; start at 6100, skip
    -- any codes that already exist under the 6xxx range.
    (select coalesce(max((code)::int), 6099)
       from public.accounts
       where code ~ '^61[0-9]{2}$')
      + row_number() over (order by c.name) as code_int
  from public.categories c
  where c.account_id is null
)
insert into public.accounts (code, name, type, normal_balance, parent_id, is_active, description)
select
  code_int::text,
  name,
  'expense'::account_type,
  'debit'::balance_side,
  (select id from parent),
  not is_archived,
  description
from to_create;

-- Now link each category to its newly created account (matched by name + parent).
update public.categories c
set account_id = a.id
from public.accounts a
where c.account_id is null
  and a.parent_id = (select id from public.accounts where code = '6000')
  and a.name = c.name;

-- ---------- Step 2: backfill journal entries + lines for existing expenses ----------

-- 2a. Create journal entries for expenses that have no mapping yet.
with new_entries as (
  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at)
  select
    e.expense_date,
    e.description,
    'expense',
    e.id,
    e.project_id,
    e.created_by,
    true,
    coalesce(e.created_at, now())
  from public.expenses e
  left join public.expense_journal_map m on m.expense_id = e.id
  where m.expense_id is null
  returning id, source_id
)
insert into public.expense_journal_map (expense_id, journal_entry_id)
select source_id, id from new_entries;

-- 2b. Create the debit line (expense account) for each backfilled entry.
insert into public.journal_lines
  (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number)
select
  m.journal_entry_id,
  c.account_id,
  e.amount,
  0,
  e.description,
  e.project_id,
  e.category_id,
  1
from public.expense_journal_map m
join public.expenses e on e.id = m.expense_id
join public.categories c on c.id = e.category_id
left join public.journal_lines jl
  on jl.journal_entry_id = m.journal_entry_id and jl.line_number = 1
where jl.id is null;

-- 2c. Create the credit line (Cash) for each backfilled entry.
insert into public.journal_lines
  (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number)
select
  m.journal_entry_id,
  (select id from public.accounts where code = '1000'),
  0,
  e.amount,
  e.description,
  e.project_id,
  e.category_id,
  2
from public.expense_journal_map m
join public.expenses e on e.id = m.expense_id
left join public.journal_lines jl
  on jl.journal_entry_id = m.journal_entry_id and jl.line_number = 2
where jl.id is null;

-- ---------- Step 3: sanity check — trial balance must sum to 0 ----------

do $$
declare
  net numeric(14,2);
begin
  select coalesce(sum(
    case normal_balance
      when 'debit'  then total_debit  - total_credit
      when 'credit' then total_credit - total_debit
    end
  ), 0)
  into net
  from public.v_trial_balance;
  -- For cash-basis expenses (Dr expense / Cr cash), each entry contributes
  -- +amount to expense (debit side) and -amount to cash (a debit-normal asset
  -- with credit balance). Sum of all signed balances:
  --   (revenue + equity + liability) - (asset + expense + cogs)
  -- which is 0 only at a clean starting point. After expenses, equity drops
  -- by total expenses (closing entries do this end-of-year); we don't post
  -- closing entries here. So we just verify Dr = Cr across all lines.
  if (select coalesce(sum(debit), 0) from public.journal_lines) <>
     (select coalesce(sum(credit), 0) from public.journal_lines) then
    raise exception 'Backfill produced unbalanced ledger: total debits != total credits';
  end if;
  raise notice 'Backfill complete. Trial-balance signed net: %', net;
end $$;

-- ---------- Step 4: live-sync triggers so expense CRUD keeps the GL fresh ----------

-- INSERT: create journal entry + 2 lines.
create or replace function public.expense_insert_to_journal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cash_id              uuid;
  expense_account_id   uuid;
  je_id                uuid;
begin
  select id into cash_id from public.accounts where code = '1000' limit 1;
  if cash_id is null then
    raise exception 'Cash account (1000) is missing. Migration 0007 must be run first.';
  end if;

  select account_id into expense_account_id
    from public.categories where id = NEW.category_id;
  if expense_account_id is null then
    raise exception 'Category % has no linked account. Run migration 0008 to backfill.', NEW.category_id;
  end if;

  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at)
  values
    (NEW.expense_date, NEW.description, 'expense', NEW.id, NEW.project_id, NEW.created_by, true, now())
  returning id into je_id;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number)
  values
    (je_id, expense_account_id, NEW.amount, 0, NEW.description, NEW.project_id, NEW.category_id, 1),
    (je_id, cash_id,             0, NEW.amount, NEW.description, NEW.project_id, NEW.category_id, 2);

  insert into public.expense_journal_map (expense_id, journal_entry_id)
  values (NEW.id, je_id);

  return NEW;
end $$;

drop trigger if exists expenses_to_journal_insert on public.expenses;
create trigger expenses_to_journal_insert
  after insert on public.expenses
  for each row execute procedure public.expense_insert_to_journal();

-- UPDATE: reverse the old entry, post a new one. Skip if nothing financially relevant changed.
create or replace function public.expense_update_to_journal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_je_id            uuid;
  rev_je_id            uuid;
  new_je_id            uuid;
  cash_id              uuid;
  old_expense_acct     uuid;
  new_expense_acct     uuid;
begin
  -- Only resync if amount / date / category / project / description changed.
  if NEW.amount = OLD.amount
     and NEW.expense_date = OLD.expense_date
     and NEW.category_id = OLD.category_id
     and NEW.project_id is not distinct from OLD.project_id
     and NEW.description = OLD.description then
    return NEW;
  end if;

  select id into cash_id from public.accounts where code = '1000' limit 1;
  select account_id into old_expense_acct from public.categories where id = OLD.category_id;
  select account_id into new_expense_acct from public.categories where id = NEW.category_id;
  select journal_entry_id into old_je_id from public.expense_journal_map where expense_id = NEW.id;

  -- Reverse the old entry.
  if old_je_id is not null then
    insert into public.journal_entries
      (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at)
    values
      (current_date, 'Reversal of edited expense', 'reversal', NEW.id, OLD.project_id,
       NEW.created_by, true, now())
    returning id into rev_je_id;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number)
    values
      (rev_je_id, cash_id,          OLD.amount, 0, 'Reversal', OLD.project_id, OLD.category_id, 1),
      (rev_je_id, old_expense_acct, 0, OLD.amount, 'Reversal', OLD.project_id, OLD.category_id, 2);

    -- We can't UPDATE the posted original directly (immutability trigger), so
    -- we use a temporary bypass: only the reversed_by column may change post-posting.
    update public.journal_entries set reversed_by = rev_je_id where id = old_je_id;
  end if;

  -- Post the new entry.
  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at)
  values
    (NEW.expense_date, NEW.description, 'expense', NEW.id, NEW.project_id,
     NEW.created_by, true, now())
  returning id into new_je_id;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number)
  values
    (new_je_id, new_expense_acct, NEW.amount, 0, NEW.description, NEW.project_id, NEW.category_id, 1),
    (new_je_id, cash_id,          0, NEW.amount, NEW.description, NEW.project_id, NEW.category_id, 2);

  update public.expense_journal_map
    set journal_entry_id = new_je_id, created_at = now()
    where expense_id = NEW.id;

  return NEW;
end $$;

drop trigger if exists expenses_to_journal_update on public.expenses;
create trigger expenses_to_journal_update
  after update on public.expenses
  for each row execute procedure public.expense_update_to_journal();

-- DELETE: post a reversal of the live entry. Don't delete the journal entry —
-- the audit trail must persist. The expense row itself goes away normally.
create or replace function public.expense_delete_to_journal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_je_id          uuid;
  rev_je_id          uuid;
  cash_id            uuid;
  old_expense_acct   uuid;
begin
  select journal_entry_id into old_je_id from public.expense_journal_map where expense_id = OLD.id;
  if old_je_id is null then return OLD; end if;

  select id into cash_id from public.accounts where code = '1000' limit 1;
  select account_id into old_expense_acct from public.categories where id = OLD.category_id;

  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at)
  values
    (current_date, 'Reversal of deleted expense', 'reversal', OLD.id, OLD.project_id,
     OLD.created_by, true, now())
  returning id into rev_je_id;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number)
  values
    (rev_je_id, cash_id,          OLD.amount, 0, 'Reversal of delete', OLD.project_id, OLD.category_id, 1),
    (rev_je_id, old_expense_acct, 0, OLD.amount, 'Reversal of delete', OLD.project_id, OLD.category_id, 2);

  update public.journal_entries set reversed_by = rev_je_id where id = old_je_id;
  return OLD;
end $$;

drop trigger if exists expenses_to_journal_delete on public.expenses;
create trigger expenses_to_journal_delete
  before delete on public.expenses
  for each row execute procedure public.expense_delete_to_journal();
