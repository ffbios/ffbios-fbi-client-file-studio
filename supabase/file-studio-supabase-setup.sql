-- FBI Client File Studio - Supabase setup
-- Run once in the Supabase SQL Editor.
-- This can live in the SAME Supabase project used by FBI Invoice Studio.

create extension if not exists pgcrypto;

create table if not exists public.file_studio_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  client_name text,
  client_email text,
  delivery_note text,
  shared boolean not null default false,
  share_token text unique,
  share_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.file_studio_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.file_studio_projects(id) on delete cascade,
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  file_size bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.file_studio_downloads (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.file_studio_projects(id) on delete cascade,
  file_id uuid not null references public.file_studio_files(id) on delete cascade,
  downloaded_at timestamptz not null default now()
);

create index if not exists idx_file_studio_projects_owner on public.file_studio_projects(owner_id);
create index if not exists idx_file_studio_projects_share on public.file_studio_projects(share_token);
create index if not exists idx_file_studio_files_owner on public.file_studio_files(owner_id);
create index if not exists idx_file_studio_files_project on public.file_studio_files(project_id);
create index if not exists idx_file_studio_downloads_file on public.file_studio_downloads(file_id);
create index if not exists idx_file_studio_downloads_project on public.file_studio_downloads(project_id);

create or replace function public.file_studio_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists file_studio_projects_touch on public.file_studio_projects;
create trigger file_studio_projects_touch
before update on public.file_studio_projects
for each row execute function public.file_studio_touch_updated_at();

alter table public.file_studio_projects enable row level security;
alter table public.file_studio_files enable row level security;
alter table public.file_studio_downloads enable row level security;

revoke all on table public.file_studio_projects from anon, authenticated;
revoke all on table public.file_studio_files from anon, authenticated;
revoke all on table public.file_studio_downloads from anon, authenticated;
grant select, insert, update, delete on table public.file_studio_projects to authenticated;
grant select, insert, update, delete on table public.file_studio_files to authenticated;
grant select on table public.file_studio_downloads to authenticated;

drop policy if exists "file studio project owner select" on public.file_studio_projects;
create policy "file studio project owner select" on public.file_studio_projects
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "file studio project owner insert" on public.file_studio_projects;
create policy "file studio project owner insert" on public.file_studio_projects
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "file studio project owner update" on public.file_studio_projects;
create policy "file studio project owner update" on public.file_studio_projects
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "file studio project owner delete" on public.file_studio_projects;
create policy "file studio project owner delete" on public.file_studio_projects
for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "file studio file owner select" on public.file_studio_files;
create policy "file studio file owner select" on public.file_studio_files
for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "file studio file owner insert" on public.file_studio_files;
create policy "file studio file owner insert" on public.file_studio_files
for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists "file studio file owner update" on public.file_studio_files;
create policy "file studio file owner update" on public.file_studio_files
for update to authenticated using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists "file studio file owner delete" on public.file_studio_files;
create policy "file studio file owner delete" on public.file_studio_files
for delete to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "file studio download owner select" on public.file_studio_downloads;
create policy "file studio download owner select" on public.file_studio_downloads
for select to authenticated using (
  exists (
    select 1 from public.file_studio_projects p
    where p.id = file_studio_downloads.project_id
      and p.owner_id = (select auth.uid())
  )
);

-- Private Storage bucket. Files are NEVER public by bucket URL.
insert into storage.buckets (id, name, public)
values ('fbi-client-files', 'fbi-client-files', false)
on conflict (id) do update set public = false;

drop policy if exists "file studio storage insert" on storage.objects;
create policy "file studio storage insert" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'fbi-client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "file studio storage select" on storage.objects;
create policy "file studio storage select" on storage.objects
for select to authenticated
using (
  bucket_id = 'fbi-client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "file studio storage update" on storage.objects;
create policy "file studio storage update" on storage.objects
for update to authenticated
using (
  bucket_id = 'fbi-client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
)
with check (
  bucket_id = 'fbi-client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "file studio storage delete" on storage.objects;
create policy "file studio storage delete" on storage.objects
for delete to authenticated
using (
  bucket_id = 'fbi-client-files'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

-- Realtime keeps the admin UI updated across devices.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='file_studio_projects'
  ) then
    alter publication supabase_realtime add table public.file_studio_projects;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='file_studio_files'
  ) then
    alter publication supabase_realtime add table public.file_studio_files;
  end if;
end $$;

grant usage on schema public to authenticated;