-- Phase 5, step 4: the one-click Win.
--
-- Client accepts a proposal → in ONE database transaction: project (with the
-- proposal's task template applied), contract ready to sign, deposit invoice
-- (sent), deal marked won, contact promoted to client. Idempotent: the
-- proposal's win-artifact columns are the receipt; calling again returns the
-- same references. unwin_proposal() compensates (refused once real money has
-- been recorded on the deposit invoice).
--
-- Spec note: §7 sketched this as an Edge Function; a security-definer RPC
-- delivers the same single-transaction guarantee with no extra runtime, which
-- matches every other money path in this codebase (I7). Deviation for the
-- gate summary.

-- Template application without a caller check, for use inside the win flow
-- (which may run from an anonymous acceptance). The public wrapper keeps its
-- permission check.
create or replace function public.apply_task_template_internal(p_template uuid, p_project uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  tpl        public.task_templates;
  v_proj_org uuid;
  item       record;
  v_section  uuid;
  v_task     uuid;
  v_base     int;
  v_count    int := 0;
  v_map      jsonb := '{}'::jsonb;
begin
  select * into tpl from public.task_templates where id = p_template;
  if not found then
    raise exception 'Template % not found', p_template;
  end if;
  select org_id into v_proj_org from public.projects where id = p_project;
  if v_proj_org is null or v_proj_org <> tpl.org_id then
    raise exception 'Template and project belong to different organizations'
      using errcode = 'check_violation';
  end if;

  select coalesce(max(sort_order), 0) into v_base from public.tasks
    where project_id = p_project;

  for item in
    with recursive tree as (
      select i.*, 0 as depth
      from public.task_template_items i
      where i.template_id = p_template and i.parent_item_id is null
      union all
      select c.*, tree.depth + 1
      from public.task_template_items c
      join tree on c.parent_item_id = tree.id
    )
    select * from tree order by depth, sort_order, created_at
  loop
    v_section := null;
    if item.section_name is not null and item.parent_item_id is null then
      select id into v_section from public.task_sections
        where project_id = p_project and lower(name) = lower(item.section_name);
      if v_section is null then
        insert into public.task_sections (org_id, project_id, name, sort_order)
        values (tpl.org_id, p_project, item.section_name,
                (select coalesce(max(sort_order), 0) + 1 from public.task_sections
                  where project_id = p_project))
        returning id into v_section;
      end if;
    end if;

    insert into public.tasks
      (org_id, project_id, section_id, parent_task_id, title, description,
       priority, sort_order, created_by)
    values
      (tpl.org_id, p_project, v_section,
       case when item.parent_item_id is null then null
            else (v_map ->> item.parent_item_id::text)::uuid end,
       item.title, item.description, item.priority,
       v_base + item.sort_order + 1, auth.uid())
    returning id into v_task;

    v_map := v_map || jsonb_build_object(item.id::text, v_task::text);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

revoke execute on function public.apply_task_template_internal(uuid, uuid) from public, anon, authenticated;

create or replace function public.apply_task_template(p_template uuid, p_project uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  select org_id into v_org from public.task_templates where id = p_template;
  if v_org is null then
    raise exception 'Template % not found', p_template;
  end if;
  if not public.org_can_edit(v_org) then
    raise exception 'Not allowed to apply templates in this organization';
  end if;
  return public.apply_task_template_internal(p_template, p_project);
end $$;

-- ---------- the win core ----------

create or replace function public.win_proposal(p_proposal uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p          public.proposals;
  t          record;
  v_contact  public.contacts;
  v_deal     public.deals;
  v_project  uuid;
  v_contract uuid;
  v_invoice  uuid;
  v_deposit  numeric(14,2);
  v_start    date;
  v_body     text;
begin
  select * into p from public.proposals where id = p_proposal for update;
  if not found then
    raise exception 'Proposal not found';
  end if;

  -- Idempotency: winning twice returns the first win's artifacts.
  if p.project_id is not null then
    return jsonb_build_object('ok', true, 'already_won', true,
      'project_id', p.project_id, 'contract_id', p.contract_id, 'invoice_id', p.invoice_id);
  end if;
  if p.status <> 'accepted' then
    raise exception 'Only accepted proposals can be won (status: %)', p.status;
  end if;

  select * into t from public.v_proposal_totals where proposal_id = p.id;
  select * into v_contact from public.contacts where id = p.contact_id;
  if p.deal_id is not null then
    select * into v_deal from public.deals where id = p.deal_id;
  end if;

  -- 1. Project (year derives from start_date).
  v_start := coalesce(v_deal.expected_date, current_date);
  insert into public.projects
    (org_id, name, contact_id, client, project_type, status, start_date, created_by)
  values
    (p.org_id, p.title, p.contact_id, v_contact.name, p.project_type,
     'planning', v_start, p.created_by)
  returning id into v_project;

  -- 2. Task template, if the proposal names one.
  if p.task_template_id is not null then
    perform public.apply_task_template_internal(p.task_template_id, v_project);
  end if;

  -- 3. Contract, generated from the proposal, ready to sign.
  v_body := '# ' || p.title || E'\n\n'
    || 'Agreement between **'
    || (select name from public.organizations where id = p.org_id)
    || '** and **' || v_contact.name || '**.' || E'\n\n## Scope\n\n'
    || coalesce((
         select string_agg('- ' || l.description || ' — ' || l.qty || ' × ' || l.unit_price, E'\n'
                           order by l.line_number)
         from public.proposal_lines l where l.proposal_id = p.id), '')
    || E'\n\n## Terms\n\nTotal: ' || t.total
    || case when p.deposit_pct > 0
            then E'\nDeposit due on signing: ' || p.deposit_pct || '% ('
                 || round(t.total * p.deposit_pct / 100, 2) || ')'
            else '' end
    || coalesce(E'\n\n' || p.memo, '');

  insert into public.contracts
    (org_id, contact_id, project_id, proposal_id, title, status, body_md, created_by)
  values
    (p.org_id, p.contact_id, v_project, p.id, 'Agreement — ' || p.title, 'sent', v_body, p.created_by)
  returning id into v_contract;

  -- 4. Deposit invoice, sent and payable (untaxed by design: taxes ride the
  -- final invoice; the deposit is a prepayment against the total).
  if p.deposit_pct > 0 and t.total > 0 then
    v_deposit := round(t.total * p.deposit_pct / 100, 2);
    perform set_config('app.invoice_rpc', 'on', true);
    insert into public.invoices
      (org_id, contact_id, project_id, status, issue_date, due_date, sent_at, memo, created_by)
    values
      (p.org_id, p.contact_id, v_project, 'sent', current_date, current_date + 7, now(),
       'Deposit — ' || p.title, p.created_by)
    returning id into v_invoice;
    insert into public.invoice_lines
      (org_id, invoice_id, description, qty, unit_price, line_number)
    values
      (p.org_id, v_invoice,
       'Deposit (' || p.deposit_pct || '% of ' || t.total || ') — ' || p.title,
       1, v_deposit, 1);
    perform set_config('app.invoice_rpc', '', true);
  end if;

  -- 5. Deal won (creates one when the proposal was standalone).
  if p.deal_id is not null then
    update public.deals set status = 'won', project_id = v_project where id = p.deal_id;
  else
    insert into public.deals
      (org_id, contact_id, title, status, estimated_value, project_id, source)
    values
      (p.org_id, p.contact_id, p.title, 'won', t.total, v_project, 'proposal');
  end if;

  -- Contact becomes a client even without a deal trigger in the loop.
  update public.contacts set lifecycle = 'client'
    where id = p.contact_id and lifecycle = 'lead';

  -- 6. Stamp the artifacts (the idempotency receipt).
  perform set_config('app.proposal_rpc', 'on', true);
  update public.proposals
    set project_id = v_project, contract_id = v_contract, invoice_id = v_invoice
    where id = p.id;
  perform set_config('app.proposal_rpc', '', true);

  return jsonb_build_object('ok', true, 'already_won', false,
    'project_id', v_project, 'contract_id', v_contract, 'invoice_id', v_invoice);
end $$;

revoke execute on function public.win_proposal(uuid) from public, anon, authenticated;

-- Acceptance now runs the whole cascade in the same transaction.
create or replace function public.accept_proposal(p_token uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.proposals;
  v_headers jsonb;
  v_win jsonb;
begin
  select * into p from public.proposals where share_token = p_token for update;
  if not found or p.status not in ('sent', 'accepted') then
    raise exception 'This proposal is not open for acceptance';
  end if;
  if p.status = 'accepted' then
    v_win := public.win_proposal(p.id);
    return jsonb_build_object('ok', true, 'status', 'accepted');
  end if;
  if p.valid_until is not null and p.valid_until < current_date then
    perform set_config('app.proposal_rpc', 'on', true);
    update public.proposals set status = 'expired' where id = p.id;
    perform set_config('app.proposal_rpc', '', true);
    raise exception 'This proposal has expired';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Please type your name to accept';
  end if;

  v_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);

  perform set_config('app.proposal_rpc', 'on', true);
  update public.proposals set
    status = 'accepted',
    accepted_at = now(),
    accepted_name = trim(p_name),
    accepted_ip = v_headers ->> 'x-forwarded-for',
    accepted_ua = v_headers ->> 'user-agent'
    where id = p.id;
  perform set_config('app.proposal_rpc', '', true);

  v_win := public.win_proposal(p.id);
  return jsonb_build_object('ok', true, 'status', 'accepted');
end $$;

grant execute on function public.accept_proposal(uuid, text) to anon, authenticated;

-- Owner-side win (e.g. verbal acceptance): marks accepted with the caller as
-- evidence, then the same cascade.
create or replace function public.win_deal_manual(p_proposal uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.proposals;
begin
  select * into p from public.proposals where id = p_proposal for update;
  if not found then
    raise exception 'Proposal not found';
  end if;
  if not public.org_can_edit(p.org_id) then
    raise exception 'Not allowed to win proposals in this organization';
  end if;
  if p.status = 'sent' then
    perform set_config('app.proposal_rpc', 'on', true);
    update public.proposals set
      status = 'accepted', accepted_at = now(),
      accepted_name = coalesce(
        (select coalesce(full_name, email) from public.profiles where id = auth.uid()),
        'recorded manually')
      where id = p.id;
    perform set_config('app.proposal_rpc', '', true);
  end if;
  return public.win_proposal(p_proposal);
end $$;

grant execute on function public.win_deal_manual(uuid) to authenticated;

-- The compensator. Refuses once real money exists on the deposit invoice.
create or replace function public.unwin_proposal(p_proposal uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  p public.proposals;
begin
  select * into p from public.proposals where id = p_proposal for update;
  if not found then
    raise exception 'Proposal not found';
  end if;
  if not public.org_is_admin(p.org_id) then
    raise exception 'Only an organization owner/admin can un-win';
  end if;
  if p.project_id is null then
    return jsonb_build_object('ok', true, 'nothing_to_undo', true);
  end if;
  if p.invoice_id is not null and exists (
    select 1 from public.payments where invoice_id = p.invoice_id and voided_at is null
  ) then
    raise exception 'Payments were recorded on the deposit invoice — void those first'
      using errcode = 'check_violation';
  end if;

  perform set_config('app.invoice_rpc', 'on', true);
  perform set_config('app.contract_rpc', 'on', true);
  perform set_config('app.proposal_rpc', 'on', true);

  if p.invoice_id is not null then
    update public.invoices set status = 'void' where id = p.invoice_id;
  end if;
  if p.contract_id is not null then
    update public.contracts set status = 'void' where id = p.contract_id;
  end if;
  if p.deal_id is not null then
    update public.deals set status = 'open', project_id = null where id = p.deal_id;
  end if;
  -- The project is kept (it may already hold tasks/time); it simply unlinks.
  update public.proposals
    set project_id = null, contract_id = null, invoice_id = null, status = 'sent',
        accepted_at = null, accepted_name = null, accepted_ip = null, accepted_ua = null
    where id = p.id;

  perform set_config('app.invoice_rpc', '', true);
  perform set_config('app.contract_rpc', '', true);
  perform set_config('app.proposal_rpc', '', true);

  return jsonb_build_object('ok', true, 'kept_project_id', p.project_id);
end $$;

grant execute on function public.unwin_proposal(uuid) to authenticated;
