# Unified Business Operating System — Master Build Specification

**One app that combines a client CRM (Dubsado-class), project & task management (Asana-class), and a real double-entry accounting/expense engine — into a single system for people who sell services and manage teams.**

- **Document version:** 1.0
- **Status:** Draft for audit / hand-off to another agent
- **Base date:** 2026-07-07
- **Owner:** Lucas
- **Existing codebase this builds on:** `expense-tracker` (React 18 + TypeScript + Vite + Tailwind + Supabase + Electron)

---

## 0. How to read and audit this document (note to the reviewing agent)

This file is intended to be **self-contained**: you should be able to audit, critique, and extend it without any other context. It describes (a) an existing, working application whose real schema and stack are documented in Section 3, and (b) the target unified product that extends it.

When auditing, please:

1. **Challenge the thesis (Section 1).** Is the "one connected spine" genuinely differentiated, or is it a feature bundle? Where is the moat weak?
2. **Stress-test the data model (Section 5).** Look for missing entities, denormalization risks, multi-tenant/RLS gaps, and places where the existing schema will fight the new requirements.
3. **Find functional gaps (Section 6).** Each incumbent (Dubsado, Asana) has features not yet captured. Flag anything missing that a real user would expect.
4. **Sanity-check the roadmap (Section 11).** Are phases correctly ordered by dependency and leverage? Is the MVP genuinely shippable?
5. **Interrogate the open decisions (Section 14).** These are unresolved; propose answers with tradeoffs.
6. **Use the audit checklist (Section 16)** as a structured pass.

Assumptions are marked **[ASSUMPTION]**. Open questions are marked **[OPEN]**. Items already built in the existing codebase are marked **[EXISTS]**. Net-new differentiators are marked **★**.

---

## 1. Vision & thesis

### 1.1 The problem
A service business runs on three disconnected systems:

- A **CRM / client-management tool** (e.g. Dubsado) owns the *relationship and the money coming in*: leads, proposals, contracts, invoices, scheduling. It is weak at managing the actual work.
- A **project-management tool** (e.g. Asana) owns *getting the work done*: projects, tasks, deadlines, collaboration. It has no concept of a client, a contract, an invoice, or an expense.
- An **expense/accounting tool** owns *money going out*. It usually knows nothing about which client or project the money belongs to.

Because these three worlds don't share data, the business owner cannot answer the single most important operational question:

> **"Is this client — and this project — actually profitable, once I account for the work, the time, and the costs?"**

They also pay for, log into, and re-enter data across three tools, with constant copy-paste between them.

### 1.2 The thesis
Build one product where the client relationship, the project delivery, and the full financial ledger share **one data model**, connected along a single spine:

```
LEAD → PROPOSAL → CONTRACT → PROJECT → TASKS → TIME LOGGED
                                          │
                    INVOICE (money in) ──►│◄── EXPENSES (money out)
                                          ▼
                     DOUBLE-ENTRY LEDGER → PROFITABILITY
                 (per client · per project · per month · per service type)
```

Because everything posts to a shared double-entry general ledger, the product delivers **live profit-per-client, profit-per-project, revenue-per-hour, and cash-flow forecasting** — capabilities none of the three incumbents can offer alone, because none owns all three data sets.

**The connective tissue is the product.** Every feature below serves the spine.

### 1.3 Why this is winnable now
The existing `expense-tracker` app already contains the hardest and least-glamorous piece: a **correct double-entry accounting engine with project-level P&L**. Most competitors bolt reporting on top of a flat transactions table; this product starts from a real ledger. The remaining work is additive (CRM front end + task layer + invoicing), not a rewrite.

### 1.4 One-line positioning
*"Win the client, do the work, get paid, and see your real profit — in one app."*

---

## 2. Target users & personas

### 2.1 Primary market
Solo operators and small teams (1–25 people) who **both sell and deliver** professional services, and who manage other people (employees, contractors, freelancers) to fulfill that work.

### 2.2 Personas
- **The owner-operator (primary buyer).** Runs a small studio/agency/practice. Cares about cash flow, whether clients are profitable, and not dropping balls. Currently juggles 3+ tools + a spreadsheet.
- **The team lead / project manager.** Assigns and tracks work, manages capacity, needs deadlines and dependencies. Lives in the project/task layer.
- **The team member / contractor.** Needs a clear task list, logs time, uploads deliverables. Minimal access.
- **The client (external).** Signs contracts, pays invoices, fills forms, optionally watches progress. Lives only in the client portal.
- **The bookkeeper / accountant (external or part-time).** Needs clean ledger exports, trial balance, P&L, and category/account integrity.

### 2.3 Beachhead vertical
The existing schema is shaped around **photography / event services** (`photographers[]`, project types like Wedding/Birthday/Conference/Photoshoot). Recommended go-to-market: **lead with this vertical** ("the operating system for photographers, studios, and event professionals") while keeping the schema generic underneath so horizontal expansion (consultants, agencies, coaches, trades, legal, creative freelancers) is a labeling change, not a re-architecture. See Sections 8.5 and 14.

---

## 3. Ground truth — the existing app (do not re-derive; extend this)

This is the real, working foundation. Everything in the target product extends it.

### 3.1 Stack **[EXISTS]**
- Frontend: React 18 + TypeScript + Vite + Tailwind CSS
- State/data: React Router, TanStack Query, React Hook Form + Zod, Recharts
- Backend: **Supabase** — Postgres + Auth + Row-Level Security (RLS) + Realtime
- Desktop: **Electron** packaging → Windows `.exe` installer and macOS `.dmg`, with a GitHub Actions release pipeline
- Testing: Vitest (money + CSV utilities)
- Money handling: `numeric(14,2)` in DB; parsed to integer cents in code via `src/lib/money.ts`; **no float arithmetic on money anywhere**; rendered via `Intl.NumberFormat`.

### 3.2 Core domain model **[EXISTS]**
Organized as **Year → Project → Category → Expense (line item)**.

- `profiles` — 1:1 with `auth.users`; fields `id, email, full_name, role, is_active`. Roles: `admin | editor | viewer`, org-wide, enforced by RLS. Invite-only: new users land `is_active = false`; first user bootstrapped as active admin.
- `years` — `year_value` unique; top-level grouping.
- `projects` — `year_id, name, location, status, dates, project_type` (free text: Wedding/Birthday/Conference/Photoshoot…), `client_paid numeric(14,2)`, `photographers text[]` (team on the project), `collection_details text`. GIN index on `photographers`.
- `expenses` — `project_id, category_id, amount numeric(14,2), expense_date, location, vendor, payment_method, receipt_url (link-only, uploads not wired), notes, description, person_name`. Indexed on `person_name`.
- `categories` — global, shared, archivable. A `BEFORE INSERT` trigger auto-creates a matching expense account in the Chart of Accounts.
- `project_members` — **stubbed in schema, not wired into the UI in v1** (`user_id, permission`). Ready to power per-project access and team/time modeling.
- `audit_log` — captures create/update/delete on the five primary entities plus role/active changes; full before/after row in `changes` JSONB.

### 3.3 Accounting engine **[EXISTS]** (migrations 0007–0008)
A real double-entry general ledger sits under the expense UI:

- `accounts` — Chart of Accounts: `code, name, type (asset|liability|equity|revenue|expense|cogs), normal_balance (debit|credit), parent_id, is_active, is_system, currency`.
- `journal_entries` — atomic events: `entry_date, memo, source_type, source_id, project_id, posted, reversed_by, period_id`.
- `journal_lines` — `account_id, debit numeric(14,2), credit numeric(14,2), project_id, category_id, line_number`. CHECK: each line is debit XOR credit.
- `accounting_periods` — `start_date, end_date, status (open|closed|locked)`.
- `expense_journal_map` — links each `expenses.id` to its current `journal_entries.id`.
- **Invariants (DB-enforced):** balanced entries (deferred constraint trigger re-checks `sum(debit)=sum(credit)` per entry at commit); posted entries immutable (corrections via reversal + replacement entries); categories always route to a real account.
- **Sync triggers:** every expense insert/update/delete is mirrored into balanced journal entries automatically (Dr category expense account, Cr Cash 1000). Cash-basis in v1; accrual (Accounts Payable) deferred.
- **Reporting views:** `v_trial_balance`, `v_account_ledger` (running balance via window function), `v_project_pnl` (revenue / COGS / expense / net margin per project).

### 3.4 Aggregation & sync **[EXISTS]**
- Rollup views: `v_year_rollup`, `v_project_rollup`, `v_category_rollup`, `v_location_rollup`, `v_monthly_rollup`.
- Filtered dashboard computes charts/KPIs client-side from a single fetch so totals always reconcile with CSV export.
- Realtime: one Supabase channel listening to `postgres_changes` on the primary tables invalidates TanStack Query keys → all clients update within seconds. Concurrency is last-write-wins; the audit log records who clobbered what.

### 3.5 Domain-specific behavior **[EXISTS]**
- `projects.photographers[]` names the team on a project.
- Adding a name to a project auto-creates a `$0` line in the **"Photographer Pay"** category attributed via `expenses.person_name` (trigger `sync_project_photographer_pay`). The user edits the row to set the real pay. Removing a name leaves the historical pay row intact. This is effectively a lightweight labor-cost model.

### 3.6 What the existing app already gives the unified product
It already **is** the *money + projects + profitability* spine. Concretely it provides: multi-user auth with RLS, an audit trail, realtime sync, a correct double-entry ledger, project-level P&L, per-person cost attribution, and shippable desktop installers. The unified product keeps all of this and builds outward.

### 3.7 The five concrete gaps to close
1. **Money-in is only a scalar** (`projects.client_paid`). Needs to become real **invoices → invoice lines → payment schedules → payments** that post revenue to the ledger (revenue accounts already exist).
2. **No front-of-funnel** — no leads, proposals, contracts/e-sign, forms, or scheduling.
3. **No task layer** — projects have no tasks/subtasks, dependencies, boards/timeline/calendar views, or assignments.
4. **No time tracking** — needed to convert the `person_name` labor model into true costed hours.
5. **`categories` is overloaded** — it serves both expense buckets and (via Photographer Pay) labor. Split as the model grows.

---

## 4. Product principles / design tenets

1. **The ledger is the source of truth for money.** Every money event (invoice, payment, expense, payroll, refund) posts a balanced journal entry. Reports read the ledger, never a shadow total.
2. **One object, many lenses.** A Project is simultaneously a CRM record's outcome, a container of tasks, and a P&L unit. Don't fork it into three disconnected objects.
3. **No re-entry across the spine.** Accepting a proposal creates the contract, the deposit invoice, and the project+tasks. Billable time and billable expenses flow onto invoices. Data is entered once.
4. **Profitability is ambient, not a report you go run.** Margin appears on the project header, the client profile, and the dashboard, live.
5. **Progressive disclosure.** A solo user should not drown in agency features; complexity reveals as the team grows.
6. **Secure multi-tenant by construction.** RLS on every table; least-privilege roles; clients see only their own portal slice.
7. **Money math is exact.** Integer-cents everywhere; no floats; explicit currency and rounding rules.
8. **Extend, don't rewrite.** Reuse the existing Supabase schema, ledger, and Electron shell.

---

## 5. Unified data model (extends the existing schema)

Legend: **[EXISTS]** already in the codebase · **NEW** to add · fields are illustrative, not final DDL.

```
organization/workspace (NEW — multi-brand support; [ASSUMPTION] single-org today)
 └─ profiles [EXISTS]  + NEW: cost_rate, bill_rate, capacity_hours, title, avatar
 └─ years [EXISTS]
 └─ contacts (NEW)  type: lead|client|company; name, emails[], phones[], company_id,
 │      tags[], source, owner_id, lifecycle_stage, custom_fields jsonb
 │   └─ deals/opportunities (NEW)  pipeline_id, stage, value, probability, expected_close
 │   └─ proposals (NEW) → contracts (NEW) → signatures (NEW)
 │   └─ activities (NEW)  emails, calls, notes, meetings — unified timeline
 │
 └─ projects [EXISTS]  + NEW: contact_id (FK→contacts), budget, service_type,
 │      billing_type (fixed|hourly|retainer), portal_visible bool
 │   ├─ tasks (NEW)  parent_task_id, title, description, assignee_id, status,
 │   │      start_date, due_date, priority, section_id, order, custom_fields jsonb,
 │   │      estimate_hours, is_milestone, approval_required
 │   │   └─ task_dependencies (NEW)  predecessor_id, successor_id, type
 │   │   └─ subtasks = tasks with parent_task_id
 │   │   └─ comments (NEW), attachments (NEW), checklists (NEW)
 │   ├─ time_entries (NEW)  user_id, task_id, project_id, start, end, hours,
 │   │      billable bool, bill_rate, cost_rate, invoiced_id, note
 │   ├─ expenses [EXISTS]  (already posts to journal_lines) + NEW: billable bool,
 │   │      markup_pct, invoiced_id
 │   ├─ invoices (NEW)  contact_id, project_id, number, issue_date, due_date,
 │   │      status, currency, subtotal, tax, total, balance, terms
 │   │   ├─ invoice_lines (NEW)  source (manual|time|expense|milestone),
 │   │   │      source_id, description, qty, unit_price, tax_rate, amount
 │   │   └─ payments (NEW)  method, amount, date, processor_ref → posts to ledger
 │   ├─ payment_schedules (NEW)  milestones/deposits/installments
 │   ├─ files (NEW), messages (NEW), approvals (NEW)
 │   └─ project_members [EXISTS-stub — wire up]  user_id, permission, allocation
 │
 ├─ categories [EXISTS]  ([OPEN] split into expense_categories vs. labor/pay)
 ├─ accounts / journal_entries / journal_lines [EXISTS]  ← reuse as the money backbone
 ├─ accounting_periods [EXISTS]
 ├─ audit_log [EXISTS]
 ├─ automations (NEW)  trigger, conditions[], actions[]
 ├─ templates (NEW)  project|task|email|proposal|contract; may carry budget+schedule
 ├─ forms (NEW)  schema jsonb, mapping (submission → contact/project fields)
 ├─ pipelines (NEW), goals (NEW), portfolios (NEW)
 └─ integrations (NEW)  provider, tokens, settings (Stripe, Google/Outlook, QBO/Xero…)
```

**Key migrations from current model:**
- `projects.client_paid` (scalar) → derived from `payments` posted to the ledger. Keep the column as a cached rollup, source it from real payments.
- `projects.photographers[]` → `project_members` + `time_entries`, costed at `profiles.cost_rate`; Photographer-Pay auto-sync becomes a special case of the general labor model.
- Give `projects` a `contact_id`; the existing project page instantly gains full client history.

**Profit formula (unchanged, richer inputs, all via the ledger):**
```
Project profit = Σ payments(revenue) − Σ expenses − Σ (time_entry.hours × cost_rate)
```

---

## 6. Exhaustive functional specification (by module)

Each capability is something a user must be able to do. ★ = net-new value beyond the three incumbents.

### 6.1 CRM & contacts (Dubsado-class)
- Create/edit contacts: people, leads, and companies; link people to companies.
- Custom fields, tags, lead source, owner assignment.
- Lead-capture forms (embeddable + shareable link); submissions auto-create a lead.
- Sales pipeline as a Kanban board with configurable stages (New → Qualified → Proposal → Won/Lost); drag between stages.
- Deals/opportunities with value, probability, expected close, and weighted pipeline totals.
- Unified activity timeline per contact: every email, form, proposal, contract, invoice, payment, project, and task.
- Notes, reminders, and follow-up tasks tied to a contact.
- Duplicate detection and merge.
- Segment/filter/saved views (e.g. "leads with no activity in 14 days").
- ★ **Unified profile** where relationship + delivery + money are the same record (the CRM contact and the project client are one object).

### 6.2 Sales, proposals & onboarding (Dubsado-class)
- Proposals/quotes with selectable packages and add-ons the client can choose.
- Contracts with legally-binding e-signatures for both parties; templates; version history; countersign.
- Smart forms: questionnaires, intake, lead-capture, feedback/offboarding; conditional logic; field mapping to contact/project.
- **Bundled "get started" flow:** proposal + contract + deposit invoice completed by the client in one sequence.
- Email templates with merge fields; scheduled sends; open/click tracking.
- Scheduling / appointment booking: availability rules, buffers, time zones, calendar sync, booking pages, reminders (a built-in Calendly-class booker).
- ★ **One-click "Win":** accepting a proposal auto-generates the contract, the deposit invoice, and the project with a task template — zero re-entry.

### 6.3 Projects & tasks (Asana-class)
- Projects with multiple views: **List, Board (Kanban), Timeline/Gantt, Calendar, Table.**
- Tasks, subtasks, dependencies, milestones, recurring tasks.
- Assignees (single + multi/collaborators), start/due dates, priorities, sections, tags, custom fields.
- Task + full project templates (reusable per service type).
- "My Tasks" cross-project personal list; unified inbox/notifications; @mentions.
- Milestones and **client approval gates** inside a project.
- Portfolios: group projects, roll up status/health.
- Workload/capacity view: who is over/under-allocated.
- Goals/OKRs tied to underlying project/financial data.
- Comments, attachments, activity feed per task.
- Project-level rules (status change → assign/notify/move).
- ★ **Templates that carry financials:** a template sets up tasks *and* budget, payment schedule, and expense categories in one click.
- ★ **Approval gates that release billing:** completing a client-approved milestone can auto-issue the milestone invoice.

### 6.4 Time tracking
- Start/stop timer and manual entry, against a task or project.
- Billable vs. non-billable; bill rate + cost rate per person/client/project.
- Timesheets, weekly view, approvals, locking.
- ★ **Time → invoice bridge:** billable hours flow onto a draft invoice; nothing re-keyed.
- ★ **Time → profitability:** entries costed at `cost_rate` post labor cost so projects show true margin, not just revenue.
- Idle detection, reminders to log time, mobile timer.

### 6.5 Invoicing & payments — money in (Dubsado-class)
- Invoices + recurring invoices; deposits, milestone billing, installment/payment plans, retainers.
- Invoice lines sourced from manual entry, billable time, billable expenses, or milestones.
- Online payments: card, ACH/bank, wallets, via integrated processor (Stripe [ASSUMPTION]).
- Auto-reminders for overdue invoices; auto late fees; dunning sequences.
- Tax/VAT, multi-currency, discounts, credit notes, refunds.
- Client self-serve payment page + emailed receipts.
- Revenue tracking, AR aging, reconciliation; **every payment posts to the ledger.**

### 6.6 Expenses — money out (**[EXISTS]**, extend)
- Manual entry, receipt photo/scan with OCR (wire up the `receipt_url` → Supabase Storage), bank/card feed import.
- Categorize; recurring/subscription expenses; vendors; payment methods.
- ★ **Tag each expense to client and/or project and/or task** (project/category already exist; add task + billable).
- Mark billable → push onto a client invoice with optional markup.
- Mileage/travel, per-diems.
- Budgets per project and per category with over-budget alerts.
- Tax-deductible flagging; year-end tax export.

### 6.7 Accounting / ledger (**[EXISTS]**, expose & extend)
- Chart of Accounts management UI; journal browser; general ledger by account; trial balance; project P&L (all views exist — build the read UI).
- Accounting periods: open/close/lock; period-end checks.
- Accrual support via Accounts Payable (Bills milestone) — currently cash-basis.
- Bank reconciliation; export to QuickBooks/Xero; accountant access role.
- ★ **Because revenue, labor, and expenses all post here, the P&L is real** — not a spreadsheet approximation.

### 6.8 Financial intelligence ★ (the differentiator layer)
- **P&L per client, per project, per month, per service type** — revenue − expenses − costed time.
- **Cash-flow forecast:** scheduled invoices + payment plans + recurring income vs. upcoming/recurring expenses → runway.
- **Effective hourly rate** by client and service type (underpricing detector).
- **Client profitability ranking.**
- **Quote-to-actual variance:** estimated vs. real time + cost per project.
- Owner dashboard: money in/out, outstanding AR, this-month margin at a glance.
- ★ **Pricing feedback:** warns when a proposal is priced below historical margin for that service type.

### 6.9 Client portal (Dubsado-class, upgraded)
- Branded portal: the client sees only their contracts, invoices, forms, files, appointments.
- ★ **Optional project transparency:** clients can see progress, milestones, and approvals — bridging Dubsado's portal with Asana's visibility (neither offers both).
- Client-side approvals, comments, file uploads, messaging thread.

### 6.10 Communication & collaboration
- Built-in email tied to the contact record; templates; scheduled sends; tracking.
- Internal team comments/chat; client messaging.
- Notifications + unified activity inbox; digest emails.

### 6.11 Files & assets
- File storage per client/project/task; versioning; previews.
- Cloud-drive integrations (Google Drive, Dropbox).
- Deliverable galleries (fits the photography vertical).

### 6.12 Automation & workflows (Dubsado + Asana, merged)
- Visual workflow builder spanning the whole lifecycle, not one silo.
- Triggers: form submitted, proposal accepted, invoice paid, task completed, date reached, status changed, contact stage changed.
- Actions: send email, create/assign task, generate invoice, move pipeline stage, start project, apply template, notify, wait/delay.
- ★ **Cross-domain automations impossible in separate tools**, e.g. *"final invoice paid → mark project complete → send offboarding form → schedule 3-month check-in → create renewal lead."*

### 6.13 Reporting, dashboards & goals
- Customizable dashboards mixing sales, delivery, and financial widgets.
- Reports: pipeline, revenue, expenses, profitability, utilization, project status, overdue, AR aging.
- Goals/OKRs tied to real data; scheduled report emails; shareable read-only dashboards.

### 6.14 Team, roles & permissions
- Roles: owner/admin, editor/member, contractor (limited), viewer, client (portal-only), accountant.
- Per-project membership (wire up `project_members`) and allocation.
- Cost/bill rates per person; capacity.
- Audit log (exists) surfaced in an admin view.

### 6.15 Admin, settings & integrations
- Multiple workspaces/brands; branding.
- Integrations: calendars (Google/Outlook), accounting (QuickBooks/Xero), payments (Stripe), email, Zapier/public API, cloud storage.
- **Importers from Dubsado, Asana, and CSV** — critical for switchers.
- Data export; GDPR delete; backups.

### 6.16 AI assistance layer ★
- Draft proposals and emails from a short brief.
- Auto-categorize expenses and match receipts (OCR + classification).
- Generate a project plan / task list from an accepted proposal or service type.
- Summarize client history; surface "clients at risk" and "invoices likely to pay late."
- Natural-language reporting ("show me my least profitable clients this quarter").

### 6.17 Mobile companion
- Log time, snap receipts, check/complete tasks, view client info, get notifications.
- React Native/Expo or responsive PWA reusing the Supabase backend + RLS.

---

## 7. Exciting add-ons / net-new value (why it's a new category, not a bundle)

1. ★ **Live profitability everywhere** — every client, project, month, and service type shows real margin from the ledger. Headline feature.
2. ★ **The unified lifecycle spine** — one object flows lead→cash with zero re-entry.
3. ★ **Cash-flow forecasting / runway** — combines scheduled invoices, plans, and recurring expenses.
4. ★ **Smart pricing feedback** — learns real cost-to-deliver; flags underpriced proposals.
5. ★ **Cross-domain automation** — workflows crossing sales/delivery/finance boundaries.
6. ★ **AI assist layer** — drafting, categorization, plan generation, risk surfacing, NL reporting.
7. ★ **Client + project portal in one** — clients see progress *and* financials in one branded space.
8. ★ **Templates that carry money** — packages set up tasks, budget, payment schedule, and expense categories at once.
9. ★ **Retention / renewal engine** — auto follow-ups, check-ins, and renewal leads generated from delivery data.
10. ★ **One migration path** — importers from Dubsado + Asana + spreadsheets to remove the switching barrier.
11. ★ **Profit-share / team-pay automation** — extend the Photographer-Pay model into rule-based contractor payouts tied to project revenue.
12. ★ **Benchmarks (later, privacy-safe)** — anonymized "how your margins/rates compare" across the user base.

---

## 8. Integration strategy — how the three fuse into one coherent app

### 8.1 The spine as the organizing principle
Do not model the product as "three apps in tabs." Model it as one lifecycle. The **Contact** and the **Project** are the two hub objects; **money** (invoices + expenses + ledger) attaches to the project; **tasks + time** attach to the project; **the client** attaches to the contact. Profit rolls up project → client → workspace.

### 8.2 Canonical end-to-end flow
1. Lead arrives (form/manual) → Contact created, enters pipeline.
2. Proposal sent → accepted → **Win** auto-creates contract + deposit invoice + Project (from template).
3. Project spawns tasks (from template); team assigned via `project_members`.
4. Team logs **time** against tasks (costed) and **expenses** against the project (some billable).
5. Milestones/approvals gate progress; approved milestones trigger invoices.
6. Invoices sent; **payments post revenue to the ledger**.
7. Ledger computes **live P&L**; dashboards show margin and cash-flow.
8. Final payment → automation closes project, sends offboarding form, schedules check-in, creates renewal lead.

### 8.3 Shared services that make it coherent
- **One ledger** for all money (already exists).
- **One identity/permission system** (RLS, roles) for staff + clients.
- **One automation engine** whose triggers/actions span every module.
- **One template system** that provisions tasks + financial structure together.
- **One activity timeline** aggregating events from every module onto the contact/project.
- **One notification inbox.**

### 8.4 Anti-patterns to avoid
- Duplicating "client" as separate CRM-contact and project-client records.
- A reporting layer that sums a shadow transactions table instead of the ledger.
- Per-module permission systems that don't compose.
- Invoicing that doesn't post to the GL (breaks the whole thesis).

### 8.5 Vertical vs. horizontal
Keep photography/events framing for marketing; keep schema generic (`photographers[]`→`team_members[]`, "Photographer Pay"→"Team Pay") so horizontal expansion is a labeling change. **[OPEN]** — see Section 14.

---

## 9. Information architecture / navigation

| Nav item | Contents |
|---|---|
| **Home / Dashboard** | Today's tasks, money snapshot, alerts, pipeline summary, margin. |
| **Inbox** | Unified notifications, mentions, approvals, client replies. |
| **Contacts (CRM)** | Leads, clients, companies, pipeline board, activity timelines. |
| **Sales** | Proposals, contracts, forms, scheduler/booking. |
| **Projects** | List/Board/Timeline/Calendar/Table, My Tasks, templates, portfolios, workload. |
| **Time** | Timer, timesheets, approvals. |
| **Money** | Invoices & payments (in), Expenses (out), Budgets, Profitability & cash-flow, Ledger/Accounting. |
| **Automations** | Workflow builder, templates, rules. |
| **Reports** | Dashboards, goals, exports. |
| **Client Portal** | (Client-facing) contracts, invoices, files, progress. |
| **Settings** | Team, roles, rates, brands, integrations, billing, imports. |

Design rules: Contact and Project are linked but distinct; "Money" unifies in/out/analysis so profitability is first-class.

---

## 10. Technical architecture

### 10.1 Keep the base
React 18 + TS + Vite + Tailwind + Supabase (Postgres/Auth/RLS/Realtime) + Electron. This is a sound foundation; extend it rather than replace.

### 10.2 Backend
- Postgres schema extended per Section 5; keep the double-entry ledger as the money backbone.
- Business logic in **Supabase Edge Functions / Postgres RPCs** (invoicing, payment webhooks, automation execution) to preserve the single-backend model.
- Row-Level Security on every new table; clients restricted to their portal slice via a `client` role + membership checks.
- Realtime channels extended to new tables (tasks, invoices, messages) reusing the existing invalidation pattern.
- Money remains `numeric(14,2)` / integer-cents; explicit currency + rounding; multi-currency via an `fx_rates` table applied in views.

### 10.3 Integrations
- Payments: Stripe (Connect for payouts) [ASSUMPTION].
- Calendars: Google/Outlook OAuth.
- Accounting: QuickBooks/Xero export/sync.
- Email: transactional (Postmark/SES) + optional inbox sync (Gmail/Outlook).
- Storage: Supabase Storage buckets (RLS-keyed) for receipts, files, deliverables.
- Public REST/GraphQL API + webhooks; Zapier app.

### 10.4 Clients
- Web app (primary).
- Desktop via existing Electron shell.
- Mobile companion (React Native/Expo or PWA).
- Public client portal (separate, minimal surface).

### 10.5 Non-functional requirements
- **Security:** RLS everywhere; least privilege; audit log on all entities; encrypted secrets; SOC2-track practices [ASSUMPTION future].
- **Performance:** views/RPCs for rollups; pagination; indexes on FKs, dates, `person_name`, pipeline stage.
- **Reliability:** DB constraints enforce money invariants; idempotent payment webhooks; backups.
- **Compliance:** GDPR (export/delete), e-signature legal validity, tax handling, data residency [OPEN].
- **Accessibility & i18n:** WCAG AA target; localizable currency/date/number (base currency already configurable); multi-language [OPEN].
- **Offline:** desktop/mobile graceful degradation; last-write-wins with audit (as today) or move to CRDT/optimistic later [OPEN].

---

## 11. Roadmap (phased, dependency-ordered, with acceptance criteria)

**Phase 0 — Foundation [EXISTS / DONE]:** projects, expenses, double-entry GL, project P&L, roles/RLS, audit, realtime, desktop installers.
- *Acceptance:* already shipped.

**Phase 1 — Money in (invoicing).** Turn `client_paid` into invoices → lines → payment schedules → payments posting revenue to the ledger. Stripe payments; receipts; AR aging.
- *Acceptance:* an invoice can be issued, paid online, and the payment appears as a balanced revenue journal entry; `v_project_pnl` reflects real collected revenue; AR aging report reconciles with the ledger.

**Phase 2 — Tasks.** Task layer on existing projects: tasks/subtasks, assignees, due dates, sections; List + Board views; My Tasks; comments/@mentions.
- *Acceptance:* a project shows tasks in List and Board; tasks assign, move status, and notify; My Tasks aggregates across projects.

**Phase 3 — Time tracking.** Timer + manual entry against tasks; billable/cost rates; timesheets; time→invoice and time→P&L.
- *Acceptance:* logged billable time appears on a draft invoice and as labor cost reducing project margin in `v_project_pnl`.

> **MVP line — Phases 0–3 = a sellable product** against both incumbents: *"the only tool that shows, live, whether each project and client actually made money."*

**Phase 4 — CRM front end.** `contacts` + `contact_id` on projects; pipeline board; deals; activity timeline; lead-capture forms.
- *Acceptance:* a lead can be captured, moved through a pipeline, and converted into a project carrying its client history.

**Phase 5 — Sell & onboard.** Proposals, contracts/e-sign, intake forms, scheduler, client portal, one-click "Win".
- *Acceptance:* a client can accept a proposal, e-sign, pay a deposit, and land in a portal — auto-creating contract + invoice + project + tasks.

**Phase 6 — Financial intelligence.** Cash-flow forecast, effective-rate, client profitability ranking, quote-to-actual variance, pricing feedback.
- *Acceptance:* dashboards render each metric from ledger + time data and reconcile with underlying records.

**Phase 7 — Automate & scale.** Workflow builder, financial templates, AI assist, Timeline/Calendar/Workload views, portfolios/goals, integrations (QBO/Xero, Google/Outlook), mobile, importers (Dubsado/Asana/CSV).
- *Acceptance:* a cross-domain automation runs end-to-end; a template provisions tasks+budget+schedule; a Dubsado/Asana import lands cleanly.

**Phase 8 — Platform & growth.** Public API/webhooks, Zapier, benchmarks, multi-brand, accountant access, SOC2-track hardening.

---

## 12. Monetization & positioning

- **Against Dubsado:** "Dubsado wins the client — but can't manage the work or tell you if you made money. We do all three."
- **Against Asana:** "Asana manages the work — but has no clients, contracts, invoices, or expenses, and your projects don't know if they're profitable. Ours do."
- **Pricing [ASSUMPTION]:** Solo tier (vs. Dubsado flat plan) → Team/per-seat tier (vs. Asana) → Business tier with financial intelligence + automation. Payment processing as a natural secondary revenue stream.
- **Growth levers:** migration importers (remove switching cost) + the profitability dashboard (the wedge) + vertical marketing (photographers/events first).

---

## 13. Competitive feature-parity notes (for the auditor to complete)

- **Dubsado parity to verify:** client portal depth, form conditional logic, contract legal robustness, scheduler feature-completeness, email marketing, bookkeeping reports.
- **Asana parity to verify:** dependencies/critical path, timeline/Gantt, custom fields, rules engine depth, portfolios, workload, goals, forms, multi-home tasks, advanced search.
- **Accounting parity to verify:** accrual/AP, bank reconciliation, tax/VAT regimes, multi-currency, QBO/Xero fidelity, period close.

*The auditing agent should expand each of these into a concrete parity matrix and flag gaps.*

---

## 14. Open decisions (resolve with tradeoffs)

- **[OPEN] Vertical vs. horizontal at launch.** Recommend vertical marketing + generic schema. Auditor: confirm or challenge.
- **[OPEN] Payments processor** (Stripe assumed) and payout model (Stripe Connect for team profit-share).
- **[OPEN] Split `categories`** into expense-categories vs. labor/pay — when and how without breaking the auto-account trigger.
- **[OPEN] Concurrency model** — keep last-write-wins + audit, or move to optimistic/CRDT for tasks and docs.
- **[OPEN] Multi-tenancy** — single-org today; when to introduce `organization` and how it interacts with RLS.
- **[OPEN] Client portal auth** — magic-link vs. full accounts; isolation guarantees.
- **[OPEN] Accrual vs. cash basis** timeline and AP (Bills) design.
- **[OPEN] Data residency / compliance** targets for the intended markets.
- **[OPEN] AI provider & data-privacy posture** for the assist layer.

---

## 15. Glossary

- **Spine** — the shared lifecycle connecting lead → cash through one data model.
- **Ledger / GL** — the double-entry general ledger; source of truth for money.
- **Project** — hub object: a unit of client work, tasks, time, and P&L.
- **Contact** — CRM record: lead, client, or company.
- **P&L** — profit and loss; here computed per project/client/month/service type.
- **RLS** — Postgres Row-Level Security enforcing per-user/role data access.
- **Costed time** — time entries valued at a person's `cost_rate` to compute true margin.

---

## 16. Audit checklist (structured pass for the reviewing agent)

**Strategy**
- [ ] Is the "one spine" thesis a real moat, or a bundle? Where is it weakest?
- [ ] Is the beachhead vertical correct? Is horizontal expansion realistic from this schema?

**Data model**
- [ ] Any missing core entities? (billing schedules, credit notes, refunds, tax rates, currencies…)
- [ ] Does giving `projects.contact_id` cleanly connect CRM ↔ delivery ↔ money?
- [ ] Are RLS/multi-tenant boundaries defined for every new table, including the client portal?
- [ ] Does every money event post to the ledger? Any path that bypasses it?
- [ ] Is the `categories` overload resolved safely w.r.t. the auto-account trigger?

**Functional completeness**
- [ ] Build the Dubsado and Asana parity matrices (Section 13). Flag gaps.
- [ ] Are approval gates, dependencies, recurring tasks, and templates fully specified?
- [ ] Is invoicing complete (deposits, milestones, retainers, credit notes, refunds, dunning)?

**Roadmap**
- [ ] Are phases dependency-correct? Is Phases 0–3 genuinely a sellable MVP?
- [ ] Any high-risk item that should move earlier (e.g. payments compliance)?

**Technical / NFR**
- [ ] Money math exactness preserved end-to-end (integer cents, no floats)?
- [ ] Payment webhook idempotency; period close; reconciliation correctness.
- [ ] Performance of rollups at 10k–100k rows; indexing plan.
- [ ] Security review of client-portal isolation.

**Open decisions**
- [ ] Provide a recommended answer + tradeoffs for every item in Section 14.

---

*End of master specification v1.0. This document is intended to be improved: the reviewing agent should return an annotated version with gaps, corrections, a competitive parity matrix, and resolved open decisions.*
