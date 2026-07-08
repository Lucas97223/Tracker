import { useState } from 'react';
import { z } from 'zod';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '../Modal';
import { useCreateYear } from '../../hooks/useYears';
import { useToast } from '../../providers/ToastProvider';

const schema = z.object({
  year_value: z.coerce.number().int().min(1900).max(3000),
  label: z.string().max(60).optional(),
});

type FormValues = z.infer<typeof schema>;

export function CreateYearButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateYear();
  const toast = useToast();
  const { register, handleSubmit, formState, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { year_value: new Date().getFullYear() },
  });

  async function onSubmit(values: FormValues) {
    try {
      await create.mutateAsync({ year_value: values.year_value, label: values.label || null });
      toast.success('Year created');
      reset({ year_value: new Date().getFullYear() });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create year');
    }
  }

  return (
    <>
      <button type="button" className="btn-ghost text-xs" onClick={() => setOpen(true)}>
        + Year
      </button>
      <Modal open={open} title="Add a year" onClose={() => setOpen(false)} size="sm">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div>
            <label className="label" htmlFor="year_value">
              Year
            </label>
            <input
              id="year_value"
              type="number"
              min={1900}
              max={3000}
              className="input"
              {...register('year_value')}
            />
            {formState.errors.year_value && (
              <p className="mt-1 text-xs text-red-600">{formState.errors.year_value.message}</p>
            )}
          </div>
          <div>
            <label className="label" htmlFor="label">
              Label (optional)
            </label>
            <input id="label" type="text" placeholder="e.g. FY25" className="input" {...register('label')} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={formState.isSubmitting}>
              Create
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
