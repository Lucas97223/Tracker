import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAcceptProposal, usePublicProposal } from '../hooks/useSell';
import { formatMoney } from '../lib/money';

/** Anonymous proposal page: read, then accept — which runs the whole Win. */
export function PublicProposalPage() {
  const { token } = useParams<{ token: string }>();
  const proposal = usePublicProposal(token);
  const accept = useAcceptProposal();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (proposal.isLoading) {
    return <p className="p-10 text-center text-sm text-slate-500">Loading…</p>;
  }
  if (proposal.isError || !proposal.data) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-lg font-semibold text-slate-800">This proposal isn't available</h1>
        <p className="mt-1 text-sm text-slate-500">The link may be wrong, or it was withdrawn.</p>
      </div>
    );
  }

  const p = proposal.data;
  const accepted = p.status === 'accepted';

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await accept.mutateAsync({ token: token!, name });
      await proposal.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong — try again');
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <header className="border-b-2 border-slate-800 pb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{p.org_name}</p>
        <h1 className="text-2xl font-bold text-slate-900">{p.title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          Prepared for {p.contact_name}
          {p.valid_until && !accepted && ` · valid until ${p.valid_until}`}
        </p>
      </header>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2">Item</th>
            <th className="py-2 text-right">Qty</th>
            <th className="py-2 text-right">Price</th>
            <th className="py-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-2 text-slate-800">{l.description}</td>
              <td className="py-2 text-right tabular-nums">{Number(l.qty)}</td>
              <td className="py-2 text-right tabular-nums">{formatMoney(l.unit_price)}</td>
              <td className="py-2 text-right tabular-nums">{formatMoney(l.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {p.totals && (
        <div className="ml-auto mt-4 w-64 space-y-1 text-sm">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal</span><span className="tabular-nums">{formatMoney(p.totals.subtotal)}</span>
          </div>
          {Number(p.totals.tax_total) > 0 && (
            <div className="flex justify-between text-slate-600">
              <span>Tax</span><span className="tabular-nums">{formatMoney(p.totals.tax_total)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold text-slate-900">
            <span>Total</span><span className="tabular-nums">{formatMoney(p.totals.total)}</span>
          </div>
          {Number(p.deposit_pct) > 0 && (
            <p className="pt-1 text-xs text-slate-500">
              A {Number(p.deposit_pct)}% deposit ({formatMoney((Number(p.totals.total) * Number(p.deposit_pct)) / 100)}) is due on acceptance.
            </p>
          )}
        </div>
      )}

      {p.memo && <p className="mt-6 whitespace-pre-wrap text-sm text-slate-600">{p.memo}</p>}

      <div className="mt-8 rounded-lg border border-slate-200 p-4">
        {accepted ? (
          <div className="text-center">
            <h2 className="text-lg font-semibold text-emerald-700">Accepted 🎉</h2>
            <p className="mt-1 text-sm text-slate-600">
              Thank you! {p.org_name} will follow up with your agreement and deposit invoice.
            </p>
          </div>
        ) : p.status === 'sent' ? (
          <form onSubmit={(e) => void handleAccept(e)} className="space-y-3">
            <p className="text-sm text-slate-700">
              Type your full name to accept this proposal. Accepting kicks everything off — your
              project, agreement, and deposit invoice.
            </p>
            <div className="flex gap-2">
              <input
                className="input min-w-0 flex-1"
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <button type="submit" className="btn-primary" disabled={accept.isPending || !name.trim()}>
                {accept.isPending ? 'Accepting…' : 'Accept proposal'}
              </button>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </form>
        ) : (
          <p className="text-center text-sm text-slate-500">This proposal is {p.status}.</p>
        )}
      </div>
    </div>
  );
}
