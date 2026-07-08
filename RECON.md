# RECON.md — Phase R Reconnaissance Report

**Date:** 2026-07-07
**Method:** Full read of all 10 migrations, seed files, Electron main/preload/db, every hook/lib/provider, pages, CI workflow, and configs. The **live Supabase database was not queried** — migrations are applied by hand via the SQL editor (per README), so live-schema drift is possible. A `db diff` against the live project is a recommended first step of Phase 0.5.

**Verdict in one paragraph:** The backbone described in the spec exists and is stronger than assumed in two places (the ledger-backed P&L view and the category→account mapping already exist) and weaker/different in three places (`project_members` is an access-control table for auth users, not a staffing table; photographers are free-text names, not users; the Photographer-Pay sync posts immediately through `expenses`, with no draft mechanism anywhere). Phase 1's thesis is fully intact: **no revenue-posting feature exists — every user-facing profit figure today is `projects.client_paid` (a manually typed scalar) minus a client-side sum of expense rows.** Several items need approval before Phase 0.5 (see §Discrepancies).

---

## Answers to the nine questions

### 1. Where does `v_project_pnl` get its revenue figure?

**Discrepancy with spec expectation — the view is already ledger-backed, but it is dead code, and the UI shows `client_paid` instead.**

- `v_project_pnl` ([0007_double_entry.sql:358](supabase/migrations/0007_double_entry.sql)) computes revenue as `sum(credit − debit)` over `journal_lines` joined to revenue-type `accounts`, posted entries only. Exactly the right shape.
- However, **nothing ever posts revenue.** The only GL writers are the expense mirror triggers (0008) and an unused manual-journal-entry hook. So `v_project_pnl.revenue` is structurally $0.
- And **no UI consumes it.** `useProjectPnL`, `useTrialBalance`, `useAccountLedger`, `useJournalEntries`, `useAccounts` ([useReports.ts](src/hooks/useReports.ts), [useJournal.ts](src/hooks/useJournal.ts), [useAccounts.ts](src/hooks/useAccounts.ts)) have **zero importers** — the "Phase 12b" reporting pages described in ARCHITECTURE.md were never built. The ledger fills itself invisibly.
- What users actually see as profit:
  - [ProjectPage.tsx:154-167](src/pages/ProjectPage.tsx) — "Client paid" = `projects.client_paid`; "Profit" = `client_paid − Σ(fetched expense rows)`, computed client-side.
  - [DashboardPage.tsx:105](src/pages/DashboardPage.tsx) — sums `client_paid` across filtered projects and blends it with expense-row sums (an I2 violation, as the spec anticipated in spirit).

**Amended plan for this item:** Phase 1 stands as specified (payments post `DR cash / CR revenue`; `client_paid` becomes a derived rollup). But the work is *not* "rewrite `v_project_pnl`" — the view needs at most minor touches. The real Phase 1 UI work is: switch ProjectPage/DashboardPage money tiles to GL-backed views, and finally surface the already-built (hook-ready, pageless) reports layer.

### 2. Does a categories → chart-of-accounts mapping already exist?

**Yes — fully.** Spec's "if yes, Phase 0.5 formalizes it" branch applies.

- `categories.account_id → accounts` added in [0007_double_entry.sql:183](supabase/migrations/0007_double_entry.sql).
- A `BEFORE INSERT` trigger (`categories_auto_account`, 0007:381-406) auto-creates an expense account under `6000 Operating Expenses` for any new category.
- 0008 backfilled an account per pre-existing category (codes 6100+) and linked them.
- The expense→GL trigger posts through the mapping (`DR category.account_id / CR 1000 Cash`) and hard-fails if a category is unmapped.

Caveats for formalization:
- **Everything maps to expense-type accounts.** No category maps to COGS (`5000` exists but `is_active=false`). Per the spec's posting map, team pay should be labor/COGS — Phase 0.5 needs a way to remap a category (esp. "Photographer Pay") to a COGS account, and the expense trigger already handles it generically since it reads `categories.account_id`.
- **Likely live bug in the auto-account trigger:** in `create_account_for_category()` the query `where parent_id = parent_id` references a PL/pgSQL variable with the same name as the column — ambiguous reference, which PL/pgSQL rejects at runtime by default (`42702`). If so, **creating a category through the app has been broken since 0007 was applied** (the seed categories in 0005 predate the trigger; [useCreateCategory](src/hooks/useCategories.ts) inserts without `account_id`, so the trigger body runs). Verify against the live DB; fix via a new migration.
- Spec §6 names the table `expense_categories` (rename of `categories`). Recommend **keeping the name `categories`** (I7: don't rewrite; the name is referenced by FKs, triggers, the audit enum, the local SQLite mirror, and hooks). Treat the spec's `expense_categories` as satisfied by `categories` + `account_id`.

### 3. Exact state of `project_members`

Exists since 0001, but it is **not** the staffing table the spec describes — it is an unused **access-control** table for *auth users*:

- Columns ([0001_schema.sql:140-145](supabase/migrations/0001_schema.sql)): `project_id → projects` (cascade), `user_id → profiles` (cascade), `permission project_permission ('edit'|'view')`, **PK (project_id, user_id)**.
- Has RLS (select: any active user; modify: admin) and an audit trigger (`'member'`).
- **Referenced nowhere else.** No RLS policy consults it, no hook or component reads or writes it, nothing joins it. Almost certainly zero rows in production. ARCHITECTURE.md and README both call it "schema-ready, not wired."

**The structural problem for the spec's plan:** `photographers[]` ([0009](supabase/migrations/0009_project_finances.sql)) holds **free-text names**. `profiles.id` is FK-chained to `auth.users(id)`, so a person without a login cannot exist as a profile — the spec's target shape `project_members(project_id, profile_id, …)` cannot hold a name-only photographer. See Discrepancy D-B in §Discrepancies for the amended design (a `team_members` registry, which spec D1 already names).

### 4. How the Photographer-Pay auto-sync works

Different mechanism than the spec implies — it never touches the ledger directly:

- Trigger `projects_sync_photographers` ([0010](supabase/migrations/0010_photographer_pay_sync.sql)) fires `AFTER INSERT OR UPDATE OF photographers ON projects`.
- For each **newly added** name it inserts a **$0 expense row** in the "Photographer Pay" category (`person_name` = the name, date = project start, dedup by person_name/description per project). Removing a name never deletes rows.
- That expense insert then flows through the normal expense→GL trigger, so a **posted, balanced, $0 journal entry is created immediately**. When the user later types the real fee into the expense row, the update trigger posts a reversal + replacement entry (see #6).
- **Posting is immediate everywhere; no draft state exists in the system.** `journal_entries.posted` defaults `true`; nothing ever creates `posted=false`. Amounts are whatever the user types into the $0 row afterward.
- Attribution is by `expenses.person_name` (matched against `photographers[]` strings); the dashboard's per-photographer breakdown filters on it.

Phase 0.5's draft-then-approve conversion is therefore a genuine behavior change: auto-created **draft `pay_items`** must replace auto-created $0 expenses, and only approval posts to the GL. Existing non-zero Photographer Pay expense rows are already-realized pay and must be preserved as-is; existing $0 rows are effectively "drafts" and can be converted (their $0 GL entries reversed — financially a no-op).

### 5. Current RLS model

- Roles: single global enum `role ('admin'|'editor'|'viewer')` on `profiles`, plus `is_active boolean` gate. First signup is bootstrapped active admin ([0001:40-67](supabase/migrations/0001_schema.sql)); everyone else lands inactive viewer.
- Helpers (`security definer`): `is_active_user()`, `user_role()`, `is_admin()`, `can_edit()` ([0002](supabase/migrations/0002_rls.sql)).
- Per-table policies:
  - `profiles`: select self-or-admin; update admin (any) or self (name only — role/is_active frozen by policy check).
  - `years`, `projects`, `expenses`: select any active user; all writes for admin/editor.
  - `categories`, `accounting_periods`, `accounts` (writes): admin. Reads: any active user.
  - `project_members`: select active; modify admin.
  - `audit_log`: select admin; inserts only via `security definer` triggers.
  - `journal_entries`: select active; **insert/update editor**; delete admin. `journal_lines`: select active; **insert editor; update/delete admin** (asymmetric — an editor can create lines but not amend an unposted entry's lines; relevant to any draft-entry design).
- **No org/workspace dimension anywhere** (as expected). No `org_id` on any table.
- **Finding — views likely bypass RLS:** all 8 views (`v_year_rollup`… `v_project_pnl`) are plain views without `security_invoker = true`, granted to `authenticated`. In Supabase, views execute with the owner's privileges, and the owner bypasses RLS on its own tables — so **any authenticated user, including `is_active = false` accounts, can read all rollups, trial balance, and P&L aggregates**. The 0004 comment "RLS on base tables still applies" is wrong on modern Postgres/Supabase defaults. Must be fixed in the Phase 0.5 RLS rewrite (set `security_invoker` on all views).
- Realtime: one channel `public-changes` subscribed to 8 tables ([useRealtimeSync.ts](src/hooks/useRealtimeSync.ts)); no per-org scoping (none possible yet). Storage: no buckets in use (`receipt_url` is link-only).

### 6. The expense→GL mirror trigger

Three triggers on `expenses` ([0008](supabase/migrations/0008_backfill_journal.sql)), all `security definer`:

- **INSERT** → one `journal_entries` row (`source_type='expense'`, `source_id=expense.id`, `posted=true`, `posted_at=now()`) + two lines: `DR categories.account_id` / `CR 1000 Cash`, both carrying `project_id` and `category_id`; a row in `expense_journal_map` links expense→current JE. Fails loudly if Cash or the category mapping is missing.
- **UPDATE** → early-returns unless amount, date, category, project, or **description** changed (so a description-only edit reposts — cosmetic ledger churn). Otherwise: posts a reversal entry (`source_type='reversal'`, dated `current_date`, lines flipped), sets `reversed_by` on the old entry (the only mutation immutability allows), posts a fresh replacement entry dated `expense_date`, and repoints `expense_journal_map`.
- **DELETE** (before) → posts a reversal, sets `reversed_by`; the JEs survive for audit while the expense row and its map row (cascade) go away.
- Invariants enforced in DB: per-entry `Σdebit = Σcredit` via a deferred constraint trigger; posted entries immutable except `reversed_by`; each line debit XOR credit ([0007:107-179](supabase/migrations/0007_double_entry.sql)).
- **Gap vs. spec conventions:** `accounting_periods` is never populated and `period_id` is never set — "every posting inside an accounting period" is not yet true. Needs a decision in Phase 0.5/1 (auto-create monthly/annual periods, or defer period enforcement).

### 7. `years` — structural or filter?

**Structural.** `projects.year_id uuid NOT NULL REFERENCES years ON DELETE RESTRICT` ([0001:79-92](supabase/migrations/0001_schema.sql)); `years.year_value` unique. The sidebar tree, HomePage, YearPage, project-creation flow, `v_year_rollup`, the local SQLite mirror, and the audit enum all key on it.

What breaks for a project spanning calendar years: nothing mechanically — expenses carry their own `expense_date` with no constraint tying them to the project's year, and `accounting_periods` (not `years`) is the GL's time dimension. But all rollups attribute the entire project to its single year bucket, so annual reporting is wrong for straddling projects, and the user must pick one year arbitrarily at creation.

Demotion (spec 0.5 task 5) is feasible — `year_id` is navigation-only — but it is the **largest UI-churn item in Phase 0.5** (sidebar, YearPage, create flows, rollup view, local mirror, audit enum). See Discrepancy D-D for a scoped recommendation.

### 8. Electron/web split

**The Vite app is web-ready today; Electron specifics are already isolated.**

- [main.tsx](src/main.tsx) uses `HashRouter` explicitly for parity between `file://` and browser. `vite.config.ts` sets `base: './'` (harmless on web). Auth is plain email+password via supabase-js (works in any browser; `detectSessionInUrl: true` already set; AuthProvider does its own token refresh scheduling).
- The platform adapter the spec asks for **already exists**: [localDb.ts:30](src/lib/localDb.ts) gates every call on `isElectron = typeof window.electronDB !== 'undefined'` and no-ops otherwise. No other renderer code touches Node/Electron APIs.
- Electron-specific surface: offline-first local mirror (better-sqlite3 in the main process, 6 mirrored tables + sync_queue/conflict_log/cache/meta, [electron/db.cjs](electron/db.cjs)) exposed over IPC ([preload.cjs](electron/preload.cjs)); menu/DevTools shortcuts; `powerSaveBlocker`; `file://` loading ([main.cjs](electron/main.cjs)). **No auto-update** — [release.yml](.github/workflows/release.yml) builds unsigned Win/Mac installers on tag push and uploads artifacts, nothing more.
- Consequence of the offline design worth noting: on web, "offline" simply degrades to no cache (queries fail); the sync queue/conflict UI are Electron-only niceties. Journal/ledger data is *not* mirrored locally — reports are online-only even on desktop.
- What Phase 0.5's "web target" actually needs: a hosting target + build config (no new adapter work), plus attention to the sync engine when `client_paid` becomes write-blocked (the offline queue currently flushes **full rows** — including `client_paid` — via upsert/update, which would start rejecting; the flush must strip derived columns when D3 lands).

### 9. Full inventory

**Migrations (applied by hand via SQL editor; next number: 0011):**
0001 schema (profiles, years, projects, categories, expenses, project_members, audit_log, enums, bootstrap + updated_at triggers) · 0002 RLS (helpers + policies) · 0003 audit triggers · 0004 rollup views ×5 · 0005 seed categories (9, incl. "Photographer Pay") · 0006 `project_type` · 0007 double-entry engine (accounts, journal_entries, journal_lines, accounting_periods, expense_journal_map, 3 enums, balance + immutability triggers, CoA seed, 3 ledger views, category-account autocreate) · 0008 backfill + 3 expense→GL triggers · 0009 `client_paid` + `photographers[]` + `collection_details` · 0010 `person_name` + photographer-pay sync trigger + backfill.

**Tables (12):** profiles, years, projects, categories, expenses, project_members, audit_log, accounts, journal_entries, journal_lines, accounting_periods, expense_journal_map.
**Views (8):** v_year_rollup, v_project_rollup, v_category_rollup, v_location_rollup, v_monthly_rollup, v_trial_balance, v_account_ledger, v_project_pnl. (First five sum the `expenses` table, not the GL — pre-ledger legacy, used by sidebar/dashboard/year pages.)
**Functions (14):** handle_new_user, set_updated_at, is_active_user, user_role, is_admin, can_edit, log_audit, check_journal_balance, enforce_journal_immutability, enforce_journal_lines_immutability, create_account_for_category, expense_insert/update/delete_to_journal, sync_project_photographer_pay.
**Triggers:** 6 audit, 3 expense→GL, balance (constraint, deferred), 2 immutability, category auto-account, photographer sync, auth bootstrap, expenses updated_at.
**Enums:** role, project_status, audit_action, audit_entity (year|project|expense|category|member|profile — **no GL entities: journal tables have no audit coverage**), project_permission, account_type, balance_side, period_status.
**Edge Functions:** none. **Supabase CLI config:** none (no `config.toml`) — no local dev DB, no programmatic migration pipeline.
**Frontend:** React 18 + TS + Vite 5 + Tailwind + TanStack Query 5 + react-router 6 (HashRouter) + RHF/Zod + Recharts. Pages: SignIn, Home, Dashboard, Year, Project, Categories, Admin, AuditLog (no reports/journal pages). Hooks: years/projects/categories/expenses/profiles/auditLog/dashboard/reports/journal/accounts/realtimeSync. Providers: Auth, Sync, Toast. Money handling: `numeric` strings → integer cents via [money.ts](src/lib/money.ts), `Intl.NumberFormat` rendering, no float arithmetic (except a tolerance check in the unused manual-JE hook).
**Electron:** main/preload/db (`better-sqlite3`), offline queue + conflict resolution UI (SyncStatusBadge, ConflictDialog), electron-builder (NSIS/DMG/AppImage, unsigned).
**Tests:** Vitest configured ([vite.config.ts](vite.config.ts), jsdom + testing-library setup). **Three unit test files** (money, csv, permissions) — the spec's "no harness assumed" is partially wrong: app-logic harness exists; **zero DB/RLS/posting tests** (the actual 0.5 deliverable).
**CI:** [release.yml](.github/workflows/release.yml) only (tag-triggered installers; Supabase creds injected from repo secrets). No test/lint CI.
**Env:** `.env` (real creds, gitignored), `.env.example`; `VITE_SUPABASE_URL/ANON_KEY/BASE_CURRENCY/BASE_LOCALE`.
**Docs:** README (setup; slightly stale — says port 5173, dev server is 5174), ARCHITECTURE.md (predates 0009/0010 and the offline layer), UNIFIED-APP-MASTER-SPEC.md (v1.0 draft — **superseded by CLAUDE-BUILD-SPEC.md**), `test-auth-and-seed.js` (manual seed script with hardcoded test credentials against the live project).

---

## Discrepancies with the spec & amended plans (approval needed)

**D-A. `v_project_pnl` is already ledger-backed (spec expected `client_paid`).** Phase 1 scope shifts from "rewrite the view" to "make revenue exist and switch the UI to GL-backed views" (ProjectPage tiles, Dashboard "paid" KPI, plus first-time surfacing of trial-balance/journal/P&L pages from the existing hooks). No change to Phase 1's deliverables list otherwise. **→ Proceed on this amended reading?**

**D-B. `project_members` can't be "wired up" as specified, because photographers aren't users.** `profiles` requires an `auth.users` row; `photographers[]` is free text. Amended design (uses the generic name spec D1 itself lists): new `team_members` registry (org-scoped; `display_name`, optional `email`, optional `profile_id → profiles`, later `cost_rate` home) + rebuild the **unused, almost-certainly-empty** `project_members` into the staffing shape `(id, project_id, team_member_id, role_label, pay_type, agreed_pay, permission)` via migration, backfilling `photographers[]` → `team_members` + memberships. UI labels stay "Photographers" (D2). The old ACL semantics (permission column) are retained for Phase 2's contractor work. **→ Approve this design?** (Alternative: leave `project_members` untouched and add a parallel `project_team` table — cleaner I7 optics, but leaves a dead table squatting on the natural name.)

**D-C. No draft mechanism exists anywhere; pay auto-sync posts $0 expenses immediately.** Phase 0.5's draft-then-approve therefore means: stop auto-creating $0 expenses; auto-create **draft `pay_items`** instead; approval posts the GL entry (per posting map: DR labor/COGS, CR payable — note this also changes the credit side from Cash to a payable, matching §5). Existing non-zero Photographer Pay expenses stay untouched (already-realized pay); existing $0 rows get converted to draft pay_items and their $0 entries reversed. **→ Confirm, including the Cash→Payable credit-side change for approved pay?**

**D-D. `years` is structural (as suspected), and demoting it is the biggest UI-churn item in 0.5.** Recommendation: keep the demotion in 0.5 as specced, implemented as "derive year from `projects.start_date` (fallback: created date); `years` becomes a compatibility view until the sidebar/YearPage/create-flow are switched; drop last." If you'd rather de-risk 0.5, the demotion can slide to Phase 1 (it touches the same screens Phase 1 rewrites anyway). **→ Keep in 0.5, or slide to Phase 1?**

**D-E. Test harness partially exists.** Vitest + 3 unit test files are in place; no DB-side tests and no supabase CLI setup at all. Amended 0.5 deliverable: add **supabase CLI config + local shadow DB** (this also fixes the "migrations applied by hand" fragility and lets us verify live-schema drift), then pgTAP/SQL tests for RLS + posting invariants on top. This adds the supabase CLI as a *dev tool* (not an app dependency — I7-compatible, but §8 says ask before adding dependencies). **→ Approve adding supabase CLI dev tooling?**

**D-F. Not a git repository.** No `.git` exists (despite `.github/workflows/`), so there is no version control, no reversibility, and the release CI is unreachable. Everything in the spec's working conventions assumes git. **→ Recommend `git init` + initial commit before any Phase 0.5 work. Approve?**

## Defects observed in passing (report-only; not fixed in Phase R)

1. **New-category creation likely broken** — ambiguous `parent_id` in `create_account_for_category()` (0007:395); PL/pgSQL raises 42702 at runtime by default. Needs live verification + fix migration. *(High confidence, high impact — blocks CategoriesPage adds.)*
2. **Views bypass RLS** (no `security_invoker`) — inactive users can read all aggregates. Fold into 0.5 RLS rewrite. *(High confidence.)*
3. **`accounting_periods` never populated; `period_id` always null** — spec's "every posting inside a period" convention isn't yet real.
4. **GL tables have no audit-log coverage** (audit enum lacks journal/account entities).
5. `useCreateJournalEntry` (unused) inserts entry + lines in two non-atomic requests — a partial failure leaves an empty posted entry. Reinforces the spec's "one transaction" rule for all Phase 1 money RPCs.
6. Description-only expense edits trigger reversal + repost (ledger noise; also true for future rename-heavy workflows).
7. Offline sync flush pushes whole rows (incl. `client_paid`) — will collide with D3's write-block when it lands; sync engine must strip derived columns in Phase 1.
8. Housekeeping: README port stale (5173 vs 5174); `test-auth-and-seed.js` hardcodes live-project test credentials.

## What Phase 0.5 does NOT need to build (already exists)

- Double-entry engine with balance/immutability enforcement — keep untouched (I7).
- Category→account mapping + auto-account creation (needs COGS remap option + the 42702 fix only).
- Ledger read models (`v_trial_balance`, `v_account_ledger`, `v_project_pnl`) and their query hooks.
- Web-compatible renderer with platform adapter (`isElectron` gating) and HashRouter.
- Vitest app-logic harness; realtime invalidation layer; audit-log framework for the original entities.
