# Expense Tracker

Collaborative, multi-user expense tracking organised around **Year → Project → Category → Line Item**, with a rich analytics dashboard and Supabase-backed real-time sync.

## Assumptions (per spec §13)

| Decision | Choice |
| --- | --- |
| Base currency | **USD** (configurable via `VITE_BASE_CURRENCY` + `VITE_BASE_LOCALE`) |
| New sign-up behaviour | **Invite-only.** New users land as `is_active = false` and must be enabled by an admin. The very first sign-up is bootstrapped as an active admin so you can get started. |
| Per-project access in v1 | **Org-wide roles only.** The `project_members` table and RLS hooks exist in the schema, but the admin UI for managing them is left for a future iteration. |
| Multi-currency | **Single base currency v1.** `currency` is stored per row so true multi-currency can be layered in later. |
| Receipts | **Link-only.** A `receipt_url` field exists; uploads to Supabase Storage are not wired up. |
| Hosting | **Managed Supabase.** Schema is portable so self-hosting also works. |

## Stack

- React 18 + TypeScript + Vite
- Tailwind CSS
- React Router, TanStack Query, React Hook Form + Zod, Recharts
- Supabase: Postgres + Auth + RLS + Realtime
- Vitest for unit tests

## Prerequisites

- Node.js 18+ (this repo was developed against Node 24 LTS)
- A free Supabase project (https://supabase.com → New project)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the env template and fill it in:
   ```bash
   cp .env.example .env
   ```
   In `.env`, set:
   - `VITE_SUPABASE_URL` — from Supabase → Project Settings → API
   - `VITE_SUPABASE_ANON_KEY` — same page, the `anon` public key
   - (optional) `VITE_BASE_CURRENCY` and `VITE_BASE_LOCALE`
3. Apply the SQL migrations. In the Supabase dashboard → SQL editor, run each file in `supabase/migrations/` in order:
   1. `0001_schema.sql` — tables, enums, profile-bootstrap trigger
   2. `0002_rls.sql` — Row-Level Security policies
   3. `0003_audit.sql` — audit triggers
   4. `0004_views.sql` — aggregation views for the dashboard / sidebar
   5. `0005_seed_categories.sql` — seeds the default category set
   6. `0006_project_type.sql` — adds `project_type` to projects
   7. `0007_double_entry.sql` — Chart of Accounts, journal entries/lines, balance trigger, ledger views
   8. `0008_backfill_journal.sql` — migrates existing expenses into journal entries and installs live-sync triggers
4. (Optional) Enable Realtime: In Supabase → Database → Replication, enable Realtime for the `years`, `projects`, `expenses`, `categories`, and `profiles` tables.
5. Run the app:
   ```bash
   npm run dev
   ```
   Open http://localhost:5173.

## Creating the first admin user

1. Supabase → Authentication → Users → **Add user** (Email + Password). Confirm the email so the user can sign in.
2. The auth trigger creates a `profiles` row automatically. The **first** profile row is bootstrapped as `role = 'admin'`, `is_active = true`. Subsequent sign-ups land as `viewer` and `is_active = false` — promote them via the Admin page.

If you skip the first-user bootstrap and need to manually promote, run in the SQL editor:

```sql
update public.profiles set role = 'admin', is_active = true where email = 'you@example.com';
```

## Demo data

To preview the dashboard with realistic numbers, after migrations run:

```sql
-- supabase/seed/demo_data.sql
```

Paste its contents into the Supabase SQL editor and run. It creates two years, five projects, and ~40 randomised expenses across the seeded categories.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Type-check + production build |
| `npm run preview` | Preview the production build locally |
| `npm run typecheck` | TypeScript only, no emit |
| `npm run lint` | ESLint |
| `npm run test` | Vitest (money + CSV utilities) |
| `npm run format` | Prettier |

## Verifying that totals reconcile

The dashboard's KPIs and the per-category subtotals on a project page both come from the same underlying `expenses.amount` numeric column:

- **Sidebar tree, year & project rollups** are aggregated server-side in the Postgres views `v_year_rollup`, `v_project_rollup`, etc.
- **Dashboard filtered widgets** aggregate client-side from a single filtered fetch, so the CSV export and every widget see the exact same row set.

To verify after creating data: open a project, sum the visible subtotals — they equal the page total at the top, and the project's row in the sidebar shows the same compact value. The dashboard's "Total spend" equals the sum of every row in the exported CSV.

## Project structure

```
src/
  components/       UI primitives (AppShell, Sidebar, Modal, ConfirmDialog, forms/, expenses/)
  hooks/            TanStack Query data hooks (one file per resource) + useRealtimeSync
  pages/            Routed pages (Sign-in, Home, Year, Project, Dashboard, Categories, Admin, AuditLog)
  providers/        AuthProvider, ToastProvider
  lib/              supabase client, config, money utilities, csv
  types/            database row types (mirror of the Supabase schema)
  test/             vitest setup
supabase/
  migrations/       SQL migrations 0001..0005
  seed/             demo_data.sql
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data model, role model, and how realtime sync is wired.

## Building the desktop installers

The app is a local desktop application; both installers connect to the same Supabase backend over the internet. Set `.env` once before building so the Supabase credentials get baked into the bundle.

### Windows (.exe installer)

On any Windows machine with Node.js installed:

```powershell
npm install
npm run electron:installer
```

Output: `release\Expense Tracker Setup 0.1.0.exe`. Double-click to install — registers in Apps & Features with Start Menu + Desktop shortcuts.

### macOS (.dmg installer)

Apple licenses macOS only to its own hardware, so the build **must** run on a Mac — not Windows, not Linux. Two paths:

#### Easy path — borrow a Mac for 10 minutes (recommended)

Once you've done the one-time setup, building a fresh `.dmg` is a double-click. Steps:

1. **Copy the `expense-tracker` folder** to the Mac. USB drive, AirDrop, iCloud Drive — anything works. Skip the `node_modules/` and `release/` subfolders; they're huge and platform-specific.
2. **Install Node.js LTS on the Mac** from https://nodejs.org — download the `.pkg`, click through the installer. ~2 minutes, one time only.
3. **One-time make-the-script-runnable step.** Open Terminal once and run:
   ```bash
   chmod +x "$HOME/Desktop/expense-tracker/Build Mac.command"
   ```
   (adjust the path if you put the folder somewhere else). This is needed because the executable bit doesn't survive file transfers from Windows.
4. **Edit `.env`** in the folder so it has your real Supabase URL and anon key (same values your Windows install uses).
5. **Double-click `Build Mac.command`.** A Terminal window opens, the script installs dependencies the first time, builds the installer, opens the `release/` folder, and pops up a "Build complete" dialog. ~3 minutes the first time, ~30 seconds for rebuilds.

Output: `release/Expense Tracker-0.1.0-arm64.dmg` (Apple Silicon M1/M2/M3/M4) and `release/Expense Tracker-0.1.0.dmg` (Intel Macs). Drag from the `.dmg` into Applications to install.

For future rebuilds (e.g. after pulling code updates) just double-click `Build Mac.command` again — the one-time setup is done.

#### Alternative — no Mac at all (GitHub Actions)

Microsoft provides free macOS runners via GitHub Actions. Workflow already in `.github/workflows/release.yml`:

1. Push this repo to GitHub.
2. Repo **Settings → Secrets and variables → Actions** → add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Tag a release: `git tag v0.1.0 && git push --tags`.
4. The workflow builds Windows + macOS in parallel. Download artifacts from the Actions run page.

#### First-run on macOS (unsigned app)

Because there's no Apple Developer certificate attached, Gatekeeper warns the first time. End users:

1. Open the `.dmg`, drag the app to Applications.
2. In Applications, **right-click the app → Open**, then click **Open** on the warning.
3. After that first launch, double-click works normally.

Or from Terminal once: `xattr -dr com.apple.quarantine "/Applications/Expense Tracker.app"`.
