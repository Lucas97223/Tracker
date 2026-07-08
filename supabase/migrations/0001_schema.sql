-- Expense Tracker schema
-- Run in order: 0001_schema, 0002_rls, 0003_audit, 0004_views, 0005_seed

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ---------- enums ----------
do $$ begin
  create type role as enum ('admin', 'editor', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_status as enum ('planning', 'active', 'completed', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type audit_action as enum ('create', 'update', 'delete');
exception when duplicate_object then null; end $$;

do $$ begin
  create type audit_entity as enum ('year', 'project', 'expense', 'category', 'member', 'profile');
exception when duplicate_object then null; end $$;

do $$ begin
  create type project_permission as enum ('edit', 'view');
exception when duplicate_object then null; end $$;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role role not null default 'viewer',
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

-- Auto-create a profile row when a new auth user is created.
-- New users default to is_active=false (invite-only). An admin must enable them.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  user_count int;
  initial_role role := 'viewer';
  initial_active boolean := false;
begin
  -- Bootstrap: the very first signup becomes an active admin.
  select count(*) into user_count from public.profiles;
  if user_count = 0 then
    initial_role := 'admin';
    initial_active := true;
  end if;
  insert into public.profiles (id, email, full_name, role, is_active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    initial_role,
    initial_active
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- years ----------
create table if not exists public.years (
  id uuid primary key default gen_random_uuid(),
  year_value int not null unique check (year_value between 1900 and 3000),
  label text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- projects ----------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years(id) on delete restrict,
  name text not null,
  description text,
  client text,
  location text,
  status project_status not null default 'active',
  start_date date,
  end_date date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists projects_year_id_idx on public.projects(year_id);
create index if not exists projects_created_at_idx on public.projects(created_at);

-- ---------- categories ----------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  color text not null default '#64748b',
  is_archived boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- expenses ----------
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  description text not null,
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'USD',
  expense_date date not null default current_date,
  location text,
  vendor text,
  payment_method text,
  receipt_url text,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expenses_project_idx on public.expenses(project_id);
create index if not exists expenses_category_idx on public.expenses(category_id);
create index if not exists expenses_date_idx on public.expenses(expense_date);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists expenses_updated_at on public.expenses;
create trigger expenses_updated_at
  before update on public.expenses
  for each row execute procedure public.set_updated_at();

-- ---------- project_members (schema-ready, not enforced in v1) ----------
create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission project_permission not null default 'view',
  primary key (project_id, user_id)
);

-- ---------- audit log ----------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  action audit_action not null,
  entity_type audit_entity not null,
  entity_id uuid not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_at_idx on public.audit_log(created_at desc);
create index if not exists audit_log_entity_idx on public.audit_log(entity_type, entity_id);
create index if not exists audit_log_user_idx on public.audit_log(user_id);
