-- Stripe rails + reminders: webhook idempotency, clearing/fee postings per
-- the §5 map (revenue gross), and the reminder-candidate rules.

\set QUIET on
\pset tuples_only on

select tests.make_user('stripe-owner@t.io') as owner_u \gset
select tests.become(:'owner_u');
set role authenticated;

insert into contacts (name, email) values ('Card Client', 'card@client.io');
insert into projects (name, start_date, contact_id)
  select 'Card Project', '2027-03-01', id from contacts;
insert into invoices (contact_id, project_id, due_date)
  select c.id, p.id, current_date - 10 from contacts c, projects p;
insert into invoice_lines (invoice_id, description, qty, unit_price, line_number)
  select id, 'Coverage', 1, 1000.00, 1 from invoices;
update invoices set status = 'sent';
reset role;

select set_config('tests.inv', (select id::text from invoices), false);

-- ---------- reminder candidates ----------
select tests.assert(
  (select count(*) = 1 from v_reminder_candidates
    where invoice_id = current_setting('tests.inv')::uuid and balance = 1000.00),
  'overdue open invoice with email is a reminder candidate');
insert into reminder_log (org_id, invoice_id, to_email)
  select org_id, id, 'card@client.io' from invoices;
select tests.assert(
  (select count(*) = 0 from v_reminder_candidates),
  'a reminder in the last 3 days suppresses the candidate');
-- sender is a no-op without the platform extensions
select tests.assert(
  (select public.send_invoice_reminders() = 0),
  'sender no-ops gracefully off-platform');

-- ---------- stripe webhook path ----------
select record_stripe_payment('cs_test_ref_1', current_setting('tests.inv')::uuid,
                             1000.00, 29.30, '{"via":"test"}'::jsonb);

select tests.assert(
  (select status = 'paid' from invoices),
  'stripe payment settles the invoice');
select tests.assert(
  (select count(*) = 1 from payments where method = 'stripe' and amount = 1000.00),
  'payment recorded gross');
-- gross into clearing, revenue credited gross
select tests.assert(
  (select sum(jl.debit) = 1000.00 from journal_lines jl
    join accounts a on a.id = jl.account_id where a.code = '1050'),
  'clearing debited the gross amount');
select tests.assert(
  (select sum(jl.credit) = 1000.00 from journal_lines jl
    join accounts a on a.id = jl.account_id where a.code = '4100'),
  'revenue stays gross (fee never nets it)');
-- fee: DR 6900 / CR clearing
select tests.assert(
  (select sum(jl.debit) = 29.30 from journal_lines jl
    join accounts a on a.id = jl.account_id where a.code = '6900'),
  'processor fee expensed');
select tests.assert(
  (select sum(jl.credit) = 29.30 from journal_lines jl
    join accounts a on a.id = jl.account_id where a.code = '1050'),
  'fee credited out of clearing (clearing nets to payout amount)');
select tests.assert(
  (select sum(debit) = sum(credit) from journal_lines),
  'ledger balanced after card payment + fee');

-- webhook retries can never double-post
select record_stripe_payment('cs_test_ref_1', current_setting('tests.inv')::uuid,
                             1000.00, 29.30, '{}'::jsonb) as again \gset
select tests.assert(
  (select count(*) = 1 from payments where method = 'stripe'),
  'duplicate processor_ref is a no-op');

-- paid invoices are settled — candidates list is empty even past the 3 days
delete from reminder_log;
select tests.assert(
  (select count(*) = 0 from v_reminder_candidates),
  'paid invoice never gets reminded');

select '13_stripe_reminders: PASS';
