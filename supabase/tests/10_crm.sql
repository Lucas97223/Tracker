-- Phase 4 acceptance: pipeline + deals (forecast stays forecast — I2),
-- public lead forms, contact merge, universal search.

\set QUIET on
\pset tuples_only on

select tests.make_user('crm-owner@t.io') as owner_u \gset
select tests.become(:'owner_u');
set role authenticated;

-- ---------- pipeline provisioned ----------
select tests.assert(
  (select count(*) = 4 from pipeline_stages),
  'default org got the 4 seeded stages');

-- ---------- deals ----------
insert into contacts (name, email, lifecycle) values ('Maybe Bride', 'bride@x.io', 'lead');
insert into deals (contact_id, title, estimated_value, expected_date)
  select id, 'Wedding — Maybe Bride', 6000.00, '2027-06-12' from contacts where name = 'Maybe Bride';

select tests.assert(
  (select s.sort_order = 1 from deals d join pipeline_stages s on s.id = d.stage_id),
  'new deal lands in the first stage');

-- stage move (the board drag)
update deals set stage_id = (select id from pipeline_stages where name = 'Proposal Sent');
select tests.assert(
  (select s.name = 'Proposal Sent' from deals d join pipeline_stages s on s.id = d.stage_id),
  'deal moves across stages');

-- I2: forecast value appears in NO ledger surface
select tests.assert(
  (select coalesce(sum(revenue), 0) = 0 from v_project_pnl),
  'I2: estimated_value never reaches P&L revenue');
select tests.assert(
  (select coalesce(sum(total_debit) + sum(total_credit), 0) = 0 from v_trial_balance),
  'I2: forecast posts nothing to the ledger');

-- winning: contact lifecycle lead → client, timestamps set
update deals set status = 'won';
select tests.assert(
  (select lifecycle = 'client' from contacts where name = 'Maybe Bride'),
  'won deal promotes the contact to client');
select tests.assert(
  (select won_at is not null and lost_at is null from deals),
  'won bookkeeping');

-- ---------- public lead form ----------
insert into forms (name, headline) values ('Wedding inquiry', 'Tell us about your day');
insert into form_fields (form_id, label, kind, required, sort_order)
  select id, 'Your name', 'text', true, 1 from forms;
insert into form_fields (form_id, label, kind, required, sort_order)
  select id, 'Email', 'email', true, 2 from forms;
insert into form_fields (form_id, label, kind, sort_order)
  select id, 'Tell us more', 'textarea', 3 from forms;

reset role;
select set_config('tests.form_token', (select share_token::text from forms), false);
select set_config('tests.f_name',  (select id::text from form_fields where label = 'Your name'), false);
select set_config('tests.f_email', (select id::text from form_fields where label = 'Email'), false);
select set_config('tests.f_more',  (select id::text from form_fields where label = 'Tell us more'), false);

-- anonymous visitor submits
set role anon;
select tests.assert(
  (select get_public_form(current_setting('tests.form_token')::uuid) ->> 'name' = 'Wedding inquiry'),
  'anon can read the public form definition');
select submit_lead_form(
  current_setting('tests.form_token')::uuid,
  jsonb_build_object(
    current_setting('tests.f_name'),  'Nina New',
    current_setting('tests.f_email'), 'nina@new.io',
    current_setting('tests.f_more'),  'Barn wedding, ~120 guests'));

-- required-field enforcement
do $$
begin
  perform public.submit_lead_form(
    current_setting('tests.form_token')::uuid,
    jsonb_build_object(current_setting('tests.f_more'), 'no identity given'));
  raise exception 'GUARD FAILED: submission without required fields';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;

-- email dedupe: same address → same contact, second deal/response attach
select submit_lead_form(
  current_setting('tests.form_token')::uuid,
  jsonb_build_object(
    current_setting('tests.f_name'),  'Nina N.',
    current_setting('tests.f_email'), 'NINA@new.io'));
reset role;
select tests.assert(
  (select count(*) = 1 from contacts where lower(coalesce(email,'')) = 'nina@new.io'),
  'form dedupes contacts by email (I3)');
select tests.assert(
  (select count(*) = 2 from form_responses),
  'both responses stored');
select tests.assert(
  (select count(*) = 2 from deals d join contacts c on c.id = d.contact_id
    where lower(coalesce(c.email,'')) = 'nina@new.io'),
  'each inquiry opens a deal');
select tests.assert(
  (select lifecycle = 'lead' from contacts where lower(coalesce(email,'')) = 'nina@new.io'),
  'form contacts arrive as leads');

-- inactive form refuses
select tests.become(:'owner_u');
set role authenticated;
update forms set is_active = false;
reset role;
set role anon;
select tests.assert(
  (select get_public_form(current_setting('tests.form_token')::uuid) is null),
  'inactive form is invisible');
do $$
begin
  perform public.submit_lead_form(current_setting('tests.form_token')::uuid, '{}'::jsonb);
  raise exception 'GUARD FAILED: inactive form accepted a response';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;
reset role;

-- ---------- activity timeline ----------
select tests.become(:'owner_u');
set role authenticated;
select tests.assert(
  (select count(*) >= 2 from v_contact_activity a
    join contacts c on c.id = a.contact_id
    where lower(coalesce(c.email,'')) = 'nina@new.io'
      and a.kind in ('deal_created', 'form_response')),
  'timeline shows deals and form responses for the contact');

-- ---------- duplicate merge ----------
insert into contacts (name, email, phone) values ('Nina Duplicate', null, '555-0100');
insert into deals (contact_id, title) select id, 'Dup deal' from contacts where name = 'Nina Duplicate';
select merge_contacts(
  (select id from contacts where lower(coalesce(email,'')) = 'nina@new.io'),
  (select id from contacts where name = 'Nina Duplicate'));

select tests.assert(
  (select count(*) = 3 from deals d join contacts c on c.id = d.contact_id
    where lower(coalesce(c.email,'')) = 'nina@new.io'),
  'merge repointed the duplicate''s deals');
select tests.assert(
  (select phone = '555-0100' from contacts where lower(coalesce(email,'')) = 'nina@new.io'),
  'merge filled missing fields from the duplicate');
select tests.assert(
  (select lifecycle = 'archived' from contacts where name = 'Nina Duplicate'),
  'duplicate archived, not deleted');

-- ---------- universal search ----------
insert into projects (name, start_date) values ('Barnhouse Editorial', '2027-03-03');
insert into tasks (project_id, title)
  select id, 'Scout the barnhouse loft' from projects where name = 'Barnhouse Editorial';

select tests.assert(
  (select count(*) >= 1 from search_all('nina') where kind = 'contact'),
  'search finds contacts');
select tests.assert(
  (select count(*) >= 2 from search_all('barnhouse')),
  'search finds projects and tasks');
select tests.assert(
  (select count(*) >= 1 from search_all('wedding') where kind = 'deal'),
  'search finds deals');

-- org isolation: a rival org sees nothing in search
reset role;
select tests.make_user('rival-crm@t.io') as rival_u \gset
delete from org_members where user_id = :'rival_u'::uuid;
update profiles set default_org_id = null, is_active = true where id = :'rival_u'::uuid;
select tests.become(:'rival_u');
set role authenticated;
insert into organizations (name) values ('Rival CRM');
select tests.assert(
  (select count(*) = 0 from search_all('nina')),
  'search is org-scoped (RLS-invoker)');
select tests.assert(
  (select count(*) = 0 from search_all('barnhouse')),
  'no cross-org project/task leakage in search');

reset role;
select '10_crm: PASS';
