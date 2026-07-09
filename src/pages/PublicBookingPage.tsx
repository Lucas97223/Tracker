import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useBookSlot, usePublicScheduler } from '../hooks/useSell';

/** Anonymous booking page: pick a slot, leave a name, done. */
export function PublicBookingPage() {
  const { token } = useParams<{ token: string }>();
  const [from] = useState(() => new Date().toISOString().slice(0, 10));
  const scheduler = usePublicScheduler(token, from);
  const book = useBookSlot();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const m = new Map<string, Array<{ starts_at: string; ends_at: string }>>();
    for (const s of scheduler.data?.slots ?? []) {
      const day = new Date(s.starts_at).toLocaleDateString([], {
        weekday: 'short', month: 'short', day: 'numeric',
      });
      m.set(day, [...(m.get(day) ?? []), s]);
    }
    return Array.from(m.entries());
  }, [scheduler.data?.slots]);

  if (scheduler.isLoading) {
    return <p className="p-10 text-center text-sm text-slate-500">Loading…</p>;
  }
  if (scheduler.isError || !scheduler.data) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-lg font-semibold text-slate-800">This scheduler isn't available</h1>
      </div>
    );
  }

  const s = scheduler.data;

  if (done) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Booked! 🎉</h1>
        <p className="mt-2 text-sm text-slate-600">
          {s.name} with {s.org_name} on{' '}
          <strong>{new Date(done).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}</strong>.
        </p>
      </div>
    );
  }

  async function handleBook(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    try {
      await book.mutateAsync({ token: token!, starts_at: selected, name, email: email || undefined });
      setDone(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Booking failed — try another slot');
      await scheduler.refetch();
      setSelected(null);
    }
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <header className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{s.org_name}</p>
        <h1 className="text-2xl font-bold text-slate-900">{s.name}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {s.minutes} minutes{s.description ? ` · ${s.description}` : ''} · times shown in {s.timezone}
        </p>
      </header>

      {byDay.length === 0 ? (
        <p className="text-sm text-slate-500">No open times in the next two weeks — check back soon.</p>
      ) : (
        <div className="space-y-4">
          {byDay.map(([day, slots]) => (
            <div key={day}>
              <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{day}</h2>
              <div className="flex flex-wrap gap-2">
                {slots.map((slot) => (
                  <button
                    key={slot.starts_at}
                    type="button"
                    className={`rounded border px-3 py-1.5 text-sm ${
                      selected === slot.starts_at
                        ? 'border-brand-600 bg-brand-50 text-brand-800'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                    }`}
                    onClick={() => setSelected(slot.starts_at)}
                  >
                    {new Date(slot.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <form onSubmit={(e) => void handleBook(e)} className="mt-6 space-y-3 rounded-lg border border-slate-200 p-4">
          <p className="text-sm text-slate-700">
            Booking{' '}
            <strong>{new Date(selected).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</strong>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <input className="input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
            <input className="input" type="email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button type="submit" className="btn-primary w-full" disabled={book.isPending || !name.trim()}>
            {book.isPending ? 'Booking…' : 'Confirm booking'}
          </button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      )}
    </div>
  );
}
