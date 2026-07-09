-- Phase 5, step 2: proposals — the quote side of quote-to-actual.
--
-- Lines snapshot estimated_cost / estimated_hours from the catalog at insert,
-- so later margin analysis compares what was promised with what the ledger
-- says actually happened. Acceptance is anonymous (share token) and records
-- evidence; the full Win cascade lands in 0034.

do $$ begin
  create type proposal_status as enum ('draft', 'sent', 'accepted', 'declined', 'expired');
exception when duplicate_object then null; end $$;

create table if not exists public.proposals (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  contact_id        uuid not null references public.contacts(id) on delete restrict,
  deal_id           uuid references public.deals(id) on delete set null,
  title             text not null check (length(trim(title)) > 0),
  project_type      text,
  status            proposal_status not null default 'draft',
  share_token       uuid not null unique default gen_random_uuid(),
  deposit_pct       numeric(5,2) not null default 50 check (deposit_pct >= 0 and deposit_pct <= 100),
  valid_until       date,
  task_template_id  uuid references public.task_templates(id) on delete set null,
  memo              text,
  sent_at           timestamptz,
  accepted_at       timestamptz,
  accepted_name     text,
  accepted_ip       text,
  accepted_ua       text,
  -- win artifacts (0034); doubles as the idempotency record
  project_id        uuid references public.projects(id) on delete set null,
  contract_id       uuid,
  invoice_id        uuid references public.invoices(id) on delete set null,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists proposals_org_idx on public.proposals(org_id, status);
create index if not exists proposals_contact_idx on public.proposals(contact_id);

drop trigger if exists proposals_updated_at on public.proposals;
create trigger proposals_updated_at
  before update on public.proposals
  for each row execute procedure public.set_updated_at();

drop trigger if exists proposals_set_org on public.proposals;
create trigger proposals_set_org
  before insert on public.proposals
  for each row execute procedure public.set_org_id();

create or replace function public.check_proposal_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.contacts where id = NEW.contact_id), 'proposal → contact');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.deals where id = NEW.deal_id), 'proposal → deal');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.task_templates where id = NEW.task_template_id), 'proposal → template');
  return NEW;
end $$;

drop trigger if exists proposals_zz_org_refs on public.proposals;
create trigger proposals_zz_org_refs
  before insert or update of contact_id, deal_id, task_template_id, org_id on public.proposals
  for each row execute procedure public.check_proposal_org();

-- State machine: header/lines frozen after draft; money-adjacent transitions
-- via RPCs (flag), user may draft→sent and sent→declined/expired.
create or replace function public.enforce_proposal_transitions()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.proposal_rpc', true), '') = 'on';
begin
  if via_rpc then
    return NEW;
  end if;
  if (NEW.contact_id is distinct from OLD.contact_id
      or NEW.deposit_pct is distinct from OLD.deposit_pct
      or NEW.title is distinct from OLD.title)
     and OLD.status <> 'draft' then
    raise exception 'Proposal is frozen after draft' using errcode = 'check_violation';
  end if;
  if NEW.status is distinct from OLD.status then
    if OLD.status = 'draft' and NEW.status = 'sent' then
      NEW.sent_at := coalesce(NEW.sent_at, now());
    elsif OLD.status = 'sent' and NEW.status in ('declined', 'expired') then
      null;
    else
      raise exception 'Proposal transition % → % goes through the accept/win flow',
        OLD.status, NEW.status using errcode = 'check_violation';
    end if;
  end if;
  if NEW.project_id is distinct from OLD.project_id
     or NEW.contract_id is distinct from OLD.contract_id
     or NEW.invoice_id is distinct from OLD.invoice_id then
    raise exception 'Win artifacts are managed by the win flow' using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

drop trigger if exists proposals_transitions on public.proposals;
create trigger proposals_transitions
  before update on public.proposals
  for each row execute procedure public.enforce_proposal_transitions();

-- ---------- proposal_lines ----------

create table if not exists public.proposal_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  proposal_id      uuid not null references public.proposals(id) on delete cascade,
  catalog_item_id  uuid references public.catalog_items(id) on delete set null,
  description      text not null,
  qty              numeric(10,2) not null default 1 check (qty > 0),
  unit_price       numeric(14,2) not null default 0 check (unit_price >= 0),
  tax_rate_id      uuid references public.tax_rates(id) on delete set null,
  estimated_cost   numeric(14,2) check (estimated_cost is null or estimated_cost >= 0),
  estimated_hours  numeric(10,2) check (estimated_hours is null or estimated_hours >= 0),
  line_number      int not null default 1,
  created_at       timestamptz not null default now()
);
create index if not exists proposal_lines_proposal_idx on public.proposal_lines(proposal_id);

create or replace function public.proposal_lines_bookkeeping()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status proposal_status;
  via_rpc boolean := coalesce(current_setting('app.proposal_rpc', true), '') = 'on';
begin
  if not via_rpc then
    select status into v_status from public.proposals
      where id = coalesce(NEW.proposal_id, OLD.proposal_id);
    if v_status is distinct from 'draft' then
      raise exception 'Proposal lines are frozen once sent' using errcode = 'check_violation';
    end if;
  end if;
  if TG_OP = 'DELETE' then
    return OLD;
  end if;

  if NEW.org_id is null then
    select p.org_id into NEW.org_id from public.proposals p where p.id = NEW.proposal_id;
  end if;
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.catalog_items where id = NEW.catalog_item_id), 'line → catalog');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.tax_rates where id = NEW.tax_rate_id), 'line → tax rate');

  -- Quote-to-actual snapshots from the catalog at insert time.
  if TG_OP = 'INSERT' and NEW.catalog_item_id is not null then
    select coalesce(NEW.estimated_cost, ci.estimated_cost),
           coalesce(NEW.estimated_hours, ci.estimated_hours)
      into NEW.estimated_cost, NEW.estimated_hours
      from public.catalog_items ci where ci.id = NEW.catalog_item_id;
  end if;
  return NEW;
end $$;

drop trigger if exists proposal_lines_bookkeeping on public.proposal_lines;
create trigger proposal_lines_bookkeeping
  before insert or update or delete on public.proposal_lines
  for each row execute procedure public.proposal_lines_bookkeeping();

-- ---------- totals + guardrail views ----------

create or replace view public.v_proposal_totals as
select
  p.id as proposal_id,
  p.org_id,
  coalesce(sum(round(l.qty * l.unit_price, 2)), 0)::numeric(14,2) as subtotal,
  coalesce(sum(round(l.qty * l.unit_price * coalesce(t.rate, 0), 2)), 0)::numeric(14,2) as tax_total,
  (coalesce(sum(round(l.qty * l.unit_price, 2)), 0)
   + coalesce(sum(round(l.qty * l.unit_price * coalesce(t.rate, 0), 2)), 0))::numeric(14,2) as total,
  coalesce(sum(l.estimated_cost), 0)::numeric(14,2) as estimated_cost,
  coalesce(sum(l.estimated_hours), 0)::numeric(10,2) as estimated_hours
from public.proposals p
left join public.proposal_lines l on l.proposal_id = p.id
left join public.tax_rates t on t.id = l.tax_rate_id
group by p.id, p.org_id;

alter view public.v_proposal_totals set (security_invoker = true);
grant select on public.v_proposal_totals to authenticated;

-- Historical realized economics per project type — the guardrail's baseline.
create or replace view public.v_project_type_costs as
select
  pr.org_id,
  coalesce(nullif(trim(pr.project_type), ''), 'Untyped') as project_type,
  count(*)                                    as projects,
  round(avg(pnl.cogs + pnl.expense), 2)       as avg_cost,
  round(avg(pnl.revenue), 2)                  as avg_revenue,
  round(avg(pnl.net_margin), 2)               as avg_margin
from public.v_project_pnl pnl
join public.projects pr on pr.id = pnl.project_id
where (pnl.revenue <> 0 or pnl.cogs <> 0 or pnl.expense <> 0)
group by pr.org_id, coalesce(nullif(trim(pr.project_type), ''), 'Untyped');

alter view public.v_project_type_costs set (security_invoker = true);
grant select on public.v_project_type_costs to authenticated;

-- ---------- anon surfaces ----------

create or replace function public.get_public_proposal(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  p public.proposals;
begin
  select * into p from public.proposals
    where share_token = p_token and status in ('sent', 'accepted', 'declined', 'expired');
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'title', p.title,
    'status', p.status,
    'valid_until', p.valid_until,
    'deposit_pct', p.deposit_pct,
    'memo', p.memo,
    'org_name', (select o.name from public.organizations o where o.id = p.org_id),
    'contact_name', (select c.name from public.contacts c where c.id = p.contact_id),
    'accepted_at', p.accepted_at,
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'description', l.description, 'qty', l.qty, 'unit_price', l.unit_price,
        'amount', round(l.qty * l.unit_price, 2),
        'tax_name', t.name, 'tax_rate', t.rate
      ) order by l.line_number), '[]'::jsonb)
      from public.proposal_lines l
      left join public.tax_rates t on t.id = l.tax_rate_id
      where l.proposal_id = p.id
    ),
    'totals', (
      select jsonb_build_object('subtotal', v.subtotal, 'tax_total', v.tax_total, 'total', v.total)
      from public.v_proposal_totals v where v.proposal_id = p.id
    )
  );
end $$;

grant execute on function public.get_public_proposal(uuid) to anon, authenticated;

-- Marks acceptance with evidence. The Win cascade (0034) replaces this with a
-- version that continues into project/contract/invoice in the same call.
create or replace function public.accept_proposal(p_token uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.proposals;
  v_headers jsonb;
begin
  select * into p from public.proposals where share_token = p_token for update;
  if not found or p.status <> 'sent' then
    raise exception 'This proposal is not open for acceptance';
  end if;
  if p.valid_until is not null and p.valid_until < current_date then
    perform set_config('app.proposal_rpc', 'on', true);
    update public.proposals set status = 'expired' where id = p.id;
    perform set_config('app.proposal_rpc', '', true);
    raise exception 'This proposal has expired';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Please type your name to accept';
  end if;

  v_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);

  perform set_config('app.proposal_rpc', 'on', true);
  update public.proposals set
    status = 'accepted',
    accepted_at = now(),
    accepted_name = trim(p_name),
    accepted_ip = v_headers ->> 'x-forwarded-for',
    accepted_ua = v_headers ->> 'user-agent'
    where id = p.id;
  perform set_config('app.proposal_rpc', '', true);

  return jsonb_build_object('ok', true, 'status', 'accepted');
end $$;

grant execute on function public.accept_proposal(uuid, text) to anon, authenticated;

-- ---------- RLS + audit ----------

alter table public.proposals      enable row level security;
alter table public.proposal_lines enable row level security;

drop policy if exists proposals_select on public.proposals;
create policy proposals_select on public.proposals
  for select using (public.org_can_view_financials(org_id));
drop policy if exists proposals_modify on public.proposals;
create policy proposals_modify on public.proposals
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists proposal_lines_select on public.proposal_lines;
create policy proposal_lines_select on public.proposal_lines
  for select using (public.org_can_view_financials(org_id));
drop policy if exists proposal_lines_modify on public.proposal_lines;
create policy proposal_lines_modify on public.proposal_lines
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop trigger if exists audit_proposals on public.proposals;
create trigger audit_proposals
  after insert or update or delete on public.proposals
  for each row execute procedure public.log_audit('proposal');
