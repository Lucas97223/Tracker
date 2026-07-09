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

-- ---------- merge_team_members (0030): the Afrik ⇄ armandoafrik case ----------
-- Plant the production shape: an unlinked roster name AND a linked auto
-- identity for the same human, each carrying references.
select tests.become(:'owner_u');
set role authenticated;
insert into team_members (display_name) values ('Rik');   -- roster name, unlinked
insert into projects (name, start_date, photographers)
  values ('Merge Gig', '2026-12-01', array['Rik']);        -- staffing + draft pay on 'Rik'
reset role;
select set_config('tests.rik', (select id::text from team_members where display_name = 'Rik'), false);
select set_config('tests.owner_tm', (
  select id::text from team_members where profile_id = :'owner_u'::uuid), false);
-- the linked identity logged time meanwhile
insert into time_entries (org_id, project_id, team_member_id, started_at, minutes)
select p.org_id, p.id, current_setting('tests.owner_tm')::uuid, now() - interval '2 hours', 60
from projects p where p.name = 'Merge Gig';

select tests.become(:'owner_u');
set role authenticated;
select merge_team_members(current_setting('tests.rik')::uuid,
                          current_setting('tests.owner_tm')::uuid);

select tests.assert(
  (select profile_id = :'owner_u'::uuid from team_members
    where id = current_setting('tests.rik')::uuid),
  'merge: keeper inherits the login link');
select tests.assert(
  (select count(*) = 0 from team_members where id = current_setting('tests.owner_tm')::uuid),
  'merge: duplicate row gone');
select tests.assert(
  (select count(*) = 1 from time_entries
    where team_member_id = current_setting('tests.rik')::uuid and minutes = 60),
  'merge: time entries repointed');
select tests.assert(
  (select count(*) >= 1 from pay_items
    where team_member_id = current_setting('tests.rik')::uuid),
  'merge: pay items repointed');

reset role;
select '09_timer_identity: PASS';
