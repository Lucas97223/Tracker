import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCatalog,
  useCreateProposal,
  useProposals,
  useUnwinProposal,
  useUpdateProposal,
  useWinProposal,
  type Proposal,
} from '../hooks/useSell';
import { useTaskTemplates } from '../hooks/useTasks';
import { usePipeline } from '../hooks/useCrm';
import { PROJECT_TYPE_SUGGESTIONS } from '../hooks/useProjects';
import { ContactPicker } from '../components/contacts/ContactPicker';
import { Modal } from '../components/Modal';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { formatMoney } from '../lib/money';

const STATUS_BADGES: Record<Proposal['status'], string> = {
  draft: 'bg-slate-100 text-slate-600',
  sent: 'bg-blue-100 text-blue-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  declined: 'bg-red-100 text-red-700',
  expired: 'bg-amber-100 text-amber-800',
};

interface DraftLine {
  key: number;
  catalog_item_id: string | null;
  description: string;
  qty: number;
  unit_price: number;
}

function NewProposalModal({ onClose }: { onClose: () => void }) {
  const create = useCreateProposal();
  const catalog = useCatalog();
  const templates = useTaskTemplates();
  const proposals = useProposals();
  const pipeline = usePipeline();
  const toast = useToast();
  const [contactId, setContactId] = useState<string | null>(null);
  const [dealId, setDealId] = useState('');
  const [title, setTitle] = useState('');
  const [projectType, setProjectType] = useState('');
  const [depositPct, setDepositPct] = useState('50');
  const [validUntil, setValidUntil] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);

  const items = (catalog.data ?? []).filter((i) => i.is_active);

  const subtotal = useMemo(
    () => lines.reduce((a, l) => a + Math.round(l.qty * l.unit_price * 100) / 100, 0),
    [lines],
  );
  const estCost = useMemo(() => {
    const m = new Map(items.map((i) => [i.id, Number(i.estimated_cost ?? 0)]));
    return lines.reduce((a, l) => a + (l.catalog_item_id ? m.get(l.catalog_item_id) ?? 0 : 0) * l.qty, 0);
  }, [lines, items]);

  // The guardrail: this quote vs. history for the same project type.
  const history = useMemo(() => {
    const t = (projectType || 'Untyped').trim() || 'Untyped';
    return (proposals.data?.typeCosts ?? []).find(
      (c) => c.project_type.toLowerCase() === t.toLowerCase(),
    );
  }, [proposals.data?.typeCosts, projectType]);

  function addFromCatalog(id: string) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    setLines((ls) => [
      ...ls,
      {
        key: Math.max(0, ...ls.map((x) => x.key)) + 1,
        catalog_item_id: item.id,
        description: item.name,
        qty: Number(item.default_qty),
        unit_price: Number(item.unit_price),
      },
    ]);
  }

  async function submit() {
    if (!contactId || !title.trim() || lines.length === 0) {
      toast.error('A proposal needs a contact, a title and at least one line');
      return;
    }
    try {
      await create.mutateAsync({
        contact_id: contactId,
        deal_id: dealId || null,
        title: title.trim(),
        project_type: projectType.trim() || null,
        deposit_pct: Number(depositPct) || 0,
        valid_until: validUntil || null,
        task_template_id: templateId || null,
        lines: lines.map((l) => ({
          catalog_item_id: l.catalog_item_id,
          description: l.description,
          qty: l.qty,
          unit_price: l.unit_price,
        })),
      });
      toast.success('Draft proposal created');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the proposal');
    }
  }

  const marginPct = subtotal > 0 ? Math.round(((subtotal - estCost) / subtotal) * 100) : null;

  return (
    <Modal open title="New proposal" onClose={onClose} size="lg">
      <div className="space-y-3">
        <ContactPicker value={contactId} onChange={(id) => { setContactId(id); setDealId(''); }} />
        {contactId && (pipeline.data?.deals ?? []).some((d) => d.contact_id === contactId && d.status === 'open') && (
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Link an open deal (won on acceptance)
            <select className="input mt-1 w-full" value={dealId} onChange={(e) => setDealId(e.target.value)}>
              <option value="">No deal</option>
              {(pipeline.data?.deals ?? [])
                .filter((d) => d.contact_id === contactId && d.status === 'open')
                .map((d) => (
                  <option key={d.id} value={d.id}>{d.title}</option>
                ))}
            </select>
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Title
            <input className="input mt-1 w-full" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Project type
            <input
              className="input mt-1 w-full"
              list="proposal-type-suggestions"
              value={projectType}
              onChange={(e) => setProjectType(e.target.value)}
            />
            <datalist id="proposal-type-suggestions">
              {PROJECT_TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
            </datalist>
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Deposit %
            <input
              type="number" min="0" max="100"
              className="input mt-1 w-full"
              value={depositPct}
              onChange={(e) => setDepositPct(e.target.value)}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Valid until
            <input type="date" className="input mt-1 w-full" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </label>
          <label className="col-span-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Task template applied on win
            <select className="input mt-1 w-full" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">None</option>
              {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lines</p>
            <select className="input w-56 !py-1 text-xs" value="" onChange={(e) => e.target.value && addFromCatalog(e.target.value)}>
              <option value="">+ Add from catalog…</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>{i.name} — {formatMoney(i.unit_price)}</option>
              ))}
            </select>
          </div>
          {lines.length === 0 && <p className="text-sm text-slate-400">Pick items from the catalog.</p>}
          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-2">
                <input
                  className="input min-w-0 flex-1"
                  value={l.description}
                  onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, description: e.target.value } : x)))}
                />
                <input
                  type="number" min="0.25" step="0.25"
                  className="input w-20 text-right"
                  value={l.qty}
                  onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, qty: Number(e.target.value) } : x)))}
                />
                <input
                  type="number" min="0" step="0.01"
                  className="input w-28 text-right"
                  value={l.unit_price}
                  onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unit_price: Number(e.target.value) } : x)))}
                />
                <button type="button" className="btn-ghost !px-2" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</button>
              </div>
            ))}
          </div>
        </div>

        {/* The margin guardrail */}
        {subtotal > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded bg-slate-50 px-3 py-2 text-sm">
            <span>Quote <strong>{formatMoney(subtotal)}</strong></span>
            {estCost > 0 && (
              <span className={`badge ${marginPct !== null && marginPct < 30 ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-800'}`}>
                est. margin {marginPct}%
              </span>
            )}
            {history && Number(history.avg_cost) > 0 && (
              <span
                className={`badge ${subtotal < Number(history.avg_cost) ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}
                title={`Across ${history.projects} past ${history.project_type} project(s): avg real cost ${formatMoney(history.avg_cost)}, avg revenue ${formatMoney(history.avg_revenue)}`}
              >
                {subtotal < Number(history.avg_cost)
                  ? `⚠ below avg real cost for ${history.project_type} (${formatMoney(history.avg_cost)})`
                  : `history: ${history.project_type} avg cost ${formatMoney(history.avg_cost)}`}
              </span>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={create.isPending} onClick={() => void submit()}>
            Create draft
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ProposalsPage() {
  const { canEdit, isAdmin } = useAuth();
  const data = useProposals();
  const update = useUpdateProposal();
  const win = useWinProposal();
  const unwin = useUnwinProposal();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  function shareUrl(p: Proposal) {
    return `${window.location.origin}${window.location.pathname}#/p/${p.share_token}`;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Proposals</h1>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>+ Proposal</button>
        )}
      </header>

      {(data.data?.proposals ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">
          No proposals yet. When a client accepts one, the project, contract, deposit invoice and
          won deal are all created in a single step.
        </p>
      ) : (
        <div className="card divide-y divide-slate-50">
          {(data.data?.proposals ?? []).map((p) => {
            const totals = data.data?.totals.get(p.id);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className={`badge ${STATUS_BADGES[p.status]}`}>{p.status}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-slate-800">{p.title}</span>
                  <span className="ml-2 text-xs text-slate-400">{p.contact?.name}</span>
                </span>
                {totals && <span className="tabular-nums text-slate-600">{formatMoney(totals.total)}</span>}
                {p.status === 'draft' && canEdit && (
                  <button
                    type="button"
                    className="btn-primary !py-0.5 text-xs"
                    onClick={() =>
                      void update.mutateAsync({ id: p.id, status: 'sent' })
                        .then(() => toast.success('Proposal marked sent — share the link'))
                        .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                    }
                  >
                    Mark sent
                  </button>
                )}
                {p.status !== 'draft' && (
                  <>
                    <button
                      type="button"
                      className="btn-ghost !py-0.5 text-xs"
                      onClick={() =>
                        void navigator.clipboard.writeText(shareUrl(p))
                          .then(() => toast.success('Client link copied'))
                      }
                    >
                      Copy link
                    </button>
                    <a className="btn-ghost !py-0.5 text-xs" href={shareUrl(p)} target="_blank" rel="noreferrer">
                      Preview
                    </a>
                  </>
                )}
                {p.status === 'sent' && canEdit && (
                  <button
                    type="button"
                    className="btn-ghost !py-0.5 text-xs"
                    title="Client accepted outside the app — run the win"
                    onClick={() =>
                      void win.mutateAsync(p.id)
                        .then(() => toast.success('Won — project, contract and deposit invoice created'))
                        .catch((e) => toast.error(e instanceof Error ? e.message : 'Win failed'))
                    }
                  >
                    🎉 Win
                  </button>
                )}
                {p.status === 'accepted' && p.project_id && (
                  <Link to={`/projects/${p.project_id}`} className="text-xs text-brand-700 hover:underline">
                    open project →
                  </Link>
                )}
                {p.status === 'accepted' && isAdmin && (
                  <button
                    type="button"
                    className="btn-ghost !py-0.5 text-xs"
                    onClick={() =>
                      void unwin.mutateAsync(p.id)
                        .then(() => toast.success('Un-won — proposal reopened'))
                        .catch((e) => toast.error(e instanceof Error ? e.message : 'Un-win refused'))
                    }
                  >
                    Un-win
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {creating && <NewProposalModal onClose={() => setCreating(false)} />}
    </div>
  );
}
