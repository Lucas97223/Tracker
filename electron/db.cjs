'use strict';
// Local SQLite database for offline-first support.
// All writes use INSERT OR REPLACE so incoming Supabase sync data and
// offline mutations can both be applied safely without conflicts.

const path = require('node:path');

let _db = null;

function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  const { app } = require('electron');
  const dbPath = path.join(app.getPath('userData'), 'expense-tracker-local.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _applySchema(_db);
  _migrateSchema(_db);
  return _db;
}

// Additive column migrations for local DBs created before a column existed.
// CREATE TABLE IF NOT EXISTS won't touch existing tables, so each new remote
// column must be retrofitted here or upserts of synced rows will fail.
function _migrateSchema(db) {
  const addColumns = [
    ['years',      'org_id TEXT'],
    ['projects',   'org_id TEXT'],
    ['expenses',   'org_id TEXT'],
    ['categories', 'org_id TEXT'],
    ['accounts',   'org_id TEXT'],
    ['profiles',   'default_org_id TEXT'],
  ];
  for (const [table, ddl] of addColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e.message))) throw e;
    }
  }
}

function _applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS years (
      id TEXT PRIMARY KEY,
      year_value INTEGER NOT NULL,
      label TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      _synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      year_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      client TEXT,
      location TEXT,
      project_type TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      start_date TEXT,
      end_date TEXT,
      client_paid TEXT NOT NULL DEFAULT '0.00',
      photographers TEXT NOT NULL DEFAULT '[]',
      collection_details TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      _synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      description TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      expense_date TEXT NOT NULL,
      location TEXT,
      vendor TEXT,
      payment_method TEXT,
      receipt_url TEXT,
      notes TEXT,
      person_name TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      _synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT NOT NULL DEFAULT '#64748b',
      is_archived INTEGER NOT NULL DEFAULT 0,
      account_id TEXT,
      created_at TEXT NOT NULL,
      _synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      full_name TEXT,
      role TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      _synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      normal_balance TEXT NOT NULL,
      parent_id TEXT,
      currency TEXT NOT NULL DEFAULT 'USD',
      is_active INTEGER NOT NULL DEFAULT 1,
      is_system INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      created_at TEXT NOT NULL,
      _synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS conflict_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      local_data TEXT NOT NULL,
      remote_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT
    );

    CREATE TABLE IF NOT EXISTS _cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// Columns that Supabase/JS uses as booleans but SQLite stores as 0/1.
const BOOL_COLS = {
  categories: ['is_archived'],
  profiles:   ['is_active'],
  accounts:   ['is_active', 'is_system'],
};

// Columns that are JSON arrays in JS but stored as TEXT in SQLite.
const JSON_COLS = {
  projects: ['photographers'],
};

const ALLOWED_TABLES = new Set(['years', 'projects', 'expenses', 'categories', 'profiles', 'accounts']);

function toSqliteRow(table, row) {
  const out = { ...row };
  for (const col of (BOOL_COLS[table] || [])) {
    if (col in out && out[col] != null) out[col] = out[col] ? 1 : 0;
  }
  for (const col of (JSON_COLS[table] || [])) {
    if (col in out && out[col] != null && typeof out[col] !== 'string') {
      out[col] = JSON.stringify(out[col]);
    }
  }
  return out;
}

function fromSqliteRow(table, row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of (BOOL_COLS[table] || [])) {
    if (col in out && out[col] != null) out[col] = out[col] === 1 || out[col] === true;
  }
  for (const col of (JSON_COLS[table] || [])) {
    if (col in out && out[col] != null && typeof out[col] === 'string') {
      try { out[col] = JSON.parse(out[col]); } catch { out[col] = []; }
    }
  }
  delete out._synced_at;
  return out;
}

// Default ORDER BY for each table.
const ORDER_BY = {
  years:      'ORDER BY year_value DESC',
  projects:   'ORDER BY created_at DESC',
  expenses:   'ORDER BY expense_date DESC, created_at DESC',
  categories: 'ORDER BY name ASC',
  accounts:   'ORDER BY code ASC',
  profiles:   'ORDER BY created_at ASC',
};

// ── Public API ──────────────────────────────────────────────────────────────

function query(table, filters = {}) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unknown table: ${table}`);
  const db = getDb();
  const keys = Object.keys(filters);
  let sql = `SELECT * FROM ${table}`;
  if (keys.length) sql += ' WHERE ' + keys.map(k => `${k} = ?`).join(' AND ');
  sql += ' ' + (ORDER_BY[table] || '');
  const rows = db.prepare(sql).all(...Object.values(filters));
  return rows.map(r => fromSqliteRow(table, r));
}

function get(table, id) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unknown table: ${table}`);
  const db = getDb();
  return fromSqliteRow(table, db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
}

function upsert(table, row) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unknown table: ${table}`);
  const db = getDb();
  const r = toSqliteRow(table, { ...row, _synced_at: new Date().toISOString() });
  const cols = Object.keys(r);
  db.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...Object.values(r));
  return fromSqliteRow(table, db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id));
}

function upsertMany(table, rows) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unknown table: ${table}`);
  if (!rows || rows.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const txn = db.transaction((items) => {
    for (const row of items) {
      const r = toSqliteRow(table, { ...row, _synced_at: now });
      const cols = Object.keys(r);
      db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).run(...Object.values(r));
    }
  });
  txn(rows);
}

function remove(table, id) {
  if (!ALLOWED_TABLES.has(table)) throw new Error(`Unknown table: ${table}`);
  getDb().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

// ── Sync queue ───────────────────────────────────────────────────────────────

function enqueue(tableName, recordId, operation, payload) {
  getDb().prepare(
    `INSERT INTO sync_queue (table_name, record_id, operation, payload, queued_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tableName, recordId, operation, JSON.stringify(payload), new Date().toISOString());
}

function getQueue() {
  return getDb().prepare('SELECT * FROM sync_queue ORDER BY id ASC').all();
}

function removeFromQueue(id) {
  getDb().prepare('DELETE FROM sync_queue WHERE id = ?').run(id);
}

function markQueueError(id, error) {
  getDb().prepare(
    'UPDATE sync_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?'
  ).run(String(error), id);
}

// ── Conflict log ─────────────────────────────────────────────────────────────

function addConflict(tableName, recordId, localData, remoteData) {
  const db = getDb();
  db.prepare(
    `INSERT INTO conflict_log (table_name, record_id, local_data, remote_data, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tableName, recordId, JSON.stringify(localData), JSON.stringify(remoteData), new Date().toISOString());
  return db.prepare('SELECT last_insert_rowid() as id').get().id;
}

function getConflicts() {
  return getDb()
    .prepare('SELECT * FROM conflict_log WHERE resolved_at IS NULL ORDER BY created_at DESC')
    .all()
    .map(row => ({
      ...row,
      local_data: JSON.parse(row.local_data),
      remote_data: JSON.parse(row.remote_data),
    }));
}

function resolveConflict(id, resolution) {
  getDb().prepare(
    'UPDATE conflict_log SET resolved_at = ?, resolution = ? WHERE id = ?'
  ).run(new Date().toISOString(), resolution, id);
}

// ── View cache ───────────────────────────────────────────────────────────────

function getCache(key) {
  const row = getDb().prepare('SELECT * FROM _cache WHERE key = ?').get(key);
  if (!row) return null;
  try { return { data: JSON.parse(row.data), cached_at: row.cached_at }; } catch { return null; }
}

function setCache(key, data) {
  getDb().prepare(
    `INSERT OR REPLACE INTO _cache (key, data, cached_at) VALUES (?, ?, ?)`
  ).run(key, JSON.stringify(data), new Date().toISOString());
}

// ── Meta ─────────────────────────────────────────────────────────────────────

function getMeta(key) {
  const row = getDb().prepare('SELECT value FROM _meta WHERE key = ?').get(key);
  return row?.value ?? null;
}

function setMeta(key, value) {
  getDb().prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)`).run(key, String(value));
}

module.exports = {
  query, get, upsert, upsertMany, remove,
  enqueue, getQueue, removeFromQueue, markQueueError,
  addConflict, getConflicts, resolveConflict,
  getCache, setCache,
  getMeta, setMeta,
};
