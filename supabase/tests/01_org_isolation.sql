-- RLS suite: two orgs, full role matrix, zero cross-org reads or writes.
-- Runs under scripts/db-test.sh (single transaction, aborts on any exception).

\set QUIET on
\pset tuples_only on

-- ---------- fixtures ----------
-- Org A ("My Studio", the default org): owner + member(editor) + viewer + contractor.
-- Org B ("Rival Studio"): owner only.

select tests.make_user('owner-a@test.io')      as owner_a  \gset
select tests.make_user('member-a@test.io')     as member_a \gset
select tests.make_user('viewer-a@test.io')     as viewer_a \gset
select tests.make_user('contractor-a@test.io') as contra_a \gset
select tests.make_user('owner-b@test.io')      as owner_b  \gset

update profiles set is_active = true, role = 'editor' where id = :'member_a'::uuid;
update profiles set is_active = true where id in (:'viewer_a'::uuid, :'contra_a'::uuid, :'owner_b'::uuid);
update org_members set role = 'contractor' where user_id = :'contra_a'::uuid;

-- Detach owner_b from org A entirely and give them their own org.
delete from org_members where user_id = :'owner_b'::uuid;
update profiles set default_org_id = null where id = :'owner_b'::uuid;
select tests.become(:'owner_b');
set role authenticated;
insert into organizations (name) values ('Rival Studio');
reset role;

-- Org A seed data (as the owner).
select tests.become(:'owner_a');
set role authenticated;
insert into years (year_value) values (2026);
insert into projects (year_id, name, start_date, photographers)
  select id, 'Shoot A', '2026-06-01', array['Anna Lee'] from years where year_value = 2026;
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Lens rental', 300.00, '2026-06-02'
  from projects p, categories c where p.name = 'Shoot A' and c.name = 'Equipment Rental';
update pay_items set amount = 500.00 where amount = 0;
select approve_pay_item(id) from pay_items where status = 'draft';
insert into team_members (display_name) values ('Rate Holder');
insert into member_rates (team_member_id, cost_rate, bill_rate)
  select id, 60, 120 from team_members where display_name = 'Rate Holder';
reset role;

-- Org B seed data.
select tests.become(:'owner_b');
set role authenticated;
insert into years (year_value) values (2026);   -- same value, different org
insert into projects (year_id, name) select id, 'Shoot B' from years where year_value = 2026;
reset role;

-- ---------- cross-org invisibility (owner B vs org A data) ----------

select tests.become(:'owner_b');
set role authenticated;
select tests.assert((select count(*) = 1 from years),          'B sees exactly one year (its own)');
select tests.assert((select count(*) = 1 from projects),       'B sees only its project');
select tests.assert((select count(*) = 0 from expenses),       'B sees no A expenses');
select tests.assert((select count(*) = 0 from pay_items),      'B sees no A pay items');
-- Since 0026 every non-viewer member has an auto roster identity, so B sees
-- exactly one team member: themself, in their own org — never A's people.
select tests.assert(
  (select count(*) = 1 from team_members)
  and (select count(*) = 0 from team_members
       where org_id <> (select default_org_id from profiles where id = auth.uid())),
  'B sees only their own org''s roster (their auto identity)');
select tests.assert((select count(*) = 0 from member_rates),   'B sees no A rates');
select tests.assert((select count(*) = 0 from journal_entries),'B sees no A journal entries');
select tests.assert((select count(*) = 0 from audit_log where org_id <> (select default_org_id from profiles where id = auth.uid())), 'B sees no foreign audit rows');
select tests.assert((select count(*) = 1 from v_project_rollup), 'views scoped: one project rollup');
select tests.assert((select coalesce(sum(cogs),0) = 0 from v_project_pnl), 'views scoped: no A pay in B P&L');

-- cross-org WRITES rejected: B attaches an expense to A's project by uuid.
-- (psql vars don't interpolate inside $$-bodies; pass them via GUCs.)
reset role;
select set_config('tests.a_project', (select id::text from projects where name = 'Shoot A'), false);
select set_config('tests.b_cat', (
  select c.id::text from categories c join organizations o on o.id = c.org_id
  where o.name = 'Rival Studio' and c.name = 'Misc'), false);
select tests.become(:'owner_b');
set role authenticated;
do $$
begin
  insert into public.expenses (project_id, category_id, description, amount, expense_date)
  values (current_setting('tests.a_project')::uuid, current_setting('tests.b_cat')::uuid,
          'sneaky', 1.00, current_date);
  raise exception 'GUARD FAILED: cross-org expense accepted';
exception when check_violation then null;
end $$;
reset role;

-- ---------- role matrix inside org A ----------

-- member (legacy editor): read + write operational data, never rates, no approvals.
select tests.become(:'member_a');
set role authenticated;
select tests.assert((select count(*) > 0 from projects),      'member reads projects');
select tests.assert((select count(*) > 0 from expenses),      'member reads expenses');
select tests.assert((select count(*) = 0 from member_rates),  'member cannot read rates');
insert into expenses (project_id, category_id, description, amount, expense_date)
  select p.id, c.id, 'Member expense', 20.00, current_date
  from projects p, categories c where p.name = 'Shoot A' and c.name = 'Misc';
do $$
begin
  perform approve_pay_item(id) from pay_items where status = 'draft' limit 1;
exception when others then null;  -- no drafts is fine; approval denial tested in 03
end $$;
reset role;

-- viewer: read yes, write no.
select tests.become(:'viewer_a');
set role authenticated;
select tests.assert((select count(*) > 0 from expenses), 'viewer reads expenses');
select tests.assert((select count(*) > 0 from v_year_rollup), 'viewer reads rollups');
select tests.assert((select count(*) = 0 from member_rates), 'viewer cannot read rates');
do $$
begin
  insert into public.years (year_value) values (2031);
  raise exception 'GUARD FAILED: viewer inserted a year';
exception when insufficient_privilege or check_violation then null;
end $$;
do $$
declare n int;
begin
  update public.expenses set description = 'defaced';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'GUARD FAILED: viewer updated % expense rows', n; end if;
end $$;
reset role;

-- contractor: no financial reads at all; sees no roster rows (not linked).
select tests.become(:'contra_a');
set role authenticated;
select tests.assert((select count(*) = 0 from years),           'contractor: no years');
select tests.assert((select count(*) = 0 from projects),        'contractor: no projects');
select tests.assert((select count(*) = 0 from expenses),        'contractor: no expenses');
select tests.assert((select count(*) = 0 from categories),      'contractor: no categories');
select tests.assert((select count(*) = 0 from accounts),        'contractor: no accounts');
select tests.assert((select count(*) = 0 from journal_entries), 'contractor: no journal');
select tests.assert((select count(*) = 0 from pay_items),       'contractor: no pay items');
select tests.assert((select count(*) = 0 from member_rates),    'contractor: no rates');
select tests.assert((select count(*) = 0 from v_project_pnl),   'contractor: no P&L');
select tests.assert((select count(*) = 0 from v_year_rollup),   'contractor: no rollups');
reset role;

-- inactive user: nothing, not even via views.
select tests.make_user('inactive@test.io') as inactive_u \gset
select tests.become(:'inactive_u');
set role authenticated;
select tests.assert((select count(*) = 0 from years), 'inactive: no base tables');
select tests.assert((select count(*) = 0 from v_year_rollup), 'inactive: no views');
reset role;

select '01_org_isolation: PASS';
