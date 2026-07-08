import { createClient } from '@supabase/supabase-js';
import { config } from './config';

// We keep the client untyped; row shapes are typed at the call sites via the
// interfaces in src/types/database.ts. This avoids fighting Supabase's generic
// `Database` shape, which is easy to regenerate later with `supabase gen types`.
export const supabase = createClient(
  config.supabaseUrl ?? 'http://localhost',
  config.supabaseAnonKey ?? 'anon',
  {
    auth: {
      persistSession: true,
      // AuthProvider owns token refresh explicitly (scheduled off the real
      // session expiry, plus a watchdog backstop). Leaving this library's own
      // autoRefreshToken on too meant two independent timers could each try
      // to refresh around the same moment; since refresh tokens rotate on
      // use, that race could reuse an already-rotated token outside
      // Supabase's reuse-tolerance window and get the whole session revoked.
      autoRefreshToken: false,
      detectSessionInUrl: true,
    },
  },
);
