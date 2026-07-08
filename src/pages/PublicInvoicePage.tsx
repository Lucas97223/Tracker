import { useParams } from 'react-router-dom';
import { usePublicInvoice } from '../hooks/useInvoices';
import { formatMoney } from '../lib/money';

/**
 * Anonymous, share-token-gated invoice view (and print stylesheet — the
 * "PDF" path is the browser's print-to-PDF). Reads a single security-definer
 * RPC that exposes nothing beyond the invoice itself.
 */
export function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const invoice = usePublicInvoice(token);

  if (invoice.isLoading) {
    return <p className="p-10 text-center text-sm text-slate-500">Loading invoice…</p>;
  }
  if (invoice.isError || !invoice.data) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-lg font-semibold text-slate-800">Invoice not available</h1>
        <p className="mt-1 text-sm text-slate-500">
          This link is invalid, or the invoice hasn't been sent yet.
        </p>
      </div>
    );
  }

  const inv = invoice.data;
  const totals = inv.totals;

  return (
    <div className="mx-auto max-w-2xl p-8 print:p-0">
      <div className="mb-6 flex items-start justify-between print:hidden">
        <span
          className={`badge ${
            inv.status === 'paid'
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-blue-100 text-blue-800'
          }`}
        >
          {inv.status}
        </span>
        <button type="button" className="btn-primary" onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>

      <header className="flex items-start justify-between border-b-2 border-slate-800 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{inv.org_name}</h1>
          {inv.project_name && <p className="text-sm text-slate-500">{inv.project_name}</p>}
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold">Invoice #{inv.number}</p>
          <p className="text-sm text-slate-500">Issued {inv.issue_date}</p>
          {inv.due_date && <p className="text-sm text-slate-500">Due {inv.due_date}</p>}
        </div>
      </header>

      {inv.contact && (
        <section className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Billed to</p>
          <p className="font-medium text-slate-800">{inv.contact.name}</p>
          {inv.contact.company && <p className="text-sm text-slate-600">{inv.contact.company}</p>}
          {inv.contact.email && <p className="text-sm text-slate-600">{inv.contact.email}</p>}
        </section>
      )}

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2">Description</th>
            <th className="py-2 text-right">Qty</th>
            <th className="py-2 text-right">Unit</th>
            <th className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-2 text-slate-800">
                {l.description}
                {l.tax_name && <span className="ml-1 text-xs text-slate-400">({l.tax_name})</span>}
              </td>
              <td className="py-2 text-right tabular-nums">{Number(l.qty)}</td>
              <td className="py-2 text-right tabular-nums">{formatMoney(l.unit_price)}</td>
              <td className="py-2 text-right tabular-nums">{formatMoney(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {totals && (
        <div className="mt-4 ml-auto w-64 space-y-1 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatMoney(totals.subtotal)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Tax</span>
            <span className="tabular-nums">{formatMoney(totals.tax_total)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold text-slate-900">
            <span>Total</span>
            <span className="tabular-nums">{formatMoney(totals.total)}</span>
          </div>
          <div className="flex justify-between text-slate-600">
            <span>Paid</span>
            <span className="tabular-nums">{formatMoney(totals.paid)}</span>
          </div>
          <div className="flex justify-between font-semibold text-slate-900">
            <span>Balance due</span>
            <span className="tabular-nums">{formatMoney(totals.balance)}</span>
          </div>
        </div>
      )}

      {inv.memo && <p className="mt-6 text-sm text-slate-600">{inv.memo}</p>}
    </div>
  );
}
