import { describe, expect, it } from 'vitest';
import { canEdit, canManageCategories, canManageUsers, canView, isActiveUser, isAdmin } from './permissions';

describe('permissions', () => {
  it('inactive users have no permissions regardless of role', () => {
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      const opts = { role, isActive: false };
      expect(isActiveUser(opts)).toBe(false);
      expect(isAdmin(opts)).toBe(false);
      expect(canEdit(opts)).toBe(false);
      expect(canView(opts)).toBe(false);
      expect(canManageUsers(opts)).toBe(false);
      expect(canManageCategories(opts)).toBe(false);
    }
  });

  it('viewer can view, cannot edit or admin', () => {
    const opts = { role: 'viewer' as const, isActive: true };
    expect(canView(opts)).toBe(true);
    expect(canEdit(opts)).toBe(false);
    expect(isAdmin(opts)).toBe(false);
    expect(canManageUsers(opts)).toBe(false);
  });

  it('editor can edit but not administer', () => {
    const opts = { role: 'editor' as const, isActive: true };
    expect(canEdit(opts)).toBe(true);
    expect(isAdmin(opts)).toBe(false);
    expect(canManageCategories(opts)).toBe(false);
  });

  it('admin can do everything', () => {
    const opts = { role: 'admin' as const, isActive: true };
    expect(canEdit(opts)).toBe(true);
    expect(isAdmin(opts)).toBe(true);
    expect(canManageUsers(opts)).toBe(true);
    expect(canManageCategories(opts)).toBe(true);
  });

  it('null role behaves like nobody', () => {
    expect(canView({ role: null, isActive: true })).toBe(false);
    expect(canEdit({ role: null, isActive: true })).toBe(false);
  });
});
