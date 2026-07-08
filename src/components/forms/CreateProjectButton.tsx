import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '../Modal';
import { useCreateProject, useProjects, PROJECT_TYPE_SUGGESTIONS } from '../../hooks/useProjects';
import { useToast } from '../../providers/ToastProvider';
import { useSyncContext } from '../../providers/SyncProvider';
import { ContactPicker } from '../contacts/ContactPicker';
import type { ProjectStatus } from '../../types/database';
import { Tabs, TabPanel } from '../Tabs';
import { ChipInput } from '../ChipInput';

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  description: z.string().max(2000).optional(),
  client: z.string().max(120).optional(),
  contact_id: z.string().nullable().optional(),
  location: z.string().max(120).optional(),
  project_type: z.string().max(60).optional(),
  status: z.enum(['planning', 'active', 'completed', 'archived']),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  photographers: z.array(z.string()).default([]),
  collection_details: z.string().max(10000).optional(),
});

type FormValues = z.infer<typeof schema>;

const statuses: ProjectStatus[] = ['planning', 'active', 'completed', 'archived'];
const DETAILS_FIELDS = new Set<keyof FormValues>([
  'name',
  'description',
  'client',
  'contact_id',
  'location',
  'project_type',
  'status',
  'start_date',
  'end_date',
]);

export function CreateProjectButton({
  yearId,
  onCreated,
  inline,
}: {
  yearId: string;
  onCreated?: (id: string) => void;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'details' | 'team' | 'collection'>('details');
  const create = useCreateProject();
  const toast = useToast();
  const { isOnline } = useSyncContext();
  const allProjects = useProjects();
  const knownTypes = Array.from(
    new Set([
      ...PROJECT_TYPE_SUGGESTIONS,
      ...((allProjects.data ?? []).map((p) => p.project_type).filter(Boolean) as string[]),
    ]),
  );
  const knownPhotographers = Array.from(
    new Set((allProjects.data ?? []).flatMap((p) => p.photographers ?? [])),
  ).sort();

  const { register, handleSubmit, formState, reset, control, watch, setValue } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: 'active', photographers: [], contact_id: null },
  });

  // After a failed submit, jump to the tab that holds the first error so the user can see it.
  useEffect(() => {
    if (!formState.isSubmitted || formState.isValid) return;
    const firstErrorKey = Object.keys(formState.errors)[0] as keyof FormValues | undefined;
    if (!firstErrorKey) return;
    if (DETAILS_FIELDS.has(firstErrorKey)) setTab('details');
    else if (firstErrorKey === 'photographers') setTab('team');
    else if (firstErrorKey === 'collection_details') setTab('collection');
  }, [formState.errors, formState.isSubmitted, formState.isValid]);

  const photographers = watch('photographers') ?? [];

  async function onSubmit(v: FormValues) {
    try {
      const proj = await create.mutateAsync({
        year_id: yearId,
        name: v.name,
        description: v.description || null,
        client: v.client || null,
        contact_id: v.contact_id ?? null,
        location: v.location || null,
        project_type: v.project_type?.trim() || null,
        status: v.status,
        start_date: v.start_date || null,
        end_date: v.end_date || null,
        photographers: v.photographers ?? [],
        collection_details: v.collection_details || null,
      });
      toast.success('Project created');
      reset({ status: 'active', photographers: [], contact_id: null });
      setTab('details');
      setOpen(false);
      onCreated?.(proj.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create project');
    }
  }

  return (
    <>
      <button
        type="button"
        className={
          inline
            ? 'btn-primary'
            : 'block w-full rounded px-2 py-1 text-left text-xs text-brand-700 hover:bg-brand-50'
        }
        onClick={() => setOpen(true)}
      >
        + Project
      </button>
      <Modal open={open} title="New project" onClose={() => setOpen(false)} size="lg">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Tabs
            tabs={[
              { id: 'details', label: 'Details' },
              { id: 'team', label: 'Photographers', count: photographers.length },
              { id: 'collection', label: 'Collection details' },
            ]}
            active={tab}
            onChange={(id) => setTab(id as typeof tab)}
            ariaLabel="Project sections"
          />

          <TabPanel active={tab} id="details">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="label">Name</label>
                <input className="input" {...register('name')} autoFocus />
                {formState.errors.name && (
                  <p className="mt-1 text-xs text-red-600">{formState.errors.name.message}</p>
                )}
              </div>
              <div className="col-span-2">
                {isOnline ? (
                  <Controller
                    control={control}
                    name="contact_id"
                    render={({ field }) => (
                      <ContactPicker
                        label="Client"
                        value={field.value ?? null}
                        onChange={(id, name) => {
                          field.onChange(id);
                          setValue('client', name ?? '');
                        }}
                      />
                    )}
                  />
                ) : (
                  <>
                    <label className="label">Client (offline — free text)</label>
                    <input className="input" {...register('client')} />
                  </>
                )}
              </div>
              <div>
                <label className="label">Location</label>
                <input
                  className="input"
                  {...register('location')}
                  placeholder="Default for line items"
                />
              </div>
              <div className="col-span-2">
                <label className="label">Type</label>
                <input
                  className="input"
                  list="project-type-suggestions"
                  placeholder="Birthday, Wedding, Conference…"
                  {...register('project_type')}
                />
                <datalist id="project-type-suggestions">
                  {knownTypes.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="label">Status</label>
                <select className="input" {...register('status')}>
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Start date</label>
                <input type="date" className="input" {...register('start_date')} />
              </div>
              <div>
                <label className="label">End date</label>
                <input type="date" className="input" {...register('end_date')} />
              </div>
              <div className="col-span-2">
                <label className="label">Description</label>
                <textarea className="input" rows={3} {...register('description')} />
              </div>
            </div>
          </TabPanel>

          <TabPanel active={tab} id="team">
            <div className="space-y-2">
              <label className="label">Photographers</label>
              <Controller
                control={control}
                name="photographers"
                render={({ field }) => (
                  <ChipInput
                    value={field.value ?? []}
                    onChange={field.onChange}
                    placeholder="Add a name and press Enter"
                    suggestions={knownPhotographers}
                    ariaLabel="Photographers"
                  />
                )}
              />
              <p className="text-xs text-slate-500">
                Type a name and press Enter (or comma) to add. Names auto-suggest from prior
                projects. Used for analytics on the dashboard.
              </p>
            </div>
          </TabPanel>

          <TabPanel active={tab} id="collection">
            <div>
              <label className="label">Collection details</label>
              <textarea
                className="input"
                rows={10}
                placeholder="Notes about the deliverable, gallery, naming convention, anything worth remembering…"
                {...register('collection_details')}
              />
            </div>
          </TabPanel>

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
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
