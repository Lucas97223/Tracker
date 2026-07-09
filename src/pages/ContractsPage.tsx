import { useState } from 'react';
import { useContracts, useSaveContract, type Contract } from '../hooks/useSell';
import { ContactPicker } from '../components/contacts/ContactPicker';
import { Modal } from '../components/Modal';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

const STATUS_BADGES: Record<Contract['status'], string> = {
  draft: 'bg-slate-100 text-slate-600',
  sent: 'bg-blue-100 text-blue-800',
  signed: 'bg-emerald-100 text-emerald-800',
  void: 'bg-slate-100 text-slate-400 line-through',
};

function ContractModal({ contract, onClose }: { contract: Contract | null; onClose: () => void }) {
  const save = useSaveContract();
  const toast = useToast();
  const readOnly = contract?.status === 'signed' || contract?.status === 'void';
  const [contactId, setContactId] = useState<string | null>(contract?.contact_id ?? null);
  const [title, setTitle] = useState(contract?.title ?? '');
  const [body, setBody] = useState(contract?.body_md ?? '');

  async function submit(status?: Contract['status']) {
    if (!contactId || !title.trim()) {
      toast.error('A contract needs a contact and a title');
      return;
    }
    try {
      await save.mutateAsync({
        id: contract?.id,
        contact_id: contactId,
        title: title.trim(),
        body_md: body,
        ...(status ? { status } : {}),
      });
      toast.success(status === 'sent' ? 'Contract sent — copy the signing link' : 'Contract saved');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <Modal open title={contract ? contract.title : 'New contract'} onClose={onClose} size="lg">
      <div className="space-y-3">
        {!readOnly && <ContactPicker value={contactId} onChange={(id) => setContactId(id)} />}
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Title
          <input
            className="input mt-1 w-full"
            value={title}
            disabled={readOnly}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Body (markdown-ish: # headings, - lists, **bold**)
          <textarea
            className="input mt-1 w-full font-mono text-xs"
            rows={14}
            value={body}
            disabled={readOnly}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        {contract?.status === 'signed' && (
          <p className="text-sm text-emerald-700">
            Signed {contract.signed_at && new Date(contract.signed_at).toLocaleString()} — the
            document is frozen; evidence is on file.
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
          {!readOnly && (
            <>
              <button type="button" className="btn-ghost" disabled={save.isPending} onClick={() => void submit()}>
                Save draft
              </button>
              <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => void submit('sent')}>
                Save & send
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function ContractsPage() {
  const { canEdit } = useAuth();
  const contracts = useContracts();
  const toast = useToast();
  const [editing, setEditing] = useState<Contract | null>(null);
  const [creating, setCreating] = useState(false);

  function shareUrl(c: Contract) {
    return `${window.location.origin}${window.location.pathname}#/c/${c.share_token}`;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Contracts</h1>
          <p className="mt-1 text-sm text-slate-500">
            Click-to-sign with evidence (name, IP, document hash). Provider-grade e-signature plugs
            in here when you pick one.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>+ Contract</button>
        )}
      </header>

      {(contracts.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">
          No contracts yet. Winning a proposal generates one automatically.
        </p>
      ) : (
        <div className="card divide-y divide-slate-50">
          {(contracts.data ?? []).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className={`badge ${STATUS_BADGES[c.status]}`}>{c.status}</span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-medium text-slate-800 hover:underline"
                onClick={() => setEditing(c)}
              >
                {c.title}
              </button>
              <span className="text-xs text-slate-400">{c.contact?.name}</span>
              {c.status !== 'draft' && c.status !== 'void' && (
                <>
                  <button
                    type="button"
                    className="btn-ghost !py-0.5 text-xs"
                    onClick={() =>
                      void navigator.clipboard.writeText(shareUrl(c))
                        .then(() => toast.success('Signing link copied'))
                    }
                  >
                    Copy signing link
                  </button>
                  <a className="btn-ghost !py-0.5 text-xs" href={shareUrl(c)} target="_blank" rel="noreferrer">
                    Preview
                  </a>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <ContractModal contract={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}
    </div>
  );
}
