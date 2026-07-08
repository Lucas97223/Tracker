import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useSyncContext } from '../providers/SyncProvider';
import type { Contact, ContactLifecycle, ContactType } from '../types/database';

// Contacts: the single client identity (I3). Online-only in Phase 1 (no local
// mirror); project modals fall back to the legacy free-text client field when
// offline.

export const contactsKey = ['contacts'] as const;

export function useContacts(includeArchived = false) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...contactsKey, includeArchived ? 'all' : 'active'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<Contact[]> => {
      let q = supabase.from('contacts').select('*').order('name', { ascending: true });
      if (!includeArchived) q = q.neq('lifecycle', 'archived');
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Contact[];
    },
  });
}

export interface ContactInput {
  name: string;
  type?: ContactType;
  lifecycle?: ContactLifecycle;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  source?: string | null;
  notes?: string | null;
}

export function useCreateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ContactInput): Promise<Contact> => {
      const { data, error } = await supabase
        .from('contacts')
        .insert({ type: 'person', lifecycle: 'client', ...input })
        .select('*')
        .single();
      if (error) throw error;
      return data as Contact;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey }),
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<ContactInput>) => {
      const { data, error } = await supabase
        .from('contacts')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as Contact;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey }),
  });
}
