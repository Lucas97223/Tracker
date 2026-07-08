#!/usr/bin/env bash
# Shadow-database test runner.
#
# Boots a project-local PostgreSQL 17 cluster (./.pgdata, gitignored), rebuilds
# the test database from scratch — auth shim, then every migration in order —
# and runs every SQL test in supabase/tests/*.sql. Any raised exception fails
# the run. Usage:
#   scripts/db-test.sh            # full rebuild + all tests
#   scripts/db-test.sh --keep    # leave the DB around for psql inspection
#   scripts/db-test.sh --stop    # stop the local cluster
set -euo pipefail

PGBIN="/opt/homebrew/opt/postgresql@17/bin"
# macOS: without a concrete locale the postmaster aborts ("became multithreaded
# during startup") because CoreFoundation locale lookup spawns a thread.
export LC_ALL=C
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PGDATA="$ROOT/.pgdata"
export PGPORT=54329
export PGHOST="$PGDATA"           # unix socket inside the data dir
export PGUSER=postgres
DB=expense_tracker_test

if [[ "${1:-}" == "--stop" ]]; then
  "$PGBIN/pg_ctl" stop -m fast || true
  exit 0
fi

if [[ ! -d "$PGDATA" ]]; then
  "$PGBIN/initdb" --auth=trust -U postgres -E UTF8 --no-instructions >/dev/null
  echo "unix_socket_directories = '$PGDATA'" >> "$PGDATA/postgresql.conf"
  echo "port = $PGPORT" >> "$PGDATA/postgresql.conf"
  echo "listen_addresses = ''" >> "$PGDATA/postgresql.conf"
fi

"$PGBIN/pg_ctl" status >/dev/null 2>&1 || "$PGBIN/pg_ctl" start -l "$PGDATA/log" -w >/dev/null

"$PGBIN/dropdb" --if-exists "$DB"
"$PGBIN/createdb" "$DB"

# -1: each file runs in a single transaction, matching `supabase db push`.
run() { "$PGBIN/psql" -X -q -1 -v ON_ERROR_STOP=1 -d "$DB" -f "$1"; }

echo "── shim"
run "$ROOT/supabase/tests/shim/000_auth_shim.sql"

echo "── migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "   $(basename "$f")"
  run "$f"
done

echo "── tests"
shopt -s nullglob
tests=("$ROOT"/supabase/tests/*.sql)
if [[ ${#tests[@]} -eq 0 ]]; then
  echo "   (no test files yet)"
else
  for f in "${tests[@]}"; do
    echo "   $(basename "$f")"
    run "$f"
  done
fi

echo "PASS: all migrations applied and all tests green."

if [[ "${1:-}" != "--keep" ]]; then
  :  # cluster stays up for fast re-runs; DB is rebuilt each invocation
fi
