-- Phase 4, step 4: merge duplicate team-member identities.
--
-- Needed in production on day one: roster rows born from photographer names
-- ("Afrik") and auto-provisioned login identities ("armandoafrik") can be the
-- same human. The keeper inherits every reference — time, pay, staffing,
-- task assignments, rates — plus the login link; the duplicate is deleted
-- (it holds nothing after repointing; contacts merge archives instead
-- because contacts carry outward-facing history).

create or replace function public.merge_team_members(p_keep uuid, p_dupe uuid)
returns public.team_members language plpgsql security definer set search_path = public as $$
declare
  keep public.team_members;
  dupe public.team_members;
begin
  if p_keep = p_dupe then
    raise exception 'Pick two different team members';
  end if;
  select * into keep from public.team_members where id = p_keep for update;
  select * into dupe from public.team_members where id = p_dupe for update;
  if keep.id is null or dupe.id is null then
    raise exception 'Team member not found';
  end if;
  if keep.org_id <> dupe.org_id then
    raise exception 'Team members belong to different organizations' using errcode = 'check_violation';
  end if;
  if not public.org_is_admin(keep.org_id) then
    raise exception 'Only an organization owner/admin can merge team members';
  end if;
  if keep.profile_id is not null and dupe.profile_id is not null
     and keep.profile_id <> dupe.profile_id then
    raise exception 'Both identities are linked to different logins — unlink one first';
  end if;

  -- Locked time entries may move too: identity hygiene, not a billing change.
  perform set_config('app.billing_rpc', 'on', true);
  update public.time_entries set team_member_id = p_keep where team_member_id = p_dupe;
  perform set_config('app.billing_rpc', '', true);

  update public.pay_items set team_member_id = p_keep where team_member_id = p_dupe;
  update public.tasks set assignee_id = p_keep where assignee_id = p_dupe;

  -- Staffing: avoid (project, member) collisions, then move the rest.
  delete from public.project_members pm
    where pm.team_member_id = p_dupe
      and exists (select 1 from public.project_members k
                  where k.project_id = pm.project_id and k.team_member_id = p_keep);
  update public.project_members set team_member_id = p_keep where team_member_id = p_dupe;

  delete from public.task_collaborators tc
    where tc.team_member_id = p_dupe
      and exists (select 1 from public.task_collaborators k
                  where k.task_id = tc.task_id and k.team_member_id = p_keep);
  update public.task_collaborators set team_member_id = p_keep where team_member_id = p_dupe;

  -- Rates: keeper's win; otherwise inherit the duplicate's.
  if exists (select 1 from public.member_rates where team_member_id = p_keep) then
    delete from public.member_rates where team_member_id = p_dupe;
  else
    update public.member_rates set team_member_id = p_keep where team_member_id = p_dupe;
  end if;

  update public.team_members set
    profile_id = coalesce(keep.profile_id, dupe.profile_id),
    email      = coalesce(keep.email, dupe.email),
    notes      = case
                   when dupe.notes is null then keep.notes
                   when keep.notes is null then dupe.notes
                   else keep.notes || E'\n' || dupe.notes
                 end
    where id = p_keep;

  delete from public.team_members where id = p_dupe;

  insert into public.audit_log (user_id, action, entity_type, entity_id, changes, org_id)
  values (auth.uid(), 'update', 'team_member', p_keep,
          jsonb_build_object('merged_duplicate', p_dupe, 'duplicate_name', dupe.display_name),
          keep.org_id);

  select * into keep from public.team_members where id = p_keep;
  return keep;
end $$;
