// Hand-written types matching the Supabase schema in supabase/migrations.
// Regenerate via `supabase gen types typescript` if you prefer.

export type Role = 'admin' | 'editor' | 'viewer';
export type ProjectStatus = 'planning' | 'active' | 'completed' | 'archived';
export type AuditAction = 'create' | 'update' | 'delete';
export type AuditEntity = 'year' | 'project' | 'expense' | 'category' | 'member' | 'profile';

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
  | 'reversal';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: Role;
  is_active: boolean;
  created_at: string;
}

export interface Year {
  id: string;
  year_value: number;
  label: string | null;
  created_by: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  year_id: string;
  name: string;
  description: string | null;
  client: string | null;
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
  name: string;
  description: string | null;
  color: string;
  is_archived: boolean;
  account_id: string | null;
  created_at: string;
}

export interface Account {
  id: string;
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

export interface ProjectMember {
  project_id: string;
  user_id: string;
  permission: 'edit' | 'view';
}

export interface AuditLog {
  id: string;
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
