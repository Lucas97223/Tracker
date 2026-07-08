import { useQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import type {
  CategoryRollup,
  Expense,
  LocationRollup,
  MonthlyRollup,
  ProjectRollup,
  YearRollup,
} from '../types/database';

export interface DashboardFilters {
  yearIds: string[];
  projectIds: string[];
  categoryIds: string[];
  locations: string[];
  projectTypes: string[];
  photographers: string[];
  startDate: string | null;
  endDate: string | null;
  search: string;
}

export const emptyFilters: DashboardFilters = {
  yearIds: [],
  projectIds: [],
  categoryIds: [],
  locations: [],
  projectTypes: [],
  photographers: [],
  startDate: null,
  endDate: null,
  search: '',
};

/**
 * Pulls the filtered expense set. We do the project join client-side in the
 * dashboard component so we don't depend on Supabase's embedded-resource
 * parsing (which can fail silently if FK metadata isn't picked up). Date/project/
 * category filters that map to DB columns are pushed down; year/location/search
 * are filtered on the joined rows in the page.
 */
export function useFilteredExpenses(filters: DashboardFilters) {
  return useQuery({
    queryKey: ['dashboard', 'expenses', filters] as const,
    queryFn: async (): Promise<Expense[]> => {
      let q = supabase
        .from('expenses')
        .select('*')
        .order('expense_date', { ascending: false });
      if (filters.startDate) q = q.gte('expense_date', filters.startDate);
      if (filters.endDate) q = q.lte('expense_date', filters.endDate);
      if (filters.projectIds.length) q = q.in('project_id', filters.projectIds);
      if (filters.categoryIds.length) q = q.in('category_id', filters.categoryIds);
      const { data, error } = await q.limit(5000);
      if (error) throw error;
      return (data ?? []) as Expense[];
    },
  });
}

export function useUnfilteredRollups() {
  const years = useQuery({
    queryKey: ['dashboard', 'years'] as const,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_year_rollup')
        .select('*')
        .order('year_value', { ascending: true });
      if (error) throw error;
      return (data ?? []) as YearRollup[];
    },
  });
  const projects = useQuery({
    queryKey: ['dashboard', 'projects'] as const,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_project_rollup')
        .select('*')
        .order('total_amount', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ProjectRollup[];
    },
  });
  const categories = useQuery({
    queryKey: ['dashboard', 'categories'] as const,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_category_rollup')
        .select('*')
        .order('total_amount', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CategoryRollup[];
    },
  });
  const locations = useQuery({
    queryKey: ['dashboard', 'locations'] as const,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_location_rollup')
        .select('*')
        .order('total_amount', { ascending: false });
      if (error) throw error;
      return (data ?? []) as LocationRollup[];
    },
  });
  const monthly = useQuery({
    queryKey: ['dashboard', 'monthly'] as const,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_monthly_rollup')
        .select('*')
        .order('month', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MonthlyRollup[];
    },
  });
  return { years, projects, categories, locations, monthly };
}
