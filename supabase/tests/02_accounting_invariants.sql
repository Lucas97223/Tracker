-- Ledger invariants: balance enforcement, immutability, the expense mirror,
-- category→account posting (incl. COGS remap), trial-balance sanity.

\set QUIET on
\pset tuples_only on

select tests.make_user('books-admin@test.io') as admin_u \gset
select tests.become(:'admin_u');
set role authenticated;

insert into years (year_value) values (2026);
insert into projects (year_id, name) select id, 'Ledger Proj' from years where year_value = 2026;

-- ---------- balanced-entry enforcement ----------
-- The balance check is a deferred constraint trigger; force it immediate so
-- the violation surfaces inside this test transaction.
set constraints journal_lines_balance immediate;

do $$
declare v_je uuid; v_acct uuid;
begin
  insert into public.journal_entries (entry_date, memo, source_type, posted, posted_at)
  values (current_date, 'unbalanced attempt', 'manual', false, null)
  returning id into v_je;
  select id into v_acct from public.accounts where code = '1000'
    and org_id = (select org_id from public.journal_entries where id = v_je);
  insert into public.journal_lines (journal_entry_id, account_id, debit, credit, line_number)
  values (v_je, v_acct, 100.00, 0, 1);
  raise exception 'GUARD FAILED: unbalanced entry accepted';
exception when check_violation then null;
end $$;

-- ---------- expense mirror: insert ----------
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Camera body', 1200.00, '2026-03-10'
  from projects p, categories c where p.name = 'Ledger Proj' and c.name = 'Equipment Rental';

select tests.assert(
  (select count(*) = 1 from expense_journal_map m join expenses e on e.id = m.expense_id
    where e.description = 'Camera body'),
  'mirror: map row exists');
select tests.assert(
  (select count(*) = 2 from journal_lines jl
    join expense_journal_map m on m.journal_entry_id = jl.journal_entry_id
    join expenses e on e.id = m.expense_id where e.description = 'Camera body'),
  'mirror: two lines');
select tests.assert(
  (select a.code = '1000' from journal_lines jl
    join accounts a on a.id = jl.account_id
    join expense_journal_map m on m.journal_entry_id = jl.journal_entry_id
    join expenses e on e.id = m.expense_id
    where e.description = 'Camera body' and jl.credit > 0),
  'mirror: cash credited');

-- ---------- expense mirror: update reverses & reposts ----------
update expenses set amount = 1500.00 where description = 'Camera body';
select tests.assert(
  (select count(*) = 1 from journal_entries where source_type = 'reversal' and reversed_by is null
     and memo = 'Reversal of edited expense'),
  'mirror: reversal entry posted on edit');
select tests.assert(
  (select count(*) = 1 from journal_entries where reversed_by is not null),
  'mirror: original marked reversed');
select tests.assert(
  (select jl.debit = 1500.00 from journal_lines jl
    join expense_journal_map m on m.journal_entry_id = jl.journal_entry_id
    join expenses e on e.id = m.expense_id
    where e.description = 'Camera body' and jl.debit > 0),
  'mirror: replacement carries new amount');

-- ---------- posted immutability ----------
do $$
begin
  update public.journal_entries set memo = 'tamper' where posted = true;
  raise exception 'GUARD FAILED: posted entry mutated';
exception when check_violation then null;
end $$;
do $$
begin
  update public.journal_lines set debit = debit + 1
    where journal_entry_id in (select id from public.journal_entries where posted = true)
      and debit > 0;
  raise exception 'GUARD FAILED: posted line mutated';
exception when check_violation or insufficient_privilege then null;
end $$;

-- ---------- expense mirror: delete posts reversal, keeps history ----------
select count(*) as je_before from journal_entries \gset
delete from expenses where description = 'Camera body';
select tests.assert(
  (select count(*) = :je_before + 1 from journal_entries),
  'mirror: delete adds a reversal, removes nothing');
select tests.assert((select count(*) = 0 from expenses where description = 'Camera body'),
  'mirror: expense row gone');

-- ---------- COGS remap posts through the mapping ----------
update categories set account_id = (select id from accounts where code = '5100')
  where name = 'Photographer Pay';
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Second shooter day rate', 400.00, '2026-03-12'
  from projects p, categories c where p.name = 'Ledger Proj' and c.name = 'Photographer Pay';
select tests.assert(
  (select a.code = '5100' and a.type = 'cogs' from journal_lines jl
    join accounts a on a.id = jl.account_id
    join expense_journal_map m on m.journal_entry_id = jl.journal_entry_id
    join expenses e on e.id = m.expense_id
    where e.description = 'Second shooter day rate' and jl.debit > 0),
  'remapped category debits the COGS account');
select tests.assert(
  (select cogs = 400.00 from v_project_pnl where project_name = 'Ledger Proj'),
  'COGS-mapped expense lands in the P&L cogs column');

-- ---------- zero-amount expenses have no ledger effect ----------
-- ($0 rows were the legacy photographer-pay placeholder mechanism; the GL
-- forbids 0/0 lines, so the mirror must skip them — and must catch up when a
-- $0 row is edited to a real amount, or reverse when edited back to zero.)
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Placeholder fee', 0, '2026-03-15'
  from projects p, categories c where p.name = 'Ledger Proj' and c.name = 'Misc';
select tests.assert(
  (select count(*) = 0 from expense_journal_map m
     join expenses e on e.id = m.expense_id where e.description = 'Placeholder fee'),
  '$0 expense posts nothing');

update expenses set amount = 275.00 where description = 'Placeholder fee';
select tests.assert(
  (select jl.debit = 275.00 from journal_lines jl
     join expense_journal_map m on m.journal_entry_id = jl.journal_entry_id
     join expenses e on e.id = m.expense_id
     where e.description = 'Placeholder fee' and jl.debit > 0),
  '$0 → $275 edit posts one fresh entry');

update expenses set amount = 0 where description = 'Placeholder fee';
select tests.assert(
  (select count(*) = 0 from expense_journal_map m
     join expenses e on e.id = m.expense_id where e.description = 'Placeholder fee'),
  '$275 → $0 edit reverses and unlinks');
delete from expenses where description = 'Placeholder fee';

-- ---------- trial balance stays balanced ----------
select tests.assert(
  (select coalesce(sum(total_debit), 0) = coalesce(sum(total_credit), 0) from v_trial_balance),
  'trial balance: total debits equal total credits');

reset role;
select '02_accounting_invariants: PASS';
