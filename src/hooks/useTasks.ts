import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useSyncContext } from '../providers/SyncProvider';
import { useAuth } from '../providers/AuthProvider';
import type {
  AppNotification,
  ContractorProject,
  Task,
  TaskComment,
  TaskPriority,
  TaskSection,
  TaskStatus,
  TaskTemplate,
} from '../types/database';

// Work management (Phase 2). Online-only — tasks are not mirrored into the
// Electron offline cache in this phase.

export const tasksKey = ['tasks'] as const;
export const notificationsKey = ['notifications'] as const;

export const SORT_GAP = 1024;

export type TaskWithAssignee = Task & {
  assignee: { display_name: string } | null;
};

export function useProjectTasks(projectId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...tasksKey, 'project', projectId] as const,
    enabled: !!projectId && isOnline,
    queryFn: async () => {
      if (!projectId) return { tasks: [] as TaskWithAssignee[], sections: [] as TaskSection[] };
      const [tasksRes, sectionsRes] = await Promise.all([
        supabase
          .from('tasks')
          // tasks↔team_members has two paths (assignee FK + collaborators
          // junction); the embed must name the FK or PostgREST returns 300.
          .select('*, assignee:team_members!tasks_assignee_id_fkey(display_name)')
          .eq('project_id', projectId)
          .order('sort_order', { ascending: true })
          .order('created_at', { ascending: true }),
        supabase
          .from('task_sections')
          .select('*')
          .eq('project_id', projectId)
          .order('sort_order', { ascending: true }),
      ]);
      if (tasksRes.error) throw tasksRes.error;
      if (sectionsRes.error) throw sectionsRes.error;
      return {
        tasks: (tasksRes.data ?? []) as unknown as TaskWithAssignee[],
        sections: (sectionsRes.data ?? []) as TaskSection[],
      };
    },
  });
}

/** Tasks assigned to any team-member identity linked to the signed-in user. */
export function useMyTasks() {
  const { isOnline } = useSyncContext();
  const { user } = useAuth();
  return useQuery({
    queryKey: [...tasksKey, 'mine', user?.id] as const,
    enabled: !!user && isOnline,
    queryFn: async () => {
      const { data: mine, error: tmErr } = await supabase
        .from('team_members')
        .select('id')
        .eq('profile_id', user!.id);
      if (tmErr) throw tmErr;
      const ids = (mine ?? []).map((r) => r.id);
      if (ids.length === 0) return [] as TaskWithAssignee[];
      const { data, error } = await supabase
        .from('tasks')
        .select('*, assignee:team_members!tasks_assignee_id_fkey(display_name)')
        .in('assignee_id', ids)
        .neq('status', 'done')
        .order('due_date', { ascending: true, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as TaskWithAssignee[];
    },
  });
}

/** Work-safe project names (readable by every role incl. contractors). */
export function useWorkProjects() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...tasksKey, 'work-projects'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<ContractorProject[]> => {
      const { data, error } = await supabase.from('v_contractor_projects').select('*');
      if (error) throw error;
      return (data ?? []) as ContractorProject[];
    },
  });
}

function invalidateTasks(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: tasksKey });
}

export interface TaskInput {
  project_id: string;
  title: string;
  description?: string | null;
  section_id?: string | null;
  parent_task_id?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee_id?: string | null;
  start_date?: string | null;
  due_date?: string | null;
  sort_order?: number;
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskInput): Promise<Task> => {
      const { data, error } = await supabase.from('tasks').insert(input).select('*').single();
      if (error) throw error;
      return data as Task;
    },
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string } & Partial<TaskInput>): Promise<Task> => {
      const { data, error } = await supabase
        .from('tasks')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as Task;
    },
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('tasks').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useCreateSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { project_id: string; name: string; sort_order?: number }) => {
      const { data, error } = await supabase
        .from('task_sections')
        .insert(input)
        .select('*')
        .single();
      if (error) throw error;
      return data as TaskSection;
    },
    onSuccess: () => invalidateTasks(qc),
  });
}

// ---------- comments ----------

export type CommentWithAuthor = TaskComment & {
  author: { full_name: string | null; email: string } | null;
};

export function useTaskComments(taskId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...tasksKey, 'comments', taskId] as const,
    enabled: !!taskId && isOnline,
    queryFn: async (): Promise<CommentWithAuthor[]> => {
      const { data, error } = await supabase
        .from('task_comments')
        .select('*, author:profiles(full_name, email)')
        .eq('task_id', taskId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as CommentWithAuthor[];
    },
  });
}

export function useAddComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { task_id: string; body: string; mentions: string[] }) => {
      const { data, error } = await supabase.rpc('add_task_comment', {
        p_task: input.task_id,
        p_body: input.body,
        p_mentions: input.mentions,
      });
      if (error) throw error;
      return data as TaskComment;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: [...tasksKey, 'comments', vars.task_id] });
      qc.invalidateQueries({ queryKey: notificationsKey });
    },
  });
}

// ---------- notifications ----------

export function useNotifications() {
  const { isOnline } = useSyncContext();
  const { user } = useAuth();
  return useQuery({
    queryKey: notificationsKey,
    enabled: !!user && isOnline,
    refetchInterval: 60_000,
    queryFn: async (): Promise<AppNotification[]> => {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as AppNotification[];
    },
  });
}

export function useMarkNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .in('id', ids);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: notificationsKey }),
  });
}

// ---------- templates ----------

export function useTaskTemplates() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...tasksKey, 'templates'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<TaskTemplate[]> => {
      const { data, error } = await supabase.from('task_templates').select('*').order('name');
      if (error) throw error;
      return (data ?? []) as TaskTemplate[];
    },
  });
}

/** Snapshot a project's current task tree (sections, tasks, subtasks) as a template. */
export function useSaveAsTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { project_id: string; name: string }) => {
      const [{ data: tasks, error: tErr }, { data: sections, error: sErr }] = await Promise.all([
        supabase.from('tasks').select('*').eq('project_id', input.project_id),
        supabase.from('task_sections').select('*').eq('project_id', input.project_id),
      ]);
      if (tErr) throw tErr;
      if (sErr) throw sErr;
      const all = (tasks ?? []) as Task[];
      if (all.length === 0) throw new Error('This project has no tasks to save');

      const { data: template, error } = await supabase
        .from('task_templates')
        .insert({ name: input.name })
        .select('*')
        .single();
      if (error) throw error;
      const tpl = template as TaskTemplate;
      const sectionName = new Map((sections ?? []).map((s) => [s.id, s.name as string]));

      const parents = all.filter((t) => !t.parent_task_id);
      const idMap = new Map<string, string>();
      for (const t of parents.sort((a, b) => a.sort_order - b.sort_order)) {
        const { data: item, error: iErr } = await supabase
          .from('task_template_items')
          .insert({
            template_id: tpl.id,
            section_name: t.section_id ? sectionName.get(t.section_id) ?? null : null,
            title: t.title,
            description: t.description,
            priority: t.priority,
            sort_order: t.sort_order,
          })
          .select('id')
          .single();
        if (iErr) throw iErr;
        idMap.set(t.id, (item as { id: string }).id);
      }
      const children = all.filter((t) => t.parent_task_id && idMap.has(t.parent_task_id));
      if (children.length > 0) {
        const { error: cErr } = await supabase.from('task_template_items').insert(
          children.map((t) => ({
            template_id: tpl.id,
            parent_item_id: idMap.get(t.parent_task_id!),
            title: t.title,
            description: t.description,
            priority: t.priority,
            sort_order: t.sort_order,
          })),
        );
        if (cErr) throw cErr;
      }
      return tpl;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [...tasksKey, 'templates'] }),
  });
}

export function useApplyTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { template_id: string; project_id: string }) => {
      const { data, error } = await supabase.rpc('apply_task_template', {
        p_template: input.template_id,
        p_project: input.project_id,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: () => invalidateTasks(qc),
  });
}
