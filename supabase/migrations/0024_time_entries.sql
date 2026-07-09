-- Phase 3, step 1: time tracking.
--
--   time_entries       who (team_member) worked what (project/task) and when.
--                      minutes NULL = a running timer; the row lives server-
--                      side, so the timer survives reloads and machine swaps.
--                      billable entries snapshot bill_rate at creation.
--   time_entry_costs   cost_rate snapshot AT ENTRY TIME, in a side table with
--                      owner/admin-only RLS: workers can read their own time
--                      rows, but cost rates stay invisible to member/
--                      contractor roles (Phase 0.5 acceptance).
--   invoiced_lock      set when a draft invoice pulls the entry (I5); locked
--                      rows are immutable outside the billing RPCs. Billable
--                      expenses gain the same lock columns.
--
-- Costed time NEVER posts to the GL (I4) — there is deliberately no journal
-- trigger anywhere in this file; the memo layer is views-only (0025).

alter type audit_entity add value if not exists 'time_entry';

-- ---------- time_entries ----------

create table if not exists public.time_entries (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  project_id       uuid not null references public.projects(id) on delete cascade,
  task_id          uuid references public.tasks(id) on delete set null,
  team_member_id   uuid not null references public.team_members(id) on delete restrict,
  started_at       timestamptz not null default now(),
  minutes          int check (minutes is null or minutes > 0),  -- NULL = timer running
  notes            text,
  billable         boolean not null default false,
  bill_rate        numeric(10,2) check (bill_rate is null or bill_rate >= 0),
  invoiced_lock    boolean not null default false,
  -- no ON DELETE action: the 0025 unlock trigger clears lock + link BEFORE a
  -- line delete (a SET NULL would erase the link before the trigger could
  -- find the rows to unlock)
  invoice_line_id  uuid references public.invoice_lines(id),
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists time_entries_project_idx on public.time_entries(project_id);
create index if not exists time_entries_member_idx on public.time_entries(team_member_id, started_at desc);
create index if not exists time_entries_org_idx on public.time_entries(org_id);
create index if not exists time_entries_unbilled_idx
  on public.time_entries(project_id) where billable and not invoiced_lock and minutes is not null;
-- one running timer per person
create unique index if not exists time_entries_one_open_key
  on public.time_entries(team_member_id) where minutes is null;

drop trigger if exists time_entries_updated_at on public.time_entries;
create trigger time_entries_updated_at
  before update on public.time_entries
  for each row execute procedure public.set_updated_at();

drop trigger if exists time_entries_set_org on public.time_entries;
create trigger time_entries_set_org
  before insert on public.time_entries
  for each row execute procedure public.set_org_id_from_project();

-- ---------- cost snapshots (admin-only) ----------

create table if not exists public.time_entry_costs (
  time_entry_id  uuid primary key references public.time_entries(id) on delete cascade,
  org_id         uuid not null references public.organizations(id) on delete cascade,
  cost_rate      numeric(10,2) not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists time_entry_costs_org_idx on public.time_entry_costs(org_id);

-- ---------- bookkeeping triggers ----------

-- Split in two: BEFORE handles validation, the I5 lock, and the bill_rate
-- snapshot; AFTER inserts the admin-only cost snapshot (its FK needs the row
-- to exist).
create or replace function public.time_entries_cost_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.time_entry_costs (time_entry_id, org_id, cost_rate)
  values (NEW.id, NEW.org_id,
          coalesce((select mr.cost_rate from public.member_rates mr
                     where mr.team_member_id = NEW.team_member_id), 0))
  on conflict (time_entry_id) do nothing;
  return NEW;
end $$;

create or replace function public.time_entries_bookkeeping()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  via_rpc boolean := coalesce(current_setting('app.billing_rpc', true), '') = 'on';
begin
  if TG_OP in ('UPDATE', 'DELETE') and OLD.invoiced_lock and not via_rpc then
    raise exception 'Time entry % is on an invoice; void that invoice line first (I5)', OLD.id
      using errcode = 'check_violation';
  end if;
  if TG_OP = 'DELETE' then
    return OLD;
  end if;

  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.team_members where id = NEW.team_member_id), 'time → member');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.tasks where id = NEW.task_id), 'time → task');
  if NEW.task_id is not null
     and (select project_id from public.tasks where id = NEW.task_id) <> NEW.project_id then
    raise exception 'Task belongs to a different project' using errcode = 'check_violation';
  end if;

  if not via_rpc then
    if TG_OP = 'INSERT' and (NEW.invoiced_lock or NEW.invoice_line_id is not null) then
      raise exception 'invoiced_lock is managed by the billing flow' using errcode = 'check_violation';
    end if;
    if TG_OP = 'UPDATE'
       and (NEW.invoiced_lock is distinct from OLD.invoiced_lock
            or NEW.invoice_line_id is distinct from OLD.invoice_line_id) then
      raise exception 'invoiced_lock is managed by the billing flow' using errcode = 'check_violation';
    end if;
  end if;

  if TG_OP = 'INSERT' and NEW.billable and NEW.bill_rate is null then
    select mr.bill_rate::numeric(10,2) into NEW.bill_rate
      from public.member_rates mr where mr.team_member_id = NEW.team_member_id;
  end if;
  return NEW;
end $$;

drop trigger if exists time_entries_zz_bookkeeping on public.time_entries;
create trigger time_entries_zz_bookkeeping
  before insert or update or delete on public.time_entries
  for each row execute procedure public.time_entries_bookkeeping();

drop trigger if exists time_entries_zzz_cost on public.time_entries;
create trigger time_entries_zzz_cost
  after insert on public.time_entries
  for each row execute procedure public.time_entries_cost_snapshot();

-- ---------- timer RPCs ----------

-- The caller's team-member identity in the project's org.
create or replace function public.my_team_member(p_project uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select tm.id
  from public.team_members tm
  join public.projects p on p.org_id = tm.org_id
  where p.id = p_project and tm.profile_id = auth.uid()
  limit 1;
$$;

create or replace function public.start_timer(
  p_project uuid,
  p_task uuid default null,
  p_notes text default null,
  p_billable boolean default false
) returns public.time_entries language plpgsql security definer set search_path = public as $$
declare
  v_member uuid;
  v_org    uuid;
  v_result public.time_entries;
begin
  select org_id into v_org from public.projects where id = p_project;
  if v_org is null then
    raise exception 'Project not found';
  end if;
  if not public.can_edit_work(v_org, p_project) then
    raise exception 'Not allowed to track time on this project';
  end if;
  v_member := public.my_team_member(p_project);
  if v_member is null then
    raise exception 'No team-member identity for your login in this organization — add yourself to the team first';
  end if;

  -- Auto-stop any running timer before starting the next (one-timer rule).
  perform public.stop_timer();

  insert into public.time_entries
    (org_id, project_id, task_id, team_member_id, started_at, notes, billable, created_by)
  values
    (v_org, p_project, p_task, v_member, now(), p_notes, p_billable, auth.uid())
  returning * into v_result;
  return v_result;
end $$;

-- Stops the caller's running timer (if any); returns the closed entry.
create or replace function public.stop_timer()
returns public.time_entries language plpgsql security definer set search_path = public as $$
declare
  v_entry public.time_entries;
begin
  select te.* into v_entry
  from public.time_entries te
  join public.team_members tm on tm.id = te.team_member_id
  where tm.profile_id = auth.uid() and te.minutes is null
  order by te.started_at desc
  limit 1
  for update of te;

  if not found then
    return null;
  end if;

  update public.time_entries
    set minutes = greatest(1, ceil(extract(epoch from (now() - v_entry.started_at)) / 60)::int)
    where id = v_entry.id
    returning * into v_entry;
  return v_entry;
end $$;

-- ---------- billable expense lock columns ----------

alter table public.expenses
  add column if not exists billable boolean not null default false,
  add column if not exists invoiced_lock boolean not null default false,
  add column if not exists invoice_line_id uuid references public.invoice_lines(id);

create or replace function public.expenses_billing_lock()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.billing_rpc', true), '') = 'on';
begin
  if via_rpc then
    return coalesce(NEW, OLD);
  end if;
  if TG_OP in ('UPDATE', 'DELETE') and OLD.invoiced_lock then
    raise exception 'Expense % is rebilled on an invoice; void that invoice line first (I5)', OLD.id
      using errcode = 'check_violation';
  end if;
  if TG_OP = 'INSERT' and (NEW.invoiced_lock or NEW.invoice_line_id is not null) then
    raise exception 'invoiced_lock is managed by the billing flow' using errcode = 'check_violation';
  end if;
  if TG_OP = 'UPDATE'
     and (NEW.invoiced_lock is distinct from OLD.invoiced_lock
          or NEW.invoice_line_id is distinct from OLD.invoice_line_id) then
    raise exception 'invoiced_lock is managed by the billing flow' using errcode = 'check_violation';
  end if;
  return coalesce(NEW, OLD);
end $$;

-- 'aa' prefix: must fire before the GL mirror triggers (alphabetical order).
drop trigger if exists expenses_aa_billing_lock on public.expenses;
create trigger expenses_aa_billing_lock
  before insert or update or delete on public.expenses
  for each row execute procedure public.expenses_billing_lock();

-- ---------- RLS ----------

alter table public.time_entries     enable row level security;
alter table public.time_entry_costs enable row level security;

-- Read: financial viewers see all; workers (incl. contractors) see their own.
drop policy if exists time_entries_select on public.time_entries;
create policy time_entries_select on public.time_entries
  for select using (
    public.org_can_view_financials(org_id)
    or exists (select 1 from public.team_members tm
               where tm.id = team_member_id and tm.profile_id = auth.uid()
                 and public.is_active_user())
  );

-- Write: editors anywhere in the org; workers their OWN rows on projects they
-- can work (covers staffed contractors). The lock trigger guards billed rows.
drop policy if exists time_entries_modify on public.time_entries;
create policy time_entries_modify on public.time_entries
  for all using (
    public.org_can_edit(org_id)
    or (exists (select 1 from public.team_members tm
                where tm.id = team_member_id and tm.profile_id = auth.uid())
        and public.can_edit_work(org_id, project_id))
  )
  with check (
    public.org_can_edit(org_id)
    or (exists (select 1 from public.team_members tm
                where tm.id = team_member_id and tm.profile_id = auth.uid())
        and public.can_edit_work(org_id, project_id))
  );

-- Cost snapshots: owner/admin eyes only (same posture as member_rates).
drop policy if exists time_entry_costs_admin on public.time_entry_costs;
create policy time_entry_costs_admin on public.time_entry_costs
  for select using (public.org_is_admin(org_id));

-- ---------- audit + realtime ----------

drop trigger if exists audit_time_entries on public.time_entries;
create trigger audit_time_entries
  after insert or update or delete on public.time_entries
  for each row execute procedure public.log_audit('time_entry');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.time_entries;
    exception when duplicate_object then null; end;
  end if;
end $$;
