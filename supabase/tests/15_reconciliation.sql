-- Bank staging + reconciliation: dedupe, exact-match suggestions, the
-- reconcile handshake, and the GL export surface.

\set QUIET on
\pset tuples_only on

select tests.make_user('bank-owner@t.io') as owner_u \gset
select tests.become(:'owner_u');
set role authenticated;

-- ledger activity to match against: one expense (cash out 250)
insert into projects (name, start_date) values ('Recon Project', '2027-04-01');
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Lens rental', 250.00, current_date - 2
  from projects p, categories c where c.name = 'Equipment Rental';

-- bank rows: matching outflow, an unrelated inflow, and a dupe of the first
insert into bank_transactions (txn_date, amount, description, source)
  values (current_date - 1, -250.00, 'CARD PURCHASE LENSRENTALS', 'test.csv');
insert into bank_transactions (txn_date, amount, description, source)
  values (current_date - 1, 999.00, 'UNRELATED DEPOSIT', 'test.csv');
insert into bank_transactions (txn_date, amount, description, source)
  values (current_date - 1, -250.00, 'CARD PURCHASE LENSRENTALS', 'test.csv')
  on conflict do nothing;

select tests.assert(
  (select count(*) = 2 from bank_transactions),
  'import dedupe: identical row lands once');

-- suggestion: the -250 bank row pairs with the cash credit line
select tests.assert(
  (select count(*) = 1 from v_bank_match_suggestions s
    where s.bank_amount = -250.00 and s.account_code = '1000' and s.ledger_amount = -250.00),
  'suggestion finds the matching cash line');
select tests.assert(
  (select count(*) = 0 from v_bank_match_suggestions where bank_amount = 999.00),
  'unrelated deposit has no suggestions');

-- reconcile through the RPC
reset role;
select set_config('tests.txn', (select id::text from bank_transactions where amount = -250.00), false);
select set_config('tests.line', (
  select line_id::text from v_bank_match_suggestions where bank_amount = -250.00), false);
select tests.become(:'owner_u');
set role authenticated;
select reconcile_bank_txn(current_setting('tests.txn')::uuid, current_setting('tests.line')::uuid);

select tests.assert(
  (select reconciled and matched_line_id is not null from bank_transactions
    where id = current_setting('tests.txn')::uuid),
  'reconcile links the bank row to the ledger line');
select tests.assert(
  (select count(*) = 0 from v_bank_match_suggestions where bank_amount = -250.00),
  'reconciled rows drop out of suggestions');

-- a second bank row cannot claim the same ledger line
insert into bank_transactions (txn_date, amount, description)
  values (current_date, -250.00, 'DUPLICATE CLAIM ATTEMPT');
do $$
begin
  perform public.reconcile_bank_txn(
    (select id from public.bank_transactions where description = 'DUPLICATE CLAIM ATTEMPT'),
    current_setting('tests.line')::uuid);
  raise exception 'GUARD FAILED: double-claimed ledger line';
exception when check_violation then null;
end $$;

-- amount mismatch rejected
do $$
begin
  perform public.reconcile_bank_txn(
    (select id from public.bank_transactions where amount = 999.00),
    current_setting('tests.line')::uuid);
  raise exception 'GUARD FAILED: mismatched amounts reconciled';
exception when check_violation then null;
end $$;

-- unreconcile restores the suggestion
select unreconcile_bank_txn(current_setting('tests.txn')::uuid);
select tests.assert(
  (select count(*) >= 1 from v_bank_match_suggestions where bank_amount = -250.00),
  'unreconcile puts the pair back in play');

-- GL export flattens posted activity
select tests.assert(
  (select count(*) >= 2 from v_gl_export where account_code in ('1000') or account_code like '61%'),
  'GL export exposes the posted lines');
select tests.assert(
  (select sum(debit) = sum(credit) from v_gl_export),
  'GL export is balanced');

reset role;
select '15_reconciliation: PASS';
