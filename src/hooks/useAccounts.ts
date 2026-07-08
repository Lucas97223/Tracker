import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { Account, AccountType, BalanceSide } from '../types/database';

export const accountsKey = ['accounts'] as const;

export function useAccounts(opts: { includeInactive?: boolean } = {}) {
  return useQuery({
    queryKey: [...accountsKey, opts.includeInactive ? 'all' : 'active'] as const,
    queryFn: async (): Promise<Account[]> => {
      let q = supabase.from('accounts').select('*').order('code', { ascending: true });
      if (!opts.includeInactive) q = q.eq('is_active', true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Account[];
    },
  });
}

export function useAccount(accountId: string | undefined) {
  return useQuery({
    queryKey: ['account', accountId] as const,
    enabled: !!accountId,
    queryFn: async (): Promise<Account | null> => {
      if (!accountId) return null;
      const { data, error } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', accountId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Account | null;
    },
  });
}

export interface AccountInput {
  code: string;
  name: string;
  type: AccountType;
  normal_balance: BalanceSide;
  parent_id?: string | null;
  description?: string | null;
  is_active?: boolean;
  currency?: string;
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AccountInput) => {
      const { data, error } = await supabase
        .from('accounts')
        .insert({
          currency: 'USD',
          is_active: true,
          parent_id: null,
          description: null,
          ...input,
        })
        .select('*')
        .single();
      if (error) throw error;
      return data as Account;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: accountsKey }),
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: { id: string } & Partial<AccountInput>) => {
      const { data, error } = await supabase
        .from('accounts')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as Account;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: accountsKey }),
  });
}
