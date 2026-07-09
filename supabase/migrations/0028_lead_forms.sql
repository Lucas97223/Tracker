-- Phase 4, step 2: public lead-capture forms.
--
-- A form has a share token (like invoices) and renders anonymously at
-- /#/f/<token>. Submission runs through ONE anon RPC that creates/dedupes the
-- contact (lifecycle lead), stores the response, and opens a deal in the
-- pipeline's first stage. A per-form daily cap blunts drive-by spam.

do $$ begin
  create type form_field_kind as enum ('text', 'email', 'phone', 'textarea', 'select', 'date');
exception when duplicate_object then null; end $$;

-- ---------- forms ----------

create table if not exists public.forms (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  headline      text,
  description   text,
  share_token   uuid not null unique default gen_random_uuid(),
  is_active     boolean not null default true,
  creates_deal  boolean not null default true,
  deal_title    text not null default 'New inquiry',
  daily_cap     int not null default 50 check (daily_cap between 1 and 1000),
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists forms_org_idx on public.forms(org_id);

drop trigger if exists forms_updated_at on public.forms;
create trigger forms_updated_at
  before update on public.forms
  for each row execute procedure public.set_updated_at();

drop trigger if exists forms_set_org on public.forms;
create trigger forms_set_org
  before insert on public.forms
  for each row execute procedure public.set_org_id();

create table if not exists public.form_fields (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  form_id     uuid not null references public.forms(id) on delete cascade,
  label       text not null check (length(trim(label)) > 0),
  kind        form_field_kind not null default 'text',
  required    boolean not null default false,
  options     text[] not null default '{}',   -- for kind = select
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists form_fields_form_idx on public.form_fields(form_id, sort_order);

create or replace function public.set_org_id_from_form()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.org_id is null then
    select f.org_id into NEW.org_id from public.forms f where f.id = NEW.form_id;
  end if;
  return NEW;
end $$;

drop trigger if exists form_fields_set_org on public.form_fields;
create trigger form_fields_set_org
  before insert on public.form_fields
  for each row execute procedure public.set_org_id_from_form();

create table if not exists public.form_responses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  form_id     uuid not null references public.forms(id) on delete cascade,
  contact_id  uuid references public.contacts(id) on delete set null,
  deal_id     uuid references public.deals(id) on delete set null,
  answers     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists form_responses_form_idx on public.form_responses(form_id, created_at desc);

drop trigger if exists form_responses_set_org on public.form_responses;
create trigger form_responses_set_org
  before insert on public.form_responses
  for each row execute procedure public.set_org_id_from_form();

-- ---------- public RPCs ----------

create or replace function public.get_public_form(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  f public.forms;
begin
  select * into f from public.forms where share_token = p_token and is_active;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'name', f.name,
    'headline', f.headline,
    'description', f.description,
    'org_name', (select o.name from public.organizations o where o.id = f.org_id),
    'fields', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', ff.id, 'label', ff.label, 'kind', ff.kind,
        'required', ff.required, 'options', ff.options
      ) order by ff.sort_order, ff.created_at), '[]'::jsonb)
      from public.form_fields ff where ff.form_id = f.id
    )
  );
end $$;

grant execute on function public.get_public_form(uuid) to anon, authenticated;

-- answers: {field_id: value, ...} plus conventional name/email keys resolved
-- from the fields' kinds/labels.
create or replace function public.submit_lead_form(p_token uuid, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f          public.forms;
  ff         record;
  v_val      text;
  v_name     text;
  v_email    text;
  v_phone    text;
  v_notes    text := '';
  v_contact  uuid;
  v_deal     uuid;
  v_today    int;
begin
  select * into f from public.forms where share_token = p_token and is_active;
  if not found then
    raise exception 'This form is not accepting responses';
  end if;

  select count(*) into v_today from public.form_responses
    where form_id = f.id and created_at > now() - interval '24 hours';
  if v_today >= f.daily_cap then
    raise exception 'This form is temporarily closed — please try again later';
  end if;

  for ff in select * from public.form_fields where form_id = f.id
            order by sort_order, created_at
  loop
    v_val := nullif(trim(coalesce(p_answers ->> ff.id::text, '')), '');
    if ff.required and v_val is null then
      raise exception 'Missing required field: %', ff.label;
    end if;
    if v_val is null then continue; end if;
    if length(v_val) > 2000 then
      raise exception 'Answer too long for: %', ff.label;
    end if;

    if ff.kind = 'email' and v_email is null then
      v_email := lower(v_val);
    elsif ff.kind = 'phone' and v_phone is null then
      v_phone := v_val;
    elsif v_name is null and ff.kind = 'text' and ff.label ilike '%name%' then
      v_name := v_val;
    else
      v_notes := v_notes || ff.label || ': ' || v_val || E'\n';
    end if;
  end loop;

  if v_name is null and v_email is null then
    raise exception 'The form needs at least a name or an email field answered';
  end if;

  -- Contact: dedupe by email within the org (I3 — one contact per human).
  if v_email is not null then
    select id into v_contact from public.contacts
      where org_id = f.org_id and lower(coalesce(email, '')) = v_email
      limit 1;
  end if;
  if v_contact is null then
    insert into public.contacts (org_id, type, lifecycle, name, email, phone, source, notes)
    values (f.org_id, 'person', 'lead',
            coalesce(v_name, v_email), v_email, v_phone,
            'form:' || f.name, nullif(v_notes, ''))
    returning id into v_contact;
  end if;

  if f.creates_deal then
    insert into public.deals (org_id, contact_id, title, source, notes)
    values (f.org_id, v_contact,
            f.deal_title || ' — ' || coalesce(v_name, v_email),
            'form:' || f.name, nullif(v_notes, ''))
    returning id into v_deal;
  end if;

  insert into public.form_responses (org_id, form_id, contact_id, deal_id, answers)
  values (f.org_id, f.id, v_contact, v_deal, p_answers);

  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.submit_lead_form(uuid, jsonb) to anon, authenticated;

-- ---------- RLS ----------

alter table public.forms          enable row level security;
alter table public.form_fields    enable row level security;
alter table public.form_responses enable row level security;

drop policy if exists forms_select on public.forms;
create policy forms_select on public.forms
  for select using (public.org_can_view_financials(org_id));
drop policy if exists forms_modify on public.forms;
create policy forms_modify on public.forms
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists form_fields_select on public.form_fields;
create policy form_fields_select on public.form_fields
  for select using (public.org_can_view_financials(org_id));
drop policy if exists form_fields_modify on public.form_fields;
create policy form_fields_modify on public.form_fields
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists form_responses_select on public.form_responses;
create policy form_responses_select on public.form_responses
  for select using (public.org_can_view_financials(org_id));
-- responses are inserted only via the definer RPC; no client write policies.

-- ---------- audit ----------

drop trigger if exists audit_forms on public.forms;
create trigger audit_forms
  after insert or update or delete on public.forms
  for each row execute procedure public.log_audit('form');
