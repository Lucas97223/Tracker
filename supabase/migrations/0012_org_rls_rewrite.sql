-- Phase 0.5, step 2: org-scoped RLS everywhere + view security fixes +
-- org-aware ledger triggers.
--
--   1. Every pre-existing policy is rewritten as org-membership + org role.
--      Effective access is unchanged for the single-org case:
--        owner/admin ≙ legacy admin, member ≙ legacy editor, viewer ≙ viewer.
--      Contractors (new) see no financial data at all (I6; task scoping
--      arrives in Phase 2).
--   2. All 8 views get security_invoker = true. Without it they execute as
--      their owner and BYPASS row-level security — verified locally: an
--      is_active=false user could read every rollup. Each view also gains a
--      trailing org_id column.
--   3. Ledger/category triggers become org-aware (account lookups scoped by
--      org, not global code), fixing in passing the ambiguous-parent_id bug
--      (42702) that has made category creation fail since 0007.
--   4. log_audit() stamps org_id itself (nullable on audit_log; audit writes
--      must never abort the audited operation).
--   5. provision_org() seeds a Chart of Accounts + default categories for new
--      orgs; an AFTER INSERT trigger provisions and makes the creator owner.
--   6. Legacy profiles.role stays the Admin-page control surface; a mirror
--      trigger keeps the default org's org_members.role in sync so the two
--      role systems cannot drift for single-org users.

-- ---------- 1. policy rewrite ----------

-- profiles: "admin" now means an owner/admin of an org the target user shares.
create or replace function public.shares_org_as_admin(p_target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_user() and exists (
    select 1
    from public.org_members me
    join public.org_members them on them.org_id = me.org_id
    where me.user_id = auth.uid()
      and me.role in ('owner', 'admin')
      and them.user_id = p_target
  );
$$;

drop policy if exists profiles_select_self_or_admin on public.profiles;
create policy profiles_select_self_or_admin on public.profiles
  for select using (auth.uid() = id or public.shares_org_as_admin(id));

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update using (public.shares_org_as_admin(id))
  with check (public.shares_org_as_admin(id));

-- (profiles_update_self_name from 0002 is unchanged and still applies.)

-- years / projects / expenses: read for financial viewers, write for editors.
drop policy if exists years_select_active on public.years;
create policy years_select_active on public.years
  for select using (public.org_can_view_financials(org_id));
drop policy if exists years_modify_editor on public.years;
create policy years_modify_editor on public.years
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists projects_select_active on public.projects;
create policy projects_select_active on public.projects
  for select using (public.org_can_view_financials(org_id));
drop policy if exists projects_modify_editor on public.projects;
create policy projects_modify_editor on public.projects
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists expenses_select_active on public.expenses;
create policy expenses_select_active on public.expenses
  for select using (public.org_can_view_financials(org_id));
drop policy if exists expenses_modify_editor on public.expenses;
create policy expenses_modify_editor on public.expenses
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

-- categories: read for financial viewers; admin-managed.
drop policy if exists categories_select_active on public.categories;
create policy categories_select_active on public.categories
  for select using (public.org_can_view_financials(org_id));
drop policy if exists categories_modify_admin on public.categories;
create policy categories_modify_admin on public.categories
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

-- accounts
drop policy if exists accounts_select_active on public.accounts;
create policy accounts_select_active on public.accounts
  for select using (public.org_can_view_financials(org_id));
drop policy if exists accounts_modify_admin on public.accounts;
create policy accounts_modify_admin on public.accounts
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

-- journal_entries
drop policy if exists je_select_active on public.journal_entries;
create policy je_select_active on public.journal_entries
  for select using (public.org_can_view_financials(org_id));
drop policy if exists je_insert_editor on public.journal_entries;
create policy je_insert_editor on public.journal_entries
  for insert with check (public.org_can_edit(org_id));
drop policy if exists je_update_editor on public.journal_entries;
create policy je_update_editor on public.journal_entries
  for update using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));
drop policy if exists je_delete_admin on public.journal_entries;
create policy je_delete_admin on public.journal_entries
  for delete using (public.org_is_admin(org_id));

-- journal_lines
drop policy if exists jl_select_active on public.journal_lines;
create policy jl_select_active on public.journal_lines
  for select using (public.org_can_view_financials(org_id));
drop policy if exists jl_insert_editor on public.journal_lines;
create policy jl_insert_editor on public.journal_lines
  for insert with check (public.org_can_edit(org_id));
drop policy if exists jl_update_admin on public.journal_lines;
create policy jl_update_admin on public.journal_lines
  for update using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));
drop policy if exists jl_delete_admin on public.journal_lines;
create policy jl_delete_admin on public.journal_lines
  for delete using (public.org_is_admin(org_id));

-- accounting_periods
drop policy if exists periods_select_active on public.accounting_periods;
create policy periods_select_active on public.accounting_periods
  for select using (public.org_can_view_financials(org_id));
drop policy if exists periods_modify_admin on public.accounting_periods;
create policy periods_modify_admin on public.accounting_periods
  for all using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));

-- expense_journal_map
drop policy if exists ejm_select_active on public.expense_journal_map;
create policy ejm_select_active on public.expense_journal_map
  for select using (public.org_can_view_financials(org_id));
drop policy if exists ejm_insert_editor on public.expense_journal_map;
create policy ejm_insert_editor on public.expense_journal_map
  for insert with check (public.org_can_edit(org_id));
drop policy if exists ejm_modify_admin on public.expense_journal_map;
create policy ejm_modify_admin on public.expense_journal_map
  for update using (public.org_is_admin(org_id)) with check (public.org_is_admin(org_id));
drop policy if exists ejm_delete_admin on public.expense_journal_map;
create policy ejm_delete_admin on public.expense_journal_map
  for delete using (public.org_is_admin(org_id));

-- audit_log: org admins read their org's trail; rows without an org (rare,
-- system-context writes) stay invisible to the API.
drop policy if exists audit_select_admin on public.audit_log;
create policy audit_select_admin on public.audit_log
  for select using (org_id is not null and public.org_is_admin(org_id));

-- ---------- 2. views: security_invoker + org_id ----------

create or replace view public.v_year_rollup as
select
  y.id            as year_id,
  y.year_value,
  y.label,
  coalesce(sum(e.amount), 0)::numeric(14,2)  as total_amount,
  count(distinct p.id)                       as project_count,
  count(e.id)                                as expense_count,
  y.org_id
from public.years y
left join public.projects p on p.year_id = y.id
left join public.expenses e on e.project_id = p.id
group by y.id, y.year_value, y.label, y.org_id
order by y.year_value desc;

create or replace view public.v_project_rollup as
select
  p.id            as project_id,
  p.year_id,
  p.name,
  p.status,
  coalesce(sum(e.amount), 0)::numeric(14,2)  as total_amount,
  count(e.id)                                as expense_count,
  p.org_id
from public.projects p
left join public.expenses e on e.project_id = p.id
group by p.id, p.year_id, p.name, p.status, p.org_id;

create or replace view public.v_category_rollup as
select
  c.id            as category_id,
  c.name,
  c.color,
  coalesce(sum(e.amount), 0)::numeric(14,2)  as total_amount,
  count(e.id)                                as expense_count,
  c.org_id
from public.categories c
left join public.expenses e on e.category_id = c.id
group by c.id, c.name, c.color, c.org_id;

create or replace view public.v_location_rollup as
select
  coalesce(nullif(trim(e.location), ''), nullif(trim(p.location), ''), 'Unspecified') as location,
  sum(e.amount)::numeric(14,2)              as total_amount,
  count(*)                                  as expense_count,
  e.org_id
from public.expenses e
join public.projects p on p.id = e.project_id
group by 1, e.org_id
order by total_amount desc;

create or replace view public.v_monthly_rollup as
select
  date_trunc('month', e.expense_date)::date  as month,
  sum(e.amount)::numeric(14,2)               as total_amount,
  count(*)                                   as expense_count,
  e.org_id
from public.expenses e
group by 1, e.org_id
order by 1;

create or replace view public.v_trial_balance as
select
  a.id            as account_id,
  a.code,
  a.name,
  a.type,
  a.normal_balance,
  coalesce(sum(jl.debit), 0)::numeric(14,2)  as total_debit,
  coalesce(sum(jl.credit), 0)::numeric(14,2) as total_credit,
  case a.normal_balance
    when 'debit'  then coalesce(sum(jl.debit), 0) - coalesce(sum(jl.credit), 0)
    when 'credit' then coalesce(sum(jl.credit), 0) - coalesce(sum(jl.debit), 0)
  end::numeric(14,2) as balance,
  a.org_id
from public.accounts a
left join public.journal_lines jl on jl.account_id = a.id
left join public.journal_entries je on je.id = jl.journal_entry_id and je.posted = true
group by a.id, a.code, a.name, a.type, a.normal_balance, a.org_id;

create or replace view public.v_account_ledger as
select
  jl.id                as line_id,
  jl.account_id,
  a.code               as account_code,
  a.name               as account_name,
  a.normal_balance,
  je.id                as entry_id,
  je.entry_date,
  je.reference,
  je.memo,
  je.source_type,
  je.source_id,
  je.project_id,
  jl.description,
  jl.debit,
  jl.credit,
  case a.normal_balance
    when 'debit'  then sum(jl.debit - jl.credit) over (
                         partition by jl.account_id
                         order by je.entry_date, je.id, jl.line_number
                         rows between unbounded preceding and current row)
    when 'credit' then sum(jl.credit - jl.debit) over (
                         partition by jl.account_id
                         order by je.entry_date, je.id, jl.line_number
                         rows between unbounded preceding and current row)
  end::numeric(14,2) as running_balance,
  jl.line_number,
  a.org_id
from public.journal_lines jl
join public.journal_entries je on je.id = jl.journal_entry_id
join public.accounts a on a.id = jl.account_id
where je.posted = true;

create or replace view public.v_project_pnl as
select
  p.id                                                      as project_id,
  p.name                                                    as project_name,
  p.year_id,
  coalesce(sum(case when a.type = 'revenue' then jl.credit - jl.debit else 0 end), 0)::numeric(14,2) as revenue,
  coalesce(sum(case when a.type = 'cogs'    then jl.debit  - jl.credit else 0 end), 0)::numeric(14,2) as cogs,
  coalesce(sum(case when a.type = 'expense' then jl.debit  - jl.credit else 0 end), 0)::numeric(14,2) as expense,
  coalesce(sum(case when a.type = 'revenue' then jl.credit - jl.debit
                    when a.type in ('expense','cogs') then -(jl.debit - jl.credit)
                    else 0 end), 0)::numeric(14,2) as net_margin,
  p.org_id
from public.projects p
left join public.journal_lines jl on jl.project_id = p.id
left join public.journal_entries je on je.id = jl.journal_entry_id and je.posted = true
left join public.accounts a on a.id = jl.account_id
group by p.id, p.name, p.year_id, p.org_id;

alter view public.v_year_rollup     set (security_invoker = true);
alter view public.v_project_rollup  set (security_invoker = true);
alter view public.v_category_rollup set (security_invoker = true);
alter view public.v_location_rollup set (security_invoker = true);
alter view public.v_monthly_rollup  set (security_invoker = true);
alter view public.v_trial_balance   set (security_invoker = true);
alter view public.v_account_ledger  set (security_invoker = true);
alter view public.v_project_pnl     set (security_invoker = true);

-- ---------- 3. org-aware ledger & category triggers ----------

-- Fixes the 42702 ambiguity (variables now v_-prefixed) and scopes account
-- lookup + code allocation to the category's org.
create or replace function public.create_account_for_category()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org       uuid;
  v_parent_id uuid;
  v_last_code int;
begin
  if NEW.account_id is not null then
    return NEW;
  end if;

  -- BEFORE-trigger firing order is alphabetical; don't rely on the set_org
  -- trigger having run first.
  v_org := coalesce(NEW.org_id, public.default_org_id());
  if v_org is null then
    raise exception 'No organization context for category %', NEW.name
      using errcode = 'check_violation';
  end if;
  NEW.org_id := v_org;

  select a.id into v_parent_id
    from public.accounts a
    where a.code = '6000' and a.org_id = v_org
    limit 1;

  select coalesce(max((a.code)::int), 6099) + 1
    into v_last_code
    from public.accounts a
    where a.org_id = v_org and a.code ~ '^6[1-9][0-9]{2}$';

  insert into public.accounts
    (code, name, type, normal_balance, parent_id, is_active, description, org_id)
  values
    (v_last_code::text, NEW.name, 'expense', 'debit', v_parent_id,
     not NEW.is_archived, NEW.description, v_org)
  returning id into NEW.account_id;

  return NEW;
end $$;

create or replace function public.expense_insert_to_journal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cash_id              uuid;
  expense_account_id   uuid;
  je_id                uuid;
begin
  -- $0 expenses have no ledger effect (0/0 lines are forbidden by design).
  if NEW.amount = 0 then
    return NEW;
  end if;

  select id into cash_id from public.accounts
    where code = '1000' and org_id = NEW.org_id limit 1;
  if cash_id is null then
    raise exception 'Cash account (1000) is missing for org %.', NEW.org_id;
  end if;

  select account_id into expense_account_id
    from public.categories where id = NEW.category_id;
  if expense_account_id is null then
    raise exception 'Category % has no linked account.', NEW.category_id;
  end if;

  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
  values
    (NEW.expense_date, NEW.description, 'expense', NEW.id, NEW.project_id, NEW.created_by, true, now(), NEW.org_id)
  returning id into je_id;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number, org_id)
  values
    (je_id, expense_account_id, NEW.amount, 0, NEW.description, NEW.project_id, NEW.category_id, 1, NEW.org_id),
    (je_id, cash_id,             0, NEW.amount, NEW.description, NEW.project_id, NEW.category_id, 2, NEW.org_id);

  insert into public.expense_journal_map (expense_id, journal_entry_id, org_id)
  values (NEW.id, je_id, NEW.org_id);

  return NEW;
end $$;

create or replace function public.expense_update_to_journal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_je_id            uuid;
  rev_je_id            uuid;
  new_je_id            uuid;
  cash_id              uuid;
  old_expense_acct     uuid;
  new_expense_acct     uuid;
begin
  if NEW.amount = OLD.amount
     and NEW.expense_date = OLD.expense_date
     and NEW.category_id = OLD.category_id
     and NEW.project_id is not distinct from OLD.project_id
     and NEW.description = OLD.description then
    return NEW;
  end if;

  select id into cash_id from public.accounts
    where code = '1000' and org_id = NEW.org_id limit 1;
  select account_id into old_expense_acct from public.categories where id = OLD.category_id;
  select account_id into new_expense_acct from public.categories where id = NEW.category_id;
  select journal_entry_id into old_je_id from public.expense_journal_map where expense_id = NEW.id;

  if old_je_id is not null then
    insert into public.journal_entries
      (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
    values
      (current_date, 'Reversal of edited expense', 'reversal', NEW.id, OLD.project_id,
       NEW.created_by, true, now(), NEW.org_id)
    returning id into rev_je_id;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number, org_id)
    values
      (rev_je_id, cash_id,          OLD.amount, 0, 'Reversal', OLD.project_id, OLD.category_id, 1, NEW.org_id),
      (rev_je_id, old_expense_acct, 0, OLD.amount, 'Reversal', OLD.project_id, OLD.category_id, 2, NEW.org_id);

    update public.journal_entries set reversed_by = rev_je_id where id = old_je_id;
  end if;

  -- Post the new entry — unless the new amount is zero (no ledger effect).
  if NEW.amount <> 0 then
    insert into public.journal_entries
      (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
    values
      (NEW.expense_date, NEW.description, 'expense', NEW.id, NEW.project_id,
       NEW.created_by, true, now(), NEW.org_id)
    returning id into new_je_id;

    insert into public.journal_lines
      (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number, org_id)
    values
      (new_je_id, new_expense_acct, NEW.amount, 0, NEW.description, NEW.project_id, NEW.category_id, 1, NEW.org_id),
      (new_je_id, cash_id,          0, NEW.amount, NEW.description, NEW.project_id, NEW.category_id, 2, NEW.org_id);

    -- Upsert: a $0-born expense has no map row yet.
    insert into public.expense_journal_map (expense_id, journal_entry_id, org_id)
    values (NEW.id, new_je_id, NEW.org_id)
    on conflict (expense_id)
      do update set journal_entry_id = excluded.journal_entry_id, created_at = now();
  else
    -- Edited down to $0: the reversal above cleared the books; drop the link.
    delete from public.expense_journal_map where expense_id = NEW.id;
  end if;

  return NEW;
end $$;

create or replace function public.expense_delete_to_journal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  old_je_id          uuid;
  rev_je_id          uuid;
  cash_id            uuid;
  old_expense_acct   uuid;
begin
  select journal_entry_id into old_je_id from public.expense_journal_map where expense_id = OLD.id;
  if old_je_id is null then return OLD; end if;

  select id into cash_id from public.accounts
    where code = '1000' and org_id = OLD.org_id limit 1;
  select account_id into old_expense_acct from public.categories where id = OLD.category_id;

  insert into public.journal_entries
    (entry_date, memo, source_type, source_id, project_id, created_by, posted, posted_at, org_id)
  values
    (current_date, 'Reversal of deleted expense', 'reversal', OLD.id, OLD.project_id,
     OLD.created_by, true, now(), OLD.org_id)
  returning id into rev_je_id;

  insert into public.journal_lines
    (journal_entry_id, account_id, debit, credit, description, project_id, category_id, line_number, org_id)
  values
    (rev_je_id, cash_id,          OLD.amount, 0, 'Reversal of delete', OLD.project_id, OLD.category_id, 1, OLD.org_id),
    (rev_je_id, old_expense_acct, 0, OLD.amount, 'Reversal of delete', OLD.project_id, OLD.category_id, 2, OLD.org_id);

  update public.journal_entries set reversed_by = rev_je_id where id = old_je_id;
  return OLD;
end $$;

-- Photographer-pay sync: org-scope the category lookup. (This trigger is
-- replaced wholesale by the draft pay_items flow in 0014.)
create or replace function public.sync_project_photographer_pay()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  pay_category_id uuid;
  ph_name text;
  to_add text[];
begin
  select id into pay_category_id
    from public.categories
    where name ilike 'photographer pay'
      and is_archived = false
      and org_id = NEW.org_id
    limit 1;
  if pay_category_id is null then return NEW; end if;

  if TG_OP = 'INSERT' then
    to_add := NEW.photographers;
  else
    to_add := array(
      select unnest(coalesce(NEW.photographers, '{}'::text[]))
      except
      select unnest(coalesce(OLD.photographers, '{}'::text[]))
    );
  end if;

  if to_add is null or array_length(to_add, 1) is null then return NEW; end if;

  foreach ph_name in array to_add loop
    perform 1 from public.expenses
      where project_id = NEW.id
        and category_id = pay_category_id
        and (
          person_name = ph_name
          or (person_name is null and lower(description) = lower(ph_name))
        );
    if not found then
      insert into public.expenses
        (project_id, category_id, description, amount, expense_date,
         location, person_name, created_by, org_id)
      values
        (NEW.id, pay_category_id, ph_name, 0,
         coalesce(NEW.start_date, current_date),
         NEW.location, ph_name, NEW.created_by, NEW.org_id);
    end if;
  end loop;

  return NEW;
end $$;

-- Posted-entry immutability must also cover the new org dimension.
create or replace function public.enforce_journal_immutability()
returns trigger language plpgsql as $$
begin
  if OLD.posted = true then
    if NEW.entry_date is distinct from OLD.entry_date
       or NEW.reference is distinct from OLD.reference
       or NEW.memo is distinct from OLD.memo
       or NEW.source_type is distinct from OLD.source_type
       or NEW.source_id is distinct from OLD.source_id
       or NEW.project_id is distinct from OLD.project_id
       or NEW.posted is distinct from OLD.posted
       or NEW.created_by is distinct from OLD.created_by
       or NEW.org_id is distinct from OLD.org_id then
      raise exception 'Posted journal entry % is immutable; create a reversal instead', OLD.id
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end $$;

-- ---------- 4. audit rows carry their org ----------

create or replace function public.log_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  entity audit_entity;
  diff jsonb := '{}'::jsonb;
  eid uuid;
  v_row jsonb;
  v_org uuid;
begin
  entity := tg_argv[0]::audit_entity;
  v_row := to_jsonb(coalesce(new, old));
  eid := (v_row->>'id')::uuid;

  -- Org resolution: the row's own org, else (for profiles) the profile's
  -- default org, else the acting user's default org. Never abort on null.
  v_org := coalesce(
    (v_row->>'org_id')::uuid,
    (v_row->>'default_org_id')::uuid,
    public.default_org_id()
  );

  if tg_op = 'INSERT' then
    diff := jsonb_build_object('new', to_jsonb(new));
    insert into public.audit_log (user_id, action, entity_type, entity_id, changes, org_id)
      values (auth.uid(), 'create', entity, eid, diff, v_org);
    return new;
  elsif tg_op = 'UPDATE' then
    diff := jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new));
    insert into public.audit_log (user_id, action, entity_type, entity_id, changes, org_id)
      values (auth.uid(), 'update', entity, eid, diff, v_org);
    return new;
  elsif tg_op = 'DELETE' then
    diff := jsonb_build_object('deleted', to_jsonb(old));
    insert into public.audit_log (user_id, action, entity_type, entity_id, changes, org_id)
      values (auth.uid(), 'delete', entity, eid, diff, v_org);
    return old;
  end if;
  return null;
end $$;

-- ---------- 5. org provisioning ----------

create or replace function public.provision_org(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  -- Chart of Accounts (mirrors the 0007 seed, plus 5100 Team Pay for the
  -- draft-pay flow; 1200/1500/5000 start inactive as before).
  insert into public.accounts (code, name, type, normal_balance, is_system, is_active, description, org_id)
  select code, name, type::account_type, nb::balance_side, sys, act, descr, p_org
  from (values
    ('1000', 'Cash',                        'asset',     'debit',  true,  true,  'Operating cash account'),
    ('1100', 'Accounts Receivable',         'asset',     'debit',  true,  true,  'Amounts owed to us by customers'),
    ('1200', 'Inventory',                   'asset',     'debit',  false, false, 'Goods held for sale'),
    ('1500', 'Fixed Assets',                'asset',     'debit',  false, false, 'Equipment, furniture, vehicles'),
    ('2000', 'Accounts Payable',            'liability', 'credit', true,  true,  'Amounts we owe to vendors and team'),
    ('2100', 'Accrued Liabilities',         'liability', 'credit', false, true,  'Expenses incurred but not yet paid'),
    ('2200', 'Sales Tax Payable',           'liability', 'credit', false, true,  'Sales tax collected pending remittance'),
    ('3000', 'Owner''s Equity',             'equity',    'credit', true,  true,  'Contributed capital'),
    ('3100', 'Retained Earnings',           'equity',    'credit', true,  true,  'Cumulative net income retained'),
    ('4000', 'Sales Revenue',               'revenue',   'credit', false, true,  'Income from product sales'),
    ('4100', 'Service Revenue',             'revenue',   'credit', false, true,  'Income from services rendered'),
    ('4900', 'Other Income',                'revenue',   'credit', false, true,  'Miscellaneous income'),
    ('5000', 'Cost of Goods Sold',          'cogs',      'debit',  false, false, 'Direct costs of goods sold'),
    ('5100', 'Team Pay',                    'cogs',      'debit',  true,  true,  'Direct labor: photographers, contractors, crew'),
    ('6000', 'Operating Expenses',          'expense',   'debit',  true,  true,  'Parent for category-level expense accounts'),
    ('7000', 'Payroll Expense',             'expense',   'debit',  false, true,  'Wages, salaries, payroll taxes'),
    ('8000', 'Other Expenses',              'expense',   'debit',  false, true,  'Miscellaneous expenses'),
    ('9000', 'Depreciation & Amortization', 'expense',   'debit',  false, true,  'Non-cash periodic charges')
  ) as t(code, name, type, nb, sys, act, descr)
  on conflict do nothing;

  -- Default categories; the BEFORE INSERT trigger creates each one's account.
  insert into public.categories (name, color, description, org_id)
  select name, color, descr, p_org
  from (values
    ('Travel',            '#3b82f6', 'Flights, trains, intercity travel'),
    ('Transportation',    '#06b6d4', 'Local transit, taxis, rentals, fuel'),
    ('Accommodation',     '#8b5cf6', 'Hotels, lodging, short-term rentals'),
    ('Photographer Pay',  '#ec4899', 'Fees paid to photographers/talent'),
    ('Equipment Rental',  '#f59e0b', 'Cameras, lighting, AV, props'),
    ('Catering',          '#10b981', 'Food and drink during shoots/events'),
    ('Software',          '#a855f7', 'Subscriptions and licenses'),
    ('Marketing',         '#ef4444', 'Ads, paid promotion'),
    ('Misc',              '#64748b', 'Everything else')
  ) as t(name, color, descr)
  on conflict do nothing;
end $$;

-- New orgs: creator becomes owner (when created through the API) and the org
-- is provisioned with CoA + categories.
create or replace function public.handle_new_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    insert into public.org_members (org_id, user_id, role)
    values (NEW.id, auth.uid(), 'owner')
    on conflict do nothing;

    update public.profiles set default_org_id = NEW.id
      where id = auth.uid() and default_org_id is null;
  end if;

  perform public.provision_org(NEW.id);
  return NEW;
end $$;

drop trigger if exists organizations_provision on public.organizations;
create trigger organizations_provision
  after insert on public.organizations
  for each row execute procedure public.handle_new_org();

-- The default org predates provision_org: give it the one account it lacks.
do $$
declare
  v_org uuid;
begin
  for v_org in select id from public.organizations loop
    if not exists (select 1 from public.accounts where org_id = v_org and code = '5100') then
      insert into public.accounts (code, name, type, normal_balance, is_system, is_active, description, org_id)
      values ('5100', 'Team Pay', 'cogs', 'debit', true, true,
              'Direct labor: photographers, contractors, crew', v_org);
    end if;
  end loop;
end $$;

-- ---------- 6. keep legacy profiles.role and org role in lockstep ----------

-- The Admin page still manages profiles.role; mirror changes into the user's
-- default-org membership so the two role systems can't drift. (Owners are
-- never demoted by the mirror.)
create or replace function public.mirror_profile_role_to_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_new org_role;
begin
  if NEW.role is distinct from OLD.role and NEW.default_org_id is not null then
    v_new := case NEW.role
      when 'admin'  then 'admin'::org_role
      when 'editor' then 'member'::org_role
      else 'viewer'::org_role
    end;
    update public.org_members
      set role = v_new
      where org_id = NEW.default_org_id
        and user_id = NEW.id
        and role <> 'owner';
  end if;
  return NEW;
end $$;

drop trigger if exists profiles_mirror_org_role on public.profiles;
create trigger profiles_mirror_org_role
  after update on public.profiles
  for each row execute procedure public.mirror_profile_role_to_org();

-- ---------- realtime publication (live platform only) ----------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.organizations;
    exception when duplicate_object then null; end;
    begin
      alter publication supabase_realtime add table public.org_members;
    exception when duplicate_object then null; end;
  end if;
end $$;
