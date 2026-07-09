import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { localDb } from '../lib/localDb';
import type { Expense, Project, Year, Category } from '../types/database';

/**
 * Subscribes to Supabase Realtime changes and:
 *   1. Invalidates the relevant TanStack Query keys (existing behaviour).
 *   2. Writes the changed row into the local SQLite cache so offline reads
 *      stay up-to-date without a full re-fetch.
 */
export function useRealtimeSync(orgId?: string | null) {
  const qc = useQueryClient();

  useEffect(() => {
    // Channel per org. Row payloads are already filtered server-side by RLS
    // (WALRUS): subscribers only receive rows their policies let them SELECT,
    // so cross-org data never reaches this client. We deliberately do NOT add
    // an org_id filter param: DELETE events carry only the primary key, and a
    // column filter would silently drop them.
    const channel = supabase
      .channel(orgId ? `org-${orgId}-changes` : 'public-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'years' }, (payload) => {
        if (payload.new && Object.keys(payload.new).length > 0) {
          void localDb.upsertYear(payload.new as Year);
        }
        qc.invalidateQueries({ queryKey: ['years'] });
        qc.invalidateQueries({ queryKey: ['year-rollup'] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, (payload) => {
        if (payload.new && Object.keys(payload.new).length > 0) {
          void localDb.upsertProject(payload.new as Project);
        }
        qc.invalidateQueries({ queryKey: ['projects'] });
        qc.invalidateQueries({ queryKey: ['project-rollup'] });
        qc.invalidateQueries({ queryKey: ['year-rollup'] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'expenses' }, (payload) => {
        if (payload.new && Object.keys(payload.new).length > 0) {
          void localDb.upsertExpense(payload.new as Expense);
        } else if (payload.eventType === 'DELETE' && payload.old?.id) {
          void localDb.deleteExpense(payload.old.id as string);
        }
        qc.invalidateQueries({ queryKey: ['expenses'] });
        qc.invalidateQueries({ queryKey: ['project-rollup'] });
        qc.invalidateQueries({ queryKey: ['year-rollup'] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, (payload) => {
        if (payload.new && Object.keys(payload.new).length > 0) {
          void localDb.upsertCategory(payload.new as Category);
        }
        qc.invalidateQueries({ queryKey: ['categories'] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => {
        qc.invalidateQueries({ queryKey: ['profiles'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, () => {
        qc.invalidateQueries({ queryKey: ['accounts'] });
        qc.invalidateQueries({ queryKey: ['reports'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'journal_entries' }, () => {
        qc.invalidateQueries({ queryKey: ['journal'] });
        qc.invalidateQueries({ queryKey: ['reports'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'journal_lines' }, () => {
        qc.invalidateQueries({ queryKey: ['journal'] });
        qc.invalidateQueries({ queryKey: ['reports'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'team_members' }, () => {
        qc.invalidateQueries({ queryKey: ['team'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_members' }, () => {
        qc.invalidateQueries({ queryKey: ['team'] });
        qc.invalidateQueries({ queryKey: ['pay-items'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pay_items' }, () => {
        qc.invalidateQueries({ queryKey: ['pay-items'] });
        qc.invalidateQueries({ queryKey: ['reports'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'contacts' }, () => {
        qc.invalidateQueries({ queryKey: ['contacts'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => {
        qc.invalidateQueries({ queryKey: ['invoices'] });
        qc.invalidateQueries({ queryKey: ['reports'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, () => {
        qc.invalidateQueries({ queryKey: ['invoices'] });
        qc.invalidateQueries({ queryKey: ['projects'] });
        qc.invalidateQueries({ queryKey: ['project'] });
        qc.invalidateQueries({ queryKey: ['reports'] });
        qc.invalidateQueries({ queryKey: ['journal'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => {
        qc.invalidateQueries({ queryKey: ['tasks'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_sections' }, () => {
        qc.invalidateQueries({ queryKey: ['tasks'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_comments' }, () => {
        qc.invalidateQueries({ queryKey: ['tasks'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {
        qc.invalidateQueries({ queryKey: ['notifications'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries' }, () => {
        qc.invalidateQueries({ queryKey: ['time'] });
        qc.invalidateQueries({ queryKey: ['reports'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deals' }, () => {
        qc.invalidateQueries({ queryKey: ['crm'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'form_responses' }, () => {
        qc.invalidateQueries({ queryKey: ['crm'] });
        qc.invalidateQueries({ queryKey: ['contacts'] });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [qc, orgId]);
}
