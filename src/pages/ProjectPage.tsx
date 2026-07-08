import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useProject, useDeleteProject, useUpdateProject } from '../hooks/useProjects';
import { useExpensesForProject } from '../hooks/useExpenses';
import { useCategories } from '../hooks/useCategories';
import { useAuth } from '../providers/AuthProvider';
import { formatMoney, sumMoney } from '../lib/money';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ExpenseCategorySection } from '../components/expenses/ExpenseCategorySection';
import { EditProjectModal } from '../components/forms/EditProjectModal';
import { useToast } from '../providers/ToastProvider';
import { Modal } from '../components/Modal';
import { ExpenseForm } from '../components/expenses/ExpenseForm';
import type { ProjectStatus } from '../types/database';

const STATUS_COLORS: Record<ProjectStatus, string> = {
  planning: 'bg-amber-100 text-amber-800',
  active: 'bg-emerald-100 text-emerald-800',
  completed: 'bg-slate-200 text-slate-800',
  archived: 'bg-slate-100 text-slate-500',
};

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { canEdit } = useAuth();
  const toast = useToast();
  const project = useProject(projectId);
  const expenses = useExpensesForProject(projectId);
  const categories = useCategories();
  const updateProject = useUpdateProject();
  const deleteProject = useDeleteProject();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [addingNew, setAddingNew] = useState(false);

  const grouped = useMemo(() => {
    const cats = categories.data ?? [];
    const rows = expenses.data ?? [];
    const byCat = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byCat.get(r.category_id) ?? [];
      arr.push(r);
      byCat.set(r.category_id, arr);
    }
    return cats
      .filter((c) => !c.is_archived || byCat.has(c.id))
      .map((c) => ({ category: c, items: byCat.get(c.id) ?? [] }))
      .sort((a, b) => {
        const ax = sumMoney(a.items.map((i) => i.amount));
        const bx = sumMoney(b.items.map((i) => i.amount));
        if (a.items.length === 0 && b.items.length > 0) return 1;
        if (b.items.length === 0 && a.items.length > 0) return -1;
        return bx - ax;
      });
  }, [categories.data, expenses.data]);

  const total = useMemo(
    () => sumMoney((expenses.data ?? []).map((e) => e.amount)),
    [expenses.data],
  );

  if (project.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!project.data) return <p className="text-sm text-slate-500">Project not found.</p>;
  const p = project.data;

  async function handleDelete() {
    if (!projectId) return;
    try {
      await deleteProject.mutateAsync(projectId);
      toast.success('Project deleted');
      navigate(`/years/${p.year_id}`, { replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setConfirmingDelete(false);
    }
  }

  async function quickStatusChange(status: ProjectStatus) {
    try {
      await updateProject.mutateAsync({ id: p.id, status });
      toast.success(`Status set to ${status}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <button
              type="button"
              className="hover:underline"
              onClick={() => navigate(`/years/${p.year_id}`)}
            >
              ← Year
            </button>
            <span aria-hidden>/</span>
            <span className={`badge ${STATUS_COLORS[p.status]}`}>{p.status}</span>
            {p.project_type && <span className="badge bg-amber-100 text-amber-800">{p.project_type}</span>}
            {p.location && <span>📍 {p.location}</span>}
            {p.client && <span>👤 {p.client}</span>}
            {(p.start_date || p.end_date) && (
              <span>
                🗓 {p.start_date ?? '…'} → {p.end_date ?? '…'}
              </span>
            )}
          </div>
          <h1 className="mt-1 truncate text-xl font-semibold">{p.name}</h1>
          {p.description && <p className="mt-1 max-w-2xl text-sm text-slate-600">{p.description}</p>}
          {(p.photographers ?? []).length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1">
              <span className="text-xs uppercase tracking-wide text-slate-500">Team:</span>
              {(p.photographers ?? []).map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                >
                  {name}
                </span>
              ))}
            </div>
          )}
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input w-auto"
              value={p.status}
              onChange={(e) => quickStatusChange(e.target.value as ProjectStatus)}
              aria-label="Status"
            >
              <option value="planning">planning</option>
              <option value="active">active</option>
              <option value="completed">completed</option>
              <option value="archived">archived</option>
            </select>
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn-primary" onClick={() => setAddingNew(true)}>
              + Expense
            </button>
            <button type="button" className="btn-danger" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          </div>
        )}
      </header>

      {/* Project P&L: Paid (from client) - Spent (from expenses) = Profit */}
      <div className="card sticky top-0 z-10 grid grid-cols-3 divide-x divide-slate-100">
        <PnLCell label="Client paid" value={formatMoney(p.client_paid ?? '0')} tone="paid" />
        <PnLCell
          label={`Spent (${expenses.data?.length ?? 0})`}
          value={formatMoney(total)}
          tone="spent"
        />
        <PnLCell
          label="Profit"
          value={formatMoney(Number(p.client_paid ?? 0) - total)}
          tone={Number(p.client_paid ?? 0) - total >= 0 ? 'profit' : 'loss'}
        />
      </div>

      {p.collection_details && (
        <details className="card open:shadow-sm" open={false}>
          <summary className="cursor-pointer px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:text-slate-700">
            Collection details
          </summary>
          <div className="whitespace-pre-wrap border-t border-slate-100 px-4 py-3 text-sm text-slate-700">
            {p.collection_details}
          </div>
        </details>
      )}

      <div className="space-y-3">
        {grouped.map(({ category, items }) => (
          <ExpenseCategorySection
            key={category.id}
            project={p}
            category={category}
            items={items}
            canEdit={canEdit}
          />
        ))}
        {grouped.length === 0 && (
          <p className="text-sm text-slate-500">
            No categories available. {canEdit ? 'Create one from the Categories page.' : ''}
          </p>
        )}
      </div>

      {editing && (
        <EditProjectModal project={p} open={editing} onClose={() => setEditing(false)} />
      )}

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete project?"
        description="This will delete the project and all of its expenses. This cannot be undone."
        confirmLabel="Delete"
        danger
        busy={deleteProject.isPending}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={handleDelete}
      />

      <Modal open={addingNew} title="Add expense" onClose={() => setAddingNew(false)}>
        <ExpenseForm
          project={p}
          mode="create"
          onDone={() => setAddingNew(false)}
        />
      </Modal>
    </div>
  );
}

function PnLCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'paid' | 'spent' | 'profit' | 'loss';
}) {
  const toneClass =
    tone === 'paid'
      ? 'text-slate-900'
      : tone === 'spent'
        ? 'text-slate-900'
        : tone === 'profit'
          ? 'text-emerald-700'
          : 'text-red-700';
  return (
    <div className="flex flex-col px-4 py-3">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className={`mt-0.5 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}
