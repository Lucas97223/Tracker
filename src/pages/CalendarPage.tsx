import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useWorkProjects } from '../hooks/useTasks';
import { useSyncContext } from '../providers/SyncProvider';

// Month calendar over the three time-bearing things: project spans, task due
// dates, bookings. Role-safe by construction: projects come from the
// work-safe view, tasks/bookings via their own RLS.

interface CalTask {
  id: string;
  title: string;
  due_date: string;
  project_id: string;
  status: string;
}
interface CalBooking {
  id: string;
  name: string;
  starts_at: string;
  status: string;
}

function monthRange(anchor: Date): { from: string; to: string } {
  const from = new Date(Date.UTC(anchor.getFullYear(), anchor.getMonth(), 1));
  const to = new Date(Date.UTC(anchor.getFullYear(), anchor.getMonth() + 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function useCalendarData(anchor: Date) {
  const { isOnline } = useSyncContext();
  const { from, to } = monthRange(anchor);
  return useQuery({
    queryKey: ['calendar', from] as const,
    enabled: isOnline,
    queryFn: async () => {
      const [tasks, bookings] = await Promise.all([
        supabase
          .from('tasks')
          .select('id, title, due_date, project_id, status')
          .gte('due_date', from)
          .lte('due_date', to)
          .neq('status', 'done'),
        supabase
          .from('bookings')
          .select('id, name, starts_at, status')
          .gte('starts_at', from)
          .lte('starts_at', to + 'T23:59:59Z')
          .eq('status', 'confirmed'),
      ]);
      if (tasks.error) throw tasks.error;
      if (bookings.error) throw bookings.error;
      return {
        tasks: (tasks.data ?? []) as CalTask[],
        bookings: (bookings.data ?? []) as CalBooking[],
      };
    },
  });
}

export function CalendarPage() {
  const [anchor, setAnchor] = useState(() => new Date());
  const data = useCalendarData(anchor);
  const projects = useWorkProjects();

  const days = useMemo(() => {
    const first = new Date(Date.UTC(anchor.getFullYear(), anchor.getMonth(), 1));
    const startPad = (first.getUTCDay() + 6) % 7; // Monday-first grid
    const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    const cells: Array<string | null> = Array(startPad).fill(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(
        `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      );
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [anchor]);

  const byDay = useMemo(() => {
    const m = new Map<string, Array<{ kind: string; label: string; to?: string }>>();
    const add = (day: string, item: { kind: string; label: string; to?: string }) =>
      m.set(day, [...(m.get(day) ?? []), item]);

    for (const p of projects.data ?? []) {
      if (p.start_date) add(p.start_date, { kind: '📁', label: p.name, to: `/projects/${p.id}` });
      if (p.end_date && p.end_date !== p.start_date)
        add(p.end_date, { kind: '🏁', label: p.name, to: `/projects/${p.id}` });
    }
    for (const t of data.data?.tasks ?? []) {
      add(t.due_date, { kind: '☑️', label: t.title, to: `/projects/${t.project_id}` });
    }
    for (const b of data.data?.bookings ?? []) {
      add(b.starts_at.slice(0, 10), {
        kind: '📅',
        label: `${new Date(b.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${b.name}`,
        to: '/scheduler',
      });
    }
    return m;
  }, [projects.data, data.data]);

  const monthLabel = anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Calendar</h1>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost"
            onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}>
            ← Prev
          </button>
          <span className="min-w-40 text-center text-sm font-medium text-slate-700">{monthLabel}</span>
          <button type="button" className="btn-ghost"
            onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}>
            Next →
          </button>
          <button type="button" className="btn-ghost" onClick={() => setAnchor(new Date())}>
            Today
          </button>
        </div>
      </header>

      <div className="card overflow-hidden">
        <div className="grid grid-cols-7 border-b border-slate-100 text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="py-1.5">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day, i) => (
            <div
              key={i}
              className={`min-h-24 border-b border-r border-slate-50 p-1 ${
                day === today ? 'bg-brand-50' : day ? '' : 'bg-slate-50/50'
              }`}
            >
              {day && (
                <>
                  <p className={`text-xs ${day === today ? 'font-bold text-brand-700' : 'text-slate-400'}`}>
                    {Number(day.slice(8))}
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {(byDay.get(day) ?? []).slice(0, 4).map((item, j) => (
                      <li key={j} className="truncate text-[11px] leading-tight">
                        {item.to ? (
                          <Link to={item.to} className="text-slate-700 hover:text-brand-700 hover:underline">
                            {item.kind} {item.label}
                          </Link>
                        ) : (
                          <span className="text-slate-700">{item.kind} {item.label}</span>
                        )}
                      </li>
                    ))}
                    {(byDay.get(day) ?? []).length > 4 && (
                      <li className="text-[11px] text-slate-400">
                        +{(byDay.get(day) ?? []).length - 4} more
                      </li>
                    )}
                  </ul>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-400">
        📁 project starts · 🏁 project ends · ☑️ task due · 📅 booking
      </p>
    </div>
  );
}
