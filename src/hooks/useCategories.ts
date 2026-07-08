import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { localDb } from '../lib/localDb';
import { useSyncContext } from '../providers/SyncProvider';
import type { Category } from '../types/database';

export const categoriesKey = ['categories'] as const;

export function useCategories(includeArchived = true) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...categoriesKey, includeArchived ? 'all' : 'active'] as const,
    queryFn: async (): Promise<Category[]> => {
      if (!isOnline) {
        const rows = await localDb.queryCategories();
        return includeArchived ? rows : rows.filter(c => !c.is_archived);
      }
      let q = supabase.from('categories').select('*').order('name', { ascending: true });
      if (!includeArchived) q = q.eq('is_archived', false);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data ?? [];
      await localDb.upsertManyCategories(rows);
      return rows;
    },
  });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; description?: string | null; color?: string }) => {
      const { data, error } = await supabase
        .from('categories')
        .insert({ name: input.name, description: input.description ?? null, color: input.color ?? '#64748b' })
        .select('*')
        .single();
      if (error) throw error;
      await localDb.upsertCategory(data);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: categoriesKey }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id, ...patch
    }: { id: string; name?: string; description?: string | null; color?: string; is_archived?: boolean }) => {
      const { data, error } = await supabase
        .from('categories')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      await localDb.upsertCategory(data);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: categoriesKey }),
  });
}
