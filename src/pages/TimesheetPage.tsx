import { useMemo, useState } from 'react';
import {
  useCreateTimeEntry,
  useDeleteTimeEntry,
  useWeekEntries,
  type TimeEntryRow,
} from '../hooks/useTime';
import { useWorkProjects } from '../hooks/useTasks';
import { useTeamMembers } from '../hooks/useTeam';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { Modal } from '../components/Modal';

function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() - day + 1);
  return x.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtMinutes(mins: number): string {
  if (mins === 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : h === 0 ? `${m}m` : `${h}h${String(m).padStart(2, '0')}`;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Person × day grid for one week. Editors see everyone; workers see themselves. */
export function TimesheetPage() {
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const entries = useWeekEntries(weekStart);
  const projects = useWorkProjects();
  const team = useTeamMembers();
  const createEntry = useCreateTimeEntry();
  const deleteEntry = useDeleteTimeEntry();
  const { canEdit, user } = useAuth();
  const toast = useToast();
  const [logging, setLogging] = useState(false);
  const [form, setForm] = useState({
    project_id: '',
    team_member_id: '',
    date: new Date().toISOString().slice(0, 10),
    hours: '1',
    billable: true,
    notes: '',
  });

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const projectName = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.name])),
    [projects.data],
  );

  const byPerson = useMemo(() => {
    const m = new Map<string, { name: string; days: Map<string, TimeEntryRow[]> }>();
    for (const e of entries.data ?? []) {
      const key = e.team_member_id;
      const name = e.member?.display_name ?? '—';
      const day = e.started_at.slice(0, 10);
      if (!m.has(key)) m.set(key, { name, days: new Map() });
      const p = m.get(key)!;
      p.days.set(day, [...(p.days.get(day) ?? []), e]);
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [entries.data]);

  const myTeamMemberIds = useMemo(
    () => new Set((team.data ?? []).filter((m) => m.profile_id === user?.id).map((m) => m.id)),
    [team.data, user?.id],
  );

  async function submitLog() {
    const minutes = Math.round(Number(form.hours) * 60);
    const member =
      form.team_member_id ||
      (team.data ?? []).find((m) => m.profile_id === user?.id)?.id ||
      '';
    if (!form.project_id || !member || !Number.isFinite(minutes) || minutes <= 0) {
      toast.error('Pick a project, person and a positive number of hours');
      return;
    }
    try {
      await createEntry.mutateAsync({
        project_id: form.project_id,
        team_member_id: member,
        date: form.date,
        minutes,
        billable: form.billable,
        notes: form.notes.trim() || null,
      });
      toast.success('Time logged');
      setLogging(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not log time');
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Timesheet</h1>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => setWeekStart(addDays(weekStart, -7))}>
            ← Prev
          </button>
          <span className="text-sm text-slate-600">
            week of <strong>{weekStart}</strong>
          </span>
          <button type="button" className="btn-ghost" onClick={() => setWeekStart(addDays(weekStart, 7))}>
            Next →
          </button>
          <button type="button" className="btn-ghost" onClick={() => setWeekStart(mondayOf(new Date()))}>
            Today
          </button>
          <button type="button" className="btn-primary" onClick={() => setLogging(true)}>
            + Log time
          </button>
        </div>
      </header>

      {byPerson.length === 0 ? (
        <p className="text-sm text-slate-500">
          No time logged this week. Use the ▶ Timer in the header, or “+ Log time”.
        </p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2">Person</th>
                {days.map((d, i) => (
                  <th key={d} className="px-2 py-2 text-right">
                    {DAY_LABELS[i]} <span className="font-normal text-slate-400">{d.slice(8)}</span>
                  </th>
                ))}
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {byPerson.map((p) => {
                const total = days.reduce(
                  (acc, d) => acc + (p.days.get(d) ?? []).reduce((a, e) => a + (e.minutes ?? 0), 0),
                  0,
                );
                return (
                  <tr key={p.name} className="border-b border-slate-50 align-top">
                    <td className="px-4 py-2 font-medium text-slate-800">{p.name}</td>
                    {days.map((d) => {
                      const dayEntries = p.days.get(d) ?? [];
                      const mins = dayEntries.reduce((a, e) => a + (e.minutes ?? 0), 0);
                      return (
                        <td key={d} className="px-2 py-2 text-right tabular-nums">
                          {dayEntries.length > 0 ? (
                            <div
                              className="group cursor-default"
                              title={dayEntries
                                .map(
                                  (e) =>
                                    `${projectName.get(e.project_id) ?? 'Project'}: ${fmtMinutes(e.minutes ?? 0)}${e.billable ? ' (billable)' : ''}${e.notes ? ' — ' + e.notes : ''}`,
                                )
                                .join('\n')}
                            >
                              {fmtMinutes(mins)}
                              {dayEntries.some((e) => e.billable) && (
                                <span className="ml-0.5 text-emerald-600" title="billable">
                                  $
                                </span>
                              )}
                              {canEdit &&
                                dayEntries
                                  .filter((e) => !e.invoiced_lock)
                                  .slice(0, 1)
                                  .map((e) => (
                                    <button
                                      key={e.id}
                                      type="button"
                                      className="ml-1 hidden text-xs text-red-400 hover:text-red-600 group-hover:inline"
                                      title="Delete this day's first entry"
                                      onClick={() =>
                                        void deleteEntry
                                          .mutateAsync(e.id)
                                          .catch((err) =>
                                            toast.error(err instanceof Error ? err.message : 'Delete failed'),
                                          )
                                      }
                                    >
                                      ✕
                                    </button>
                                  ))}
                            </div>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{fmtMinutes(total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={logging} title="Log time" onClose={() => setLogging(false)} size="sm">
        <div className="space-y-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Project
            <select
              className="input mt-1 w-full"
              value={form.project_id}
              onChange={(e) => setForm((f) => ({ ...f, project_id: e.target.value }))}
            >
              <option value="">Pick…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {canEdit && (
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Person
              <select
                className="input mt-1 w-full"
                value={form.team_member_id}
                onChange={(e) => setForm((f) => ({ ...f, team_member_id: e.target.value }))}
              >
                <option value="">Me</option>
                {(team.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                    {myTeamMemberIds.has(m.id) ? ' (me)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Date
              <input
                type="date"
                className="input mt-1 w-full"
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              />
            </label>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Hours
              <input
                type="number"
                min="0.25"
                step="0.25"
                className="input mt-1 w-full"
                value={form.hours}
                onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={form.billable}
              onChange={(e) => setForm((f) => ({ ...f, billable: e.target.checked }))}
            />
            Billable
          </label>
          <input
            className="input w-full"
            placeholder="Notes (optional)"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
          />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setLogging(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={createEntry.isPending}
              onClick={() => void submitLog()}
            >
              Log
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
