-- Row-Level Security policies.
-- Source of truth: the database. The UI also hides controls but RLS enforces.

alter table public.profiles        enable row level security;
alter table public.years           enable row level security;
alter table public.projects        enable row level security;
alter table public.categories      enable row level security;
alter table public.expenses        enable row level security;
alter table public.project_members enable row level security;
alter table public.audit_log       enable row level security;

-- Helper functions ----------------------------------------------------------

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_active from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.user_role()
returns role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.user_role() = 'admin' and public.is_active_user();
$$;

create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user() and public.user_role() in ('admin', 'editor');
$$;

-- profiles -----------------------------------------------------------------
drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_update_self_name on public.profiles;
create policy profiles_update_self_name on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id and role = (select role from public.profiles where id = auth.uid()) and is_active = (select is_active from public.profiles where id = auth.uid()));

-- profiles insert is handled by the auth trigger; deny direct insert/delete from clients.

-- years --------------------------------------------------------------------
drop policy if exists years_select_active on public.years;
create policy years_select_active on public.years
  for select using (public.is_active_user());

drop policy if exists years_modify_editor on public.years;
create policy years_modify_editor on public.years
  for all using (public.can_edit()) with check (public.can_edit());

-- projects -----------------------------------------------------------------
drop policy if exists projects_select_active on public.projects;
create policy projects_select_active on public.projects
  for select using (public.is_active_user());

drop policy if exists projects_modify_editor on public.projects;
create policy projects_modify_editor on public.projects
  for all using (public.can_edit()) with check (public.can_edit());

-- categories ---------------------------------------------------------------
drop policy if exists categories_select_active on public.categories;
create policy categories_select_active on public.categories
  for select using (public.is_active_user());

drop policy if exists categories_modify_admin on public.categories;
create policy categories_modify_admin on public.categories
  for all using (public.is_admin()) with check (public.is_admin());

-- expenses -----------------------------------------------------------------
drop policy if exists expenses_select_active on public.expenses;
create policy expenses_select_active on public.expenses
  for select using (public.is_active_user());

drop policy if exists expenses_modify_editor on public.expenses;
create policy expenses_modify_editor on public.expenses
  for all using (public.can_edit()) with check (public.can_edit());

-- project_members ----------------------------------------------------------
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select using (public.is_active_user());

drop policy if exists members_modify_admin on public.project_members;
create policy members_modify_admin on public.project_members
  for all using (public.is_admin()) with check (public.is_admin());

-- audit_log ----------------------------------------------------------------
drop policy if exists audit_select_admin on public.audit_log;
create policy audit_select_admin on public.audit_log
  for select using (public.is_admin());
-- Inserts happen from the triggers below (security definer), not from clients.
