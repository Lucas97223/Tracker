-- Phase 4, step 3: the contact activity timeline, duplicate merge, and
-- universal search.

alter type audit_entity add value if not exists 'contact_merge';

-- ---------- activity timeline ----------

-- Everything that happened around a contact, newest first. Each source keeps
-- its own RLS (security_invoker), so the timeline shows exactly what the
-- caller may know.
create or replace view public.v_contact_activity as
select d.contact_id, d.org_id, d.created_at as happened_at,
       'deal_created'::text as kind, d.title as summary, d.id as ref_id
from public.deals d
union all
select d.contact_id, d.org_id, d.won_at, 'deal_won', d.title, d.id
from public.deals d where d.won_at is not null
union all
select d.contact_id, d.org_id, d.lost_at, 'deal_lost', d.title, d.id
from public.deals d where d.lost_at is not null
union all
select i.contact_id, i.org_id, coalesce(i.sent_at, i.created_at),
       case when i.sent_at is null then 'invoice_created' else 'invoice_sent' end,
       'Invoice #' || i.number, i.id
from public.invoices i where i.status <> 'void'
union all
select i.contact_id, i.org_id, p.created_at, 'payment_received',
       'Payment on invoice #' || i.number, p.id
from public.payments p join public.invoices i on i.id = p.invoice_id
where p.voided_at is null
union all
select pr.contact_id, pr.org_id, pr.created_at, 'project_created', pr.name, pr.id
from public.projects pr where pr.contact_id is not null
union all
select fr.contact_id, fr.org_id, fr.created_at, 'form_response',
       (select f.name from public.forms f where f.id = fr.form_id), fr.id
from public.form_responses fr where fr.contact_id is not null;

alter view public.v_contact_activity set (security_invoker = true);
grant select on public.v_contact_activity to authenticated;

-- ---------- duplicate merge ----------

-- Repoints every reference from the duplicate onto the keeper, fills gaps in
-- the keeper's fields, then archives the duplicate (kept for audit).
create or replace function public.merge_contacts(p_keep uuid, p_dupe uuid)
returns public.contacts language plpgsql security definer set search_path = public as $$
declare
  keep public.contacts;
  dupe public.contacts;
begin
  if p_keep = p_dupe then
    raise exception 'Pick two different contacts';
  end if;
  select * into keep from public.contacts where id = p_keep for update;
  select * into dupe from public.contacts where id = p_dupe for update;
  if keep.id is null or dupe.id is null then
    raise exception 'Contact not found';
  end if;
  if keep.org_id <> dupe.org_id then
    raise exception 'Contacts belong to different organizations' using errcode = 'check_violation';
  end if;
  if not public.org_is_admin(keep.org_id) then
    raise exception 'Only an organization owner/admin can merge contacts';
  end if;

  update public.projects       set contact_id = p_keep where contact_id = p_dupe;
  -- invoice headers are frozen after draft; this is a data-hygiene merge, so
  -- lift the guard for the transaction.
  perform set_config('app.invoice_rpc', 'on', true);
  update public.invoices       set contact_id = p_keep where contact_id = p_dupe;
  perform set_config('app.invoice_rpc', '', true);
  update public.deals          set contact_id = p_keep where contact_id = p_dupe;
  update public.credit_notes   set contact_id = p_keep where contact_id = p_dupe;
  update public.form_responses set contact_id = p_keep where contact_id = p_dupe;

  update public.contacts set
    email   = coalesce(keep.email, dupe.email),
    phone   = coalesce(keep.phone, dupe.phone),
    company = coalesce(keep.company, dupe.company),
    notes   = case
                when dupe.notes is null then keep.notes
                when keep.notes is null then dupe.notes
                else keep.notes || E'\n---merged---\n' || dupe.notes
              end,
    lifecycle = case when 'client' in (keep.lifecycle::text, dupe.lifecycle::text)
                     then 'client'::contact_lifecycle else keep.lifecycle end
    where id = p_keep;

  update public.contacts set
    lifecycle = 'archived',
    notes = coalesce(notes || E'\n', '') || '[merged into ' || keep.name || ' / ' || p_keep || ']'
    where id = p_dupe;

  insert into public.audit_log (user_id, action, entity_type, entity_id, changes, org_id)
  values (auth.uid(), 'update', 'contact_merge', p_keep,
          jsonb_build_object('kept', p_keep, 'merged', p_dupe), keep.org_id);

  select * into keep from public.contacts where id = p_keep;
  return keep;
end $$;

-- ---------- universal search ----------

create index if not exists contacts_fts_idx on public.contacts
  using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(email,'') || ' ' || coalesce(company,'')));
create index if not exists projects_fts_idx on public.projects
  using gin (to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(client,'') || ' ' || coalesce(location,'') || ' ' || coalesce(project_type,'')));
create index if not exists tasks_fts_idx on public.tasks
  using gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(description,'')));
create index if not exists deals_fts_idx on public.deals
  using gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(notes,'')));

-- Runs with the CALLER's rights (not definer): every branch is filtered by
-- the underlying RLS, so cross-org rows can never surface.
create or replace function public.search_all(p_query text, p_limit int default 20)
returns table (
  kind text,
  id uuid,
  title text,
  subtitle text,
  project_id uuid
) language sql stable security invoker set search_path = public as $$
  with q as (
    select websearch_to_tsquery('simple', coalesce(p_query, '')) as tsq
  )
  (
    select 'contact', c.id, c.name, coalesce(c.email, c.company, ''), null::uuid
    from public.contacts c, q
    where to_tsvector('simple', coalesce(c.name,'') || ' ' || coalesce(c.email,'') || ' ' || coalesce(c.company,'')) @@ q.tsq
    limit p_limit
  )
  union all
  (
    select 'project', p.id, p.name, coalesce(p.client, p.location, ''), p.id
    from public.projects p, q
    where to_tsvector('simple', coalesce(p.name,'') || ' ' || coalesce(p.client,'') || ' ' || coalesce(p.location,'') || ' ' || coalesce(p.project_type,'')) @@ q.tsq
    limit p_limit
  )
  union all
  (
    select 'task', t.id, t.title, t.status::text, t.project_id
    from public.tasks t, q
    where to_tsvector('simple', coalesce(t.title,'') || ' ' || coalesce(t.description,'')) @@ q.tsq
    limit p_limit
  )
  union all
  (
    select 'deal', d.id, d.title, d.status::text, d.project_id
    from public.deals d, q
    where to_tsvector('simple', coalesce(d.title,'') || ' ' || coalesce(d.notes,'')) @@ q.tsq
    limit p_limit
  )
  union all
  (
    select 'invoice', i.id, 'Invoice #' || i.number,
           (select c.name from public.contacts c where c.id = i.contact_id),
           i.project_id
    from public.invoices i, q
    where p_query ~ '^#?\d{1,9}$'
      and i.number = (replace(p_query, '#', ''))::int
    limit p_limit
  )
  limit p_limit
$$;

grant execute on function public.search_all(text, int) to authenticated;
