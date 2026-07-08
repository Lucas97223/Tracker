import { useState } from 'react';
import { useContacts, useCreateContact } from '../../hooks/useContacts';
import { useToast } from '../../providers/ToastProvider';

/**
 * Pick the invoice/project contact (I3: one contacts record per client),
 * with inline quick-create so modals never dead-end on a missing contact.
 */
export function ContactPicker({
  value,
  onChange,
  label = 'Contact',
}: {
  value: string | null;
  onChange: (contactId: string | null, contactName?: string) => void;
  label?: string;
}) {
  const contacts = useContacts();
  const createContact = useCreateContact();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');

  async function quickCreate() {
    if (!newName.trim()) return;
    try {
      const c = await createContact.mutateAsync({
        name: newName.trim(),
        email: newEmail.trim() || null,
      });
      onChange(c.id, c.name);
      setCreating(false);
      setNewName('');
      setNewEmail('');
      toast.success(`Contact "${c.name}" created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create contact');
    }
  }

  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
        <div className="mt-1 flex gap-2">
          <select
            className="input min-w-0 flex-1"
            value={value ?? ''}
            onChange={(e) => {
              const id = e.target.value || null;
              const name = (contacts.data ?? []).find((c) => c.id === id)?.name;
              onChange(id, name);
            }}
          >
            <option value="">— none —</option>
            {(contacts.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company ? ` (${c.company})` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-ghost whitespace-nowrap"
            onClick={() => setCreating((v) => !v)}
          >
            + New
          </button>
        </div>
      </label>
      {creating && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-slate-50 p-2">
          <input
            className="input min-w-0 flex-1"
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="input min-w-0 flex-1"
            placeholder="Email (optional)"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={createContact.isPending || !newName.trim()}
            onClick={() => void quickCreate()}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}
