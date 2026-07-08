import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { useDeleteYear, useUpdateYear, useYearRollups, useYears } from '../hooks/useYears';
import { useProjectRollups } from '../hooks/useProjects';
import { useAuth } from '../providers/AuthProvider';
import { formatMoney } from '../lib/money';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CreateProjectButton } from '../components/forms/CreateProjectButton';
import { useToast } from '../providers/ToastProvider';

export function YearPage() {
  const { yearId } = useParams<{ yearId: string }>();
  const navigate = useNavigate();
  const { canEdit } = useAuth();
  const toast = useToast();
  const years = useYears();
  const rollups = useYearRollups();
  const projects = useProjectRollups(yearId);
  const update = useUpdateYear();
  const del = useDeleteYear();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);

  const year = (years.data ?? []).find((y) => y.id === yearId);
  const rollup = (rollups.data ?? []).find((r) => r.year_id === yearId);
  const yearProjects = projects.data ?? [];

  if (years.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (!year) return <p className="text-sm text-slate-500">Year not found.</p>;

  const canDelete = yearProjects.length === 0;

  async function handleDelete() {
    if (!yearId) return;
    try {
      await del.mutateAsync(yearId);
      toast.success('Year deleted');
      navigate('/', { replace: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Year</div>
          <h1 className="text-xl font-semibold">{year.label || year.year_value}</h1>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <CreateProjectButton
              yearId={year.id}
              onCreated={(id) => navigate(`/projects/${id}`)}
              inline
            />
            <button type="button" className="btn-ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Done' : 'Rename'}
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => setConfirming(true)}
              disabled={!canDelete}
              title={canDelete ? 'Delete year' : 'Year is not empty'}
            >
              Delete
            </button>
          </div>
        )}
      </header>

      {editing && (
        <RenameForm
          initialLabel={year.label}
          onSave={async (label) => {
            await update.mutateAsync({ id: year.id, label: label || null });
            toast.success('Year updated');
            setEditing(false);
          }}
        />
      )}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi label="Total" value={formatMoney(rollup?.total_amount ?? '0')} />
        <Kpi label="Projects" value={(rollup?.project_count ?? yearProjects.length).toString()} />
        <Kpi label="Line items" value={(rollup?.expense_count ?? 0).toString()} />
      </section>

      <section className="card">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Projects</h2>
        </div>
        {yearProjects.length === 0 ? (
          <div className="px-4 py-6 text-sm text-slate-500">
            No projects yet.{' '}
            {canEdit && (
              <CreateProjectButton
                yearId={year.id}
                onCreated={(id) => navigate(`/projects/${id}`)}
                inline
              />
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {yearProjects.map((p) => (
              <li key={p.project_id}>
                <Link
                  to={`/projects/${p.project_id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-slate-50"
                >
                  <div>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs uppercase tracking-wide text-slate-500">{p.status}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium tabular-nums">{formatMoney(p.total_amount)}</div>
                    <div className="text-xs text-slate-500">{p.expense_count} items</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        title="Delete year?"
        description={
          canDelete
            ? 'This year is empty and will be permanently removed.'
            : 'This year has projects and cannot be deleted.'
        }
        confirmLabel="Delete"
        danger
        busy={del.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function RenameForm({
  initialLabel,
  onSave,
}: {
  initialLabel: string | null;
  onSave: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState(initialLabel ?? '');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onSave(label.trim());
      }}
      className="card flex items-end gap-2 p-3"
    >
      <div className="flex-1">
        <label className="label">Label</label>
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <button type="submit" className="btn-primary">
        Save
      </button>
    </form>
  );
}
