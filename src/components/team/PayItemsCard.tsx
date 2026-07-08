import { useState } from 'react';
import {
  usePayItemsForProject,
  useUpdatePayItem,
  useApprovePayItem,
  useVoidPayItem,
  type PayItemWithMember,
} from '../../hooks/useTeam';
import { useToast } from '../../providers/ToastProvider';
import { formatMoney } from '../../lib/money';
import type { PayItemStatus } from '../../types/database';

const STATUS_BADGES: Record<PayItemStatus, string> = {
  draft: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  void: 'bg-slate-100 text-slate-500',
};

function DraftAmount({
  item,
  disabled,
}: {
  item: PayItemWithMember;
  disabled: boolean;
}) {
  const [value, setValue] = useState(item.amount);
  const update = useUpdatePayItem();
  const toast = useToast();

  async function commit() {
    const next = Number(value);
    if (!Number.isFinite(next) || next < 0) {
      setValue(item.amount);
      return;
    }
    if (next === Number(item.amount)) return;
    try {
      await update.mutateAsync({ id: item.id, amount: next.toFixed(2) });
    } catch (e) {
      setValue(item.amount);
      toast.error(e instanceof Error ? e.message : 'Could not update pay');
    }
  }

  return (
    <input
      type="number"
      min="0"
      step="0.01"
      className="input w-28 text-right"
      value={value}
      disabled={disabled || update.isPending}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      aria-label="Pay amount"
    />
  );
}

/**
 * Team pay for one project: the draft → approve → posted flow that replaced
 * the auto-created $0 "Photographer Pay" expense rows. Approving posts the
 * balanced journal entry (Team Pay / Accounts Payable); voiding reverses it.
 */
export function PayItemsCard({
  projectId,
  canEdit,
  isAdmin,
}: {
  projectId: string;
  canEdit: boolean;
  isAdmin: boolean;
}) {
  const payItems = usePayItemsForProject(projectId);
  const approve = useApprovePayItem();
  const voidPay = useVoidPayItem();
  const toast = useToast();

  const items = payItems.data ?? [];
  if (payItems.isLoading || items.length === 0) return null;

  async function handleApprove(item: PayItemWithMember) {
    try {
      await approve.mutateAsync(item.id);
      toast.success(`Approved pay for ${item.team_member?.display_name ?? 'member'}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Approve failed');
    }
  }

  async function handleVoid(item: PayItemWithMember) {
    try {
      await voidPay.mutateAsync(item.id);
      toast.success('Pay item voided (journal entry reversed)');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Void failed');
    }
  }

  return (
    <section className="card">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Photographer Pay
        </h2>
        <span className="text-xs text-slate-400">
          drafts post to the ledger only when approved
        </span>
      </header>
      <ul className="divide-y divide-slate-100">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
            <span className={`badge ${STATUS_BADGES[item.status]}`}>{item.status}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
              {item.team_member?.display_name ?? item.description}
              <span className="ml-2 text-xs text-slate-400">{item.pay_date}</span>
            </span>
            {item.status === 'draft' ? (
              <DraftAmount item={item} disabled={!canEdit} />
            ) : (
              <span className="text-sm font-medium tabular-nums">{formatMoney(item.amount)}</span>
            )}
            {isAdmin && item.status === 'draft' && (
              <button
                type="button"
                className="btn-primary"
                disabled={approve.isPending}
                onClick={() => void handleApprove(item)}
              >
                Approve
              </button>
            )}
            {isAdmin && item.status === 'approved' && (
              <button
                type="button"
                className="btn-ghost"
                disabled={voidPay.isPending}
                onClick={() => void handleVoid(item)}
              >
                Void
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
