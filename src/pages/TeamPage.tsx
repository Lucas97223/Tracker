import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useTeamMembers, teamKey } from '../hooks/useTeam';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import type { MemberRate } from '../types/database';

// Admin-only: the roster with logins, rates, and duplicate cleanup. Rates
// live in member_rates (owner/admin RLS) — never readable by other roles.

function useMemberRates() {
  const { isAdmin } = useAuth();
  return useQuery({
    queryKey: [...teamKey, 'rates'] as const,
    enabled: isAdmin,
    queryFn: async (): Promise<MemberRate[]> => {
      const { data, error } = await supabase.from('member_rates').select('*');
      if (error) throw error;
      return (data ?? []) as MemberRate[];
    },
  });
}

export function TeamPage() {
  const { isAdmin } = useAuth();
  const team = useTeamMembers();
  const rates = useMemberRates();
  const qc = useQueryClient();
  const toast = useToast();
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);

  const rateByMember = useMemo(
    () => new Map((rates.data ?? []).map((r) => [r.team_member_id, r])),
    [rates.data],
  );

  const saveMember = useMutation({
    mutationFn: async (input: { id: string; display_name?: string; email?: string | null }) => {
      const { id, ...patch } = input;
      const { error } = await supabase.from('team_members').update(patch).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKey }),
  });

  const saveRate = useMutation({
    mutationFn: async (input: { team_member_id: string; cost_rate: number | null; bill_rate: number | null }) => {
      const { error } = await supabase.from('member_rates').upsert(
        {
          team_member_id: input.team_member_id,
          cost_rate: input.cost_rate?.toFixed(2) ?? null,
          bill_rate: input.bill_rate?.toFixed(2) ?? null,
        },
        { onConflict: 'team_member_id' },
      );
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: teamKey }),
  });

  const mergeMembers = useMutation({
    mutationFn: async (input: { keep: string; dupe: string }) => {
      const { error } = await supabase.rpc('merge_team_members', {
        p_keep: input.keep,
        p_dupe: input.dupe,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKey });
      qc.invalidateQueries({ queryKey: ['pay-items'] });
      qc.invalidateQueries({ queryKey: ['time'] });
    },
  });

  if (!isAdmin) {
    return <p className="text-sm text-slate-500">Team management is for organization admins.</p>;
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold">Team & Rates</h1>
        <p className="mt-1 text-sm text-slate-500">
          Rates are visible to owners/admins only. Time entries snapshot rates when logged — set
          them before the week starts. New rates apply to new entries.
        </p>
      </header>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Login</th>
              <th className="px-4 py-2 text-right">Cost rate /h</th>
              <th className="px-4 py-2 text-right">Bill rate /h</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {(team.data ?? []).map((m) => {
              const rate = rateByMember.get(m.id);
              return (
                <tr key={m.id} className="border-b border-slate-50">
                  <td className="px-4 py-1.5">
                    <input
                      className="input !py-1"
                      defaultValue={m.display_name}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== m.display_name) {
                          void saveMember
                            .mutateAsync({ id: m.id, display_name: v })
                            .then(() => toast.success('Renamed'))
                            .catch((err) => toast.error(err instanceof Error ? err.message : 'Rename failed'));
                        }
                      }}
                    />
                  </td>
                  <td className="px-4 py-1.5">
                    <input
                      className="input !py-1"
                      placeholder="link a future login…"
                      defaultValue={(m as { email?: string | null }).email ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim() || null;
                        void saveMember
                          .mutateAsync({ id: m.id, email: v })
                          .catch((err) => toast.error(err instanceof Error ? err.message : 'Save failed'));
                      }}
                    />
                  </td>
                  <td className="px-4 py-1.5">
                    {m.profile_id ? (
                      <span className="badge bg-emerald-100 text-emerald-800">linked</span>
                    ) : (
                      <span className="badge bg-slate-100 text-slate-500">no login</span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input w-24 !py-1 text-right"
                      defaultValue={rate?.cost_rate ?? ''}
                      onBlur={(e) =>
                        void saveRate
                          .mutateAsync({
                            team_member_id: m.id,
                            cost_rate: e.target.value === '' ? null : Number(e.target.value),
                            bill_rate: rate?.bill_rate != null ? Number(rate.bill_rate) : null,
                          })
                          .catch((err) => toast.error(err instanceof Error ? err.message : 'Save failed'))
                      }
                    />
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input w-24 !py-1 text-right"
                      defaultValue={rate?.bill_rate ?? ''}
                      onBlur={(e) =>
                        void saveRate
                          .mutateAsync({
                            team_member_id: m.id,
                            cost_rate: rate?.cost_rate != null ? Number(rate.cost_rate) : null,
                            bill_rate: e.target.value === '' ? null : Number(e.target.value),
                          })
                          .catch((err) => toast.error(err instanceof Error ? err.message : 'Save failed'))
                      }
                    />
                  </td>
                  <td className="px-4 py-1.5 text-right">
                    {mergeFrom === null ? (
                      <button type="button" className="btn-ghost !py-0.5 text-xs" onClick={() => setMergeFrom(m.id)}>
                        Merge into…
                      </button>
                    ) : mergeFrom === m.id ? (
                      <button type="button" className="btn-ghost !py-0.5 text-xs" onClick={() => setMergeFrom(null)}>
                        Cancel
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary !py-0.5 text-xs"
                        onClick={() => {
                          const dupe = mergeFrom;
                          setMergeFrom(null);
                          void mergeMembers
                            .mutateAsync({ keep: m.id, dupe })
                            .then(() => toast.success('Merged — history repointed'))
                            .catch((err) => toast.error(err instanceof Error ? err.message : 'Merge failed'));
                        }}
                      >
                        ← keep this one
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {mergeFrom && (
        <p className="text-sm text-amber-700">
          Merging: pick the row to <strong>keep</strong> — the other one's time, pay, tasks and
          staffing move onto it, then it's removed.
        </p>
      )}
    </div>
  );
}
