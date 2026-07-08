import { Link } from 'react-router-dom';
import { useYearRollups } from '../hooks/useYears';
import { useProjectRollups } from '../hooks/useProjects';
import { formatMoney } from '../lib/money';
import { Skeleton } from '../components/LoadingScreen';

export function HomePage() {
  const years = useYearRollups();
  const projects = useProjectRollups();

  const total = (years.data ?? []).reduce((acc, y) => acc + Number(y.total_amount || 0), 0);
  const projectCount = (years.data ?? []).reduce((acc, y) => acc + y.project_count, 0);
  const expenseCount = (years.data ?? []).reduce((acc, y) => acc + y.expense_count, 0);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Overview</h1>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="Total spend" value={years.isLoading ? <Skeleton className="h-6 w-24" /> : formatMoney(total)} />
        <Kpi label="Projects" value={years.isLoading ? <Skeleton className="h-6 w-16" /> : projectCount.toString()} />
        <Kpi label="Line items" value={years.isLoading ? <Skeleton className="h-6 w-16" /> : expenseCount.toString()} />
      </div>

      <section className="card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">By year</h2>
          <Link className="text-sm text-brand-700 hover:underline" to="/dashboard">
            Open dashboard →
          </Link>
        </div>
        <ul className="mt-2 divide-y divide-slate-100">
          {(years.data ?? []).map((y) => (
            <li key={y.year_id}>
              <Link
                to={`/years/${y.year_id}`}
                className="flex items-center justify-between py-2 hover:bg-slate-50"
              >
                <span className="font-medium">{y.label || y.year_value}</span>
                <span className="text-sm text-slate-600">
                  {y.project_count} projects · {formatMoney(y.total_amount)}
                </span>
              </Link>
            </li>
          ))}
          {!years.isLoading && (years.data ?? []).length === 0 && (
            <li className="py-4 text-sm text-slate-500">
              No years yet. Use the sidebar to create one.
            </li>
          )}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Top projects</h2>
        <ul className="mt-2 divide-y divide-slate-100">
          {(projects.data ?? []).slice(0, 8).map((p) => (
            <li key={p.project_id}>
              <Link
                to={`/projects/${p.project_id}`}
                className="flex items-center justify-between py-2 hover:bg-slate-50"
              >
                <span className="truncate">{p.name}</span>
                <span className="text-sm text-slate-600">{formatMoney(p.total_amount)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
