-- Phase 5, step 6: the client portal.
--
-- Clients sign in with a magic link (Supabase's built-in mailer — no external
-- key). A portal login is an auth user flagged portal=true in its metadata:
--   * its profile is created INACTIVE and never joins an org or the roster,
--     so every staff-side helper stays false for it (I6);
--   * contact_users links it to contacts by verified email;
--   * it reads ONLY through the definer portal views below, each filtered by
--     that mapping — base tables and staff views stay closed. No UI-level
--     filtering is load-bearing (I6). Pen-test before GA, per the spec.

alter type audit_entity add value if not exists 'portal_user';

create table if not exists public.contact_users (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, contact_id)
);
create index if not exists contact_users_contact_idx on public.contact_users(contact_id);

alter table public.contact_users enable row level security;

drop policy if exists contact_users_select_own on public.contact_users;
create policy contact_users_select_own on public.contact_users
  for select using (user_id = auth.uid());

drop policy if exists contact_users_admin on public.contact_users;
create policy contact_users_admin on public.contact_users
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

-- ---------- linking ----------

create or replace function public.link_portal_user(p_user uuid, p_email text)
returns int language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  insert into public.contact_users (user_id, contact_id, org_id)
  select p_user, c.id, c.org_id
  from public.contacts c
  where lower(coalesce(c.email, '')) = lower(p_email)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.link_portal_user(uuid, text) from public, anon, authenticated;

-- Signup bootstrap: portal users get an inactive, org-less profile and their
-- contact links; staff signups keep the existing single-org behaviour.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  user_count int;
  initial_role role := 'viewer';
  initial_active boolean := false;
  v_org uuid;
  v_org_count int;
  v_portal boolean := coalesce(new.raw_user_meta_data ->> 'portal', '') = 'true';
begin
  if v_portal then
    insert into public.profiles (id, email, full_name, role, is_active)
    values (new.id, new.email,
            coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
            'viewer', false);
    perform public.link_portal_user(new.id, new.email);
    return new;
  end if;

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

  select count(*) into v_org_count from public.organizations;
  if v_org_count = 1 then
    select id into v_org from public.organizations limit 1;
    insert into public.org_members (org_id, user_id, role)
    values (v_org, new.id, case when initial_role = 'admin' then 'owner'::org_role else 'viewer'::org_role end)
    on conflict do nothing;
    update public.profiles set default_org_id = v_org where id = new.id;
  end if;

  return new;
end $$;

-- A contact gaining an email later links any existing portal login for it.
create or replace function public.contacts_link_portal_users()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.email is null or length(trim(NEW.email)) = 0 then
    return NEW;
  end if;
  insert into public.contact_users (user_id, contact_id, org_id)
  select u.id, NEW.id, NEW.org_id
  from auth.users u
  where lower(u.email) = lower(NEW.email)
    and coalesce(u.raw_user_meta_data ->> 'portal', '') = 'true'
  on conflict do nothing;
  return NEW;
end $$;

drop trigger if exists contacts_portal_link on public.contacts;
create trigger contacts_portal_link
  after insert or update of email on public.contacts
  for each row execute procedure public.contacts_link_portal_users();

-- ---------- portal read surfaces (definer views, mapping-filtered) ----------

-- NOTE: totals are computed from base tables here on purpose. Joining the
-- staff-side v_invoice_totals (security_invoker) would re-apply RLS as the
-- portal user — who correctly has none — and empty the join.
create or replace view public.v_portal_invoices as
select
  i.id, i.number, i.status, i.issue_date, i.due_date, i.memo, i.share_token,
  t.total,
  coalesce(pay.paid, 0)::numeric(14,2) as paid,
  (t.total - coalesce(pay.paid, 0))::numeric(14,2) as balance,
  o.name as org_name,
  p.name as project_name,
  c.name as contact_name
from public.invoices i
join public.contact_users cu on cu.contact_id = i.contact_id and cu.user_id = auth.uid()
cross join lateral (
  select (coalesce(sum(round(l.qty * l.unit_price, 2)), 0)
          + coalesce(sum(round(l.qty * l.unit_price * coalesce(tr.rate, 0), 2)), 0))::numeric(14,2) as total
  from public.invoice_lines l
  left join public.tax_rates tr on tr.id = l.tax_rate_id
  where l.invoice_id = i.id
) t
left join lateral (
  select sum(amount) as paid from public.payments
  where invoice_id = i.id and voided_at is null
) pay on true
join public.organizations o on o.id = i.org_id
left join public.projects p on p.id = i.project_id
join public.contacts c on c.id = i.contact_id
where i.status in ('sent', 'partial', 'paid');

grant select on public.v_portal_invoices to authenticated;

create or replace view public.v_portal_projects as
select p.id, p.name, p.status, p.project_type, p.start_date, p.end_date, p.location,
       o.name as org_name
from public.projects p
join public.contact_users cu on cu.contact_id = p.contact_id and cu.user_id = auth.uid()
join public.organizations o on o.id = p.org_id;

grant select on public.v_portal_projects to authenticated;

create or replace view public.v_portal_proposals as
select pr.id, pr.title, pr.status, pr.share_token, pr.valid_until, pr.accepted_at,
       t.total, o.name as org_name
from public.proposals pr
join public.contact_users cu on cu.contact_id = pr.contact_id and cu.user_id = auth.uid()
cross join lateral (
  select (coalesce(sum(round(l.qty * l.unit_price, 2)), 0)
          + coalesce(sum(round(l.qty * l.unit_price * coalesce(tr.rate, 0), 2)), 0))::numeric(14,2) as total
  from public.proposal_lines l
  left join public.tax_rates tr on tr.id = l.tax_rate_id
  where l.proposal_id = pr.id
) t
join public.organizations o on o.id = pr.org_id
where pr.status in ('sent', 'accepted', 'declined', 'expired');

grant select on public.v_portal_proposals to authenticated;

create or replace view public.v_portal_contracts as
select c.id, c.title, c.status, c.share_token, c.signed_at,
       o.name as org_name
from public.contracts c
join public.contact_users cu on cu.contact_id = c.contact_id and cu.user_id = auth.uid()
join public.organizations o on o.id = c.org_id
where c.status in ('sent', 'signed');

grant select on public.v_portal_contracts to authenticated;
