import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useSyncContext } from '../providers/SyncProvider';
import type { Contact, DealStatus } from '../types/database';

// CRM (Phase 4): pipeline/deals, lead forms, contact timeline, merge, search.
// All online-only.

export const crmKey = ['crm'] as const;

export interface PipelineStage {
  id: string;
  org_id: string;
  name: string;
  sort_order: number;
}

export interface Deal {
  id: string;
  org_id: string;
  contact_id: string;
  stage_id: string | null;
  status: DealStatus;
  title: string;
  estimated_value: string | null;
  expected_date: string | null;
  project_id: string | null;
  source: string | null;
  notes: string | null;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  contact?: { name: string } | null;
}

export function usePipeline() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...crmKey, 'pipeline'] as const,
    enabled: isOnline,
    queryFn: async () => {
      const [stages, deals] = await Promise.all([
        supabase.from('pipeline_stages').select('*').order('sort_order'),
        supabase
          .from('deals')
          .select('*, contact:contacts(name)')
          .order('sort_order')
          .order('created_at'),
      ]);
      if (stages.error) throw stages.error;
      if (deals.error) throw deals.error;
      return {
        stages: (stages.data ?? []) as PipelineStage[],
        deals: (deals.data ?? []) as unknown as Deal[],
      };
    },
  });
}

function invalidateCrm(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: crmKey });
  qc.invalidateQueries({ queryKey: ['contacts'] });
}

export interface DealInput {
  contact_id: string;
  title: string;
  estimated_value?: number | null;
  expected_date?: string | null;
  stage_id?: string | null;
  project_id?: string | null;
  notes?: string | null;
  source?: string | null;
}

export function useCreateDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DealInput) => {
      const { data, error } = await supabase
        .from('deals')
        .insert({
          ...input,
          estimated_value:
            input.estimated_value != null ? input.estimated_value.toFixed(2) : null,
        })
        .select('*')
        .single();
      if (error) throw error;
      return data as Deal;
    },
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useUpdateDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      estimated_value,
      ...patch
    }: { id: string; status?: DealStatus; lost_reason?: string | null; sort_order?: number } & Partial<DealInput>) => {
      const payload: Record<string, unknown> = { ...patch };
      if (estimated_value !== undefined) {
        payload.estimated_value = estimated_value != null ? estimated_value.toFixed(2) : null;
      }
      const { data, error } = await supabase
        .from('deals')
        .update(payload)
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as Deal;
    },
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useDeleteDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('deals').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateCrm(qc),
  });
}

// ---------- contact timeline + merge ----------

export interface ActivityRow {
  contact_id: string;
  org_id: string;
  happened_at: string;
  kind: string;
  summary: string | null;
  ref_id: string;
}

export function useContactActivity(contactId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...crmKey, 'activity', contactId] as const,
    enabled: !!contactId && isOnline,
    queryFn: async (): Promise<ActivityRow[]> => {
      const { data, error } = await supabase
        .from('v_contact_activity')
        .select('*')
        .eq('contact_id', contactId!)
        .order('happened_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as ActivityRow[];
    },
  });
}

export function useMergeContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { keep_id: string; dupe_id: string }) => {
      const { data, error } = await supabase.rpc('merge_contacts', {
        p_keep: input.keep_id,
        p_dupe: input.dupe_id,
      });
      if (error) throw error;
      return data as Contact;
    },
    onSuccess: () => invalidateCrm(qc),
  });
}

// ---------- lead forms ----------

export interface LeadForm {
  id: string;
  org_id: string;
  name: string;
  headline: string | null;
  description: string | null;
  share_token: string;
  is_active: boolean;
  creates_deal: boolean;
  deal_title: string;
  daily_cap: number;
  created_at: string;
}

export interface FormField {
  id: string;
  form_id: string;
  label: string;
  kind: 'text' | 'email' | 'phone' | 'textarea' | 'select' | 'date';
  required: boolean;
  options: string[];
  sort_order: number;
}

export interface FormResponse {
  id: string;
  form_id: string;
  contact_id: string | null;
  deal_id: string | null;
  answers: Record<string, string>;
  created_at: string;
}

export function useForms() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...crmKey, 'forms'] as const,
    enabled: isOnline,
    queryFn: async () => {
      const [forms, fields, responses] = await Promise.all([
        supabase.from('forms').select('*').order('created_at'),
        supabase.from('form_fields').select('*').order('sort_order'),
        supabase
          .from('form_responses')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);
      if (forms.error) throw forms.error;
      if (fields.error) throw fields.error;
      if (responses.error) throw responses.error;
      return {
        forms: (forms.data ?? []) as LeadForm[],
        fields: (fields.data ?? []) as FormField[],
        responses: (responses.data ?? []) as FormResponse[],
      };
    },
  });
}

export function useCreateForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      name: string;
      headline?: string | null;
      fields: Array<Pick<FormField, 'label' | 'kind' | 'required'>>;
    }) => {
      const { data: form, error } = await supabase
        .from('forms')
        .insert({ name: input.name, headline: input.headline ?? null })
        .select('*')
        .single();
      if (error) throw error;
      const f = form as LeadForm;
      if (input.fields.length > 0) {
        const { error: fErr } = await supabase.from('form_fields').insert(
          input.fields.map((x, i) => ({
            form_id: f.id,
            label: x.label,
            kind: x.kind,
            required: x.required,
            sort_order: i + 1,
          })),
        );
        if (fErr) {
          await supabase.from('forms').delete().eq('id', f.id);
          throw fErr;
        }
      }
      return f;
    },
    onSuccess: () => invalidateCrm(qc),
  });
}

export function useToggleForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from('forms')
        .update({ is_active: input.is_active })
        .eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => invalidateCrm(qc),
  });
}

export interface PublicForm {
  name: string;
  headline: string | null;
  description: string | null;
  org_name: string;
  fields: Array<{ id: string; label: string; kind: FormField['kind']; required: boolean; options: string[] }>;
}

export function usePublicForm(token: string | undefined) {
  return useQuery({
    queryKey: ['public-form', token] as const,
    enabled: !!token,
    retry: 1,
    queryFn: async (): Promise<PublicForm | null> => {
      const { data, error } = await supabase.rpc('get_public_form', { p_token: token });
      if (error) throw error;
      return (data as PublicForm) ?? null;
    },
  });
}

export function useSubmitPublicForm() {
  return useMutation({
    mutationFn: async (input: { token: string; answers: Record<string, string> }) => {
      const { error } = await supabase.rpc('submit_lead_form', {
        p_token: input.token,
        p_answers: input.answers,
      });
      if (error) throw error;
    },
  });
}

// ---------- universal search ----------

export interface SearchResult {
  kind: 'contact' | 'project' | 'task' | 'deal' | 'invoice';
  id: string;
  title: string;
  subtitle: string | null;
  project_id: string | null;
}

export function useSearch(query: string) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...crmKey, 'search', query] as const,
    enabled: isOnline && query.trim().length >= 2,
    staleTime: 10_000,
    queryFn: async (): Promise<SearchResult[]> => {
      const { data, error } = await supabase.rpc('search_all', {
        p_query: query.trim(),
        p_limit: 20,
      });
      if (error) throw error;
      return (data ?? []) as SearchResult[];
    },
  });
}
