import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile, Role } from '../types/database';

interface AuthState {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  role: Role | null;
  /** The user's default organization (single-org UX for now). */
  orgId: string | null;
  isAdmin: boolean;
  canEdit: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.error('[auth] fetchProfile error', error);
    return null;
  }
  return data;
}

/**
 * Race a promise against a timeout. Used to make sure a hanging Supabase
 * request can never wedge the entire app on the loading screen.
 */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[auth] ${tag} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Nuke any Supabase auth tokens stuck in localStorage (e.g. expired/corrupt). */
function clearStaleAuthStorage() {
  try {
    const keys = Object.keys(localStorage).filter(
      (k) => k.startsWith('sb-') || k.toLowerCase().includes('supabase'),
    );
    for (const k of keys) localStorage.removeItem(k);
    console.warn('[auth] cleared', keys.length, 'stale auth storage key(s)');
  } catch (e) {
    console.warn('[auth] could not clear storage', e);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        const { data } = await withTimeout(supabase.auth.getSession(), 6000, 'getSession');
        if (!mounted) return;
        setSession(data.session);
        onSessionUpdate(data.session);
        if (data.session?.user) {
          // Profile fetch is best-effort: if it times out we still flip off the
          // loading flag so the user at least sees the app shell / inactive screen.
          try {
            const p = await withTimeout(
              fetchProfile(data.session.user.id),
              6000,
              'fetchProfile',
            );
            if (mounted) setProfile(p);
          } catch (e) {
            console.error(e);
            if (mounted) setProfile(null);
          }
        }
      } catch (err) {
        // Most common cause on Electron relaunch: a stale/expired session that
        // can't refresh. Clear it and treat as signed-out so the user can sign
        // in fresh instead of staring at a stuck spinner.
        console.error('[auth] bootstrap failed:', err);
        clearStaleAuthStorage();
        try {
          await supabase.auth.signOut();
        } catch {
          /* ignore */
        }
        if (mounted) {
          setSession(null);
          setProfile(null);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };

    // Keep the session warm. The previous approach refreshed on a blind
    // ~4 minute cadence, which assumed Supabase's default ~1 hour JWT
    // lifetime. That assumption doesn't hold for every project (this one's
    // access tokens expire in well under 4 minutes), so instead we schedule
    // the refresh from the session's actual `expires_at`, with a watchdog
    // interval as a backstop in case a scheduled timer gets throttled by the
    // OS/renderer while the window sits idle.
    let refreshing = false;
    let lastAttempt = 0;
    let expiresAtMs: number | null = null;
    let bufferMs = 30 * 1000;
    let scheduledTimer: number | null = null;
    // Floor on how often we'll even attempt a refresh, independent of how
    // short the token's lifetime is. Supabase rate-limits the token
    // endpoint; a token lifetime shorter than our buffer must not turn into
    // a tight refresh loop that trips that limit and gets the session
    // revoked (which looks like — and previously caused — a hard logout).
    const MIN_RETRY_GAP_MS = 15 * 1000;
    const WATCHDOG_MS = 20 * 1000;

    const clearScheduled = () => {
      if (scheduledTimer !== null) {
        window.clearTimeout(scheduledTimer);
        scheduledTimer = null;
      }
    };

    const refresh = async (reason: string) => {
      if (refreshing || Date.now() - lastAttempt < MIN_RETRY_GAP_MS) return;
      refreshing = true;
      lastAttempt = Date.now();
      try {
        const { error } = await supabase.auth.refreshSession();
        if (error) {
          console.warn('[auth] refresh failed (' + reason + '):', error.message);
        }
      } catch (e) {
        console.warn('[auth] refresh threw (' + reason + '):', e);
      } finally {
        refreshing = false;
      }
    };

    // Only refresh from a "user did something" signal (click, focus, etc.)
    // if we're actually near/past expiry. Refreshing unconditionally on
    // every click while the token is still fresh is exactly the kind of
    // needless traffic that can trip Supabase's rate limit on the token
    // endpoint.
    const refreshIfNearExpiry = (reason: string) => {
      if (expiresAtMs !== null && Date.now() >= expiresAtMs - bufferMs) {
        void refresh(reason);
      }
    };

    const scheduleFromExpiry = () => {
      clearScheduled();
      if (expiresAtMs === null) return;
      const delay = Math.max(0, expiresAtMs - Date.now() - bufferMs);
      scheduledTimer = window.setTimeout(() => void refresh('scheduled'), delay);
    };

    const onSessionUpdate = (newSession: Session | null) => {
      expiresAtMs = newSession?.expires_at ? newSession.expires_at * 1000 : null;
      // Buffer never exceeds half the token's actual lifetime, so a very
      // short-lived token (well under our default 30s buffer) still gets a
      // sane "refresh partway through its life" schedule instead of
      // constantly appearing to already be past its buffer window.
      const lifetimeMs = newSession?.expires_in ? newSession.expires_in * 1000 : 30 * 1000;
      bufferMs = Math.min(30 * 1000, lifetimeMs / 2);
      scheduleFromExpiry();
    };

    bootstrap();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (!mounted) return;
      setSession(newSession);
      onSessionUpdate(newSession);
      if (newSession?.user) {
        try {
          setProfile(await withTimeout(fetchProfile(newSession.user.id), 6000, 'fetchProfile'));
        } catch (e) {
          console.error(e);
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshIfNearExpiry('visibility');
    };
    const onFocus = () => refreshIfNearExpiry('focus');
    const onActivity = () => refreshIfNearExpiry('activity');

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    document.addEventListener('pointerdown', onActivity, { passive: true });
    document.addEventListener('keydown', onActivity, { passive: true });

    // Backstop: if the scheduled timeout itself gets throttled while idle,
    // this periodic (cheap) check still notices we're past/near expiry and
    // refreshes as soon as it does get to run.
    const watchdog = window.setInterval(() => refreshIfNearExpiry('watchdog'), WATCHDOG_MS);

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('pointerdown', onActivity);
      document.removeEventListener('keydown', onActivity);
      clearScheduled();
      window.clearInterval(watchdog);
    };
  }, []);

  const value = useMemo<AuthState>(() => {
    const user = session?.user ?? null;
    const role = profile?.role ?? null;
    return {
      user,
      session,
      profile,
      loading,
      role,
      orgId: profile?.default_org_id ?? null,
      isAdmin: role === 'admin',
      canEdit: role === 'admin' || role === 'editor',
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error?.message ?? null };
      },
      async signOut() {
        await supabase.auth.signOut();
      },
      async refreshProfile() {
        if (session?.user) setProfile(await fetchProfile(session.user.id));
      },
    };
  }, [session, profile, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
