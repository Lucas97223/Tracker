-- Phase 6c: bank-feed staging + reconciliation + GL export.
--
-- Bank rows are STAGING — they never post anything. Reconciling links a bank
-- row to the ledger's cash-side line it corresponds to, so the books get
-- independently confirmed against the outside world. The export view
-- flattens posted journal activity for QuickBooks-style CSV import.

alter type audit_entity add value if not exists 'bank_transaction';

create table if not exists public.bank_transactions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  txn_date         date not null,
  amount           numeric(14,2) not null,  -- signed: + in, − out
  description      text not null default '',
  source           text,                     -- e.g. the uploaded file name
  reconciled       boolean not null default false,
  matched_line_id  uuid references public.journal_lines(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists bank_transactions_org_idx
  on public.bank_transactions(org_id, reconciled, txn_date desc);
-- import dedupe: identical (date, amount, description) rows land once
create unique index if not exists bank_transactions_dedupe_key
  on public.bank_transactions(org_id, txn_date, amount, md5(description));

drop trigger if exists bank_transactions_set_org on public.bank_transactions;
create trigger bank_transactions_set_org
  before insert on public.bank_transactions
  for each row execute procedure public.set_org_id();

alter table public.bank_transactions enable row level security;

drop policy if exists bank_transactions_select on public.bank_transactions;
create policy bank_transactions_select on public.bank_transactions
  for select using (public.org_can_view_financials(org_id));
drop policy if exists bank_transactions_modify on public.bank_transactions;
create policy bank_transactions_modify on public.bank_transactions
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop trigger if exists audit_bank_transactions on public.bank_transactions;
create trigger audit_bank_transactions
  after insert or update or delete on public.bank_transactions
  for each row execute procedure public.log_audit('bank_transaction');

-- ---------- match suggestions ----------

-- Cash-side ledger lines (1000 Cash, 1050 Stripe Clearing) with the same
-- magnitude within ±5 days, not already claimed by another bank row.
create or replace view public.v_bank_match_suggestions as
select
  bt.id            as bank_transaction_id,
  bt.org_id,
  bt.txn_date,
  bt.amount        as bank_amount,
  bt.description   as bank_description,
  jl.id            as line_id,
  je.entry_date,
  je.memo,
  a.code           as account_code,
  case when jl.debit > 0 then jl.debit else -jl.credit end as ledger_amount,
  abs(bt.txn_date - je.entry_date) as day_distance
from public.bank_transactions bt
join public.journal_lines jl
  on jl.org_id = bt.org_id
join public.accounts a
  on a.id = jl.account_id and a.code in ('1000', '1050')
join public.journal_entries je
  on je.id = jl.journal_entry_id and je.posted
where not bt.reconciled
  and abs(bt.txn_date - je.entry_date) <= 5
  and ((bt.amount > 0 and jl.debit  = bt.amount)
    or (bt.amount < 0 and jl.credit = -bt.amount))
  and not exists (
    select 1 from public.bank_transactions other
    where other.matched_line_id = jl.id and other.reconciled
  );

alter view public.v_bank_match_suggestions set (security_invoker = true);
grant select on public.v_bank_match_suggestions to authenticated;

-- ---------- reconcile / unreconcile ----------

create or replace function public.reconcile_bank_txn(p_txn uuid, p_line uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  bt public.bank_transactions;
  v_line_org uuid;
  v_ok boolean;
begin
  select * into bt from public.bank_transactions where id = p_txn for update;
  if not found then
    raise exception 'Bank transaction not found';
  end if;
  if not public.org_can_edit(bt.org_id) then
    raise exception 'Not allowed to reconcile in this organization';
  end if;
  if bt.reconciled then
    raise exception 'Already reconciled';
  end if;

  select jl.org_id,
         ((bt.amount > 0 and jl.debit = bt.amount)
          or (bt.amount < 0 and jl.credit = -bt.amount))
    into v_line_org, v_ok
    from public.journal_lines jl where jl.id = p_line;
  if v_line_org is null or v_line_org <> bt.org_id then
    raise exception 'Ledger line belongs to a different organization' using errcode = 'check_violation';
  end if;
  if not v_ok then
    raise exception 'Amounts do not match — reconciliation must be exact' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.bank_transactions o
             where o.matched_line_id = p_line and o.reconciled) then
    raise exception 'That ledger line is already matched to another bank row'
      using errcode = 'check_violation';
  end if;

  update public.bank_transactions
    set reconciled = true, matched_line_id = p_line
    where id = p_txn;
end $$;

grant execute on function public.reconcile_bank_txn(uuid, uuid) to authenticated;

create or replace function public.unreconcile_bank_txn(p_txn uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  bt public.bank_transactions;
begin
  select * into bt from public.bank_transactions where id = p_txn for update;
  if not found then
    raise exception 'Bank transaction not found';
  end if;
  if not public.org_can_edit(bt.org_id) then
    raise exception 'Not allowed to reconcile in this organization';
  end if;
  update public.bank_transactions
    set reconciled = false, matched_line_id = null
    where id = p_txn;
end $$;

grant execute on function public.unreconcile_bank_txn(uuid) to authenticated;

-- ---------- GL export ----------

create or replace view public.v_gl_export as
select
  je.entry_date,
  je.id as entry_id,
  coalesce(je.reference, '') as reference,
  coalesce(je.memo, '') as memo,
  je.source_type,
  a.code as account_code,
  a.name as account_name,
  jl.debit,
  jl.credit,
  coalesce((select name from public.projects p where p.id = jl.project_id), '') as project,
  jl.org_id
from public.journal_lines jl
join public.journal_entries je on je.id = jl.journal_entry_id and je.posted
join public.accounts a on a.id = jl.account_id;

alter view public.v_gl_export set (security_invoker = true);
grant select on public.v_gl_export to authenticated;
