export const config = {
  baseCurrency: (import.meta.env.VITE_BASE_CURRENCY as string) || 'USD',
  baseLocale: (import.meta.env.VITE_BASE_LOCALE as string) || 'en-US',
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL as string,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
} as const;

if (!config.supabaseUrl || !config.supabaseAnonKey) {
  // Surfaced once at startup; the Supabase client will also throw.
  console.warn(
    '[expense-tracker] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env',
  );
}
