import { useState } from 'react';
import { format } from 'date-fns';
import { useAuditLog } from '../hooks/useAuditLog';
import { useProfiles } from '../hooks/useProfiles';
import type { AuditEntity } from '../types/database';

const ENTITY_TYPES: (AuditEntity | '')[] = ['', 'year', 'project', 'expense', 'category', 'member', 'profile'];

export function AuditLogPage() {
  const [userId, setUserId] = useState<string>('');
  const [entityType, setEntityType] = useState<AuditEntity | ''>('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const log = useAuditLog({
    userId: userId || undefined,
    entityType: entityType || undefined,
    startDate: start || undefined,
    endDate: end || undefined,
  });
  const profiles = useProfiles();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Audit log</h1>

      <div className="card grid grid-cols-1 gap-3 p-3 md:grid-cols-4">
        <div>
          <label className="label">User</label>
          <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name || p.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Entity</label>
          <select
            className="input"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value as AuditEntity | '')}
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t || 'All'}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">From</label>
          <input
            type="datetime-local"
            className="input"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </div>
        <div>
          <label className="label">To</label>
          <input
            type="datetime-local"
            className="input"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Entity</th>
              <th className="px-3 py-2 font-medium">Changes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(log.data ?? []).map((row) => (
              <tr key={row.id} className="align-top">
                <td className="px-3 py-2 text-slate-600">
                  {format(new Date(row.created_at), 'yyyy-MM-dd HH:mm:ss')}
                </td>
                <td className="px-3 py-2">{row.user?.full_name || row.user?.email || '—'}</td>
                <td className="px-3 py-2">
                  <span
                    className={`badge ${
                      row.action === 'create'
                        ? 'bg-emerald-100 text-emerald-800'
                        : row.action === 'update'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {row.action}
                  </span>
                </td>
                <td className="px-3 py-2 text-slate-700">
                  <div className="font-mono text-xs">{row.entity_type}</div>
                  <div className="font-mono text-[10px] text-slate-400">{row.entity_id}</div>
                </td>
                <td className="px-3 py-2 max-w-md">
                  <pre className="whitespace-pre-wrap break-all text-xs text-slate-600">
                    {JSON.stringify(row.changes, null, 2)}
                  </pre>
                </td>
              </tr>
            ))}
            {log.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-sm text-slate-500">
                  No entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
