import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { usePublicForm, useSubmitPublicForm } from '../hooks/useCrm';

/** Anonymous lead-capture page at /#/f/<token> — no auth, no app chrome. */
export function PublicFormPage() {
  const { token } = useParams<{ token: string }>();
  const form = usePublicForm(token);
  const submit = useSubmitPublicForm();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (form.isLoading) {
    return <p className="p-10 text-center text-sm text-slate-500">Loading…</p>;
  }
  if (form.isError || !form.data) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-lg font-semibold text-slate-800">This form isn't available</h1>
        <p className="mt-1 text-sm text-slate-500">The link may be wrong, or the form was closed.</p>
      </div>
    );
  }

  const f = form.data;

  if (done) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Thank you! 🎉</h1>
        <p className="mt-2 text-sm text-slate-600">
          {f.org_name} received your inquiry and will get back to you soon.
        </p>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await submit.mutateAsync({ token: token!, answers });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed — please try again');
    }
  }

  return (
    <div className="mx-auto max-w-md p-6">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{f.org_name}</p>
        <h1 className="text-2xl font-bold text-slate-900">{f.headline || f.name}</h1>
        {f.description && <p className="mt-1 text-sm text-slate-600">{f.description}</p>}
      </header>

      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        {f.fields.map((field) => (
          <label key={field.id} className="block text-sm font-medium text-slate-700">
            {field.label}
            {field.required && <span className="text-red-500"> *</span>}
            {field.kind === 'textarea' ? (
              <textarea
                className="input mt-1 w-full"
                rows={4}
                required={field.required}
                value={answers[field.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [field.id]: e.target.value }))}
              />
            ) : (
              <input
                className="input mt-1 w-full"
                type={field.kind === 'email' ? 'email' : field.kind === 'phone' ? 'tel' : field.kind === 'date' ? 'date' : 'text'}
                required={field.required}
                value={answers[field.id] ?? ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [field.id]: e.target.value }))}
              />
            )}
          </label>
        ))}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button type="submit" className="btn-primary w-full" disabled={submit.isPending}>
          {submit.isPending ? 'Sending…' : 'Send inquiry'}
        </button>
      </form>
    </div>
  );
}
