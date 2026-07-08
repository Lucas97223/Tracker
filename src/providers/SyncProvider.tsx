import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { localDb, type ConflictItem } from '../lib/localDb';
import { flushSyncQueue } from '../lib/syncEngine';

interface SyncState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  conflicts: ConflictItem[];
  lastSyncAt: Date | null;
  triggerSync: () => void;
  refreshConflicts: () => Promise<void>;
}

const SyncContext = createContext<SyncState | undefined>(undefined);

export function SyncProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [isOnline,     setIsOnline]     = useState(navigator.onLine);
  const [isSyncing,    setIsSyncing]    = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [conflicts,    setConflicts]    = useState<ConflictItem[]>([]);
  const [lastSyncAt,   setLastSyncAt]   = useState<Date | null>(null);
  const syncingRef = useRef(false);

  const refreshState = useCallback(async () => {
    const [queue, unresolvedConflicts] = await Promise.all([
      localDb.getQueue(),
      localDb.getConflicts(),
    ]);
    setPendingCount(queue.length);
    setConflicts(unresolvedConflicts);
  }, []);

  const triggerSync = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    syncingRef.current = true;
    setIsSyncing(true);
    try {
      await flushSyncQueue();
      setLastSyncAt(new Date());
      await refreshState();
      // Invalidate all query keys so the UI refetches fresh data from Supabase.
      await qc.invalidateQueries();
    } catch (err) {
      console.error('[sync] flush failed:', err);
    } finally {
      syncingRef.current = false;
      setIsSyncing(false);
    }
  }, [qc, refreshState]);

  // Online / offline events
  useEffect(() => {
    const goOnline  = () => { setIsOnline(true);  void triggerSync(); };
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online',  goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online',  goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [triggerSync]);

  // Refresh pending count every 10 s
  useEffect(() => {
    void refreshState();
    const id = window.setInterval(() => void refreshState(), 10_000);
    return () => window.clearInterval(id);
  }, [refreshState]);

  return (
    <SyncContext.Provider
      value={{
        isOnline,
        isSyncing,
        pendingCount,
        conflicts,
        lastSyncAt,
        triggerSync,
        refreshConflicts: refreshState,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useSyncContext(): SyncState {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSyncContext must be used inside SyncProvider');
  return ctx;
}
