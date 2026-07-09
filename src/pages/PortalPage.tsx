import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../providers/AuthProvider';
import { formatMoney } from '../lib/money';

// The client portal: magic-link sign-in, then read-only views of the
// client's own documents. Everything here is served by contact-scoped
// definer views — the database, not this page, decides what's visible.

interface PortalInvoice {
  id: string; number: number; status: string; issue_date: string; due_date: string | null;
  share_token: string; total: string; paid: string; balance: string;
  org_name: string; project_name: string | null;
}
interface PortalProject {
  id: string; name: string; status: string; start_date: string | null; end_date: string | null;
  org_name: string;
}
interface PortalProposal {
  id: string; title: string; status: string; share_token: string; total: string; org_name: string;
}
interface PortalContract {
  id: string; title: string; status: string; share_token: string; signed_at: string | null; org_name: string;
}

function usePortalData(enabled: boolean) {
  return useQuery({
    queryKey: ['portal'] as const,
    enabled,
    queryFn: async () => {
      const [invoices, projects, proposals, contracts] = await Promise.all([
        supabase.from('v_portal_invoices').select('*').order('issue_date', { ascending: false }),
        supabase.from('v_portal_projects').select('*').order('start_date', { ascending: false }),
        supabase.from('v_portal_proposals').select('*'),
        supabase.from('v_portal_contracts').select('*'),
      ]);
      for (const r of [invoices, projects, proposals, contracts]) {
        if (r.error) throw r.error;
      }
      return {
        invoices: (invoices.data ?? []) as PortalInvoice[],
        projects: (projects.data ?? []) as PortalProject[],
        proposals: (proposals.data ?? []) as PortalProposal[],
        contracts: (contracts.data ?? []) as PortalContract[],
      };
    },
  });
}

const STATUS_COLORS: Record<string, string> = {
  paid: 'bg-emerald-100 text-emerald-800',
  partial: 'bg-amber-100 text-amber-800',
  sent: 'bg-blue-100 text-blue-800',
  signed: 'bg-emerald-100 text-emerald-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  active: 'bg-emerald-100 text-emerald-800',
  planning: 'bg-amber-100 text-amber-800',
  completed: 'bg-slate-200 text-slate-700',
};

export function PortalPage() {
  const { session, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = usePortalData(!!session);

  async function requestLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        data: { portal: 'true' },
        emailRedirectTo: `${window.location.origin}${window.location.pathname}#/portal`,
      },
    });
    if (err) setError(err.message);
    else setSent(true);
  }

  if (loading) {
    return <p className="p-10 text-center text-sm text-slate-500">Loading…</p>;
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-sm p-10">
        <h1 className="text-xl font-semibold text-slate-900">Client portal</h1>
        <p className="mt-1 text-sm text-slate-500">
          Enter the email your photographer has on file — we'll send you a sign-in link.
        </p>
        {sent ? (
          <p className="mt-6 rounded bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Check your inbox — your sign-in link is on its way. You can close this tab.
          </p>
        ) : (
          <form onSubmit={(e) => void requestLink(e)} className="mt-6 space-y-3">
            <input
              className="input w-full"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <button type="submit" className="btn-primary w-full">Email me a sign-in link</button>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>
    );
  }

  const d = data.data;
  const orgName =
    d?.invoices[0]?.org_name || d?.projects[0]?.org_name || d?.proposals[0]?.org_name || null;
  const empty =
    d && d.invoices.length === 0 && d.projects.length === 0 &&
    d.proposals.length === 0 && d.contracts.length === 0;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="flex items-start justify-between">
        <div>
          {orgName && (
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{orgName}</p>
          )}
          <h1 className="text-xl font-semibold text-slate-900">Your client portal</h1>
          <p className="mt-0.5 text-xs text-slate-400">{session.user.email}</p>
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => void supabase.auth.signOut().then(() => window.location.reload())}
        >
          Sign out
        </button>
      </header>

      {data.isLoading && <p className="text-sm text-slate-500">Loading your documents…</p>}
      {empty && (
        <p className="rounded bg-slate-50 px-4 py-3 text-sm text-slate-600">
          Nothing here yet for {session.user.email}. If you expected documents, check that your
          photographer has this exact email on file for you.
        </p>
      )}

      {d && d.proposals.filter((p) => p.status === 'sent').length > 0 && (
        <section className="card">
          <header className="border-b border-slate-100 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Awaiting your decision
            </h2>
          </header>
          <ul className="divide-y divide-slate-50">
            {d.proposals.filter((p) => p.status === 'sent').map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{p.title}</span>
                <span className="tabular-nums text-slate-600">{formatMoney(p.total)}</span>
                <a className="btn-primary !py-0.5 text-xs" href={`#/p/${p.share_token}`}>
                  Review & accept
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && d.contracts.filter((c) => c.status === 'sent').length > 0 && (
        <section className="card">
          <header className="border-b border-slate-100 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Awaiting your signature
            </h2>
          </header>
          <ul className="divide-y divide-slate-50">
            {d.contracts.filter((c) => c.status === 'sent').map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{c.title}</span>
                <a className="btn-primary !py-0.5 text-xs" href={`#/c/${c.share_token}`}>
                  Read & sign
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && d.invoices.length > 0 && (
        <section className="card">
          <header className="border-b border-slate-100 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Invoices</h2>
          </header>
          <ul className="divide-y divide-slate-50">
            {d.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className={`badge ${STATUS_COLORS[i.status] ?? 'bg-slate-100 text-slate-600'}`}>
                  {i.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-800">
                  Invoice #{i.number}
                  {i.project_name && <span className="ml-1 text-xs text-slate-400">· {i.project_name}</span>}
                </span>
                <span className="tabular-nums text-slate-600">
                  {Number(i.balance) > 0
                    ? <>balance <strong>{formatMoney(i.balance)}</strong></>
                    : formatMoney(i.total)}
                </span>
                <a className="btn-ghost !py-0.5 text-xs" href={`#/share/invoice/${i.share_token}`}>
                  View / print
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && d.projects.length > 0 && (
        <section className="card">
          <header className="border-b border-slate-100 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Your projects
            </h2>
          </header>
          <ul className="divide-y divide-slate-50">
            {d.projects.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className={`badge ${STATUS_COLORS[p.status] ?? 'bg-slate-100 text-slate-600'}`}>
                  {p.status}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{p.name}</span>
                {p.start_date && <span className="text-xs text-slate-400">{p.start_date}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {d && d.contracts.filter((c) => c.status === 'signed').length > 0 && (
        <section className="card">
          <header className="border-b border-slate-100 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Signed agreements
            </h2>
          </header>
          <ul className="divide-y divide-slate-50">
            {d.contracts.filter((c) => c.status === 'signed').map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-slate-800">{c.title}</span>
                <a className="btn-ghost !py-0.5 text-xs" href={`#/c/${c.share_token}`}>View</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
