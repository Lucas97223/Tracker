-- Phase 5, step 3: contracts with versioned bodies and signature evidence.
--
-- Decision D6: e-signature LEGALITY is never built in-house — a provider
-- (Documenso-class) gets embedded when the user picks one; signature_events
-- stores whatever evidence payload the provider returns. Until then the
-- 'internal' provider records click-to-accept evidence (doc hash, signer,
-- IP/UA, timestamp) — honest groundwork, clearly not provider-grade.

do $$ begin
  create type contract_status as enum ('draft', 'sent', 'signed', 'void');
exception when duplicate_object then null; end $$;

create table if not exists public.contracts (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  contact_id   uuid not null references public.contacts(id) on delete restrict,
  project_id   uuid references public.projects(id) on delete set null,
  proposal_id  uuid references public.proposals(id) on delete set null,
  title        text not null check (length(trim(title)) > 0),
  status       contract_status not null default 'draft',
  body_md      text not null default '',
  share_token  uuid not null unique default gen_random_uuid(),
  signed_at    timestamptz,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists contracts_org_idx on public.contracts(org_id, status);
create index if not exists contracts_contact_idx on public.contracts(contact_id);

drop trigger if exists contracts_updated_at on public.contracts;
create trigger contracts_updated_at
  before update on public.contracts
  for each row execute procedure public.set_updated_at();

drop trigger if exists contracts_set_org on public.contracts;
create trigger contracts_set_org
  before insert on public.contracts
  for each row execute procedure public.set_org_id();

create or replace function public.check_contract_org()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.contacts where id = NEW.contact_id), 'contract → contact');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.projects where id = NEW.project_id), 'contract → project');
  perform public.assert_same_org(
    NEW.org_id, (select org_id from public.proposals where id = NEW.proposal_id), 'contract → proposal');
  return NEW;
end $$;

drop trigger if exists contracts_zz_org_refs on public.contracts;
create trigger contracts_zz_org_refs
  before insert or update of contact_id, project_id, proposal_id, org_id on public.contracts
  for each row execute procedure public.check_contract_org();

-- Signed contracts are immutable except void.
create or replace function public.enforce_contract_transitions()
returns trigger language plpgsql as $$
declare
  via_rpc boolean := coalesce(current_setting('app.contract_rpc', true), '') = 'on';
begin
  if via_rpc then
    return NEW;
  end if;
  if OLD.status = 'signed'
     and not (NEW.status = 'void'
              and NEW.body_md = OLD.body_md
              and NEW.contact_id = OLD.contact_id) then
    raise exception 'Signed contract % is immutable (void is the only exit)', OLD.id
      using errcode = 'check_violation';
  end if;
  if NEW.status is distinct from OLD.status then
    if OLD.status = 'draft' and NEW.status = 'sent' then
      null;
    elsif NEW.status = 'void' then
      null;
    elsif OLD.status = 'sent' and NEW.status = 'draft' then
      null; -- pull back for edits before anyone signed
    else
      raise exception 'Contract transition % → % goes through the signing flow',
        OLD.status, NEW.status using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists contracts_transitions on public.contracts;
create trigger contracts_transitions
  before update on public.contracts
  for each row execute procedure public.enforce_contract_transitions();

-- ---------- versions (immutable body snapshots) ----------

create table if not exists public.contract_versions (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  contract_id  uuid not null references public.contracts(id) on delete cascade,
  version      int not null,
  body_md      text not null,
  doc_hash     text not null,          -- sha256 of body_md
  created_at   timestamptz not null default now(),
  unique (contract_id, version)
);

create or replace function public.snapshot_contract_version()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' or NEW.body_md is distinct from OLD.body_md then
    insert into public.contract_versions (org_id, contract_id, version, body_md, doc_hash)
    values (
      NEW.org_id, NEW.id,
      coalesce((select max(version) from public.contract_versions where contract_id = NEW.id), 0) + 1,
      NEW.body_md,
      encode(digest(NEW.body_md, 'sha256'), 'hex'));
  end if;
  return NEW;
end $$;

drop trigger if exists contracts_snapshot_version on public.contracts;
create trigger contracts_snapshot_version
  after insert or update of body_md on public.contracts
  for each row execute procedure public.snapshot_contract_version();

-- ---------- signature evidence ----------

create table if not exists public.signature_events (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  contract_id          uuid not null references public.contracts(id) on delete cascade,
  contract_version_id  uuid references public.contract_versions(id) on delete set null,
  provider             text not null default 'internal',   -- documenso/docusign/etc later (D6)
  doc_hash             text not null,
  signer_name          text not null,
  signer_email         text,
  signer_ip            text,
  signer_ua            text,
  payload              jsonb not null default '{}'::jsonb, -- provider evidence blob
  created_at           timestamptz not null default now()
);
create index if not exists signature_events_contract_idx on public.signature_events(contract_id);

-- ---------- anon surfaces ----------

create or replace function public.get_public_contract(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c public.contracts;
begin
  select * into c from public.contracts
    where share_token = p_token and status in ('sent', 'signed');
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'title', c.title,
    'status', c.status,
    'body_md', c.body_md,
    'signed_at', c.signed_at,
    'org_name', (select o.name from public.organizations o where o.id = c.org_id),
    'contact_name', (select ct.name from public.contacts ct where ct.id = c.contact_id)
  );
end $$;

grant execute on function public.get_public_contract(uuid) to anon, authenticated;

create or replace function public.sign_contract(p_token uuid, p_name text, p_email text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.contracts;
  v_version public.contract_versions;
  v_headers jsonb;
begin
  select * into c from public.contracts where share_token = p_token for update;
  if not found or c.status <> 'sent' then
    raise exception 'This contract is not open for signing';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Please type your full name to sign';
  end if;

  select * into v_version from public.contract_versions
    where contract_id = c.id order by version desc limit 1;
  v_headers := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);

  insert into public.signature_events
    (org_id, contract_id, contract_version_id, provider, doc_hash,
     signer_name, signer_email, signer_ip, signer_ua)
  values
    (c.org_id, c.id, v_version.id, 'internal', v_version.doc_hash,
     trim(p_name), p_email, v_headers ->> 'x-forwarded-for', v_headers ->> 'user-agent');

  perform set_config('app.contract_rpc', 'on', true);
  update public.contracts set status = 'signed', signed_at = now() where id = c.id;
  perform set_config('app.contract_rpc', '', true);

  return jsonb_build_object('ok', true, 'signed_at', now());
end $$;

grant execute on function public.sign_contract(uuid, text, text) to anon, authenticated;

-- ---------- RLS + audit ----------

alter table public.contracts         enable row level security;
alter table public.contract_versions enable row level security;
alter table public.signature_events  enable row level security;

drop policy if exists contracts_select on public.contracts;
create policy contracts_select on public.contracts
  for select using (public.org_can_view_financials(org_id));
drop policy if exists contracts_modify on public.contracts;
create policy contracts_modify on public.contracts
  for all using (public.org_can_edit(org_id)) with check (public.org_can_edit(org_id));

drop policy if exists contract_versions_select on public.contract_versions;
create policy contract_versions_select on public.contract_versions
  for select using (public.org_can_view_financials(org_id));

drop policy if exists signature_events_select on public.signature_events;
create policy signature_events_select on public.signature_events
  for select using (public.org_can_view_financials(org_id));
-- versions + evidence rows are trigger/RPC-written only (no client policies).

drop trigger if exists audit_contracts on public.contracts;
create trigger audit_contracts
  after insert or update or delete on public.contracts
  for each row execute procedure public.log_audit('contract');

-- Link proposals.contract_id now that contracts exist.
alter table public.proposals
  drop constraint if exists proposals_contract_id_fkey;
alter table public.proposals
  add constraint proposals_contract_id_fkey
  foreign key (contract_id) references public.contracts(id) on delete set null;
