# PROGRESS.md

> Living status file for the CLAUDE-BUILD-SPEC.md build. Updated at every phase gate and whenever scope moves.

## Current state

- **Phase:** 1 — Money in — **in progress** (gate 0.5 passed 2026-07-08; user approved proceeding)
- **Live deployment: BLOCKED on credentials (2026-07-08).**
  - DB password provided ("Ttlljjmm6") **fails authentication** against `db.biwnmfauratqfbywxxtz.supabase.co` (connection reachable; `FATAL: password authentication failed`). Needs the exact password or a reset: Supabase Dashboard → Project Settings → Database. Migrations 0011+ stay repo-only until then.
  - GitHub `https://github.com/Lucas97223/Tracker` reachable; its initial README commit is merged into local `main`, but **push needs auth** (no `gh` CLI, no stored token). Either install/log in `gh auth login`, or provide a PAT.
- **Phase 1 scope:** contacts + `projects.contact_id`; tax_rates/invoices/lines/schedules; payment RPCs posting `DR cash / CR revenue (+ CR tax liability)` in one transaction; `client_paid` derived + write-blocked (legacy balances become backfilled invoices+payments so history turns ledger-backed); UI money tiles switch to GL views; reports page (first ledger UI); AR aging; vendors + 1099 view; `years` demotion (D-D); accounting-period auto-assignment (closes recon gap #3).
- **Known Phase-1 gate items:** overdue-reminder *sending* needs an ESP choice + API key (aging view/UI ship regardless); Edge Function deploys would also need a Supabase access token.

## Phase 0.5 gate summary

### Shipped (migrations 0011–0015, all reversible-by-restore, never editing applied ones)

| # | Migration | Contents |
|---|---|---|
| 0011 | organizations | orgs, org_members (owner/admin/member/contractor/viewer), org_id on every table + backfill to default org "My Studio", per-org uniques (year_value, category name, account code, period range), org auto-fill triggers, org-aware signup bootstrap |
| 0012 | org RLS rewrite | every policy org-scoped (legacy mapping: admin→owner/admin, editor→member, viewer→viewer; contractor sees no financials), `security_invoker` on all 8 views (**fixes RLS bypass**), org-aware ledger/category triggers (**fixes 42702**), audit org-stamping, `provision_org()` + owner-on-create trigger, profiles.role→org role mirror |
| 0013 | team model | `team_members` registry; `project_members` rebuilt to staffing shape (id, project, team_member, role_label, pay_type, agreed_pay, permission); photographers[] backfilled; defensive v1-ACL row migration |
| 0014 | draft pay | `pay_items` draft/approved/void; RPC-only transitions; `approve_pay_item` posts **DR 5100 Team Pay (COGS) / CR 2000 Accounts Payable** in one transaction; `void_pay_item` posts reversal; photographers[]→memberships sync (replaces the broken $0-expense sync); legacy $0 rows converted to drafts |
| 0015 | guards | `member_rates` (cost/bill) owner-admin-only RLS; audit coverage for accounts/journal_entries; category→account type+org validation (COGS remap enabled); cross-org FK reference guards on 6 tables |

App: AuthProvider exposes `orgId`; realtime channel per org + 3 new table subscriptions; ProjectPage "Photographer Pay" panel (edit draft amounts, admin approve/void) with Spent/Profit including approved pay; dashboard per-photographer widget unions approved pay under the page filters; Electron SQLite mirror gains org columns via additive migration; types updated.

Tooling: git repo initialized (was none); supabase CLI as devDependency + `supabase init` config; local Postgres 17 shadow DB + `scripts/db-test.sh` (auth shim, per-file fresh DB, one transaction per file matching `db push`).

### Acceptance checklist

- [x] Two seeded orgs; role × org matrix tested; zero cross-org reads **and writes** (incl. FK-reference smuggling) — `supabase/tests/01_org_isolation.sql`
- [x] `cost_rate`/`bill_rate` unreadable by member/viewer/contractor — 01 + 0015 policy
- [x] Web build: builds, serves, renders sign-in in a real browser, full auth round-trip against live Supabase (got the expected "Invalid login credentials" — the repo's seed creds don't exist on live; **a real login needs Lucas's credentials**)
- [x] Electron: production bundle boots and stays alive (local electron dist had a pre-existing broken extraction; repaired manually — see note below)
- [ ] Installers build in CI — **unverifiable locally**: repo has no remote yet; `.github/workflows/release.yml` untouched and expected to work once pushed + tagged
- [x] photographers[] fully migrated to team_members/project_members; adding a member creates a **draft** pay item; approving posts a balanced GL entry; un-approved drafts never in P&L — `03_pay_flow.sql`
- [x] Every category maps to a CoA account; expense trigger posts through the mapping; COGS remap validated — `02_accounting_invariants.sql`
- [x] Regression for single-org users: bootstrap chain, editor CRUD, rollup parity, ledger mirror parity, category creation (42702 regression test) — `04_regression_and_audit.sql`
- [x] Vitest (10/10), tsc, eslint (0 errors), vite build all green

### Deviations & notes (all within approved D-A…D-F or forced by findings)

1. **Legacy pay sync was hard-broken** (RECON addendum #3) — replacement, not regression: on clean chains "add photographer" aborted the project write entirely. New-data behavior necessarily differs: pay lives in pay_items, not $0 expenses.
2. Rates live on `member_rates` keyed to `team_members` (not columns on `profiles`): row-level security can't hide columns, and non-login people need rates too. Spec's intent (admin-only) enforced exactly.
3. `org_role` enum includes `viewer` beyond the spec's four — preserves legacy read-only users' exact access. Legacy `profiles.role` remains the Admin-page control; a trigger mirrors it into the default org's membership.
4. Kept table name `categories` (spec sketched `expense_categories`) per I7 and Recon approval.
5. Dashboard KPIs stay expense-based in 0.5; only the per-photographer widget unions approved pay. Full money-display truth arrives in Phase 1 with GL-view-backed UI (approved reading of D-A).
6. `years` demotion deferred to Phase 1 (approved D-D). `client_paid` write-block lands with the Phase 1 payments rollup (spec task 6 was "plan only").
7. Realtime org scoping = per-org channel name + WALRUS RLS enforcement server-side; no client column filter (it would drop DELETE events, which carry only PKs). No storage buckets exist yet to scope.
8. `accounting_periods` remains unpopulated (pre-existing gap, RECON defect #3) — proposed for Phase 1 alongside payments (auto-create monthly periods on first posting).
9. Local electron binary extraction was already broken before this phase (dist contained only a licenses file since Jul 6); repaired by manual unzip + path.txt. Machine-specific, not in git.

### Open questions for the user (gate)

1. Approve deploying 0011–0015 to the live Supabase project? (I need the DB connection password for `supabase db push`, or you run the five files in the SQL editor in order.)
2. Push the repo to GitHub (restores CI installers + enables tag releases)? If yes: which remote?
3. Proceed to Phase 1 after deployment?

## Phase log

### Phase R — Reconnaissance (2026-07-07) — gate passed
- RECON.md produced; discrepancies D-A…D-F approved (recommended options).
- Baseline commit `75646a0`.

### Phase 0.5 — Foundations (2026-07-08) — complete, at gate
- Commits: `a53761c` (0011–0014 + harness), `abcb793` (app wiring + 0015 guards), `d97628b` (test suite), plus this gate-docs commit.
- Empirically confirmed RECON defects #1/#2 and upgraded the legacy-pay finding (see RECON addendum).

## Migration list

- Applied on live (per repo history): 0001–0010.
- Written this phase, **not yet on live**: 0011–0015. Next number: **0016**.
