import { useEffect, useState } from 'react';
import { Modal } from '../Modal';
import {
  useAddComment,
  useCreateTask,
  useDeleteTask,
  useTaskComments,
  useUpdateTask,
  type TaskWithAssignee,
} from '../../hooks/useTasks';
import { useTeamMembers } from '../../hooks/useTeam';
import { useToast } from '../../providers/ToastProvider';
import type { Task, TaskPriority, TaskSection, TaskStatus } from '../../types/database';

const PRIORITY_BADGES: Record<TaskPriority, string> = {
  low: 'bg-slate-100 text-slate-600',
  medium: 'bg-blue-100 text-blue-800',
  high: 'bg-amber-100 text-amber-800',
  urgent: 'bg-red-100 text-red-800',
};

export function TaskDetailModal({
  task,
  subtasks,
  sections,
  canEdit,
  onClose,
}: {
  task: TaskWithAssignee;
  subtasks: TaskWithAssignee[];
  sections: TaskSection[];
  canEdit: boolean;
  onClose: () => void;
}) {
  const update = useUpdateTask();
  const remove = useDeleteTask();
  const createTask = useCreateTask();
  const comments = useTaskComments(task.id);
  const addComment = useAddComment();
  const team = useTeamMembers();
  const toast = useToast();

  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [newSubtask, setNewSubtask] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);

  useEffect(() => {
    setTitle(task.title);
    setDescription(task.description ?? '');
  }, [task.id, task.title, task.description]);

  async function patch(fields: Partial<Task>) {
    try {
      await update.mutateAsync({ id: task.id, ...fields });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function addSubtask() {
    if (!newSubtask.trim()) return;
    try {
      await createTask.mutateAsync({
        project_id: task.project_id,
        parent_task_id: task.id,
        title: newSubtask.trim(),
        sort_order: (subtasks.at(-1)?.sort_order ?? 0) + 1024,
      });
      setNewSubtask('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add subtask');
    }
  }

  async function postComment() {
    if (!commentBody.trim()) return;
    try {
      await addComment.mutateAsync({ task_id: task.id, body: commentBody.trim(), mentions });
      setCommentBody('');
      setMentions([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Comment failed');
    }
  }

  async function handleDelete() {
    try {
      await remove.mutateAsync(task.id);
      toast.success('Task deleted');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <Modal open title="" onClose={onClose} size="lg">
      <div className="-mt-8 space-y-4">
        <input
          className="w-full border-0 border-b border-transparent bg-transparent text-lg font-semibold text-slate-900 focus:border-slate-300 focus:outline-none"
          value={title}
          disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && void patch({ title: title.trim() })}
          aria-label="Task title"
        />

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Status
            <select
              className="input mt-1 w-full"
              value={task.status}
              disabled={!canEdit}
              onChange={(e) => void patch({ status: e.target.value as TaskStatus })}
            >
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </select>
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Priority
            <select
              className="input mt-1 w-full"
              value={task.priority}
              disabled={!canEdit}
              onChange={(e) => void patch({ priority: e.target.value as TaskPriority })}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Assignee
            <select
              className="input mt-1 w-full"
              value={task.assignee_id ?? ''}
              disabled={!canEdit}
              onChange={(e) => void patch({ assignee_id: e.target.value || null })}
            >
              <option value="">Unassigned</option>
              {(team.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Start
            <input
              type="date"
              className="input mt-1 w-full"
              value={task.start_date ?? ''}
              disabled={!canEdit}
              onChange={(e) => void patch({ start_date: e.target.value || null })}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Due
            <input
              type="date"
              className="input mt-1 w-full"
              value={task.due_date ?? ''}
              disabled={!canEdit}
              onChange={(e) => void patch({ due_date: e.target.value || null })}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Section
            <select
              className="input mt-1 w-full"
              value={task.section_id ?? ''}
              disabled={!canEdit}
              onChange={(e) => void patch({ section_id: e.target.value || null })}
            >
              <option value="">No section</option>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <textarea
          className="input w-full"
          rows={3}
          placeholder="Description…"
          value={description}
          disabled={!canEdit}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() =>
            description !== (task.description ?? '') &&
            void patch({ description: description || null })
          }
        />

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Subtasks ({subtasks.filter((s) => s.status === 'done').length}/{subtasks.length})
          </h3>
          <ul className="space-y-1">
            {subtasks.map((st) => (
              <li key={st.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={st.status === 'done'}
                  disabled={!canEdit}
                  onChange={() =>
                    void update.mutateAsync({
                      id: st.id,
                      status: st.status === 'done' ? 'todo' : 'done',
                    })
                  }
                  aria-label={`Complete ${st.title}`}
                />
                <span className={st.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700'}>
                  {st.title}
                </span>
                {st.assignee?.display_name && (
                  <span className="text-xs text-slate-400">· {st.assignee.display_name}</span>
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <div className="mt-2 flex gap-2">
              <input
                className="input min-w-0 flex-1"
                placeholder="Add a subtask…"
                value={newSubtask}
                onChange={(e) => setNewSubtask(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addSubtask()}
              />
              <button type="button" className="btn-ghost" onClick={() => void addSubtask()}>
                Add
              </button>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Comments
          </h3>
          <ul className="max-h-48 space-y-2 overflow-y-auto">
            {(comments.data ?? []).map((c) => (
              <li key={c.id} className="rounded bg-slate-50 px-3 py-2 text-sm">
                <span className="font-medium text-slate-800">
                  {c.author?.full_name || c.author?.email || 'Someone'}
                </span>
                <span className="ml-2 text-xs text-slate-400">
                  {new Date(c.created_at).toLocaleString()}
                </span>
                <p className="mt-0.5 whitespace-pre-wrap text-slate-700">{c.body}</p>
              </li>
            ))}
            {(comments.data ?? []).length === 0 && (
              <li className="text-sm text-slate-400">No comments yet.</li>
            )}
          </ul>
          {canEdit && (
            <div className="mt-2 space-y-2">
              <textarea
                className="input w-full"
                rows={2}
                placeholder="Write a comment…"
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wide text-slate-400">@ Mention:</span>
                {(team.data ?? [])
                  .filter((m) => m.profile_id)
                  .map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`badge cursor-pointer ${
                        mentions.includes(m.id)
                          ? 'bg-brand-100 text-brand-800 ring-1 ring-brand-500'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                      onClick={() =>
                        setMentions((ms) =>
                          ms.includes(m.id) ? ms.filter((x) => x !== m.id) : [...ms, m.id],
                        )
                      }
                    >
                      @{m.display_name}
                    </button>
                  ))}
                <button
                  type="button"
                  className="btn-primary ml-auto"
                  disabled={addComment.isPending || !commentBody.trim()}
                  onClick={() => void postComment()}
                >
                  Comment
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="flex items-center justify-between border-t border-slate-100 pt-3">
          <span className={`badge ${PRIORITY_BADGES[task.priority]}`}>{task.priority}</span>
          {canEdit && (
            <button type="button" className="btn-danger" onClick={() => void handleDelete()}>
              Delete task
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
