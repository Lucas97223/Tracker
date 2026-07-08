import { Link } from 'react-router-dom';
import { useProfiles, useUpdateProfile } from '../hooks/useProfiles';
import { useToast } from '../providers/ToastProvider';
import { useAuth } from '../providers/AuthProvider';
import type { Role } from '../types/database';
import { format } from 'date-fns';

const ROLES: Role[] = ['admin', 'editor', 'viewer'];

export function AdminPage() {
  const { user } = useAuth();
  const profiles = useProfiles();
  const update = useUpdateProfile();
  const toast = useToast();

  async function setRole(id: string, role: Role) {
    try {
      await update.mutateAsync({ id, role });
      toast.success('Role updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function setActive(id: string, isActive: boolean) {
    try {
      await update.mutateAsync({ id, is_active: isActive });
      toast.success(isActive ? 'Activated' : 'Deactivated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed');
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admin</h1>
        <Link to="/admin/audit-log" className="btn-ghost">
          Audit log →
        </Link>
      </header>

      <section className="card overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Users</h2>
          <p className="mt-1 text-xs text-slate-500">
            Invite-only. Create users in the Supabase dashboard; they appear here after their first sign-in.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Name / Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium">Active</th>
                <th className="px-4 py-2 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(profiles.data ?? []).map((p) => {
                const self = p.id === user?.id;
                return (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <div className="font-medium">{p.full_name || '—'}</div>
                      <div className="text-xs text-slate-500">{p.email}</div>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        className="input w-auto"
                        value={p.role}
                        disabled={self}
                        title={self ? "You can't change your own role" : ''}
                        onChange={(e) => setRole(p.id, e.target.value as Role)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={p.is_active}
                          disabled={self}
                          onChange={(e) => setActive(p.id, e.target.checked)}
                        />
                        <span className="text-sm">
                          {p.is_active ? 'Active' : <span className="text-red-600">Inactive</span>}
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {format(new Date(p.created_at), 'MMM d, yyyy')}
                    </td>
                  </tr>
                );
              })}
              {profiles.data?.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-sm text-slate-500">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
