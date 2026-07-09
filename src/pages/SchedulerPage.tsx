import { useState } from 'react';
import {
  useCancelBooking,
  useDeleteAvailabilityRule,
  useSaveAppointmentType,
  useSaveAvailabilityRule,
  useScheduler,
} from '../hooks/useSell';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // ISO 1..7

export function SchedulerPage() {
  const { canEdit } = useAuth();
  const data = useScheduler();
  const saveType = useSaveAppointmentType();
  const saveRule = useSaveAvailabilityRule();
  const deleteRule = useDeleteAvailabilityRule();
  const cancelBooking = useCancelBooking();
  const toast = useToast();
  const [newType, setNewType] = useState({ name: '', minutes: '30' });
  const [newRule, setNewRule] = useState({ weekday: '1', start: '09:00', end: '17:00' });

  const types = data.data?.types ?? [];
  const rules = data.data?.rules ?? [];
  const bookings = (data.data?.bookings ?? []).filter((b) => b.status === 'confirmed');

  function shareUrl(token: string) {
    return `${window.location.origin}${window.location.pathname}#/book/${token}`;
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Scheduler</h1>
        <p className="mt-1 text-sm text-slate-500">
          Share a booking link; visitors pick from your open slots. Double-booking is impossible.
        </p>
      </header>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Appointment types
          </h2>
        </header>
        <div className="divide-y divide-slate-50">
          {types.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
              <span className={`badge ${t.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
                {t.is_active ? 'live' : 'off'}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-slate-800">{t.name}</span>
              <span className="text-xs text-slate-400">{t.minutes} min</span>
              <button
                type="button"
                className="btn-ghost !py-0.5 text-xs"
                onClick={() =>
                  void navigator.clipboard.writeText(shareUrl(t.share_token))
                    .then(() => toast.success('Booking link copied'))
                }
              >
                Copy link
              </button>
              <a className="btn-ghost !py-0.5 text-xs" href={shareUrl(t.share_token)} target="_blank" rel="noreferrer">
                Preview
              </a>
              {canEdit && (
                <button
                  type="button"
                  className="btn-ghost !py-0.5 text-xs"
                  onClick={() =>
                    void saveType.mutateAsync({ id: t.id, name: t.name, is_active: !t.is_active })
                      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                  }
                >
                  {t.is_active ? 'Turn off' : 'Turn on'}
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <div className="flex items-center gap-2 px-4 py-2">
              <input
                className="input min-w-0 flex-1"
                placeholder="e.g. Consultation call"
                value={newType.name}
                onChange={(e) => setNewType((f) => ({ ...f, name: e.target.value }))}
              />
              <input
                type="number" min="5" step="5"
                className="input w-24 text-right"
                value={newType.minutes}
                onChange={(e) => setNewType((f) => ({ ...f, minutes: e.target.value }))}
              />
              <span className="text-xs text-slate-400">min</span>
              <button
                type="button"
                className="btn-primary"
                disabled={!newType.name.trim() || saveType.isPending}
                onClick={() =>
                  void saveType
                    .mutateAsync({ name: newType.name.trim(), minutes: Number(newType.minutes) || 30 })
                    .then(() => setNewType({ name: '', minutes: '30' }))
                    .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                }
              >
                Add
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Weekly availability (applies to all types)
          </h2>
        </header>
        <div className="divide-y divide-slate-50">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="w-10 font-medium text-slate-800">{WEEKDAYS[r.weekday - 1]}</span>
              <span className="text-slate-600">{r.start_time.slice(0, 5)} – {r.end_time.slice(0, 5)}</span>
              {canEdit && (
                <button
                  type="button"
                  className="btn-ghost ml-auto !px-2 !py-0.5 text-xs"
                  onClick={() => void deleteRule.mutateAsync(r.id)}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <div className="flex items-center gap-2 px-4 py-2">
              <select
                className="input w-24"
                value={newRule.weekday}
                onChange={(e) => setNewRule((f) => ({ ...f, weekday: e.target.value }))}
              >
                {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
              </select>
              <input type="time" className="input w-32" value={newRule.start}
                onChange={(e) => setNewRule((f) => ({ ...f, start: e.target.value }))} />
              <span className="text-slate-400">to</span>
              <input type="time" className="input w-32" value={newRule.end}
                onChange={(e) => setNewRule((f) => ({ ...f, end: e.target.value }))} />
              <button
                type="button"
                className="btn-primary"
                disabled={saveRule.isPending}
                onClick={() =>
                  void saveRule
                    .mutateAsync({ weekday: Number(newRule.weekday), start_time: newRule.start, end_time: newRule.end })
                    .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                }
              >
                Add hours
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Upcoming bookings
          </h2>
        </header>
        {bookings.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">Nothing booked yet.</p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {bookings.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className="font-medium text-slate-800">
                  {new Date(b.starts_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {b.name}{b.email ? ` · ${b.email}` : ''}
                </span>
                {canEdit && (
                  <button
                    type="button"
                    className="btn-ghost !py-0.5 text-xs"
                    onClick={() =>
                      void cancelBooking.mutateAsync(b.id)
                        .then(() => toast.success('Booking cancelled — the slot is free again'))
                        .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                    }
                  >
                    Cancel
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
