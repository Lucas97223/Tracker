'use strict';
// Preload script: exposes the SQLite IPC bridge to the renderer via contextBridge.
// Runs in a sandboxed context — only ipcRenderer and contextBridge are available.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronDB', {
  // Table reads / writes
  query:          (table, filters)                      => ipcRenderer.invoke('db:query',           table, filters),
  get:            (table, id)                           => ipcRenderer.invoke('db:get',             table, id),
  upsert:         (table, row)                          => ipcRenderer.invoke('db:upsert',          table, row),
  upsertMany:     (table, rows)                         => ipcRenderer.invoke('db:upsert-many',     table, rows),
  delete:         (table, id)                           => ipcRenderer.invoke('db:delete',          table, id),

  // Sync queue
  enqueue:        (table, recordId, operation, payload) => ipcRenderer.invoke('db:enqueue',         table, recordId, operation, payload),
  getQueue:       ()                                    => ipcRenderer.invoke('db:get-queue'),
  removeFromQueue:(id)                                  => ipcRenderer.invoke('db:remove-from-queue', id),
  markQueueError: (id, err)                             => ipcRenderer.invoke('db:mark-queue-error',  id, err),

  // Conflict log
  getConflicts:   ()                                    => ipcRenderer.invoke('db:get-conflicts'),
  resolveConflict:(id, resolution)                      => ipcRenderer.invoke('db:resolve-conflict', id, resolution),
  addConflict:    (table, recordId, local, remote)      => ipcRenderer.invoke('db:add-conflict',     table, recordId, local, remote),

  // View cache
  getCache:       (key)                                 => ipcRenderer.invoke('db:get-cache',  key),
  setCache:       (key, data)                           => ipcRenderer.invoke('db:set-cache',  key, data),

  // Meta
  getMeta:        (key)                                 => ipcRenderer.invoke('db:get-meta',   key),
  setMeta:        (key, value)                          => ipcRenderer.invoke('db:set-meta',   key, value),
});
