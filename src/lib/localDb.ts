// Typed renderer-side wrapper for the window.electronDB IPC bridge.
// All methods are no-ops when running outside Electron (tests, plain web).

import type { Year, Project, Expense, Category, Profile, Account } from '../types/database';

export type SyncOperation = 'insert' | 'update' | 'delete';

export interface SyncQueueItem {
  id: number;
  table_name: string;
  record_id: string;
  operation: SyncOperation;
  payload: string;
  queued_at: string;
  attempts: number;
  last_error: string | null;
}

export interface ConflictItem {
  id: number;
  table_name: string;
  record_id: string;
  local_data: Record<string, unknown>;
  remote_data: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

export const isElectron = typeof window !== 'undefined' && typeof window.electronDB !== 'undefined';

const b = () => window.electronDB!;

export const localDb = {
  // Reads
  queryYears:      ():                   Promise<Year[]>       => isElectron ? b().query('years', {})                        .then(r => r as Year[])       : Promise.resolve([]),
  queryProjects:   (yearId?: string):    Promise<Project[]>    => isElectron ? b().query('projects', yearId ? { year_id: yearId } : {}).then(r => r as Project[])  : Promise.resolve([]),
  queryProjectById:(id: string):         Promise<Project|null> => isElectron ? b().get('projects', id)                       .then(r => r as Project|null) : Promise.resolve(null),
  queryExpenses:   (projectId: string):  Promise<Expense[]>    => isElectron ? b().query('expenses', { project_id: projectId }).then(r => r as Expense[])  : Promise.resolve([]),
  queryAllExpenses:():                   Promise<Expense[]>    => isElectron ? b().query('expenses', {})                     .then(r => r as Expense[])    : Promise.resolve([]),
  queryCategories: ():                   Promise<Category[]>   => isElectron ? b().query('categories', {})                   .then(r => r as Category[])   : Promise.resolve([]),
  queryProfiles:   ():                   Promise<Profile[]>    => isElectron ? b().query('profiles', {})                     .then(r => r as Profile[])    : Promise.resolve([]),
  queryAccounts:   ():                   Promise<Account[]>    => isElectron ? b().query('accounts', {})                     .then(r => r as Account[])    : Promise.resolve([]),
  getExpense:      (id: string):         Promise<Expense|null> => isElectron ? b().get('expenses', id)                       .then(r => r as Expense|null) : Promise.resolve(null),

  // Writes
  upsertYear:      (row: Year):     Promise<Year>     => isElectron ? b().upsert('years',      row as unknown as Record<string,unknown>).then(r => r as Year)     : Promise.resolve(row),
  upsertProject:   (row: Project):  Promise<Project>  => isElectron ? b().upsert('projects',   row as unknown as Record<string,unknown>).then(r => r as Project)  : Promise.resolve(row),
  upsertExpense:   (row: Expense):  Promise<Expense>  => isElectron ? b().upsert('expenses',   row as unknown as Record<string,unknown>).then(r => r as Expense)  : Promise.resolve(row),
  upsertCategory:  (row: Category): Promise<Category> => isElectron ? b().upsert('categories', row as unknown as Record<string,unknown>).then(r => r as Category) : Promise.resolve(row),
  upsertProfile:   (row: Profile):  Promise<Profile>  => isElectron ? b().upsert('profiles',   row as unknown as Record<string,unknown>).then(r => r as Profile)  : Promise.resolve(row),
  upsertAccount:   (row: Account):  Promise<Account>  => isElectron ? b().upsert('accounts',   row as unknown as Record<string,unknown>).then(r => r as Account)  : Promise.resolve(row),

  upsertManyYears:      (rows: Year[]):     Promise<void> => isElectron ? b().upsertMany('years',      rows as unknown as Record<string,unknown>[]) : Promise.resolve(),
  upsertManyProjects:   (rows: Project[]):  Promise<void> => isElectron ? b().upsertMany('projects',   rows as unknown as Record<string,unknown>[]) : Promise.resolve(),
  upsertManyExpenses:   (rows: Expense[]):  Promise<void> => isElectron ? b().upsertMany('expenses',   rows as unknown as Record<string,unknown>[]) : Promise.resolve(),
  upsertManyCategories: (rows: Category[]): Promise<void> => isElectron ? b().upsertMany('categories', rows as unknown as Record<string,unknown>[]) : Promise.resolve(),
  upsertManyProfiles:   (rows: Profile[]):  Promise<void> => isElectron ? b().upsertMany('profiles',   rows as unknown as Record<string,unknown>[]) : Promise.resolve(),
  upsertManyAccounts:   (rows: Account[]):  Promise<void> => isElectron ? b().upsertMany('accounts',   rows as unknown as Record<string,unknown>[]) : Promise.resolve(),

  deleteExpense: (id: string): Promise<void> => isElectron ? b().delete('expenses', id) : Promise.resolve(),
  deleteProject: (id: string): Promise<void> => isElectron ? b().delete('projects', id) : Promise.resolve(),
  deleteYear:    (id: string): Promise<void> => isElectron ? b().delete('years',    id) : Promise.resolve(),

  // Sync queue
  enqueue:         (table: string, recordId: string, op: SyncOperation, payload: unknown): Promise<void> =>
    isElectron ? b().enqueue(table, recordId, op, payload) : Promise.resolve(),
  getQueue:        (): Promise<SyncQueueItem[]> => isElectron ? b().getQueue() as Promise<SyncQueueItem[]> : Promise.resolve([]),
  removeFromQueue: (id: number): Promise<void>  => isElectron ? b().removeFromQueue(id)    : Promise.resolve(),
  markQueueError:  (id: number, err: string): Promise<void> => isElectron ? b().markQueueError(id, err) : Promise.resolve(),

  // Conflicts
  getConflicts:   (): Promise<ConflictItem[]> => isElectron ? b().getConflicts() as Promise<ConflictItem[]> : Promise.resolve([]),
  resolveConflict:(id: number, resolution: 'kept_local' | 'kept_remote'): Promise<void> =>
    isElectron ? b().resolveConflict(id, resolution) : Promise.resolve(),
  addConflict:    (table: string, recordId: string, local: unknown, remote: unknown): Promise<number> =>
    isElectron ? b().addConflict(table, recordId, local, remote) as Promise<number> : Promise.resolve(-1),

  // View cache
  getCache: <T>(key: string): Promise<{ data: T; cached_at: string } | null> =>
    isElectron ? b().getCache(key).then(r => r as { data: T; cached_at: string } | null) : Promise.resolve(null),
  setCache: (key: string, data: unknown): Promise<void> =>
    isElectron ? b().setCache(key, data) : Promise.resolve(),

  // Meta
  getMeta: (key: string): Promise<string | null> => isElectron ? b().getMeta(key) : Promise.resolve(null),
  setMeta: (key: string, value: string): Promise<void> => isElectron ? b().setMeta(key, value) : Promise.resolve(),
};
