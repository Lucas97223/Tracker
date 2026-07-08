import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type { JournalEntry, JournalLine, JournalSourceType } from '../types/database';

export interface JournalFilters {
  accountIds?: string[];
  projectIds?: string[];
  sourceTypes?: JournalSourceType[];
  startDate?: string;
  endDate?: string;
  search?: string;
  postedOnly?: boolean;
}

export const journalKey = ['journal'] as const;

/**
 * List journal entries with their lines. Lines are embedded via the FK from
 * journal_lines → journal_entries.
 */
export function useJournalEntries(filters: JournalFilters = {}, limit = 200) {
  return useQuery({
    queryKey: [...journalKey, 'entries', filters, limit] as const,
    queryFn: async (): Promise<(JournalEntry & { lines: JournalLine[] })[]> => {
      let q = supabase
        .from('journal_entries')
        .select('*, lines:journal_lines(*)')
        .order('entry_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
      if (filters.postedOnly !== false) q = q.eq('posted', true);
      if (filters.startDate) q = q.gte('entry_date', filters.startDate);
      if (filters.endDate) q = q.lte('entry_date', filters.endDate);
      if (filters.projectIds?.length) q = q.in('project_id', filters.projectIds);
      if (filters.sourceTypes?.length) q = q.in('source_type', filters.sourceTypes);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as unknown as (JournalEntry & { lines: JournalLine[] })[];

      // Account filter is applied client-side (a row passes if ANY of its lines
      // hits one of the requested accounts). Search likewise.
      return rows.filter((e) => {
        if (filters.accountIds?.length) {
          if (!e.lines.some((l) => filters.accountIds!.includes(l.account_id))) return false;
        }
        if (filters.search) {
          const s = filters.search.toLowerCase();
          const hay = [
            e.memo,
            e.reference,
            ...e.lines.map((l) => l.description ?? ''),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(s)) return false;
        }
        return true;
      });
    },
  });
}

export function useJournalEntry(entryId: string | undefined) {
  return useQuery({
    queryKey: [...journalKey, 'entry', entryId] as const,
    enabled: !!entryId,
    queryFn: async () => {
      if (!entryId) return null;
      const { data, error } = await supabase
        .from('journal_entries')
        .select('*, lines:journal_lines(*)')
        .eq('id', entryId)
        .maybeSingle();
      if (error) throw error;
      return data as (JournalEntry & { lines: JournalLine[] }) | null;
    },
  });
}

export interface JournalLineInput {
  account_id: string;
  debit: number | string;
  credit: number | string;
  description?: string | null;
  project_id?: string | null;
  category_id?: string | null;
  line_number?: number;
}

export interface ManualJournalEntryInput {
  entry_date: string;
  reference?: string | null;
  memo?: string | null;
  project_id?: string | null;
  lines: JournalLineInput[];
}

/**
 * Post a manual journal entry (the form-driven path; expense-driven entries
 * are created by DB triggers in 0008). Validates that debits = credits before
 * hitting the database so the user sees a clean error.
 */
export function useCreateJournalEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManualJournalEntryInput) => {
      const totalDebit = input.lines.reduce(
        (acc, l) => acc + Number(l.debit || 0),
        0,
      );
      const totalCredit = input.lines.reduce(
        (acc, l) => acc + Number(l.credit || 0),
        0,
      );
      if (Math.abs(totalDebit - totalCredit) > 0.005) {
        throw new Error(
          `Entry is unbalanced: debits=${totalDebit.toFixed(2)} credits=${totalCredit.toFixed(2)}`,
        );
      }
      if (input.lines.length < 2) {
        throw new Error('A journal entry needs at least two lines.');
      }

      const { data: entry, error: entryError } = await supabase
        .from('journal_entries')
        .insert({
          entry_date: input.entry_date,
          reference: input.reference ?? null,
          memo: input.memo ?? null,
          project_id: input.project_id ?? null,
          source_type: 'manual',
          posted: true,
          posted_at: new Date().toISOString(),
        })
        .select('*')
        .single();
      if (entryError) throw entryError;

      const linesPayload = input.lines.map((l, idx) => ({
        journal_entry_id: (entry as JournalEntry).id,
        account_id: l.account_id,
        debit: Number(l.debit || 0).toString(),
        credit: Number(l.credit || 0).toString(),
        description: l.description ?? null,
        project_id: l.project_id ?? null,
        category_id: l.category_id ?? null,
        line_number: l.line_number ?? idx + 1,
      }));
      const { error: linesError } = await supabase.from('journal_lines').insert(linesPayload);
      if (linesError) throw linesError;
      return entry as JournalEntry;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: journalKey });
      qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
}
