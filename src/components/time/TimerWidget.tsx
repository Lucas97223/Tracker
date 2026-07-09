import { useEffect, useMemo, useState } from 'react';
import { useRunningTimer, useStartTimer, useStopTimer } from '../../hooks/useTime';
import { useWorkProjects } from '../../hooks/useTasks';
import { useToast } from '../../providers/ToastProvider';

function elapsed(startedAt: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Header start/stop timer. The running entry lives server-side (survives reload). */
export function TimerWidget() {
  const running = useRunningTimer();
  const start = useStartTimer();
  const stop = useStopTimer();
  const projects = useWorkProjects();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [billable, setBillable] = useState(true);
  const [now, setNow] = useState(Date.now());

  const active = running.data ?? null;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  const projectName = useMemo(
    () => (projects.data ?? []).find((p) => p.id === active?.project_id)?.name,
    [projects.data, active?.project_id],
  );

  async function handleStart() {
    if (!projectId) return;
    try {
      await start.mutateAsync({ project_id: projectId, billable });
      setOpen(false);
      toast.success('Timer started');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the timer');
    }
  }

  async function handleStop() {
    try {
      const entry = await stop.mutateAsync();
      const mins = entry?.minutes ?? 0;
      toast.success(`Timer stopped — ${Math.floor(mins / 60)}h ${mins % 60}m logged`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not stop the timer');
    }
  }

  if (active) {
    return (
      <button
        type="button"
        className="flex items-center gap-2 rounded bg-red-50 px-2.5 py-1 text-sm text-red-700 ring-1 ring-red-200 hover:bg-red-100"
        onClick={() => void handleStop()}
        title={`Recording time on ${projectName ?? 'a project'} — click to stop`}
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="tabular-nums">{elapsed(active.started_at, now)}</span>
        {projectName && <span className="hidden max-w-32 truncate lg:inline">{projectName}</span>}
        <span className="font-medium">■ Stop</span>
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-ghost"
        onClick={() => setOpen((v) => !v)}
        aria-label="Start timer"
      >
        ▶ Timer
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-40 mt-1 w-72 space-y-2 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Project
              <select
                className="input mt-1 w-full"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Pick a project…</option>
                {(projects.data ?? [])
                  .filter((p) => p.status === 'active' || p.status === 'planning')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={billable}
                onChange={(e) => setBillable(e.target.checked)}
              />
              Billable
            </label>
            <button
              type="button"
              className="btn-primary w-full"
              disabled={!projectId || start.isPending}
              onClick={() => void handleStart()}
            >
              Start
            </button>
          </div>
        </>
      )}
    </div>
  );
}
