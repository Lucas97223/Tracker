import type { ReactNode } from 'react';

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

/**
 * Minimal tab strip used in the project create/edit modal and elsewhere.
 * Controlled component — the parent owns the active tab.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  ariaLabel,
}: {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-1 border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={active === t.id}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          className={`relative -mb-px px-3 py-1.5 text-sm font-medium transition ${
            active === t.id
              ? 'border-b-2 border-brand-600 text-slate-900'
              : 'border-b-2 border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          {t.label}
          {typeof t.count === 'number' && t.count > 0 && (
            <span className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  active,
  id,
  children,
}: {
  active: string;
  id: string;
  children: ReactNode;
}) {
  if (active !== id) return null;
  return (
    <div role="tabpanel" aria-labelledby={id}>
      {children}
    </div>
  );
}
