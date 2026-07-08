-- Phase 1, step 3: payments — the thesis lands here (posting map §5, D7).
--
-- Recording a payment creates its balanced journal entry IN THE SAME
-- TRANSACTION (record_payment RPC):
--     DR 1000 Cash                      full amount
--     CR revenue account(s)             net portion, split per line buckets
--     CR tax liability account(s)       proportional share, rounding trued-up
-- Payments are immutable; corrections go through void_payment, which posts a
-- reversal entry and recomputes the invoice status. Direct writes to the
-- payments table are impossible for API roles (RPC-only).
--
-- Also here:
--   - accounting periods finally become real (recon gap #3): a monthly period
--     is auto-created and stamped on EVERY journal entry, old rows backfilled;
--     posting into a closed/locked period is rejected.
--   - credit_notes: DR 4800 Discounts & Credits (contra-revenue) / CR cash.
--   - invoice void now blocked while un-voided payments exist.

-- ---------- payments ----------

create table if not exists public.payments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  invoice_id         uuid not null references public.invoices(id) on delete restrict,
  payment_date       date not null default current_date,
  amount             numeric(14,2) not null check (amount > 0),
  method             text,
  reference          text,
  journal_entry_id   uuid not null references public.journal_entries(id) on delete restrict,
  voided_at          timestamptz,
  reversal_entry_id  uuid references public.journal_entries(id) on delete restrict,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists payments_invoice_idx on public.payments(invoice_id);
create index if not exists payments_org_idx on public.payments(org_id);
create index if not exists payments_date_idx on public.payments(payment_date);

-- Immutable outside the RPCs (which set the transaction-local flag).
create or replace function public.enforce_payment_immutability()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.payment_rpc', true), '') = 'on';
begin
  if via_rpc then
    return coalesce(NEW, OLD);
  end if;
  raise exception 'Payments are managed by record_payment()/void_payment() only'
    using errcode = 'check_violation';
end $$;

drop trigger if exists payments_immutable on public.payments;
create trigger payments_immutable
  before insert or update or delete on public.payments
  for each row execute procedure public.enforce_payment_immutability();

-- ---------- derived totals (amounts + paid + balance) ----------

create or replace view public.v_invoice_totals as
select
  a.invoice_id,
  a.org_id,
  a.subtotal,
  a.tax_total,
  a.total,
  coalesce(p.paid, 0)::numeric(14,2)              as paid,
  (a.total - coalesce(p.paid, 0))::numeric(14,2)  as balance
from public.v_invoice_amounts a
left join (
  select invoice_id, sum(amount) as paid
  from public.payments
  where voided_at is null
  group by invoice_id
) p on p.invoice_id = a.invoice_id;

alter view public.v_invoice_totals set (security_invoker = true);
grant select on public.v_invoice_totals to authenticated;

-- AR aging over open invoices.
create or replace view public.v_ar_aging as
select
  i.id            as invoice_id,
  i.org_id,
  i.number,
  i.contact_id,
  c.name          as contact_name,
  i.project_id,
  i.issue_date,
  i.due_date,
  i.status,
  t.total,
  t.paid,
  t.balance,
  case
    when i.due_date is null or i.due_date >= current_date then 'current'
    when current_date - i.due_date <= 30 then '1-30'
    when current_date - i.due_date <= 60 then '31-60'
    when current_date - i.due_date <= 90 then '61-90'
    else '90+'
  end as bucket,
  greatest(0, current_date - coalesce(i.due_date, current_date)) as days_overdue
from public.invoices i
join public.v_invoice_totals t on t.invoice_id = i.id
join public.contacts c on c.id = i.contact_id
where i.status in ('sent', 'partial');

alter view public.v_ar_aging set (security_invoker = true);
grant select on public.v_ar_aging to authenticated;

-- ---------- accounting periods become real ----------

create or replace function public.ensure_period(p_org uuid, p_date date)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_start date := date_trunc('month', p_date)::date;
  v_end   date := (date_trunc('month', p_date) + interval '1 month - 1 day')::date;
  v_id    uuid;
  v_status period_status;
begin
  select id, status into v_id, v_status
    from public.accounting_periods
    where org_id = p_org and start_date = v_start and end_date = v_end;

  if v_id is null then
    perform pg_advisory_xact_lock(hashtext('period:' || p_org::text || v_start::text));
    select id, status into v_id, v_status
      from public.accounting_periods
      where org_id = p_org and start_date = v_start and end_date = v_end;
    if v_id is null then
      insert into public.accounting_periods (name, start_date, end_date, status, org_id)
      values (to_char(v_start, 'YYYY-MM'), v_start, v_end, 'open', p_org)
      returning id, status into v_id, v_status;
    end if;
  end if;

  if v_status in ('closed', 'locked') then
    raise exception 'Accounting period % is %; postings must land in an open period',
      to_char(v_start, 'YYYY-MM'), v_status using errcode = 'check_violation';
  end if;
  return v_id;
end $$;

create or replace function public.stamp_journal_period()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.period_id is null and NEW.org_id is not null then
    NEW.period_id := public.ensure_period(NEW.org_id, NEW.entry_date);
  end if;
  return NEW;
end $$;

-- zzz: fires after set_org (…_set_org) and the org-ref guard (…_zz_org_refs).
drop trigger if exists journal_entries_zzz_period on public.journal_entries;
create trigger journal_entries_zzz_period
  before insert on public.journal_entries
  for each row execute procedure public.stamp_journal_period();

-- Backfill periods for every existing posted entry (period_id was never set;
-- immutability deliberately leaves period_id assignable).
do $$
declare
  r record;
begin
  for r in
    select distinct org_id, date_trunc('month', entry_date)::date as m
    from public.journal_entries where period_id is null
  loop
    perform public.ensure_period(r.org_id, r.m);
  end loop;

  update public.journal_entries je
  set period_id = ap.id
  from public.accounting_periods ap
  where je.period_id is null
    and ap.org_id = je.org_id
    and je.entry_date between ap.start_date and ap.end_date;
end $$;

-- ---------- contra-revenue account ----------

do $$
declare
  v_org uuid;
begin
  for v_org in select id from public.organizations loop
    if not exists (select 1 from public.accounts where org_id = v_org and code = '4800') then
      insert into public.accounts (code, name, type, normal_balance, is_system, is_active, description, org_id)
      values ('4800', 'Discounts & Credits', 'revenue', 'debit', true, true,
              'Contra-revenue: discounts, credit notes, refunds', v_org);
    end if;
  end loop;
end $$;

-- New orgs get 4800 from provisioning too.
create or replace function public.provision_org_extras_0018(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.accounts where org_id = p_org and code = '4800') then
    insert into public.accounts (code, name, type, normal_balance, is_system, is_active, description, org_id)
    values ('4800', 'Discounts & Credits', 'revenue', 'debit', true, true,
            'Contra-revenue: discounts, credit notes, refunds', p_org);
  end if;
end $$;

create or replace function public.handle_new_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    insert into public.org_members (org_id, user_id, role)
    values (NEW.id, auth.uid(), 'owner')
    on conflict do nothing;
    update public.profiles set default_org_id = NEW.id
      where id = auth.uid() and default_org_id is null;
  end if;
  perform public.provision_org(NEW.id);
  perform public.provision_org_extras_0018(NEW.id);
  return NEW;
end $$;

-- ---------- record_payment ----------

create or replace function public.record_payment(
  p_invoice   uuid,
  p_amount    numeric,
  p_date      date default current_date,
  p_method    text default null,
  p_reference text default null
) returns public.payments language plpgsql security definer set search_path = public as $$
declare
  inv          public.invoices;
  amt          public.v_invoice_amounts;
  v_paid       numeric(14,2);
  v_balance    numeric(14,2);
  v_cash       uuid;
  v_default_rev uuid;
  v_payment_id uuid := gen_random_uuid();
  v_je         uuid;
  v_line_no    int := 1;
  v_tax_before numeric(14,2);
  v_tax_after  numeric(14,2);
  v_tax_this   numeric(14,2);
  v_net_this   numeric(14,2);
  v_alloc      numeric(14,2);
  v_remaining  numeric(14,2);
  bucket       record;
  v_result     public.payments;
  v_contact    text;
begin
  select * into inv from public.invoices where id = p_invoice for update;
  if not found then
    raise exception 'Invoice % not found', p_invoice;
  end if;
  if not public.org_can_edit(inv.org_id) then
    raise exception 'Not allowed to record payments in this organization';
  end if;
  if inv.status not in ('sent', 'partial') then
    raise exception 'Invoice % is %; payments require a sent invoice', inv.number, inv.status;
  end if;

  select * into amt from public.v_invoice_amounts where invoice_id = p_invoice;
  select coalesce(sum(amount), 0) into v_paid
    from public.payments where invoice_id = p_invoice and voided_at is null;
  v_balance := amt.total - v_paid;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment amount must be positive';
  end if;
  if p_amount > v_balance then
    raise exception 'Payment (%) exceeds the open balance (%)', p_amount, v_balance;
  end if;

  select id into v_cash from public.accounts where org_id = inv.org_id and code = '1000' limit 1;
  select id into v_default_rev from public.accounts where org_id = inv.org_id and code = '4100' limit 1;
  if v_cash is null or v_default_rev is null then
    raise exception 'Org % is missing the 1000 Cash or 4100 Service Revenue account', inv.org_id;
  end if;

  -- Cash-basis proportional tax with cumulative true-up: after the final
  -- payment the credited tax equals tax_total exactly.
  if amt.total > 0 and amt.tax_total > 0 then
    v_tax_before := round(v_paid * amt.tax_total / amt.total, 2);
    v_tax_after  := round((v_paid + p_amount) * amt.tax_total / amt.total, 2);
    v_tax_this   := v_tax_after - v_tax_before;
  else
    v_tax_this := 0;
  end if;
  v_net_this := p_amount - v_tax_this;

  select display_name into v_contact from (
    select c.name as display_name from public.contacts c where c.id = inv.contact_id
  ) s;

  insert into public.journal_entries
    (entry_date, memo, reference, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
  values
    (p_date, 'Payment — invoice #' || inv.number || coalesce(' — ' || v_contact, ''),
     p_reference, 'payment', v_payment_id, inv.project_id, auth.uid(), true, now(), inv.org_id)
  returning id into v_je;

  -- DR cash, full amount.
  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
  values
    (v_je, v_cash, p_amount, 0, 'Payment received', inv.project_id, v_line_no, inv.org_id);

  -- CR revenue, net portion, split across line revenue-account buckets in
  -- proportion to their subtotals (largest-remainder handled by giving the
  -- final bucket the remainder).
  v_remaining := v_net_this;
  for bucket in
    select coalesce(l.revenue_account_id, v_default_rev) as account_id,
           sum(round(l.qty * l.unit_price, 2)) as bucket_subtotal,
           count(*) over () as bucket_count,
           row_number() over (order by coalesce(l.revenue_account_id, v_default_rev)) as rn
    from public.invoice_lines l
    where l.invoice_id = p_invoice
    group by coalesce(l.revenue_account_id, v_default_rev)
    order by coalesce(l.revenue_account_id, v_default_rev)
  loop
    if bucket.rn = bucket.bucket_count then
      v_alloc := v_remaining;
    else
      v_alloc := round(v_net_this * bucket.bucket_subtotal / amt.subtotal, 2);
      v_alloc := least(v_alloc, v_remaining);
    end if;
    if v_alloc <> 0 then
      v_line_no := v_line_no + 1;
      insert into public.journal_lines
        (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
      values
        (v_je, bucket.account_id, 0, v_alloc, 'Revenue', inv.project_id, v_line_no, inv.org_id);
      v_remaining := v_remaining - v_alloc;
    end if;
  end loop;

  -- CR sales-tax liability, split across the invoice's tax-rate accounts by
  -- their share of tax_total (remainder to the last bucket).
  if v_tax_this > 0 then
    v_remaining := v_tax_this;
    for bucket in
      select t.liability_account_id as account_id,
             sum(round(l.qty * l.unit_price * t.rate, 2)) as bucket_tax,
             count(*) over () as bucket_count,
             row_number() over (order by t.liability_account_id) as rn
      from public.invoice_lines l
      join public.tax_rates t on t.id = l.tax_rate_id
      where l.invoice_id = p_invoice
      group by t.liability_account_id
      order by t.liability_account_id
    loop
      if bucket.rn = bucket.bucket_count then
        v_alloc := v_remaining;
      else
        v_alloc := round(v_tax_this * bucket.bucket_tax / amt.tax_total, 2);
        v_alloc := least(v_alloc, v_remaining);
      end if;
      if v_alloc <> 0 then
        v_line_no := v_line_no + 1;
        insert into public.journal_lines
          (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
        values
          (v_je, bucket.account_id, 0, v_alloc, 'Sales tax collected', inv.project_id, v_line_no, inv.org_id);
        v_remaining := v_remaining - v_alloc;
      end if;
    end loop;
  end if;

  perform set_config('app.payment_rpc', 'on', true);
  perform set_config('app.invoice_rpc', 'on', true);

  insert into public.payments
    (id, org_id, invoice_id, payment_date, amount, method, reference, journal_entry_id, created_by)
  values
    (v_payment_id, inv.org_id, p_invoice, p_date, p_amount, p_method, p_reference, v_je, auth.uid())
  returning * into v_result;

  update public.invoices
    set status = case when v_paid + p_amount >= amt.total then 'paid'::invoice_status
                      else 'partial'::invoice_status end
    where id = p_invoice;

  if v_paid + p_amount >= amt.total then
    update public.payment_schedules set status = 'paid'
      where invoice_id = p_invoice and status = 'pending';
  end if;

  perform set_config('app.payment_rpc', '', true);
  perform set_config('app.invoice_rpc', '', true);

  return v_result;
end $$;

-- ---------- void_payment ----------

create or replace function public.void_payment(p_payment uuid)
returns public.payments language plpgsql security definer set search_path = public as $$
declare
  pay       public.payments;
  amt_total numeric(14,2);
  v_paid    numeric(14,2);
  v_rev     uuid;
  v_result  public.payments;
begin
  select * into pay from public.payments where id = p_payment for update;
  if not found then
    raise exception 'Payment % not found', p_payment;
  end if;
  if not public.org_is_admin(pay.org_id) then
    raise exception 'Only an organization owner/admin can void payments';
  end if;
  if pay.voided_at is not null then
    return pay;
  end if;

  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
  select current_date, 'Reversal: ' || coalesce(je.memo, 'payment'), 'reversal', pay.id,
         je.project_id, auth.uid(), true, now(), pay.org_id
  from public.journal_entries je where je.id = pay.journal_entry_id
  returning id into v_rev;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
  select v_rev, jl.account_id, jl.credit, jl.debit,
         'Reversal: ' || coalesce(jl.description, ''), jl.project_id, jl.line_number, jl.org_id
  from public.journal_lines jl
  where jl.journal_entry_id = pay.journal_entry_id;

  update public.journal_entries set reversed_by = v_rev where id = pay.journal_entry_id;

  perform set_config('app.payment_rpc', 'on', true);
  perform set_config('app.invoice_rpc', 'on', true);

  update public.payments
    set voided_at = now(), reversal_entry_id = v_rev
    where id = p_payment
    returning * into v_result;

  select t.total, t.paid into amt_total, v_paid
    from public.v_invoice_totals t where t.invoice_id = pay.invoice_id;

  update public.invoices
    set status = case
      when v_paid <= 0 then 'sent'::invoice_status
      when v_paid < amt_total then 'partial'::invoice_status
      else 'paid'::invoice_status
    end
    where id = pay.invoice_id;

  perform set_config('app.payment_rpc', '', true);
  perform set_config('app.invoice_rpc', '', true);

  return v_result;
end $$;

-- ---------- invoice void now checks for live payments ----------

create or replace function public.enforce_invoice_transitions()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.invoice_rpc', true), '') = 'on';
begin
  if via_rpc then
    return NEW;
  end if;

  if NEW.number is distinct from OLD.number
     or (NEW.contact_id is distinct from OLD.contact_id and OLD.status <> 'draft')
     or (NEW.project_id is distinct from OLD.project_id and OLD.status <> 'draft')
     or (NEW.issue_date is distinct from OLD.issue_date and OLD.status <> 'draft')
     or NEW.org_id is distinct from OLD.org_id then
    raise exception 'Invoice % header is frozen after draft', OLD.id
      using errcode = 'check_violation';
  end if;

  if NEW.status is distinct from OLD.status then
    if OLD.status = 'draft' and NEW.status = 'sent' then
      NEW.sent_at := coalesce(NEW.sent_at, now());
    elsif OLD.status in ('draft', 'sent') and NEW.status = 'void' then
      if exists (select 1 from public.payments
                 where invoice_id = OLD.id and voided_at is null) then
        raise exception 'Void the payments on invoice % first', OLD.number
          using errcode = 'check_violation';
      end if;
    else
      raise exception 'Invoice transition % → % goes through the payment RPCs',
        OLD.status, NEW.status using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end $$;

-- ---------- credit notes ----------

create table if not exists public.credit_notes (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  contact_id        uuid not null references public.contacts(id) on delete restrict,
  invoice_id        uuid references public.invoices(id) on delete set null,
  project_id        uuid references public.projects(id) on delete set null,
  credit_date       date not null default current_date,
  amount            numeric(14,2) not null check (amount > 0),
  reason            text,
  journal_entry_id  uuid not null references public.journal_entries(id) on delete restrict,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);
create index if not exists credit_notes_org_idx on public.credit_notes(org_id);
create index if not exists credit_notes_contact_idx on public.credit_notes(contact_id);

create or replace function public.enforce_credit_note_immutability()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.payment_rpc', true), '') = 'on';
begin
  if via_rpc then
    return coalesce(NEW, OLD);
  end if;
  raise exception 'Credit notes are issued via issue_credit_note() and never edited'
    using errcode = 'check_violation';
end $$;

drop trigger if exists credit_notes_immutable on public.credit_notes;
create trigger credit_notes_immutable
  before insert or update or delete on public.credit_notes
  for each row execute procedure public.enforce_credit_note_immutability();

create or replace function public.issue_credit_note(
  p_contact uuid,
  p_amount  numeric,
  p_date    date default current_date,
  p_invoice uuid default null,
  p_project uuid default null,
  p_reason  text default null
) returns public.credit_notes language plpgsql security definer set search_path = public as $$
declare
  v_org    uuid;
  v_contra uuid;
  v_cash   uuid;
  v_id     uuid := gen_random_uuid();
  v_je     uuid;
  v_result public.credit_notes;
begin
  select org_id into v_org from public.contacts where id = p_contact;
  if v_org is null then
    raise exception 'Contact % not found', p_contact;
  end if;
  if not public.org_is_admin(v_org) then
    raise exception 'Only an organization owner/admin can issue credit notes';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Credit amount must be positive';
  end if;

  select id into v_contra from public.accounts where org_id = v_org and code = '4800' limit 1;
  select id into v_cash   from public.accounts where org_id = v_org and code = '1000' limit 1;
  if v_contra is null or v_cash is null then
    raise exception 'Org % is missing the 4800 or 1000 account', v_org;
  end if;

  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
  values
    (p_date, 'Credit note' || coalesce(' — ' || p_reason, ''), 'adjustment', v_id,
     p_project, auth.uid(), true, now(), v_org)
  returning id into v_je;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
  values
    (v_je, v_contra, p_amount, 0, 'Credit/refund issued', p_project, 1, v_org),
    (v_je, v_cash,   0, p_amount, 'Credit/refund issued', p_project, 2, v_org);

  perform set_config('app.payment_rpc', 'on', true);
  insert into public.credit_notes
    (id, org_id, contact_id, invoice_id, project_id, credit_date, amount, reason, journal_entry_id, created_by)
  values
    (v_id, v_org, p_contact, p_invoice, p_project, p_date, p_amount, p_reason, v_je, auth.uid())
  returning * into v_result;
  perform set_config('app.payment_rpc', '', true);

  return v_result;
end $$;

-- ---------- RLS ----------

alter table public.payments     enable row level security;
alter table public.credit_notes enable row level security;

-- Read for financial viewers; NO direct write policies — the definer RPCs are
-- the only write path (and the immutability triggers back that up).
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  for select using (public.org_can_view_financials(org_id));

drop policy if exists credit_notes_select on public.credit_notes;
create policy credit_notes_select on public.credit_notes
  for select using (public.org_can_view_financials(org_id));

-- ---------- audit + realtime ----------

drop trigger if exists audit_payments on public.payments;
create trigger audit_payments
  after insert or update or delete on public.payments
  for each row execute procedure public.log_audit('payment');

drop trigger if exists audit_credit_notes on public.credit_notes;
create trigger audit_credit_notes
  after insert or update or delete on public.credit_notes
  for each row execute procedure public.log_audit('credit_note');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.payments;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.credit_notes;
    exception when duplicate_object then null; end;
  end if;
end $$;
