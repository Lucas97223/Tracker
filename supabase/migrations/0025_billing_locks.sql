-- Phase 3, step 2: unbilled work → invoice lines, with the I5 lock cycle,
-- and the I4 managerial memo columns on the P&L view.
--
--   add_unbilled_to_invoice()  one transaction: validates every source, adds
--                              the lines, locks the sources with line refs
--   unlock triggers            deleting a draft's line, or voiding an
--                              invoice, releases its sources for rebilling
--   v_project_pnl              gains labor_memo_cost / logged_minutes /
--                              effective_hourly_rate. MEMO ONLY — nothing in
--                              this file touches journal tables (I4).
--   v_unbilled                 the picker: closed billable unlocked time +
--                              billable unlocked expenses per project

-- ---------- the billing RPC ----------

create or replace function public.add_unbilled_to_invoice(
  p_invoice uuid,
  p_time_entries uuid[] default '{}',
  p_expenses uuid[] default '{}'
) returns int language plpgsql security definer set search_path = public as $$
declare
  inv      public.invoices;
  te       public.time_entries;
  ex       public.expenses;
  v_id     uuid;
  v_line   uuid;
  v_lineno int;
  v_name   text;
  v_hours  numeric(10,2);
  v_count  int := 0;
begin
  select * into inv from public.invoices where id = p_invoice for update;
  if not found then
    raise exception 'Invoice % not found', p_invoice;
  end if;
  if not public.org_can_edit(inv.org_id) then
    raise exception 'Not allowed to bill in this organization';
  end if;
  if inv.status <> 'draft' then
    raise exception 'Invoice #% is %; unbilled work can only be added to a draft', inv.number, inv.status;
  end if;
  if inv.project_id is null then
    raise exception 'Invoice #% has no project; billable work is pulled per project', inv.number;
  end if;

  select coalesce(max(line_number), 0) into v_lineno
    from public.invoice_lines where invoice_id = p_invoice;

  perform set_config('app.billing_rpc', 'on', true);
  perform set_config('app.invoice_rpc', 'on', true);

  foreach v_id in array coalesce(p_time_entries, '{}') loop
    select * into te from public.time_entries where id = v_id for update;
    if not found then
      raise exception 'Time entry % not found', v_id;
    end if;
    if te.org_id <> inv.org_id or te.project_id <> inv.project_id then
      raise exception 'Time entry % belongs to a different project', v_id
        using errcode = 'check_violation';
    end if;
    if te.minutes is null then
      raise exception 'Stop the running timer before billing it';
    end if;
    if not te.billable then
      raise exception 'Time entry % is not billable', v_id;
    end if;
    if te.invoiced_lock then
      raise exception 'Time entry % is already on an invoice (I5)', v_id
        using errcode = 'check_violation';
    end if;
    if te.bill_rate is null then
      raise exception 'No bill rate on this entry — set one in member rates first';
    end if;

    select display_name into v_name from public.team_members where id = te.team_member_id;
    v_hours := round(te.minutes / 60.0, 2);
    v_lineno := v_lineno + 1;

    insert into public.invoice_lines
      (org_id, invoice_id, description, qty, unit_price, source_type, source_id, line_number)
    values
      (inv.org_id, p_invoice,
       'Time — ' || coalesce(v_name, 'member') || ' — ' || to_char(te.started_at, 'YYYY-MM-DD')
         || ' (' || v_hours || 'h)' || coalesce(': ' || nullif(trim(te.notes), ''), ''),
       greatest(v_hours, 0.02), te.bill_rate, 'time_entry', te.id, v_lineno)
    returning id into v_line;

    update public.time_entries
      set invoiced_lock = true, invoice_line_id = v_line
      where id = v_id;
    v_count := v_count + 1;
  end loop;

  foreach v_id in array coalesce(p_expenses, '{}') loop
    select * into ex from public.expenses where id = v_id for update;
    if not found then
      raise exception 'Expense % not found', v_id;
    end if;
    if ex.org_id <> inv.org_id or ex.project_id <> inv.project_id then
      raise exception 'Expense % belongs to a different project', v_id
        using errcode = 'check_violation';
    end if;
    if not ex.billable then
      raise exception 'Expense % is not billable', v_id;
    end if;
    if ex.invoiced_lock then
      raise exception 'Expense % is already rebilled on an invoice (I5)', v_id
        using errcode = 'check_violation';
    end if;
    if ex.amount <= 0 then
      raise exception 'Expense % has no amount to rebill', v_id;
    end if;

    v_lineno := v_lineno + 1;
    -- Gross method (D7): the rebill is an income line; the original expense
    -- row and its GL posting stay untouched.
    insert into public.invoice_lines
      (org_id, invoice_id, description, qty, unit_price, source_type, source_id, line_number)
    values
      (inv.org_id, p_invoice,
       'Rebill — ' || ex.description || ' (' || to_char(ex.expense_date, 'YYYY-MM-DD') || ')',
       1, ex.amount, 'expense', ex.id, v_lineno)
    returning id into v_line;

    update public.expenses
      set invoiced_lock = true, invoice_line_id = v_line
      where id = v_id;
    v_count := v_count + 1;
  end loop;

  perform set_config('app.billing_rpc', '', true);
  perform set_config('app.invoice_rpc', '', true);
  return v_count;
end $$;

-- ---------- unlock cycle ----------

-- Deleting a draft invoice's line (or the whole draft, which cascades its
-- lines) releases the sources it billed.
create or replace function public.unlock_sources_on_line_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.billing_rpc', 'on', true);
  update public.time_entries
    set invoiced_lock = false, invoice_line_id = null
    where invoice_line_id = OLD.id;
  update public.expenses
    set invoiced_lock = false, invoice_line_id = null
    where invoice_line_id = OLD.id;
  perform set_config('app.billing_rpc', '', true);
  return OLD;
end $$;

drop trigger if exists invoice_lines_unlock_sources on public.invoice_lines;
create trigger invoice_lines_unlock_sources
  before delete on public.invoice_lines
  for each row execute procedure public.unlock_sources_on_line_delete();

-- Voiding an invoice keeps its lines (history) but releases the work.
create or replace function public.unlock_sources_on_invoice_void()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'void' and OLD.status <> 'void' then
    perform set_config('app.billing_rpc', 'on', true);
    update public.time_entries
      set invoiced_lock = false, invoice_line_id = null
      where invoice_line_id in (select id from public.invoice_lines where invoice_id = NEW.id);
    update public.expenses
      set invoiced_lock = false, invoice_line_id = null
      where invoice_line_id in (select id from public.invoice_lines where invoice_id = NEW.id);
    perform set_config('app.billing_rpc', '', true);
  end if;
  return NEW;
end $$;

drop trigger if exists invoices_unlock_on_void on public.invoices;
create trigger invoices_unlock_on_void
  after update of status on public.invoices
  for each row execute procedure public.unlock_sources_on_invoice_void();

-- ---------- I4: the managerial memo columns ----------

-- Costed time NEVER posts to the GL; it joins the P&L as separately labeled
-- memo columns. Cost detail rides time_entry_costs (admin-only RLS), so with
-- security_invoker the memo cost renders for owners/admins and reads as zero
-- for roles that must not see cost rates.
create or replace view public.v_project_pnl as
select
  base.project_id,
  base.project_name,
  base.year_id,
  base.revenue,
  base.cogs,
  base.expense,
  base.net_margin,
  base.org_id,
  coalesce(tt.memo_cost, 0)::numeric(14,2) as labor_memo_cost,
  coalesce(tt.mins, 0)::int                as logged_minutes,
  case when coalesce(tt.mins, 0) > 0
       then round(base.revenue / (tt.mins / 60.0), 2)
  end::numeric(14,2)                       as effective_hourly_rate
from (
  select
    p.id                                                      as project_id,
    p.name                                                    as project_name,
    p.year_id,
    coalesce(sum(case when a.type = 'revenue' then jl.credit - jl.debit else 0 end), 0)::numeric(14,2) as revenue,
    coalesce(sum(case when a.type = 'cogs'    then jl.debit  - jl.credit else 0 end), 0)::numeric(14,2) as cogs,
    coalesce(sum(case when a.type = 'expense' then jl.debit  - jl.credit else 0 end), 0)::numeric(14,2) as expense,
    coalesce(sum(case when a.type = 'revenue' then jl.credit - jl.debit
                      when a.type in ('expense','cogs') then -(jl.debit - jl.credit)
                      else 0 end), 0)::numeric(14,2) as net_margin,
    p.org_id
  from public.projects p
  left join public.journal_lines jl on jl.project_id = p.id
  left join public.journal_entries je on je.id = jl.journal_entry_id and je.posted = true
  left join public.accounts a on a.id = jl.account_id
  group by p.id, p.name, p.year_id, p.org_id
) base
left join (
  select
    te.project_id,
    sum(te.minutes)                                        as mins,
    sum(round(te.minutes / 60.0 * tc.cost_rate, 2))        as memo_cost
  from public.time_entries te
  left join public.time_entry_costs tc on tc.time_entry_id = te.id
  where te.minutes is not null
  group by te.project_id
) tt on tt.project_id = base.project_id;

alter view public.v_project_pnl set (security_invoker = true);
grant select on public.v_project_pnl to authenticated;

-- ---------- the unbilled picker ----------

create or replace view public.v_unbilled as
select
  'time_entry'                     as source_type,
  te.id                            as source_id,
  te.org_id,
  te.project_id,
  tm.display_name                  as who,
  'Time — ' || to_char(te.started_at, 'YYYY-MM-DD')
    || ' (' || round(te.minutes / 60.0, 2) || 'h)'
    || coalesce(': ' || nullif(trim(te.notes), ''), '') as description,
  round(te.minutes / 60.0 * coalesce(te.bill_rate, 0), 2)::numeric(14,2) as amount,
  (te.bill_rate is null)           as missing_rate
from public.time_entries te
join public.team_members tm on tm.id = te.team_member_id
where te.billable and not te.invoiced_lock and te.minutes is not null
union all
select
  'expense', e.id, e.org_id, e.project_id,
  coalesce(v.name, e.vendor, '—'),
  'Rebill — ' || e.description || ' (' || to_char(e.expense_date, 'YYYY-MM-DD') || ')',
  e.amount,
  false
from public.expenses e
left join public.vendors v on v.id = e.vendor_id
where e.billable and not e.invoiced_lock and e.amount > 0;

alter view public.v_unbilled set (security_invoker = true);
grant select on public.v_unbilled to authenticated;
