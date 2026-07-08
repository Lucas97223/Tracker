-- Single-org regression: the pre-Phase-0.5 feature set keeps working for a
-- normal studio, plus bootstrap/audit checks and the 42702 category fix.

\set QUIET on
\pset tuples_only on

-- ---------- bootstrap chain ----------
-- Fresh database: first signup becomes an active admin AND owner of the
-- default org; later signups are inactive viewers auto-joined to the single
-- org, so activating them stays the admin's only step (invite-only UX).
select tests.make_user('studio-admin@test.io') as admin_u \gset
select tests.assert(
  (select role = 'admin' and is_active from profiles where id = :'admin_u'::uuid),
  'first signup: active admin');
select tests.assert(
  (select role = 'owner' from org_members where user_id = :'admin_u'::uuid),
  'first signup: org owner');

select tests.make_user('newcomer@test.io') as newbie \gset
select tests.assert(
  (select role = 'viewer' and is_active = false from profiles where id = :'newbie'::uuid),
  'new signup: inactive viewer');
select tests.assert(
  (select role = 'viewer' from org_members where user_id = :'newbie'::uuid),
  'single-org instance: signup auto-joins as org viewer');

-- Activating + promoting via the legacy Admin page path mirrors into org role.
select tests.make_user('studio-editor@test.io') as editor_u \gset
update profiles set is_active = true, role = 'editor' where id = :'editor_u'::uuid;
select tests.assert(
  (select role = 'member' from org_members where user_id = :'editor_u'::uuid),
  'profiles.role=editor mirrors to org member');

-- ---------- editor day-to-day flow ----------
select tests.become(:'editor_u');
set role authenticated;
insert into years (year_value) values (2030);
insert into projects (year_id, name, client, location, client_paid)
  select id, 'Regression Shoot', 'Acme', 'Berlin', 2000.00 from years where year_value = 2030;
insert into expenses (project_id, category_id, description, amount, expense_date, location)
  select p.id, c.id, 'Flight', 350.00, '2030-05-02', 'Berlin'
  from projects p, categories c where p.name = 'Regression Shoot' and c.name = 'Travel';
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Hotel', 150.00, '2030-05-03'
  from projects p, categories c where p.name = 'Regression Shoot' and c.name = 'Accommodation';
update expenses set amount = 175.00 where description = 'Hotel';

-- client_paid remains directly editable in Phase 0.5. Phase 1 derives it from
-- payments and write-blocks it — this assertion is EXPECTED TO FLIP then.
update projects set client_paid = 2500.00 where name = 'Regression Shoot';
select tests.assert(
  (select client_paid = 2500.00 from projects where name = 'Regression Shoot'),
  'client_paid editable until the Phase 1 rollup lands');

-- rollup parity: view totals equal table sums
select tests.assert(
  (select r.total_amount = (select coalesce(sum(amount), 0) from expenses e
     join projects p on p.id = e.project_id where p.name = 'Regression Shoot')
   from v_project_rollup r where r.name = 'Regression Shoot'),
  'v_project_rollup matches expense sum');
select tests.assert(
  (select total_amount = 525.00 from v_year_rollup where year_value = 2030),
  'v_year_rollup totals the year');
select tests.assert(
  (select expense = 525.00 from v_project_pnl where project_name = 'Regression Shoot'),
  'ledger P&L expense column matches (mirror parity)');
reset role;

-- ---------- category creation works (the 42702 fix) ----------
select tests.become(:'admin_u');
set role authenticated;
insert into categories (name, color, description) values ('Insurance', '#0ea5e9', 'Gear + liability');
select tests.assert(
  (select a.code ~ '^6[0-9]{3}$' and a.type = 'expense'
     from categories c join accounts a on a.id = c.account_id where c.name = 'Insurance'),
  'new category auto-creates its expense account (42702 regression)');

-- audit rows are org-stamped and visible to the org admin
select tests.assert(
  (select count(*) > 0 from audit_log
    where entity_type = 'expense' and org_id is not null),
  'expense audit rows carry org_id');
select tests.assert(
  (select count(*) > 0 from audit_log where entity_type = 'journal_entry'),
  'journal entries are audited');
reset role;

select '04_regression_and_audit: PASS';
