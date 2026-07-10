import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { usePipeline } from '../hooks/useCrm';
import { useTaskTemplates } from '../hooks/useTasks';
import { useTeamMembers } from '../hooks/useTeam';
import { Modal } from '../components/Modal';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

interface Automation {
  id: string;
  org_id: string;
  name: string;
  trigger_event: string;
  condition: Record<string, string>;
  action: string;
  action_config: Record<string, string>;
  is_active: boolean;
  created_at: string;
}

interface AutomationRun {
  id: string;
  automation_id: string;
  trigger_event: string;
  status: 'ok' | 'error' | 'skipped';
  detail: string | null;
  created_at: string;
}

const TRIGGERS: Record<string, string> = {
  form_response: 'A lead form is submitted',
  booking_created: 'A booking is made',
  deal_stage_changed: 'A deal moves stage / closes',
  invoice_paid: 'An invoice is fully paid',
  project_created: 'A project is created',
};

const ACTIONS: Record<string, string> = {
  create_task: 'Create a task on the project',
  notify: 'Notify the admins',
  apply_template: 'Apply a task template to the project',
};

const RECIPES: Array<{ label: string; hint: string; rule: Partial<Automation> }> = [
  {
    label: '🙏 Thank-you after payment',
    hint: 'When an invoice is paid, add a "send thank-you + gallery" task (due in 3 days).',
    rule: {
      name: 'Thank-you after payment', trigger_event: 'invoice_paid', action: 'create_task',
      action_config: { title: 'Send thank-you + gallery link', due_days: '3' },
    },
  },
  {
    label: '📨 New-lead ping',
    hint: 'When a lead form is submitted, notify the admins.',
    rule: {
      name: 'New-lead ping', trigger_event: 'form_response', action: 'notify',
      action_config: { message: 'New lead form submission' },
    },
  },
  {
    label: '📅 Booking heads-up',
    hint: 'When someone books a call, notify the admins.',
    rule: {
      name: 'Booking heads-up', trigger_event: 'booking_created', action: 'notify',
      action_config: { message: 'New booking' },
    },
  },
];

function useAutomations() {
  return useQuery({
    queryKey: ['automations'] as const,
    queryFn: async () => {
      const [rules, runs] = await Promise.all([
        supabase.from('automations').select('*').order('created_at'),
        supabase
          .from('automation_runs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(30),
      ]);
      if (rules.error) throw rules.error;
      if (runs.error) throw runs.error;
      return {
        rules: (rules.data ?? []) as Automation[],
        runs: (runs.data ?? []) as AutomationRun[],
      };
    },
  });
}

export function AutomationsPage() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const data = useAutomations();
  const pipeline = usePipeline();
  const templates = useTaskTemplates();
  const team = useTeamMembers();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<Automation> | null>(null);

  const save = useMutation({
    mutationFn: async (rule: Partial<Automation>) => {
      const { id, ...fields } = rule;
      const q = id
        ? supabase.from('automations').update(fields).eq('id', id)
        : supabase.from('automations').insert(fields);
      const { error } = await q;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('automations').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automations'] }),
  });

  if (!isAdmin) {
    return <p className="text-sm text-slate-500">Automations are managed by organization admins.</p>;
  }

  const rules = data.data?.rules ?? [];
  const runs = data.data?.runs ?? [];
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">Automations</h1>
        <p className="mt-1 text-sm text-slate-500">
          When something happens, do something — logged, capped, and loop-proof.
        </p>
      </header>

      <section className="card">
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Rules</h2>
          <button type="button" className="btn-primary" onClick={() => setEditing({})}>
            + Rule
          </button>
        </header>
        {rules.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">No rules yet — try a recipe below.</p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
                <span className={`badge ${r.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}>
                  {r.is_active ? 'on' : 'off'}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-slate-800">{r.name}</span>
                  <span className="ml-2 text-xs text-slate-400">
                    {TRIGGERS[r.trigger_event]} → {ACTIONS[r.action]}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-ghost !py-0.5 text-xs"
                  onClick={() =>
                    void save.mutateAsync({ id: r.id, is_active: !r.is_active })
                      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                  }
                >
                  {r.is_active ? 'Turn off' : 'Turn on'}
                </button>
                <button
                  type="button"
                  className="btn-ghost !py-0.5 text-xs"
                  onClick={() =>
                    void remove.mutateAsync(r.id)
                      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
                  }
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recipe gallery
          </h2>
        </header>
        <div className="grid gap-3 p-4 md:grid-cols-3">
          {RECIPES.map((rec) => (
            <button
              key={rec.label}
              type="button"
              className="rounded border border-slate-200 p-3 text-left text-sm hover:border-slate-300"
              onClick={() =>
                void save.mutateAsync(rec.rule)
                  .then(() => toast.success('Rule created — it is live'))
                  .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed'))
              }
            >
              <p className="font-medium text-slate-800">{rec.label}</p>
              <p className="mt-1 text-xs text-slate-500">{rec.hint}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <header className="border-b border-slate-100 px-4 py-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Recent runs
          </h2>
        </header>
        {runs.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500">Nothing has fired yet.</p>
        ) : (
          <ul className="divide-y divide-slate-50">
            {runs.map((run) => (
              <li key={run.id} className="flex items-center gap-3 px-4 py-1.5 text-sm">
                <span
                  className={`badge ${
                    run.status === 'ok'
                      ? 'bg-emerald-100 text-emerald-800'
                      : run.status === 'skipped'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-red-100 text-red-700'
                  }`}
                >
                  {run.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-700">
                  {ruleName.get(run.automation_id) ?? 'Rule'}
                  {run.detail && <span className="ml-2 text-xs text-slate-400">{run.detail}</span>}
                </span>
                <span className="text-xs text-slate-400">
                  {new Date(run.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && (
        <RuleModal
          rule={editing}
          stages={pipeline.data?.stages ?? []}
          templates={templates.data ?? []}
          team={team.data ?? []}
          onSave={(rule) =>
            void save.mutateAsync(rule)
              .then(() => {
                toast.success('Rule saved');
                setEditing(null);
              })
              .catch((e) => toast.error(e instanceof Error ? e.message : 'Save failed'))
          }
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function RuleModal({
  rule,
  stages,
  templates,
  team,
  onSave,
  onClose,
}: {
  rule: Partial<Automation>;
  stages: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string }>;
  team: Array<{ id: string; display_name: string }>;
  onSave: (rule: Partial<Automation>) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(rule.name ?? '');
  const [trigger, setTrigger] = useState(rule.trigger_event ?? 'invoice_paid');
  const [action, setAction] = useState(rule.action ?? 'create_task');
  const [config, setConfig] = useState<Record<string, string>>(rule.action_config ?? {});
  const [stageId, setStageId] = useState(rule.condition?.stage_id ?? '');

  function set(key: string, value: string) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  return (
    <Modal open title={rule.id ? 'Edit rule' : 'New rule'} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Name
          <input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          When
          <select className="input mt-1 w-full" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            {Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {trigger === 'deal_stage_changed' && (
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Only when moved to
            <select className="input mt-1 w-full" value={stageId} onChange={(e) => setStageId(e.target.value)}>
              <option value="">Any stage</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Then
          <select className="input mt-1 w-full" value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>

        {action === 'create_task' && (
          <>
            <input className="input w-full" placeholder="Task title"
              value={config.title ?? ''} onChange={(e) => set('title', e.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <input className="input" type="number" min="0" placeholder="Due in N days"
                value={config.due_days ?? ''} onChange={(e) => set('due_days', e.target.value)} />
              <select className="input" value={config.assignee_team_member_id ?? ''}
                onChange={(e) => set('assignee_team_member_id', e.target.value)}>
                <option value="">Unassigned</option>
                {team.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </select>
            </div>
          </>
        )}
        {action === 'notify' && (
          <input className="input w-full" placeholder="Notification message"
            value={config.message ?? ''} onChange={(e) => set('message', e.target.value)} />
        )}
        {action === 'apply_template' && (
          <select className="input w-full" value={config.template_id ?? ''}
            onChange={(e) => set('template_id', e.target.value)}>
            <option value="">Pick a template…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-primary"
            disabled={!name.trim()}
            onClick={() =>
              onSave({
                id: rule.id,
                name: name.trim(),
                trigger_event: trigger,
                action,
                action_config: config,
                condition: trigger === 'deal_stage_changed' && stageId ? { stage_id: stageId } : {},
              })
            }
          >
            Save rule
          </button>
        </div>
      </div>
    </Modal>
  );
}
