import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { useAddUnbilledToInvoice, useUnbilled } from '../../hooks/useTime';
import { useToast } from '../../providers/ToastProvider';
import { formatMoney } from '../../lib/money';

/**
 * Pick unbilled billable time + expenses and pull them onto a draft invoice.
 * Sources get locked (I5) and each line keeps its source reference.
 */
export function AddUnbilledModal({
  invoiceId,
  invoiceNumber,
  projectId,
  onClose,
}: {
  invoiceId: string;
  invoiceNumber: number;
  projectId: string;
  onClose: () => void;
}) {
  const unbilled = useUnbilled(projectId);
  const addUnbilled = useAddUnbilledToInvoice();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const rows = unbilled.data ?? [];
  const total = useMemo(
    () => rows.filter((r) => selected.has(r.source_id)).reduce((a, r) => a + Number(r.amount), 0),
    [rows, selected],
  );

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function submit() {
    const time = rows
      .filter((r) => r.source_type === 'time_entry' && selected.has(r.source_id))
      .map((r) => r.source_id);
    const expenses = rows
      .filter((r) => r.source_type === 'expense' && selected.has(r.source_id))
      .map((r) => r.source_id);
    try {
      const n = await addUnbilled.mutateAsync({
        invoice_id: invoiceId,
        time_entry_ids: time,
        expense_ids: expenses,
      });
      toast.success(`${n} line${n === 1 ? '' : 's'} added to invoice #${invoiceNumber}`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Billing failed');
    }
  }

  return (
    <Modal open title={`Add unbilled work — invoice #${invoiceNumber}`} onClose={onClose}>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing unbilled on this project. Time must be billable and stopped; expenses must be
          marked billable.
        </p>
      ) : (
        <div className="space-y-3">
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.source_id}>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-50 ${
                    r.missing_rate ? 'opacity-60' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r.source_id)}
                    disabled={r.missing_rate}
                    onChange={() => toggle(r.source_id)}
                  />
                  <span className="badge bg-slate-100 text-slate-600">
                    {r.source_type === 'time_entry' ? 'time' : 'expense'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-700">
                    {r.who} · {r.description}
                  </span>
                  <span className="tabular-nums text-slate-600">
                    {r.missing_rate ? 'no bill rate' : formatMoney(r.amount)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-slate-100 pt-3">
            <span className="text-sm text-slate-600">
              Selected: <strong>{formatMoney(total)}</strong>
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={selected.size === 0 || addUnbilled.isPending}
                onClick={() => void submit()}
              >
                Add {selected.size || ''} line{selected.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
