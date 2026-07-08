-- Legacy client_paid backfill (0019): planted pre-Phase-1 balances become
-- ledger-backed invoices + payments, idempotently, and the write-block holds.

\set QUIET on
\pset tuples_only on

select tests.make_user('legacy-owner@test.io') as owner_u \gset
select tests.become(:'owner_u');
set role authenticated;

insert into years (year_value) values (2024);
insert into projects (year_id, name, client, status, end_date)
  select id, 'Old Wedding', 'Vandelay Industries', 'completed', '2024-09-15'
  from years where year_value = 2024;

-- Plant a legacy balance the way pre-0019 data had it (system context, rollup
-- flag set — exactly how a pre-migration row would look).
reset role;
select set_config('app.client_paid_rollup', 'on', false);
update projects set client_paid = 3500.00 where name = 'Old Wedding';
select set_config('app.client_paid_rollup', '', false);

select backfill_legacy_client_paid() as backfilled \gset
select tests.assert(:backfilled = 1, 'one legacy balance backfilled');

select tests.become(:'owner_u');
set role authenticated;

select tests.assert(
  (select count(*) = 1 from invoices
    where memo = 'Historical balance (pre-ledger)' and status = 'paid'),
  'legacy invoice created as paid');
select tests.assert(
  (select c.name = 'Vandelay Industries'
     from invoices i join contacts c on c.id = i.contact_id
     where i.memo = 'Historical balance (pre-ledger)'),
  'contact created from the project client text (I3)');
select tests.assert(
  (select count(*) = 1 from payments where method = 'legacy' and amount = 3500.00),
  'legacy payment recorded');
select tests.assert(
  (select sum(jl.debit) = 3500.00 and sum(jl.credit) = 3500.00
     from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
     where je.source_type = 'payment'),
  'legacy entry balanced: DR cash / CR revenue');
select tests.assert(
  (select revenue = 3500.00 from v_project_pnl where project_name = 'Old Wedding'),
  'historical revenue is now ledger-backed');
select tests.assert(
  (select client_paid = 3500.00 from projects where name = 'Old Wedding'),
  'rollup reproduces the legacy number exactly');

-- idempotent: a second run changes nothing
reset role;
select backfill_legacy_client_paid() as again \gset
select tests.assert(:again = 0, 'backfill is idempotent');
select tests.become(:'owner_u');
set role authenticated;
select tests.assert(
  (select count(*) = 1 from invoices where memo = 'Historical balance (pre-ledger)'),
  'no duplicate legacy invoices');

-- the write-block holds after backfill
do $$
begin
  update public.projects set client_paid = 9999 where name = 'Old Wedding';
  raise exception 'GUARD FAILED: client_paid writable after backfill';
exception when check_violation then null;
end $$;

-- API roles cannot invoke the backfill function
do $$
begin
  perform public.backfill_legacy_client_paid();
  raise exception 'GUARD FAILED: authenticated ran the backfill';
exception when insufficient_privilege then null;
end $$;

reset role;
select '06_legacy_backfill: PASS';
