import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { localDb, type ConflictItem } from '../lib/localDb';
import { useSyncContext } from '../providers/SyncProvider';
import { useQueryClient } from '@tanstack/react-query';

const AUTO_RESOLVE_SECS = 30;

function ConflictRow({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-28 shrink-0 font-medium text-slate-500">{label}</span>
      <span className="text-slate-800">{String(value)}</span>
    </div>
  );
}

function SingleConflictDialog({ conflict, onDone }: { conflict: ConflictItem; onDone: () => void }) {
  const [countdown, setCountdown] = useState(AUTO_RESOLVE_SECS);
  const [busy, setBusy] = useState(false);
  const { refreshConflicts } = useSyncContext();
  const qc = useQueryClient();

  useEffect(() => {
    const id = window.setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          clearInterval(id);
          void resolve('kept_remote');
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function resolve(choice: 'kept_local' | 'kept_remote') {
    if (busy) return;
    setBusy(true);
    try {
      if (choice === 'kept_local') {
        // Push local_data to Supabase, overwriting the remote version.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id, created_at, created_by, ...patch } = conflict.local_data as Record<string, unknown>;
        await supabase
          .from(conflict.table_name as never)
          .update(patch as never)
          .eq('id', conflict.record_id);
        // Update local cache with what we just pushed.
        await localDb.upsertExpense(conflict.local_data as never);
      } else {
        // Keep remote: overwrite local SQLite with the remote version.
        await localDb.upsertExpense(conflict.remote_data as never);
      }
      await localDb.resolveConflict(conflict.id, choice);
      await refreshConflicts();
      await qc.invalidateQueries({ queryKey: ['expenses'] });
    } finally {
      setBusy(false);
      onDone();
    }
  }

  const local  = conflict.local_data  as Record<string, unknown>;
  const remote = conflict.remote_data as Record<string, unknown>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-2xl">
        <h2 className="mb-1 text-base font-semibold text-slate-900">Sync conflict detected</h2>
        <p className="mb-4 text-sm text-slate-500">
          A record was edited while you were offline AND updated by someone else in the cloud.
          The <strong>remote version wins by default</strong> — choose "Keep mine" to override.
          Auto-resolving to remote in <strong className="text-amber-600">{countdown}s</strong>.
        </p>

        <div className="grid grid-cols-2 gap-4 rounded-lg border border-slate-200 p-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Your offline version</p>
            <div className="space-y-1">
              <ConflictRow label="description"    value={local.description} />
              <ConflictRow label="amount"         value={local.amount} />
              <ConflictRow label="date"           value={local.expense_date} />
              <ConflictRow label="category"       value={local.category_id} />
              <ConflictRow label="notes"          value={local.notes} />
              <ConflictRow label="last modified"  value={local.updated_at} />
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-600">Remote version (will win)</p>
            <div className="space-y-1">
              <ConflictRow label="description"    value={remote.description} />
              <ConflictRow label="amount"         value={remote.amount} />
              <ConflictRow label="date"           value={remote.expense_date} />
              <ConflictRow label="category"       value={remote.category_id} />
              <ConflictRow label="notes"          value={remote.notes} />
              <ConflictRow label="last modified"  value={remote.updated_at} />
            </div>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolve('kept_local')}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Keep mine (overwrite remote)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void resolve('kept_remote')}
            className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Keep remote ({countdown}s)
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConflictDialog() {
  const { conflicts } = useSyncContext();
  const [idx, setIdx] = useState(0);

  useEffect(() => { setIdx(0); }, [conflicts]);

  const current = conflicts[idx];
  if (!current || conflicts.length === 0) return null;
  return <SingleConflictDialog conflict={current} onDone={() => setIdx(i => i + 1)} />;
}
