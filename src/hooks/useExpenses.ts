import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { config } from '../lib/config';
import { localDb } from '../lib/localDb';
import { useSyncContext } from '../providers/SyncProvider';
import { useAuth } from '../providers/AuthProvider';
import type { Expense } from '../types/database';

export const expensesKey = ['expenses'] as const;

export function useExpensesForProject(projectId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: ['expenses', 'project', projectId] as const,
    enabled: !!projectId,
    queryFn: async (): Promise<Expense[]> => {
      if (!projectId) return [];
      if (!isOnline) return localDb.queryExpenses(projectId);
      const { data, error } = await supabase
        .from('expenses')
        .select('*')
        .eq('project_id', projectId)
        .order('expense_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = data ?? [];
      await localDb.upsertManyExpenses(rows);
      return rows;
    },
  });
}

export interface ExpenseInput {
  project_id: string;
  category_id: string;
  description: string;
  amount: string | number;
  expense_date: string;
  location?: string | null;
  vendor?: string | null;
  payment_method?: string | null;
  receipt_url?: string | null;
  notes?: string | null;
  currency?: string;
  person_name?: string | null;
  billable?: boolean;
}

export function useCreateExpense() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: ExpenseInput): Promise<Expense> => {
      if (!isOnline) {
        const now = new Date().toISOString();
        const row: Expense = {
          id: crypto.randomUUID(),
          currency: config.baseCurrency,
          location: null, vendor: null, payment_method: null,
          receipt_url: null, notes: null, person_name: null,
          ...input,
          amount: input.amount.toString(),
          created_by: user?.id ?? null,
          created_at: now,
          updated_at: now,
        };
        await localDb.upsertExpense(row);
        await localDb.enqueue('expenses', row.id, 'insert', row);
        return row;
      }
      const { data, error } = await supabase
        .from('expenses')
        .insert({ currency: config.baseCurrency, ...input, amount: input.amount.toString() })
        .select('*')
        .single();
      if (error) throw error;
      await localDb.upsertExpense(data);
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['expenses', 'project', vars.project_id] });
      qc.invalidateQueries({ queryKey: ['project-rollup'] });
      qc.invalidateQueries({ queryKey: ['year-rollup'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<ExpenseInput>): Promise<Expense> => {
      if (!isOnline) {
        const existing = await localDb.getExpense(id);
        if (!existing) throw new Error('Expense not found in local cache — connect to internet to edit.');
        const now = new Date().toISOString();
        const updated: Expense = {
          ...existing,
          ...patch,
          amount: patch.amount !== undefined ? patch.amount.toString() : existing.amount,
          updated_at: now,
        };
        await localDb.upsertExpense(updated);
        await localDb.enqueue('expenses', id, 'update', updated);
        return updated;
      }
      const payload: Record<string, unknown> = { ...patch };
      if (patch.amount !== undefined) payload.amount = patch.amount.toString();
      const { data, error } = await supabase
        .from('expenses')
        .update(payload)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      await localDb.upsertExpense(data);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['project-rollup'] });
      qc.invalidateQueries({ queryKey: ['year-rollup'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (!isOnline) {
        await localDb.deleteExpense(id);
        await localDb.enqueue('expenses', id, 'delete', { id });
        return;
      }
      const { error } = await supabase.from('expenses').delete().eq('id', id);
      if (error) throw error;
      await localDb.deleteExpense(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['project-rollup'] });
      qc.invalidateQueries({ queryKey: ['year-rollup'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
