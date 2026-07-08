import { useState } from 'react';
import { format } from 'date-fns';
import { formatMoney, sumMoney } from '../../lib/money';
import { useCreateExpense, useDeleteExpense } from '../../hooks/useExpenses';
import { useToast } from '../../providers/ToastProvider';
import type { Category, Expense, Project } from '../../types/database';
import { ConfirmDialog } from '../ConfirmDialog';
import { Modal } from '../Modal';
import { ExpenseForm } from './ExpenseForm';
import { cn } from '../../lib/cn';

interface Props {
  project: Project;
  category: Category;
  items: Expense[];
  canEdit: boolean;
}

export function ExpenseCategorySection({ project, category, items, canEdit }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const subtotal = sumMoney(items.map((i) => i.amount));

  return (
    <section className="card overflow-hidden">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 text-left"
          aria-expanded={!collapsed}
        >
          <span
            aria-hidden
            className={cn('inline-block transition-transform', !collapsed && 'rotate-90')}
          >
            ▸
          </span>
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: category.color }}
          />
          <span className="font-medium">{category.name}</span>
          {category.is_archived && (
            <span className="badge bg-slate-200 text-slate-600">archived</span>
          )}
          <span className="text-xs text-slate-500">
            ({items.length} item{items.length === 1 ? '' : 's'})
          </span>
        </button>
        <span className="text-sm font-semibold tabular-nums">{formatMoney(subtotal)}</span>
      </header>

      {!collapsed && (
        <>
          {items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium">Location</th>
                    <th className="px-4 py-2 font-medium">Vendor</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    {canEdit && <th className="px-2 py-2" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((it) => (
                    <ExpenseRow key={it.id} expense={it} project={project} canEdit={canEdit} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canEdit && !category.is_archived && (
            <QuickAdd project={project} categoryId={category.id} />
          )}
        </>
      )}
    </section>
  );
}

function ExpenseRow({
  expense,
  project,
  canEdit,
}: {
  expense: Expense;
  project: Project;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const del = useDeleteExpense();
  const create = useCreateExpense();
  const toast = useToast();

  async function duplicate() {
    try {
      await create.mutateAsync({
        project_id: expense.project_id,
        category_id: expense.category_id,
        description: expense.description,
        amount: expense.amount,
        expense_date: expense.expense_date,
        location: expense.location,
        vendor: expense.vendor,
        payment_method: expense.payment_method,
        receipt_url: expense.receipt_url,
        notes: expense.notes,
        person_name: expense.person_name,
      });
      toast.success('Duplicated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to duplicate');
    }
  }

  async function handleDelete() {
    try {
      await del.mutateAsync(expense.id);
      toast.success('Deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <tr className="hover:bg-slate-50">
      <td className="max-w-xs px-4 py-2">
        <div className="flex items-center gap-1.5 truncate">
          <span className="truncate font-medium">{expense.description}</span>
          {expense.person_name && expense.person_name !== expense.description && (
            <span className="inline-flex items-center rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              👤 {expense.person_name}
            </span>
          )}
        </div>
        {expense.notes && <div className="truncate text-xs text-slate-500">{expense.notes}</div>}
      </td>
      <td className="px-4 py-2 text-slate-600">
        {format(new Date(expense.expense_date + 'T00:00:00'), 'MMM d, yyyy')}
      </td>
      <td className="px-4 py-2 text-slate-600">{expense.location || '—'}</td>
      <td className="px-4 py-2 text-slate-600">{expense.vendor || '—'}</td>
      <td className="px-4 py-2 text-right font-medium tabular-nums">{formatMoney(expense.amount)}</td>
      {canEdit && (
        <td className="px-2 py-2 text-right">
          <div className="flex justify-end gap-1">
            <button type="button" className="btn-ghost text-xs" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn-ghost text-xs" onClick={duplicate}>
              Dup
            </button>
            <button
              type="button"
              className="btn-ghost text-xs text-red-600 hover:bg-red-50"
              onClick={() => setConfirming(true)}
            >
              Del
            </button>
          </div>
          <Modal open={editing} title="Edit expense" onClose={() => setEditing(false)}>
            <ExpenseForm
              project={project}
              mode="edit"
              expense={expense}
              onDone={() => setEditing(false)}
            />
          </Modal>
          <ConfirmDialog
            open={confirming}
            title="Delete expense?"
            description="This line item will be permanently removed."
            confirmLabel="Delete"
            danger
            busy={del.isPending}
            onCancel={() => setConfirming(false)}
            onConfirm={handleDelete}
          />
        </td>
      )}
    </tr>
  );
}

function QuickAdd({ project, categoryId }: { project: Project; categoryId: string }) {
  const projectStart = project.start_date || null;
  const projectEnd = project.end_date || null;
  const clampToRange = (d: string) => {
    if (projectStart && d < projectStart) return projectStart;
    if (projectEnd && d > projectEnd) return projectEnd;
    return d;
  };
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => clampToRange(new Date().toISOString().slice(0, 10)));
  const [submitting, setSubmitting] = useState(false);
  const create = useCreateExpense();
  const toast = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const desc = description.trim();
    const amt = amount.trim();
    if (!desc || !amt) return;
    setSubmitting(true);
    try {
      await create.mutateAsync({
        project_id: project.id,
        category_id: categoryId,
        description: desc,
        amount: amt,
        expense_date: date,
        location: project.location,
      });
      setDescription('');
      setAmount('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid grid-cols-12 gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2"
    >
      <input
        className="input col-span-12 sm:col-span-5"
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="Description"
      />
      <input
        className="input col-span-4 sm:col-span-2"
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        aria-label="Amount"
      />
      <input
        type="date"
        className="input col-span-5 sm:col-span-3"
        value={date}
        min={projectStart ?? undefined}
        max={projectEnd ?? undefined}
        onChange={(e) => setDate(e.target.value)}
        aria-label="Date"
        title={
          projectStart && projectEnd
            ? `Project range: ${projectStart} → ${projectEnd}`
            : projectStart
              ? `Project starts ${projectStart}`
              : projectEnd
                ? `Project ends ${projectEnd}`
                : ''
        }
      />
      <button type="submit" className="btn-primary col-span-3 sm:col-span-2" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add'}
      </button>
    </form>
  );
}
