-- Audit triggers: every create/update/delete on the primary entities is logged.

create or replace function public.log_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  entity audit_entity;
  diff jsonb := '{}'::jsonb;
  eid uuid;
begin
  entity := tg_argv[0]::audit_entity;

  if tg_op = 'INSERT' then
    eid := (row_to_json(new)->>'id')::uuid;
    diff := jsonb_build_object('new', to_jsonb(new));
    insert into public.audit_log (user_id, action, entity_type, entity_id, changes)
      values (auth.uid(), 'create', entity, eid, diff);
    return new;
  elsif tg_op = 'UPDATE' then
    eid := (row_to_json(new)->>'id')::uuid;
    diff := jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new));
    insert into public.audit_log (user_id, action, entity_type, entity_id, changes)
      values (auth.uid(), 'update', entity, eid, diff);
    return new;
  elsif tg_op = 'DELETE' then
    eid := (row_to_json(old)->>'id')::uuid;
    diff := jsonb_build_object('deleted', to_jsonb(old));
    insert into public.audit_log (user_id, action, entity_type, entity_id, changes)
      values (auth.uid(), 'delete', entity, eid, diff);
    return old;
  end if;
  return null;
end $$;

-- Year
drop trigger if exists audit_years on public.years;
create trigger audit_years
  after insert or update or delete on public.years
  for each row execute procedure public.log_audit('year');

-- Project
drop trigger if exists audit_projects on public.projects;
create trigger audit_projects
  after insert or update or delete on public.projects
  for each row execute procedure public.log_audit('project');

-- Expense
drop trigger if exists audit_expenses on public.expenses;
create trigger audit_expenses
  after insert or update or delete on public.expenses
  for each row execute procedure public.log_audit('expense');

-- Category
drop trigger if exists audit_categories on public.categories;
create trigger audit_categories
  after insert or update or delete on public.categories
  for each row execute procedure public.log_audit('category');

-- Project member
drop trigger if exists audit_members on public.project_members;
create trigger audit_members
  after insert or update or delete on public.project_members
  for each row execute procedure public.log_audit('member');

-- Profile (role/active changes)
drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles
  after update on public.profiles
  for each row execute procedure public.log_audit('profile');
