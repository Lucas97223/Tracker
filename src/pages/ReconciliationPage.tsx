import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { formatMoney } from '../lib/money';

interface BankTxn {
  id: string;
  txn_date: string;
  amount: string;
  description: string;
  reconciled: boolean;
  created_at: string;
}
interface Suggestion {
  bank_transaction_id: string;
  line_id: string;
  entry_date: string;
  memo: string | null;
  account_code: string;
  ledger_amount: string;
  day_distance: number;
}

/** Tiny CSV parser: quoted fields, commas, newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((c) => c.trim() !== '')) rows.push(row); }
  return rows;
}

function detectColumns(header: string[]): { date: number; amount: number; desc: number } {
  const lower = header.map((h) => h.toLowerCase());
  const find = (...names: string[]) => lower.findIndex((h) => names.some((n) => h.includes(n)));
  return {
    date: Math.max(find('date'), 0),
    amount: find('amount') >= 0 ? find('amount') : 1,
    desc: find('desc', 'memo', 'name', 'payee') >= 0 ? find('desc', 'memo', 'name', 'payee') : 2,
  };
}

function normalizeDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us && us[1] && us[2] && us[3]) {
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  return null;
}

export function ReconciliationPage() {
  const { canEdit } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const data = useQuery({
    queryKey: ['reconciliation'] as const,
    queryFn: async () => {
      const [txns, suggestions] = await Promise.all([
        supabase.from('bank_transactions').select('*')
          .order('reconciled').order('txn_date', { ascending: false }).limit(300),
        supabase.from('v_bank_match_suggestions').select('*').order('day_distance'),
      ]);
      if (txns.error) throw txns.error;
      if (suggestions.error) throw suggestions.error;
      return {
        txns: (txns.data ?? []) as BankTxn[],
        suggestions: (suggestions.data ?? []) as Suggestion[],
      };
    },
  });

  const reconcile = useMutation({
    mutationFn: async (input: { txn: string; line: string }) => {
      const { error } = await supabase.rpc('reconcile_bank_txn', {
        p_txn: input.txn, p_line: input.line,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reconciliation'] }),
  });

  const unreconcile = useMutation({
    mutationFn: async (txn: string) => {
      const { error } = await supabase.rpc('unreconcile_bank_txn', { p_txn: txn });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reconciliation'] }),
  });

  async function handleFile(file: File) {
    setImporting(true);
    try {
      const rows = parseCsv(await file.text());
      const header = rows[0];
      if (rows.length < 2 || !header) throw new Error('The file needs a header row and data');
      const cols = detectColumns(header);
      const parsed = rows.slice(1).flatMap((r) => {
        const date = normalizeDate(r[cols.date] ?? '');
        const amount = Number((r[cols.amount] ?? '').replace(/[$,]/g, ''));
        const description = (r[cols.desc] ?? '').trim();
        if (!date || !Number.isFinite(amount) || amount === 0) return [];
        return [{ txn_date: date, amount: amount.toFixed(2), description, source: file.name }];
      });
      if (parsed.length === 0) throw new Error('No usable rows found (need date, amount, description)');

      let inserted = 0;
      for (const row of parsed) {
        const { error } = await supabase.from('bank_transactions').insert(row);
        if (!error) inserted++;
        else if (!error.message.includes('duplicate')) throw error;
      }
      toast.success(`Imported ${inserted} of ${parsed.length} rows (${parsed.length - inserted} already present)`);
      void qc.invalidateQueries({ queryKey: ['reconciliation'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const txns = data.data?.txns ?? [];
  const suggestionsByTxn = useMemo(() => {
    const m = new Map<string, Suggestion[]>();
    for (const s of data.data?.suggestions ?? []) {
      m.set(s.bank_transaction_id, [...(m.get(s.bank_transaction_id) ?? []), s]);
    }
    return m;
  }, [data.data?.suggestions]);
  const open = txns.filter((t) => !t.reconciled);
  const done = txns.filter((t) => t.reconciled);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Bank reconciliation</h1>
          <p className="mt-1 text-sm text-slate-500">
            Upload a bank CSV; match each row to its ledger line. Staging only — nothing posts.
          </p>
        </div>
        {canEdit && (
          <label className="btn-primary cursor-pointer">
            {importing ? 'Importing…' : '⬆ Upload bank CSV'}
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              disabled={importing}
              onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])}
            />
          </label>
        )}
      </header>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            To reconcile ({open.length})
          </h2>
        </header>
        {open.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">Nothing waiting. Upload a statement to start.</p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {open.map((t) => {
              const sugg = suggestionsByTxn.get(t.id) ?? [];
              return (
                <li key={t.id} className="px-4 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs text-slate-400">{t.txn_date}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-700">{t.description}</span>
                    <span className={`tabular-nums font-medium ${Number(t.amount) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                      {formatMoney(t.amount)}
                    </span>
                  </div>
                  {sugg.length > 0 && canEdit && (
                    <div className="mt-1 flex flex-wrap gap-2 pl-2">
                      {sugg.slice(0, 3).map((s) => (
                        <button
                          key={s.line_id}
                          type="button"
                          className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 hover:bg-emerald-100"
                          disabled={reconcile.isPending}
                          onClick={() =>
                            void reconcile.mutateAsync({ txn: t.id, line: s.line_id })
                              .then(() => toast.success('Matched'))
                              .catch((e) => toast.error(e instanceof Error ? e.message : 'Match failed'))
                          }
                        >
                          ✓ match: {s.entry_date} · {s.memo ?? s.account_code} ({formatMoney(s.ledger_amount)})
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {done.length > 0 && (
        <section className="card">
          <header className="border-b border-slate-100 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Reconciled ({done.length})
            </h2>
          </header>
          <ul className="divide-y divide-slate-50">
            {done.slice(0, 50).map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-1.5 text-sm">
                <span className="badge bg-emerald-100 text-emerald-800">✓</span>
                <span className="text-xs text-slate-400">{t.txn_date}</span>
                <span className="min-w-0 flex-1 truncate text-slate-500">{t.description}</span>
                <span className="tabular-nums text-slate-500">{formatMoney(t.amount)}</span>
                {canEdit && (
                  <button
                    type="button"
                    className="btn-ghost !py-0.5 text-xs"
                    onClick={() =>
                      void unreconcile.mutateAsync(t.id)
                        .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                    }
                  >
                    Unmatch
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
