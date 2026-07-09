#!/usr/bin/env bash
# Deploy rehearsal: replays the LIVE database's real migration history —
# 0001–0006 + 0009 + 0010 applied, the ledger (0007/0008) never deployed —
# plants realistic production data (including the $0 photographer-pay
# placeholder rows that only exist because the GL triggers were missing),
# then applies the catch-up sequence exactly as it will run in production:
#
#     0007 → 0008 → 0011 → … → 0021
#
# Any exception fails the rehearsal. Run before every hand deploy.
set -euo pipefail

PGBIN="/opt/homebrew/opt/postgresql@17/bin"
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PGDATA="$ROOT/.pgdata"
export PGPORT=54329
export PGHOST="$PGDATA"
export PGUSER=postgres
DB=expense_tracker_live_sim
MIG="$ROOT/supabase/migrations"

"$PGBIN/pg_ctl" status >/dev/null 2>&1 || "$PGBIN/pg_ctl" start -l "$PGDATA/log" -w >/dev/null

run() { "$PGBIN/psql" -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$1"; }
sql() { "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

"$PGBIN/dropdb" --if-exists "$DB"
"$PGBIN/createdb" "$DB"

echo "── shim + LIVE's actual history (no 0007/0008)"
run "$ROOT/supabase/tests/shim/000_auth_shim.sql"
for f in 0001_schema 0002_rls 0003_audit 0004_views 0005_seed_categories \
         0006_project_type 0009_project_finances 0010_photographer_pay_sync; do
  run "$MIG/$f.sql"
done

echo "── plant production-shaped data"
"$PGBIN/psql" -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
\set QUIET on
\pset tuples_only on
-- the studio owner (first user → active admin)
select tests.make_user('lucas@studio.io') as owner \gset

-- years, projects with client names, client_paid balances, photographers[]
insert into years (year_value) values (2024), (2025);
insert into projects (year_id, name, client, location, status, start_date, end_date, client_paid, photographers)
select y.id, p.name, p.client, p.loc, p.status::project_status, p.sd::date, p.ed::date, p.paid, p.phs
from (values
  ('Acme Rebrand',   'Acme Co',  'Berlin', 'completed', '2024-03-01', '2024-04-30', 4500.00, array['Anna Lee','Ben Cruz']),
  ('Q4 Launch',      'Globex',   'NYC',    'completed', '2024-10-01', '2024-12-15', 8000.00, array['Anna Lee']),
  ('Spring Campaign','Initech',  'Lisbon', 'active',    '2025-03-15', null,         2000.00, array['Cara Diaz'])
) as p(name, client, loc, status, sd, ed, paid, phs)
join years y on y.year_value = extract(year from p.sd::date)::int;

-- the 0010 sync must have created $0 placeholder rows (works pre-ledger!)
select tests.assert(
  (select count(*) = 4 from expenses where amount = 0),
  'pre-ledger: sync created 4 x $0 placeholder pay rows');

-- real expenses
insert into expenses (project_id, category_id, description, amount, expense_date)
select p.id, c.id, e.descr, e.amt, e.d::date
from (values
  ('Acme Rebrand', 'Travel',            'Flights BER',      620.00, '2024-03-02'),
  ('Acme Rebrand', 'Equipment Rental',  'Lens kit',         340.00, '2024-03-05'),
  ('Q4 Launch',    'Catering',          'Crew lunch',       180.00, '2024-10-03'),
  ('Spring Campaign','Accommodation',   'Hotel Lisbon',     450.00, '2025-03-16')
) as e(proj, cat, descr, amt, d)
join projects p on p.name = e.proj
join categories c on c.name = e.cat;

-- the user filled in one photographer's real fee (the $0 → amount flow)
update expenses set amount = 450.00
  where amount = 0 and person_name = 'Anna Lee'
  and project_id = (select id from projects where name = 'Acme Rebrand');

select tests.assert((select count(*) = 3 from expenses where amount = 0),
  'one placeholder became a real fee; three remain at $0');
SQL

echo "── catch-up deploy: 0007, 0008, then 0011…0021 (production order)"
for f in 0007_double_entry 0008_backfill_journal; do
  echo "   $f"
  run "$MIG/$f.sql"
done

"$PGBIN/psql" -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
\set QUIET on
\pset tuples_only on
-- 0008 must have mirrored the 5 nonzero expenses (4 real + 1 filled-in fee)
-- and skipped the 3 remaining $0 placeholders.
select tests.assert((select count(*) = 5 from expense_journal_map), '0008: 5 expenses mirrored');
select tests.assert(
  (select count(*) = 0 from journal_lines where debit = 0 and credit = 0),
  '0008: no 0/0 lines anywhere');
select tests.assert(
  (select sum(debit) = sum(credit) from journal_lines), '0008: ledger balanced');
SQL

# Everything ≥ 0011, dynamically — a hardcoded list here went stale once and
# silently skipped new migrations.
for f in "$MIG"/00*.sql; do
  base="$(basename "$f")"
  ver="${base%%_*}"
  if [[ "$ver" > "0010" ]]; then
    echo "   $base"
    run "$f"
  fi
done

echo "── post-deploy verification (mirrors the SQL-editor checklist)"
"$PGBIN/psql" -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" <<'SQL'
\set QUIET on
\pset tuples_only on
select tests.assert((select count(*) = 1 from organizations), 'one default org');
select tests.assert((select count(*) = 1 from org_members where role = 'owner'), 'owner backfilled');
select tests.assert((select count(*) = 2 from accounts where code in ('5100','4800')), '5100 + 4800 provisioned');
-- 3 photographers + the owner's auto identity (0026)
select tests.assert((select count(*) = 4 from team_members), 'photographers[] + owner identity → 4 team members');
select tests.assert((select count(*) = 4 from project_members), '4 project memberships');
-- the 3 remaining $0 placeholders became draft pay items; expense rows gone
select tests.assert((select count(*) = 3 from pay_items where status = 'draft' and amount = 0),
  '$0 placeholders converted to draft pay items');
select tests.assert((select count(*) = 0 from expenses where amount = 0),
  'no $0 expense rows remain');
-- the filled-in $450 fee stayed a real expense (already-realized pay)
select tests.assert(
  (select count(*) = 1 from expenses where person_name = 'Anna Lee' and amount = 450.00),
  'realized pay expense untouched');
-- legacy client_paid → ledger-backed history
select tests.assert(
  (select count(*) = 3 from invoices where memo = 'Historical balance (pre-ledger)' and status = 'paid'),
  '3 legacy balances became paid invoices');
select tests.assert(
  (select sum(amount) = 14500.00 from payments where method = 'legacy'),
  'legacy payments total 4500+8000+2000');
select tests.assert(
  (select client_paid = 4500.00 from projects where name = 'Acme Rebrand'),
  'rollup reproduces the old numbers');
select tests.assert(
  (select revenue = 8000.00 from v_project_pnl where project_name = 'Q4 Launch'),
  'historical revenue is ledger-backed');
-- contacts created from client text and linked (I3)
select tests.assert(
  (select count(*) = 3 from contacts where source like 'backfill%'),
  'contacts backfilled from client text');
select tests.assert(
  (select count(*) = 0 from projects where client is not null and contact_id is null),
  'every client-named project linked to a contact');
-- periods + balance
select tests.assert((select count(*) = 0 from journal_entries where period_id is null),
  'every entry stamped with a period');
select tests.assert((select sum(debit) = sum(credit) from journal_lines), 'ledger balanced end-to-end');
-- guard active
do $$
begin
  update public.projects set client_paid = 1 where name = 'Acme Rebrand';
  raise exception 'GUARD FAILED: client_paid writable';
exception when check_violation then null;
end $$;
SQL

"$PGBIN/dropdb" "$DB"
echo "PASS: live-order deploy rehearsal is green (0007 → 0008 → 0011…0021)."
