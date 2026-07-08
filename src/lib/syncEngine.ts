// Flushes the offline sync queue to Supabase.
// Runs in the renderer so it can reuse the authenticated Supabase client.

import { supabase } from './supabase';
import { localDb } from './localDb';

export interface SyncResult {
  synced: number;
  conflicts: number;
  errors: number;
}

export async function flushSyncQueue(): Promise<SyncResult> {
  const queue = await localDb.getQueue();
  if (queue.length === 0) return { synced: 0, conflicts: 0, errors: 0 };

  let synced = 0;
  let conflicts = 0;
  let errors = 0;

  for (const item of queue) {
    const payload = JSON.parse(item.payload) as Record<string, unknown>;

    try {
      if (item.operation === 'insert') {
        // upsert so a duplicate push after partial failure is safe
        const { error } = await supabase
          .from(item.table_name as never)
          .upsert(payload as never, { onConflict: 'id' });
        if (error) throw error;
        await localDb.removeFromQueue(item.id);
        synced++;

      } else if (item.operation === 'update') {
        // For expenses we can detect conflicts via updated_at.
        if (item.table_name === 'expenses') {
          const { data: remote } = await supabase
            .from('expenses')
            .select('*')
            .eq('id', item.record_id)
            .maybeSingle();

          if (remote && remote.updated_at) {
            const remoteMs  = new Date(remote.updated_at as string).getTime();
            const queuedMs  = new Date(item.queued_at).getTime();
            if (remoteMs > queuedMs) {
              // Someone else saved a newer version while we were offline.
              await localDb.addConflict(item.table_name, item.record_id, payload, remote);
              await localDb.removeFromQueue(item.id);
              conflicts++;
              continue;
            }
          }
        }

        // No conflict (or non-expense table) — push local version.
        // Strip read-only / meta fields before sending to Supabase.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { id, created_at, created_by, ...patch } = payload;
        const { error } = await supabase
          .from(item.table_name as never)
          .update(patch as never)
          .eq('id', item.record_id);
        if (error) throw error;
        await localDb.removeFromQueue(item.id);
        synced++;

      } else if (item.operation === 'delete') {
        const { error } = await supabase
          .from(item.table_name as never)
          .delete()
          .eq('id', item.record_id);
        if (error) throw error;
        await localDb.removeFromQueue(item.id);
        synced++;
      }
    } catch (err) {
      await localDb.markQueueError(item.id, String(err));
      errors++;
    }
  }

  return { synced, conflicts, errors };
}
