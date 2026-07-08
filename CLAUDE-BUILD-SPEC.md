# CLAUDE-BUILD-SPEC.md — Unified Business App for Service Professionals

**How to use this file:** place it in the root of the `expense-tracker` repository. Then tell Claude Code: *"Read CLAUDE-BUILD-SPEC.md fully, then begin with Phase R (Reconnaissance)."* This file is the single source of truth for what to build, in what order, and what is out of bounds. It supersedes any earlier draft spec. All product/architecture decisions in §3 are **final** — do not relitigate them; if the codebase contradicts an assumption, follow §2 (report, don't improvise).

---

## 1. Mission

Extend the existing `expense-tracker` app (React 18 + TypeScript + Vite + Tailwind + TanStack Query + Supabase/Postgres + Electron) into one unified product for solo/small-team service professionals (launch vertical: photographers & event pros) that covers:

1. **CRM & sales** (Dubsado-class): contacts, pipeline, proposals, contracts, forms, scheduling, client portal.
2. **Projects & tasks** (Asana-class): tasks, views, assignments, time tracking, templates.
3. **Money** (already partly built): the existing double-entry ledger, extended with real invoices and payments.

The product thesis — and the thing every phase must protect — is **live, true profitability per project and client**, computed from one shared data model where every money event flows through the existing double-entry ledger.

The existing app already has: Year → Project → Category → Expense structure; Chart of Accounts; `journal_entries`/`journal_lines` with a DB-enforced balanced constraint; accounting periods; immutable posted entries with reversal corrections; a trigger mirroring expenses to the GL; `v_project_pnl`; per-person pay attribution ("Photographer Pay" auto-sync); RLS (admin/editor/viewer); audit log; realtime; desktop installers via GitHub Actions. **This is the backbone. Extend it. Never rewrite it.**

---

## 2. Non-negotiable invariants

Every phase, migration, and feature must satisfy all seven. Violating any of these is a bug even if the feature "works."

- **I1 — One ledger.** Every event that moves real money resolves to balanced `journal_lines` per the posting map (§5). No feature may store a money total that isn't derived from, or posted to, the ledger.
- **I2 — No shadow totals.** Every *realized* number on any dashboard/report reads from GL-backed views. Never compute "total revenue/spend" by summing a feature table. *Forecast* numbers read from schedules and must be labeled as forecast, never blended with actuals in one figure.
- **I3 — One contact.** Exactly one `contacts` record per real-world client, referenced by FK from deals, proposals, contracts, projects, invoices, bookings, and messages. No entity may carry its own free-text client identity (invoice bill-to renders *from* the contact FK).
- **I4 — Labor counted once.** Real pay (approved pay lines) posts to the GL. Costed time (`hours × cost_rate`) NEVER posts to the GL — it is a managerial memo layer joined into P&L *views* as a separately labeled line. A project with a paid contractor who also logs hours must show that labor cost exactly once in realized P&L.
- **I5 — Nothing billed twice.** `time_entries` and billable `expenses` carry `invoiced_lock` + `invoice_line_id`, set when their draft invoice is sent. Locked rows cannot be edited or added to another invoice without voiding the line.
- **I6 — Tenancy everywhere.** Every table carries `org_id`; every RLS policy checks org membership + role. Cost/bill rates and margin data are readable by owner/admin only. (Later: portal contacts get contact-scoped policies; contractors see assigned work, never financials.)
- **I7 — Extend, don't rewrite.** Keep the stack, the ledger engine, the migration style, and existing UI patterns. New server logic goes in Supabase Edge Functions/RPCs. Do not introduce new frameworks, ORMs, or state libraries.

---

## 3. Locked decisions (final — do not reopen)

| # | Decision |
|---|---|
| D1 | Vertical launch (photography/events) in UI labels & templates; **generic schema underneath** (`team_members`, `pay_items`, `project_type`). |
| D2 | Schema renames happen in Phase 0.5 (`photographers[]` → wired-up `project_members`); UI keeps vertical labels ("Photographer Pay" stays as a label). |
| D3 | `projects.client_paid` becomes **derived & write-blocked**: read-only rollup of payments. Existing reads keep working; manual writes rejected at DB level. |
| D4 | Labor costing is managerial (invariant I4). |
| D5 | Payments: **Stripe Connect only**, and not until Phase 5. Phases 1–4 record payments manually. |
| D6 | E-signature: **embed a provider** (Documenso-class self-hosted or white-labelable API); store the evidence payload in `signature_events`. Never build signature legality in-house. |
| D7 | **Cash-basis** posting: revenue posts on payment; invoices are operational AR documents (aging/reminders outside the GL). Billable-expense rebills use the gross method (rebill = income line; original expense stays an expense). **Single currency.** |
| D8 | Mobile: responsive PWA later (Phase 6). No native app. |
| D9 | Tenancy: single database, `org_id` + RLS. Multi-brand = multiple orgs. |
| D10 | Email: integrate Gmail/Outlook OAuth (send-as + thread sync). System notifications via one established ESP. Never run mail infrastructure. |
| D11 | Importers: Dubsado first (Phase 5), Asana/CSV later. |
| D12 | Tasks: **single assignee** + collaborators. No multi-homing, no Asana-style "bundles". |

---

## 4. Phase R — Reconnaissance (do this before writing any code)

The plan below was written against a description of the codebase, not the code. First, verify reality. Read the migrations, schema, triggers, views, and RLS policies, then produce a written report (`RECON.md`) answering:

1. **Where does `v_project_pnl` get its revenue figure?** (Expected: the manual `client_paid` scalar, i.e. NOT the ledger. This is why Phase 1 exists.)
2. **Does a `categories → chart-of-accounts` mapping already exist** (COGS vs. expense classification)? If yes, Phase 0.5 formalizes it; if no, Phase 0.5 creates it.
3. **Exact state of `project_members`** (described as "schema-ready, not wired"): columns, FKs, anything referencing it.
4. **How the Photographer-Pay auto-sync trigger works**: when it fires, what amount it posts, whether entries post immediately (expected) or as drafts.
5. **Current RLS model**: exact policies per table, how roles are stored, whether any org/workspace dimension exists (expected: none).
6. **The expense→GL mirror trigger**: exact posting logic, which accounts, how corrections work.
7. **`years`**: structural FK parent or just a filter? What breaks if projects span calendar years?
8. **Electron/web split**: can the Vite app already build for web? What is Electron-specific (IPC, fs access, auto-update)?
9. Full inventory: tables, views, triggers, functions, Edge Functions, env/config, test setup (if any).

**If findings contradict this spec** (e.g. a mapping already exists, or revenue is already ledger-backed), do not silently improvise: update `RECON.md` with the discrepancy and the amended plan for that item, present it, and wait for approval. Then proceed.

---

## 5. Money posting map (authoritative)

Any feature that moves money and is not on this table must be brought to the user before implementation.

| Event | Posting (cash basis, D7) |
|---|---|
| Expense recorded | DR expense/COGS account (via category mapping), CR cash/payable — *exists today via trigger; keep* |
| Invoice sent | **No GL posting.** Operational document: drives AR aging, reminders, schedules |
| Payment received | DR cash (or processor clearing), CR revenue account |
| Processor fee (Phase 5) | DR payment-fees expense, CR clearing — revenue stays gross |
| Discount / credit note / refund | DR contra-revenue, CR AR/cash |
| Late fee collected | CR other income |
| Sales tax collected | CR **sales-tax liability** (never revenue); remittance clears the liability |
| Billable expense rebilled | Rebill (base + markup) = income on payment; original expense unchanged (gross method) |
| Team pay (Photographer Pay) | DR labor/COGS, CR payable — **created as draft, posts only on explicit approval** |
| Costed time | **NO GL POSTING** (I4). Memo layer only |
| `client_paid` | Never an input. Derived rollup of payments (D3) |

Ledger conventions to preserve: posted entries are immutable; corrections via reversal entries; every entry balanced (existing DB constraint); every posting inside an accounting period.

---

## 6. Target data model

Extend, in this order of dependency. Adapt names/types to match existing conventions found in Phase R. All new tables: `org_id uuid not null` + RLS + `created_at/updated_at` + audit-log coverage matching existing patterns.

**Phase 0.5**
- `organizations` (id, name, settings jsonb)
- `org_members` (org_id, user_id, role: owner|admin|member|contractor)
- `expense_categories` (rename/extend of `categories`): add `account_id → accounts` (the CoA mapping)
- `profiles`: add `cost_rate`, `bill_rate` (admin-only read via RLS/views)
- Wire up `project_members` (project_id, profile_id, role_label, pay_type, agreed_pay); migrate `photographers[]` into it; auto-pay lines become **draft** `pay_items` that post on approval

**Phase 1**
- `contacts` (org_id, type person|company, lifecycle lead|client|archived, name, email, phone, company, address jsonb, source, notes) — minimal now, extended in Phase 4
- `projects`: add `contact_id → contacts` (backfill from existing client fields where possible)
- `invoices` (contact_id NOT NULL, project_id, status draft|sent|partial|paid|void, issue/due dates, totals derived from lines)
- `invoice_lines` (invoice_id, description, qty, unit_price, tax_rate_id, source_type/source_id nullable → time_entry|expense|catalog_item)
- `payment_schedules` (invoice_id or project_id, installments: due_date, amount, status)
- `payments` (invoice_id, date, amount, method, reference, journal_entry_id NOT NULL) — creating a payment creates its balanced journal entry in the same transaction
- `credit_notes` (contra-revenue posting), `tax_rates` (rate, liability account_id)
- `vendors` (payee dedupe; `is_1099` flag); `expenses.vendor_id` nullable FK
- Trigger/materialized rollup: `projects.client_paid` = Σ payments; block direct UPDATE
- Update `v_project_pnl`: revenue column now reads ledger revenue by project

**Phase 2**
- `tasks` (project_id, parent_task_id nullable, title, description, status, section_id, assignee_id, start_date, due_date, priority, sort_order)
- `task_sections`, `task_comments` (@mentions), `task_attachments`, `task_collaborators`
- `task_templates` / `project_templates` (v1: tasks only; money-carrying fields added Phase 5/6)
- `notifications` (drives My Tasks inbox)

**Phase 3**
- `time_entries` (user_id, project_id, task_id nullable, started_at, minutes, billable bool, bill_rate snapshot, invoiced_lock bool default false, invoice_line_id nullable)
- P&L views gain managerial columns: `labor_memo_cost` = Σ(minutes/60 × cost_rate at entry time), presented separately from realized P&L (I4)

**Phases 4–6 (outline only; detailed specs at their phase gates)**
- Phase 4: full CRM — `deals`, `pipeline_stages`, activity timeline view, `forms`/`form_fields`/`form_responses` (public lead capture), duplicate merge, universal search (Postgres FTS)
- Phase 5: `catalog_items`/`packages` (single source for proposal/invoice/template lines — backfill invoice_lines source refs), `proposals`/`proposal_lines` (snapshot `estimated_cost`/`estimated_hours` for quote-to-actual), `contracts`/`contract_versions`/`signature_events` (provider evidence payload: doc hash, signer identity, IP, timestamps), scheduler (`appointment_types`, `availability_rules`, `bookings`), `contact_users` (portal magic-link auth + contact-scoped RLS), `processor_events` (raw Stripe webhooks; payments created idempotently on `processor_ref`), Dubsado import staging tables
- Phase 6: `automations`/`automation_runs` (executions log; loop detection; per-contact rate cap), `email_messages` (OAuth sync), `recurring_schedules`, bank feed staging + reconciliation matching, reporting entities

---

## 7. Build phases

Work strictly in order. **Each phase ends at a gate:** run the full test suite, write a short summary (what shipped, what was deferred, migration list), present it, and **stop for user approval before the next phase.** Maintain `PROGRESS.md` throughout.

### Phase 0.5 — Foundations (no visible features; everything later depends on it)

Tasks:
1. Introduce `organizations`/`org_members`; add `org_id` to every existing table; create a default org and backfill; rewrite every RLS policy as org-membership + role; scope realtime channels and storage buckets per org.
2. Stand up the **web deployment target**: same Vite app served on the web behind Supabase auth (Electron continues to work). Isolate Electron-specific code behind a platform adapter if needed.
3. Wire `project_members`; migrate `photographers[]`; convert Photographer-Pay auto-sync to draft-then-approve posting. UI labels unchanged.
4. `expense_categories` with `account_id` CoA mapping (create or formalize per Recon #2).
5. Demote `years` to a derived filter if Recon #7 shows it's structural.
6. Write-block plan for `client_paid` (block lands with the Phase 1 rollup).
7. **Set up the test harness** (none is assumed to exist): pgTAP or SQL-based tests for RLS + accounting invariants, Vitest for app logic. This harness is a Phase 0.5 deliverable, not optional.

Acceptance (all must pass):
- [ ] Two seeded orgs; every role × org combination tested; zero cross-org reads/writes possible.
- [ ] `cost_rate`/`bill_rate` unreadable by member/contractor roles.
- [ ] Web build logs in and shows the existing app; Electron build still works; installers still build in CI.
- [ ] `photographers[]` fully migrated; adding a project member creates a **draft** pay item; approving it posts a balanced GL entry; un-approved drafts never appear in P&L.
- [ ] Every expense category maps to a CoA account; expense trigger posts through the mapping.
- [ ] Full regression: all pre-existing features work unchanged for a single-org user.

### Phase 1 — Money in (the thesis becomes true here)

Tasks: minimal `contacts` + `projects.contact_id`; invoices/lines/schedules; manual payment recording that posts to the GL (per §5) in one transaction; `client_paid` derived + write-blocked; `v_project_pnl` revenue switched to ledger; AR aging view + overdue email reminders (ESP, D10); `tax_rates` with liability posting; `vendors` + year-end 1099 totals view; invoice PDF/print + share link (web).

Acceptance:
- [ ] Create contact → project → invoice → record two partial payments: each payment creates a balanced journal entry crediting revenue; invoice status transitions draft→sent→partial→paid correctly.
- [ ] `UPDATE projects SET client_paid = …` is rejected; rollup equals Σ payments exactly.
- [ ] `v_project_pnl` revenue for a test project == ledger revenue, and a project with zero invoices shows zero revenue regardless of any legacy scalar.
- [ ] Invoice with sales tax: tax amount lands in the liability account, not revenue.
- [ ] Voiding a paid invoice's payment produces a reversal entry (never edits the posted one).
- [ ] Every dashboard figure touched in this phase reads from GL views (I2 spot-check).
- [ ] Regression: expense flow and existing reports unchanged.

### Phase 2 — Tasks (Asana core on existing projects)

Tasks: tasks/subtasks/sections with single assignee (D12), statuses, start/due dates, priority, drag-ordering; **List + Board** views on the existing project page; My Tasks (across projects) + notifications inbox; comments with @mentions; task templates v1; realtime updates; contractor role sees only assigned projects/tasks and never money (extends I6).

Acceptance:
- [ ] Full task CRUD with subtasks; board drag persists order/status; My Tasks aggregates across projects; @mention notifies.
- [ ] Contractor role: cannot read invoices, payments, expenses amounts, rates, or P&L — verified in the RLS suite.
- [ ] Two browsers see each other's task changes in realtime.
- [ ] Applying a task template to a project creates its task tree.

### Phase 3 — Time (completes the MVP)

Tasks: start/stop timer + manual entries against task/project; billable flag + `bill_rate` snapshot; managerial labor cost into P&L views as a **separately labeled memo line** (I4); "generate invoice lines from unbilled time/expenses" flow with `invoiced_lock` (I5); simple timesheet list per person/week.

Acceptance:
- [ ] **The I4 test:** project with an approved $500 pay item for a contractor who also logged 10 hours — realized P&L shows $500 labor cost once; memo line shows costed hours separately; no GL entry exists for costed time.
- [ ] **The I5 test:** pull time entries onto invoice A (locks them); attempting to pull the same entries onto invoice B fails; voiding A's line unlocks them.
- [ ] Effective-hourly-rate figure per project (revenue ÷ logged hours) renders from ledger + time data.
- [ ] Timer survives reload (server-side open entry, not localStorage).

**MVP GATE (end of Phase 3).** Definition of done: a user can run a project from contact → invoice → payment → tasks → time and see a true P&L where labor appears exactly once, revenue is ledger-backed, and nothing was entered twice. Stop. Present a demo script. The user validates with real users before Phase 4 begins.

### Phases 4–6 (gated outlines — detail at each gate)

- **Phase 4 — CRM front:** deals + pipeline board, contact activity timeline, public lead-capture forms (web), duplicate merge, universal search.
- **Phase 5 — Sell & onboard:** offer catalog; proposals with inline margin guardrail (proposal price vs. historical avg cost for that project_type from quote-to-actual data); embedded e-sign (D6); intake forms; scheduler; client portal (magic-link, contact-scoped RLS, per-project visibility toggles enforced in policies/views — pen-test before GA; white-label domain); **Stripe Connect** (hosted elements only, webhook → `processor_events` → idempotent payments; fees/refunds per §5; autopay on schedules; no surcharging); the **one-click Win action** — one Edge Function, one transaction, idempotency key, compensating "un-win" (proposal accept → contract + deposit invoice + project-from-template + deal Won + lifecycle client); Dubsado importer.
- **Phase 6 — Automate & scale:** workflow builder + `automation_runs` + recipe gallery (incl. renewal recipes), money-carrying templates (tasks + budget + payment schedule + expense categories in one apply), Timeline/Calendar views + dependencies + workload + portfolios + status updates, cash-flow forecast (forecast/actual separation, I2) + tax set-aside estimate, ledger-grounded AI features only (margin trends, miscategorization flags, quote advice), bank feed + reconciliation, QuickBooks/Xero export, capacity-aware booking, PWA polish, Asana/CSV importers.

---

## 8. Hard guardrails (do-nots)

- Do **not** rewrite or restructure the ledger engine, existing migrations, or working modules; new behavior comes via new migrations/tables/views/triggers.
- Do **not** build: email servers, e-sign legality, card handling (Stripe-hosted elements only), multi-currency, payroll, fixed assets, SSO/SCIM, native mobile, internal team chat, multi-homing tasks.
- Do **not** post costed time to the GL, ever (I4). Do not create any editable "total" column (I1/I2).
- Do **not** let any client-portal or contractor-visible surface depend on UI-level filtering for financial secrecy — RLS/views only (I6).
- Do **not** add dependencies outside the existing stack without asking (allowed additions when their phase arrives: Stripe SDK, an e-sign provider SDK, an ESP SDK, an OCR lib).
- Do **not** proceed past a phase gate, a failed acceptance item, or a Recon discrepancy without user approval.
- UI labels stay vertical ("Photographers", "Photographer Pay"); schema stays generic (D1/D2).

## 9. Working conventions

- Sequentially numbered migrations continuing the existing `00NN` scheme; every migration reversible or explicitly documented as not; never edit an applied migration.
- Every money feature ships with posting-rule tests; every table ships with RLS tests; run the full suite at every gate.
- Follow existing code patterns (TanStack Query hooks, component structure, Tailwind conventions) — match the codebase, not generic best practice.
- Keep `PROGRESS.md` current: phase, completed acceptance items, open questions, migration list.
- When ambiguity arises, prefer: (1) this spec, (2) the invariants §2, (3) ask the user. Never guess on money semantics.
