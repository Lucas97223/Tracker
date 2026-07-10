-- Phase 6a: the automation engine.
--
-- Small, honest v1: five business events fan out to user-defined rules with
-- three action kinds. Every execution is logged in automation_runs. Two
-- safety rails from the spec:
--   * loop detection — automations never trigger automations (a depth flag
--     set for the transaction while actions run);
--   * rate cap — max 20 runs per contact per day, so a runaway form or
--     integration can't spam a client's world.
-- A failing automation NEVER breaks the business operation that fired it:
-- the fan-out triggers swallow errors into the run log.

alter type audit_entity add value if not exists 'automation';

-- notifications gains an 'automation' kind.
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('assigned', 'mention', 'comment', 'automation'));

create table if not exists public.automations (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  name           text not null check (length(trim(name)) > 0),
  trigger_event  text not null check (trigger_event in
                   ('deal_stage_changed', 'form_response', 'booking_created',
                    'invoice_paid', 'project_created')),
  condition      jsonb not null default '{}'::jsonb,   -- e.g. {"stage_id": "..."}
  action         text not null check (action in ('create_task', 'notify', 'apply_template')),
  action_config  jsonb not null default '{}'::jsonb,
  is_active      boolean not null default true,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists automations_org_idx on public.automations(org_id, trigger_event)
  where is_active;

drop trigger if exists automations_updated_at on public.automations;
create trigger automations_updated_at
  before update on public.automations
  for each row execute procedure public.set_updated_at();

drop trigger if exists automations_set_org on public.automations;
create trigger automations_set_org
  before insert on public.automations
  for each row execute procedure public.set_org_id();

create table if not exists public.automation_runs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  automation_id  uuid not null references public.automations(id) on delete cascade,
  trigger_event  text not null,
  context        jsonb not null default '{}'::jsonb,
  status         text not null check (status in ('ok', 'error', 'skipped')),
  detail         text,
  created_at     timestamptz not null default now()
);
create index if not exists automation_runs_automation_idx
  on public.automation_runs(automation_id, created_at desc);
create index if not exists automation_runs_contact_idx
  on public.automation_runs(org_id, ((context ->> 'contact_id')), created_at);

-- ---------- the runner ----------

create or replace function public.run_automations(
  p_org uuid,
  p_trigger text,
  p_context jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  a          public.automations;
  v_contact  text := p_context ->> 'contact_id';
  v_project  uuid := nullif(p_context ->> 'project_id', '')::uuid;
  v_status   text;
  v_detail   text;
  v_title    text;
  v_assignee uuid;
  v_recip    record;
begin
  -- Loop detection: work done BY an automation never fires more automations.
  if coalesce(current_setting('app.automation_depth', true), '') = '1' then
    return;
  end if;

  for a in
    select * from public.automations
    where org_id = p_org and trigger_event = p_trigger and is_active
  loop
    v_status := 'ok';
    v_detail := null;

    -- Rate cap per contact per day.
    if v_contact is not null and (
      select count(*) from public.automation_runs r
      where r.org_id = p_org
        and r.context ->> 'contact_id' = v_contact
        and r.created_at > now() - interval '24 hours'
        and r.status = 'ok'
    ) >= 20 then
      insert into public.automation_runs (org_id, automation_id, trigger_event, context, status, detail)
      values (p_org, a.id, p_trigger, p_context, 'skipped', 'per-contact daily rate cap');
      continue;
    end if;

    -- Condition (v1: stage match for deal moves; empty condition = always).
    if p_trigger = 'deal_stage_changed'
       and a.condition ? 'stage_id'
       and (a.condition ->> 'stage_id') is distinct from (p_context ->> 'stage_id') then
      continue;
    end if;

    begin
      perform set_config('app.automation_depth', '1', true);

      if a.action = 'create_task' then
        if v_project is null then
          v_status := 'skipped';
          v_detail := 'no project in context for create_task';
        else
          v_title := coalesce(a.action_config ->> 'title', a.name);
          v_assignee := nullif(a.action_config ->> 'assignee_team_member_id', '')::uuid;
          insert into public.tasks (org_id, project_id, title, description, assignee_id, due_date, sort_order)
          values (p_org, v_project, v_title,
                  a.action_config ->> 'description',
                  v_assignee,
                  case when a.action_config ? 'due_days'
                       then current_date + ((a.action_config ->> 'due_days')::int)
                  end,
                  (select coalesce(max(sort_order), 0) + 1024 from public.tasks
                    where project_id = v_project));
        end if;

      elsif a.action = 'notify' then
        for v_recip in
          select om.user_id from public.org_members om
          where om.org_id = p_org and om.role in ('owner', 'admin')
        loop
          insert into public.notifications (org_id, recipient_id, kind, project_id, body)
          values (p_org, v_recip.user_id, 'automation', v_project,
                  coalesce(a.action_config ->> 'message', a.name)
                  || coalesce(' — ' || (p_context ->> 'summary'), ''));
        end loop;

      elsif a.action = 'apply_template' then
        if v_project is null or nullif(a.action_config ->> 'template_id', '') is null then
          v_status := 'skipped';
          v_detail := 'apply_template needs a project and a template_id';
        else
          perform public.apply_task_template_internal(
            (a.action_config ->> 'template_id')::uuid, v_project);
        end if;
      end if;

      perform set_config('app.automation_depth', '', true);
    exception when others then
      perform set_config('app.automation_depth', '', true);
      v_status := 'error';
      v_detail := sqlerrm;
    end;

    insert into public.automation_runs (org_id, automation_id, trigger_event, context, status, detail)
    values (p_org, a.id, p_trigger, p_context, v_status, v_detail);
  end loop;
end $$;

revoke execute on function public.run_automations(uuid, text, jsonb) from public, anon, authenticated;

-- ---------- fan-out triggers (never break the business op) ----------

-- IMPORTANT: branch on tg_table_name in its own IF before touching any NEW
-- field — SQL boolean evaluation order isn't guaranteed, and NEW.stage_id on
-- an invoices row raises (which the safety catch would then silently eat).
create or replace function public.automation_fanout()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ctx jsonb;
begin
  begin
    if tg_table_name = 'deals' then
      if tg_op = 'UPDATE'
         and (NEW.stage_id is distinct from OLD.stage_id
              or NEW.status is distinct from OLD.status) then
        v_ctx := jsonb_build_object(
          'deal_id', NEW.id, 'contact_id', NEW.contact_id, 'project_id', NEW.project_id,
          'stage_id', NEW.stage_id, 'status', NEW.status, 'summary', NEW.title);
        perform public.run_automations(NEW.org_id, 'deal_stage_changed', v_ctx);
      end if;

    elsif tg_table_name = 'form_responses' then
      v_ctx := jsonb_build_object(
        'contact_id', NEW.contact_id, 'form_id', NEW.form_id,
        'summary', (select name from public.forms where id = NEW.form_id));
      perform public.run_automations(NEW.org_id, 'form_response', v_ctx);

    elsif tg_table_name = 'bookings' then
      v_ctx := jsonb_build_object(
        'contact_id', NEW.contact_id, 'booking_id', NEW.id,
        'summary', NEW.name || ' — ' || to_char(NEW.starts_at, 'YYYY-MM-DD HH24:MI'));
      perform public.run_automations(NEW.org_id, 'booking_created', v_ctx);

    elsif tg_table_name = 'invoices' then
      if NEW.status = 'paid' and OLD.status <> 'paid' then
        v_ctx := jsonb_build_object(
          'invoice_id', NEW.id, 'contact_id', NEW.contact_id, 'project_id', NEW.project_id,
          'summary', 'Invoice #' || NEW.number);
        perform public.run_automations(NEW.org_id, 'invoice_paid', v_ctx);
      end if;

    elsif tg_table_name = 'projects' then
      if tg_op = 'INSERT' then
        v_ctx := jsonb_build_object(
          'project_id', NEW.id, 'contact_id', NEW.contact_id, 'summary', NEW.name);
        perform public.run_automations(NEW.org_id, 'project_created', v_ctx);
      end if;
    end if;
  exception when others then
    null;  -- automations must never sink the ship
  end;
  return NEW;
end $$;

drop trigger if exists deals_automation_fanout on public.deals;
create trigger deals_automation_fanout
  after update of stage_id, status on public.deals
  for each row execute procedure public.automation_fanout();

drop trigger if exists form_responses_automation_fanout on public.form_responses;
create trigger form_responses_automation_fanout
  after insert on public.form_responses
  for each row execute procedure public.automation_fanout();

drop trigger if exists bookings_automation_fanout on public.bookings;
create trigger bookings_automation_fanout
  after insert on public.bookings
  for each row execute procedure public.automation_fanout();

drop trigger if exists invoices_automation_fanout on public.invoices;
create trigger invoices_automation_fanout
  after update of status on public.invoices
  for each row execute procedure public.automation_fanout();

drop trigger if exists projects_automation_fanout on public.projects;
create trigger projects_automation_fanout
  after insert on public.projects
  for each row execute procedure public.automation_fanout();

-- ---------- RLS + audit ----------

alter table public.automations     enable row level security;
alter table public.automation_runs enable row level security;

drop policy if exists automations_select on public.automations;
create policy automations_select on public.automations
  for select using (public.org_can_view_financials(org_id));
drop policy if exists automations_modify on public.automations;
create policy automations_modify on public.automations
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

drop policy if exists automation_runs_select on public.automation_runs;
create policy automation_runs_select on public.automation_runs
  for select using (public.org_is_admin(org_id));

drop trigger if exists audit_automations on public.automations;
create trigger audit_automations
  after insert or update or delete on public.automations
  for each row execute procedure public.log_audit('automation');
