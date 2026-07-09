-- Phase 3 acceptance. The two invariants that define the MVP:
--   I4 — labor counted once: approved pay posts; costed time NEVER posts.
--   I5 — nothing billed twice: invoiced_lock cycle across invoices A and B.

\set QUIET on
\pset tuples_only on

select tests.make_user('studio@t.io') as owner_u \gset
select tests.make_user('fred@t.io')   as fred_u  \gset
update profiles set is_active = true where id = :'fred_u'::uuid;

-- ---------- fixtures ----------
select tests.become(:'owner_u');
set role authenticated;
insert into contacts (name) values ('Big Client');
insert into projects (name, start_date, contact_id, photographers)
  select 'Retainer', '2026-10-01', id, array['Fred Lance'] from contacts;
insert into projects (name, start_date) values ('Unstaffed Project', '2026-10-02');
reset role;
-- The supported linking flow: put the person's email on their roster row,
-- THEN promote — the 0026 identity trigger claims the row instead of
-- creating a duplicate.
update team_members set email = 'fred@t.io' where display_name = 'Fred Lance';
update org_members set role = 'contractor' where user_id = :'fred_u'::uuid;
select tests.assert(
  (select count(*) = 1 from team_members where profile_id = :'fred_u'::uuid),
  'promotion claimed the roster row — exactly one identity for Fred');
select tests.assert(
  (select display_name = 'Fred Lance' from team_members where profile_id = :'fred_u'::uuid),
  'the claimed row is the photographer roster row');
select tests.become(:'owner_u');
set role authenticated;
insert into member_rates (team_member_id, cost_rate, bill_rate)
  select id, 50, 100 from team_members where display_name = 'Fred Lance';

-- Approved pay: the REALIZED labor cost ($500, exactly once in P&L).
update pay_items set amount = 500.00
  where team_member_id = (select id from team_members where display_name = 'Fred Lance');
select approve_pay_item(id) from pay_items where status = 'draft';
select set_config('app.pay_item_rpc', '', true);

-- Revenue for the effective-rate figure: invoice 2000, paid in full.
insert into invoices (contact_id, project_id)
  select c.id, p.id from contacts c, projects p where p.name = 'Retainer';
insert into invoice_lines (invoice_id, description, qty, unit_price, line_number)
  select id, 'Retainer fee', 1, 2000.00, 1 from invoices;
update invoices set status = 'sent';
select record_payment(id, 2000.00, '2026-10-15') from invoices;
select set_config('app.payment_rpc', '', true);
select set_config('app.invoice_rpc', '', true);

select count(*) as je_before_time from journal_entries \gset

-- ---------- Fred (contractor) logs 10 hours ----------
-- Contractors cannot read the projects table (by design); the app hands them
-- project ids via their work views. The test does the same via GUCs.
reset role;
select set_config('tests.retainer', (select id::text from projects where name = 'Retainer'), false);
select set_config('tests.unstaffed', (select id::text from projects where name = 'Unstaffed Project'), false);
select set_config('tests.fred_tm', (select id::text from team_members where display_name = 'Fred Lance'), false);
select tests.become(:'fred_u');
set role authenticated;

-- timer survives "reload": the open entry is a server-side row
select start_timer(current_setting('tests.retainer')::uuid, null, 'edit session', true);
select tests.assert(
  (select count(*) = 1 from time_entries where minutes is null),
  'running timer is a server-side row');
select stop_timer();
select tests.assert(
  (select count(*) = 1 from time_entries where minutes is not null),
  'stop closes the entry with computed minutes');

-- manual 10h billable entry (the I4 scenario)
insert into time_entries (project_id, team_member_id, started_at, minutes, billable, notes)
values (current_setting('tests.retainer')::uuid, current_setting('tests.fred_tm')::uuid,
        '2026-10-10 09:00+00', 600, true, 'full day edit');

select tests.assert(
  (select bill_rate = 100.00 from time_entries where minutes = 600),
  'bill_rate snapshotted from member rates');

-- contractor cannot log on unstaffed projects
do $$
begin
  insert into public.time_entries (project_id, team_member_id, started_at, minutes)
  values (current_setting('tests.unstaffed')::uuid, current_setting('tests.fred_tm')::uuid, now(), 30);
  raise exception 'GUARD FAILED: contractor logged on unstaffed project';
exception when insufficient_privilege or check_violation then null;
end $$;

-- cost snapshots invisible to the contractor
select tests.assert((select count(*) = 0 from time_entry_costs), 'cost snapshots hidden from contractor');

-- ---------- I4: labor appears exactly once ----------
reset role;
select tests.become(:'owner_u');
set role authenticated;

select tests.assert(
  (select cogs = 500.00 from v_project_pnl where project_name = 'Retainer'),
  'I4: realized P&L shows the $500 approved pay exactly once');
select tests.assert(
  (select labor_memo_cost = 500.00 + round((select minutes from time_entries where notes = 'edit session') / 60.0 * 50, 2)
     from v_project_pnl where project_name = 'Retainer'),
  'I4: memo column = hours × cost_rate, separate from realized P&L');
select tests.assert(
  (select count(*) = :je_before_time from journal_entries),
  'I4: logging time created ZERO journal entries');
select tests.assert(
  (select count(*) = 0 from journal_entries where source_type = 'time_entry'),
  'I4: no journal entry ever references a time entry');

-- rate snapshot is stable even after the rate changes
update member_rates set cost_rate = 80, bill_rate = 160
  where team_member_id = (select id from team_members where display_name = 'Fred Lance');
select tests.assert(
  (select bill_rate = 100.00 from time_entries where minutes = 600),
  'snapshots survive later rate changes');

-- effective hourly rate = revenue / logged hours
select tests.assert(
  (select effective_hourly_rate =
     round(2000.00 / ((logged_minutes) / 60.0), 2)
   from v_project_pnl where project_name = 'Retainer'),
  'effective hourly rate renders from ledger + time data');

-- ---------- I5: nothing billed twice ----------
insert into invoices (contact_id, project_id)  -- invoice A (draft)
  select c.id, p.id from contacts c, projects p where c.name = 'Big Client' and p.name = 'Retainer';
select set_config('tests.inv_a', (
  select id::text from invoices where status = 'draft' order by created_at desc limit 1), false);

-- a billable expense to rebill alongside the time
insert into expenses (project_id, category_id, description, amount, expense_date, billable)
  select p.id, c.id, 'Drone rental', 300.00, '2026-10-11', true
  from projects p, categories c where p.name = 'Retainer' and c.name = 'Equipment Rental';

select add_unbilled_to_invoice(
  current_setting('tests.inv_a')::uuid,
  array(select id from time_entries where minutes = 600),
  array(select id from expenses where description = 'Drone rental')) as added \gset
select tests.assert(:added = 2, 'I5: time + expense pulled onto invoice A');
select tests.assert(
  (select invoiced_lock and invoice_line_id is not null from time_entries where minutes = 600),
  'I5: entry locked with a line reference');

-- locked rows are immutable
do $$
begin
  update public.time_entries set minutes = 660 where minutes = 600;
  raise exception 'GUARD FAILED: edited a locked time entry';
exception when check_violation then null;
end $$;

-- invoice B cannot pull the same entries
insert into invoices (contact_id, project_id)
  select c.id, p.id from contacts c, projects p where c.name = 'Big Client' and p.name = 'Retainer';
select set_config('tests.inv_b', (
  select id::text from invoices i where i.status = 'draft'
    and i.id <> current_setting('tests.inv_a')::uuid
  order by created_at desc limit 1), false);
do $$
begin
  perform public.add_unbilled_to_invoice(
    current_setting('tests.inv_b')::uuid,
    array(select id from public.time_entries where minutes = 600), '{}');
  raise exception 'GUARD FAILED: invoice B billed locked entries';
exception when check_violation then null;
end $$;

-- voiding A releases the work…
update invoices set status = 'void' where id = current_setting('tests.inv_a')::uuid;
select tests.assert(
  (select not invoiced_lock and invoice_line_id is null from time_entries where minutes = 600),
  'I5: voiding invoice A unlocks its sources');

-- …and B can now bill them
select add_unbilled_to_invoice(
  current_setting('tests.inv_b')::uuid,
  array(select id from time_entries where minutes = 600), '{}') as readded \gset
select tests.assert(:readded = 1, 'I5: unlocked entry billable on invoice B');

-- draft line delete also unlocks
delete from invoice_lines
  where invoice_id = current_setting('tests.inv_b')::uuid and source_type = 'time_entry';
select tests.assert(
  (select not invoiced_lock from time_entries where minutes = 600),
  'I5: deleting a draft line unlocks its source');

reset role;
select '08_time_i4_i5: PASS';
