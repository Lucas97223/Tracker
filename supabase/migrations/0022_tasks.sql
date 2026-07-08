-- Phase 2, step 1: Asana-core work management on existing projects.
--
--   task_sections       list-view grouping (board columns are STATUS)
--   tasks               single assignee (decision D12) → team_members, so
--                       people without logins can hold work; subtasks via
--                       parent_task_id; sort_order drives drag ordering
--   task_collaborators  additional watchers (D12: no multi-homing)
--   task_comments       via add_task_comment() RPC so @mentions and their
--                       notifications land in one transaction
--   task_attachments    URL-based (no storage buckets exist yet)
--   notifications       in-app inbox (assignments, mentions)
--
-- Contractor access (extends I6): contractors see and work tasks ONLY on
-- projects they are staffed on, resolved through team_members.profile_id —
-- and never any financial row. Because the projects table carries financial
-- columns (client_paid), contractors do NOT get projects rows at all; they
-- read v_contractor_projects, a definer view exposing only work-safe columns.

-- ---------- enums ----------

do $$ begin
  create type task_status as enum ('todo', 'in_progress', 'done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type task_priority as enum ('low', 'medium', 'high', 'urgent');
exception when duplicate_object then null; end $$;

alter type audit_entity add value if not exists 'task';
alter type audit_entity add value if not exists 'task_section';
alter type audit_entity add value if not exists 'task_comment';
alter type audit_entity add value if not exists 'task_template';

-- ---------- staffing helpers ----------

create or replace function public.is_staffed_on(p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user() and exists (
    select 1
    from public.project_members pm
    join public.team_members tm on tm.id = pm.team_member_id
    where pm.project_id = p_project
      and tm.profile_id = auth.uid()
  );
$$;

-- Read/write work items: full org members always; contractors when staffed.
create or replace function public.can_access_work(p_org uuid, p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.org_can_view_financials(p_org)
      or (public.org_role_of(p_org) = 'contractor' and public.is_staffed_on(p_project));
$$;

create or replace function public.can_edit_work(p_org uuid, p_project uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.org_can_edit(p_org)
      or (public.org_role_of(p_org) = 'contractor' and public.is_staffed_on(p_project));
$$;

-- ---------- task_sections ----------

create table if not exists public.task_sections (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists task_sections_project_idx on public.task_sections(project_id);

drop trigger if exists task_sections_updated_at on public.task_sections;
create trigger task_sections_updated_at
  before update on public.task_sections
  for each row execute procedure public.set_updated_at();

drop trigger if exists task_sections_set_org on public.task_sections;
create trigger task_sections_set_org
  before insert on public.task_sections
  for each row execute procedure public.set_org_id_from_project();

-- ---------- tasks ----------

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  section_id      uuid references public.task_sections(id) on delete set null,
  parent_task_id  uuid references public.tasks(id) on delete cascade,
  title           text not null check (length(trim(title)) > 0),
  description     text,
  status          task_status not null default 'todo',
  priority        task_priority not null default 'medium',
  assignee_id     uuid references public.team_members(id) on delete set null,
  start_date      date,
  due_date        date,
  sort_order      int not null default 0,
  completed_at    timestamptz,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists tasks_project_idx on public.tasks(project_id);
create index if not exists tasks_parent_idx on public.tasks(parent_task_id);
create index if not exists tasks_assignee_idx on public.tasks(assignee_id);
create index if not exists tasks_status_idx on public.tasks(project_id, status);
create index if not exists tasks_org_idx on public.tasks(org_id);

drop trigger if exists tasks_updated_at on public.tasks;
create trigger tasks_updated_at
  before update on public.tasks
  for each row execute procedure public.set_updated_at();

drop trigger if exists tasks_set_org on public.tasks;
create trigger tasks_set_org
  before insert on public.tasks
  for each row execute procedure public.set_org_id_from_project();

-- completed_at tracks the status flip; subtask/section/assignee org must match.
create or replace function public.tasks_bookkeeping()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.status = 'done' and (TG_OP = 'INSERT' or OLD.status <> 'done') then
    NEW.completed_at := now();
  elsif NEW.status <> 'done' then
    NEW.completed_at := null;
  end if;

  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.task_sections where id = NEW.section_id), 'task → section');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.tasks where id = NEW.parent_task_id), 'task → parent');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.team_members where id = NEW.assignee_id), 'task → assignee');
  if NEW.parent_task_id is not null then
    if NEW.parent_task_id = NEW.id then
      raise exception 'A task cannot be its own parent' using errcode = 'check_violation';
    end if;
    if (select project_id from public.tasks where id = NEW.parent_task_id) <> NEW.project_id then
      raise exception 'Subtasks live on their parent''s project' using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists tasks_zz_bookkeeping on public.tasks;
create trigger tasks_zz_bookkeeping
  before insert or update on public.tasks
  for each row execute procedure public.tasks_bookkeeping();

-- ---------- task_collaborators ----------

create table if not exists public.task_collaborators (
  task_id         uuid not null references public.tasks(id) on delete cascade,
  team_member_id  uuid not null references public.team_members(id) on delete cascade,
  org_id          uuid not null references public.organizations(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (task_id, team_member_id)
);

create or replace function public.set_org_id_from_task()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select t.org_id into NEW.org_id from public.tasks t where t.id = NEW.task_id;
  end if;
  return NEW;
end $$;

drop trigger if exists task_collaborators_set_org on public.task_collaborators;
create trigger task_collaborators_set_org
  before insert on public.task_collaborators
  for each row execute procedure public.set_org_id_from_task();

-- ---------- task_comments ----------

create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  task_id     uuid not null references public.tasks(id) on delete cascade,
  author_id   uuid references public.profiles(id) on delete set null,
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments(task_id);

drop trigger if exists task_comments_set_org on public.task_comments;
create trigger task_comments_set_org
  before insert on public.task_comments
  for each row execute procedure public.set_org_id_from_task();

-- ---------- task_attachments ----------

create table if not exists public.task_attachments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  task_id     uuid not null references public.tasks(id) on delete cascade,
  name        text not null,
  url         text not null,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists task_attachments_task_idx on public.task_attachments(task_id);

drop trigger if exists task_attachments_set_org on public.task_attachments;
create trigger task_attachments_set_org
  before insert on public.task_attachments
  for each row execute procedure public.set_org_id_from_task();

-- ---------- notifications ----------

create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  actor_id      uuid references public.profiles(id) on delete set null,
  kind          text not null check (kind in ('assigned', 'mention', 'comment')),
  task_id       uuid references public.tasks(id) on delete cascade,
  project_id    uuid references public.projects(id) on delete cascade,
  body          text not null,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists notifications_inbox_idx
  on public.notifications(recipient_id, read_at, created_at desc);

-- Assignment → notify the assignee (when they have a login and aren't the actor).
create or replace function public.notify_task_assignment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_profile uuid;
  v_title text;
begin
  if NEW.assignee_id is null
     or (TG_OP = 'UPDATE' and NEW.assignee_id is not distinct from OLD.assignee_id) then
    return NEW;
  end if;
  select profile_id into v_profile from public.team_members where id = NEW.assignee_id;
  if v_profile is null or v_profile = auth.uid() then
    return NEW;
  end if;
  select title into v_title from public.tasks where id = NEW.id;
  insert into public.notifications (org_id, recipient_id, actor_id, kind, task_id, project_id, body)
  values (NEW.org_id, v_profile, auth.uid(), 'assigned', NEW.id, NEW.project_id,
          'You were assigned: ' || coalesce(NEW.title, v_title, 'a task'));
  return NEW;
end $$;

drop trigger if exists tasks_notify_assignment on public.tasks;
create trigger tasks_notify_assignment
  after insert or update of assignee_id on public.tasks
  for each row execute procedure public.notify_task_assignment();

-- Comment + mentions in one transaction. Mentions arrive as team_member ids
-- (the UI resolves @names); each mentioned member with a login gets a
-- notification, as does the task's assignee.
create or replace function public.add_task_comment(
  p_task uuid,
  p_body text,
  p_mentions uuid[] default '{}'
) returns public.task_comments language plpgsql security definer set search_path = public as $$
declare
  t          public.tasks;
  v_comment  public.task_comments;
  v_profile  uuid;
  v_m        uuid;
begin
  select * into t from public.tasks where id = p_task;
  if not found then
    raise exception 'Task % not found', p_task;
  end if;
  if not public.can_edit_work(t.org_id, t.project_id) then
    raise exception 'Not allowed to comment on this task';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then
    raise exception 'Empty comment';
  end if;

  insert into public.task_comments (org_id, task_id, author_id, body)
  values (t.org_id, p_task, auth.uid(), p_body)
  returning * into v_comment;

  -- mentions
  foreach v_m in array coalesce(p_mentions, '{}') loop
    select profile_id into v_profile from public.team_members
      where id = v_m and org_id = t.org_id;
    if v_profile is not null and v_profile <> auth.uid() then
      insert into public.notifications (org_id, recipient_id, actor_id, kind, task_id, project_id, body)
      values (t.org_id, v_profile, auth.uid(), 'mention', p_task, t.project_id,
              'Mentioned you on: ' || t.title);
    end if;
  end loop;

  -- assignee hears about new comments (unless they wrote it / were mentioned)
  select tm.profile_id into v_profile
    from public.team_members tm where tm.id = t.assignee_id;
  if v_profile is not null and v_profile <> auth.uid()
     and not exists (
       select 1 from public.team_members tm2
       where tm2.id = any(coalesce(p_mentions, '{}')) and tm2.profile_id = v_profile
     ) then
    insert into public.notifications (org_id, recipient_id, actor_id, kind, task_id, project_id, body)
    values (t.org_id, v_profile, auth.uid(), 'comment', p_task, t.project_id,
            'New comment on: ' || t.title);
  end if;

  return v_comment;
end $$;

-- ---------- contractor-safe project view ----------

-- SECURITY DEFINER on purpose: contractors have no RLS access to the projects
-- table (it carries client_paid and other financials). This view exposes only
-- work-safe columns, and only for staffed projects. Non-contractors also get
-- rows here so shared UI can read one source.
create or replace view public.v_contractor_projects as
select p.id, p.org_id, p.name, p.status, p.project_type,
       p.location, p.start_date, p.end_date
from public.projects p
where public.can_access_work(p.org_id, p.id);

grant select on public.v_contractor_projects to authenticated;

-- ---------- RLS ----------

alter table public.task_sections      enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_collaborators enable row level security;
alter table public.task_comments      enable row level security;
alter table public.task_attachments   enable row level security;
alter table public.notifications      enable row level security;

drop policy if exists task_sections_select on public.task_sections;
create policy task_sections_select on public.task_sections
  for select using (public.can_access_work(org_id, project_id));
drop policy if exists task_sections_modify on public.task_sections;
create policy task_sections_modify on public.task_sections
  for all using (public.can_edit_work(org_id, project_id))
  with check (public.can_edit_work(org_id, project_id));

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select using (public.can_access_work(org_id, project_id));
drop policy if exists tasks_modify on public.tasks;
create policy tasks_modify on public.tasks
  for all using (public.can_edit_work(org_id, project_id))
  with check (public.can_edit_work(org_id, project_id));

drop policy if exists task_collaborators_select on public.task_collaborators;
create policy task_collaborators_select on public.task_collaborators
  for select using (exists (
    select 1 from public.tasks t
    where t.id = task_id and public.can_access_work(t.org_id, t.project_id)));
drop policy if exists task_collaborators_modify on public.task_collaborators;
create policy task_collaborators_modify on public.task_collaborators
  for all using (exists (
    select 1 from public.tasks t
    where t.id = task_id and public.can_edit_work(t.org_id, t.project_id)))
  with check (exists (
    select 1 from public.tasks t
    where t.id = task_id and public.can_edit_work(t.org_id, t.project_id)));

drop policy if exists task_comments_select on public.task_comments;
create policy task_comments_select on public.task_comments
  for select using (exists (
    select 1 from public.tasks t
    where t.id = task_id and public.can_access_work(t.org_id, t.project_id)));
-- inserts go through add_task_comment(); authors may delete their own
drop policy if exists task_comments_delete_own on public.task_comments;
create policy task_comments_delete_own on public.task_comments
  for delete using (author_id = auth.uid() and public.is_active_user());

drop policy if exists task_attachments_select on public.task_attachments;
create policy task_attachments_select on public.task_attachments
  for select using (exists (
    select 1 from public.tasks t
    where t.id = task_id and public.can_access_work(t.org_id, t.project_id)));
drop policy if exists task_attachments_modify on public.task_attachments;
create policy task_attachments_modify on public.task_attachments
  for all using (exists (
    select 1 from public.tasks t
    where t.id = task_id and public.can_edit_work(t.org_id, t.project_id)))
  with check (exists (
    select 1 from public.tasks t
    where t.id = task_id and public.can_edit_work(t.org_id, t.project_id)));

-- notifications: strictly the recipient's own; only read_at is writable.
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (recipient_id = auth.uid());
drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());
drop policy if exists notifications_delete_own on public.notifications;
create policy notifications_delete_own on public.notifications
  for delete using (recipient_id = auth.uid());

-- ---------- audit ----------

drop trigger if exists audit_tasks on public.tasks;
create trigger audit_tasks
  after insert or update or delete on public.tasks
  for each row execute procedure public.log_audit('task');

drop trigger if exists audit_task_sections on public.task_sections;
create trigger audit_task_sections
  after insert or update or delete on public.task_sections
  for each row execute procedure public.log_audit('task_section');

drop trigger if exists audit_task_comments on public.task_comments;
create trigger audit_task_comments
  after insert or delete on public.task_comments
  for each row execute procedure public.log_audit('task_comment');

-- ---------- realtime ----------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.tasks;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.task_sections;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.task_comments;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.notifications;
    exception when duplicate_object then null; end;
  end if;
end $$;
