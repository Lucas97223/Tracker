-- Pre-hosting hardening (portal/public pen-test finding).
--
-- book_slot is the only public WRITE endpoint that lacked an abuse cap: its
-- scheduler share_token is semi-public by design (posted on a website), so an
-- attacker with the link could fill every available slot with junk bookings
-- (denial-of-booking) and pollute contacts with fake leads. submit_lead_form
-- already guards this with forms.daily_cap; mirror that exact pattern here.
--
-- This is defense-in-depth at the DB layer. The real fix for a publicly hosted
-- booking page is a CAPTCHA / Turnstile challenge on the public form, verified
-- before book_slot is called — add that when the web app gets hosted.

alter table public.appointment_types
  add column if not exists daily_cap int not null default 20
    check (daily_cap between 1 and 500);

-- Recreated with the 24h cap check, inserted after availability validation and
-- before any write. Body is otherwise identical to 0035.
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
  v_recent  int;
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

  -- Abuse cap: bookings created for this type in the last 24h (I mirror
  -- forms.daily_cap). Counts intake volume, not the slot calendar itself.
  select count(*) into v_recent from public.bookings
    where appointment_type_id = t.id and created_at > now() - interval '24 hours';
  if v_recent >= t.daily_cap then
    raise exception 'This scheduler is temporarily closed — please try again later';
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
