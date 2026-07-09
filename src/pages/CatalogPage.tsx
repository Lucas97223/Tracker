import { useState } from 'react';
import { useCatalog, useSaveCatalogItem, type CatalogItem } from '../hooks/useSell';
import { useTaxRates } from '../hooks/useInvoices';
import { Modal } from '../components/Modal';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';
import { formatMoney } from '../lib/money';

function ItemModal({ item, onClose }: { item: CatalogItem | null; onClose: () => void }) {
  const save = useSaveCatalogItem();
  const taxRates = useTaxRates();
  const toast = useToast();
  const [form, setForm] = useState({
    name: item?.name ?? '',
    kind: item?.kind ?? ('service' as CatalogItem['kind']),
    description: item?.description ?? '',
    unit_price: item?.unit_price ?? '0',
    estimated_cost: item?.estimated_cost ?? '',
    estimated_hours: item?.estimated_hours ?? '',
    tax_rate_id: item?.tax_rate_id ?? '',
    is_active: item?.is_active ?? true,
  });

  async function submit() {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }
    try {
      await save.mutateAsync({
        id: item?.id,
        name: form.name.trim(),
        kind: form.kind,
        description: form.description.trim() || null,
        unit_price: Number(form.unit_price).toFixed(2),
        estimated_cost: form.estimated_cost === '' ? null : Number(form.estimated_cost).toFixed(2),
        estimated_hours: form.estimated_hours === '' ? null : Number(form.estimated_hours).toFixed(2),
        tax_rate_id: form.tax_rate_id || null,
        is_active: form.is_active,
      });
      toast.success(item ? 'Item updated' : 'Item added to the catalog');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    }
  }

  return (
    <Modal open title={item ? `Edit ${item.name}` : 'New catalog item'} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <label className="col-span-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Name
            <input
              className="input mt-1 w-full"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Kind
            <select
              className="input mt-1 w-full"
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as CatalogItem['kind'] }))}
            >
              <option value="service">Service</option>
              <option value="product">Product</option>
              <option value="package">Package</option>
            </select>
          </label>
        </div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Description
          <textarea
            className="input mt-1 w-full"
            rows={2}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </label>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Price
            <input
              type="number" min="0" step="0.01"
              className="input mt-1 w-full"
              value={form.unit_price}
              onChange={(e) => setForm((f) => ({ ...f, unit_price: e.target.value }))}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Est. cost
            <input
              type="number" min="0" step="0.01"
              className="input mt-1 w-full"
              value={form.estimated_cost}
              onChange={(e) => setForm((f) => ({ ...f, estimated_cost: e.target.value }))}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Est. hours
            <input
              type="number" min="0" step="0.25"
              className="input mt-1 w-full"
              value={form.estimated_hours}
              onChange={(e) => setForm((f) => ({ ...f, estimated_hours: e.target.value }))}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Tax
            <select
              className="input mt-1 w-full"
              value={form.tax_rate_id}
              onChange={(e) => setForm((f) => ({ ...f, tax_rate_id: e.target.value }))}
            >
              <option value="">None</option>
              {(taxRates.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
          />
          Active (offered on new proposals)
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => void submit()}>
            {item ? 'Save' : 'Add item'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function CatalogPage() {
  const { canEdit } = useAuth();
  const catalog = useCatalog();
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Catalog</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your priced offerings. Estimated cost & hours feed the proposal margin guardrail.
          </p>
        </div>
        {canEdit && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            + Item
          </button>
        )}
      </header>

      {(catalog.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-500">Nothing here yet — add your packages and services.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2 text-right">Price</th>
                <th className="px-4 py-2 text-right">Est. cost</th>
                <th className="px-4 py-2 text-right">Est. hours</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {(catalog.data ?? []).map((i) => (
                <tr
                  key={i.id}
                  className={`cursor-pointer border-b border-slate-50 hover:bg-slate-50 ${i.is_active ? '' : 'opacity-50'}`}
                  onClick={() => canEdit && setEditing(i)}
                >
                  <td className="px-4 py-2 font-medium text-slate-800">{i.name}</td>
                  <td className="px-4 py-2"><span className="badge bg-slate-100 text-slate-600">{i.kind}</span></td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatMoney(i.unit_price)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                    {i.estimated_cost ? formatMoney(i.estimated_cost) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                    {i.estimated_hours ? Number(i.estimated_hours).toFixed(1) : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!i.is_active && <span className="badge bg-slate-100 text-slate-500">inactive</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <ItemModal item={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}
    </div>
  );
}
