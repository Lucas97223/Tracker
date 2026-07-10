-- Phase 6b: cash-flow forecast + tax set-aside.
--
-- FORECAST, clearly separated from actuals (I2): these views read operational
-- documents (open invoices, schedules, pay items) — never journal tables —
-- and are labeled forecast end to end. Money IN buckets by due date; money
-- OUT splits committed (approved pay awaiting payout — a real payable) from
-- forecast (draft pay).

create or replace view public.v_cashflow_forecast as
-- money in: open invoice balances by due-date bucket
select
  i.org_id,
  'in'::text as direction,
  case
    when i.due_date is null then '0-30'
    when i.due_date < current_date then 'overdue'
    when i.due_date <= current_date + 30 then '0-30'
    when i.due_date <= current_date + 60 then '31-60'
    else '61+'
  end as bucket,
  'Invoice #' || i.number as source,
  (t.total - coalesce(p.paid, 0))::numeric(14,2) as amount
from public.invoices i
cross join lateral (
  select (coalesce(sum(round(l.qty * l.unit_price, 2)), 0)
          + coalesce(sum(round(l.qty * l.unit_price * coalesce(tr.rate, 0), 2)), 0))::numeric(14,2) as total
  from public.invoice_lines l
  left join public.tax_rates tr on tr.id = l.tax_rate_id
  where l.invoice_id = i.id
) t
left join lateral (
  select sum(amount) as paid from public.payments
  where invoice_id = i.id and voided_at is null
) p on true
where i.status in ('sent', 'partial')
  and (t.total - coalesce(p.paid, 0)) > 0

union all
-- money in: project-level payment schedules not yet invoiced
select
  s.org_id, 'in',
  case
    when s.due_date < current_date then 'overdue'
    when s.due_date <= current_date + 30 then '0-30'
    when s.due_date <= current_date + 60 then '31-60'
    else '61+'
  end,
  'Schedule — ' || coalesce((select name from public.projects pr where pr.id = s.project_id), 'project'),
  s.amount
from public.payment_schedules s
where s.status = 'pending' and s.project_id is not null

union all
-- money out, committed: approved team pay awaiting payout (a real payable)
select
  pi.org_id, 'out', 'committed',
  'Pay — ' || (select display_name from public.team_members tm where tm.id = pi.team_member_id),
  pi.amount
from public.pay_items pi
where pi.status = 'approved'

union all
-- money out, forecast: draft pay
select
  pi.org_id, 'out', 'forecast',
  'Draft pay — ' || (select display_name from public.team_members tm where tm.id = pi.team_member_id),
  pi.amount
from public.pay_items pi
where pi.status = 'draft' and pi.amount > 0;

alter view public.v_cashflow_forecast set (security_invoker = true);
grant select on public.v_cashflow_forecast to authenticated;

-- Tax set-aside: a configurable slice of YTD LEDGER revenue (the one actual
-- input, clearly labeled as an estimate). Percentage lives in org settings.
create or replace view public.v_tax_set_aside as
select
  o.id as org_id,
  coalesce(nullif(o.settings ->> 'tax_set_aside_pct', '')::numeric, 25) as pct,
  coalesce(rev.ytd_revenue, 0)::numeric(14,2) as ytd_revenue,
  round(coalesce(rev.ytd_revenue, 0)
        * coalesce(nullif(o.settings ->> 'tax_set_aside_pct', '')::numeric, 25) / 100,
        2)::numeric(14,2) as suggested_set_aside
from public.organizations o
left join lateral (
  select sum(case when a.type = 'revenue' then jl.credit - jl.debit else 0 end) as ytd_revenue
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_entry_id and je.posted
  join public.accounts a on a.id = jl.account_id
  where jl.org_id = o.id
    and je.entry_date >= date_trunc('year', current_date)::date
) rev on true;

alter view public.v_tax_set_aside set (security_invoker = true);
grant select on public.v_tax_set_aside to authenticated;
