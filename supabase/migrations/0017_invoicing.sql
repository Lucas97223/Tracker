-- Phase 1, step 2: invoices as operational AR documents (decision D7).
--
-- Invoices NEVER post to the GL (cash basis): they drive AR aging, reminders
-- and schedules. Money hits the ledger only when a payment is recorded (0018).
-- Totals are always derived from lines (I1/I2: no editable total columns):
-- v_invoice_amounts here, extended with paid/balance in 0018.
--
--   tax_rates          rate as a fraction (0.0825 = 8.25%) + the liability
--                      account it accrues to (2200 by default)
--   invoices           per-org numbering, draft|sent|partial|paid|void with a
--                      guarded state machine; share_token for the public link
--   invoice_lines      qty × unit_price (+ tax_rate), optional revenue account
--                      override, nullable source refs for Phase 3 time/expense
--                      pulls; editable only while the invoice is draft
--   payment_schedules  installments against an invoice or a project

do $$ begin
  create type invoice_status as enum ('draft', 'sent', 'partial', 'paid', 'void');
exception when duplicate_object then null; end $$;

do $$ begin
  create type schedule_status as enum ('pending', 'paid', 'cancelled');
exception when duplicate_object then null; end $$;

alter type audit_entity add value if not exists 'payment_schedule';

-- ---------- tax_rates ----------

create table if not exists public.tax_rates (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  name                  text not null,
  rate                  numeric(7,4) not null check (rate >= 0 and rate < 1),
  liability_account_id  uuid not null references public.accounts(id),
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists tax_rates_org_idx on public.tax_rates(org_id);

drop trigger if exists tax_rates_updated_at on public.tax_rates;
create trigger tax_rates_updated_at
  before update on public.tax_rates
  for each row execute procedure public.set_updated_at();

drop trigger if exists tax_rates_set_org on public.tax_rates;
create trigger tax_rates_set_org
  before insert on public.tax_rates
  for each row execute procedure public.set_org_id();

create or replace function public.check_tax_rate_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type account_type;
  v_org  uuid;
begin
  select type, org_id into v_type, v_org from public.accounts where id = NEW.liability_account_id;
  perform public.assert_same_org(NEW.org_id, v_org, 'tax rate → account');
  if v_type is distinct from 'liability' then
    raise exception 'Sales tax must accrue to a liability account (never revenue)'
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

drop trigger if exists tax_rates_zz_org_refs on public.tax_rates;
create trigger tax_rates_zz_org_refs
  before insert or update of liability_account_id, org_id on public.tax_rates
  for each row execute procedure public.check_tax_rate_org();

-- ---------- invoices ----------

create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  number       int,
  contact_id   uuid not null references public.contacts(id) on delete restrict,
  project_id   uuid references public.projects(id) on delete set null,
  status       invoice_status not null default 'draft',
  issue_date   date not null default current_date,
  due_date     date,
  sent_at      timestamptz,
  memo         text,
  share_token  uuid not null unique default gen_random_uuid(),
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (org_id, number)
);
create index if not exists invoices_org_idx on public.invoices(org_id);
create index if not exists invoices_contact_idx on public.invoices(contact_id);
create index if not exists invoices_project_idx on public.invoices(project_id);
create index if not exists invoices_status_idx on public.invoices(org_id, status);

drop trigger if exists invoices_updated_at on public.invoices;
create trigger invoices_updated_at
  before update on public.invoices
  for each row execute procedure public.set_updated_at();

drop trigger if exists invoices_set_org on public.invoices;
create trigger invoices_set_org
  before insert on public.invoices
  for each row execute procedure public.set_org_id();

-- Per-org sequential numbering, race-safe via an org-scoped advisory lock.
create or replace function public.assign_invoice_number()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.number is null then
    perform pg_advisory_xact_lock(hashtext('invoice_number:' || NEW.org_id::text));
    select coalesce(max(number), 0) + 1 into NEW.number
      from public.invoices where org_id = NEW.org_id;
  end if;
  return NEW;
end $$;

drop trigger if exists invoices_ss_number on public.invoices;
create trigger invoices_ss_number
  before insert on public.invoices
  for each row execute procedure public.assign_invoice_number();

create or replace function public.check_invoice_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.contacts where id = NEW.contact_id), 'invoice → contact');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'invoice → project');
  return NEW;
end $$;

drop trigger if exists invoices_zz_org_refs on public.invoices;
create trigger invoices_zz_org_refs
  before insert or update of contact_id, project_id, org_id on public.invoices
  for each row execute procedure public.check_invoice_org();

-- State machine. Money-driven transitions (sent↔partial↔paid) belong to the
-- payment RPCs (0018), which set a transaction-local flag. Users may:
--   draft: edit anything, → sent, → void
--   sent:  edit due_date/memo only, → void (no live payments; checked in 0018's RPC path too)
create or replace function public.enforce_invoice_transitions()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.invoice_rpc', true), '') = 'on';
begin
  if via_rpc then
    return NEW;
  end if;

  if NEW.number is distinct from OLD.number
     or NEW.contact_id is distinct from OLD.contact_id and OLD.status <> 'draft'
     or NEW.project_id is distinct from OLD.project_id and OLD.status <> 'draft'
     or NEW.issue_date is distinct from OLD.issue_date and OLD.status <> 'draft'
     or NEW.org_id is distinct from OLD.org_id then
    raise exception 'Invoice % header is frozen after draft', OLD.id
      using errcode = 'check_violation';
  end if;

  if NEW.status is distinct from OLD.status then
    if OLD.status = 'draft' and NEW.status = 'sent' then
      NEW.sent_at := coalesce(NEW.sent_at, now());
    elsif OLD.status in ('draft', 'sent') and NEW.status = 'void' then
      null; -- void with recorded payments is blocked below
    else
      raise exception 'Invoice transition % → % goes through the payment RPCs',
        OLD.status, NEW.status using errcode = 'check_violation';
    end if;
  end if;

  return NEW;
end $$;

drop trigger if exists invoices_transitions on public.invoices;
create trigger invoices_transitions
  before update on public.invoices
  for each row execute procedure public.enforce_invoice_transitions();

-- ---------- invoice_lines ----------

create table if not exists public.invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  invoice_id          uuid not null references public.invoices(id) on delete cascade,
  description         text not null,
  qty                 numeric(10,2) not null default 1 check (qty > 0),
  unit_price          numeric(14,2) not null default 0 check (unit_price >= 0),
  tax_rate_id         uuid references public.tax_rates(id) on delete restrict,
  revenue_account_id  uuid references public.accounts(id),
  source_type         text,          -- time_entry | expense | catalog_item (Phase 3+)
  source_id           uuid,
  line_number         int not null default 1,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists invoice_lines_invoice_idx on public.invoice_lines(invoice_id);
create index if not exists invoice_lines_org_idx on public.invoice_lines(org_id);

drop trigger if exists invoice_lines_updated_at on public.invoice_lines;
create trigger invoice_lines_updated_at
  before update on public.invoice_lines
  for each row execute procedure public.set_updated_at();

create or replace function public.set_org_id_from_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select i.org_id into NEW.org_id from public.invoices i where i.id = NEW.invoice_id;
  end if;
  return NEW;
end $$;

drop trigger if exists invoice_lines_set_org on public.invoice_lines;
create trigger invoice_lines_set_org
  before insert on public.invoice_lines
  for each row execute procedure public.set_org_id_from_invoice();

create or replace function public.check_invoice_line_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_acct_type account_type;
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.invoices where id = NEW.invoice_id), 'line → invoice');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.tax_rates where id = NEW.tax_rate_id), 'line → tax rate');
  if NEW.revenue_account_id is not null then
    select type into v_acct_type from public.accounts where id = NEW.revenue_account_id;
    perform public.assert_same_org(
      NEW.org_id, (select org_id from public.accounts where id = NEW.revenue_account_id), 'line → account');
    if v_acct_type is distinct from 'revenue' then
      raise exception 'Invoice lines may only credit revenue accounts'
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists invoice_lines_zz_org_refs on public.invoice_lines;
create trigger invoice_lines_zz_org_refs
  before insert or update of invoice_id, tax_rate_id, revenue_account_id, org_id on public.invoice_lines
  for each row execute procedure public.check_invoice_line_org();

-- Lines are immutable once the invoice leaves draft.
create or replace function public.enforce_invoice_line_freeze()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status invoice_status;
  via_rpc boolean := coalesce(current_setting('app.invoice_rpc', true), '') = 'on';
begin
  if via_rpc then
    return coalesce(NEW, OLD);
  end if;
  select status into v_status from public.invoices
    where id = coalesce(NEW.invoice_id, OLD.invoice_id);
  if v_status is distinct from 'draft' then
    raise exception 'Invoice lines are frozen once the invoice is sent'
      using errcode = 'check_violation';
  end if;
  return coalesce(NEW, OLD);
end $$;

drop trigger if exists invoice_lines_freeze on public.invoice_lines;
create trigger invoice_lines_freeze
  before insert or update or delete on public.invoice_lines
  for each row execute procedure public.enforce_invoice_line_freeze();

-- ---------- derived amounts ----------

create or replace view public.v_invoice_amounts as
select
  i.id                                           as invoice_id,
  i.org_id,
  coalesce(sum(round(l.qty * l.unit_price, 2)), 0)::numeric(14,2) as subtotal,
  coalesce(sum(round(l.qty * l.unit_price * coalesce(t.rate, 0), 2)), 0)::numeric(14,2) as tax_total,
  (coalesce(sum(round(l.qty * l.unit_price, 2)), 0)
   + coalesce(sum(round(l.qty * l.unit_price * coalesce(t.rate, 0), 2)), 0))::numeric(14,2) as total
from public.invoices i
left join public.invoice_lines l on l.invoice_id = i.id
left join public.tax_rates t on t.id = l.tax_rate_id
group by i.id, i.org_id;

alter view public.v_invoice_amounts set (security_invoker = true);
grant select on public.v_invoice_amounts to authenticated;

-- ---------- payment_schedules ----------

create table if not exists public.payment_schedules (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  invoice_id  uuid references public.invoices(id) on delete cascade,
  project_id  uuid references public.projects(id) on delete cascade,
  due_date    date not null,
  amount      numeric(14,2) not null check (amount > 0),
  status      schedule_status not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (num_nonnulls(invoice_id, project_id) = 1)
);
create index if not exists payment_schedules_invoice_idx on public.payment_schedules(invoice_id);
create index if not exists payment_schedules_org_idx on public.payment_schedules(org_id);

drop trigger if exists payment_schedules_updated_at on public.payment_schedules;
create trigger payment_schedules_updated_at
  before update on public.payment_schedules
  for each row execute procedure public.set_updated_at();

drop trigger if exists payment_schedules_set_org on public.payment_schedules;
create trigger payment_schedules_set_org
  before insert on public.payment_schedules
  for each row execute procedure public.set_org_id();

create or replace function public.check_schedule_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.invoices where id = NEW.invoice_id), 'schedule → invoice');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'schedule → project');
  return NEW;
end $$;

drop trigger if exists payment_schedules_zz_org_refs on public.payment_schedules;
create trigger payment_schedules_zz_org_refs
  before insert or update of invoice_id, project_id, org_id on public.payment_schedules
  for each row execute procedure public.check_schedule_org();

-- ---------- RLS ----------

alter table public.tax_rates          enable row level security;
alter table public.invoices           enable row level security;
alter table public.invoice_lines      enable row level security;
alter table public.payment_schedules  enable row level security;

drop policy if exists tax_rates_select on public.tax_rates;
create policy tax_rates_select on public.tax_rates
  for select using (public.org_can_view_financials(org_id));
drop policy if exists tax_rates_modify_admin on public.tax_rates;
create policy tax_rates_modify_admin on public.tax_rates
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  for select using (public.org_can_view_financials(org_id));
drop policy if exists invoices_modify_editor on public.invoices;
create policy invoices_modify_editor on public.invoices
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists invoice_lines_select on public.invoice_lines;
create policy invoice_lines_select on public.invoice_lines
  for select using (public.org_can_view_financials(org_id));
drop policy if exists invoice_lines_modify_editor on public.invoice_lines;
create policy invoice_lines_modify_editor on public.invoice_lines
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists payment_schedules_select on public.payment_schedules;
create policy payment_schedules_select on public.payment_schedules
  for select using (public.org_can_view_financials(org_id));
drop policy if exists payment_schedules_modify_editor on public.payment_schedules;
create policy payment_schedules_modify_editor on public.payment_schedules
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

-- ---------- audit + realtime ----------

drop trigger if exists audit_invoices on public.invoices;
create trigger audit_invoices
  after insert or update or delete on public.invoices
  for each row execute procedure public.log_audit('invoice');

drop trigger if exists audit_tax_rates on public.tax_rates;
create trigger audit_tax_rates
  after insert or update or delete on public.tax_rates
  for each row execute procedure public.log_audit('tax_rate');

drop trigger if exists audit_payment_schedules on public.payment_schedules;
create trigger audit_payment_schedules
  after insert or update or delete on public.payment_schedules
  for each row execute procedure public.log_audit('payment_schedule');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.invoices;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.invoice_lines;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.payment_schedules;
    exception when duplicate_object then null; end;
  end if;
end $$;
