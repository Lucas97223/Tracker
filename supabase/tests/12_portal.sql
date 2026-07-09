-- Client portal isolation: portal logins see exactly their own contact's
-- documents through the portal views, and nothing anywhere else.

\set QUIET on
\pset tuples_only on

select tests.make_user('portal-owner@t.io') as owner_u \gset
select tests.become(:'owner_u');
set role authenticated;

-- Two clients with documents each.
insert into contacts (name, email) values ('Alpha Client', 'alpha@client.io');
insert into contacts (name, email) values ('Beta Client', 'beta@client.io');
insert into projects (name, start_date, contact_id)
  select 'Alpha Shoot', '2027-01-10', id from contacts where name = 'Alpha Client';
insert into invoices (contact_id, project_id)
  select c.id, p.id from contacts c, projects p
  where c.name = 'Alpha Client' and p.name = 'Alpha Shoot';
insert into invoice_lines (invoice_id, description, qty, unit_price, line_number)
  select id, 'Coverage', 1, 1000.00, 1 from invoices;
update invoices set status = 'sent';
insert into projects (name, start_date, contact_id)
  select 'Beta Shoot', '2027-02-01', id from contacts where name = 'Beta Client';
reset role;

-- ---------- portal signup links by email ----------
select tests.make_portal_user('alpha@client.io') as alpha_u \gset

select tests.assert(
  (select is_active = false and role = 'viewer' from profiles where id = :'alpha_u'::uuid),
  'portal profile is inactive staff-side');
select tests.assert(
  (select count(*) = 0 from org_members where user_id = :'alpha_u'::uuid),
  'portal login never joins the org');
select tests.assert(
  (select count(*) = 0 from team_members where profile_id = :'alpha_u'::uuid),
  'portal login never joins the roster');
select tests.assert(
  (select count(*) = 1 from contact_users where user_id = :'alpha_u'::uuid),
  'portal login linked to its contact by email');

-- ---------- portal reads: own documents only, views only ----------
select tests.become(:'alpha_u');
set role authenticated;

select tests.assert(
  (select count(*) = 1 from v_portal_invoices where number is not null),
  'portal sees own invoice');
select tests.assert(
  (select balance = 1000.00 from v_portal_invoices),
  'portal invoice carries totals');
select tests.assert(
  (select count(*) = 1 from v_portal_projects where name = 'Alpha Shoot'),
  'portal sees own project');
select tests.assert(
  (select count(*) = 0 from v_portal_projects where name = 'Beta Shoot'),
  'other clients'' projects invisible');

-- base tables and staff views stay closed
select tests.assert((select count(*) = 0 from invoices),      'portal: base invoices closed');
select tests.assert((select count(*) = 0 from projects),      'portal: base projects closed');
select tests.assert((select count(*) = 0 from expenses),      'portal: expenses closed');
select tests.assert((select count(*) = 0 from v_project_pnl), 'portal: P&L closed');
select tests.assert((select count(*) = 0 from v_ar_aging),    'portal: AR closed');
select tests.assert((select count(*) = 0 from team_members),  'portal: roster closed');
reset role;

-- ---------- staff see nothing through portal views ----------
select tests.become(:'owner_u');
set role authenticated;
select tests.assert(
  (select count(*) = 0 from v_portal_invoices),
  'staff (unlinked) get nothing from portal views');
reset role;

-- ---------- late email: contact gains an email, existing portal login links ----------
select tests.make_portal_user('gamma@client.io') as gamma_u \gset
select tests.assert(
  (select count(*) = 0 from contact_users where user_id = :'gamma_u'::uuid),
  'no contact yet — no links');
select tests.become(:'owner_u');
set role authenticated;
insert into contacts (name, email) values ('Gamma Client', 'gamma@client.io');
reset role;
select tests.assert(
  (select count(*) = 1 from contact_users where user_id = :'gamma_u'::uuid),
  'creating the contact linked the waiting portal login');

select '12_portal: PASS';
