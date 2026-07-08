import { useState, type KeyboardEvent } from 'react';

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  ariaLabel?: string;
}

/**
 * Add-on-Enter chip input. Type a name + Enter (or comma) to add a chip.
 * Backspace on an empty field removes the last chip. Click × on a chip to
 * remove it directly.
 */
export function ChipInput({
  value,
  onChange,
  placeholder = 'Type and press Enter',
  suggestions,
  ariaLabel,
}: Props) {
  const [draft, setDraft] = useState('');

  function add(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (value.some((v) => v.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...value, trimmed]);
    setDraft('');
  }

  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault();
      remove(value.length - 1);
    }
  }

  const datalistId = ariaLabel ? `chip-${ariaLabel.replace(/\s+/g, '-')}` : undefined;

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-300 bg-white px-1.5 py-1 shadow-sm focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500">
      {value.map((chip, i) => (
        <span
          key={`${chip}-${i}`}
          className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-800"
        >
          {chip}
          <button
            type="button"
            onClick={() => remove(i)}
            className="rounded text-slate-500 hover:bg-slate-200 hover:text-slate-900"
            aria-label={`Remove ${chip}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => add(draft)}
        placeholder={value.length === 0 ? placeholder : ''}
        aria-label={ariaLabel}
        list={datalistId}
        className="flex-1 min-w-[8rem] bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-slate-400"
      />
      {suggestions && suggestions.length > 0 && (
        <datalist id={datalistId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
