-- Phase 3 hotfix: every org member gets a team-member identity.
--
-- Found in first real use: team_members rows come from photographer names and
-- carry no profile link, so the org OWNER had no identity and start_timer
-- refused for everyone. Identity now materializes three ways:
--   1. backfill below (existing members),
--   2. an org_members trigger (future joins),
--   3. inside start_timer as a safety net.
-- Claiming beats creating: an unlinked team_members row matching the user's
-- email or full name is linked rather than duplicated.

-- Core: find-or-claim-or-create the identity for a given user in an org.
create or replace function public.ensure_team_member_for(p_user uuid, p_org uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_email text;
  v_name  text;
begin
  select tm.id into v_id from public.team_members tm
    where tm.org_id = p_org and tm.profile_id = p_user;
  if v_id is not null then
    return v_id;
  end if;

  select p.email, p.full_name into v_email, v_name from public.profiles p where p.id = p_user;
  if v_email is null then
    return null;
  end if;

  -- Claim an unlinked row that clearly IS this person.
  update public.team_members tm
    set profile_id = p_user,
        email = coalesce(tm.email, v_email)
    where tm.org_id = p_org
      and tm.profile_id is null
      and (lower(coalesce(tm.email, '')) = lower(v_email)
           or (v_name is not null and lower(tm.display_name) = lower(v_name)))
    returning tm.id into v_id;
  if v_id is not null then
    return v_id;
  end if;

  insert into public.team_members (org_id, display_name, email, profile_id)
  values (p_org,
          coalesce(nullif(trim(v_name), ''), split_part(v_email, '@', 1)),
          v_email, p_user)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.ensure_team_member_for(uuid, uuid) from public, anon, authenticated;

-- Caller-facing wrapper (any active member of the org).
create or replace function public.ensure_my_team_member(p_org uuid)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not public.is_org_member(p_org) then
    raise exception 'Not a member of this organization';
  end if;
  return public.ensure_team_member_for(auth.uid(), p_org);
end $$;

grant execute on function public.ensure_my_team_member(uuid) to authenticated;

-- start_timer: self-heal a missing identity instead of refusing.
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
    v_member := public.ensure_team_member_for(auth.uid(), v_org);
  end if;
  if v_member is null then
    raise exception 'Could not resolve your team-member identity';
  end if;

  perform public.stop_timer();

  insert into public.time_entries
    (org_id, project_id, task_id, team_member_id, started_at, notes, billable, created_by)
  values
    (v_org, p_project, p_task, v_member, now(), p_notes, p_billable, auth.uid())
  returning * into v_result;
  return v_result;
end $$;

-- Future org joins get an identity immediately (viewers excluded — they
-- observe, they don't hold work). Fires on role changes too: new signups
-- arrive as viewers and are promoted later by an admin.
create or replace function public.org_members_ensure_identity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.role <> 'viewer' then
    perform public.ensure_team_member_for(NEW.user_id, NEW.org_id);
  end if;
  return NEW;
end $$;

drop trigger if exists org_members_identity on public.org_members;
create trigger org_members_identity
  after insert or update of role on public.org_members
  for each row execute procedure public.org_members_ensure_identity();

-- Backfill every existing non-viewer member.
do $$
declare
  r record;
begin
  for r in select om.user_id, om.org_id from public.org_members om where om.role <> 'viewer'
  loop
    perform public.ensure_team_member_for(r.user_id, r.org_id);
  end loop;
end $$;
