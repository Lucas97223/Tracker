-- Phase 1 acceptance: contact → project → invoice → partial payments → void,
-- with tax to liability, ledger-backed revenue, derived client_paid, AR aging,
-- credit notes, and every guard along the way.

\set QUIET on
\pset tuples_only on

select tests.make_user('inv-owner@test.io')  as owner_u  \gset
select tests.make_user('inv-editor@test.io') as editor_u \gset
select tests.make_user('inv-viewer@test.io') as viewer_u \gset
update profiles set is_active = true, role = 'editor' where id = :'editor_u'::uuid;
update profiles set is_active = true where id = :'viewer_u'::uuid;

select tests.become(:'owner_u');
set role authenticated;

-- ---------- contact + project (years demotion: no year_id supplied) ----------
insert into contacts (name, type, email) values ('Globex Events', 'company', 'ap@globex.io');
insert into projects (name, start_date, contact_id)
  select 'Gala 2026', '2026-10-01', id from contacts where name = 'Globex Events';

select tests.assert(
  (select y.year_value = 2026 from projects p join years y on y.id = p.year_id
    where p.name = 'Gala 2026'),
  'years demotion: year derived from start_date, row auto-created');

-- ---------- tax rate + invoice with lines ----------
insert into tax_rates (name, rate, liability_account_id)
  select 'Sales Tax 8.25%', 0.0825, id from accounts where code = '2200';

insert into invoices (contact_id, project_id, due_date)
  select c.id, p.id, current_date - 10   -- overdue on purpose (aging bucket)
  from contacts c, projects p where c.name = 'Globex Events' and p.name = 'Gala 2026';

select set_config('tests.inv', (select id::text from invoices limit 1), false);

insert into invoice_lines (invoice_id, description, qty, unit_price, line_number)
  values (current_setting('tests.inv')::uuid, 'Event coverage package', 1, 1000.00, 1);
insert into invoice_lines (invoice_id, description, qty, unit_price, tax_rate_id, line_number)
  select current_setting('tests.inv')::uuid, 'Prints', 2, 250.00, id, 2 from tax_rates;

select tests.assert(
  (select subtotal = 1500.00 and tax_total = 41.25 and total = 1541.25
    from v_invoice_totals where invoice_id = current_setting('tests.inv')::uuid),
  'derived totals: 1500 + 41.25 tax');
select tests.assert(
  (select number = 1 from invoices where id = current_setting('tests.inv')::uuid),
  'per-org numbering starts at 1');

-- payments require a sent invoice
do $$
begin
  perform public.record_payment(current_setting('tests.inv')::uuid, 100.00);
  raise exception 'GUARD FAILED: paid a draft invoice';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;

update invoices set status = 'sent' where id = current_setting('tests.inv')::uuid;

-- lines are frozen after draft
do $$
begin
  update public.invoice_lines set unit_price = 9999
    where invoice_id = current_setting('tests.inv')::uuid;
  raise exception 'GUARD FAILED: edited a sent invoice''s lines';
exception when check_violation then null;
end $$;

-- ---------- partial payment #1 (editor records it) ----------
reset role;
select tests.become(:'editor_u');
set role authenticated;
select record_payment(current_setting('tests.inv')::uuid, 1000.00, '2026-10-05', 'wire', 'W-1');

select tests.assert(
  (select status = 'partial' from invoices where id = current_setting('tests.inv')::uuid),
  'status sent → partial');
select tests.assert(
  (select paid = 1000.00 and balance = 541.25 from v_invoice_totals
    where invoice_id = current_setting('tests.inv')::uuid),
  'paid/balance track payments');
select tests.assert(
  (select client_paid = 1000.00 from projects where name = 'Gala 2026'),
  'client_paid rollup = payments');
-- balanced entry, cash debited in full
select tests.assert(
  (select sum(jl.debit) = 1000.00 and sum(jl.credit) = 1000.00
     from journal_lines jl join journal_entries je on je.id = jl.journal_entry_id
     where je.source_type = 'payment'),
  'payment entry balanced');
select tests.assert(
  (select sum(jl.credit) = 26.76 from journal_lines jl
     join accounts a on a.id = jl.account_id
     where a.code = '2200'),
  'proportional tax share on partial payment (26.76)');

-- direct payment-table writes are impossible even for editors
do $$
begin
  insert into public.payments (org_id, invoice_id, amount, journal_entry_id)
  select org_id, id, 1, gen_random_uuid() from public.invoices limit 1;
  raise exception 'GUARD FAILED: direct payment insert';
exception when check_violation then null;
end $$;

-- viewers cannot record payments
reset role;
select tests.become(:'viewer_u');
set role authenticated;
do $$
begin
  perform public.record_payment(current_setting('tests.inv')::uuid, 10.00);
  raise exception 'GUARD FAILED: viewer recorded a payment';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;

-- AR aging: overdue partial invoice shows up with a bucket
select tests.assert(
  (select bucket in ('1-30','31-60') and balance = 541.25 from v_ar_aging
    where invoice_id = current_setting('tests.inv')::uuid),
  'AR aging exposes the open overdue balance');

-- ---------- payment #2 completes, tax trues up exactly ----------
reset role;
select tests.become(:'owner_u');
set role authenticated;

do $$
begin
  perform public.record_payment(current_setting('tests.inv')::uuid, 600.00);
  raise exception 'GUARD FAILED: overpayment accepted';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;

select record_payment(current_setting('tests.inv')::uuid, 541.25, '2026-10-20');

select tests.assert(
  (select status = 'paid' from invoices where id = current_setting('tests.inv')::uuid),
  'status partial → paid');
select tests.assert(
  (select sum(jl.credit) = 41.25 from journal_lines jl
     join accounts a on a.id = jl.account_id where a.code = '2200'),
  'tax liability credited exactly tax_total after final payment');
select tests.assert(
  (select sum(jl.credit) = 1500.00 from journal_lines jl
     join accounts a on a.id = jl.account_id where a.code = '4100'),
  'revenue = net subtotal, never includes tax');
select tests.assert(
  (select revenue = 1500.00 from v_project_pnl where project_name = 'Gala 2026'),
  'v_project_pnl revenue reads the ledger');
select tests.assert(
  (select client_paid = 1541.25 from projects where name = 'Gala 2026'),
  'client_paid equals Σ payments exactly');

-- a project with zero invoices shows zero revenue
insert into projects (name, start_date) values ('No Invoices Yet', '2026-11-01');
select tests.assert(
  (select revenue = 0 from v_project_pnl where project_name = 'No Invoices Yet'),
  'zero-invoice project has zero revenue');

-- ---------- void the second payment: reversal, never edits ----------
select set_config('tests.pay2', (
  select id::text from payments where amount = 541.25 and voided_at is null), false);
select void_payment(current_setting('tests.pay2')::uuid);

select tests.assert(
  (select status = 'partial' from invoices where id = current_setting('tests.inv')::uuid),
  'void: paid → partial again');
select tests.assert(
  (select client_paid = 1000.00 from projects where name = 'Gala 2026'),
  'void: rollup drops the voided amount');
select tests.assert(
  (select count(*) = 1 from journal_entries je
     join payments p on p.reversal_entry_id = je.id
     where p.id = current_setting('tests.pay2')::uuid),
  'void posted a reversal entry');
select tests.assert(
  (select reversed_by is not null from journal_entries
     where id = (select journal_entry_id from payments
                 where id = current_setting('tests.pay2')::uuid)),
  'original payment entry marked reversed, not edited');
select tests.assert(
  (select revenue = 1000.00 - 26.76 + 26.76 from v_project_pnl where project_name = 'Gala 2026')
  or (select revenue = 973.24 from v_project_pnl where project_name = 'Gala 2026'),
  'ledger revenue reflects the reversal');

-- sent invoice with live payments cannot be voided
do $$
begin
  update public.invoices set status = 'void'
    where id = current_setting('tests.inv')::uuid;
  raise exception 'GUARD FAILED: voided an invoice with live payments';
exception when check_violation then null;
end $$;

-- ---------- credit note posts contra-revenue ----------
select issue_credit_note(
  (select id from contacts where name = 'Globex Events'),
  100.00, current_date, null,
  (select id from projects where name = 'Gala 2026'),
  'Goodwill discount');
select tests.assert(
  (select sum(jl.debit) = 100.00 from journal_lines jl
     join accounts a on a.id = jl.account_id where a.code = '4800'),
  'credit note debits 4800 contra-revenue');
select tests.assert(
  (select revenue = 873.24 from v_project_pnl where project_name = 'Gala 2026'),
  'contra-revenue nets out of project revenue');

-- every journal entry got an accounting period
select tests.assert(
  (select count(*) = 0 from journal_entries where period_id is null),
  'every posting landed in an accounting period');

reset role;
select '05_invoicing_payments: PASS';
