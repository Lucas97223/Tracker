import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useSyncContext } from '../providers/SyncProvider';

// Sell & onboard (Phase 5): catalog, proposals + Win, contracts, scheduler.

export const sellKey = ['sell'] as const;

export interface CatalogItem {
  id: string;
  org_id: string;
  kind: 'service' | 'product' | 'package';
  name: string;
  description: string | null;
  default_qty: string;
  unit_price: string;
  tax_rate_id: string | null;
  estimated_cost: string | null;
  estimated_hours: string | null;
  is_active: boolean;
}

export interface Proposal {
  id: string;
  org_id: string;
  contact_id: string;
  deal_id: string | null;
  title: string;
  project_type: string | null;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
  share_token: string;
  deposit_pct: string;
  valid_until: string | null;
  task_template_id: string | null;
  memo: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_name: string | null;
  project_id: string | null;
  contract_id: string | null;
  invoice_id: string | null;
  created_at: string;
  contact?: { name: string } | null;
}

export interface ProposalLine {
  id: string;
  proposal_id: string;
  catalog_item_id: string | null;
  description: string;
  qty: string;
  unit_price: string;
  tax_rate_id: string | null;
  estimated_cost: string | null;
  estimated_hours: string | null;
  line_number: number;
}

export interface ProposalTotals {
  proposal_id: string;
  subtotal: string;
  tax_total: string;
  total: string;
  estimated_cost: string;
  estimated_hours: string;
}

export interface ProjectTypeCost {
  org_id: string;
  project_type: string;
  projects: number;
  avg_cost: string;
  avg_revenue: string;
  avg_margin: string;
}

export interface Contract {
  id: string;
  org_id: string;
  contact_id: string;
  project_id: string | null;
  proposal_id: string | null;
  title: string;
  status: 'draft' | 'sent' | 'signed' | 'void';
  body_md: string;
  share_token: string;
  signed_at: string | null;
  created_at: string;
  contact?: { name: string } | null;
}

export interface AppointmentType {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  minutes: number;
  buffer_minutes: number;
  share_token: string;
  is_active: boolean;
}

export interface AvailabilityRule {
  id: string;
  appointment_type_id: string | null;
  weekday: number; // ISO 1=Mon
  start_time: string;
  end_time: string;
}

export interface Booking {
  id: string;
  appointment_type_id: string;
  contact_id: string | null;
  name: string;
  email: string | null;
  starts_at: string;
  ends_at: string;
  status: 'confirmed' | 'cancelled';
  notes: string | null;
}

function invalidateSell(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: sellKey });
  qc.invalidateQueries({ queryKey: ['crm'] });
  qc.invalidateQueries({ queryKey: ['invoices'] });
  qc.invalidateQueries({ queryKey: ['projects'] });
  qc.invalidateQueries({ queryKey: ['contacts'] });
}

// ---------- catalog ----------

export function useCatalog() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...sellKey, 'catalog'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<CatalogItem[]> => {
      const { data, error } = await supabase.from('catalog_items').select('*').order('name');
      if (error) throw error;
      return (data ?? []) as CatalogItem[];
    },
  });
}

export function useSaveCatalogItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<CatalogItem> & { name: string }) => {
      const { id, ...fields } = input;
      const q = id
        ? supabase.from('catalog_items').update(fields).eq('id', id)
        : supabase.from('catalog_items').insert(fields);
      const { data, error } = await q.select('*').single();
      if (error) throw error;
      return data as CatalogItem;
    },
    onSuccess: () => invalidateSell(qc),
  });
}

// ---------- proposals ----------

export function useProposals() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...sellKey, 'proposals'] as const,
    enabled: isOnline,
    queryFn: async () => {
      const [proposals, lines, totals, typeCosts] = await Promise.all([
        supabase
          .from('proposals')
          // contacts is reachable via contracts too — pin the FK (PGRST201)
          .select('*, contact:contacts!proposals_contact_id_fkey(name)')
          .order('created_at', { ascending: false }),
        supabase.from('proposal_lines').select('*').order('line_number'),
        supabase.from('v_proposal_totals').select('*'),
        supabase.from('v_project_type_costs').select('*'),
      ]);
      for (const r of [proposals, lines, totals, typeCosts]) {
        if (r.error) throw r.error;
      }
      return {
        proposals: (proposals.data ?? []) as unknown as Proposal[],
        lines: (lines.data ?? []) as ProposalLine[],
        totals: new Map(
          ((totals.data ?? []) as ProposalTotals[]).map((t) => [t.proposal_id, t]),
        ),
        typeCosts: (typeCosts.data ?? []) as ProjectTypeCost[],
      };
    },
  });
}

export function useCreateProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      contact_id: string;
      deal_id?: string | null;
      title: string;
      project_type?: string | null;
      deposit_pct: number;
      valid_until?: string | null;
      task_template_id?: string | null;
      memo?: string | null;
      lines: Array<{
        catalog_item_id?: string | null;
        description: string;
        qty: number;
        unit_price: number;
        tax_rate_id?: string | null;
      }>;
    }) => {
      const { lines, deposit_pct, ...header } = input;
      const { data: proposal, error } = await supabase
        .from('proposals')
        .insert({ ...header, deposit_pct: deposit_pct.toFixed(2) })
        .select('*')
        .single();
      if (error) throw error;
      const p = proposal as Proposal;
      if (lines.length > 0) {
        const { error: lErr } = await supabase.from('proposal_lines').insert(
          lines.map((l, i) => ({
            proposal_id: p.id,
            catalog_item_id: l.catalog_item_id ?? null,
            description: l.description,
            qty: l.qty.toString(),
            unit_price: l.unit_price.toFixed(2),
            tax_rate_id: l.tax_rate_id ?? null,
            line_number: i + 1,
          })),
        );
        if (lErr) {
          await supabase.from('proposals').delete().eq('id', p.id);
          throw lErr;
        }
      }
      return p;
    },
    onSuccess: () => invalidateSell(qc),
  });
}

export function useUpdateProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }: { id: string; status?: Proposal['status']; memo?: string | null; valid_until?: string | null }) => {
      const { data, error } = await supabase
        .from('proposals')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as Proposal;
    },
    onSuccess: () => invalidateSell(qc),
  });
}

export function useWinProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('win_deal_manual', { p_proposal: id });
      if (error) throw error;
      return data as { project_id: string | null };
    },
    onSuccess: () => invalidateSell(qc),
  });
}

export function useUnwinProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase.rpc('unwin_proposal', { p_proposal: id });
      if (error) throw error;
      return data;
    },
    onSuccess: () => invalidateSell(qc),
  });
}

// ---------- contracts ----------

export function useContracts() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...sellKey, 'contracts'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<Contract[]> => {
      const { data, error } = await supabase
        .from('contracts')
        .select('*, contact:contacts!contracts_contact_id_fkey(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Contract[];
    },
  });
}

export function useSaveContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Contract> & { title?: string; contact_id?: string }) => {
      const { id, ...fields } = input;
      const q = id
        ? supabase.from('contracts').update(fields).eq('id', id)
        : supabase.from('contracts').insert(fields);
      const { data, error } = await q.select('*').single();
      if (error) throw error;
      return data as Contract;
    },
    onSuccess: () => invalidateSell(qc),
  });
}

// ---------- scheduler ----------

export function useScheduler() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...sellKey, 'scheduler'] as const,
    enabled: isOnline,
    queryFn: async () => {
      const [types, rules, bookings] = await Promise.all([
        supabase.from('appointment_types').select('*').order('name'),
        supabase.from('availability_rules').select('*').order('weekday'),
        supabase
          .from('bookings')
          .select('*')
          .gte('starts_at', new Date(Date.now() - 86400000).toISOString())
          .order('starts_at'),
      ]);
      for (const r of [types, rules, bookings]) {
        if (r.error) throw r.error;
      }
      return {
        types: (types.data ?? []) as AppointmentType[],
        rules: (rules.data ?? []) as AvailabilityRule[],
        bookings: (bookings.data ?? []) as Booking[],
      };
    },
  });
}

export function useSaveAppointmentType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<AppointmentType> & { name: string }) => {
      const { id, ...fields } = input;
      const q = id
        ? supabase.from('appointment_types').update(fields).eq('id', id)
        : supabase.from('appointment_types').insert(fields);
      const { data, error } = await q.select('*').single();
      if (error) throw error;
      return data as AppointmentType;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: sellKey }),
  });
}

export function useSaveAvailabilityRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { weekday: number; start_time: string; end_time: string }) => {
      const { error } = await supabase.from('availability_rules').insert(input);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: sellKey }),
  });
}

export function useDeleteAvailabilityRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('availability_rules').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: sellKey }),
  });
}

export function useCancelBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('bookings')
        .update({ status: 'cancelled' })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: sellKey }),
  });
}

// ---------- public (anon) surfaces ----------

export function usePublicProposal(token: string | undefined) {
  return useQuery({
    queryKey: ['public-proposal', token] as const,
    enabled: !!token,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_public_proposal', { p_token: token });
      if (error) throw error;
      return data as {
        title: string;
        status: string;
        valid_until: string | null;
        deposit_pct: string;
        memo: string | null;
        org_name: string;
        contact_name: string;
        accepted_at: string | null;
        lines: Array<{ description: string; qty: string; unit_price: string; amount: string; tax_name: string | null }>;
        totals: { subtotal: string; tax_total: string; total: string } | null;
      } | null;
    },
  });
}

export function useAcceptProposal() {
  return useMutation({
    mutationFn: async (input: { token: string; name: string }) => {
      const { data, error } = await supabase.rpc('accept_proposal', {
        p_token: input.token,
        p_name: input.name,
      });
      if (error) throw error;
      return data;
    },
  });
}

export function usePublicContract(token: string | undefined) {
  return useQuery({
    queryKey: ['public-contract', token] as const,
    enabled: !!token,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_public_contract', { p_token: token });
      if (error) throw error;
      return data as {
        title: string;
        status: string;
        body_md: string;
        signed_at: string | null;
        org_name: string;
        contact_name: string;
      } | null;
    },
  });
}

export function useSignContract() {
  return useMutation({
    mutationFn: async (input: { token: string; name: string; email?: string }) => {
      const { data, error } = await supabase.rpc('sign_contract', {
        p_token: input.token,
        p_name: input.name,
        p_email: input.email ?? null,
      });
      if (error) throw error;
      return data;
    },
  });
}

export function usePublicScheduler(token: string | undefined, from: string) {
  return useQuery({
    queryKey: ['public-scheduler', token, from] as const,
    enabled: !!token,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_public_scheduler', {
        p_token: token,
        p_from: from,
        p_days: 14,
      });
      if (error) throw error;
      return data as {
        name: string;
        description: string | null;
        minutes: number;
        org_name: string;
        timezone: string;
        slots: Array<{ starts_at: string; ends_at: string }>;
      } | null;
    },
  });
}

export function useBookSlot() {
  return useMutation({
    mutationFn: async (input: { token: string; starts_at: string; name: string; email?: string; notes?: string }) => {
      const { data, error } = await supabase.rpc('book_slot', {
        p_token: input.token,
        p_starts_at: input.starts_at,
        p_name: input.name,
        p_email: input.email ?? null,
        p_notes: input.notes ?? null,
      });
      if (error) throw error;
      return data;
    },
  });
}
