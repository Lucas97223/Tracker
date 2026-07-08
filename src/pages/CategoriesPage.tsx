import { useState } from 'react';
import { useCategories, useCreateCategory, useUpdateCategory } from '../hooks/useCategories';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import type { Category } from '../types/database';

const SWATCHES = ['#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b'];

export function CategoriesPage() {
  const { canEdit } = useAuth();
  const categories = useCategories();
  const create = useCreateCategory();
  const toast = useToast();

  const [name, setName] = useState('');
  const [color, setColor] = useState(SWATCHES[5]!);
  const [description, setDescription] = useState('');

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await create.mutateAsync({ name: name.trim(), description: description || null, color });
      toast.success('Category added');
      setName('');
      setDescription('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add');
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Categories</h1>
      <p className="text-sm text-slate-600">
        Categories are shared across all projects. Archive a category to hide it from new expenses
        without affecting historical line items.
      </p>

      {canEdit && (
        <form onSubmit={handleAdd} className="card grid grid-cols-1 gap-3 p-4 md:grid-cols-5">
          <div className="md:col-span-2">
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Description</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div>
            <label className="label">Color</label>
            <div className="flex flex-wrap gap-1">
              {SWATCHES.map((s) => (
                <button
                  type="button"
                  key={s}
                  aria-label={`color ${s}`}
                  onClick={() => setColor(s)}
                  className={`h-6 w-6 rounded-full border-2 ${color === s ? 'border-slate-900' : 'border-transparent'}`}
                  style={{ backgroundColor: s }}
                />
              ))}
            </div>
          </div>
          <div className="md:col-span-5 flex justify-end">
            <button type="submit" className="btn-primary">
              Add category
            </button>
          </div>
        </form>
      )}

      <ul className="card divide-y divide-slate-100">
        {(categories.data ?? []).map((c) => (
          <CategoryRow key={c.id} category={c} canEdit={canEdit} />
        ))}
        {categories.data?.length === 0 && (
          <li className="px-4 py-3 text-sm text-slate-500">No categories yet.</li>
        )}
      </ul>
    </div>
  );
}

function CategoryRow({ category, canEdit }: { category: Category; canEdit: boolean }) {
  const update = useUpdateCategory();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);

  async function save() {
    try {
      await update.mutateAsync({ id: category.id, name: name.trim(), color });
      toast.success('Saved');
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function toggleArchive() {
    try {
      await update.mutateAsync({ id: category.id, is_archived: !category.is_archived });
      toast.success(category.is_archived ? 'Unarchived' : 'Archived');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <li className="flex items-center justify-between px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {editing ? (
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-6 w-8"
            aria-label="Color"
          />
        ) : (
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: category.color }}
          />
        )}
        {editing ? (
          <input className="input max-w-xs" value={name} onChange={(e) => setName(e.target.value)} />
        ) : (
          <span className="font-medium">{category.name}</span>
        )}
        {category.is_archived && <span className="badge bg-slate-200 text-slate-600">archived</span>}
        {category.description && (
          <span className="ml-2 truncate text-sm text-slate-500">{category.description}</span>
        )}
      </div>
      {canEdit && (
        <div className="flex gap-1">
          {editing ? (
            <>
              <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary" onClick={save}>
                Save
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="btn-ghost" onClick={toggleArchive}>
                {category.is_archived ? 'Unarchive' : 'Archive'}
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
