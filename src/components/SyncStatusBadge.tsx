import { useSyncContext } from '../providers/SyncProvider';

export function SyncStatusBadge() {
  const { isOnline, isSyncing, pendingCount, lastSyncAt, triggerSync } = useSyncContext();

  return (
    <div className="flex items-center gap-1.5 text-xs">
      {/* Online / offline dot */}
      <span
        className={`h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-amber-400'}`}
        title={isOnline ? 'Online' : 'Offline — changes saved locally'}
      />

      {/* Status label */}
      {isSyncing ? (
        <span className="text-slate-500">Syncing…</span>
      ) : !isOnline ? (
        <span className="font-medium text-amber-600">Offline</span>
      ) : lastSyncAt ? (
        <span className="text-slate-400">Synced</span>
      ) : null}

      {/* Pending badge */}
      {pendingCount > 0 && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">
          {pendingCount} pending
        </span>
      )}

      {/* Manual sync button (only when online + something pending) */}
      {isOnline && pendingCount > 0 && !isSyncing && (
        <button
          type="button"
          onClick={() => void triggerSync()}
          className="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          title="Push pending changes to Supabase now"
        >
          ↑ Sync now
        </button>
      )}
    </div>
  );
}
