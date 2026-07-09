import { useMemo, useState } from 'react';
import {
  SORT_GAP,
  useApplyTemplate,
  useCreateSection,
  useCreateTask,
  useProjectTasks,
  useSaveAsTemplate,
  useTaskTemplates,
  useUpdateTask,
  type TaskWithAssignee,
} from '../../hooks/useTasks';
import { TaskDetailModal } from './TaskDetailModal';
import { Modal } from '../Modal';
import { useToast } from '../../providers/ToastProvider';
import type { TaskStatus } from '../../types/database';

const STATUS_COLUMNS: Array<{ id: TaskStatus; label: string }> = [
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
];

const PRIORITY_DOTS: Record<string, string> = {
  low: 'bg-slate-300',
  medium: 'bg-blue-400',
  high: 'bg-amber-400',
  urgent: 'bg-red-500',
};

function TaskCard({
  task,
  canEdit,
  onOpen,
  onDragStart,
}: {
  task: TaskWithAssignee;
  canEdit: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  return (
    <div
      draggable={canEdit}
      onDragStart={onDragStart}
      onClick={onOpen}
      className="cursor-pointer rounded border border-slate-200 bg-white p-2 text-sm shadow-sm hover:border-slate-300"
      role="button"
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 h-2 w-2 flex-none rounded-full ${PRIORITY_DOTS[task.priority]}`}
          title={task.priority}
        />
        <span className={task.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'}>
          {task.title}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4 text-xs text-slate-400">
        {task.assignee?.display_name && <span>{task.assignee.display_name}</span>}
        {task.due_date && <span>due {task.due_date}</span>}
      </div>
    </div>
  );
}

/** List + Board task views for one project (labels stay generic). */
export function TasksPanel({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const { data, error: tasksError } = useProjectTasks(projectId);
  const createTask = useCreateTask();
  const updateTask = useUpdateTask();
  const createSection = useCreateSection();
  const templates = useTaskTemplates();
  const applyTemplate = useApplyTemplate();
  const saveTemplate = useSaveAsTemplate();
  const toast = useToast();

  const [view, setView] = useState<'list' | 'board'>('list');
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [quickAdd, setQuickAdd] = useState<Record<string, string>>({});
  const [newSection, setNewSection] = useState('');
  const [addingSection, setAddingSection] = useState(false);
  const [applying, setApplying] = useState(false);

  const tasks = useMemo(() => data?.tasks ?? [], [data?.tasks]);
  const sections = useMemo(() => data?.sections ?? [], [data?.sections]);
  const parents = useMemo(() => tasks.filter((t) => !t.parent_task_id), [tasks]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, TaskWithAssignee[]>();
    for (const t of tasks) {
      if (!t.parent_task_id) continue;
      m.set(t.parent_task_id, [...(m.get(t.parent_task_id) ?? []), t]);
    }
    return m;
  }, [tasks]);

  const current = tasks.find((t) => t.id === openTask) ?? null;

  async function quickCreate(sectionId: string | null) {
    const key = sectionId ?? 'none';
    const title = (quickAdd[key] ?? '').trim();
    if (!title) return;
    try {
      await createTask.mutateAsync({
        project_id: projectId,
        section_id: sectionId,
        title,
        sort_order: (parents.at(-1)?.sort_order ?? 0) + SORT_GAP,
      });
      setQuickAdd((q) => ({ ...q, [key]: '' }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add task');
    }
  }

  async function handleDrop(status: TaskStatus, e: React.DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/task-id');
    if (!id) return;
    const columnTasks = parents.filter((t) => t.status === status);
    try {
      await updateTask.mutateAsync({
        id,
        status,
        sort_order: (columnTasks.at(-1)?.sort_order ?? 0) + SORT_GAP,
      });
    } catch (e2) {
      toast.error(e2 instanceof Error ? e2.message : 'Move failed');
    }
  }

  async function handleApply(templateId: string) {
    try {
      const n = await applyTemplate.mutateAsync({ template_id: templateId, project_id: projectId });
      toast.success(`Template applied — ${n} tasks created`);
      setApplying(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Apply failed');
    }
  }

  const listGroups: Array<{ id: string | null; name: string; items: TaskWithAssignee[] }> = [
    ...sections.map((s) => ({
      id: s.id as string | null,
      name: s.name,
      items: parents.filter((t) => t.section_id === s.id),
    })),
    {
      id: null,
      name: sections.length > 0 ? 'No section' : 'Tasks',
      items: parents.filter((t) => !t.section_id),
    },
  ];

  return (
    <section className="card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Tasks ({parents.filter((t) => t.status !== 'done').length} open)
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`rounded px-2 py-0.5 text-xs ${view === 'list' ? 'bg-slate-200 text-slate-900' : 'text-slate-500 hover:bg-slate-100'}`}
            onClick={() => setView('list')}
          >
            List
          </button>
          <button
            type="button"
            className={`rounded px-2 py-0.5 text-xs ${view === 'board' ? 'bg-slate-200 text-slate-900' : 'text-slate-500 hover:bg-slate-100'}`}
            onClick={() => setView('board')}
          >
            Board
          </button>
          {canEdit && (
            <>
              <button type="button" className="btn-ghost !py-0.5 text-xs" onClick={() => setAddingSection(true)}>
                + Section
              </button>
              <button type="button" className="btn-ghost !py-0.5 text-xs" onClick={() => setApplying(true)}>
                Use template
              </button>
            </>
          )}
        </div>
      </header>

      {tasksError && (
        <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">
          Tasks failed to load: {tasksError instanceof Error ? tasksError.message : 'unknown error'}
        </p>
      )}

      {view === 'list' ? (
        <div className="divide-y divide-slate-100">
          {listGroups.map((g) => (
            <div key={g.id ?? 'none'} className="px-4 py-2">
              {(sections.length > 0 || g.items.length > 0) && (
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {g.name}
                </h3>
              )}
              <ul className="space-y-1">
                {g.items.map((t) => {
                  const subs = childrenOf.get(t.id) ?? [];
                  return (
                    <li
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50"
                      onClick={() => setOpenTask(t.id)}
                    >
                      <input
                        type="checkbox"
                        checked={t.status === 'done'}
                        disabled={!canEdit}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() =>
                          void updateTask.mutateAsync({
                            id: t.id,
                            status: t.status === 'done' ? 'todo' : 'done',
                          })
                        }
                        aria-label={`Complete ${t.title}`}
                      />
                      <span
                        className={`h-2 w-2 flex-none rounded-full ${PRIORITY_DOTS[t.priority]}`}
                        title={t.priority}
                      />
                      <span
                        className={
                          t.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-800'
                        }
                      >
                        {t.title}
                      </span>
                      {subs.length > 0 && (
                        <span className="text-xs text-slate-400">
                          {subs.filter((s) => s.status === 'done').length}/{subs.length}
                        </span>
                      )}
                      {t.status === 'in_progress' && (
                        <span className="badge bg-blue-100 text-blue-800">in progress</span>
                      )}
                      <span className="ml-auto flex items-center gap-3 text-xs text-slate-400">
                        {t.assignee?.display_name && <span>{t.assignee.display_name}</span>}
                        {t.due_date && <span>due {t.due_date}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {canEdit && (
                <input
                  className="mt-1 w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-sm placeholder:text-slate-300 focus:border-slate-200 focus:bg-white focus:outline-none"
                  placeholder="+ Add task"
                  value={quickAdd[g.id ?? 'none'] ?? ''}
                  onChange={(e) => setQuickAdd((q) => ({ ...q, [g.id ?? 'none']: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && void quickCreate(g.id)}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-3">
          {STATUS_COLUMNS.map((col) => {
            const items = parents.filter((t) => t.status === col.id);
            return (
              <div
                key={col.id}
                className="rounded bg-slate-50 p-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => void handleDrop(col.id, e)}
              >
                <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {col.label} ({items.length})
                </h3>
                <div className="space-y-2">
                  {items.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      canEdit={canEdit}
                      onOpen={() => setOpenTask(t.id)}
                      onDragStart={(e) => e.dataTransfer.setData('text/task-id', t.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {current && (
        <TaskDetailModal
          task={current}
          subtasks={childrenOf.get(current.id) ?? []}
          sections={sections}
          canEdit={canEdit}
          onClose={() => setOpenTask(null)}
        />
      )}

      <Modal open={addingSection} title="New section" onClose={() => setAddingSection(false)} size="sm">
        <div className="flex gap-2">
          <input
            className="input min-w-0 flex-1"
            placeholder="Section name"
            value={newSection}
            onChange={(e) => setNewSection(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!newSection.trim() || createSection.isPending}
            onClick={() =>
              void createSection
                .mutateAsync({
                  project_id: projectId,
                  name: newSection.trim(),
                  sort_order: (sections.at(-1)?.sort_order ?? 0) + 1,
                })
                .then(() => {
                  setNewSection('');
                  setAddingSection(false);
                })
                .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
            }
          >
            Add
          </button>
        </div>
      </Modal>

      <Modal open={applying} title="Task templates" onClose={() => setApplying(false)} size="sm">
        <div className="space-y-3">
          {(templates.data ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No templates yet.</p>
          ) : (
            <ul className="space-y-1">
              {(templates.data ?? []).map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50"
                    disabled={applyTemplate.isPending}
                    onClick={() => void handleApply(t.id)}
                  >
                    <span className="font-medium text-slate-800">{t.name}</span>
                    {t.description && <span className="ml-2 text-slate-500">{t.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {parents.length > 0 && (
            <div className="border-t border-slate-100 pt-2">
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={saveTemplate.isPending}
                onClick={() => {
                  const name = window.prompt('Template name (saves this project’s task tree):');
                  if (!name?.trim()) return;
                  void saveTemplate
                    .mutateAsync({ project_id: projectId, name: name.trim() })
                    .then((t) => toast.success(`Saved template "${t.name}"`))
                    .catch((e) => toast.error(e instanceof Error ? e.message : 'Save failed'));
                }}
              >
                Save this project's tasks as a template
              </button>
            </div>
          )}
        </div>
      </Modal>
    </section>
  );
}
