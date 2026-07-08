-- Phase 2 acceptance: task CRUD + subtasks + ordering, contractor scoping
-- (work yes, money never), @mention notifications, template application.

\set QUIET on
\pset tuples_only on

select tests.make_user('boss@studio.io')       as owner_u  \gset
select tests.make_user('shooter@studio.io')    as contra_u \gset
update profiles set is_active = true where id = :'contra_u'::uuid;
update org_members set role = 'contractor' where user_id = :'contra_u'::uuid;

-- ---------- fixtures (as the owner) ----------
select tests.become(:'owner_u');
set role authenticated;
insert into projects (name, start_date, photographers)
  values ('Shoot A', '2026-09-01', array['Freelance Fred']);
insert into projects (name, start_date) values ('Secret Project B', '2026-09-02');
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Lens', 200, current_date
  from projects p, categories c where p.name = 'Shoot A' and c.name = 'Equipment Rental';

-- link the contractor's login to the team member staffed on Shoot A
reset role;
update team_members set profile_id = :'contra_u'::uuid, email = 'shooter@studio.io'
  where display_name = 'Freelance Fred';
select tests.become(:'owner_u');
set role authenticated;

-- ---------- task CRUD, subtasks, ordering ----------
insert into task_sections (project_id, name, sort_order)
  select id, 'Pre-production', 1 from projects where name = 'Shoot A';
insert into tasks (project_id, section_id, title, priority, sort_order, assignee_id)
  select p.id, s.id, 'Scout location', 'high', 1024, tm.id
  from projects p
  join task_sections s on s.project_id = p.id
  join team_members tm on tm.display_name = 'Freelance Fred'
  where p.name = 'Shoot A';
insert into tasks (project_id, parent_task_id, title, sort_order)
  select t.project_id, t.id, 'Check permits', 512
  from tasks t where t.title = 'Scout location';

select tests.assert((select count(*) = 2 from tasks), 'task + subtask created');
select tests.assert(
  (select parent_task_id is not null from tasks where title = 'Check permits'),
  'subtask linked to parent');

-- assignment notified the contractor's login (checked as superuser — the
-- owner rightly cannot read someone else's inbox rows)
reset role;
select tests.assert(
  (select count(*) = 1 from notifications
    where recipient_id = :'contra_u'::uuid and kind = 'assigned'),
  'assignment notification created');
select tests.become(:'owner_u');
set role authenticated;

-- status flip tracks completion; board drag = status+order update
update tasks set status = 'done', sort_order = 2048 where title = 'Check permits';
select tests.assert(
  (select completed_at is not null from tasks where title = 'Check permits'),
  'done sets completed_at');
update tasks set status = 'todo' where title = 'Check permits';
select tests.assert(
  (select completed_at is null from tasks where title = 'Check permits'),
  'reopen clears completed_at');

-- @mention via the comment RPC
select add_task_comment(
  (select id from tasks where title = 'Scout location'),
  'Fred can you confirm the permit fees?',
  array[(select id from team_members where display_name = 'Freelance Fred')]);
reset role;
select tests.assert(
  (select count(*) = 1 from notifications
    where recipient_id = :'contra_u'::uuid and kind = 'mention'),
  '@mention notifies the mentioned login');

-- ---------- contractor scoping ----------
reset role;
select tests.become(:'contra_u');
set role authenticated;

-- work: staffed project only
select tests.assert((select count(*) = 2 from tasks), 'contractor sees staffed tasks');
select tests.assert(
  (select count(*) = 1 from v_contractor_projects where name = 'Shoot A'),
  'contractor sees the staffed project via the safe view');
select tests.assert(
  (select count(*) = 0 from v_contractor_projects where name = 'Secret Project B'),
  'unstaffed project invisible');
select tests.assert((select count(*) = 0 from projects), 'projects table itself stays closed');

-- contractor can work tasks + comment
update tasks set status = 'in_progress' where title = 'Scout location';
select tests.assert(
  (select status = 'in_progress' from tasks where title = 'Scout location'),
  'contractor updates own project''s task');
select add_task_comment((select id from tasks where title = 'Scout location'), 'Permits confirmed.', '{}');

-- money: never
select tests.assert((select count(*) = 0 from expenses),        'contractor: no expenses');
select tests.assert((select count(*) = 0 from invoices),        'contractor: no invoices');
select tests.assert((select count(*) = 0 from payments),        'contractor: no payments');
select tests.assert((select count(*) = 0 from pay_items),       'contractor: no pay items');
select tests.assert((select count(*) = 0 from member_rates),    'contractor: no rates');
select tests.assert((select count(*) = 0 from v_project_pnl),   'contractor: no P&L');
select tests.assert((select count(*) = 0 from v_invoice_totals),'contractor: no invoice totals');
select tests.assert((select count(*) = 0 from v_ar_aging),      'contractor: no AR');

-- notifications inbox: own rows only, mark-read works
select tests.assert((select count(*) = 2 from notifications), 'contractor inbox has its 2 items');
update notifications set read_at = now() where read_at is null;
select tests.assert((select count(*) = 0 from notifications where read_at is null), 'mark all read');

-- ---------- templates ----------
reset role;
select tests.become(:'owner_u');
set role authenticated;
insert into task_templates (name) values ('Wedding runbook');
insert into task_template_items (template_id, section_name, title, sort_order)
  select id, 'Pre-production', 'Client questionnaire', 1 from task_templates;
insert into task_template_items (template_id, section_name, title, sort_order)
  select id, 'Shoot day', 'Pack gear', 2 from task_templates;
insert into task_template_items (template_id, parent_item_id, title, sort_order)
  select t.id, i.id, 'Charge batteries', 1
  from task_templates t join task_template_items i on i.template_id = t.id
  where i.title = 'Pack gear';

select apply_task_template(
  (select id from task_templates),
  (select id from projects where name = 'Secret Project B')) as created \gset
select tests.assert(:created = 3, 'template created 3 tasks');
select tests.assert(
  (select count(*) = 2 from task_sections s
    join projects p on p.id = s.project_id where p.name = 'Secret Project B'),
  'template created its sections');
select tests.assert(
  (select t.parent_task_id is not null from tasks t
    join projects p on p.id = t.project_id
    where p.name = 'Secret Project B' and t.title = 'Charge batteries'),
  'template subtask nested under its parent');

reset role;
select '07_tasks: PASS';
