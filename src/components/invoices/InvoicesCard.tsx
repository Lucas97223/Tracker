import { useMemo, useState } from 'react';
import {
  useInvoicesForProject,
  useSendInvoice,
  useVoidInvoice,
  useRecordPayment,
  useVoidPayment,
  type InvoiceWithDetails,
} from '../../hooks/useInvoices';
import { CreateInvoiceModal } from './CreateInvoiceModal';
import { Modal } from '../Modal';
import { useToast } from '../../providers/ToastProvider';
import { formatMoney } from '../../lib/money';
import type { InvoiceStatus, Project } from '../../types/database';

const STATUS_BADGES: Record<InvoiceStatus, string> = {
  draft: 'bg-slate-100 text-slate-600',
  sent: 'bg-blue-100 text-blue-800',
  partial: 'bg-amber-100 text-amber-800',
  paid: 'bg-emerald-100 text-emerald-800',
  void: 'bg-slate-100 text-slate-400 line-through',
};

function RecordPaymentModal({
  invoice,
  onClose,
}: {
  invoice: InvoiceWithDetails;
  onClose: () => void;
}) {
  const record = useRecordPayment();
  const toast = useToast();
  const balance = Number(invoice.totals?.balance ?? 0);
  const [amount, setAmount] = useState(balance.toFixed(2));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');

  async function submit() {
    try {
      await record.mutateAsync({
        invoice_id: invoice.id,
        amount: Number(amount),
        payment_date: date,
        method: method.trim() || null,
        reference: reference.trim() || null,
      });
      toast.success('Payment recorded and posted to the ledger');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Payment failed');
    }
  }

  return (
    <Modal open title={`Record payment — invoice #${invoice.number}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Open balance: <strong>{formatMoney(balance)}</strong>
        </p>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Amount
          <input
            type="number"
            min="0.01"
            step="0.01"
            className="input mt-1 w-full"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Date
          <input
            type="date"
            className="input mt-1 w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Method
            <input
              className="input mt-1 w-full"
              placeholder="wire, card, cash…"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Reference
            <input
              className="input mt-1 w-full"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={record.isPending || Number(amount) <= 0}
            onClick={() => void submit()}
          >
            Record payment
          </button>
        </div>
      </div>
    </Modal>
  );
}

function InvoiceRow({
  invoice,
  canEdit,
  isAdmin,
}: {
  invoice: InvoiceWithDetails;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const send = useSendInvoice();
  const voidInvoice = useVoidInvoice();
  const voidPayment = useVoidPayment();
  const toast = useToast();

  const totals = invoice.totals;
  const livePayments = invoice.payments.filter((p) => !p.voided_at);
  const shareUrl = `${window.location.origin}${window.location.pathname}#/share/invoice/${invoice.share_token}`;

  async function handleSend() {
    try {
      await send.mutateAsync(invoice.id);
      toast.success(`Invoice #${invoice.number} marked sent`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed');
    }
  }

  async function handleVoidInvoice() {
    try {
      await voidInvoice.mutateAsync(invoice.id);
      toast.success(`Invoice #${invoice.number} voided`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Void failed');
    }
  }

  async function handleVoidPayment(id: string) {
    try {
      await voidPayment.mutateAsync(id);
      toast.success('Payment voided (reversal posted)');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Void failed');
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied');
    } catch {
      toast.error('Could not copy — link: ' + shareUrl);
    }
  }

  return (
    <li className="px-4 py-2">
      <div
        className="flex cursor-pointer flex-wrap items-center gap-3"
        onClick={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={open}
      >
        <span className="font-mono text-xs text-slate-500">#{invoice.number}</span>
        <span className={`badge ${STATUS_BADGES[invoice.status]}`}>{invoice.status}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
          {invoice.contact?.name ?? '—'}
          {invoice.due_date && (
            <span className="ml-2 text-xs text-slate-400">due {invoice.due_date}</span>
          )}
        </span>
        <span className="text-sm tabular-nums text-slate-600">
          {formatMoney(totals?.paid ?? '0')} / {formatMoney(totals?.total ?? '0')}
        </span>
      </div>

      {open && (
        <div className="mt-2 space-y-2 rounded bg-slate-50 p-3">
          <table className="w-full text-sm">
            <tbody>
              {invoice.lines
                .slice()
                .sort((a, b) => a.line_number - b.line_number)
                .map((l) => (
                  <tr key={l.id} className="text-slate-700">
                    <td className="py-0.5">{l.description}</td>
                    <td className="py-0.5 text-right tabular-nums">
                      {Number(l.qty)} × {formatMoney(l.unit_price)}
                    </td>
                    <td className="py-0.5 pl-4 text-right tabular-nums">
                      {formatMoney(Number(l.qty) * Number(l.unit_price))}
                    </td>
                  </tr>
                ))}
              <tr className="border-t border-slate-200 text-slate-500">
                <td className="pt-1 text-xs">
                  subtotal {formatMoney(totals?.subtotal ?? '0')} · tax{' '}
                  {formatMoney(totals?.tax_total ?? '0')}
                </td>
                <td className="pt-1 text-right text-xs" colSpan={2}>
                  balance <strong>{formatMoney(totals?.balance ?? '0')}</strong>
                </td>
              </tr>
            </tbody>
          </table>

          {livePayments.length > 0 && (
            <ul className="space-y-1 border-t border-slate-200 pt-2">
              {livePayments.map((p) => (
                <li key={p.id} className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="badge bg-emerald-50 text-emerald-700">payment</span>
                  <span className="flex-1">
                    {p.payment_date}
                    {p.method ? ` · ${p.method}` : ''}
                    {p.reference ? ` · ${p.reference}` : ''}
                  </span>
                  <span className="tabular-nums">{formatMoney(p.amount)}</span>
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn-ghost !px-2 !py-0.5 text-xs"
                      onClick={() => void handleVoidPayment(p.id)}
                    >
                      Void
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-2">
            {canEdit && invoice.status === 'draft' && (
              <button type="button" className="btn-primary" onClick={() => void handleSend()}>
                Mark sent
              </button>
            )}
            {canEdit && ['sent', 'partial'].includes(invoice.status) && (
              <button type="button" className="btn-primary" onClick={() => setPaying(true)}>
                Record payment
              </button>
            )}
            {invoice.status !== 'draft' && invoice.status !== 'void' && (
              <>
                <button type="button" className="btn-ghost" onClick={() => void copyLink()}>
                  Copy share link
                </button>
                <a className="btn-ghost" href={shareUrl} target="_blank" rel="noreferrer">
                  Print view
                </a>
              </>
            )}
            {canEdit &&
              ['draft', 'sent'].includes(invoice.status) &&
              livePayments.length === 0 && (
                <button type="button" className="btn-danger" onClick={() => void handleVoidInvoice()}>
                  Void invoice
                </button>
              )}
          </div>
        </div>
      )}

      {paying && <RecordPaymentModal invoice={invoice} onClose={() => setPaying(false)} />}
    </li>
  );
}

/**
 * Invoices & payments for one project. Invoices are operational documents —
 * the ledger only moves when a payment is recorded (via RPC).
 */
export function InvoicesCard({
  project,
  canEdit,
  isAdmin,
}: {
  project: Project;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const invoices = useInvoicesForProject(project.id);
  const [creating, setCreating] = useState(false);

  const rows = useMemo(
    () => (invoices.data ?? []).filter((i) => i.status !== 'void' || i.payments.length > 0),
    [invoices.data],
  );

  return (
    <section className="card">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Invoices</h2>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            + Invoice
          </button>
        )}
      </header>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500">
          No invoices yet. Payments recorded against an invoice post straight to the ledger.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((inv) => (
            <InvoiceRow key={inv.id} invoice={inv} canEdit={canEdit} isAdmin={isAdmin} />
          ))}
        </ul>
      )}
      {creating && <CreateInvoiceModal project={project} onClose={() => setCreating(false)} />}
    </section>
  );
}
