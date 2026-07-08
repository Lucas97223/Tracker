import { useState } from 'react';
import { useContacts, useCreateContact, useUpdateContact } from '../hooks/useContacts';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { Modal } from '../components/Modal';
import { LoadingScreen } from '../components/LoadingScreen';
import type { Contact, ContactLifecycle, ContactType } from '../types/database';

const LIFECYCLE_BADGES: Record<ContactLifecycle, string> = {
  lead: 'bg-amber-100 text-amber-800',
  client: 'bg-emerald-100 text-emerald-800',
  archived: 'bg-slate-100 text-slate-500',
};

function ContactModal({
  contact,
  onClose,
}: {
  contact: Contact | null;
  onClose: () => void;
}) {
  const create = useCreateContact();
  const update = useUpdateContact();
  const toast = useToast();
  const [form, setForm] = useState({
    name: contact?.name ?? '',
    type: (contact?.type ?? 'person') as ContactType,
    lifecycle: (contact?.lifecycle ?? 'client') as ContactLifecycle,
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    company: contact?.company ?? '',
    notes: contact?.notes ?? '',
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    const payload = {
      name: form.name.trim(),
      type: form.type,
      lifecycle: form.lifecycle,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      company: form.company.trim() || null,
      notes: form.notes.trim() || null,
    };
    try {
      if (contact) {
        await update.mutateAsync({ id: contact.id, ...payload });
        toast.success('Contact updated');
      } else {
        await create.mutateAsync(payload);
        toast.success('Contact created');
      }
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <Modal open title={contact ? `Edit ${contact.name}` : 'New contact'} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Name
          <input
            className="input mt-1 w-full"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Type
            <select
              className="input mt-1 w-full"
              value={form.type}
              onChange={(e) => set('type', e.target.value as ContactType)}
            >
              <option value="person">Person</option>
              <option value="company">Company</option>
            </select>
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Lifecycle
            <select
              className="input mt-1 w-full"
              value={form.lifecycle}
              onChange={(e) => set('lifecycle', e.target.value as ContactLifecycle)}
            >
              <option value="lead">Lead</option>
              <option value="client">Client</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Email
            <input
              className="input mt-1 w-full"
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Phone
            <input
              className="input mt-1 w-full"
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          </label>
        </div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Company
          <input
            className="input mt-1 w-full"
            value={form.company}
            onChange={(e) => set('company', e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Notes
          <textarea
            className="input mt-1 w-full"
            rows={3}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={create.isPending || update.isPending}
            onClick={() => void submit()}
          >
            {contact ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ContactsPage() {
  const { canEdit } = useAuth();
  const contacts = useContacts(true);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  if (contacts.isLoading) return <LoadingScreen />;

  const rows = (contacts.data ?? []).filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return [c.name, c.email, c.company].filter(Boolean).join(' ').toLowerCase().includes(s);
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Contacts</h1>
        <div className="flex items-center gap-2">
          <input
            className="input w-56"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {canEdit && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              + Contact
            </button>
          )}
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          No contacts yet. Every invoice and (soon) every deal hangs off a contact.
        </p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Lifecycle</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Phone</th>
                <th className="px-4 py-2">Company</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                  onClick={() => canEdit && setEditing(c)}
                >
                  <td className="px-4 py-2 font-medium text-slate-800">{c.name}</td>
                  <td className="px-4 py-2">
                    <span className={`badge ${LIFECYCLE_BADGES[c.lifecycle]}`}>{c.lifecycle}</span>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{c.email ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{c.phone ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-600">{c.company ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <ContactModal
          contact={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
