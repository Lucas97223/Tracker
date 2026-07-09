import { useMemo } from 'react';
import { useProjectPnL, useTrialBalance } from '../hooks/useReports';
import { useArAging } from '../hooks/useInvoices';
import { formatMoney } from '../lib/money';

const BUCKET_BADGES: Record<string, string> = {
  current: 'bg-emerald-100 text-emerald-800',
  '1-30': 'bg-amber-100 text-amber-800',
  '31-60': 'bg-orange-100 text-orange-800',
  '61-90': 'bg-red-100 text-red-800',
  '90+': 'bg-red-200 text-red-900',
};

/**
 * The ledger, finally on screen: project P&L, AR aging and the trial balance
 * all read the GL-backed views — never feature-table sums (I2).
 */
export function ReportsPage() {
  const pnl = useProjectPnL();
  const trialBalance = useTrialBalance();
  const aging = useArAging();

  const pnlRows = useMemo(
    () =>
      (pnl.data ?? [])
        .filter((r) => Number(r.revenue) !== 0 || Number(r.cogs) !== 0 || Number(r.expense) !== 0)
        .sort((a, b) => Number(b.net_margin) - Number(a.net_margin)),
    [pnl.data],
  );

  const tb = useMemo(() => trialBalance.data ?? [], [trialBalance.data]);
  const tbTotals = useMemo(
    () => ({
      debit: tb.reduce((acc, r) => acc + Number(r.total_debit), 0),
      credit: tb.reduce((acc, r) => acc + Number(r.total_credit), 0),
    }),
    [tb],
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Reports</h1>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Project P&L (ledger-backed)
            <span className="ml-2 normal-case text-slate-400">
              memo columns are managerial — never posted to the ledger
            </span>
          </h2>
        </header>
        {pnlRows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">No posted activity yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Project</th>
                  <th className="px-4 py-2 text-right">Revenue</th>
                  <th className="px-4 py-2 text-right">Team pay (COGS)</th>
                  <th className="px-4 py-2 text-right">Expenses</th>
                  <th className="px-4 py-2 text-right">Net margin</th>
                  <th className="px-4 py-2 text-right text-slate-400">Hours (memo)</th>
                  <th className="px-4 py-2 text-right text-slate-400">Labor cost (memo)</th>
                  <th className="px-4 py-2 text-right text-slate-400">Eff. $/h</th>
                </tr>
              </thead>
              <tbody>
                {pnlRows.map((r) => (
                  <tr key={r.project_id} className="border-b border-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-800">{r.project_name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-emerald-700">
                      {formatMoney(r.revenue)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.cogs)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.expense)}</td>
                    <td
                      className={`px-4 py-2 text-right font-semibold tabular-nums ${
                        Number(r.net_margin) >= 0 ? 'text-emerald-700' : 'text-red-600'
                      }`}
                    >
                      {formatMoney(r.net_margin)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">
                      {r.logged_minutes > 0 ? (r.logged_minutes / 60).toFixed(1) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">
                      {Number(r.labor_memo_cost) > 0 ? formatMoney(r.labor_memo_cost) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-400">
                      {r.effective_hourly_rate ? formatMoney(r.effective_hourly_rate) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Accounts receivable aging
          </h2>
        </header>
        {(aging.data ?? []).length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">No open invoices. 🎉</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2">Invoice</th>
                  <th className="px-4 py-2">Contact</th>
                  <th className="px-4 py-2">Due</th>
                  <th className="px-4 py-2">Bucket</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {(aging.data ?? []).map((r) => (
                  <tr key={r.invoice_id} className="border-b border-slate-50">
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">#{r.number}</td>
                    <td className="px-4 py-2 text-slate-800">{r.contact_name}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {r.due_date ?? '—'}
                      {r.days_overdue > 0 && (
                        <span className="ml-1 text-xs text-red-500">({r.days_overdue}d late)</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`badge ${BUCKET_BADGES[r.bucket]}`}>{r.bucket}</span>
                    </td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">
                      {formatMoney(r.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Trial balance
          </h2>
          <span
            className={`badge ${
              Math.abs(tbTotals.debit - tbTotals.credit) < 0.005
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-red-100 text-red-800'
            }`}
          >
            {Math.abs(tbTotals.debit - tbTotals.credit) < 0.005 ? 'balanced' : 'UNBALANCED'}
          </span>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2">Code</th>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2 text-right">Debits</th>
                <th className="px-4 py-2 text-right">Credits</th>
                <th className="px-4 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {tb
                .filter((r) => Number(r.total_debit) !== 0 || Number(r.total_credit) !== 0)
                .map((r) => (
                  <tr key={r.account_id} className="border-b border-slate-50">
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">{r.code}</td>
                    <td className="px-4 py-2 text-slate-800">{r.name}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.total_debit)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.total_credit)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatMoney(r.balance)}</td>
                  </tr>
                ))}
              <tr className="font-semibold text-slate-800">
                <td className="px-4 py-2" colSpan={2}>
                  Totals
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(tbTotals.debit)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(tbTotals.credit)}</td>
                <td className="px-4 py-2" />
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
