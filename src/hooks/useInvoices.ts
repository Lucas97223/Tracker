import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useSyncContext } from '../providers/SyncProvider';
import type {
  ArAgingRow,
  Invoice,
  InvoiceLine,
  InvoiceTotals,
  Payment,
  PublicInvoice,
  TaxRate,
} from '../types/database';

// Invoicing + payments (Phase 1). Invoices are operational documents (D7);
// only record_payment/void_payment touch the ledger, and only via RPC.

export const invoicesKey = ['invoices'] as const;

export type InvoiceWithDetails = Invoice & {
  contact: { name: string } | null;
  lines: InvoiceLine[];
  payments: Payment[];
  totals?: InvoiceTotals;
};

export function useInvoicesForProject(projectId: string | undefined) {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...invoicesKey, 'project', projectId] as const,
    enabled: !!projectId && isOnline,
    queryFn: async (): Promise<InvoiceWithDetails[]> => {
      if (!projectId) return [];
      const [{ data, error }, { data: totals, error: tErr }] = await Promise.all([
        supabase
          .from('invoices')
          .select('*, contact:contacts(name), lines:invoice_lines(*), payments:payments(*)')
          .eq('project_id', projectId)
          .order('number', { ascending: false }),
        supabase.from('v_invoice_totals').select('*'),
      ]);
      if (error) throw error;
      if (tErr) throw tErr;
      const totalsMap = new Map((totals ?? []).map((t) => [t.invoice_id as string, t as InvoiceTotals]));
      return ((data ?? []) as unknown as InvoiceWithDetails[]).map((inv) => ({
        ...inv,
        totals: totalsMap.get(inv.id),
      }));
    },
  });
}

export function useTaxRates() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: ['tax-rates'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<TaxRate[]> => {
      const { data, error } = await supabase
        .from('tax_rates')
        .select('*')
        .eq('is_active', true)
        .order('name');
      if (error) throw error;
      return (data ?? []) as TaxRate[];
    },
  });
}

export function useArAging() {
  const { isOnline } = useSyncContext();
  return useQuery({
    queryKey: [...invoicesKey, 'ar-aging'] as const,
    enabled: isOnline,
    queryFn: async (): Promise<ArAgingRow[]> => {
      const { data, error } = await supabase
        .from('v_ar_aging')
        .select('*')
        .order('days_overdue', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ArAgingRow[];
    },
  });
}

export interface InvoiceLineInput {
  description: string;
  qty: number;
  unit_price: number;
  tax_rate_id?: string | null;
}

export interface CreateInvoiceInput {
  contact_id: string;
  project_id?: string | null;
  issue_date?: string;
  due_date?: string | null;
  memo?: string | null;
  lines: InvoiceLineInput[];
}

function invalidateMoney(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: invoicesKey });
  qc.invalidateQueries({ queryKey: ['reports'] });
  qc.invalidateQueries({ queryKey: ['journal'] });
  qc.invalidateQueries({ queryKey: ['projects'] });
  qc.invalidateQueries({ queryKey: ['project'] });
  qc.invalidateQueries({ queryKey: ['dashboard'] });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInvoiceInput): Promise<Invoice> => {
      const { lines, ...header } = input;
      const { data: invoice, error } = await supabase
        .from('invoices')
        .insert(header)
        .select('*')
        .single();
      if (error) throw error;
      const inv = invoice as Invoice;
      if (lines.length > 0) {
        const payload = lines.map((l, idx) => ({
          invoice_id: inv.id,
          description: l.description,
          qty: l.qty.toString(),
          unit_price: l.unit_price.toFixed(2),
          tax_rate_id: l.tax_rate_id ?? null,
          line_number: idx + 1,
        }));
        const { error: lineErr } = await supabase.from('invoice_lines').insert(payload);
        if (lineErr) {
          // Draft creation isn't a money posting, but don't leave a headless
          // draft behind if the lines failed.
          await supabase.from('invoices').delete().eq('id', inv.id);
          throw lineErr;
        }
      }
      return inv;
    },
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from('invoices')
        .update({ status: 'sent' })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as Invoice;
    },
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useVoidInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from('invoices')
        .update({ status: 'void' })
        .eq('id', id)
        .select('*')
        .single();
      if (error) throw error;
      return data as Invoice;
    },
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      invoice_id: string;
      amount: number;
      payment_date?: string;
      method?: string | null;
      reference?: string | null;
    }) => {
      const { data, error } = await supabase.rpc('record_payment', {
        p_invoice: input.invoice_id,
        p_amount: input.amount,
        p_date: input.payment_date ?? new Date().toISOString().slice(0, 10),
        p_method: input.method ?? null,
        p_reference: input.reference ?? null,
      });
      if (error) throw error;
      return data as Payment;
    },
    onSuccess: () => invalidateMoney(qc),
  });
}

export function useVoidPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paymentId: string) => {
      const { data, error } = await supabase.rpc('void_payment', { p_payment: paymentId });
      if (error) throw error;
      return data as Payment;
    },
    onSuccess: () => invalidateMoney(qc),
  });
}

/** Public (anon-capable) invoice fetch by share token. */
export function usePublicInvoice(token: string | undefined) {
  return useQuery({
    queryKey: ['public-invoice', token] as const,
    enabled: !!token,
    retry: 1,
    queryFn: async (): Promise<PublicInvoice | null> => {
      if (!token) return null;
      const { data, error } = await supabase.rpc('get_public_invoice', { p_token: token });
      if (error) throw error;
      return (data as PublicInvoice) ?? null;
    },
  });
}
