import { useEffect, useState } from 'react';

export function LoadingScreen() {
  // If we sit here for more than a few seconds something is wrong. Show the
  // user a recovery affordance so they can never be permanently stuck.
  const [showRecovery, setShowRecovery] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowRecovery(true), 6000);
    return () => clearTimeout(t);
  }, []);

  function resetApp() {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    window.location.replace(window.location.pathname);
  }

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="flex items-center gap-3 text-slate-500">
        <div
          aria-hidden
          className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
        />
        <span className="text-sm">Loading…</span>
      </div>
      {showRecovery && (
        <div className="max-w-md space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
          <p className="font-medium text-amber-900">Still loading?</p>
          <p className="text-amber-800">
            This usually means a saved sign-in session is stuck or the database is unreachable.
            Resetting the local session will sign you out and let you start fresh.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost text-amber-900 hover:bg-amber-100"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
            <button type="button" className="btn-danger" onClick={resetApp}>
              Reset local session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function InlineSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <div
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600"
      />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-slate-200 ${className}`} />;
}
