-- Adds three columns to projects:
--   client_paid          numeric(14,2)   How much the client has paid for this project (default 0).
--   photographers        text[]          Names of people on the project team (default empty).
--   collection_details   text            Free-text notes about the deliverable / collection.
--
-- All three are editable after project creation. The dashboard uses client_paid
-- to compute project P&L (Paid − Spent = Profit) and photographers to break
-- down expenses by person and by team size.

alter table public.projects
  add column if not exists client_paid numeric(14,2) not null default 0
    check (client_paid >= 0),
  add column if not exists photographers text[] not null default '{}'::text[],
  add column if not exists collection_details text;

-- GIN index lets us search "projects featuring person X" efficiently.
create index if not exists projects_photographers_idx
  on public.projects using gin (photographers);
