# Architecture

## Data model

```
auth.users  ─ 1:1 ─►  profiles (id, email, full_name, role, is_active)
                          │
years (year_value unique)  │
   │                       │
   └── projects (year_id, name, location, status, dates…)
              │
              ├── expenses (category_id, amount numeric(14,2), expense_date,
              │             location, vendor, payment_method, receipt_url, notes)
              │
              └── project_members (user_id, permission)   ← schema-ready, not wired in v1

categories (global, shared, archivable)
audit_log (every create/update/delete on the entities above)
```

### Money

`expenses.amount` is `numeric(14,2)`. The Supabase JS client returns it as a string to preserve precision. In code we parse via `src/lib/money.ts` into integer cents and only render via `Intl.NumberFormat`. There is no float arithmetic on money values anywhere.

### Aggregations

The dashboard's unfiltered KPIs, the sidebar rollups, and the year/project pages read from five views:

- `v_year_rollup` — total, project_count, expense_count per year
- `v_project_rollup` — totals per project
- `v_category_rollup` — totals per category
- `v_location_rollup` — line-item location falling back to project location
- `v_monthly_rollup` — monthly trend

The filtered dashboard widgets share **one** fetch with project join (`useFilteredExpenses`) and compute every chart, table, and KPI from that row set client-side, so totals always reconcile with the CSV export.

## Roles & RLS

Three org-wide roles, enforced in the database via Row-Level Security:

| Role | Profiles | Years/Projects/Expenses | Categories | Audit log |
| --- | --- | --- | --- | --- |
| `admin` | read all, change role/active for any non-self | full CRUD | full CRUD | read all |
| `editor` | read self | full CRUD | read | — |
| `viewer` | read self | read | read | — |

Plus: any user with `is_active = false` sees nothing (the `is_active_user()` helper returns false, which cascades into every other policy). The UI surfaces an "Account inactive" screen and pushes them out.

Helpers (`is_active_user()`, `user_role()`, `is_admin()`, `can_edit()`) live in `0002_rls.sql` and are `security definer` so a user can't escalate by manipulating their own `profiles` row — the function reads its own row, and the `profiles_update_self_name` policy blocks the user from changing their own `role` or `is_active`.

### Profile bootstrap

A trigger on `auth.users` inserts the matching `profiles` row on first sign-in. The very first row is bootstrapped as `role = 'admin'`, `is_active = true` so you can sign in and grant access to others; everyone after that lands as `viewer`, `is_active = false`.

### Audit log

A single `log_audit(entity_type)` trigger function captures inserts, updates, and deletes on the five primary entities plus role/active changes on `profiles`. The full before/after row is stored in `changes` JSONB so the Audit Log page can diff or unwind.

## Sync

`src/hooks/useRealtimeSync.ts` is mounted once at the AppShell. It opens a single Supabase Realtime channel and listens to `postgres_changes` events for the five primary tables. On every event it invalidates the relevant TanStack Query keys (`years`, `projects`, `expenses`, `categories`, `profiles`, plus the rollup and dashboard keys). Because queries auto-refetch on invalidation, every connected client sees changes within a couple of seconds.

Concurrency is last-write-wins in v1; the audit log lets you see who clobbered what after the fact.

## Folder layout

```
src/
  components/
    AppShell.tsx          shell with header + sidebar + Outlet
    Sidebar.tsx           year-project tree with rollup totals
    Modal.tsx             generic dialog primitive
    ConfirmDialog.tsx     destructive-action confirmation
    LoadingScreen.tsx     loading + skeleton primitives
    expenses/
      ExpenseCategorySection.tsx  collapsible category section + inline QuickAdd
      ExpenseForm.tsx              full add/edit form (modal contents)
    forms/
      CreateYearButton.tsx
      CreateProjectButton.tsx
      EditProjectModal.tsx
  hooks/
    useYears, useProjects, useCategories, useExpenses
    useProfiles, useAuditLog, useDashboard
    useRealtimeSync
  pages/
    SignInPage, HomePage, YearPage, ProjectPage,
    DashboardPage, CategoriesPage, AdminPage, AuditLogPage
  providers/
    AuthProvider, ToastProvider
  lib/
    supabase, config, money, csv, cn
  types/
    database.ts
```

## Why these trade-offs

- **Views, not RPCs, for rollups.** Views auto-update with the underlying data and respect RLS. Fast enough for tens of thousands of rows.
- **Client-side aggregation for the dashboard's filtered widgets** because filters compose with each other in five dimensions; building one Postgres RPC for the cross-product is fragile, and a single fetch with `.limit(5000)` is plenty for the expected dataset size. If the dataset outgrows this, swap `useFilteredExpenses` for an RPC — the chart components don't change.
- **No optimistic mutations in v1.** The query cache is invalidated and re-fetched on success. Cheaper to reason about; the realtime channel piggybacks on the same invalidation.
- **`is_active` defaults to false** so a leaked invite link doesn't grant access — an admin still has to enable the user.

## Bookkeeping engine (Milestone 12, Phase 12a)

The expense model still exists at the UI level, but underneath it now flows into a proper double-entry general ledger. The migration is invisible to existing users: every expense create/update/delete is mirrored into journal entries by DB triggers, so the existing forms keep working.

### New tables

```
accounts             Chart of Accounts: code, name, type (asset|liability|equity|revenue|expense|cogs),
                     normal_balance (debit|credit), parent_id, is_active, is_system, currency.
journal_entries      Atomic accounting events: entry_date, memo, source_type, source_id, project_id,
                     posted, reversed_by, period_id.
journal_lines        Debit/credit lines: account_id, debit numeric(14,2), credit numeric(14,2),
                     project_id, category_id, line_number. CHECK: each line is debit XOR credit,
                     never both, never neither.
accounting_periods   Fiscal periods: start_date, end_date, status (open|closed|locked).
expense_journal_map  Links each expenses.id to the journal_entries.id it currently maps to.
                     Updated on expense edits (the link moves to the new replacement entry).
```

### Invariants (database-enforced)

- **Balanced entries.** A `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `journal_lines` re-checks `sum(debit) = sum(credit)` per entry at every transaction commit. Unbalanced entries can never persist.
- **Posted entries are immutable.** A `BEFORE UPDATE` trigger blocks any change to a posted entry except setting `reversed_by`. Corrections happen via *reversal* entries (Dr/Cr flipped) plus a *replacement* entry — the audit-friendly way.
- **Categories link to accounts.** A `BEFORE INSERT` trigger on `categories` auto-creates an expense account under "6000 Operating Expenses" so the GL can always route a new expense to a real account.

### Sync triggers (expenses → journal)

`0008_backfill_journal.sql` installs three triggers on the existing `expenses` table:

- `expenses_to_journal_insert` — for each new expense row, post a journal entry with two lines: Dr the category's expense account, Cr Cash (account 1000). Record in `expense_journal_map`.
- `expenses_to_journal_update` — when a financially relevant field changes (amount, date, category, project, description), reverse the previous entry and post a new one. The old entry is marked `reversed_by`; the new one replaces it in `expense_journal_map`.
- `expenses_to_journal_delete` — post a reversal of the live entry. The original journal entry stays in the ledger for audit; only the `expenses` row goes away.

### Reports (views)

- `v_trial_balance` — per-account totals (debit, credit, signed balance). Sum of debits = sum of credits is the engine's smoke test.
- `v_account_ledger` — every line for a chosen account, in date order, with a running balance computed via window function.
- `v_project_pnl` — revenue / COGS / expense / net margin per project.

### What's deliberately out of Phase 12a

- No new UI yet. Existing forms keep working unchanged; the ledger fills itself.
- No accounting-period auto-creation. `period_id` on entries is nullable until Phase 12d.
- Cash-basis only. Every expense credits Cash directly; accrual (via Accounts Payable) is part of the Bills milestone.

### What Phase 12b adds

- Chart of Accounts page, Journal browser, General Ledger by account, Trial Balance report, Project P&L page. All read-only views over the existing data, exposing the new layer to users.

## Extending

- **Per-project membership UI.** The `project_members` table already exists. Tighten the `projects_select_active` and `expenses_select_active` policies to require either an admin/editor role OR membership.
- **Multi-currency.** Add a `fx_rates` table or use a Postgres extension; transform amounts in the views before summing.
- **Receipt uploads.** Create a Supabase Storage bucket `receipts/` (RLS keyed to the user). Add an upload field to `ExpenseForm` that writes the public URL into `expenses.receipt_url`.
