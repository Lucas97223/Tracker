-- Phase 2, step 2: task templates v1 (tasks/sections/subtasks only — the
-- money-carrying template fields arrive with Phases 5/6 per the spec).

create table if not exists public.task_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  description text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists task_templates_org_idx on public.task_templates(org_id);

drop trigger if exists task_templates_updated_at on public.task_templates;
create trigger task_templates_updated_at
  before update on public.task_templates
  for each row execute procedure public.set_updated_at();

drop trigger if exists task_templates_set_org on public.task_templates;
create trigger task_templates_set_org
  before insert on public.task_templates
  for each row execute procedure public.set_org_id();

create table if not exists public.task_template_items (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  template_id     uuid not null references public.task_templates(id) on delete cascade,
  parent_item_id  uuid references public.task_template_items(id) on delete cascade,
  section_name    text,
  title           text not null check (length(trim(title)) > 0),
  description     text,
  priority        task_priority not null default 'medium',
  sort_order      int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists task_template_items_template_idx
  on public.task_template_items(template_id);

create or replace function public.set_org_id_from_template()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select t.org_id into NEW.org_id from public.task_templates t where t.id = NEW.template_id;
  end if;
  return NEW;
end $$;

drop trigger if exists task_template_items_set_org on public.task_template_items;
create trigger task_template_items_set_org
  before insert on public.task_template_items
  for each row execute procedure public.set_org_id_from_template();

-- ---------- apply ----------

-- Creates the template's whole tree on a project in one transaction:
-- sections found-or-created by name, then parent tasks, then subtasks.
create or replace function public.apply_task_template(p_template uuid, p_project uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  tpl        public.task_templates;
  v_proj_org uuid;
  item       record;
  v_section  uuid;
  v_task     uuid;
  v_base     int;
  v_count    int := 0;
  v_map      jsonb := '{}'::jsonb;   -- template item id → created task id
begin
  select * into tpl from public.task_templates where id = p_template;
  if not found then
    raise exception 'Template % not found', p_template;
  end if;
  select org_id into v_proj_org from public.projects where id = p_project;
  if v_proj_org is null or v_proj_org <> tpl.org_id then
    raise exception 'Template and project belong to different organizations'
      using errcode = 'check_violation';
  end if;
  if not public.org_can_edit(tpl.org_id) then
    raise exception 'Not allowed to apply templates in this organization';
  end if;

  select coalesce(max(sort_order), 0) into v_base from public.tasks
    where project_id = p_project;

  -- depth-first ordering so every parent is created (and mapped) before its
  -- children, whatever the nesting depth.
  for item in
    with recursive tree as (
      select i.*, 0 as depth
      from public.task_template_items i
      where i.template_id = p_template and i.parent_item_id is null
      union all
      select c.*, tree.depth + 1
      from public.task_template_items c
      join tree on c.parent_item_id = tree.id
    )
    select * from tree order by depth, sort_order, created_at
  loop
    v_section := null;
    if item.section_name is not null and item.parent_item_id is null then
      select id into v_section from public.task_sections
        where project_id = p_project and lower(name) = lower(item.section_name);
      if v_section is null then
        insert into public.task_sections (org_id, project_id, name, sort_order)
        values (tpl.org_id, p_project, item.section_name,
                (select coalesce(max(sort_order), 0) + 1 from public.task_sections
                  where project_id = p_project))
        returning id into v_section;
      end if;
    end if;

    insert into public.tasks
      (org_id, project_id, section_id, parent_task_id, title, description,
       priority, sort_order, created_by)
    values
      (tpl.org_id, p_project, v_section,
       case when item.parent_item_id is null then null
            else (v_map ->> item.parent_item_id::text)::uuid end,
       item.title, item.description, item.priority,
       v_base + item.sort_order + 1, auth.uid())
    returning id into v_task;

    v_map := v_map || jsonb_build_object(item.id::text, v_task::text);
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- ---------- RLS + audit ----------

alter table public.task_templates      enable row level security;
alter table public.task_template_items enable row level security;

drop policy if exists task_templates_select on public.task_templates;
create policy task_templates_select on public.task_templates
  for select using (public.org_can_view_financials(org_id));
drop policy if exists task_templates_modify on public.task_templates;
create policy task_templates_modify on public.task_templates
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists task_template_items_select on public.task_template_items;
create policy task_template_items_select on public.task_template_items
  for select using (public.org_can_view_financials(org_id));
drop policy if exists task_template_items_modify on public.task_template_items;
create policy task_template_items_modify on public.task_template_items
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop trigger if exists audit_task_templates on public.task_templates;
create trigger audit_task_templates
  after insert or update or delete on public.task_templates
  for each row execute procedure public.log_audit('task_template');
