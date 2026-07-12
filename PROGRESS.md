# PROGRESS.md

> Living status file for the CLAUDE-BUILD-SPEC.md build. Updated at every phase gate and whenever scope moves.

## Current state

- **Phase:** 1 — Money in — **complete, awaiting user approval at the gate**
- **Phase: ALL SIX PHASES COMPLETE (2026-07-10).** Live database at **0041**; GitHub current; 15/15 SQL suites; ledger balanced with $1.58M of imported history.
- **Portal/public pen-test PASSED (2026-07-12).** One finding, fixed (0041 booking rate cap). See below.

## Phase 6 gate summary (2026-07-10)

**6a Automations (0038):** 5 triggers × 3 actions, per-contact daily cap, loop-proof (depth flag), failure-isolated fan-out (branch-on-table fix caught by suite 14), runs log, recipe gallery UI.
**6b Calendar + forecast (0039):** month calendar (projects/tasks/bookings, role-safe); `v_cashflow_forecast` (IN by due-bucket from invoices+schedules; OUT split committed payable vs draft forecast — documents only, I2); `v_tax_set_aside` (configurable % of YTD ledger revenue, inline rate editor).
**6c Reconciliation + export (0040):** bank_transactions staging (import dedupe), exact-match ±5-day suggestions on cash/clearing lines, reconcile/unreconcile RPCs (one bank row per line), CSV upload with header detection, QuickBooks-style GL CSV export.
**6d PWA:** manifest + SVG icon + hand-rolled app-shell service worker (prod web only, never Electron/dev; API never cached) — verified registered in-browser.

## Portal / public pen-test (2026-07-12) — PASSED

Audited every surface an unauthenticated (`anon`) or external portal user can reach, before the app is publicly hosted (spec gate).

**Verified clean:**
- **No IDOR.** Every public entity (invoice/proposal/contract/form/scheduler) is keyed by its own high-entropy `share_token uuid default gen_random_uuid()`, never the row PK. Read RPCs (`get_public_*`) hand-pick safe fields (no costs/rates/margins/internal notes) and gate on shareable statuses only.
- **No direct table access for `anon`.** `anon` holds *zero* table privileges — only EXECUTE on 10 vetted RPCs. The `/rest/v1/<table>` IDOR class is impossible for anon regardless of RLS.
- **No cross-org injection in public writes.** `submit_lead_form` / `accept_proposal` / `sign_contract` / `book_slot` all derive `org_id` from the token; none accept a caller-supplied org. All take `FOR UPDATE` locks, gate on status/expiry, capture IP/UA as evidence, and return only `{ok:true}`.
- **`record_stripe_payment` is `service_role`-only** (revoked from public/anon/authenticated) — a payment cannot be forged from the browser.
- **Portal isolation holds three-deep:** portal profiles are created `is_active=false`, so `is_active_user()` → false → every org helper (`is_org_member`/`org_can_view_financials`/`org_can_edit`/`org_is_admin`/`can_access_work`) short-circuits false → all base tables return zero rows even via direct REST. Portal reads flow *only* through definer views filtered by `contact_users cu … cu.user_id = auth.uid()`, and `contact_users` links a login to contacts only by **verified** email. The `profiles` self-update policy pins `is_active`, so a portal user cannot self-activate. (suite 12)
- **Cross-tenant isolation intact:** 0012 rescoped every legacy table (projects/expenses/categories/years) from bare `is_active_user()` to `org_can_view_financials`/`org_can_edit`; suite 01 asserts zero cross-org reads *and* writes. RLS enabled + policied on all 55 tables (~130 policies).

**Finding (fixed — 0041):** `book_slot` was the only public *write* with no abuse cap, yet its scheduler token is semi-public by design (posted on a site). An attacker with the link could fill every open slot with junk bookings (denial-of-booking) and spawn fake lead contacts. `submit_lead_form` already guards this via `forms.daily_cap`; 0041 mirrors that exactly onto `appointment_types.daily_cap` (default 20/24h) and enforces it in `book_slot`. Verified by suite 11 (a fresh visitor on a still-open slot is refused once the cap is hit — no booking, no junk lead). Deployed to production, `daily_cap` column confirmed live.

**Recommendation for hosting time (not a blocker):** the real fix for a public booking/lead page is a CAPTCHA/Turnstile challenge verified before the RPC runs — the DB cap is defense-in-depth. Add it when the public pages get a real domain.

**Deferred from the Phase 6 menu (candidates for a v2 cycle):** task dependencies/workload/portfolios/status updates; ledger-grounded AI features (needs an Anthropic API key decision); Asana/CSV importers; capacity-aware booking; money-carrying templates (budget+schedule in one apply).

**Standing operational notes:**
- **E-SIGN REMINDER (as requested):** pick a provider when ready — recommendation Documenso; the `signature_events.provider/payload` slot is wired (D6).
- Stripe: LIVE key — first real payment (or a self-test + refund) is the final end-to-end verification; consider rotating the key since it transited chat; `APP_ORIGIN` secret currently `http://localhost:5174` → update when the web app gets real hosting.
- Resend: verify a domain to lift the send-to-self restriction on reminders/magic links.
- Portal: **pen-test passed 2026-07-12** (see section below) — clear for client rollout; add a CAPTCHA on public booking/lead pages when hosted.

## Previous state (Phase 5)
- Phase 5 — Sell & onboard — complete (0031–0037 + portal 0036 + Stripe/Resend/Dubsado). Credential integrations live.
- **Client portal shipped (0036):** magic-link sign-in at `#/portal` (Supabase built-in mailer, no key). Portal logins are inactive, org-less, roster-less profiles linked to contacts by verified email (`contact_users`); they read exclusively through contact-scoped definer views (`v_portal_invoices/projects/proposals/contracts`) — base tables and staff views provably closed (suite 12). Nested-view lesson recorded: definer portal views must compute from base tables, not from invoker views (whose RLS re-applies as the portal user). **Pen-test before GA** per spec.
- **Next:** on gate approval → remaining Phase 5 integrations as credentials arrive (Stripe Connect → `processor_events` + hosted checkout on invoices; e-sign provider into `signature_events`; Resend for reminders; client portal via Supabase magic links needs no key; Dubsado importer needs an export file) → then Phase 6.

## Phase 5 gate summary (2026-07-09)

**Schema (0031–0035, live):** catalog_items (price + estimated cost/hours → quote-to-actual); proposals + lines (catalog snapshots, freeze-after-sent, `v_proposal_totals`, `v_project_type_costs` guardrail baseline); **the one-click Win** — `accept_proposal` (anon, evidence-capturing) runs `win_proposal` in the same transaction: project (+task template) + generated contract (versioned, sha256-hashed, sent) + deposit invoice (sent, deposit_pct of total) + deal won (created if standalone) + contact → client; idempotent via artifact stamps; `unwin_proposal` compensates and refuses once payments exist; `win_deal_manual` for offline acceptances. *Spec deviation, noted:* implemented as a definer RPC rather than an Edge Function — same single-transaction guarantee, no new runtime, matches every other money path (I7). Contracts: immutable versions + `signature_events` with 'internal' click-to-sign evidence (doc hash, signer, IP/UA, timestamp) — provider slot ready per D6, legality never in-house. Scheduler: appointment types, weekly availability, anon slot computation, bookings with **range-exclusion double-book protection**, booking → lead contact.

**App:** Sales ▾ nav cluster (Proposals, Catalog, Contracts, Scheduler, Lead forms); Catalog page; proposal builder with catalog picker, open-deal linking, deposit %, task-template-on-win, and the **margin guardrail chip** (estimated margin + warning when the quote sits below the historical average real cost for that project type); public proposal page with Accept-runs-the-Win; contract editor (dependency-free markdown-subset rendering) + public signing page; scheduler admin (types, hours, bookings w/ cancel) + public booking page with taken-slot race handling.

**Verified:** 11/11 SQL suites (suite 11: snapshots, full Win cascade incl. template + deposit math, idempotency, compensation + refuse-after-payment, signing freeze + evidence, slot computation, double-book rejection); tsc/lint/vitest/build green; pinned embeds smoke-tested on production (PGRST201 class); all three public pages render against production anonymously.

**Deferred within Phase 5 (each waits on one input):** Stripe Connect (account/keys), provider e-sign (provider choice), reminder emails (Resend key), client portal (buildable next — magic links need no external key; pen-test before GA per spec), Dubsado importer (needs a real export). Deposit invoices are untaxed by design (prepayment; tax truth rides the final invoice) — flagged for accounting review.

## Previous gate summaries (4)

## Phase 4 gate summary (2026-07-09)

**Schema (0027–0030, live):** pipeline_stages (seeded per org + provisioning); deals — `estimated_value` is **forecast-only** (I2: suite 10 proves it reaches no ledger surface), win promotes contact lead→client; public lead forms (share token, anon `get_public_form`/`submit_lead_form`, contact dedupe by email per I3, deal in first stage, required-field + length + daily-cap guards, inactive→invisible); `v_contact_activity` (deals/invoices/payments/projects/form responses, RLS-invoker); `merge_contacts` (repoint + coalesce + archive, audited); `search_all` FTS (contacts/projects/tasks/deals + invoice #, SECURITY INVOKER so org-scoped by construction) + GIN indexes; `merge_team_members` (0030 — repoints time/pay/tasks/staffing/rates, inherits login; used in production to merge Afrik ⇄ armandoafrik, roster now: Afrik ✓linked, Conor, Lucas ✓linked).

**App:** Pipeline board (stage columns with per-stage forecast totals clearly labeled, drag deals, new-deal modal with contact quick-create, win/lose/reopen, won-lost drawer); contact modal gains an **activity timeline** + admin **merge picker**; **Forms** page (builder with field kinds/required, live/off toggle, copy public link, responses viewer) + anonymous form page at `#/f/<token>` (verified rendering against production); **header search** (⌘K, all entity types); **Team & Rates** page (rename roster, set emails for future login-claiming, admin-only cost/bill rates, merge duplicates) — closes the Phase 3 rates-UI gap.

**Acceptance:** suite 10 (pipeline moves, I2 forecast isolation, anon submission + dedupe + caps + inactive, merge repointing, org-scoped search) + suites 01–09 unchanged; tsc/lint/vitest/build green; REST smokes on every new embed/RPC (deals→contacts checked for the PGRST201 class — clean); live deploy verified.

**Deferred:** deal→project link UI is manual (the one-click Win action is Phase 5 by design); form `select` field kind exists in schema, builder offers the common five; reminder emails still await an ESP key.

## MVP gate (passed)

- **Definition of done (spec §7):** contact → invoice → payment → tasks → time with true P&L — validated by Lucas on production, 2026-07-09.

## Phase 3 gate summary (2026-07-09)

**Schema (0024–0025, live):** `time_entries` (running timer = server-side row with NULL minutes — survives reload by construction; one open timer per person; `bill_rate` snapshotted at creation; `cost_rate` snapshotted into admin-only `time_entry_costs` so cost rates stay invisible to member/contractor roles); `start_timer`/`stop_timer` RPCs; **I5** `invoiced_lock` on time entries *and* billable expenses with RPC-only transitions, `add_unbilled_to_invoice()` (draft-only, source-linked lines, gross-method rebills per D7), unlock on draft-line delete and invoice void; **I4** memo columns on `v_project_pnl` (`labor_memo_cost`, `logged_minutes`, `effective_hourly_rate`) with zero journal writes anywhere in the time layer; `v_unbilled` picker view.

**App:** header ▶ Timer widget (live clock, project picker, stop-from-anywhere); Timesheet page (person × day grid, week nav, manual log with member picker for editors); "Start timer" on task detail; "Add unbilled work" on draft invoices (checkbox picker with amounts, missing-rate guard); Reports P&L gains memo-labeled Hours / Labor cost / Eff. $/h columns; billable checkbox on the expense form (locked state shown); realtime for time entries.

**Acceptance:**
- [x] **I4 test verbatim** (suite 08): $500 approved pay + 10 logged hours → realized P&L shows $500 once; memo column carries hours × cost_rate separately; **zero** journal entries from time
- [x] **I5 test verbatim** (suite 08): entries locked on invoice A; invoice B pull rejected; voiding A (or deleting a draft line) unlocks; B can then bill them
- [x] Effective hourly rate = ledger revenue ÷ logged hours, on the P&L view + Reports
- [x] Timer survives reload: open entry is a database row, not localStorage (suite 08 + design)
- [x] Rate snapshots stable across later member_rates changes; cost snapshots admin-only; contractors log own time on staffed projects only
- [x] 8/8 SQL suites; tsc/lint/vitest/build green; live REST smoke on every new embed/view (200s)

**Notes:** memo cost renders as 0 for roles that can't read cost rates (I6-correct posture). Timesheet delete affects a day's first unlocked entry (finer editing via project pages later).

## MVP demo script (for validating with real users)

1. **Contact → project:** Contacts → "+ Contact" (a real client) → sidebar "+ Project" with a start date (year is derived) → pick the contact as Client.
2. **Staff it:** edit project → Photographers tab → add a name → a **draft pay item** appears in Photographer Pay → set the fee → **Approve** (posts to the books: Team Pay / Accounts Payable).
3. **Work it:** Tasks panel → add sections/tasks, assign people, switch to Board and drag to In progress → ▶ Timer in the header (or on a task) → stop after a bit → Timesheet shows the grid.
4. **Bill it:** Invoices → "+ Invoice" → add a line or use **Add unbilled work** to pull the logged time + any billable expense (they lock) → Mark sent → copy the share link (client-facing, printable) → **Record payment**.
5. **Read the truth:** Reports → project P&L: revenue equals what was paid, team pay appears once under COGS, hours + memo labor sit in their own gray columns, trial balance says **balanced**. Project page money strip agrees.
6. **Try to break it:** edit client_paid (blocked), pull the same time onto a second invoice (blocked), edit a billed time entry (blocked), sign in as a viewer/contractor (financials disappear).

## Previous gate summaries (2)

## Phase 2 gate summary (2026-07-08)

**Shipped — schema (0022–0023, live):** task_sections; tasks (single assignee → team_members per D12, subtasks, status/priority/dates, sort_order); task_collaborators; task_comments via `add_task_comment` RPC (comment + @mention + assignee notifications in one transaction); url-based task_attachments; notifications with owner-only RLS; task templates v1 + depth-first `apply_task_template`. Contractor scoping per I6: `is_staffed_on`/`can_access_work` helpers; contractors read/work tasks only on staffed projects and read `v_contractor_projects` (work-safe columns only) — the projects table, and every money table/view, stays closed to them (suite 07 asserts each).

**Shipped — app:** Tasks panel on ProjectPage with **List** (sections, quick-add, subtask counts) and **Board** (status columns, HTML5 drag persisting status + order — no new dependencies); task detail modal (meta editing, subtasks, comment thread with mention chips); **My Tasks** page (overdue/today/upcoming buckets, contractor-safe project names, inline detail); **notifications bell** with unread badge + mark-read; realtime invalidations for tasks/sections/comments/notifications; nav + routes.

**Acceptance:**
- [x] Task CRUD + subtasks; board drag persists order/status — suite 07 + UI
- [x] My Tasks aggregates across projects (team-member identities → login)
- [x] @mention notifies — suite 07
- [x] Contractor: no invoices/payments/expenses/rates/P&L; only staffed projects/tasks — suite 07
- [x] Applying a template creates its task tree (incl. nesting) — suite 07; save-as-template shipped too
- [~] Two-browser realtime: pattern identical to the proven Phase 0.5 channel; **needs a logged-in two-browser check** (I still have no app credentials — 2-minute manual check on your side)
- [x] 7/7 SQL suites, vitest 10/10, lint 0 errors, tsc clean, web bundle renders

**Notes:** attachments are link-based (no storage buckets yet — spec allows; uploads can ride Phase 5's portal work). ESP decision still open (only blocks reminder *sending*).

## Previous gate summaries

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
