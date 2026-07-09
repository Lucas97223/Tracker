import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePublicContract, useSignContract } from '../hooks/useSell';

/** Hand-rolled, dependency-free rendering of the tiny markdown subset we use. */
function renderBody(md: string) {
  return md.split('\n').map((line, i) => {
    const bolded = line.split(/\*\*(.+?)\*\*/g).map((part, j) =>
      j % 2 === 1 ? <strong key={j}>{part}</strong> : part,
    );
    if (line.startsWith('## ')) {
      return <h2 key={i} className="mt-4 text-lg font-semibold text-slate-900">{line.slice(3)}</h2>;
    }
    if (line.startsWith('# ')) {
      return <h1 key={i} className="mt-2 text-xl font-bold text-slate-900">{line.slice(2)}</h1>;
    }
    if (line.startsWith('- ')) {
      return <li key={i} className="ml-5 list-disc text-slate-700">{bolded.slice(0)}</li>;
    }
    if (line.trim() === '') return <div key={i} className="h-2" />;
    return <p key={i} className="text-slate-700">{bolded}</p>;
  });
}

export function PublicContractPage() {
  const { token } = useParams<{ token: string }>();
  const contract = usePublicContract(token);
  const sign = useSignContract();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (contract.isLoading) {
    return <p className="p-10 text-center text-sm text-slate-500">Loading…</p>;
  }
  if (contract.isError || !contract.data) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-lg font-semibold text-slate-800">This contract isn't available</h1>
        <p className="mt-1 text-sm text-slate-500">The link may be wrong, or it was withdrawn.</p>
      </div>
    );
  }

  const c = contract.data;

  async function handleSign(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await sign.mutateAsync({ token: token!, name, email: email || undefined });
      await contract.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signing failed — try again');
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <header className="border-b-2 border-slate-800 pb-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{c.org_name}</p>
        <h1 className="text-2xl font-bold text-slate-900">{c.title}</h1>
        <p className="mt-1 text-sm text-slate-500">For {c.contact_name}</p>
      </header>

      <div className="mt-4 space-y-1 text-sm leading-relaxed">{renderBody(c.body_md)}</div>

      <div className="mt-8 rounded-lg border border-slate-200 p-4">
        {c.status === 'signed' ? (
          <div className="text-center">
            <h2 className="text-lg font-semibold text-emerald-700">Signed ✓</h2>
            <p className="mt-1 text-sm text-slate-600">
              Signed {c.signed_at && new Date(c.signed_at).toLocaleString()}. A record of this
              signature is on file.
            </p>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSign(e)} className="space-y-3">
            <p className="text-sm text-slate-700">
              By typing your full legal name and clicking Sign, you agree to the terms above.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input
                className="input"
                placeholder="Full legal name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <input
                className="input"
                type="email"
                placeholder="Email (optional)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={sign.isPending || !name.trim()}>
              {sign.isPending ? 'Signing…' : 'Sign contract'}
            </button>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
