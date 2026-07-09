-- 0026 hotfix: org members always have a team-member identity, so the timer
-- works out of the box — the exact failure the first real user hit.

\set QUIET on
\pset tuples_only on

select tests.make_user('solo@studio.io') as owner_u \gset

-- backfill/trigger: the bootstrap owner has an identity without doing anything
select tests.assert(
  (select count(*) = 1 from team_members where profile_id = :'owner_u'::uuid),
  'owner gets a team-member identity automatically');

select tests.become(:'owner_u');
set role authenticated;
insert into projects (name, start_date) values ('First Gig', '2026-11-01');

-- timer works immediately, no manual linking
select start_timer((select id from projects where name = 'First Gig'), null, null, true);
select tests.assert(
  (select count(*) = 1 from time_entries where minutes is null),
  'timer starts for the owner out of the box');
select stop_timer();

-- no duplicate identity was created along the way
select tests.assert(
  (select count(*) = 1 from team_members where profile_id = :'owner_u'::uuid),
  'no duplicate identity from start_timer');

-- claim path: an unlinked roster row matching a new user's email gets LINKED,
-- not duplicated
insert into team_members (display_name, email) values ('Bea Cruz', 'bea@studio.io');
reset role;
select tests.make_user('bea@studio.io') as bea_u \gset
update profiles set is_active = true, role = 'editor' where id = :'bea_u'::uuid;
select tests.assert(
  (select count(*) = 1 from team_members
    where lower(coalesce(email, '')) = 'bea@studio.io'),
  'claim: still exactly one roster row for Bea');
select tests.assert(
  (select profile_id = :'bea_u'::uuid from team_members
    where lower(coalesce(email, '')) = 'bea@studio.io'),
  'claim: the existing row now carries her login');

-- and her timer works too
select set_config('tests.gig', (select id::text from projects where name = 'First Gig'), false);
select tests.become(:'bea_u');
set role authenticated;
select start_timer(current_setting('tests.gig')::uuid);
select tests.assert(
  (select count(*) = 1 from time_entries te
    join team_members tm on tm.id = te.team_member_id
    where tm.profile_id = :'bea_u'::uuid and te.minutes is null),
  'claimed identity can run the timer');
select stop_timer();

reset role;
select '09_timer_identity: PASS';
