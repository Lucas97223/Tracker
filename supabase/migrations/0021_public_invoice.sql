-- Phase 1, step 6: public invoice share link.
--
-- One security-definer RPC keyed by the invoice's unguessable share_token.
-- Anon may call it; it exposes exactly the fields a client needs to read and
-- print their invoice — never rates, costs, or anything org-internal. Voids
-- and drafts are not shareable.

create or replace function public.get_public_invoice(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  inv public.invoices;
  result jsonb;
begin
  select * into inv from public.invoices
    where share_token = p_token and status in ('sent', 'partial', 'paid');
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'number',      inv.number,
    'status',      inv.status,
    'issue_date',  inv.issue_date,
    'due_date',    inv.due_date,
    'sent_at',     inv.sent_at,
    'memo',        inv.memo,
    'org_name',    (select o.name from public.organizations o where o.id = inv.org_id),
    'contact', (
      select jsonb_build_object('name', c.name, 'email', c.email, 'company', c.company)
      from public.contacts c where c.id = inv.contact_id
    ),
    'project_name', (select p.name from public.projects p where p.id = inv.project_id),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'description', l.description,
        'qty',         l.qty,
        'unit_price',  l.unit_price,
        'amount',      round(l.qty * l.unit_price, 2),
        'tax_rate',    t.rate,
        'tax_name',    t.name
      ) order by l.line_number), '[]'::jsonb)
      from public.invoice_lines l
      left join public.tax_rates t on t.id = l.tax_rate_id
      where l.invoice_id = inv.id
    ),
    'totals', (
      select jsonb_build_object(
        'subtotal', v.subtotal, 'tax_total', v.tax_total,
        'total', v.total, 'paid', v.paid, 'balance', v.balance)
      from public.v_invoice_totals v where v.invoice_id = inv.id
    )
  ) into result;

  return result;
end $$;

grant execute on function public.get_public_invoice(uuid) to anon, authenticated;
