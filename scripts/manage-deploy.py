#!/usr/bin/env python3
"""Deploy driver for the Supabase Management API (HTTPS only — works when
direct Postgres ports are unreachable). Token comes from SUPABASE_ACCESS_TOKEN.

Phases (run in order, each is a subcommand so a human can eyeball between):
    check      token works, project healthy, backups exist, migration state
    snapshot   JSON dump of all business data to backups/<timestamp>/
    migrate    apply the catch-up sequence 0007, 0008, 0011..0021 (one call
               per file, stops hard on the first error)
    verify     post-deploy assertions + record supabase_migrations versions
"""
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

REF = "biwnmfauratqfbywxxtz"
API = "https://api.supabase.com"
ROOT = pathlib.Path(__file__).resolve().parent.parent
MIG = ROOT / "supabase" / "migrations"

DEPLOY_ORDER = [
    "0007_double_entry.sql",
    "0008_backfill_journal.sql",
    "0011_organizations.sql",
    "0012_org_rls_rewrite.sql",
    "0013_team_members.sql",
    "0014_pay_items.sql",
    "0015_rates_audit_coa.sql",
    "0016_contacts.sql",
    "0017_invoicing.sql",
    "0018_payments.sql",
    "0019_client_paid_rollup.sql",
    "0020_vendors_years.sql",
    "0021_public_invoice.sql",
]

SNAPSHOT_TABLES = [
    "profiles", "years", "projects", "categories", "expenses",
    "project_members", "audit_log",
]


def token() -> str:
    t = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not t.startswith("sbp_"):
        sys.exit("SUPABASE_ACCESS_TOKEN missing or malformed")
    return t


def req(method: str, path: str, body=None):
    r = urllib.request.Request(
        API + path,
        method=method,
        headers={
            "Authorization": f"Bearer {token()}",
            "Content-Type": "application/json",
            # Cloudflare fronting api.supabase.com rejects urllib's default
            # user agent (error 1010); anything explicit passes.
            "User-Agent": "expense-tracker-deploy/1.0 (+curl-compatible)",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def query(sql: str):
    """Run SQL through the project query endpoint. Returns rows (list) or
    raises SystemExit with the server's error."""
    status, body = req("POST", f"/v1/projects/{REF}/database/query", {"query": sql})
    if status not in (200, 201):
        raise SystemExit(f"QUERY FAILED (HTTP {status}):\n{body}")
    return body


def phase_check():
    status, projects = req("GET", "/v1/projects")
    if status != 200:
        sys.exit(f"token rejected (HTTP {status}): {projects}")
    proj = next((p for p in projects if p.get("id") == REF), None)
    if not proj:
        sys.exit(f"token works but has no access to project {REF}")
    print(f"project: {proj.get('name')} · region {proj.get('region')} · status {proj.get('status')}")

    status, backups = req("GET", f"/v1/projects/{REF}/database/backups")
    if status == 200 and isinstance(backups, dict):
        n = len(backups.get("backups", []))
        pitr = backups.get("pitr_enabled")
        print(f"backups: {n} available · PITR {'on' if pitr else 'off'}")
    else:
        print(f"backups: endpoint answered HTTP {status} (non-fatal)")

    rows = query("""
        select
          exists(select 1 from information_schema.columns
                 where table_name='projects' and column_name='project_type')  as m0006,
          to_regclass('public.accounts') is not null                          as m0007,
          exists(select 1 from information_schema.triggers
                 where trigger_name='expenses_to_journal_insert')             as m0008,
          exists(select 1 from information_schema.columns
                 where table_name='projects' and column_name='client_paid')   as m0009,
          exists(select 1 from information_schema.columns
                 where table_name='expenses' and column_name='person_name')   as m0010,
          to_regclass('public.organizations') is not null                     as m0011
    """)
    print("migration state:", rows[0])

    rows = query("""
        select (select count(*) from profiles)                    as profiles,
               (select count(*) from years)                       as years,
               (select count(*) from projects)                    as projects,
               (select count(*) from expenses)                    as expenses,
               (select count(*) from expenses where amount = 0)   as zero_expenses,
               (select count(distinct ph) from projects, unnest(photographers) ph) as photographers,
               (select coalesce(sum(client_paid),0) from projects) as client_paid_total,
               (select count(*) from categories)                  as categories
    """)
    print("data shape:", rows[0])


def phase_snapshot():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    outdir = ROOT / "backups" / stamp
    outdir.mkdir(parents=True, exist_ok=True)
    total = 0
    for t in SNAPSHOT_TABLES:
        rows = query(f"select coalesce(json_agg(t), '[]'::json) as data from public.{t} t")
        data = rows[0]["data"]
        if isinstance(data, str):
            data = json.loads(data)
        (outdir / f"{t}.json").write_text(json.dumps(data, indent=1, default=str))
        print(f"  {t}: {len(data)} rows")
        total += len(data)
    print(f"snapshot: {total} rows → {outdir}")


def phase_migrate():
    applied = []
    for name in DEPLOY_ORDER:
        sql = (MIG / name).read_text()
        print(f"  applying {name} ({len(sql)} bytes)…", flush=True)
        try:
            query(sql)
        except SystemExit as e:
            print(f"\nSTOPPED at {name}. Applied so far: {applied or 'none'}")
            raise
        applied.append(name)
    print(f"migrate: all {len(applied)} files applied")


def phase_verify():
    rows = query("""
        select
          (select count(*) from organizations)                                as orgs,
          (select count(*) from org_members)                                  as org_members,
          (select count(*) from accounts where code in ('5100','4800'))       as new_accounts,
          (select count(*) from team_members)                                 as team_members,
          (select count(*) from project_members)                              as memberships,
          (select count(*) from pay_items where status = 'draft')             as draft_pay,
          (select count(*) from expenses where amount = 0)                    as zero_expenses,
          (select count(*) from invoices
             where memo = 'Historical balance (pre-ledger)')                  as legacy_invoices,
          (select coalesce(sum(amount),0) from payments where method='legacy') as legacy_paid,
          (select count(*) from contacts)                                     as contacts,
          (select count(*) from journal_entries where period_id is null)      as unstamped,
          (select sum(debit) = sum(credit) from journal_lines)                as ledger_balanced
    """)
    print("post-deploy:", json.dumps(rows[0], indent=1))

    # Make future `supabase db push` aware of what's applied.
    versions = sorted(p.name.split("_", 1) for p in MIG.glob("0*.sql"))
    stmts = ["create schema if not exists supabase_migrations",
             """create table if not exists supabase_migrations.schema_migrations
                (version text primary key, statements text[], name text)"""]
    for v, rest in versions:
        n = rest.removesuffix(".sql").replace("'", "''")
        stmts.append(
            "insert into supabase_migrations.schema_migrations (version, name) "
            f"values ('{v}', '{n}') on conflict (version) do nothing")
    query(";\n".join(stmts))
    print(f"schema_migrations: {len(versions)} versions recorded")


if __name__ == "__main__":
    phase = sys.argv[1] if len(sys.argv) > 1 else ""
    {
        "check": phase_check,
        "snapshot": phase_snapshot,
        "migrate": phase_migrate,
        "verify": phase_verify,
    }.get(phase, lambda: sys.exit(f"usage: {sys.argv[0]} check|snapshot|migrate|verify"))()
