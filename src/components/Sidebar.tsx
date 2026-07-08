import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useYearRollups } from '../hooks/useYears';
import { useProjectRollups } from '../hooks/useProjects';
import { useAuth } from '../providers/AuthProvider';
import { formatMoneyCompact } from '../lib/money';
import { CreateYearButton } from './forms/CreateYearButton';
import { CreateProjectButton } from './forms/CreateProjectButton';

export function Sidebar() {
  const navigate = useNavigate();
  const { canEdit } = useAuth();
  const { data: years, isLoading } = useYearRollups();
  const { data: projects } = useProjectRollups();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const projectsByYear = useMemo(() => {
    const map = new Map<string, typeof projects>();
    (projects ?? []).forEach((p) => {
      const arr = map.get(p.year_id) ?? [];
      arr.push(p);
      map.set(p.year_id, arr);
    });
    return map;
  }, [projects]);

  function toggle(yearId: string) {
    setExpanded((e) => ({ ...e, [yearId]: !e[yearId] }));
  }

  return (
    <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Hierarchy
        </h2>
        {canEdit && <CreateYearButton />}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {isLoading && <div className="px-3 text-sm text-slate-500">Loading…</div>}
        {!isLoading && (years ?? []).length === 0 && (
          <div className="px-3 text-sm text-slate-500">
            No years yet. {canEdit ? 'Click "+ Year" to start.' : ''}
          </div>
        )}
        <ul>
          {(years ?? []).map((y) => {
            const isOpen = expanded[y.year_id] ?? true;
            const projs = projectsByYear.get(y.year_id) ?? [];
            return (
              <li key={y.year_id} className="mb-0.5">
                <div className="flex items-center gap-1 px-1">
                  <button
                    type="button"
                    onClick={() => toggle(y.year_id)}
                    className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                    aria-expanded={isOpen}
                  >
                    <span className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                  </button>
                  <NavLink
                    to={`/years/${y.year_id}`}
                    className={({ isActive }) =>
                      `flex flex-1 items-center justify-between rounded px-2 py-1 text-sm ${
                        isActive ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-100'
                      }`
                    }
                  >
                    <span className="font-medium">{y.label || y.year_value}</span>
                    <span className="text-xs tabular-nums text-slate-500">
                      {formatMoneyCompact(y.total_amount)}
                    </span>
                  </NavLink>
                </div>
                {isOpen && (
                  <ul className="ml-7 mt-0.5 space-y-0.5">
                    {projs.length === 0 && (
                      <li className="px-2 py-1 text-xs text-slate-400">No projects</li>
                    )}
                    {projs.map((p) => (
                      <li key={p.project_id}>
                        <NavLink
                          to={`/projects/${p.project_id}`}
                          className={({ isActive }) =>
                            `flex items-center justify-between rounded px-2 py-1 text-sm ${
                              isActive ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-100'
                            }`
                          }
                        >
                          <span className="truncate">{p.name}</span>
                          <span className="ml-2 text-xs tabular-nums text-slate-500">
                            {formatMoneyCompact(p.total_amount)}
                          </span>
                        </NavLink>
                      </li>
                    ))}
                    {canEdit && (
                      <li>
                        <CreateProjectButton
                          yearId={y.year_id}
                          onCreated={(id) => navigate(`/projects/${id}`)}
                        />
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
