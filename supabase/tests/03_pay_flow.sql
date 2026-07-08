-- Draft-then-approve team pay: the Phase 0.5 acceptance flow.
-- NOTE: this whole file is one transaction and approve/void set a txn-local
-- guard-bypass GUC — every guard test either runs before the first RPC call
-- or explicitly clears the flag first.

\set QUIET on
\pset tuples_only on

select tests.make_user('pay-owner@test.io')  as owner_u  \gset
select tests.make_user('pay-editor@test.io') as editor_u \gset
update profiles set is_active = true, role = 'editor' where id = :'editor_u'::uuid;

select tests.become(:'owner_u');
set role authenticated;
insert into years (year_value) values (2026);
insert into projects (year_id, name, start_date, photographers)
  select id, 'Pay Proj', '2026-09-01', array['Anna Lee', 'Ben Cruz'] from years where year_value = 2026;

-- drafts exist; zero GL / zero expense footprint
select tests.assert((select count(*) = 2 from pay_items where status = 'draft'), 'two drafts');
select tests.assert((select count(*) = 0 from expenses), 'no placeholder expenses');
select tests.assert((select count(*) = 0 from journal_entries), 'drafts post nothing');
select tests.assert(
  (select coalesce(sum(cogs) + sum(expense) + sum(revenue), 0) = 0 from v_project_pnl),
  'drafts never appear in P&L');

-- direct membership insert also drafts
insert into team_members (display_name) values ('Cara Diaz');
insert into project_members (project_id, team_member_id, role_label, agreed_pay)
  select p.id, tm.id, 'Assistant', 250.00 from projects p, team_members tm
  where p.name = 'Pay Proj' and tm.display_name = 'Cara Diaz';
select tests.assert(
  (select count(*) = 1 from pay_items pi join team_members tm on tm.id = pi.team_member_id
    where tm.display_name = 'Cara Diaz' and pi.status = 'draft' and pi.amount = 250.00),
  'adding a member creates a draft seeded from agreed_pay');

-- guards, all before any RPC runs in this transaction:
do $$
begin
  update public.pay_items set status = 'approved' where status = 'draft';
  raise exception 'GUARD FAILED: direct approve';
exception when check_violation then null;
end $$;

do $$
begin
  perform public.approve_pay_item(id) from public.pay_items where status = 'draft' limit 1;
  raise exception 'GUARD FAILED: $0 draft approved';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;

reset role;
select tests.become(:'editor_u');
set role authenticated;
do $$
declare v uuid;
begin
  select id into v from public.pay_items
    join public.team_members tm on tm.id = team_member_id
    where tm.display_name = 'Cara Diaz';
  perform public.approve_pay_item(v);
  raise exception 'GUARD FAILED: editor (member role) approved pay';
exception when others then
  if sqlerrm like '%GUARD FAILED%' then raise; end if;
end $$;
reset role;

-- approve as owner
select tests.become(:'owner_u');
set role authenticated;
update pay_items set amount = 500.00
  where team_member_id = (select id from team_members where display_name = 'Anna Lee');
select approve_pay_item(id) from pay_items where amount = 500.00 and status = 'draft';
select set_config('app.pay_item_rpc', '', true);  -- clear txn-local bypass

select tests.assert(
  (select sum(debit) = 500.00 and sum(credit) = 500.00 from journal_lines),
  'approval posted one balanced entry');
select tests.assert(
  (select a.code = '5100' from journal_lines jl join accounts a on a.id = jl.account_id where jl.debit > 0),
  'DR 5100 Team Pay');
select tests.assert(
  (select a.code = '2000' from journal_lines jl join accounts a on a.id = jl.account_id where jl.credit > 0),
  'CR 2000 Accounts Payable');
select tests.assert(
  (select cogs = 500.00 from v_project_pnl where project_name = 'Pay Proj'),
  'approved pay = project COGS');
select tests.assert(
  (select source_type = 'pay_item' from journal_entries where posted limit 1),
  'entry tagged pay_item');

-- approved rows are immutable outside the RPCs
do $$
begin
  update public.pay_items set amount = 9999 where status = 'approved';
  raise exception 'GUARD FAILED: approved row edited';
exception when check_violation then null;
end $$;
do $$
begin
  delete from public.pay_items where status = 'approved';
  raise exception 'GUARD FAILED: approved row deleted';
exception when check_violation then null;
end $$;

-- void reverses; P&L returns to zero
select void_pay_item(id) from pay_items where status = 'approved';
select set_config('app.pay_item_rpc', '', true);
select tests.assert(
  (select cogs = 0 from v_project_pnl where project_name = 'Pay Proj'),
  'void restores P&L to zero');
select tests.assert(
  (select count(*) = 1 from journal_entries where reversed_by is not null),
  'original entry marked reversed');
select tests.assert(
  (select count(*) = 2 from journal_entries),
  'reversal added, nothing deleted');

-- drafts may simply be deleted
delete from pay_items where status = 'draft';
select tests.assert((select count(*) = 0 from pay_items where status = 'draft'), 'drafts deletable');

reset role;
select '03_pay_flow: PASS';
