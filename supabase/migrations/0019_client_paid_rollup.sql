-- Phase 1, step 4 (decision D3): projects.client_paid becomes a derived,
-- write-blocked rollup of payments.
--
-- Legacy data: every project with a manually-typed client_paid balance gets a
-- backfilled "Historical balance" invoice + payment + balanced journal entry
-- (DR cash / CR service revenue), so historical revenue is ledger-backed and
-- the rollup reproduces the old numbers exactly. Reads keep working; direct
-- writes now fail at the database (unchanged-value writes still pass, so the
-- Electron offline queue's whole-row updates stay safe).

-- ---------- rollup ----------

create or replace function public.recompute_client_paid(p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_project is null then return; end if;
  perform set_config('app.client_paid_rollup', 'on', true);
  update public.projects p
  set client_paid = coalesce((
    select sum(pay.amount)
    from public.payments pay
    join public.invoices i on i.id = pay.invoice_id
    where i.project_id = p_project and pay.voided_at is null
  ), 0)
  where p.id = p_project;
  perform set_config('app.client_paid_rollup', '', true);
end $$;

create or replace function public.payments_rollup_client_paid()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
begin
  select project_id into v_project from public.invoices
    where id = coalesce(NEW.invoice_id, OLD.invoice_id);
  perform public.recompute_client_paid(v_project);
  return coalesce(NEW, OLD);
end $$;

drop trigger if exists payments_client_paid_rollup on public.payments;
create trigger payments_client_paid_rollup
  after insert or update or delete on public.payments
  for each row execute procedure public.payments_rollup_client_paid();

-- Invoices can move between projects only in draft (no payments yet), but a
-- voided-then-unvoided edge or project reassignment is still covered:
create or replace function public.invoices_rollup_client_paid()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.project_id is distinct from OLD.project_id then
    perform public.recompute_client_paid(OLD.project_id);
    perform public.recompute_client_paid(NEW.project_id);
  end if;
  return NEW;
end $$;

drop trigger if exists invoices_client_paid_rollup on public.invoices;
create trigger invoices_client_paid_rollup
  after update of project_id on public.invoices
  for each row execute procedure public.invoices_rollup_client_paid();

-- ---------- write-block ----------

create or replace function public.block_client_paid_writes()
returns trigger language plpgsql as $$
declare
  via_rollup boolean := coalesce(current_setting('app.client_paid_rollup', true), '') = 'on';
begin
  if via_rollup then
    return NEW;
  end if;
  if TG_OP = 'INSERT' then
    if coalesce(NEW.client_paid, 0) <> 0 then
      raise exception 'client_paid is derived from payments; record a payment instead'
        using errcode = 'check_violation';
    end if;
  elsif NEW.client_paid is distinct from OLD.client_paid then
    raise exception 'client_paid is derived from payments; record a payment instead'
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

drop trigger if exists projects_client_paid_guard on public.projects;
create trigger projects_client_paid_guard
  before insert or update of client_paid on public.projects
  for each row execute procedure public.block_client_paid_writes();

-- ---------- legacy backfill ----------

-- Posts inline (system context, no auth) rather than through record_payment().
-- One invoice + one payment per legacy balance. Idempotent — safe to re-run;
-- exposed as a function so the test suite can exercise it against planted
-- legacy rows.
create or replace function public.backfill_legacy_client_paid()
returns int language plpgsql security definer set search_path = public as $$
declare
  proj record;
  v_contact uuid;
  v_invoice uuid;
  v_payment uuid;
  v_je      uuid;
  v_cash    uuid;
  v_rev     uuid;
  v_date    date;
  v_count   int := 0;
begin
  perform set_config('app.invoice_rpc', 'on', true);
  perform set_config('app.payment_rpc', 'on', true);

  for proj in
    select * from public.projects
    where client_paid > 0
      and not exists (
        select 1 from public.invoices i
        where i.project_id = projects.id and i.memo = 'Historical balance (pre-ledger)'
      )
  loop
    v_date := coalesce(proj.end_date, proj.start_date, proj.created_at::date);

    -- Contact: the project's, else find-or-create from its client text.
    v_contact := proj.contact_id;
    if v_contact is null then
      select id into v_contact from public.contacts
        where org_id = proj.org_id
          and lower(name) = lower(coalesce(nullif(trim(proj.client), ''), 'Unknown client'));
      if v_contact is null then
        insert into public.contacts (org_id, type, lifecycle, name, source)
        values (proj.org_id, 'company', 'client',
                coalesce(nullif(trim(proj.client), ''), 'Unknown client'),
                'backfill:client_paid')
        returning id into v_contact;
      end if;
      update public.projects set contact_id = v_contact where id = proj.id;
    end if;

    select id into v_cash from public.accounts where org_id = proj.org_id and code = '1000' limit 1;
    select id into v_rev  from public.accounts where org_id = proj.org_id and code = '4100' limit 1;
    if v_cash is null or v_rev is null then
      raise exception 'Org % missing 1000/4100 accounts for legacy backfill', proj.org_id;
    end if;

    insert into public.invoices
      (org_id, contact_id, project_id, status, issue_date, due_date, sent_at, memo)
    values
      (proj.org_id, v_contact, proj.id, 'paid', v_date, v_date, now(),
       'Historical balance (pre-ledger)')
    returning id into v_invoice;

    insert into public.invoice_lines
      (org_id, invoice_id, description, qty, unit_price, line_number)
    values
      (proj.org_id, v_invoice, 'Historical client payments (pre-ledger balance)',
       1, proj.client_paid, 1);

    v_payment := gen_random_uuid();
    insert into public.journal_entries
      (entry_date, memo, source_type, source_id, project_id, posted, posted_at, org_id)
    values
      (v_date, 'Legacy client payments — ' || proj.name, 'payment', v_payment,
       proj.id, true, now(), proj.org_id)
    returning id into v_je;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
    values
      (v_je, v_cash, proj.client_paid, 0, 'Legacy balance', proj.id, 1, proj.org_id),
      (v_je, v_rev,  0, proj.client_paid, 'Legacy balance', proj.id, 2, proj.org_id);

    insert into public.payments
      (id, org_id, invoice_id, payment_date, amount, method, reference, journal_entry_id)
    values
      (v_payment, proj.org_id, v_invoice, v_date, proj.client_paid, 'legacy',
       'client_paid backfill', v_je);
    -- The payments trigger recomputes client_paid to Σ payments = old value.
    v_count := v_count + 1;
  end loop;

  perform set_config('app.invoice_rpc', '', true);
  perform set_config('app.payment_rpc', '', true);
  return v_count;
end $$;

-- Run it for the migration itself.
select public.backfill_legacy_client_paid();

-- Not callable by API roles (system/migration tool only). PUBLIC must be
-- revoked too — Postgres grants functions to PUBLIC by default.
revoke execute on function public.backfill_legacy_client_paid() from public, anon, authenticated;
