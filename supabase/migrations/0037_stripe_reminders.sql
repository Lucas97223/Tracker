-- Phase 5 completion: Stripe payment rails + Resend invoice reminders.
--
-- Posting map (§5): online payments post DR 1050 Stripe Clearing (gross),
-- CR revenue; the processor fee posts DR 6900 Payment Processing Fees,
-- CR 1050 — revenue stays gross, the clearing account carries the net that
-- Stripe later pays out (reconciliation is Phase 6 bank-feed work).
-- processor_events.processor_ref is UNIQUE: webhook retries can never
-- double-post a payment.
--
-- Reminders: v_reminder_candidates is plain SQL (tested locally); the sender
-- reads the Resend key from Vault and posts via pg_net under a daily pg_cron
-- schedule — all three are platform extensions, so every use is guarded and
-- the local harness skips them cleanly.

alter type audit_entity add value if not exists 'processor_event';

-- ---------- accounts ----------

create or replace function public.provision_org_extras_0037(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.accounts where org_id = p_org and code = '1050') then
    insert into public.accounts (code, name, type, normal_balance, is_system, is_active, description, org_id)
    values ('1050', 'Stripe Clearing', 'asset', 'debit', true, true,
            'Card payments received, net of fees, awaiting payout', p_org);
  end if;
  if not exists (select 1 from public.accounts where org_id = p_org and code = '6900') then
    insert into public.accounts (code, name, type, normal_balance, is_system, is_active, description, org_id)
    values ('6900', 'Payment Processing Fees', 'expense', 'debit', true, true,
            'Card processor fees (Stripe)', p_org);
  end if;
end $$;

do $$
declare v uuid;
begin
  for v in select id from public.organizations loop
    perform public.provision_org_extras_0037(v);
  end loop;
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
  perform public.provision_pipeline(NEW.id);
  perform public.provision_org_extras_0037(NEW.id);
  return NEW;
end $$;

-- ---------- processor_events ----------

create table if not exists public.processor_events (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  provider       text not null default 'stripe',
  processor_ref  text not null unique,
  kind           text not null,
  invoice_id     uuid references public.invoices(id) on delete set null,
  payment_id     uuid references public.payments(id) on delete set null,
  payload        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

alter table public.processor_events enable row level security;

drop policy if exists processor_events_select on public.processor_events;
create policy processor_events_select on public.processor_events
  for select using (public.org_is_admin(org_id));
-- writes: service-role webhook path only.

-- ---------- payment internals (cash-account override + fee posting) ----------

create or replace function public.record_payment_internal(
  p_invoice      uuid,
  p_amount       numeric,
  p_date         date,
  p_method       text,
  p_reference    text,
  p_cash_account uuid default null,
  p_fee          numeric default null,
  p_created_by   uuid default null
) returns public.payments language plpgsql security definer set search_path = public as $$
declare
  inv          public.invoices;
  amt          public.v_invoice_amounts;
  v_paid       numeric(14,2);
  v_balance    numeric(14,2);
  v_cash       uuid;
  v_default_rev uuid;
  v_fee_acct   uuid;
  v_payment_id uuid := gen_random_uuid();
  v_je         uuid;
  v_fee_je     uuid;
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
  if p_amount > v_balance + 0.01 then
    raise exception 'Payment (%) exceeds the open balance (%)', p_amount, v_balance;
  end if;

  v_cash := coalesce(p_cash_account,
    (select id from public.accounts where org_id = inv.org_id and code = '1000' limit 1));
  select id into v_default_rev from public.accounts where org_id = inv.org_id and code = '4100' limit 1;
  if v_cash is null or v_default_rev is null then
    raise exception 'Org % is missing its cash or revenue account', inv.org_id;
  end if;

  if amt.total > 0 and amt.tax_total > 0 then
    v_tax_before := round(v_paid * amt.tax_total / amt.total, 2);
    v_tax_after  := round(least(v_paid + p_amount, amt.total) * amt.tax_total / amt.total, 2);
    v_tax_this   := v_tax_after - v_tax_before;
  else
    v_tax_this := 0;
  end if;
  v_net_this := p_amount - v_tax_this;

  select c.name into v_contact from public.contacts c where c.id = inv.contact_id;

  insert into public.journal_entries
    (entry_date, memo, reference, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
  values
    (p_date, 'Payment — invoice #' || inv.number || coalesce(' — ' || v_contact, ''),
     p_reference, 'payment', v_payment_id, inv.project_id, p_created_by, true, now(), inv.org_id)
  returning id into v_je;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
  values
    (v_je, v_cash, p_amount, 0, 'Payment received', inv.project_id, v_line_no, inv.org_id);

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

  -- Processor fee: DR fees / CR the clearing account. Revenue stays gross.
  if p_fee is not null and p_fee > 0 then
    select id into v_fee_acct from public.accounts
      where org_id = inv.org_id and code = '6900' limit 1;
    if v_fee_acct is not null then
      insert into public.journal_entries
        (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
      values
        (p_date, 'Processor fee — invoice #' || inv.number, 'adjustment', v_payment_id,
         inv.project_id, p_created_by, true, now(), inv.org_id)
      returning id into v_fee_je;
      insert into public.journal_lines
        (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
      values
        (v_fee_je, v_fee_acct, p_fee, 0, 'Stripe fee', inv.project_id, 1, inv.org_id),
        (v_fee_je, v_cash,     0, p_fee, 'Stripe fee', inv.project_id, 2, inv.org_id);
    end if;
  end if;

  perform set_config('app.payment_rpc', 'on', true);
  perform set_config('app.invoice_rpc', 'on', true);

  insert into public.payments
    (id, org_id, invoice_id, payment_date, amount, method, reference, journal_entry_id, created_by)
  values
    (v_payment_id, inv.org_id, p_invoice, p_date, p_amount, p_method, p_reference, v_je, p_created_by)
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

revoke execute on function public.record_payment_internal(uuid, numeric, date, text, text, uuid, numeric, uuid)
  from public, anon, authenticated;

-- The staff-facing RPC keeps its permission check and delegates.
create or replace function public.record_payment(
  p_invoice   uuid,
  p_amount    numeric,
  p_date      date default current_date,
  p_method    text default null,
  p_reference text default null
) returns public.payments language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.invoices where id = p_invoice;
  if v_org is null then
    raise exception 'Invoice % not found', p_invoice;
  end if;
  if not public.org_can_edit(v_org) then
    raise exception 'Not allowed to record payments in this organization';
  end if;
  return public.record_payment_internal(p_invoice, p_amount, p_date, p_method, p_reference,
                                        null, null, auth.uid());
end $$;

-- Webhook entry point: idempotent on processor_ref; service-role only.
create or replace function public.record_stripe_payment(
  p_processor_ref text,
  p_invoice       uuid,
  p_gross         numeric,
  p_fee           numeric default 0,
  p_payload       jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_org     uuid;
  v_clearing uuid;
  v_payment public.payments;
begin
  select org_id into v_org from public.invoices where id = p_invoice;
  if v_org is null then
    raise exception 'Invoice % not found', p_invoice;
  end if;

  -- Idempotency gate: one processor_ref, one payment, forever.
  begin
    insert into public.processor_events (org_id, processor_ref, kind, invoice_id, payload)
    values (v_org, p_processor_ref, 'checkout.session.completed', p_invoice, p_payload);
  exception when unique_violation then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end;

  select id into v_clearing from public.accounts
    where org_id = v_org and code = '1050' limit 1;

  v_payment := public.record_payment_internal(
    p_invoice, p_gross, current_date, 'stripe', p_processor_ref, v_clearing,
    nullif(p_fee, 0), null);

  update public.processor_events
    set payment_id = v_payment.id
    where processor_ref = p_processor_ref;

  return jsonb_build_object('ok', true, 'payment_id', v_payment.id);
end $$;

revoke execute on function public.record_stripe_payment(text, uuid, numeric, numeric, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_stripe_payment(text, uuid, numeric, numeric, jsonb)
  to service_role;

-- ---------- invoice reminders ----------

create table if not exists public.reminder_log (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  to_email    text not null,
  status      text not null default 'sent',
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists reminder_log_invoice_idx on public.reminder_log(invoice_id, created_at desc);

alter table public.reminder_log enable row level security;
drop policy if exists reminder_log_select on public.reminder_log;
create policy reminder_log_select on public.reminder_log
  for select using (public.org_can_view_financials(org_id));

-- Who gets nudged: overdue, open, has an email, not reminded in 3 days,
-- at most 5 nudges per invoice. Plain SQL — covered by the local suite.
create or replace view public.v_reminder_candidates as
select
  i.id as invoice_id,
  i.org_id,
  i.number,
  i.share_token,
  i.due_date,
  (current_date - i.due_date) as days_overdue,
  c.email as to_email,
  c.name as contact_name,
  o.name as org_name,
  (t.total - coalesce(p.paid, 0))::numeric(14,2) as balance
from public.invoices i
join public.contacts c on c.id = i.contact_id and c.email is not null
join public.organizations o on o.id = i.org_id
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
  and i.due_date is not null
  and i.due_date < current_date
  and (t.total - coalesce(p.paid, 0)) > 0
  and not exists (
    select 1 from public.reminder_log r
    where r.invoice_id = i.id and r.created_at > now() - interval '3 days'
  )
  and (select count(*) from public.reminder_log r2 where r2.invoice_id = i.id) < 5;

alter view public.v_reminder_candidates set (security_invoker = true);
grant select on public.v_reminder_candidates to authenticated;

-- The sender: Vault key + pg_net. Runs under pg_cron on the platform;
-- guarded so environments without those extensions skip gracefully.
create or replace function public.send_invoice_reminders()
returns int language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_key text;
  v_count int := 0;
  v_app_url text;
begin
  if to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'net' and p.proname = 'http_post') then
    return 0;  -- platform extensions absent (local harness)
  end if;

  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  if v_key is null then
    return 0;
  end if;

  for r in select * from public.v_reminder_candidates limit 25 loop
    v_app_url := 'https://biwnmfauratqfbywxxtz.supabase.co';  -- share links render in-app; origin configurable later
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_key,
        'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'from', r.org_name || ' <onboarding@resend.dev>',
        'to', jsonb_build_array(r.to_email),
        'subject', 'Reminder: invoice #' || r.number || ' is ' || r.days_overdue || ' day(s) overdue',
        'text',
          'Hi ' || coalesce(r.contact_name, '') || ',' || E'\n\n' ||
          'A friendly reminder that invoice #' || r.number || ' (balance ' || r.balance ||
          ') was due on ' || r.due_date || '.' || E'\n\n' ||
          'Questions? Just reply to this email.' || E'\n\n— ' || r.org_name)
    );
    insert into public.reminder_log (org_id, invoice_id, to_email)
    values (r.org_id, r.invoice_id, r.to_email);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

revoke execute on function public.send_invoice_reminders() from public, anon;
grant execute on function public.send_invoice_reminders() to authenticated, service_role;

-- Enable the platform extensions where available (no-ops locally).
do $$
begin
  begin
    create extension if not exists pg_net;
  exception when others then null;
  end;
  begin
    create extension if not exists pg_cron;
  exception when others then null;
  end;
end $$;

-- Daily schedule where pg_cron exists (the platform).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('invoice-reminders')
      where exists (select 1 from cron.job where jobname = 'invoice-reminders');
    perform cron.schedule('invoice-reminders', '0 15 * * *',
                          'select public.send_invoice_reminders()');
  end if;
end $$;
