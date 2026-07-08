import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { AccountLedgerRow, ProjectPnLRow, TrialBalanceRow } from '../types/database';

export const reportsKey = ['reports'] as const;

/**
 * Trial balance: every account with totals and signed balance.
 * The fundamental smoke test for the engine: sum of debits across all
 * accounts must equal sum of credits. The dashboard surfaces this so a
 * broken state is immediately visible.
 */
export function useTrialBalance() {
  return useQuery({
    queryKey: [...reportsKey, 'trial-balance'] as const,
    queryFn: async (): Promise<TrialBalanceRow[]> => {
      const { data, error } = await supabase
        .from('v_trial_balance')
        .select('*')
        .order('code', { ascending: true });
      if (error) throw error;
      return (data ?? []) as TrialBalanceRow[];
    },
  });
}

export interface AccountLedgerFilters {
  startDate?: string;
  endDate?: string;
  projectId?: string;
}

/**
 * General ledger for a single account, in date order, with running balance.
 * Filters narrow the date range and optionally a project dimension.
 */
export function useAccountLedger(
  accountId: string | undefined,
  filters: AccountLedgerFilters = {},
) {
  return useQuery({
    queryKey: [...reportsKey, 'ledger', accountId, filters] as const,
    enabled: !!accountId,
    queryFn: async (): Promise<AccountLedgerRow[]> => {
      if (!accountId) return [];
      let q = supabase
        .from('v_account_ledger')
        .select('*')
        .eq('account_id', accountId)
        .order('entry_date', { ascending: true })
        .order('entry_id', { ascending: true })
        .order('line_number', { ascending: true });
      if (filters.startDate) q = q.gte('entry_date', filters.startDate);
      if (filters.endDate) q = q.lte('entry_date', filters.endDate);
      if (filters.projectId) q = q.eq('project_id', filters.projectId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as AccountLedgerRow[];
    },
  });
}

/**
 * Project P&L: revenue, COGS, expense, net margin per project. Computed
 * server-side via v_project_pnl so totals stay consistent with the ledger.
 */
export function useProjectPnL(projectId?: string) {
  return useQuery({
    queryKey: [...reportsKey, 'project-pnl', projectId ?? 'all'] as const,
    queryFn: async (): Promise<ProjectPnLRow[]> => {
      let q = supabase.from('v_project_pnl').select('*');
      if (projectId) q = q.eq('project_id', projectId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ProjectPnLRow[];
    },
  });
}
