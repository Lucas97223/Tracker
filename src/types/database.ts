// Hand-written types matching the Supabase schema in supabase/migrations.
// Regenerate via `supabase gen types typescript` if you prefer.

export type Role = 'admin' | 'editor' | 'viewer';
export type ProjectStatus = 'planning' | 'active' | 'completed' | 'archived';
export type AuditAction = 'create' | 'update' | 'delete';
export type AuditEntity =
  | 'year'
  | 'project'
  | 'expense'
  | 'category'
  | 'member'
  | 'profile'
  | 'organization'
  | 'team_member'
  | 'pay_item'
  | 'account'
  | 'journal_entry'
  | 'member_rate';

// --- Multi-tenancy (Phase 0.5) ---
export type OrgRole = 'owner' | 'admin' | 'member' | 'contractor' | 'viewer';
export type PayType = 'flat' | 'hourly' | 'none';
export type PayItemStatus = 'draft' | 'approved' | 'void';

export interface Organization {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OrgMember {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: string;
}

export interface TeamMember {
  id: string;
  org_id: string;
  display_name: string;
  email: string | null;
  profile_id: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayItem {
  id: string;
  org_id: string;
  project_id: string;
  project_member_id: string | null;
  team_member_id: string;
  description: string;
  amount: string; // numeric(14,2)
  pay_date: string;
  status: PayItemStatus;
  journal_entry_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemberRate {
  id: string;
  org_id: string;
  team_member_id: string;
  cost_rate: string | null;
  bill_rate: string | null;
  created_at: string;
  updated_at: string;
}

// --- Money-in (Phase 1) ---
export type ContactType = 'person' | 'company';
export type ContactLifecycle = 'lead' | 'client' | 'archived';
export type InvoiceStatus = 'draft' | 'sent' | 'partial' | 'paid' | 'void';
export type ScheduleStatus = 'pending' | 'paid' | 'cancelled';

export interface Contact {
  id: string;
  org_id: string;
  type: ContactType;
  lifecycle: ContactLifecycle;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  address: Record<string, unknown>;
  source: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaxRate {
  id: string;
  org_id: string;
  name: string;
  rate: string; // numeric fraction, e.g. "0.0825"
  liability_account_id: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: string;
  org_id: string;
  number: number;
  contact_id: string;
  project_id: string | null;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string | null;
  sent_at: string | null;
  memo: string | null;
  share_token: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceLine {
  id: string;
  org_id: string;
  invoice_id: string;
  description: string;
  qty: string;
  unit_price: string;
  tax_rate_id: string | null;
  revenue_account_id: string | null;
  source_type: string | null;
  source_id: string | null;
  line_number: number;
  created_at: string;
  updated_at: string;
}

export interface InvoiceTotals {
  invoice_id: string;
  org_id: string;
  subtotal: string;
  tax_total: string;
  total: string;
  paid: string;
  balance: string;
}

export interface Payment {
  id: string;
  org_id: string;
  invoice_id: string;
  payment_date: string;
  amount: string;
  method: string | null;
  reference: string | null;
  journal_entry_id: string;
  voided_at: string | null;
  reversal_entry_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PaymentSchedule {
  id: string;
  org_id: string;
  invoice_id: string | null;
  project_id: string | null;
  due_date: string;
  amount: string;
  status: ScheduleStatus;
  created_at: string;
  updated_at: string;
}

export interface Vendor {
  id: string;
  org_id: string;
  name: string;
  is_1099: boolean;
  email: string | null;
  phone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ArAgingRow {
  invoice_id: string;
  org_id: string;
  number: number;
  contact_id: string;
  contact_name: string;
  project_id: string | null;
  issue_date: string;
  due_date: string | null;
  status: InvoiceStatus;
  total: string;
  paid: string;
  balance: string;
  bucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
  days_overdue: number;
}

export interface PublicInvoice {
  number: number;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string | null;
  sent_at: string | null;
  memo: string | null;
  org_name: string;
  contact: { name: string; email: string | null; company: string | null } | null;
  project_name: string | null;
  lines: Array<{
    description: string;
    qty: string;
    unit_price: string;
    amount: string;
    tax_rate: string | null;
    tax_name: string | null;
  }>;
  totals: { subtotal: string; tax_total: string; total: string; paid: string; balance: string } | null;
}


// --- Tasks (Phase 2) ---
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type NotificationKind = 'assigned' | 'mention' | 'comment';

export interface TaskSection {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  org_id: string;
  project_id: string;
  section_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  start_date: string | null;
  due_date: string | null;
  sort_order: number;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskComment {
  id: string;
  org_id: string;
  task_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
}

export interface AppNotification {
  id: string;
  org_id: string;
  recipient_id: string;
  actor_id: string | null;
  kind: NotificationKind;
  task_id: string | null;
  project_id: string | null;
  body: string;
  read_at: string | null;
  created_at: string;
}

export interface TaskTemplate {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractorProject {
  id: string;
  org_id: string;
  name: string;
  status: ProjectStatus;
  project_type: string | null;
  location: string | null;
  start_date: string | null;
  end_date: string | null;
}

// --- Bookkeeping (M12) ---
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense' | 'cogs';
export type BalanceSide = 'debit' | 'credit';
export type PeriodStatus = 'open' | 'closed' | 'locked';
export type JournalSourceType =
  | 'manual'
  | 'expense'
  | 'invoice'
  | 'bill'
  | 'payment'
  | 'adjustment'
  | 'reversal'
  | 'pay_item';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  is_active: boolean;
  default_org_id?: string | null;
  created_at: string;
}

export interface Year {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  year_value: number;
  label: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  year_id: string;
  name: string;
  description: string | null;
  client: string | null;
  contact_id?: string | null; // FK to contacts since 0016; client text is legacy display
  location: string | null;
  project_type: string | null;
  status: ProjectStatus;
  start_date: string | null;
  end_date: string | null;
  client_paid: string; // numeric(14,2) — total paid by the client for this project
  photographers: string[]; // names of team members
  collection_details: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Category {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  name: string;
  description: string | null;
  color: string;
  is_archived: boolean;
  account_id: string | null;
  created_at: string;
}

export interface Account {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  code: string;
  name: string;
  type: AccountType;
  normal_balance: BalanceSide;
  parent_id: string | null;
  currency: string;
  is_active: boolean;
  is_system: boolean;
  description: string | null;
  created_at: string;
}

export interface AccountingPeriod {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  name: string;
  start_date: string;
  end_date: string;
  status: PeriodStatus;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
}

export interface JournalEntry {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  entry_date: string;
  reference: string | null;
  memo: string | null;
  source_type: JournalSourceType;
  source_id: string | null;
  project_id: string | null;
  period_id: string | null;
  posted: boolean;
  reversed_by: string | null;
  created_by: string | null;
  posted_at: string | null;
  created_at: string;
}

export interface JournalLine {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  journal_entry_id: string;
  account_id: string;
  description: string | null;
  debit: string; // numeric(14,2)
  credit: string;
  project_id: string | null;
  category_id: string | null;
  line_number: number;
}

export interface ExpenseJournalMap {
  expense_id: string;
  journal_entry_id: string;
  created_at: string;
}

// --- Report rows ---
export interface TrialBalanceRow {
  account_id: string;
  code: string;
  name: string;
  type: AccountType;
  normal_balance: BalanceSide;
  total_debit: string;
  total_credit: string;
  balance: string;
}

export interface AccountLedgerRow {
  line_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  normal_balance: BalanceSide;
  entry_id: string;
  entry_date: string;
  reference: string | null;
  memo: string | null;
  source_type: JournalSourceType;
  source_id: string | null;
  project_id: string | null;
  description: string | null;
  debit: string;
  credit: string;
  running_balance: string;
  line_number: number;
}

export interface ProjectPnLRow {
  project_id: string;
  project_name: string;
  year_id: string | null;
  revenue: string;
  cogs: string;
  expense: string;
  net_margin: string;
}

export interface Expense {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  project_id: string;
  category_id: string;
  description: string;
  amount: string; // numeric(14,2) arrives as string
  currency: string;
  expense_date: string;
  location: string | null;
  vendor: string | null;
  payment_method: string | null;
  receipt_url: string | null;
  notes: string | null;
  person_name: string | null; // attribution: who this expense was paid to / for
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Staffing shape since migration 0013 (was an unused user/permission ACL).
export interface ProjectMember {
  id: string;
  org_id: string;
  project_id: string;
  team_member_id: string;
  role_label: string;
  pay_type: PayType;
  agreed_pay: string | null;
  permission: 'edit' | 'view' | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  org_id?: string; // present on all rows since 0011; optional for stale local-mirror rows
  user_id: string | null;
  action: AuditAction;
  entity_type: AuditEntity;
  entity_id: string;
  changes: Record<string, unknown>;
  created_at: string;
}

// View / RPC return types
export interface YearRollup {
  year_id: string;
  year_value: number;
  label: string | null;
  total_amount: string;
  project_count: number;
  expense_count: number;
}

export interface ProjectRollup {
  project_id: string;
  year_id: string;
  name: string;
  status: ProjectStatus;
  total_amount: string;
  expense_count: number;
}

export interface CategoryRollup {
  category_id: string;
  name: string;
  color: string;
  total_amount: string;
  expense_count: number;
}

export interface LocationRollup {
  location: string;
  total_amount: string;
  expense_count: number;
}

export interface MonthlyRollup {
  month: string; // YYYY-MM-01
  total_amount: string;
  expense_count: number;
}

// Minimal stand-in for the generated Database type used by createClient.
// We keep this loose; queries are typed via the row interfaces above.
export type Database = {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile> & { id: string; email: string }; Update: Partial<Profile> };
      years: { Row: Year; Insert: Partial<Year> & { year_value: number }; Update: Partial<Year> };
      projects: { Row: Project; Insert: Partial<Project> & { year_id: string; name: string }; Update: Partial<Project> };
      categories: { Row: Category; Insert: Partial<Category> & { name: string }; Update: Partial<Category> };
      expenses: {
        Row: Expense;
        Insert: Partial<Expense> & {
          project_id: string;
          category_id: string;
          description: string;
          amount: string | number;
          expense_date: string;
        };
        Update: Partial<Expense>;
      };
      project_members: { Row: ProjectMember; Insert: ProjectMember; Update: Partial<ProjectMember> };
      audit_log: { Row: AuditLog; Insert: Partial<AuditLog>; Update: Partial<AuditLog> };
    };
    Views: {
      v_year_rollup: { Row: YearRollup };
      v_project_rollup: { Row: ProjectRollup };
      v_category_rollup: { Row: CategoryRollup };
      v_location_rollup: { Row: LocationRollup };
      v_monthly_rollup: { Row: MonthlyRollup };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
};
