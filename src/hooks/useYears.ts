import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { localDb } from '../lib/localDb';
import { useSyncContext } from '../providers/SyncProvider';
import { useAuth } from '../providers/AuthProvider';
import type { Year, YearRollup } from '../types/database';

export const yearsKey = ['years'] as const;
export const yearRollupKey = ['year-rollup'] as const;

export function useYears() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: yearsKey,
    queryFn: async (): Promise<Year[]> => {
      if (!isOnline) return localDb.queryYears();
      const { data, error } = await supabase
        .from('years')
        .select('*')
        .order('year_value', { ascending: false });
      if (error) throw error;
      const rows = data ?? [];
      await localDb.upsertManyYears(rows);
      return rows;
    },
  });
}

export function useYearRollups() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: yearRollupKey,
    queryFn: async (): Promise<YearRollup[]> => {
      if (!isOnline) {
        const cached = await localDb.getCache<YearRollup[]>('year-rollup');
        return cached?.data ?? [];
      }
      const { data, error } = await supabase
        .from('v_year_rollup')
        .select('*')
        .order('year_value', { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as YearRollup[];
      await localDb.setCache('year-rollup', rows);
      return rows;
    },
  });
}

export function useCreateYear() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: { year_value: number; label?: string | null }): Promise<Year> => {
      if (!isOnline) {
        const row: Year = {
          id: crypto.randomUUID(),
          year_value: input.year_value,
          label: input.label ?? null,
          created_by: user?.id ?? null,
          created_at: new Date().toISOString(),
        };
        await localDb.upsertYear(row);
        await localDb.enqueue('years', row.id, 'insert', row);
        return row;
      }
      const { data, error } = await supabase
        .from('years')
        .insert({ year_value: input.year_value, label: input.label ?? null })
        .select('*')
        .single();
      if (error) throw error;
      await localDb.upsertYear(data);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: yearsKey });
      qc.invalidateQueries({ queryKey: yearRollupKey });
    },
  });
}

export function useUpdateYear() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; label?: string | null; year_value?: number }): Promise<Year> => {
      if (!isOnline) {
        const years = await localDb.queryYears();
        const existing = years.find(y => y.id === id);
        if (!existing) throw new Error('Year not found in local cache — connect to internet to edit.');
        const updated: Year = { ...existing, ...patch };
        await localDb.upsertYear(updated);
        await localDb.enqueue('years', id, 'update', updated);
        return updated;
      }
      const { data, error } = await supabase.from('years').update(patch).eq('id', id).select('*').single();
      if (error) throw error;
      await localDb.upsertYear(data);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: yearsKey });
      qc.invalidateQueries({ queryKey: yearRollupKey });
    },
  });
}

export function useDeleteYear() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (!isOnline) {
        await localDb.deleteYear(id);
        await localDb.enqueue('years', id, 'delete', { id });
        return;
      }
      const { error } = await supabase.from('years').delete().eq('id', id);
      if (error) throw error;
      await localDb.deleteYear(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: yearsKey });
      qc.invalidateQueries({ queryKey: yearRollupKey });
    },
  });
}
