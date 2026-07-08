-- Adds person_name to expenses + a trigger that, when a project's photographers
-- list grows, auto-creates a $0 row in the "Photographer Pay" category for
-- each new name. The user then edits each row to fill in the actual pay.
--
-- Why this design:
--   * "Filter dashboard by photographer X" should show what X was paid, not
--     every Travel/Catering line on projects where X happened to work.
--   * person_name gives every expense a precise attribution that survives
--     description edits (you can rename the line and the attribution stays).
--   * Removing a photographer from a project's team leaves their pay row
--     intact, so historical records aren't lost on a typo or team change.

-- ---------- column + index ----------

alter table public.expenses
  add column if not exists person_name text;

create index if not exists expenses_person_name_idx
  on public.expenses(person_name)
  where person_name is not null;

-- Optional backfill: when a Photographer Pay row's description matches a
-- photographer name on its project, copy that name into person_name.
update public.expenses e
set person_name = lower_match.match
from (
  select
    ex.id,
    (
      select ph
      from unnest(p.photographers) ph
      where lower(ph) = lower(ex.description)
      limit 1
    ) as match
  from public.expenses ex
  join public.projects p on p.id = ex.project_id
  join public.categories c on c.id = ex.category_id
  where ex.person_name is null
    and c.name ilike 'photographer pay'
) as lower_match
where e.id = lower_match.id and lower_match.match is not null;

-- ---------- sync trigger ----------

create or replace function public.sync_project_photographer_pay()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  pay_category_id uuid;
  ph_name text;
  to_add text[];
begin
  -- Find the active Photographer Pay category. If the user archived it, do nothing.
  select id into pay_category_id
    from public.categories
    where name ilike 'photographer pay'
      and is_archived = false
    limit 1;
  if pay_category_id is null then return NEW; end if;

  if TG_OP = 'INSERT' then
    to_add := NEW.photographers;
  else
    -- Only add names that are in NEW but not OLD (we don't re-create rows that
    -- already exist, and we don't delete rows for removed photographers).
    to_add := array(
      select unnest(coalesce(NEW.photographers, '{}'::text[]))
      except
      select unnest(coalesce(OLD.photographers, '{}'::text[]))
    );
  end if;

  if to_add is null or array_length(to_add, 1) is null then return NEW; end if;

  foreach ph_name in array to_add loop
    -- Skip if there's already a row for this person on this project.
    -- Match either by person_name (preferred) or by exact description (legacy).
    perform 1 from public.expenses
      where project_id = NEW.id
        and category_id = pay_category_id
        and (
          person_name = ph_name
          or (person_name is null and lower(description) = lower(ph_name))
        );
    if not found then
      insert into public.expenses
        (project_id, category_id, description, amount, expense_date,
         location, person_name, created_by)
      values
        (NEW.id, pay_category_id, ph_name, 0,
         coalesce(NEW.start_date, current_date),
         NEW.location, ph_name, NEW.created_by);
    end if;
  end loop;

  return NEW;
end $$;

drop trigger if exists projects_sync_photographers on public.projects;
create trigger projects_sync_photographers
  after insert or update of photographers on public.projects
  for each row execute procedure public.sync_project_photographer_pay();

-- ---------- backfill: for existing projects with photographers but no rows ----------

do $$
declare
  proj record;
  ph_name text;
  pay_category_id uuid;
begin
  select id into pay_category_id
    from public.categories
    where name ilike 'photographer pay' and is_archived = false
    limit 1;
  if pay_category_id is null then return; end if;

  for proj in
    select id, photographers, start_date, location, created_by
    from public.projects
    where photographers is not null and array_length(photographers, 1) > 0
  loop
    foreach ph_name in array proj.photographers loop
      perform 1 from public.expenses
        where project_id = proj.id
          and category_id = pay_category_id
          and (
            person_name = ph_name
            or (person_name is null and lower(description) = lower(ph_name))
          );
      if not found then
        insert into public.expenses
          (project_id, category_id, description, amount, expense_date,
           location, person_name, created_by)
        values
          (proj.id, pay_category_id, ph_name, 0,
           coalesce(proj.start_date, current_date),
           proj.location, ph_name, proj.created_by);
      end if;
    end loop;
  end loop;
end $$;
