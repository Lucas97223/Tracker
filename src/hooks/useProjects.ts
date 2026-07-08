import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { localDb } from '../lib/localDb';
import { useSyncContext } from '../providers/SyncProvider';
import { useAuth } from '../providers/AuthProvider';
import type { Project, ProjectRollup, ProjectStatus } from '../types/database';

export const projectsKey = ['projects'] as const;
export const projectRollupKey = ['project-rollup'] as const;

export function useProjects(yearId?: string) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: yearId ? ([...projectsKey, yearId] as const) : projectsKey,
    queryFn: async (): Promise<Project[]> => {
      if (!isOnline) return localDb.queryProjects(yearId);
      let q = supabase.from('projects').select('*').order('created_at', { ascending: false });
      if (yearId) q = q.eq('year_id', yearId);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data ?? [];
      await localDb.upsertManyProjects(rows);
      return rows;
    },
  });
}

export function useProject(projectId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: ['project', projectId] as const,
    enabled: !!projectId,
    queryFn: async (): Promise<Project | null> => {
      if (!projectId) return null;
      if (!isOnline) return localDb.queryProjectById(projectId);
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .maybeSingle();
      if (error) throw error;
      if (data) await localDb.upsertProject(data);
      return data;
    },
  });
}

export function useProjectRollups(yearId?: string) {
  const { isOnline } = useSyncContext();
  const cacheKey = 'project-rollup' + (yearId ?? '');
  return useQuery({
    queryKey: yearId ? ([...projectRollupKey, yearId] as const) : projectRollupKey,
    queryFn: async (): Promise<ProjectRollup[]> => {
      if (!isOnline) {
        const cached = await localDb.getCache<ProjectRollup[]>(cacheKey);
        return cached?.data ?? [];
      }
      let q = supabase.from('v_project_rollup').select('*').order('total_amount', { ascending: false });
      if (yearId) q = q.eq('year_id', yearId);
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as ProjectRollup[];
      await localDb.setCache(cacheKey, rows);
      return rows;
    },
  });
}

export interface ProjectInput {
  year_id: string;
  name: string;
  description?: string | null;
  client?: string | null;
  contact_id?: string | null;
  location?: string | null;
  project_type?: string | null;
  status?: ProjectStatus;
  start_date?: string | null;
  end_date?: string | null;
  /** Derived from payments since Phase 1 (D3); never sent to the server. */
  client_paid?: number | string;
  photographers?: string[];
  collection_details?: string | null;
}

export const PROJECT_TYPE_SUGGESTIONS = [
  'Birthday', 'Wedding', 'Conference', 'Photoshoot', 'Concert',
  'Trade Show', 'Workshop', 'Corporate Event', 'Holiday', 'Festival', 'Other',
] as const;

export function useCreateProject() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: ProjectInput): Promise<Project> => {
      // client_paid is server-derived (D3): never part of an insert payload.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { client_paid: _cp, ...clean } = input;
      if (!isOnline) {
        const now = new Date().toISOString();
        const row: Project = {
          id: crypto.randomUUID(),
          status: 'active',
          description: null, client: null, contact_id: null, location: null, project_type: null,
          start_date: null, end_date: null,
          photographers: [], collection_details: null,
          ...clean,
          client_paid: '0.00',
          created_by: user?.id ?? null,
          created_at: now,
        };
        await localDb.upsertProject(row);
        await localDb.enqueue('projects', row.id, 'insert', row);
        return row;
      }
      const { data, error } = await supabase
        .from('projects')
        .insert({ status: 'active', ...clean })
        .select('*')
        .single();
      if (error) throw error;
      await localDb.upsertProject(data);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectsKey });
      qc.invalidateQueries({ queryKey: projectRollupKey });
      qc.invalidateQueries({ queryKey: ['year-rollup'] });
    },
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<ProjectInput>): Promise<Project> => {
      // client_paid is server-derived (D3): strip it from every update payload
      // (the DB rejects changes; unchanged-value echoes are pointless anyway).
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { client_paid: _cp, ...clean } = patch;
      if (!isOnline) {
        const existing = await localDb.queryProjectById(id);
        if (!existing) throw new Error('Project not found in local cache — connect to internet to edit.');
        const updated: Project = { ...existing, ...clean };
        await localDb.upsertProject(updated);
        await localDb.enqueue('projects', id, 'update', updated);
        return updated;
      }
      const { data, error } = await supabase
        .from('projects')
        .update(clean)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      await localDb.upsertProject(data);
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: projectsKey });
      qc.invalidateQueries({ queryKey: projectRollupKey });
      qc.invalidateQueries({ queryKey: ['project', vars.id] });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  const { isOnline } = useSyncContext();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      if (!isOnline) {
        await localDb.deleteProject(id);
        await localDb.enqueue('projects', id, 'delete', { id });
        return;
      }
      const { error } = await supabase.from('projects').delete().eq('id', id);
      if (error) throw error;
      await localDb.deleteProject(id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectsKey });
      qc.invalidateQueries({ queryKey: projectRollupKey });
      qc.invalidateQueries({ queryKey: ['year-rollup'] });
    },
  });
}
