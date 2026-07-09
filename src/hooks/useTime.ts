import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useSyncContext } from '../providers/SyncProvider';
import { useAuth } from '../providers/AuthProvider';

// Time tracking (Phase 3). The running timer is a server-side row (minutes
// NULL), so it survives reloads and follows the user across devices.

export const timeKey = ['time'] as const;

export interface TimeEntryRow {
  id: string;
  org_id: string;
  project_id: string;
  task_id: string | null;
  team_member_id: string;
  started_at: string;
  minutes: number | null;
  notes: string | null;
  billable: boolean;
  bill_rate: string | null;
  invoiced_lock: boolean;
  invoice_line_id: string | null;
  created_at: string;
  member?: { display_name: string; profile_id: string | null } | null;
}

export interface UnbilledRow {
  source_type: 'time_entry' | 'expense';
  source_id: string;
  org_id: string;
  project_id: string;
  who: string;
  description: string;
  amount: string;
  missing_rate: boolean;
}

const ENTRY_SELECT =
  '*, member:team_members!time_entries_team_member_id_fkey(display_name, profile_id)';

export function useRunningTimer() {
  const { isOnline } = useSyncContext();
  const { user } = useAuth();
  return useQuery({
    queryKey: [...timeKey, 'running'] as const,
    enabled: !!user && isOnline,
    refetchInterval: 60_000,
    queryFn: async (): Promise<TimeEntryRow | null> => {
      const { data, error } = await supabase
        .from('time_entries')
        .select(ENTRY_SELECT)
        .is('minutes', null)
        .order('started_at', { ascending: false })
        .limit(5);
      if (error) throw error;
      const rows = (data ?? []) as unknown as TimeEntryRow[];
      return rows.find((r) => r.member?.profile_id === user!.id) ?? null;
    },
  });
}

export function useStartTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      project_id: string;
      task_id?: string | null;
      notes?: string | null;
      billable?: boolean;
    }) => {
      const { data, error } = await supabase.rpc('start_timer', {
        p_project: input.project_id,
        p_task: input.task_id ?? null,
        p_notes: input.notes ?? null,
        p_billable: input.billable ?? false,
      });
      if (error) throw error;
      return data as TimeEntryRow;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: timeKey }),
  });
}

export function useStopTimer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('stop_timer');
      if (error) throw error;
      return data as TimeEntryRow | null;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: timeKey }),
  });
}

/** Closed entries for one ISO week (Mon–Sun), everyone the caller may see. */
export function useWeekEntries(weekStart: string) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...timeKey, 'week', weekStart] as const,
    enabled: isOnline,
    queryFn: async (): Promise<TimeEntryRow[]> => {
      const end = new Date(weekStart + 'T00:00:00Z');
      end.setUTCDate(end.getUTCDate() + 7);
      const { data, error } = await supabase
        .from('time_entries')
        .select(ENTRY_SELECT)
        .gte('started_at', weekStart)
        .lt('started_at', end.toISOString().slice(0, 10))
        .not('minutes', 'is', null)
        .order('started_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as TimeEntryRow[];
    },
  });
}

export function useCreateTimeEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      project_id: string;
      team_member_id: string;
      date: string;
      minutes: number;
      billable: boolean;
      notes?: string | null;
      task_id?: string | null;
    }) => {
      const { data, error } = await supabase
        .from('time_entries')
        .insert({
          project_id: input.project_id,
          team_member_id: input.team_member_id,
          task_id: input.task_id ?? null,
          started_at: `${input.date}T09:00:00Z`,
          minutes: input.minutes,
          billable: input.billable,
          notes: input.notes ?? null,
        })
        .select('*')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: timeKey }),
  });
}

export function useDeleteTimeEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('time_entries').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: timeKey }),
  });
}

// ---------- unbilled → invoice ----------

export function useUnbilled(projectId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...timeKey, 'unbilled', projectId] as const,
    enabled: !!projectId && isOnline,
    queryFn: async (): Promise<UnbilledRow[]> => {
      const { data, error } = await supabase
        .from('v_unbilled')
        .select('*')
        .eq('project_id', projectId!);
      if (error) throw error;
      return (data ?? []) as UnbilledRow[];
    },
  });
}

export function useAddUnbilledToInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      invoice_id: string;
      time_entry_ids: string[];
      expense_ids: string[];
    }) => {
      const { data, error } = await supabase.rpc('add_unbilled_to_invoice', {
        p_invoice: input.invoice_id,
        p_time_entries: input.time_entry_ids,
        p_expenses: input.expense_ids,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: timeKey });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}
