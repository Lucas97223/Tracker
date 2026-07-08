import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useSyncContext } from '../providers/SyncProvider';
import type { PayItem } from '../types/database';

// Staffing + pay-item hooks (Phase 0.5). Pay data is not mirrored into the
// local SQLite cache — these views are online-only, like the ledger reports.

export const teamKey = ['team'] as const;
export const payItemsKey = ['pay-items'] as const;

export type PayItemWithMember = PayItem & {
  team_member: { display_name: string } | null;
};

export function usePayItemsForProject(projectId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...payItemsKey, 'project', projectId] as const,
    enabled: !!projectId && isOnline,
    queryFn: async (): Promise<PayItemWithMember[]> => {
      if (!projectId) return [];
      const { data, error } = await supabase
        .from('pay_items')
        .select('*, team_member:team_members(display_name)')
        .eq('project_id', projectId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PayItemWithMember[];
    },
  });
}

/** Approved pay across all projects — the dashboard's per-photographer union. */
export function useApprovedPay() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...payItemsKey, 'approved'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<PayItemWithMember[]> => {
      const { data, error } = await supabase
        .from('pay_items')
        .select('*, team_member:team_members(display_name)')
        .eq('status', 'approved')
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as unknown as PayItemWithMember[];
    },
  });
}

function invalidatePay(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: payItemsKey });
  qc.invalidateQueries({ queryKey: ['reports'] });
  qc.invalidateQueries({ queryKey: ['journal'] });
}

export function useUpdatePayItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: { id: string } & Partial<Pick<PayItem, 'amount' | 'pay_date' | 'description'>>) => {
      const { data, error } = await supabase
        .from('pay_items')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as PayItem;
    },
    onSuccess: () => invalidatePay(qc),
  });
}

export function useApprovePayItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('approve_pay_item', { p_id: id });
      if (error) throw error;
      return data as PayItem;
    },
    onSuccess: () => invalidatePay(qc),
  });
}

export function useVoidPayItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('void_pay_item', { p_id: id });
      if (error) throw error;
      return data as PayItem;
    },
    onSuccess: () => invalidatePay(qc),
  });
}
