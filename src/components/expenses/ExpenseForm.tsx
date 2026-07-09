import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCreateExpense, useUpdateExpense } from '../../hooks/useExpenses';
import { useCategories } from '../../hooks/useCategories';
import { useToast } from '../../providers/ToastProvider';
import type { Expense, Project } from '../../types/database';

const schema = z.object({
  category_id: z.string().uuid('Pick a category'),
  description: z.string().min(1, 'Required').max(500),
  amount: z.coerce.number().nonnegative('Must be ≥ 0'),
  expense_date: z.string().min(1, 'Required'),
  location: z.string().optional(),
  vendor: z.string().optional(),
  payment_method: z.string().optional(),
  receipt_url: z.string().url('Must be a URL').optional().or(z.literal('')),
  notes: z.string().optional(),
  person_name: z.string().optional(),
  billable: z.boolean().default(false),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  project: Project;
  mode: 'create' | 'edit';
  expense?: Expense;
  onDone: () => void;
}

export function ExpenseForm({ project, mode, expense, onDone }: Props) {
  const categories = useCategories();
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const toast = useToast();

  const activeCategories = (categories.data ?? []).filter(
    (c) => !c.is_archived || c.id === expense?.category_id,
  );

  // Default to constraining the date to the project's date range. If the user
  // checks "Allow date outside project range" (e.g. pre-event prep), drop it.
  const projectStart = project.start_date || null;
  const projectEnd = project.end_date || null;
  const existingOutsideRange = useMemo(() => {
    if (!expense) return false;
    if (projectStart && expense.expense_date < projectStart) return true;
    if (projectEnd && expense.expense_date > projectEnd) return true;
    return false;
  }, [expense, projectStart, projectEnd]);
  const [allowOutside, setAllowOutside] = useState(existingOutsideRange);

  const defaultDate = (() => {
    if (expense?.expense_date) return expense.expense_date;
    const today = new Date().toISOString().slice(0, 10);
    if (allowOutside) return today;
    if (projectStart && today < projectStart) return projectStart;
    if (projectEnd && today > projectEnd) return projectEnd;
    return today;
  })();

  const { register, handleSubmit, formState, watch, setValue } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      category_id: expense?.category_id ?? activeCategories[0]?.id ?? '',
      description: expense?.description ?? '',
      amount: expense ? Number(expense.amount) : 0,
      expense_date: defaultDate,
      location: expense?.location ?? project.location ?? '',
      vendor: expense?.vendor ?? '',
      payment_method: expense?.payment_method ?? '',
      receipt_url: expense?.receipt_url ?? '',
      notes: expense?.notes ?? '',
      person_name: expense?.person_name ?? '',
      billable: expense?.billable ?? false,
    },
  });

  // When the user picks the Photographer Pay category, surface a dropdown of
  // the project's photographers. For other categories, the person field is
  // hidden (it would be noise — most expenses have no person attribution).
  const selectedCategoryId = watch('category_id');
  const personName = watch('person_name');
  const isPayCategory =
    activeCategories.find((c) => c.id === selectedCategoryId)?.name?.toLowerCase() ===
    'photographer pay';
  const projectPhotographers = project.photographers ?? [];

  async function onSubmit(values: FormValues) {
    try {
      if (mode === 'create') {
        await create.mutateAsync({
          project_id: project.id,
          category_id: values.category_id,
          description: values.description,
          amount: values.amount,
          expense_date: values.expense_date,
          location: values.location || null,
          vendor: values.vendor || null,
          payment_method: values.payment_method || null,
          receipt_url: values.receipt_url || null,
          notes: values.notes || null,
          person_name: values.person_name?.trim() || null,
          billable: values.billable,
        });
        toast.success('Expense added');
      } else if (expense) {
        await update.mutateAsync({
          id: expense.id,
          category_id: values.category_id,
          description: values.description,
          amount: values.amount,
          expense_date: values.expense_date,
          location: values.location || null,
          vendor: values.vendor || null,
          payment_method: values.payment_method || null,
          receipt_url: values.receipt_url || null,
          notes: values.notes || null,
          person_name: values.person_name?.trim() || null,
          billable: values.billable,
        });
        toast.success('Expense updated');
      }
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">Description</label>
          <input className="input" {...register('description')} autoFocus />
          {formState.errors.description && (
            <p className="mt-1 text-xs text-red-600">{formState.errors.description.message}</p>
          )}
        </div>
        <div>
          <label className="label">Amount</label>
          <input
            className="input"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            {...register('amount')}
          />
          {formState.errors.amount && (
            <p className="mt-1 text-xs text-red-600">{formState.errors.amount.message}</p>
          )}
        </div>
        <div>
          <label className="label">Date</label>
          <input
            className="input"
            type="date"
            min={!allowOutside && projectStart ? projectStart : undefined}
            max={!allowOutside && projectEnd ? projectEnd : undefined}
            {...register('expense_date')}
          />
          {(projectStart || projectEnd) && (
            <label className="mt-1 flex cursor-pointer items-center gap-1 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={allowOutside}
                onChange={(e) => setAllowOutside(e.target.checked)}
              />
              <span>
                Allow date outside project range
                {projectStart && projectEnd
                  ? ` (${projectStart} → ${projectEnd})`
                  : projectStart
                    ? ` (from ${projectStart})`
                    : ` (through ${projectEnd})`}
              </span>
            </label>
          )}
          {formState.errors.expense_date && (
            <p className="mt-1 text-xs text-red-600">{formState.errors.expense_date.message}</p>
          )}
        </div>
        <div className="col-span-2">
          <label className="label">Category</label>
          <select className="input" {...register('category_id')}>
            <option value="">Select a category…</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {formState.errors.category_id && (
            <p className="mt-1 text-xs text-red-600">{formState.errors.category_id.message}</p>
          )}
        </div>
        {isPayCategory && (
          <div className="col-span-2">
            <label className="label">Photographer</label>
            <select
              className="input"
              value={personName ?? ''}
              onChange={(e) => setValue('person_name', e.target.value)}
            >
              <option value="">— No specific person —</option>
              {projectPhotographers.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {personName && !projectPhotographers.includes(personName) && (
                <option value={personName}>{personName} (not on current team)</option>
              )}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              {projectPhotographers.length === 0
                ? 'Add photographers to the project team to attribute pay rows to specific people.'
                : 'This expense will be credited to the selected photographer in the dashboard.'}
            </p>
          </div>
        )}
        <div>
          <label className="label">Location</label>
          <input className="input" {...register('location')} />
        </div>
        <div>
          <label className="label">Vendor</label>
          <input className="input" {...register('vendor')} />
        </div>
        <div>
          <label className="label">Payment method</label>
          <input className="input" {...register('payment_method')} />
        </div>
        <div>
          <label className="label">Receipt URL</label>
          <input className="input" type="url" placeholder="https://…" {...register('receipt_url')} />
          {formState.errors.receipt_url && (
            <p className="mt-1 text-xs text-red-600">{formState.errors.receipt_url.message}</p>
          )}
        </div>
        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="input" rows={2} {...register('notes')} />
        </div>
        <div className="col-span-2">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              disabled={expense?.invoiced_lock}
              {...register('billable')}
            />
            Billable to client
            {expense?.invoiced_lock && (
              <span className="badge bg-amber-100 text-amber-800">on an invoice — locked</span>
            )}
          </label>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={formState.isSubmitting}>
          {mode === 'create' ? 'Add expense' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
