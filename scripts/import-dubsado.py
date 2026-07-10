#!/usr/bin/env python3
"""Dubsado → expense-tracker importer.

Reads clients.csv + projects_*.csv from a Dubsado export and loads them into
production via the Management API:

  clients            → contacts (email-deduped, source 'dubsado')
  projects (Lead)    → deals in the pipeline's first stage
  projects (Job)     → projects (type from Tags, dates, location, status) and,
                       when money was collected, a ledger-backed historical
                       invoice + payment (same pattern as the client_paid
                       backfill — revenue lands in the books, periods and all)

Idempotent: contacts dedupe by email/name+source; projects/deals skip when a
same-named row exists; historical invoices are keyed by payment reference
'dubsado:<title>'. Run with --dry first.
"""
import csv
import importlib.util
import json
import pathlib
import sys

DATA = pathlib.Path('/Users/aaron/Desktop/dubsado_data')
ROOT = pathlib.Path(__file__).resolve().parent.parent
DRY = '--dry' in sys.argv

spec = importlib.util.spec_from_file_location('md', ROOT / 'scripts' / 'manage-deploy.py')
md = importlib.util.module_from_spec(spec)
spec.loader.exec_module(md)


def sql_json(obj) -> str:
    return json.dumps(obj).replace("'", "''")


def load_clients():
    with open(DATA / 'clients.csv', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        name = f"{r['firstName'].strip()} {r['lastName'].strip()}".strip()
        if not name:
            continue
        out.append({
            'name': name,
            'email': r['email'].strip().lower() or None,
            'phone': r['phone'].strip() or None,
        })
    return out


def load_projects():
    path = next(DATA.glob('projects_*.csv'))
    with open(path, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        title = r['Project title'].strip()
        if not title:
            continue
        cname = f"{r['Client first name'].strip()} {r['Client last name'].strip()}".strip()
        photographers = [p for p in
                         [r.get('Second Photographer', '').strip(), r.get('Third Photographer', '').strip()]
                         if p]
        loc = ', '.join(x for x in [r['Project location City'].strip(),
                                    r['Project location State'].strip()] if x) \
              or r['Project location Line 1'].strip() or None
        paid = 0.0
        try:
            paid = float((r.get('All invoices paid') or '0').replace(',', '') or 0)
        except ValueError:
            pass
        out.append({
            'title': title,
            'kind': (r['Lead or job'] or 'Job').strip(),
            'status_text': r['Project status'].strip(),
            'archived': (r.get('Archived') or '').strip().lower() == 'yes',
            'type': (r['Tag(s)'] or '').split(',')[0].strip() or None,
            'created': r['Created date'].strip() or None,
            'start': r['Start date'].strip() or None,
            'end': r['End date'].strip() or None,
            'location': loc,
            'source': r['Source'].strip() or None,
            'contact_name': cname or None,
            'contact_email': (r['Client email'] or '').strip().lower() or None,
            'contact_phone': (r['Client phone'] or '').strip() or None,
            'paid': paid,
            'notes': ('Second/Third photographer: ' + ', '.join(photographers)) if photographers else None,
        })
    return out


clients = load_clients()
projects = load_projects()
jobs = [p for p in projects if p['kind'].lower() == 'job']
leads = [p for p in projects if p['kind'].lower() != 'job']
total_paid = sum(p['paid'] for p in jobs)

print(f"clients: {len(clients)} | jobs: {len(jobs)} | leads: {len(leads)} "
      f"| historical revenue: {total_paid:,.2f}")

if DRY:
    print("dry run — showing 3 samples of each")
    for c in clients[:3]:
        print("  contact:", c)
    for p in projects[:3]:
        print("  project:", {k: v for k, v in p.items() if v})
    sys.exit(0)

# ---------- contacts ----------
CHUNK = 250
imported_contacts = 0
for i in range(0, len(clients), CHUNK):
    chunk = clients[i:i + CHUNK]
    md.query(f"""
do $$
declare
  v_org uuid;
  r jsonb;
begin
  select id into v_org from public.organizations order by created_at limit 1;
  for r in select * from jsonb_array_elements('{sql_json(chunk)}'::jsonb) loop
    if not exists (
      select 1 from public.contacts c
      where c.org_id = v_org
        and ((r->>'email' is not null and lower(coalesce(c.email,'')) = r->>'email')
             or (r->>'email' is null and lower(c.name) = lower(r->>'name')))
    ) then
      insert into public.contacts (org_id, type, lifecycle, name, email, phone, source)
      values (v_org, 'person', 'lead', r->>'name', r->>'email', r->>'phone', 'dubsado');
    end if;
  end loop;
end $$;
""")
    imported_contacts += len(chunk)
    print(f"  contacts processed: {imported_contacts}/{len(clients)}")

# ---------- projects + leads + historical money ----------
for i in range(0, len(projects), 50):
    chunk = projects[i:i + 50]
    md.query(f"""
do $$
declare
  v_org uuid;
  r jsonb;
  v_contact uuid;
  v_project uuid;
  v_invoice uuid;
  v_payment uuid;
  v_je uuid;
  v_cash uuid;
  v_rev uuid;
  v_start date;
  v_date date;
  v_paid numeric(14,2);
begin
  select id into v_org from public.organizations order by created_at limit 1;
  select id into v_cash from public.accounts where org_id = v_org and code = '1000';
  select id into v_rev  from public.accounts where org_id = v_org and code = '4100';

  for r in select * from jsonb_array_elements('{sql_json(chunk)}'::jsonb) loop
    -- contact: email match, then name match, then create
    v_contact := null;
    if r->>'contact_email' is not null then
      select id into v_contact from public.contacts
        where org_id = v_org and lower(coalesce(email,'')) = r->>'contact_email' limit 1;
    end if;
    if v_contact is null and r->>'contact_name' is not null then
      select id into v_contact from public.contacts
        where org_id = v_org and lower(name) = lower(r->>'contact_name') limit 1;
    end if;
    if v_contact is null and coalesce(r->>'contact_name', r->>'contact_email') is not null then
      insert into public.contacts (org_id, type, lifecycle, name, email, phone, source)
      values (v_org, 'person', 'lead',
              coalesce(r->>'contact_name', r->>'contact_email'),
              r->>'contact_email', r->>'contact_phone', 'dubsado')
      returning id into v_contact;
    end if;

    if lower(r->>'kind') <> 'job' then
      -- LEAD → deal (open unless archived)
      if v_contact is not null and not exists (
        select 1 from public.deals where org_id = v_org and title = r->>'title'
      ) then
        insert into public.deals (org_id, contact_id, title, status, expected_date, source, notes)
        values (v_org, v_contact, r->>'title',
                case when (r->>'archived')::boolean then 'lost'::deal_status else 'open'::deal_status end,
                nullif(r->>'start','')::date, coalesce(r->>'source','dubsado'), r->>'notes');
      end if;
      continue;
    end if;

    -- JOB → project
    if exists (select 1 from public.projects where org_id = v_org and name = r->>'title') then
      continue;
    end if;
    v_start := coalesce(nullif(r->>'start','')::date, nullif(r->>'created','')::date, current_date);
    insert into public.projects
      (org_id, name, contact_id, client, project_type, status, start_date, end_date,
       location, description)
    values
      (v_org, r->>'title', v_contact,
       (select name from public.contacts where id = v_contact),
       r->>'type',
       case
         when (r->>'archived')::boolean then 'archived'::project_status
         when nullif(r->>'end','')::date < current_date then 'completed'::project_status
         else 'active'::project_status
       end,
       v_start, nullif(r->>'end','')::date, r->>'location',
       trim(both E'\\n' from coalesce('[dubsado import] ' || coalesce(r->>'status_text','') , '')
            || coalesce(E'\\n' || (r->>'notes'), '')))
    returning id into v_project;

    if v_contact is not null then
      update public.contacts set lifecycle = 'client'
        where id = v_contact and lifecycle = 'lead';
    end if;

    -- historical money → ledger-backed invoice + payment
    v_paid := coalesce((r->>'paid')::numeric, 0);
    if v_paid > 0 and v_contact is not null
       and not exists (select 1 from public.payments
                       where reference = 'dubsado:' || (r->>'title')) then
      v_date := coalesce(nullif(r->>'end','')::date, v_start);
      perform set_config('app.invoice_rpc', 'on', true);
      perform set_config('app.payment_rpc', 'on', true);

      insert into public.invoices
        (org_id, contact_id, project_id, status, issue_date, due_date, sent_at, memo)
      values
        (v_org, v_contact, v_project, 'paid', v_date, v_date, now(),
         'Dubsado import — historical payments')
      returning id into v_invoice;

      insert into public.invoice_lines (org_id, invoice_id, description, qty, unit_price, line_number)
      values (v_org, v_invoice, 'Historical payments (Dubsado) — ' || (r->>'title'), 1, v_paid, 1);

      v_payment := gen_random_uuid();
      insert into public.journal_entries
        (entry_date, memo, source_type, source_id, project_id, posted, posted_at, org_id)
      values (v_date, 'Dubsado import — ' || (r->>'title'), 'payment', v_payment, v_project,
              true, now(), v_org)
      returning id into v_je;

      insert into public.journal_lines
        (journal_entry_id, account_id, debit, credit, description, project_id, line_number, org_id)
      values
        (v_je, v_cash, v_paid, 0, 'Dubsado historical payments', v_project, 1, v_org),
        (v_je, v_rev,  0, v_paid, 'Dubsado historical payments', v_project, 2, v_org);

      insert into public.payments
        (id, org_id, invoice_id, payment_date, amount, method, reference, journal_entry_id)
      values
        (v_payment, v_org, v_invoice, v_date, v_paid, 'legacy', 'dubsado:' || (r->>'title'), v_je);

      perform set_config('app.invoice_rpc', '', true);
      perform set_config('app.payment_rpc', '', true);
    end if;
  end loop;
end $$;
""")
    print(f"  projects processed: {min(i + 50, len(projects))}/{len(projects)}")

# ---------- verify ----------
rows = md.query("""
select
  (select count(*) from contacts where source like 'dubsado%') as dubsado_contacts,
  (select count(*) from projects where description like '[dubsado import]%') as dubsado_projects,
  (select count(*) from deals where source in ('dubsado') or notes like '%dubsado%'
     or id in (select d.id from deals d join contacts c on c.id = d.contact_id where c.source='dubsado')) as related_deals,
  (select count(*) from payments where reference like 'dubsado:%') as historical_payments,
  (select coalesce(sum(amount),0) from payments where reference like 'dubsado:%') as historical_revenue,
  (select sum(debit) = sum(credit) from journal_lines) as ledger_balanced
""")
print("import result:", json.dumps(rows[0], indent=1))
