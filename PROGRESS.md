# PROGRESS.md

> Living status file for the CLAUDE-BUILD-SPEC.md build. Updated at every phase gate and whenever scope moves.

## Current state

- **Phase:** 0.5 — Foundations — **in progress**
- **Phase R gate:** passed 2026-07-07. User decisions:
  - **D-A approved** — Phase 1 proceeds on amended reading (revenue posting + UI switch to GL views; `v_project_pnl` kept).
  - **D-B approved** — new `team_members` registry; rebuild the unused `project_members` into staffing shape `(project_id, team_member_id, role_label, pay_type, agreed_pay, permission)`.
  - **D-C approved** — draft `pay_items` replace $0 auto-expenses; approval posts **DR labor/COGS, CR Accounts Payable** per posting map §5. Existing non-zero pay expenses untouched; $0 rows convert to drafts.
  - **D-D approved** — `years` demotion **slides to Phase 1**; 0.5 only adds `org_id` to years.
  - **Tooling approved** — `git init` + initial commit, then supabase CLI dev tooling + local shadow DB.
- **Known scope consequence (from recon, to honor both 0.5 acceptance lines):** converting pay to draft-then-approve requires a minimal pay-items surface on ProjectPage (labels stay "Photographer Pay") and a small union in the dashboard's per-photographer widget so the existing breakdown feature keeps working for new pay.

## Phase log

### Phase R — Reconnaissance (2026-07-07)
- Read all 10 migrations, seed, Electron layer, full src, CI, configs. Live DB not queried (no CLI config exists; migrations applied by hand historically).
- Produced [RECON.md](RECON.md): answers to the 9 spec questions, 6 discrepancies with amended plans (D-A…D-F), 8 observed defects (report-only), full inventory.
- Copied CLAUDE-BUILD-SPEC.md into the repo root (supersedes UNIFIED-APP-MASTER-SPEC.md).
- **No code or schema changes made.**

Key findings that reshape later phases:
1. `v_project_pnl` already ledger-backed but unused; UI profit = manual `client_paid` − client-side expense sum. Phase 1 scope confirmed, shifted toward UI switchover + revenue posting (not view rewrite).
2. `categories.account_id` CoA mapping already exists end-to-end; needs COGS remap option + a likely 42702 bug fix in the auto-account trigger.
3. `project_members` is an unused auth-user ACL table; photographers are free-text names → needs `team_members` registry design (approval pending).
4. No draft state exists anywhere; pay sync creates $0 posted expenses. Draft `pay_items` is a real behavior change incl. credit side Cash→Payable (approval pending).
5. Views bypass RLS (`security_invoker` unset) — security fix folded into 0.5.
6. Not a git repo; no supabase CLI; Vitest exists (3 unit files), zero DB/RLS tests.

## Migration list

- Applied (per repo; live DB unverified): 0001–0010.
- Written by this effort: none yet. Next number: **0011**.

## Open questions for the user

See RECON.md §Discrepancies: D-A (amended Phase 1 reading), D-B (team_members design), D-C (draft pay + payable credit side), D-D (years demotion in 0.5 vs Phase 1), D-E (add supabase CLI dev tooling), D-F (git init).
