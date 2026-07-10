-- Automations: actions fire on business events, are logged, never cascade
-- (loop detection), never spam (rate cap), and never break the business op.

\set QUIET on
\pset tuples_only on

select tests.make_user('auto-owner@t.io') as owner_u \gset
select tests.become(:'owner_u');
set role authenticated;

insert into contacts (name, email) values ('Automated Amy', 'amy@auto.io');
insert into projects (name, start_date, contact_id)
  select 'Auto Project', '2027-05-01', id from contacts;
insert into invoices (contact_id, project_id)
  select c.id, p.id from contacts c, projects p;
insert into invoice_lines (invoice_id, description, qty, unit_price, line_number)
  select id, 'Coverage', 1, 500.00, 1 from invoices;
update invoices set status = 'sent';

-- rule: invoice paid → thank-you task
insert into automations (name, trigger_event, action, action_config)
values ('Thank-you after payment', 'invoice_paid', 'create_task',
        '{"title": "Send thank-you + gallery link", "due_days": 3}'::jsonb);
-- rule: new project → notify admins
insert into automations (name, trigger_event, action, action_config)
values ('New project ping', 'project_created', 'notify',
        '{"message": "A project was created"}'::jsonb);

-- ---------- invoice_paid fires ----------
select record_payment((select id from invoices), 500.00);
select set_config('app.payment_rpc', '', true);
select set_config('app.invoice_rpc', '', true);

select tests.assert(
  (select count(*) = 1 from tasks where title = 'Send thank-you + gallery link'),
  'invoice_paid automation created the task');
select tests.assert(
  (select due_date = current_date + 3 from tasks where title like 'Send thank-you%'),
  'due_days config respected');
select tests.assert(
  (select count(*) = 1 from automation_runs where status = 'ok' and trigger_event = 'invoice_paid'),
  'run logged ok');

-- ---------- project_created fires + loop detection ----------
-- Creating a project notifies; the automation-created TASK from above must
-- not have triggered anything (tasks aren't a trigger, and depth guards
-- cascades in general).
insert into projects (name, start_date) values ('Second Auto Project', '2027-06-01');
reset role;
select tests.assert(
  (select count(*) >= 1 from notifications where kind = 'automation'),
  'project_created automation notified admins');
select tests.become(:'owner_u');
set role authenticated;

-- apply_template action driven by project_created must not re-fire
-- project_created handlers for its own work (depth guard).
insert into task_templates (name) values ('Kickoff');
insert into task_template_items (template_id, title, sort_order)
  select id, 'Kickoff call', 1 from task_templates;
insert into automations (name, trigger_event, action, action_config)
select 'Kickoff on new project', 'project_created', 'apply_template',
       jsonb_build_object('template_id', (select id from task_templates));
insert into projects (name, start_date) values ('Third Auto Project', '2027-07-01');
select tests.assert(
  (select count(*) = 1 from tasks t join projects p on p.id = t.project_id
    where p.name = 'Third Auto Project' and t.title = 'Kickoff call'),
  'apply_template automation built the kickoff task');
select tests.assert(
  (select count(*) = 0 from automation_runs where status = 'error'),
  'no errored runs so far');

-- ---------- failure isolation ----------
-- A broken rule (missing template) logs an error/skip but the business op
-- (project insert) succeeds.
insert into automations (name, trigger_event, action, action_config)
values ('Broken rule', 'project_created', 'apply_template', '{}'::jsonb);
insert into projects (name, start_date) values ('Fourth Auto Project', '2027-08-01');
select tests.assert(
  (select count(*) = 1 from projects where name = 'Fourth Auto Project'),
  'business op survives a broken automation');
select tests.assert(
  (select count(*) >= 1 from automation_runs where status = 'skipped'
    and detail like '%template_id%'),
  'broken rule logged as skipped with a reason');

-- ---------- rate cap ----------
insert into forms (name) values ('Cap Form');
insert into form_fields (form_id, label, kind, required, sort_order)
  select id, 'Email', 'email', true, 1 from forms;
insert into automations (name, trigger_event, action, action_config)
values ('Lead ping', 'form_response', 'notify', '{"message": "New lead"}'::jsonb);
reset role;
select set_config('tests.cap_form', (select share_token::text from forms where name = 'Cap Form'), false);
select set_config('tests.cap_field', (select id::text from form_fields
  where form_id = (select id from forms where name = 'Cap Form')), false);
set role anon;
do $$
declare i int;
begin
  for i in 1..25 loop
    perform public.submit_lead_form(
      current_setting('tests.cap_form')::uuid,
      jsonb_build_object(current_setting('tests.cap_field'), 'capped@lead.io'));
  end loop;
end $$;
reset role;
select tests.assert(
  (select count(*) between 1 and 20 from automation_runs r
    where r.trigger_event = 'form_response' and r.status = 'ok'
      and r.context ->> 'contact_id' = (
        select id::text from contacts where email = 'capped@lead.io')),
  'per-contact daily cap holds under a submission flood');
select tests.assert(
  (select count(*) >= 5 from automation_runs
    where trigger_event = 'form_response' and status = 'skipped'
      and detail like '%rate cap%'),
  'excess runs logged as rate-capped');

select '14_automations: PASS';
