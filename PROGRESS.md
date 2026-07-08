# PROGRESS.md

> Living status file for the CLAUDE-BUILD-SPEC.md build. Updated at every phase gate and whenever scope moves.

## Current state

- **Phase:** 1 — Money in — **complete, awaiting user approval at the gate**
- **Live deployment: still BLOCKED on credentials.**
  - DB password ("Ttlljjmm6") **fails authentication** against `db.biwnmfauratqfbywxxtz.supabase.co`. Check/reset: Supabase Dashboard → Project Settings → Database. Migrations 0011–0021 are repo-only until then.
  - GitHub push to `https://github.com/Lucas97223/Tracker` needs auth (no `gh`, no stored token). The remote's initial commit is already merged into local `main`; one working credential and it pushes.
- **Next phase:** 2 — Tasks (after live deploy + gate approval).

## Phase 1 gate summary (2026-07-08)

### Shipped — migrations 0016–0021

| # | Migration | Contents |
|---|---|---|
| 0016 | contacts | `contacts` (I3), `projects.contact_id`, backfill one contact per distinct client text per org |
| 0017 | invoicing | `tax_rates` (liability-account-validated), `invoices` (per-org numbering, guarded draft→sent→partial→paid/void state machine, share_token), `invoice_lines` (frozen after draft; revenue-account override validated), `payment_schedules`, derived `v_invoice_amounts` |
| 0018 | payments | RPC-only `payments` (`record_payment` posts DR cash / CR revenue buckets + CR tax liability with cumulative rounding true-up, all in one transaction; `void_payment` posts reversals and recomputes status), `v_invoice_totals`, `v_ar_aging`, `credit_notes` → 4800 contra-revenue, **accounting periods auto-created + stamped on every journal entry incl. backfill (closes recon gap #3)**, invoice-void blocked while live payments exist |
| 0019 | client_paid (D3) | derived rollup of non-void payments; direct writes rejected (unchanged-value passes → offline queue safe); **legacy balances become ledger-backed "Historical balance" invoices+payments** via idempotent `backfill_legacy_client_paid()` (API-role execution revoked) |
| 0020 | vendors + years | `vendors` registry with free-text auto-link trigger + backfill, `v_vendor_1099_totals`; **years demotion (D-D)**: `year_id` derived from `start_date` (find-or-create per org), existing straddlers re-homed |
| 0021 | share link | anon-callable `get_public_invoice(share_token)` exposing only invoice-facing fields |

### Shipped — app

ContactsPage + ContactPicker (inline quick-create; offline falls back to free text); ProjectPage InvoicesCard (draft lines editor, mark-sent, record/void payments, copy share link, print view); money strip reads `v_project_pnl` online (offline falls back to cached client-side sums); ReportsPage — the ledger's first UI: project P&L, AR aging, trial balance with live balance check; public print-ready invoice route (`#/share/invoice/:token`, no auth); `client_paid` inputs removed from project modals and stripped from create/update/off-line-sync payloads; realtime subscriptions for contacts/invoices/payments.

### Acceptance checklist (verified in `supabase/tests/05_invoicing_payments.sql` + `06_legacy_backfill.sql`)

- [x] Contact → project → invoice → two partial payments: each payment posts one balanced entry crediting revenue; status walks draft→sent→partial→paid
- [x] `UPDATE projects SET client_paid` rejected; rollup equals Σ payments exactly (incl. after voids)
- [x] `v_project_pnl` revenue == ledger revenue; zero-invoice project shows zero revenue; legacy scalars became real ledger history (06)
- [x] Sales tax lands in the liability account (proportional on partials, trues up exactly on final payment), never in revenue
- [x] Voiding a payment posts a reversal (originals never edited); paid → partial recomputed
- [x] I2 spot-check: ProjectPage strip reads GL views; dashboard "paid" is the derived rollup; ReportsPage is entirely view-backed
- [x] Regression: suites 01–04 unchanged and green; expense flow untouched; lint/typecheck/vitest/build green
- [x] Years demotion: project created with only a start_date lands in the right (auto-created) year

### Deferred / gate items

1. **Overdue email reminders**: AR aging view + UI shipped; *sending* needs an ESP decision (recommend Resend) + API key + a Supabase access token for Edge Function deploys. Say the word and Phase 2 starts with it.
2. Invoice "PDF" = the print stylesheet on the share route (browser print-to-PDF). A real PDF lib is outside the allowed dependency list (§8) — flag if you want one.
3. Payment schedules: table + auto-mark-paid shipped; a schedule-editing UI is thin (create via SQL/API only) — UI slated for Phase 5 (proposals) unless you want it sooner.
4. Full browser verification of logged-in flows requires the live deploy (shadow DB has no Supabase API layer). The DB behavior itself is covered by the six SQL suites.

## Previous gates

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
