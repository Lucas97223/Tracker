import type { Role } from '../types/database';

/**
 * Pure permission helpers mirroring the RLS policies in supabase/migrations/0002_rls.sql.
 * The database is the source of truth; these only drive UI affordances.
 */
export function isActiveUser(opts: { isActive: boolean }): boolean {
  return opts.isActive === true;
}

export function isAdmin(opts: { role: Role | null; isActive: boolean }): boolean {
  return opts.isActive && opts.role === 'admin';
}

export function canEdit(opts: { role: Role | null; isActive: boolean }): boolean {
  return opts.isActive && (opts.role === 'admin' || opts.role === 'editor');
}

export function canView(opts: { role: Role | null; isActive: boolean }): boolean {
  return opts.isActive && opts.role !== null;
}

export function canManageUsers(opts: { role: Role | null; isActive: boolean }): boolean {
  return isAdmin(opts);
}

export function canManageCategories(opts: { role: Role | null; isActive: boolean }): boolean {
  return isAdmin(opts);
}
