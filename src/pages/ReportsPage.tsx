import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useProjectPnL, useTrialBalance } from '../hooks/useReports';
import { useArAging } from '../hooks/useInvoices';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { formatMoney } from '../lib/money';
import { Link } from 'react-router-dom';
import { exportToCsv } from '../lib/csv';

interface ForecastRow {
  org_id: string;
  direction: 'in' | 'out';
  bucket: string;
  source: string;
  amount: string;
}
interface TaxSetAside {
  org_id: string;
  pct: string;
  ytd_revenue: string;
  suggested_set_aside: string;
}

const IN_BUCKETS = ['overdue', '0-30', '31-60', '61+'];

function CashflowSection() {
  const { isAdmin, orgId } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [pctDraft, setPctDraft] = useState<string | null>(null);

  const forecast = useQuery({
    queryKey: ['reports', 'cashflow'] as const,
    queryFn: async () => {
      const [flows, tax] = await Promise.all([
        supabase.from('v_cashflow_forecast').select('*'),
        supabase.from('v_tax_set_aside').select('*'),
      ]);
      if (flows.error) throw flows.error;
      if (tax.error) throw tax.error;
      return {
        flows: (flows.data ?? []) as ForecastRow[],
        tax: ((tax.data ?? []) as TaxSetAside[])[0] ?? null,
      };
    },
  });

  const savePct = useMutation({
    mutationFn: async (pct: number) => {
      const { data: org, error: gErr } = await supabase
        .from('organizations').select('settings').eq('id', orgId!).single();
      if (gErr) throw gErr;
      const settings = { ...(org?.settings ?? {}), tax_set_aside_pct: String(pct) };
      const { error } = await supabase.from('organizations').update({ settings }).eq('id', orgId!);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports', 'cashflow'] }),
  });

  const flows = forecast.data?.flows ?? [];
  const tax = forecast.data?.tax ?? null;
  const inBuckets = IN_BUCKETS.map((b) => ({
    bucket: b,
    total: flows.filter((f) => f.direction === 'in' && f.bucket === b)
      .reduce((a, f) => a + Number(f.amount), 0),
  }));
  const totalIn = inBuckets.reduce((a, b) => a + b.total, 0);
  const committedOut = flows.filter((f) => f.direction === 'out' && f.bucket === 'committed')
    .reduce((a, f) => a + Number(f.amount), 0);
  const forecastOut = flows.filter((f) => f.direction === 'out' && f.bucket === 'forecast')
    .reduce((a, f) => a + Number(f.amount), 0);

  return (
    <section className="card">
      <header className="border-b border-slate-100 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Cash-flow forecast
          <span className="ml-2 normal-case text-slate-400">
            expected, not actual — actuals live in the ledger above
          </span>
        </h2>
      </header>
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Expected in</p>
          <ul className="mt-1 space-y-1 text-sm">
            {inBuckets.map((b) => (
              <li key={b.bucket} className="flex justify-between">
                <span className={b.bucket === 'overdue' ? 'text-red-600' : 'text-slate-600'}>
                  {b.bucket === 'overdue' ? 'Overdue' : `Due ${b.bucket} days`}
                </span>
                <span className="tabular-nums">{formatMoney(b.total)}</span>
              </li>
            ))}
            <li className="flex justify-between border-t border-slate-100 pt-1 font-semibold text-slate-800">
              <span>Total expected</span>
              <span className="tabular-nums">{formatMoney(totalIn)}</span>
            </li>
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Expected out</p>
          <ul className="mt-1 space-y-1 text-sm">
            <li className="flex justify-between text-slate-600">
              <span>Team pay committed (payable)</span>
              <span className="tabular-nums">{formatMoney(committedOut)}</span>
            </li>
            <li className="flex justify-between text-slate-600">
              <span>Draft pay (forecast)</span>
              <span className="tabular-nums">{formatMoney(forecastOut)}</span>
            </li>
            <li className="flex justify-between border-t border-slate-100 pt-1 font-semibold text-slate-800">
              <span>Net expected</span>
              <span className="tabular-nums">{formatMoney(totalIn - committedOut - forecastOut)}</span>
            </li>
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tax set-aside (estimate)</p>
          {tax && (
            <ul className="mt-1 space-y-1 text-sm">
              <li className="flex justify-between text-slate-600">
                <span>YTD ledger revenue</span>
                <span className="tabular-nums">{formatMoney(tax.ytd_revenue)}</span>
              </li>
              <li className="flex items-center justify-between text-slate-600">
                <span>Set-aside rate</span>
                {isAdmin ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="number" min="0" max="60"
                      className="input w-16 !py-0.5 text-right text-sm"
                      value={pctDraft ?? Number(tax.pct)}
                      onChange={(e) => setPctDraft(e.target.value)}
                      onBlur={() => {
                        if (pctDraft !== null && Number(pctDraft) !== Number(tax.pct)) {
                          void savePct.mutateAsync(Number(pctDraft))
                            .then(() => toast.success('Set-aside rate saved'))
                            .catch((err) => toast.error(err instanceof Error ? err.message : 'Failed'));
                        }
                        setPctDraft(null);
                      }}
                    />%
                  </span>
                ) : (
                  <span>{Number(tax.pct)}%</span>
                )}
              </li>
              <li className="flex justify-between border-t border-slate-100 pt-1 font-semibold text-slate-800">
                <span>Suggested to set aside</span>
                <span className="tabular-nums">{formatMoney(tax.suggested_set_aside)}</span>
              </li>
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

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
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Reports</h1>
        <div className="flex items-center gap-2">
          <Link to="/reconciliation" className="btn-ghost">🏦 Bank reconciliation</Link>
          <button
            type="button"
            className="btn-ghost"
            onClick={() =>
              void supabase
                .from('v_gl_export')
                .select('*')
                .order('entry_date')
                .limit(10000)
                .then(({ data, error }) => {
                  if (error || !data?.length) return;
                  exportToCsv(
                    'general-ledger.csv',
                    data.map((r) => ({
                      date: r.entry_date, account: r.account_code, name: r.account_name,
                      debit: r.debit, credit: r.credit, memo: r.memo, project: r.project,
                      source: r.source_type, reference: r.reference,
                    })),
                  );
                })
            }
          >
            ⬇ Export GL (CSV)
          </button>
        </div>
      </header>

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

      <CashflowSection />

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
