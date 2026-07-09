import { useMemo, useState } from 'react';
import {
  useCreateForm,
  useForms,
  useToggleForm,
  type FormField,
  type LeadForm,
} from '../hooks/useCrm';
import { Modal } from '../components/Modal';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

const FIELD_KINDS: Array<FormField['kind']> = ['text', 'email', 'phone', 'textarea', 'date'];

function NewFormModal({ onClose }: { onClose: () => void }) {
  const create = useCreateForm();
  const toast = useToast();
  const [name, setName] = useState('');
  const [headline, setHeadline] = useState('');
  const [fields, setFields] = useState<Array<Pick<FormField, 'label' | 'kind' | 'required'>>>([
    { label: 'Your name', kind: 'text', required: true },
    { label: 'Email', kind: 'email', required: true },
    { label: 'Tell us about your event', kind: 'textarea', required: false },
  ]);

  function patchField(i: number, patch: Partial<(typeof fields)[number]>) {
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  }

  async function submit() {
    if (!name.trim()) {
      toast.error('Give the form a name');
      return;
    }
    const cleaned = fields.filter((f) => f.label.trim());
    if (cleaned.length === 0) {
      toast.error('Add at least one field');
      return;
    }
    try {
      await create.mutateAsync({ name: name.trim(), headline: headline.trim() || null, fields: cleaned });
      toast.success('Form created — share its link to start collecting leads');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the form');
    }
  }

  return (
    <Modal open title="New lead form" onClose={onClose} size="lg">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Name (internal)
            <input
              className="input mt-1 w-full"
              placeholder="Wedding inquiry"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Headline (shown to visitors)
            <input
              className="input mt-1 w-full"
              placeholder="Tell us about your day"
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
            />
          </label>
        </div>

        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fields</p>
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                className="input min-w-0 flex-1"
                placeholder="Label"
                value={f.label}
                onChange={(e) => patchField(i, { label: e.target.value })}
              />
              <select
                className="input w-28"
                value={f.kind}
                onChange={(e) => patchField(i, { kind: e.target.value as FormField['kind'] })}
              >
                {FIELD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={f.required}
                  onChange={(e) => patchField(i, { required: e.target.checked })}
                />
                required
              </label>
              <button
                type="button"
                className="btn-ghost !px-2"
                aria-label="Remove field"
                onClick={() => setFields((fs) => fs.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setFields((fs) => [...fs, { label: '', kind: 'text', required: false }])}
        >
          + Add field
        </button>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={create.isPending}
            onClick={() => void submit()}
          >
            Create form
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function FormsPage() {
  const { canEdit } = useAuth();
  const data = useForms();
  const toggle = useToggleForm();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<LeadForm | null>(null);

  const fieldsByForm = useMemo(() => {
    const m = new Map<string, FormField[]>();
    for (const f of data.data?.fields ?? []) {
      m.set(f.form_id, [...(m.get(f.form_id) ?? []), f]);
    }
    return m;
  }, [data.data?.fields]);

  const responseCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data.data?.responses ?? []) {
      m.set(r.form_id, (m.get(r.form_id) ?? 0) + 1);
    }
    return m;
  }, [data.data?.responses]);

  function shareUrl(f: LeadForm) {
    return `${window.location.origin}${window.location.pathname}#/f/${f.share_token}`;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Lead forms</h1>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            + Form
          </button>
        )}
      </header>

      {(data.data?.forms ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">
          No forms yet. A form gives you a public link; every submission becomes a lead contact and
          a deal in your pipeline.
        </p>
      ) : (
        <div className="card divide-y divide-slate-50">
          {(data.data?.forms ?? []).map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span
                className={`badge ${f.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}
              >
                {f.is_active ? 'live' : 'off'}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{f.name}</span>
              <span className="text-xs text-slate-400">
                {(fieldsByForm.get(f.id) ?? []).length} fields · {responseCount.get(f.id) ?? 0} responses
              </span>
              <button
                type="button"
                className="btn-ghost !py-0.5 text-xs"
                onClick={() => setViewing(f)}
              >
                Responses
              </button>
              <button
                type="button"
                className="btn-ghost !py-0.5 text-xs"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(shareUrl(f))
                    .then(() => toast.success('Public link copied'))
                    .catch(() => toast.error('Copy failed — ' + shareUrl(f)))
                }
              >
                Copy link
              </button>
              <a className="btn-ghost !py-0.5 text-xs" href={shareUrl(f)} target="_blank" rel="noreferrer">
                Preview
              </a>
              {canEdit && (
                <button
                  type="button"
                  className="btn-ghost !py-0.5 text-xs"
                  onClick={() =>
                    void toggle
                      .mutateAsync({ id: f.id, is_active: !f.is_active })
                      .catch((e) => toast.error(e instanceof Error ? e.message : 'Toggle failed'))
                  }
                >
                  {f.is_active ? 'Turn off' : 'Turn on'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {creating && <NewFormModal onClose={() => setCreating(false)} />}

      {viewing && (
        <Modal open title={`Responses — ${viewing.name}`} onClose={() => setViewing(null)} size="lg">
          {(data.data?.responses ?? []).filter((r) => r.form_id === viewing.id).length === 0 ? (
            <p className="text-sm text-slate-500">No responses yet.</p>
          ) : (
            <ul className="max-h-96 space-y-2 overflow-y-auto">
              {(data.data?.responses ?? [])
                .filter((r) => r.form_id === viewing.id)
                .map((r) => (
                  <li key={r.id} className="rounded bg-slate-50 p-3 text-sm">
                    <p className="mb-1 text-xs text-slate-400">
                      {new Date(r.created_at).toLocaleString()}
                    </p>
                    {(fieldsByForm.get(viewing.id) ?? []).map((f) =>
                      r.answers[f.id] ? (
                        <p key={f.id} className="text-slate-700">
                          <span className="font-medium">{f.label}:</span> {r.answers[f.id]}
                        </p>
                      ) : null,
                    )}
                  </li>
                ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}
