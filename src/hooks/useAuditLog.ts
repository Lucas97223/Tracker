import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { AuditEntity, AuditLog, Profile } from '../types/database';

export interface AuditFilters {
  userId?: string;
  entityType?: AuditEntity;
  startDate?: string;
  endDate?: string;
}

export function useAuditLog(filters: AuditFilters = {}, limit = 200) {
  return useQuery({
    queryKey: ['audit-log', filters, limit] as const,
    queryFn: async () => {
      let q = supabase
        .from('audit_log')
        .select('*, user:profiles(id, full_name, email)')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (filters.userId) q = q.eq('user_id', filters.userId);
      if (filters.entityType) q = q.eq('entity_type', filters.entityType);
      if (filters.startDate) q = q.gte('created_at', filters.startDate);
      if (filters.endDate) q = q.lte('created_at', filters.endDate);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as (AuditLog & { user: Pick<Profile, 'id' | 'full_name' | 'email'> | null })[];
    },
  });
}
