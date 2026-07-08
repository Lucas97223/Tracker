-- Phase 0.5, step 4: draft-then-approve team pay (approved Recon amendment D-C).
--
-- Replaces the legacy photographer-pay auto-sync ($0 expense rows that posted
-- to the GL immediately). Empirical finding while testing 0013: that legacy
-- flow is actually BROKEN on a clean 0001–0010 chain — a $0 expense produces
-- journal lines with debit=0 AND credit=0, violating 0007's "never neither"
-- check, which aborts the project write that added the photographer.
--
-- New model:
--   pay_items         draft | approved | void. Drafts carry no GL presence at
--                     all; approval posts DR 5100 Team Pay (COGS) / CR 2000
--                     Accounts Payable in one transaction (posting map §5).
--   sync trigger      photographers[] additions → team_members + project_members
--                     (the array remains the UI write path; labels unchanged).
--   member trigger    adding a project member auto-creates a draft pay item.
--
-- Status transitions are RPC-only (approve_pay_item / void_pay_item), enforced
-- by a trigger + transaction-local GUC so no API caller can flip a row to
-- approved or forge journal links directly.

-- ---------- enum + table ----------

do $$ begin
  create type pay_item_status as enum ('draft', 'approved', 'void');
exception when duplicate_object then null; end $$;

create table if not exists public.pay_items (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  project_id         uuid not null references public.projects(id) on delete cascade,
  project_member_id  uuid references public.project_members(id) on delete set null,
  team_member_id     uuid not null references public.team_members(id) on delete restrict,
  description        text not null default 'Photographer pay',
  amount             numeric(14,2) not null default 0 check (amount >= 0),
  pay_date           date not null default current_date,
  status             pay_item_status not null default 'draft',
  journal_entry_id   uuid references public.journal_entries(id) on delete restrict,
  approved_by        uuid references public.profiles(id) on delete set null,
  approved_at        timestamptz,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (status <> 'approved' or journal_entry_id is not null)
);
create index if not exists pay_items_project_idx on public.pay_items(project_id);
create index if not exists pay_items_team_idx on public.pay_items(team_member_id);
create index if not exists pay_items_org_idx on public.pay_items(org_id);
create index if not exists pay_items_status_idx on public.pay_items(status);

drop trigger if exists pay_items_updated_at on public.pay_items;
create trigger pay_items_updated_at
  before update on public.pay_items
  for each row execute procedure public.set_updated_at();

drop trigger if exists pay_items_set_org on public.pay_items;
create trigger pay_items_set_org
  before insert on public.pay_items
  for each row execute procedure public.set_org_id_from_project();

-- ---------- transition guard ----------

-- Inside approve/void RPCs we set a transaction-local flag; everything else
-- may only create drafts and edit drafts.
create or replace function public.enforce_pay_item_transitions()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.pay_item_rpc', true), '') = 'on';
begin
  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' and not via_rpc then
      raise exception 'Pay items are created as drafts; use approve_pay_item()'
        using errcode = 'check_violation';
    end if;
    if NEW.journal_entry_id is not null and not via_rpc then
      raise exception 'journal_entry_id is set by approve_pay_item() only'
        using errcode = 'check_violation';
    end if;
    return NEW;
  end if;

  if TG_OP = 'UPDATE' then
    if not via_rpc then
      if OLD.status = 'approved' then
        raise exception 'Approved pay item % is immutable; use void_pay_item()', OLD.id
          using errcode = 'check_violation';
      end if;
      if NEW.status is distinct from OLD.status and NEW.status <> 'draft' then
        raise exception 'Status changes go through approve_pay_item()/void_pay_item()'
          using errcode = 'check_violation';
      end if;
      if NEW.journal_entry_id is distinct from OLD.journal_entry_id then
        raise exception 'journal_entry_id is managed by the pay RPCs'
          using errcode = 'check_violation';
      end if;
    end if;
    return NEW;
  end if;

  -- DELETE: drafts and voids may be deleted; approved must be voided first.
  if OLD.status = 'approved' and not via_rpc then
    raise exception 'Void approved pay item % before deleting it', OLD.id
      using errcode = 'check_violation';
  end if;
  return OLD;
end $$;

drop trigger if exists pay_items_transitions on public.pay_items;
create trigger pay_items_transitions
  before insert or update or delete on public.pay_items
  for each row execute procedure public.enforce_pay_item_transitions();

-- ---------- RPCs ----------

create or replace function public.approve_pay_item(p_id uuid)
returns public.pay_items language plpgsql security definer set search_path = public as $$
declare
  v          public.pay_items;
  v_name     text;
  v_labor    uuid;
  v_payable  uuid;
  v_je       uuid;
begin
  select * into v from public.pay_items where id = p_id for update;
  if not found then
    raise exception 'Pay item % not found', p_id;
  end if;
  if not public.org_is_admin(v.org_id) then
    raise exception 'Only an organization owner/admin can approve pay';
  end if;
  if v.status <> 'draft' then
    raise exception 'Pay item % is %, not draft', p_id, v.status;
  end if;
  if v.amount <= 0 then
    raise exception 'Set an amount before approving (pay item % is %)', p_id, v.amount;
  end if;

  select display_name into v_name from public.team_members where id = v.team_member_id;

  select id into v_labor from public.accounts
    where org_id = v.org_id and code = '5100' limit 1;
  select id into v_payable from public.accounts
    where org_id = v.org_id and code = '2000' limit 1;
  if v_labor is null or v_payable is null then
    raise exception 'Org % is missing the 5100 Team Pay or 2000 Accounts Payable account', v.org_id;
  end if;

  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
  values
    (v.pay_date, 'Team pay — ' || coalesce(v_name, 'member'), 'pay_item', v.id,
     v.project_id, auth.uid(), true, now(), v.org_id)
  returning id into v_je;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
  values
    (v_je, v_labor,   v.amount, 0, coalesce(v_name, 'Team pay'), v.project_id, 1, v.org_id),
    (v_je, v_payable, 0, v.amount, coalesce(v_name, 'Team pay'), v.project_id, 2, v.org_id);

  perform set_config('app.pay_item_rpc', 'on', true);
  update public.pay_items
    set status = 'approved',
        journal_entry_id = v_je,
        approved_by = auth.uid(),
        approved_at = now()
    where id = p_id
    returning * into v;

  return v;
end $$;

create or replace function public.void_pay_item(p_id uuid)
returns public.pay_items language plpgsql security definer set search_path = public as $$
declare
  v      public.pay_items;
  v_name text;
  v_rev  uuid;
begin
  select * into v from public.pay_items where id = p_id for update;
  if not found then
    raise exception 'Pay item % not found', p_id;
  end if;
  if not public.org_is_admin(v.org_id) then
    raise exception 'Only an organization owner/admin can void pay';
  end if;
  if v.status = 'void' then
    return v;
  end if;

  if v.status = 'approved' then
    select display_name into v_name from public.team_members where id = v.team_member_id;

    -- Reversal of the posted entry (never edit it): flip the lines.
    insert into public.journal_entries
      (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
    values
      (current_date, 'Reversal: team pay — ' || coalesce(v_name, 'member'), 'reversal', v.id,
       v.project_id, auth.uid(), true, now(), v.org_id)
    returning id into v_rev;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
    select v_rev, jl.account_id, jl.credit, jl.debit, 'Reversal: ' || coalesce(jl.description, ''), jl.project_id, jl.line_number, jl.org_id
    from public.journal_lines jl
    where jl.journal_entry_id = v.journal_entry_id;

    update public.journal_entries set reversed_by = v_rev where id = v.journal_entry_id;
  end if;

  perform set_config('app.pay_item_rpc', 'on', true);
  update public.pay_items set status = 'void' where id = p_id returning * into v;
  return v;
end $$;

-- ---------- auto-draft on membership ----------

create or replace function public.create_draft_pay_for_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name  text;
  v_date  date;
begin
  if NEW.pay_type = 'none' then
    return NEW;
  end if;

  -- One open (non-void) pay item per membership is enough.
  perform 1 from public.pay_items
    where project_member_id = NEW.id and status <> 'void';
  if found then
    return NEW;
  end if;

  select display_name into v_name from public.team_members where id = NEW.team_member_id;
  select coalesce(p.start_date, current_date) into v_date
    from public.projects p where p.id = NEW.project_id;

  insert into public.pay_items
    (org_id, project_id, project_member_id, team_member_id, description, amount, pay_date, created_by)
  values
    (NEW.org_id, NEW.project_id, NEW.id, NEW.team_member_id,
     coalesce(NEW.role_label, 'Photographer') || ' pay — ' || coalesce(v_name, 'member'),
     coalesce(NEW.agreed_pay, 0), v_date, auth.uid());

  return NEW;
end $$;

drop trigger if exists project_members_draft_pay on public.project_members;
create trigger project_members_draft_pay
  after insert on public.project_members
  for each row execute procedure public.create_draft_pay_for_member();

-- ---------- photographers[] → memberships (replaces the legacy sync) ----------

drop trigger if exists projects_sync_photographers on public.projects;
drop function if exists public.sync_project_photographer_pay();

create or replace function public.sync_photographers_to_members()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ph_name text;
  to_add  text[];
  v_tm    uuid;
begin
  if TG_OP = 'INSERT' then
    to_add := NEW.photographers;
  else
    to_add := array(
      select unnest(coalesce(NEW.photographers, '{}'::text[]))
      except
      select unnest(coalesce(OLD.photographers, '{}'::text[]))
    );
  end if;

  if to_add is null or array_length(to_add, 1) is null then
    return NEW;
  end if;

  foreach ph_name in array to_add loop
    ph_name := trim(ph_name);
    continue when length(ph_name) = 0;

    select id into v_tm from public.team_members
      where org_id = NEW.org_id and lower(display_name) = lower(ph_name);
    if v_tm is null then
      insert into public.team_members (org_id, display_name, created_at)
      values (NEW.org_id, ph_name, now())
      returning id into v_tm;
    end if;

    -- Membership (draft pay item follows via project_members trigger).
    insert into public.project_members (org_id, project_id, team_member_id, role_label, pay_type)
    values (NEW.org_id, NEW.id, v_tm, 'Photographer', 'flat')
    on conflict (project_id, team_member_id) do nothing;
  end loop;

  -- Removals intentionally keep memberships and pay history (legacy semantics).
  return NEW;
end $$;

drop trigger if exists projects_sync_photographer_members on public.projects;
create trigger projects_sync_photographer_members
  after insert or update of photographers on public.projects
  for each row execute procedure public.sync_photographers_to_members();

-- ---------- convert legacy $0 pay rows to drafts ----------

-- $0 "Photographer Pay" expenses were the old placeholder mechanism. Each
-- becomes a draft pay item; the expense row is removed WITHOUT posting a
-- reversal (we detach its journal map first — a $0 reversal would violate the
-- debit-xor-credit check; and any mapped entry is itself all-zero history).
do $$
declare
  e record;
  v_tm uuid;
  v_pm uuid;
begin
  for e in
    select ex.*, c.org_id as cat_org
    from public.expenses ex
    join public.categories c on c.id = ex.category_id
    where c.name ilike 'photographer pay'
      and ex.amount = 0
  loop
    -- Resolve / create the person.
    select id into v_tm from public.team_members
      where org_id = e.org_id
        and lower(display_name) = lower(coalesce(e.person_name, e.description));
    if v_tm is null then
      insert into public.team_members (org_id, display_name)
      values (e.org_id, coalesce(e.person_name, e.description))
      returning id into v_tm;
    end if;

    -- Resolve / create the membership (suppresses its own auto-draft: we
    -- create the pay item explicitly below to carry the expense's details).
    select id into v_pm from public.project_members
      where project_id = e.project_id and team_member_id = v_tm;
    if v_pm is null then
      insert into public.project_members (org_id, project_id, team_member_id, role_label, pay_type)
      values (e.org_id, e.project_id, v_tm, 'Photographer', 'flat')
      returning id into v_pm;
      -- The membership trigger may have created a draft already; keep just one.
      delete from public.pay_items
        where project_member_id = v_pm and status = 'draft';
    end if;

    insert into public.pay_items
      (org_id, project_id, project_member_id, team_member_id, description, amount, pay_date, created_by)
    values
      (e.org_id, e.project_id, v_pm, v_tm,
       coalesce(e.person_name, e.description), 0, e.expense_date, e.created_by);

    -- Detach GL map, then remove the placeholder expense (no reversal fires).
    delete from public.expense_journal_map where expense_id = e.id;
    delete from public.expenses where id = e.id;
  end loop;
end $$;

-- ---------- RLS ----------

alter table public.pay_items enable row level security;

drop policy if exists pay_items_select on public.pay_items;
create policy pay_items_select on public.pay_items
  for select using (public.org_can_view_financials(org_id));

drop policy if exists pay_items_modify_editor on public.pay_items;
create policy pay_items_modify_editor on public.pay_items
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

-- ---------- audit ----------

drop trigger if exists audit_pay_items on public.pay_items;
create trigger audit_pay_items
  after insert or update or delete on public.pay_items
  for each row execute procedure public.log_audit('pay_item');

-- ---------- realtime ----------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.pay_items;
    exception when duplicate_object then null; end;
  end if;
end $$;
