-- Phase 5, step 5: the scheduler — appointment types, weekly availability,
-- anonymous booking with hard double-book protection (range exclusion).
--
-- Times: availability rules are wall-clock times in the org's timezone
-- (organizations.settings ->> 'timezone', default UTC). Slots are returned
-- and stored as absolute timestamps.

create extension if not exists btree_gist;

do $$ begin
  create type booking_status as enum ('confirmed', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.appointment_types (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  name            text not null check (length(trim(name)) > 0),
  description     text,
  minutes         int not null default 30 check (minutes between 5 and 480),
  buffer_minutes  int not null default 0 check (buffer_minutes between 0 and 120),
  share_token     uuid not null unique default gen_random_uuid(),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists appointment_types_updated_at on public.appointment_types;
create trigger appointment_types_updated_at
  before update on public.appointment_types
  for each row execute procedure public.set_updated_at();

drop trigger if exists appointment_types_set_org on public.appointment_types;
create trigger appointment_types_set_org
  before insert on public.appointment_types
  for each row execute procedure public.set_org_id();

create table if not exists public.availability_rules (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  appointment_type_id   uuid references public.appointment_types(id) on delete cascade,
  weekday               int not null check (weekday between 1 and 7),  -- ISO: 1 = Monday
  start_time            time not null,
  end_time              time not null,
  created_at            timestamptz not null default now(),
  check (end_time > start_time)
);
create index if not exists availability_rules_org_idx on public.availability_rules(org_id, weekday);

drop trigger if exists availability_rules_set_org on public.availability_rules;
create trigger availability_rules_set_org
  before insert on public.availability_rules
  for each row execute procedure public.set_org_id();

create table if not exists public.bookings (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  appointment_type_id  uuid not null references public.appointment_types(id) on delete cascade,
  contact_id           uuid references public.contacts(id) on delete set null,
  name                 text not null,
  email                text,
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  status               booking_status not null default 'confirmed',
  notes                text,
  created_at           timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists bookings_org_time_idx on public.bookings(org_id, starts_at);

-- The race killer: two confirmed bookings can never overlap within an org.
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (org_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status = 'confirmed');

drop trigger if exists bookings_set_org on public.bookings;
create trigger bookings_set_org
  before insert on public.bookings
  for each row execute procedure public.set_org_id();

-- ---------- slot computation ----------

create or replace function public.org_timezone(p_org uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(o.settings ->> 'timezone', ''), 'UTC')
  from public.organizations o where o.id = p_org;
$$;

create or replace function public.get_public_scheduler(
  p_token uuid,
  p_from date default current_date,
  p_days int default 14
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  t     public.appointment_types;
  v_tz  text;
  slots jsonb := '[]'::jsonb;
  d     date;
  r     record;
  s     timestamptz;
  e     timestamptz;
  step  int;
begin
  select * into t from public.appointment_types where share_token = p_token and is_active;
  if not found then
    return null;
  end if;
  v_tz := public.org_timezone(t.org_id);
  step := t.minutes + t.buffer_minutes;
  p_days := least(greatest(p_days, 1), 31);

  for d in select generate_series(p_from, p_from + (p_days - 1), interval '1 day')::date loop
    for r in
      select * from public.availability_rules
      where org_id = t.org_id
        and (appointment_type_id is null or appointment_type_id = t.id)
        and weekday = extract(isodow from d)::int
    loop
      s := (d::text || ' ' || r.start_time::text)::timestamp at time zone v_tz;
      while s + make_interval(mins => t.minutes)
            <= (d::text || ' ' || r.end_time::text)::timestamp at time zone v_tz loop
        e := s + make_interval(mins => t.minutes);
        if s > now() and not exists (
          select 1 from public.bookings b
          where b.org_id = t.org_id and b.status = 'confirmed'
            and tstzrange(b.starts_at, b.ends_at) && tstzrange(s, e)
        ) then
          slots := slots || jsonb_build_object('starts_at', s, 'ends_at', e);
        end if;
        s := s + make_interval(mins => step);
      end loop;
    end loop;
  end loop;

  return jsonb_build_object(
    'name', t.name,
    'description', t.description,
    'minutes', t.minutes,
    'org_name', (select o.name from public.organizations o where o.id = t.org_id),
    'timezone', v_tz,
    'slots', slots
  );
end $$;

grant execute on function public.get_public_scheduler(uuid, date, int) to anon, authenticated;

create or replace function public.book_slot(
  p_token uuid,
  p_starts_at timestamptz,
  p_name text,
  p_email text default null,
  p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t         public.appointment_types;
  v_tz      text;
  v_ends    timestamptz;
  v_ok      boolean := false;
  v_contact uuid;
  r         record;
  v_local   timestamp;
begin
  select * into t from public.appointment_types where share_token = p_token and is_active;
  if not found then
    raise exception 'This scheduler is not accepting bookings';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Please give your name';
  end if;
  if p_starts_at <= now() then
    raise exception 'That time has already passed';
  end if;

  v_tz := public.org_timezone(t.org_id);
  v_ends := p_starts_at + make_interval(mins => t.minutes);
  v_local := p_starts_at at time zone v_tz;

  -- The requested start must sit inside a rule window, aligned to the step.
  for r in
    select * from public.availability_rules
    where org_id = t.org_id
      and (appointment_type_id is null or appointment_type_id = t.id)
      and weekday = extract(isodow from v_local)::int
  loop
    if v_local::time >= r.start_time
       and (v_local::time + make_interval(mins => t.minutes))::time <= r.end_time
       and mod(extract(epoch from (v_local::time - r.start_time))::int / 60,
               t.minutes + t.buffer_minutes) = 0 then
      v_ok := true;
      exit;
    end if;
  end loop;
  if not v_ok then
    raise exception 'That time is outside the available hours';
  end if;

  -- Contact: dedupe by email (I3), lifecycle lead.
  if p_email is not null and length(trim(p_email)) > 0 then
    select id into v_contact from public.contacts
      where org_id = t.org_id and lower(coalesce(email, '')) = lower(trim(p_email))
      limit 1;
    if v_contact is null then
      insert into public.contacts (org_id, type, lifecycle, name, email, source)
      values (t.org_id, 'person', 'lead', trim(p_name), lower(trim(p_email)), 'booking:' || t.name)
      returning id into v_contact;
    end if;
  end if;

  begin
    insert into public.bookings
      (org_id, appointment_type_id, contact_id, name, email, starts_at, ends_at, notes)
    values
      (t.org_id, t.id, v_contact, trim(p_name), nullif(trim(coalesce(p_email, '')), ''),
       p_starts_at, v_ends, p_notes);
  exception when exclusion_violation then
    raise exception 'Sorry — that slot was just taken. Pick another time.';
  end;

  return jsonb_build_object('ok', true, 'starts_at', p_starts_at, 'ends_at', v_ends);
end $$;

grant execute on function public.book_slot(uuid, timestamptz, text, text, text) to anon, authenticated;

-- ---------- RLS + audit ----------

alter table public.appointment_types enable row level security;
alter table public.availability_rules enable row level security;
alter table public.bookings           enable row level security;

drop policy if exists appointment_types_select on public.appointment_types;
create policy appointment_types_select on public.appointment_types
  for select using (public.org_can_view_financials(org_id));
drop policy if exists appointment_types_modify on public.appointment_types;
create policy appointment_types_modify on public.appointment_types
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists availability_rules_select on public.availability_rules;
create policy availability_rules_select on public.availability_rules
  for select using (public.org_can_view_financials(org_id));
drop policy if exists availability_rules_modify on public.availability_rules;
create policy availability_rules_modify on public.availability_rules
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists bookings_select on public.bookings;
create policy bookings_select on public.bookings
  for select using (public.org_can_view_financials(org_id));
-- bookings arrive via the anon RPC; org editors may cancel/annotate.
drop policy if exists bookings_modify on public.bookings;
create policy bookings_modify on public.bookings
  for update using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop trigger if exists audit_bookings on public.bookings;
create trigger audit_bookings
  after insert or update or delete on public.bookings
  for each row execute procedure public.log_audit('booking');
