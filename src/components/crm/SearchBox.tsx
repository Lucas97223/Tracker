import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch, type SearchResult } from '../../hooks/useCrm';

const KIND_META: Record<SearchResult['kind'], { icon: string; label: string }> = {
  contact: { icon: '👤', label: 'Contact' },
  project: { icon: '📁', label: 'Project' },
  task: { icon: '☑️', label: 'Task' },
  deal: { icon: '💼', label: 'Deal' },
  invoice: { icon: '🧾', label: 'Invoice' },
};

/** Universal search (org-scoped in the database, not the UI). */
export function SearchBox() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const results = useSearch(query);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        boxRef.current?.querySelector('input')?.focus();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function go(r: SearchResult) {
    setOpen(false);
    setQuery('');
    if (r.kind === 'contact') navigate('/contacts');
    else if (r.kind === 'deal') navigate('/pipeline');
    else if (r.project_id) navigate(`/projects/${r.project_id}`);
  }

  const rows = results.data ?? [];

  return (
    <div ref={boxRef} className="relative hidden md:block">
      <input
        className="input w-52 !py-1 text-sm"
        placeholder="Search…  ⌘K"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        aria-label="Search everything"
      />
      {open && query.trim().length >= 2 && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-40 mt-1 w-96 rounded-lg border border-slate-200 bg-white shadow-xl">
            {results.isLoading ? (
              <p className="px-3 py-3 text-sm text-slate-400">Searching…</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-3 text-sm text-slate-400">No matches for “{query}”.</p>
            ) : (
              <ul className="max-h-96 overflow-y-auto py-1">
                {rows.map((r) => (
                  <li key={`${r.kind}-${r.id}`}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50"
                      onClick={() => go(r)}
                    >
                      <span aria-hidden>{KIND_META[r.kind].icon}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-800">{r.title}</span>
                      {r.subtitle && (
                        <span className="max-w-32 truncate text-xs text-slate-400">{r.subtitle}</span>
                      )}
                      <span className="text-[10px] uppercase tracking-wide text-slate-300">
                        {KIND_META[r.kind].label}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
