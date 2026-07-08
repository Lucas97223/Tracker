-- Adds a free-text `project_type` column to projects (e.g. Birthday, Wedding,
-- Conference, Photoshoot…). Stored as text so users can invent new types
-- without a schema change; the app provides common suggestions for autocomplete.

alter table public.projects
  add column if not exists project_type text;

create index if not exists projects_type_idx on public.projects(project_type);
