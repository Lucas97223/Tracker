// Global type for the IPC bridge exposed by electron/preload.cjs via contextBridge.
// Only present when running inside Electron; undefined in plain web/test environments.

interface ElectronDB {
  query:          (table: string, filters: Record<string, unknown>) => Promise<unknown[]>;
  get:            (table: string, id: string) => Promise<unknown | null>;
  upsert:         (table: string, row: Record<string, unknown>) => Promise<unknown>;
  upsertMany:     (table: string, rows: Record<string, unknown>[]) => Promise<void>;
  delete:         (table: string, id: string) => Promise<void>;
  enqueue:        (table: string, recordId: string, operation: string, payload: unknown) => Promise<void>;
  getQueue:       () => Promise<import('./localDb').SyncQueueItem[]>;
  removeFromQueue:(id: number) => Promise<void>;
  markQueueError: (id: number, err: string) => Promise<void>;
  getConflicts:   () => Promise<import('./localDb').ConflictItem[]>;
  resolveConflict:(id: number, resolution: string) => Promise<void>;
  addConflict:    (table: string, recordId: string, local: unknown, remote: unknown) => Promise<number>;
  getCache:       (key: string) => Promise<{ data: unknown; cached_at: string } | null>;
  setCache:       (key: string, data: unknown) => Promise<void>;
  getMeta:        (key: string) => Promise<string | null>;
  setMeta:        (key: string, value: string) => Promise<void>;
}

declare global {
  interface Window {
    electronDB?: ElectronDB;
  }
}

export {};
