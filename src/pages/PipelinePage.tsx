import { useMemo, useState } from 'react';
import {
  useCreateDeal,
  useDeleteDeal,
  usePipeline,
  useUpdateDeal,
  type Deal,
} from '../hooks/useCrm';
import { ContactPicker } from '../components/contacts/ContactPicker';
import { Modal } from '../components/Modal';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { formatMoney } from '../lib/money';

const SORT_GAP = 1024;

function DealModal({ deal, onClose }: { deal: Deal; onClose: () => void }) {
  const update = useUpdateDeal();
  const remove = useDeleteDeal();
  const toast = useToast();
  const [value, setValue] = useState(deal.estimated_value ?? '');
  const [expected, setExpected] = useState(deal.expected_date ?? '');
  const [notes, setNotes] = useState(deal.notes ?? '');
  const [lostReason, setLostReason] = useState('');

  async function patch(fields: Parameters<typeof update.mutateAsync>[0]) {
    try {
      await update.mutateAsync(fields);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <Modal open title={deal.title} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <span
            className={`badge ${
              deal.status === 'won'
                ? 'bg-emerald-100 text-emerald-800'
                : deal.status === 'lost'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-blue-100 text-blue-800'
            }`}
          >
            {deal.status}
          </span>
          <span>{deal.contact?.name}</span>
          {deal.source && <span className="text-xs text-slate-400">via {deal.source}</span>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Estimated value (forecast)
            <input
              type="number"
              min="0"
              step="0.01"
              className="input mt-1 w-full"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={() =>
                void patch({ id: deal.id, estimated_value: value === '' ? null : Number(value) })
              }
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Expected date
            <input
              type="date"
              className="input mt-1 w-full"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              onBlur={() => void patch({ id: deal.id, expected_date: expected || null })}
            />
          </label>
        </div>
        <p className="text-xs text-slate-400">
          Forecast numbers stay forecast — nothing here touches the books until an invoice is paid.
        </p>

        <textarea
          className="input w-full"
          rows={3}
          placeholder="Notes…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => void patch({ id: deal.id, notes: notes || null })}
        />

        {deal.status === 'open' ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
            <div className="flex items-center gap-2">
              <input
                className="input w-44"
                placeholder="Lost reason (optional)"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={() =>
                  void patch({ id: deal.id, status: 'lost', lost_reason: lostReason || null }).then(
                    onClose,
                  )
                }
              >
                Mark lost
              </button>
            </div>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void patch({ id: deal.id, status: 'won' }).then(onClose)}
            >
              🎉 Mark won
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between border-t border-slate-100 pt-3">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void patch({ id: deal.id, status: 'open' }).then(onClose)}
            >
              Reopen
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() =>
                void remove
                  .mutateAsync(deal.id)
                  .then(onClose)
                  .catch((e) => toast.error(e instanceof Error ? e.message : 'Delete failed'))
              }
            >
              Delete
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function NewDealModal({ onClose }: { onClose: () => void }) {
  const create = useCreateDeal();
  const toast = useToast();
  const [contactId, setContactId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [expected, setExpected] = useState('');

  async function submit() {
    if (!contactId || !title.trim()) {
      toast.error('A deal needs a contact and a title');
      return;
    }
    try {
      await create.mutateAsync({
        contact_id: contactId,
        title: title.trim(),
        estimated_value: value === '' ? null : Number(value),
        expected_date: expected || null,
      });
      toast.success('Deal created');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the deal');
    }
  }

  return (
    <Modal open title="New deal" onClose={onClose}>
      <div className="space-y-3">
        <ContactPicker value={contactId} onChange={(id) => setContactId(id)} />
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Title
          <input
            className="input mt-1 w-full"
            placeholder="Wedding — September"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Estimated value (forecast)
            <input
              type="number"
              min="0"
              step="0.01"
              className="input mt-1 w-full"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Expected date
            <input
              type="date"
              className="input mt-1 w-full"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={create.isPending}
            onClick={() => void submit()}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The sales board: stages as columns, deals as draggable cards. */
export function PipelinePage() {
  const pipeline = usePipeline();
  const update = useUpdateDeal();
  const { canEdit } = useAuth();
  const toast = useToast();
  const [openDeal, setOpenDeal] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const stages = pipeline.data?.stages ?? [];
  const deals = useMemo(() => pipeline.data?.deals ?? [], [pipeline.data?.deals]);
  const open = deals.filter((d) => d.status === 'open');
  const closed = deals.filter((d) => d.status !== 'open');
  const current = deals.find((d) => d.id === openDeal) ?? null;

  async function handleDrop(stageId: string, e: React.DragEvent) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/deal-id');
    if (!id) return;
    const column = open.filter((d) => d.stage_id === stageId);
    try {
      await update.mutateAsync({
        id,
        stage_id: stageId,
        sort_order: (column.at(-1)?.sort_order ?? 0) + SORT_GAP,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Move failed');
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Pipeline</h1>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Hide' : 'Show'} won/lost ({closed.length})
          </button>
          {canEdit && (
            <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
              + Deal
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {stages.map((stage) => {
          const items = open.filter((d) => d.stage_id === stage.id);
          const forecast = items.reduce((a, d) => a + Number(d.estimated_value ?? 0), 0);
          return (
            <div
              key={stage.id}
              className="rounded bg-slate-50 p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void handleDrop(stage.id, e)}
            >
              <h3 className="mb-2 flex items-baseline justify-between px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <span>
                  {stage.name} ({items.length})
                </span>
                {forecast > 0 && (
                  <span className="font-normal normal-case text-slate-400">
                    {formatMoney(forecast)} forecast
                  </span>
                )}
              </h3>
              <div className="space-y-2">
                {items.map((d) => (
                  <div
                    key={d.id}
                    draggable={canEdit}
                    onDragStart={(e) => e.dataTransfer.setData('text/deal-id', d.id)}
                    onClick={() => setOpenDeal(d.id)}
                    role="button"
                    className="cursor-pointer rounded border border-slate-200 bg-white p-2 text-sm shadow-sm hover:border-slate-300"
                  >
                    <p className="font-medium text-slate-800">{d.title}</p>
                    <p className="mt-0.5 flex items-center justify-between text-xs text-slate-400">
                      <span>{d.contact?.name}</span>
                      {d.estimated_value && <span>{formatMoney(d.estimated_value)}</span>}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {showClosed && closed.length > 0 && (
        <section className="card">
          <header className="border-b border-slate-100 px-4 py-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Won & lost
            </h2>
          </header>
          <ul className="divide-y divide-slate-50">
            {closed.map((d) => (
              <li
                key={d.id}
                className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm hover:bg-slate-50"
                onClick={() => setOpenDeal(d.id)}
              >
                <span
                  className={`badge ${
                    d.status === 'won' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'
                  }`}
                >
                  {d.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-800">{d.title}</span>
                <span className="text-xs text-slate-400">{d.contact?.name}</span>
                {d.estimated_value && (
                  <span className="tabular-nums text-slate-500">{formatMoney(d.estimated_value)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {current && <DealModal deal={current} onClose={() => setOpenDeal(null)} />}
      {creating && <NewDealModal onClose={() => setCreating(false)} />}
    </div>
  );
}
