-- Phase 0.5, step 3: the staffing model (approved Recon amendment D-B).
--
-- photographers[] holds free-text names; profiles requires an auth.users row,
-- so people without logins can never be profiles. This migration introduces:
--
--   team_members     org-scoped registry of real-world people (name, optional
--                    email, optional link to a profile once they get a login)
--   project_members  REBUILT from the unused v1 access-control shape
--                    (project_id, user_id, permission) into the staffing shape
--                    (project_id, team_member_id, role_label, pay_type,
--                    agreed_pay, permission). Any v1 rows are preserved by
--                    mapping their profiles through team_members.
--
-- photographers[] is backfilled into team_members + project_members. The
-- array column stays (it remains the UI's write path; a sync trigger in 0014
-- materializes it into memberships). UI labels stay "Photographers" (D2).
--
-- Behavior swaps (replacing the $0-expense auto-pay trigger with draft
-- pay_items) land in 0014 — this migration is purely structural.

-- ---------- enums ----------

do $$ begin
  create type pay_type as enum ('flat', 'hourly', 'none');
exception when duplicate_object then null; end $$;

-- ---------- team_members ----------

create table if not exists public.team_members (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  display_name text not null,
  email        text,
  profile_id   uuid references public.profiles(id) on delete set null,
  is_active    boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (length(trim(display_name)) > 0)
);
create unique index if not exists team_members_org_name_key
  on public.team_members(org_id, lower(display_name));
create index if not exists team_members_profile_idx on public.team_members(profile_id);

drop trigger if exists team_members_updated_at on public.team_members;
create trigger team_members_updated_at
  before update on public.team_members
  for each row execute procedure public.set_updated_at();

drop trigger if exists team_members_set_org on public.team_members;
create trigger team_members_set_org
  before insert on public.team_members
  for each row execute procedure public.set_org_id();

-- ---------- rebuild project_members ----------

do $$
begin
  -- Preserve any v1 ACL rows (expected empty — the table was never wired).
  create temporary table _old_project_members on commit drop as
    select pm.project_id, pm.user_id, pm.permission, p.org_id
    from public.project_members pm
    join public.projects p on p.id = pm.project_id;
exception when undefined_column then
  -- Already rebuilt (idempotent re-run): nothing to preserve.
  create temporary table _old_project_members (
    project_id uuid, user_id uuid, permission project_permission, org_id uuid
  ) on commit drop;
end $$;

drop table if exists public.project_members;

create table public.project_members (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  team_member_id  uuid not null references public.team_members(id) on delete restrict,
  role_label      text not null default 'Photographer',
  pay_type        pay_type not null default 'flat',
  agreed_pay      numeric(14,2) check (agreed_pay is null or agreed_pay >= 0),
  permission      project_permission,          -- reserved for Phase 2 access scoping
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id, team_member_id)
);
create index if not exists project_members_project_idx on public.project_members(project_id);
create index if not exists project_members_team_idx on public.project_members(team_member_id);
create index if not exists project_members_org_idx on public.project_members(org_id);

drop trigger if exists project_members_updated_at on public.project_members;
create trigger project_members_updated_at
  before update on public.project_members
  for each row execute procedure public.set_updated_at();

-- org always comes from the project, never the caller.
create or replace function public.set_org_id_from_project()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select p.org_id into NEW.org_id from public.projects p where p.id = NEW.project_id;
  end if;
  return NEW;
end $$;

drop trigger if exists project_members_set_org on public.project_members;
create trigger project_members_set_org
  before insert on public.project_members
  for each row execute procedure public.set_org_id_from_project();

-- ---------- backfill ----------

do $$
declare
  r record;
  v_tm uuid;
begin
  -- 1. v1 ACL rows: each referenced profile becomes a team member; the
  --    membership keeps its permission and carries no pay semantics.
  for r in select * from _old_project_members loop
    v_tm := null;
    insert into public.team_members (org_id, display_name, email, profile_id)
    select r.org_id,
           coalesce(nullif(trim(p.full_name), ''), p.email),
           p.email,
           p.id
    from public.profiles p where p.id = r.user_id
    on conflict (org_id, lower(display_name)) do update set profile_id = excluded.profile_id
    returning id into v_tm;

    if v_tm is not null then
      insert into public.project_members
        (org_id, project_id, team_member_id, role_label, pay_type, agreed_pay, permission)
      values (r.org_id, r.project_id, v_tm, 'Member', 'none', null, r.permission)
      on conflict (project_id, team_member_id) do nothing;
    end if;
  end loop;

  -- 2. photographers[]: every distinct name per org becomes a team member…
  insert into public.team_members (org_id, display_name)
  select distinct p.org_id, trim(ph)
  from public.projects p, unnest(p.photographers) as ph
  where length(trim(ph)) > 0
  on conflict (org_id, lower(display_name)) do nothing;

  -- …and each (project, name) pair a membership.
  insert into public.project_members (org_id, project_id, team_member_id, role_label, pay_type)
  select p.org_id, p.id, tm.id, 'Photographer', 'flat'
  from public.projects p
  cross join lateral unnest(p.photographers) as ph
  join public.team_members tm
    on tm.org_id = p.org_id and lower(tm.display_name) = lower(trim(ph))
  where length(trim(ph)) > 0
  on conflict (project_id, team_member_id) do nothing;
end $$;

-- ---------- RLS ----------

alter table public.team_members    enable row level security;
alter table public.project_members enable row level security;

-- Financial viewers see the whole roster; a person always sees their own row.
drop policy if exists team_members_select on public.team_members;
create policy team_members_select on public.team_members
  for select using (
    public.org_can_view_financials(org_id)
    or (profile_id is not null and profile_id = auth.uid() and public.is_active_user())
  );

drop policy if exists team_members_modify_editor on public.team_members;
create policy team_members_modify_editor on public.team_members
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists project_members_select on public.project_members;
create policy project_members_select on public.project_members
  for select using (
    public.org_can_view_financials(org_id)
    or exists (
      select 1 from public.team_members tm
      where tm.id = team_member_id and tm.profile_id = auth.uid() and public.is_active_user()
    )
  );

drop policy if exists project_members_modify_editor on public.project_members;
create policy project_members_modify_editor on public.project_members
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

-- ---------- audit ----------

drop trigger if exists audit_team_members on public.team_members;
create trigger audit_team_members
  after insert or update or delete on public.team_members
  for each row execute procedure public.log_audit('team_member');

drop trigger if exists audit_members on public.project_members;
create trigger audit_members
  after insert or update or delete on public.project_members
  for each row execute procedure public.log_audit('member');

-- ---------- realtime ----------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.team_members;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.project_members;
    exception when duplicate_object then null; end;
  end if;
end $$;
