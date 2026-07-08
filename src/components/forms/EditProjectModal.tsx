import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '../Modal';
import { useUpdateProject, useProjects, PROJECT_TYPE_SUGGESTIONS } from '../../hooks/useProjects';
import { useToast } from '../../providers/ToastProvider';
import { useSyncContext } from '../../providers/SyncProvider';
import { ContactPicker } from '../contacts/ContactPicker';
import type { Project, ProjectStatus } from '../../types/database';
import { Tabs, TabPanel } from '../Tabs';
import { ChipInput } from '../ChipInput';

// client_paid is intentionally absent: since Phase 1 it is derived from
// payments and write-blocked at the database (D3).
const schema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  client: z.string().optional(),
  contact_id: z.string().nullable().optional(),
  location: z.string().optional(),
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

export function EditProjectModal({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  const update = useUpdateProject();
  const toast = useToast();
  const allProjects = useProjects();
  const { isOnline } = useSyncContext();
  const [tab, setTab] = useState<'details' | 'team' | 'collection'>('details');
  const knownTypes = Array.from(
    new Set([
      ...PROJECT_TYPE_SUGGESTIONS,
      ...((allProjects.data ?? []).map((p) => p.project_type).filter(Boolean) as string[]),
    ]),
  );
  const knownPhotographers = Array.from(
    new Set((allProjects.data ?? []).flatMap((p) => p.photographers ?? [])),
  ).sort();

  const { register, handleSubmit, formState, control, watch, reset, setValue } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: project.name,
      description: project.description ?? '',
      client: project.client ?? '',
      contact_id: project.contact_id ?? null,
      location: project.location ?? '',
      project_type: project.project_type ?? '',
      status: project.status,
      start_date: project.start_date ?? '',
      end_date: project.end_date ?? '',
      photographers: project.photographers ?? [],
      collection_details: project.collection_details ?? '',
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: project.name,
        description: project.description ?? '',
        client: project.client ?? '',
        contact_id: project.contact_id ?? null,
        location: project.location ?? '',
        project_type: project.project_type ?? '',
        status: project.status,
        start_date: project.start_date ?? '',
        end_date: project.end_date ?? '',
        photographers: project.photographers ?? [],
        collection_details: project.collection_details ?? '',
      });
      setTab('details');
    }
  }, [open, project, reset]);

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
      await update.mutateAsync({
        id: project.id,
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
      toast.success('Project updated');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <Modal open={open} title="Edit project" onClose={onClose} size="lg">
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
              <input className="input" {...register('name')} />
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
                        // keep the legacy display text in sync with the FK
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
              <input className="input" {...register('location')} />
            </div>
            <div className="col-span-2">
              <label className="label">Type</label>
              <input
                className="input"
                list="project-type-suggestions-edit"
                placeholder="Birthday, Wedding, Conference…"
                {...register('project_type')}
              />
              <datalist id="project-type-suggestions-edit">
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
              <input className="input" type="date" {...register('start_date')} />
            </div>
            <div>
              <label className="label">End date</label>
              <input className="input" type="date" {...register('end_date')} />
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
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={formState.isSubmitting}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
