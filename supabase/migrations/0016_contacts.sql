-- Phase 1, step 1: contacts — the single client identity (invariant I3).
--
-- One contacts record per real-world client. projects gain contact_id;
-- existing free-text projects.client values are backfilled into contacts
-- (one per distinct name per org) and linked. The legacy text column stays
-- for display compatibility but new code reads through the FK.

-- ---------- enums ----------

do $$ begin
  create type contact_type as enum ('person', 'company');
exception when duplicate_object then null; end $$;

do $$ begin
  create type contact_lifecycle as enum ('lead', 'client', 'archived');
exception when duplicate_object then null; end $$;

alter type audit_entity add value if not exists 'contact';
alter type audit_entity add value if not exists 'invoice';
alter type audit_entity add value if not exists 'payment';
alter type audit_entity add value if not exists 'vendor';
alter type audit_entity add value if not exists 'credit_note';
alter type audit_entity add value if not exists 'tax_rate';

-- ---------- contacts ----------

create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  type        contact_type not null default 'person',
  lifecycle   contact_lifecycle not null default 'client',
  name        text not null check (length(trim(name)) > 0),
  email       text,
  phone       text,
  company     text,
  address     jsonb not null default '{}'::jsonb,
  source      text,
  notes       text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contacts_org_idx on public.contacts(org_id);
create index if not exists contacts_name_idx on public.contacts(org_id, lower(name));
create index if not exists contacts_lifecycle_idx on public.contacts(org_id, lifecycle);

drop trigger if exists contacts_updated_at on public.contacts;
create trigger contacts_updated_at
  before update on public.contacts
  for each row execute procedure public.set_updated_at();

drop trigger if exists contacts_set_org on public.contacts;
create trigger contacts_set_org
  before insert on public.contacts
  for each row execute procedure public.set_org_id();

-- ---------- projects.contact_id ----------

alter table public.projects
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;
create index if not exists projects_contact_idx on public.projects(contact_id);

-- Same-org guard (extends the 0015 project checks).
create or replace function public.check_project_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.years where id = NEW.year_id), 'project → year');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.contacts where id = NEW.contact_id), 'project → contact');
  return NEW;
end $$;

drop trigger if exists projects_zz_org_refs on public.projects;
create trigger projects_zz_org_refs
  before insert or update of year_id, contact_id, org_id on public.projects
  for each row execute procedure public.check_project_org();

-- ---------- backfill: one contact per distinct client name per org ----------

do $$
begin
  insert into public.contacts (org_id, type, lifecycle, name, source)
  select distinct p.org_id, 'company'::contact_type, 'client'::contact_lifecycle,
         trim(p.client), 'backfill:projects.client'
  from public.projects p
  where p.client is not null and length(trim(p.client)) > 0
    and not exists (
      select 1 from public.contacts c
      where c.org_id = p.org_id and lower(c.name) = lower(trim(p.client))
    );

  update public.projects p
  set contact_id = c.id
  from public.contacts c
  where p.contact_id is null
    and p.client is not null
    and c.org_id = p.org_id
    and lower(c.name) = lower(trim(p.client));
end $$;

-- ---------- RLS ----------

alter table public.contacts enable row level security;

drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select using (public.org_can_view_financials(org_id));

drop policy if exists contacts_modify_editor on public.contacts;
create policy contacts_modify_editor on public.contacts
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

-- ---------- audit + realtime ----------

drop trigger if exists audit_contacts on public.contacts;
create trigger audit_contacts
  after insert or update or delete on public.contacts
  for each row execute procedure public.log_audit('contact');

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.contacts;
    exception when duplicate_object then null; end;
  end if;
end $$;
