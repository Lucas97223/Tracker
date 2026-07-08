import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useYears } from '../hooks/useYears';
import { useProjects } from '../hooks/useProjects';
import { useCategories } from '../hooks/useCategories';
import { useFilteredExpenses, emptyFilters, type DashboardFilters } from '../hooks/useDashboard';
import { useApprovedPay } from '../hooks/useTeam';
import { formatMoney, formatMoneyCompact, sumMoney } from '../lib/money';
import { exportToCsv } from '../lib/csv';
import { useToast } from '../providers/ToastProvider';
import type { Expense, Project } from '../types/database';

type Row = Expense & { project: Project | null };
type Granularity = 'month' | 'year';
type TrendBasis = 'project_end' | 'actual';
type Metric = 'sum' | 'avg';

interface Bucket {
  key: string;
  label: string;
  total: number;
  count: number;
  color?: string;
}

function valueOf(b: Bucket, metric: Metric): number {
  if (metric === 'sum') return b.total;
  return b.count > 0 ? b.total / b.count : 0;
}

export function DashboardPage() {
  const [filters, setFilters] = useState<DashboardFilters>(emptyFilters);
  const [showPivot, setShowPivot] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [trendBasis, setTrendBasis] = useState<TrendBasis>('project_end');
  const [metric, setMetric] = useState<Metric>('sum');

  const years = useYears();
  const projects = useProjects();
  const categories = useCategories();
  const expensesQuery = useFilteredExpenses(filters);
  const approvedPayQuery = useApprovedPay();
  const toast = useToast();

  const projectMap = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p])),
    [projects.data],
  );

  const rawRows: Row[] = useMemo(
    () =>
      (expensesQuery.data ?? []).map((r) => ({
        ...r,
        project: projectMap.get(r.project_id) ?? null,
      })),
    [expensesQuery.data, projectMap],
  );

  const rows = useMemo(
    () =>
      rawRows.filter((r) => {
        if (filters.yearIds.length && !filters.yearIds.includes(r.project?.year_id ?? '')) return false;
        if (filters.locations.length) {
          const loc = (r.location || r.project?.location || 'Unspecified').trim() || 'Unspecified';
          if (!filters.locations.includes(loc)) return false;
        }
        if (filters.projectTypes.length) {
          const t = (r.project?.project_type || 'Untyped').trim() || 'Untyped';
          if (!filters.projectTypes.includes(t)) return false;
        }
        if (filters.photographers.length) {
          // Filter on the line item's attribution (person_name), not project
          // team membership. So filtering by "Alice" shows only what was paid
          // to Alice — not every Travel / Catering line on her projects.
          if (!r.person_name || !filters.photographers.includes(r.person_name)) return false;
        }
        if (filters.search) {
          const s = filters.search.toLowerCase();
          const hay = [r.description, r.vendor, r.notes, r.location].filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(s)) return false;
        }
        return true;
      }),
    [rawRows, filters.yearIds, filters.locations, filters.projectTypes, filters.photographers, filters.search],
  );

  // Headline P&L: paid (sum across projects in scope) - spent (filtered expenses) = profit.
  const pnl = useMemo(() => {
    const projectIds = new Set(rows.map((r) => r.project_id));
    let paid = 0;
    for (const id of projectIds) {
      const p = projectMap.get(id);
      if (p) paid += Number(p.client_paid ?? 0);
    }
    const spent = sumMoney(rows.map((r) => r.amount));
    return { paid, spent, profit: paid - spent };
  }, [rows, projectMap]);

  const totals = useMemo(() => {
    const projectCount = new Set(rows.map((r) => r.project_id)).size;
    const avgPerProject = projectCount > 0 ? pnl.spent / projectCount : 0;
    return { projectCount, avgPerProject, count: rows.length };
  }, [rows, pnl.spent]);

  // --- Aggregations as buckets { total, count } so the metric toggle is uniform ---

  const byYear: Bucket[] = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const k = r.project?.year_id ?? '?';
      const cur = map.get(k) ?? { total: 0, count: 0 };
      cur.total += Number(r.amount || 0);
      cur.count += 1;
      map.set(k, cur);
    }
    return Array.from(map.entries())
      .map(([id, v]) => {
        const y = (years.data ?? []).find((yr) => yr.id === id);
        return {
          key: id,
          label: y?.label || y?.year_value?.toString() || 'No year',
          total: v.total,
          count: v.count,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows, years.data]);

  const byProject: Bucket[] = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const cur = map.get(r.project_id) ?? { total: 0, count: 0 };
      cur.total += Number(r.amount || 0);
      cur.count += 1;
      map.set(r.project_id, cur);
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({
        key: id,
        label: projectMap.get(id)?.name ?? 'Unknown',
        total: v.total,
        count: v.count,
      }))
      .sort((a, b) => b.total - a.total);
  }, [rows, projectMap]);

  const byCategory: Bucket[] = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const cur = map.get(r.category_id) ?? { total: 0, count: 0 };
      cur.total += Number(r.amount || 0);
      cur.count += 1;
      map.set(r.category_id, cur);
    }
    return Array.from(map.entries())
      .map(([id, v]) => {
        const c = (categories.data ?? []).find((x) => x.id === id);
        return {
          key: id,
          label: c?.name ?? '—',
          color: c?.color ?? '#94a3b8',
          total: v.total,
          count: v.count,
        };
      })
      .sort((a, b) => b.total - a.total);
  }, [rows, categories.data]);

  const byLocation: Bucket[] = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const raw = (r.location || r.project?.location || '').trim();
      const loc = raw === '' ? 'Unspecified' : raw;
      const cur = map.get(loc) ?? { total: 0, count: 0 };
      cur.total += Number(r.amount || 0);
      cur.count += 1;
      map.set(loc, cur);
    }
    return Array.from(map.entries())
      .map(([location, v]) => ({ key: location, label: location, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);

  const byProjectType: Bucket[] = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const t = (r.project?.project_type || 'Untyped').trim() || 'Untyped';
      const cur = map.get(t) ?? { total: 0, count: 0 };
      cur.total += Number(r.amount || 0);
      cur.count += 1;
      map.set(t, cur);
    }
    return Array.from(map.entries())
      .map(([type, v]) => ({ key: type, label: type, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);

  // Per-photographer: sum of expenses *attributed* to each person via
  // expense.person_name (legacy pay rows live in expenses), PLUS approved pay
  // items (the Phase 0.5 flow, which posts to the ledger instead of expenses).
  // Drafts never count. Pay items pass the same project-level filters as
  // expense rows so this widget stays consistent with the page's filter bar.
  const byPhotographer: Bucket[] = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    const bump = (name: string, amount: number) => {
      const cur = map.get(name) ?? { total: 0, count: 0 };
      cur.total += amount;
      cur.count += 1;
      map.set(name, cur);
    };
    for (const r of rows) {
      const name = r.person_name?.trim();
      if (!name) continue;
      bump(name, Number(r.amount || 0));
    }
    for (const item of approvedPayQuery.data ?? []) {
      const name = item.team_member?.display_name?.trim();
      if (!name) continue;
      const p = projectMap.get(item.project_id) ?? null;
      if (filters.projectIds.length && !filters.projectIds.includes(item.project_id)) continue;
      if (filters.yearIds.length && !filters.yearIds.includes(p?.year_id ?? '')) continue;
      if (filters.startDate && item.pay_date < filters.startDate) continue;
      if (filters.endDate && item.pay_date > filters.endDate) continue;
      if (filters.locations.length) {
        const loc = (p?.location || 'Unspecified').trim() || 'Unspecified';
        if (!filters.locations.includes(loc)) continue;
      }
      if (filters.projectTypes.length) {
        const t = (p?.project_type || 'Untyped').trim() || 'Untyped';
        if (!filters.projectTypes.includes(t)) continue;
      }
      if (filters.photographers.length && !filters.photographers.includes(name)) continue;
      if (filters.search) {
        const s = filters.search.toLowerCase();
        if (!`${item.description} ${name}`.toLowerCase().includes(s)) continue;
      }
      bump(name, Number(item.amount || 0));
    }
    return Array.from(map.entries())
      .map(([name, v]) => ({ key: name, label: name, total: v.total, count: v.count }))
      .sort((a, b) => b.total - a.total);
  }, [rows, approvedPayQuery.data, projectMap, filters]);

  // Team-size buckets: expenses grouped by # of photographers on their project.
  const byTeamSize: Bucket[] = useMemo(() => {
    const map = new Map<number, { total: number; count: number }>();
    for (const r of rows) {
      const size = (r.project?.photographers ?? []).length;
      const cur = map.get(size) ?? { total: 0, count: 0 };
      cur.total += Number(r.amount || 0);
      cur.count += 1;
      map.set(size, cur);
    }
    return Array.from(map.entries())
      .map(([size, v]) => ({
        key: size.toString(),
        label: size === 0 ? 'None' : size === 1 ? '1 person' : `${size} people`,
        total: v.total,
        count: v.count,
      }))
      .sort((a, b) => Number(a.key) - Number(b.key));
  }, [rows]);

  // Trend ----------------------------------------------------------------
  const trend = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const baseDate =
        trendBasis === 'project_end' ? r.project?.end_date || r.expense_date : r.expense_date;
      if (!baseDate) continue;
      const key = granularity === 'month' ? baseDate.slice(0, 7) : baseDate.slice(0, 4);
      const cur = map.get(key) ?? { total: 0, count: 0 };
      cur.total += Number(r.amount || 0);
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.entries())
      .map(([period, v]) => ({
        period,
        amount: metric === 'sum' ? v.total : v.count > 0 ? v.total / v.count : 0,
      }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }, [rows, granularity, trendBasis, metric]);

  const formatTrendTick = (v: string) => {
    if (granularity === 'year') return v;
    const [y, m] = v.split('-');
    if (!y || !m) return v;
    const d = new Date(Number(y), Number(m) - 1, 1);
    return new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' }).format(d);
  };

  const pivot = useMemo(() => {
    const yearLabels = Array.from(new Set(byYear.map((y) => y.label)));
    const data: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      const cat = (categories.data ?? []).find((c) => c.id === r.category_id)?.name ?? '—';
      const yr =
        (years.data ?? []).find((y) => y.id === r.project?.year_id)?.label ||
        (years.data ?? []).find((y) => y.id === r.project?.year_id)?.year_value?.toString() ||
        'No year';
      data[cat] = data[cat] ?? {};
      data[cat]![yr] = (data[cat]![yr] ?? 0) + Number(r.amount || 0);
    }
    return { yearLabels, cats: Object.keys(data).sort(), data };
  }, [rows, categories.data, years.data, byYear]);

  const availableLocations = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) {
      const raw = (r.location || r.project?.location || '').trim();
      set.add(raw === '' ? 'Unspecified' : raw);
    }
    return Array.from(set).sort();
  }, [rawRows]);

  const availableProjectTypes = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects.data ?? []) {
      const t = (p.project_type || '').trim();
      set.add(t === '' ? 'Untyped' : t);
    }
    return Array.from(set).sort();
  }, [projects.data]);

  // Available names for the photographer filter dropdown: union of every
  // person_name we've ever seen on an expense (the dimension the filter
  // actually narrows on), plus any team members already on projects so newly
  // added people show up even before their first paid row exists.
  const availablePhotographers = useMemo(() => {
    const set = new Set<string>();
    for (const r of rawRows) {
      if (r.person_name) set.add(r.person_name);
    }
    for (const p of projects.data ?? []) {
      for (const ph of p.photographers ?? []) set.add(ph);
    }
    for (const item of approvedPayQuery.data ?? []) {
      const name = item.team_member?.display_name?.trim();
      if (name) set.add(name);
    }
    return Array.from(set).sort();
  }, [rawRows, projects.data, approvedPayQuery.data]);

  function exportCsv() {
    if (rows.length === 0) {
      toast.error('Nothing to export');
      return;
    }
    const yMap = new Map((years.data ?? []).map((y) => [y.id, y.label || y.year_value.toString()]));
    const cMap = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
    const data = rows.map((r) => ({
      date: r.expense_date,
      year: yMap.get(r.project?.year_id ?? '') ?? '',
      project: r.project?.name ?? '',
      project_type: r.project?.project_type ?? '',
      photographers: (r.project?.photographers ?? []).join('; '),
      category: cMap.get(r.category_id) ?? '',
      description: r.description,
      amount: Number(r.amount).toFixed(2),
      currency: r.currency,
      location: r.location || r.project?.location || '',
      vendor: r.vendor ?? '',
      payment_method: r.payment_method ?? '',
      notes: r.notes ?? '',
    }));
    exportToCsv(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, data);
  }

  function exportSummariesCsv() {
    const m = metric;
    exportToCsv(`summaries-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['Metric', m === 'sum' ? 'Sum' : 'Average per expense'],
      ['Section', 'Bucket', 'Value'],
      ...byYear.map((b) => ['Year', b.label, valueOf(b, m).toFixed(2)]),
      ...byProject.map((b) => ['Project', b.label, valueOf(b, m).toFixed(2)]),
      ...byCategory.map((b) => ['Category', b.label, valueOf(b, m).toFixed(2)]),
      ...byProjectType.map((b) => ['Project type', b.label, valueOf(b, m).toFixed(2)]),
      ...byLocation.map((b) => ['Location', b.label, valueOf(b, m).toFixed(2)]),
      ...byPhotographer.map((b) => ['Photographer', b.label, valueOf(b, m).toFixed(2)]),
      ...byTeamSize.map((b) => ['Team size', b.label, valueOf(b, m).toFixed(2)]),
      ...trend.map((r) => [granularity === 'month' ? 'Month' : 'Year', r.period, r.amount.toFixed(2)]),
    ]);
  }

  const firstError =
    years.error || projects.error || categories.error || expensesQuery.error || null;
  const anyLoading =
    years.isLoading || projects.isLoading || categories.isLoading || expensesQuery.isLoading;

  return (
    <div className="flex flex-col gap-3">
      {firstError && (
        <div
          role="alert"
          className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          <strong>Data load error:</strong>{' '}
          {firstError instanceof Error ? firstError.message : String(firstError)}
        </div>
      )}

      {/* ---- Header ---- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
          <p className="text-xs text-slate-500">
            {anyLoading
              ? 'Loading…'
              : `${totals.count} expense${totals.count === 1 ? '' : 's'} across ${totals.projectCount} project${totals.projectCount === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={() => setFilters(emptyFilters)}>
            Clear filters
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={() => setShowPivot((v) => !v)}>
            {showPivot ? 'Hide pivot' : 'Show pivot'}
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={exportSummariesCsv}>
            Export summaries
          </button>
          <button type="button" className="btn-primary text-xs" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      {/* ---- Headline P&L (always sums; this is what they're paying for) ---- */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <PnlCard label="Client paid" value={formatMoney(pnl.paid)} tone="paid" />
        <PnlCard label="Spent" value={formatMoney(pnl.spent)} tone="spent" />
        <PnlCard
          label="Profit"
          value={formatMoney(pnl.profit)}
          tone={pnl.profit >= 0 ? 'profit' : 'loss'}
        />
      </div>

      {/* ---- Filters ---- */}
      <CompactFilters
        filters={filters}
        onChange={setFilters}
        years={years.data ?? []}
        projects={projects.data ?? []}
        categories={categories.data ?? []}
        locations={availableLocations}
        projectTypes={availableProjectTypes}
        photographers={availablePhotographers}
      />

      {/* ---- Secondary KPIs + metric toggle ---- */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid grow grid-cols-3 gap-2">
          <Kpi label="Projects in scope" value={totals.projectCount.toString()} />
          <Kpi label="Line items" value={totals.count.toString()} />
          <Kpi label="Avg / project" value={formatMoney(totals.avgPerProject)} />
        </div>
        <div className="flex items-center gap-2 self-end">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Chart metric
          </span>
          <Toggle
            value={metric}
            onChange={(v) => setMetric(v as Metric)}
            options={[
              { value: 'sum', label: 'Sum' },
              { value: 'avg', label: 'Avg per expense' },
            ]}
          />
        </div>
      </div>

      {/* ---- Charts: 3 cols x 2 rows ---- */}
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
        <ChartCard title="By year" empty={byYear.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byYear.map((b) => ({ ...b, v: valueOf(b, metric) }))} margin={chartMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMoneyCompact(v)} />
              <Tooltip formatter={(v: number) => formatMoney(v)} />
              <Bar dataKey="v" fill="#1d4ed8" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="By category" empty={byCategory.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={byCategory.map((b) => ({ ...b, v: valueOf(b, metric) }))}
                dataKey="v"
                nameKey="label"
                outerRadius="75%"
                innerRadius="45%"
                paddingAngle={2}
              >
                {byCategory.map((c) => (
                  <Cell key={c.key} fill={c.color ?? '#94a3b8'} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number) => formatMoney(v)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="By project type" empty={byProjectType.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={byProjectType.slice(0, 10).map((b) => ({ ...b, v: valueOf(b, metric) }))}
              layout="vertical"
              margin={chartMargin}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMoneyCompact(v)} />
              <YAxis type="category" dataKey="label" width={110} interval={0} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => formatMoney(v)} />
              <Bar dataKey="v" fill="#0f766e" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Top projects" empty={byProject.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={byProject.slice(0, 10).map((b) => ({ ...b, v: valueOf(b, metric) }))}
              layout="vertical"
              margin={chartMargin}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMoneyCompact(v)} />
              <YAxis type="category" dataKey="label" width={110} interval={0} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => formatMoney(v)} />
              <Bar dataKey="v" fill="#475569" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="By location" empty={byLocation.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={byLocation.slice(0, 10).map((b) => ({ ...b, v: valueOf(b, metric) }))}
              layout="vertical"
              margin={chartMargin}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMoneyCompact(v)} />
              <YAxis type="category" dataKey="label" width={110} interval={0} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => formatMoney(v)} />
              <Bar dataKey="v" fill="#7c3aed" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title={granularity === 'month' ? 'Monthly trend' : 'Yearly trend'}
          empty={trend.length === 0}
          headerExtra={
            <div className="flex items-center gap-1">
              <Toggle
                value={granularity}
                onChange={(v) => setGranularity(v as Granularity)}
                options={[
                  { value: 'month', label: 'Month' },
                  { value: 'year', label: 'Year' },
                ]}
              />
              <Toggle
                value={trendBasis}
                onChange={(v) => setTrendBasis(v as TrendBasis)}
                options={[
                  { value: 'project_end', label: 'Project end' },
                  { value: 'actual', label: 'Actual date' },
                ]}
              />
            </div>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={chartMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={formatTrendTick} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMoneyCompact(v)} />
              <Tooltip
                formatter={(v: number) => formatMoney(v)}
                labelFormatter={(label: string) => formatTrendTick(label)}
              />
              <Line dataKey="amount" stroke="#1d4ed8" strokeWidth={2} dot />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ---- People & team size ---- */}
      <div className="mt-2 border-t border-slate-200 pt-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Team</h2>
        <p className="text-xs text-slate-500">
          By photographer counts only line items attributed to a specific person (typically rows
          under Photographer Pay). By team size groups every expense by the number of
          photographers on its project.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <ChartCard title="By photographer" empty={byPhotographer.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={byPhotographer.slice(0, 12).map((b) => ({ ...b, v: valueOf(b, metric) }))}
              layout="vertical"
              margin={chartMargin}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMoneyCompact(v)} />
              <YAxis type="category" dataKey="label" width={140} interval={0} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => formatMoney(v)} />
              <Bar dataKey="v" fill="#0369a1" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="By team size" empty={byTeamSize.length === 0}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={byTeamSize.map((b) => ({ ...b, v: valueOf(b, metric) }))} margin={chartMargin}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => formatMoneyCompact(v)} />
              <Tooltip formatter={(v: number) => formatMoney(v)} />
              <Bar dataKey="v" fill="#b45309" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {showPivot && (
        <div className="card max-h-72 overflow-auto p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Category × Year
          </h3>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-1 font-medium">Category</th>
                {pivot.yearLabels.map((y) => (
                  <th key={y} className="px-2 py-1 text-right font-medium">
                    {y}
                  </th>
                ))}
                <th className="px-2 py-1 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pivot.cats.map((c) => {
                const row = pivot.data[c] ?? {};
                const total = pivot.yearLabels.reduce((acc, y) => acc + (row[y] ?? 0), 0);
                return (
                  <tr key={c}>
                    <td className="px-2 py-1 font-medium">{c}</td>
                    {pivot.yearLabels.map((y) => (
                      <td key={y} className="px-2 py-1 text-right tabular-nums">
                        {row[y] ? formatMoney(row[y]!) : '—'}
                      </td>
                    ))}
                    <td className="px-2 py-1 text-right font-semibold tabular-nums">
                      {formatMoney(total)}
                    </td>
                  </tr>
                );
              })}
              {pivot.cats.length === 0 && (
                <tr>
                  <td colSpan={pivot.yearLabels.length + 2} className="px-2 py-3 text-slate-500">
                    No data for the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const chartMargin = { top: 4, right: 8, left: -12, bottom: 0 };

function PnlCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'paid' | 'spent' | 'profit' | 'loss';
}) {
  const accent =
    tone === 'paid'
      ? 'border-l-4 border-slate-900'
      : tone === 'spent'
        ? 'border-l-4 border-slate-400'
        : tone === 'profit'
          ? 'border-l-4 border-emerald-600'
          : 'border-l-4 border-red-600';
  const valueClass =
    tone === 'profit' ? 'text-emerald-700' : tone === 'loss' ? 'text-red-700' : 'text-slate-900';
  return (
    <div className={`card flex flex-col px-4 py-3 ${accent}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <span className={`mt-0.5 text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="card flex flex-col px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="truncate text-base font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function ChartCard({
  title,
  children,
  empty,
  className,
  headerExtra,
}: {
  title: string;
  children: React.ReactNode;
  empty?: boolean;
  className?: string;
  headerExtra?: React.ReactNode;
}) {
  return (
    <div className={`card flex h-56 flex-col p-2 ${className ?? ''}`}>
      <div className="mb-1 flex shrink-0 items-center justify-between gap-2 px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
        {headerExtra}
      </div>
      <div className="relative min-h-0 flex-1">
        {empty ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-400">
            No data for the current filters
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function Toggle({
  value,
  onChange,
  options,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  title?: string;
}) {
  return (
    <div
      role="group"
      title={title}
      className="inline-flex overflow-hidden rounded border border-slate-300 bg-white"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-2 py-0.5 text-[10px] font-medium ${
            value === o.value
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-50'
          }`}
          aria-pressed={value === o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface CompactFiltersProps {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
  years: { id: string; label: string | null; year_value: number }[];
  projects: { id: string; name: string; year_id: string }[];
  categories: { id: string; name: string }[];
  locations: string[];
  projectTypes: string[];
  photographers: string[];
}

function CompactFilters({
  filters,
  onChange,
  years,
  projects,
  categories,
  locations,
  projectTypes,
  photographers,
}: CompactFiltersProps) {
  function toggle<K extends keyof DashboardFilters>(key: K, value: string) {
    const current = filters[key] as unknown as string[];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...filters, [key]: next });
  }

  return (
    <div className="card flex shrink-0 flex-wrap items-center gap-2 px-2 py-1.5">
      <MultiDropdown
        label="Years"
        values={filters.yearIds}
        onToggle={(v) => toggle('yearIds', v)}
        options={years.map((y) => ({ value: y.id, label: y.label || y.year_value.toString() }))}
      />
      <MultiDropdown
        label="Projects"
        values={filters.projectIds}
        onToggle={(v) => toggle('projectIds', v)}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
      />
      <MultiDropdown
        label="Types"
        values={filters.projectTypes}
        onToggle={(v) => toggle('projectTypes', v)}
        options={projectTypes.map((t) => ({ value: t, label: t }))}
      />
      <MultiDropdown
        label="Photographers"
        values={filters.photographers}
        onToggle={(v) => toggle('photographers', v)}
        options={photographers.map((p) => ({ value: p, label: p }))}
      />
      <MultiDropdown
        label="Categories"
        values={filters.categoryIds}
        onToggle={(v) => toggle('categoryIds', v)}
        options={categories.map((c) => ({ value: c.id, label: c.name }))}
      />
      <MultiDropdown
        label="Locations"
        values={filters.locations}
        onToggle={(v) => toggle('locations', v)}
        options={locations.map((l) => ({ value: l, label: l }))}
      />
      <div className="flex items-center gap-1">
        <input
          type="date"
          aria-label="From"
          className="input h-7 w-32 py-0 text-xs"
          value={filters.startDate ?? ''}
          onChange={(e) => onChange({ ...filters, startDate: e.target.value || null })}
        />
        <span className="text-xs text-slate-400">→</span>
        <input
          type="date"
          aria-label="To"
          className="input h-7 w-32 py-0 text-xs"
          value={filters.endDate ?? ''}
          onChange={(e) => onChange({ ...filters, endDate: e.target.value || null })}
        />
      </div>
      <input
        type="search"
        placeholder="Search description, vendor, notes…"
        className="input h-7 min-w-[12rem] flex-1 py-0 text-xs"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
      />
    </div>
  );
}

function MultiDropdown({
  label,
  values,
  onToggle,
  options,
}: {
  label: string;
  values: string[];
  onToggle: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const summary =
    values.length === 0 ? 'All' : values.length === 1 ? '1 selected' : `${values.length} selected`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 items-center gap-1 rounded border border-slate-300 bg-white px-2 text-xs hover:bg-slate-50"
        aria-expanded={open}
      >
        <span className="font-medium text-slate-700">{label}:</span>
        <span className="text-slate-600">{summary}</span>
        <span aria-hidden className="text-slate-400">
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-8 z-20 max-h-64 w-56 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg">
            {options.length === 0 && (
              <div className="px-2 py-1 text-xs text-slate-400">No options</div>
            )}
            {options.map((o) => (
              <label
                key={o.value}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={values.includes(o.value)}
                  onChange={() => onToggle(o.value)}
                />
                <span className="truncate">{o.label}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
