import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMyTasks, useProjectTasks, useWorkProjects, type TaskWithAssignee } from '../hooks/useTasks';
import { TaskDetailModal } from '../components/tasks/TaskDetailModal';
import { useAuth } from '../providers/AuthProvider';

function bucketOf(t: TaskWithAssignee): string {
  if (!t.due_date) return 'No due date';
  const today = new Date().toISOString().slice(0, 10);
  if (t.due_date < today) return 'Overdue';
  if (t.due_date === today) return 'Today';
  return 'Upcoming';
}

const BUCKET_ORDER = ['Overdue', 'Today', 'Upcoming', 'No due date'];
const BUCKET_STYLES: Record<string, string> = {
  Overdue: 'text-red-600',
  Today: 'text-amber-600',
  Upcoming: 'text-slate-600',
  'No due date': 'text-slate-400',
};

/**
 * Every open task assigned to the signed-in person, across projects — the
 * inbox view. Works for contractors too: project names come from the
 * work-safe view, and the detail modal never touches financial rows.
 */
export function MyTasksPage() {
  const myTasks = useMyTasks();
  const projects = useWorkProjects();
  const { role } = useAuth();
  const [open, setOpen] = useState<TaskWithAssignee | null>(null);
  // Detail modal needs the open task's project context (sections, subtasks).
  const projectTasks = useProjectTasks(open?.project_id);

  const projectName = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
    [projects.data],
  );

  const buckets = useMemo(() => {
    const m = new Map<string, TaskWithAssignee[]>();
    for (const t of myTasks.data ?? []) {
      const b = bucketOf(t);
      m.set(b, [...(m.get(b) ?? []), t]);
    }
    return BUCKET_ORDER.filter((b) => m.has(b)).map((b) => ({ name: b, items: m.get(b)! }));
  }, [myTasks.data]);

  const canNavigateToProjects = role !== null; // contractors keep the modal-only flow
  const showProjectLinks = canNavigateToProjects && (projects.data ?? []).length > 0;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">My Tasks</h1>

      {myTasks.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (myTasks.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing assigned to you right now. Tasks land here when someone assigns you on a project.
        </p>
      ) : (
        buckets.map((b) => (
          <section key={b.name} className="card">
            <header className="border-b border-slate-100 px-4 py-2">
              <h2 className={`text-xs font-semibold uppercase tracking-wide ${BUCKET_STYLES[b.name]}`}>
                {b.name} ({b.items.length})
              </h2>
            </header>
            <ul className="divide-y divide-slate-50">
              {b.items.map((t) => (
                <li
                  key={t.id}
                  className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-slate-50"
                  onClick={() => setOpen(t)}
                >
                  <span
                    className={`badge ${
                      t.status === 'in_progress'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {t.status === 'in_progress' ? 'in progress' : 'to do'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-800">{t.title}</span>
                  <span className="text-xs text-slate-400">
                    {projectName.get(t.project_id) ?? 'Project'}
                    {t.due_date ? ` · due ${t.due_date}` : ''}
                  </span>
                  {showProjectLinks && (
                    <Link
                      to={`/projects/${t.project_id}`}
                      className="text-xs text-brand-700 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      open project →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {open && (
        <TaskDetailModal
          task={(projectTasks.data?.tasks ?? []).find((t) => t.id === open.id) ?? open}
          subtasks={(projectTasks.data?.tasks ?? []).filter((t) => t.parent_task_id === open.id)}
          sections={projectTasks.data?.sections ?? []}
          canEdit
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
