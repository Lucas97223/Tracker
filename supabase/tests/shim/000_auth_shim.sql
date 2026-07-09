-- Local-Postgres shim for the pieces Supabase provides in production.
-- Applied ONLY by scripts/db-test.sh against the throwaway test database —
-- never against a real Supabase project (which has the genuine auth schema).

create schema if not exists auth;

create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text unique,
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Mirrors Supabase's auth.uid(): the sub claim of the caller's JWT.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- API roles as they exist on the platform.
do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;

grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Supabase grants table/sequence/function access to the API roles by default;
-- RLS is the actual gate. Replicate for everything the migrations create.
alter default privileges in schema public grant all on tables    to authenticated;
alter default privileges in schema public grant all on sequences to authenticated;
alter default privileges in schema public grant execute on functions to authenticated;

-- ---------- test helpers ----------

create schema if not exists tests;
grant usage on schema tests to authenticated, anon;

-- Simulate signing in: point auth.uid() at the given user. Pair with
-- `set role authenticated;` in the test script so RLS actually applies.
create or replace function tests.become(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), false)
$$;
grant execute on function tests.become(uuid) to authenticated;

create or replace function tests.assert(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'ASSERT FAILED: %', p_msg;
  end if;
end $$;
grant execute on function tests.assert(boolean, text) to authenticated, anon;

-- Create an auth user (fires the profile-bootstrap trigger) and return its id.
create or replace function tests.make_user(p_email text)
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_email);
  return v_id;
end $$;

-- A PORTAL signup (magic-link client): flagged in metadata like the app does.
create or replace function tests.make_portal_user(p_email text)
returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
  values (v_id, p_email, '{"portal": "true"}'::jsonb);
  return v_id;
end $$;
