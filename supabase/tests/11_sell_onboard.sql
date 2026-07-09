-- Phase 5 acceptance: catalog → proposal snapshots, the one-click Win (one
-- transaction, idempotent, compensable), contract signing evidence, and the
-- scheduler's double-book protection.

\set QUIET on
\pset tuples_only on

select tests.make_user('sell-owner@t.io') as owner_u \gset
select tests.become(:'owner_u');
set role authenticated;

-- ---------- catalog + proposal with snapshots ----------
insert into catalog_items (name, kind, unit_price, estimated_cost, estimated_hours)
  values ('Full-day wedding coverage', 'service', 4000.00, 1200.00, 10),
         ('Second shooter', 'service', 800.00, 400.00, 8);

insert into contacts (name, email, lifecycle) values ('June Couple', 'june@couple.io', 'lead');
insert into deals (contact_id, title, estimated_value, expected_date)
  select id, 'June wedding', 5000.00, '2027-06-20' from contacts where name = 'June Couple';

insert into task_templates (name) values ('Wedding runbook');
insert into task_template_items (template_id, section_name, title, sort_order)
  select id, 'Prep', 'Scout venue', 1 from task_templates;

insert into proposals (contact_id, deal_id, title, project_type, deposit_pct, task_template_id)
  select c.id, d.id, 'June Wedding Package', 'Wedding', 50,
         (select id from task_templates)
  from contacts c join deals d on d.contact_id = c.id
  where c.name = 'June Couple';

insert into proposal_lines (proposal_id, catalog_item_id, description, qty, unit_price, line_number)
  select p.id, ci.id, ci.name, 1, ci.unit_price, row_number() over (order by ci.name)
  from proposals p, catalog_items ci;

select tests.assert(
  (select sum(estimated_cost) = 1600.00 from proposal_lines),
  'lines snapshot estimated cost from the catalog');
select tests.assert(
  (select total = 4800.00 from v_proposal_totals),
  'proposal totals derive from lines');

update proposals set status = 'sent';

-- lines frozen after sending
do $$
begin
  update public.proposal_lines set unit_price = 1;
  raise exception 'GUARD FAILED: edited sent proposal lines';
exception when check_violation then null;
end $$;

-- ---------- anonymous acceptance runs the whole Win in one call ----------
reset role;
select set_config('tests.ptoken', (select share_token::text from proposals), false);
set role anon;
select tests.assert(
  (select get_public_proposal(current_setting('tests.ptoken')::uuid) ->> 'title' = 'June Wedding Package'),
  'anon reads the proposal');
select accept_proposal(current_setting('tests.ptoken')::uuid, 'June Couple');
reset role;

select tests.become(:'owner_u');
set role authenticated;
select tests.assert((select status = 'accepted' from proposals), 'proposal accepted');
select tests.assert(
  (select project_id is not null and contract_id is not null and invoice_id is not null
     from proposals),
  'win artifacts stamped');
select tests.assert(
  (select count(*) = 1 from projects where name = 'June Wedding Package'),
  'win created the project');
select tests.assert(
  (select count(*) = 1 from tasks t join projects p on p.id = t.project_id
    where p.name = 'June Wedding Package' and t.title = 'Scout venue'),
  'win applied the task template');
select tests.assert(
  (select c.status = 'sent' and cv.doc_hash is not null
     from contracts c join contract_versions cv on cv.contract_id = c.id),
  'win generated a contract, versioned and hashed');
select tests.assert(
  (select i.status = 'sent' and t.total = 2400.00
     from invoices i join v_invoice_totals t on t.invoice_id = i.id
     where i.memo like 'Deposit%'),
  'win issued the 50% deposit invoice, sent');
select tests.assert(
  (select status = 'won' and project_id is not null from deals),
  'win closed the deal');
select tests.assert(
  (select lifecycle = 'client' from contacts where name = 'June Couple'),
  'win promoted the contact');

-- idempotency: accepting again changes nothing
reset role;
set role anon;
select accept_proposal(current_setting('tests.ptoken')::uuid, 'June Couple');
reset role;
select tests.become(:'owner_u');
set role authenticated;
select tests.assert((select count(*) = 1 from projects where name = 'June Wedding Package'),
  'idempotent: still one project');
select tests.assert((select count(*) = 1 from invoices where memo like 'Deposit%'),
  'idempotent: still one deposit invoice');

-- ---------- contract signing: evidence + freeze ----------
reset role;
select set_config('tests.ctoken', (select share_token::text from contracts), false);
set role anon;
select sign_contract(current_setting('tests.ctoken')::uuid, 'June Couple', 'june@couple.io');
reset role;
select tests.become(:'owner_u');
set role authenticated;
select tests.assert(
  (select count(*) = 1 from signature_events
    where signer_name = 'June Couple' and provider = 'internal' and doc_hash is not null),
  'signature evidence recorded');
select tests.assert((select status = 'signed' from contracts), 'contract signed');
do $$
begin
  update public.contracts set body_md = 'tampered';
  raise exception 'GUARD FAILED: edited a signed contract';
exception when check_violation then null;
end $$;

-- ---------- un-win compensates, and refuses after money ----------
select unwin_proposal((select id from proposals));
select tests.assert((select status = 'sent' from proposals), 'unwin reopened the proposal');
select tests.assert((select status = 'open' from deals), 'unwin reopened the deal');
select tests.assert(
  (select count(*) = 1 from invoices where status = 'void'),
  'unwin voided the deposit invoice');
select tests.assert(
  (select count(*) = 1 from projects where name = 'June Wedding Package'),
  'unwin keeps the project (data preservation)');

-- win again, pay the deposit, then unwin must refuse
select win_deal_manual((select id from proposals));
select set_config('app.proposal_rpc', '', true);
select record_payment((select invoice_id from proposals), 100.00);
select set_config('app.payment_rpc', '', true);
select set_config('app.invoice_rpc', '', true);
do $$
begin
  perform public.unwin_proposal((select id from public.proposals));
  raise exception 'GUARD FAILED: unwin after payment';
exception when check_violation then null;
end $$;

-- ---------- scheduler ----------
insert into appointment_types (name, minutes, buffer_minutes) values ('Consultation', 30, 0);
insert into availability_rules (weekday, start_time, end_time)
  select extract(isodow from current_date + 7)::int, '09:00', '12:00';

reset role;
select set_config('tests.stoken', (select share_token::text from appointment_types), false);
set role anon;
select tests.assert(
  (select jsonb_array_length(get_public_scheduler(current_setting('tests.stoken')::uuid,
                                                  current_date, 14) -> 'slots') = 6),
  'scheduler computes 6 open half-hour slots for the 9-12 window');
select set_config('tests.slot', (
  select (get_public_scheduler(current_setting('tests.stoken')::uuid, current_date, 14)
          -> 'slots' -> 0 ->> 'starts_at')), false);
select book_slot(current_setting('tests.stoken')::uuid,
                 current_setting('tests.slot')::timestamptz,
                 'Walk-in Wanda', 'wanda@x.io');
-- the same slot cannot be booked twice
do $$
begin
  perform public.book_slot(current_setting('tests.stoken')::uuid,
                           current_setting('tests.slot')::timestamptz,
                           'Second Sam', 'sam@x.io');
  raise exception 'GUARD FAILED: double booking accepted';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;
select tests.assert(
  (select jsonb_array_length(get_public_scheduler(current_setting('tests.stoken')::uuid,
                                                  current_date, 14) -> 'slots') = 5),
  'booked slot disappears from availability');
reset role;

select tests.become(:'owner_u');
set role authenticated;
select tests.assert(
  (select count(*) = 1 from bookings where status = 'confirmed' and name = 'Walk-in Wanda'),
  'booking recorded with the visitor identity');
select tests.assert(
  (select lifecycle = 'lead' from contacts where email = 'wanda@x.io'),
  'booking created a lead contact');

reset role;
select '11_sell_onboard: PASS';
