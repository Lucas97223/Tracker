import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { ContactPicker } from '../contacts/ContactPicker';
import { useCreateInvoice, useTaxRates, type InvoiceLineInput } from '../../hooks/useInvoices';
import { useToast } from '../../providers/ToastProvider';
import { formatMoney } from '../../lib/money';
import type { Project } from '../../types/database';

interface LineDraft extends InvoiceLineInput {
  key: number;
}

export function CreateInvoiceModal({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const createInvoice = useCreateInvoice();
  const taxRates = useTaxRates();
  const toast = useToast();

  const [contactId, setContactId] = useState<string | null>(project.contact_id ?? null);
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([
    { key: 1, description: '', qty: 1, unit_price: 0, tax_rate_id: null },
  ]);

  const totals = useMemo(() => {
    const rateMap = new Map((taxRates.data ?? []).map((t) => [t.id, Number(t.rate)]));
    let subtotal = 0;
    let tax = 0;
    for (const l of lines) {
      const amount = Math.round(l.qty * l.unit_price * 100) / 100;
      subtotal += amount;
      if (l.tax_rate_id) {
        tax += Math.round(amount * (rateMap.get(l.tax_rate_id) ?? 0) * 100) / 100;
      }
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [lines, taxRates.data]);

  function patchLine(key: number, patch: Partial<InvoiceLineInput>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (!contactId) {
      toast.error('Pick or create a contact — every invoice bills a contact');
      return;
    }
    const cleaned = lines
      .filter((l) => l.description.trim() && l.qty > 0 && l.unit_price >= 0)
      .map(({ key: _key, ...l }) => l);
    if (cleaned.length === 0) {
      toast.error('Add at least one line');
      return;
    }
    try {
      await createInvoice.mutateAsync({
        contact_id: contactId,
        project_id: project.id,
        issue_date: issueDate,
        due_date: dueDate || null,
        memo: memo.trim() || null,
        lines: cleaned,
      });
      toast.success('Draft invoice created');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the invoice');
    }
  }

  return (
    <Modal open title="New invoice" onClose={onClose} size="lg">
      <div className="space-y-4">
        <ContactPicker value={contactId} onChange={setContactId} />

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Issue date
            <input
              type="date"
              className="input mt-1 w-full"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Due date
            <input
              type="date"
              className="input mt-1 w-full"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Lines</p>
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="flex flex-wrap items-center gap-2">
                <input
                  className="input min-w-0 flex-1"
                  placeholder="Description"
                  value={l.description}
                  onChange={(e) => patchLine(l.key, { description: e.target.value })}
                />
                <input
                  type="number"
                  min="0.25"
                  step="0.25"
                  className="input w-20 text-right"
                  value={l.qty}
                  aria-label="Quantity"
                  onChange={(e) => patchLine(l.key, { qty: Number(e.target.value) })}
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="input w-28 text-right"
                  value={l.unit_price}
                  aria-label="Unit price"
                  onChange={(e) => patchLine(l.key, { unit_price: Number(e.target.value) })}
                />
                <select
                  className="input w-32"
                  value={l.tax_rate_id ?? ''}
                  aria-label="Tax rate"
                  onChange={(e) => patchLine(l.key, { tax_rate_id: e.target.value || null })}
                >
                  <option value="">No tax</option>
                  {(taxRates.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-ghost !px-2"
                  aria-label="Remove line"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-ghost mt-2"
            onClick={() =>
              setLines((ls) => [
                ...ls,
                { key: Math.max(0, ...ls.map((x) => x.key)) + 1, description: '', qty: 1, unit_price: 0, tax_rate_id: null },
              ])
            }
          >
            + Add line
          </button>
        </div>

        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Memo
          <input
            className="input mt-1 w-full"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </label>

        <div className="flex items-center justify-between border-t border-slate-100 pt-3">
          <p className="text-sm text-slate-600">
            Subtotal {formatMoney(totals.subtotal)} · Tax {formatMoney(totals.tax)} ·{' '}
            <strong>Total {formatMoney(totals.total)}</strong>
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={createInvoice.isPending}
              onClick={() => void submit()}
            >
              Create draft
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
