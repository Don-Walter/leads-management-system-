-- ============================================================
--  Podcast Client Tracker — Supabase schema
--  Project: qppedffzzsavdumwpjdd
--
--  Run this once in the Supabase SQL Editor:
--    Dashboard -> SQL Editor -> New query -> paste -> Run
--
--  Safe to re-run: every statement is idempotent.
-- ============================================================

-- ---------- extensions ----------
create extension if not exists "pgcrypto";


-- ---------- enums ----------
-- The three production blocks (Thumbnails / Intro / Copywriting)
-- all share the same lifecycle.
do $$ begin
  create type public.work_status as enum ('not_started', 'in_progress', 'done');
exception when duplicate_object then null; end $$;

-- The fourth block: where the video actually stands.
do $$ begin
  create type public.upload_status as enum ('to_be_uploaded', 'in_process', 'uploaded');
exception when duplicate_object then null; end $$;

-- Access levels. Only 'admin' is granted write access today;
-- 'teammate' is wired up now so adding the team later is a data change,
-- not a schema migration.
do $$ begin
  create type public.app_role as enum ('admin', 'teammate');
exception when duplicate_object then null; end $$;


-- ============================================================
--  profiles — links a Supabase auth user to a role
-- ============================================================
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  role        public.app_role not null default 'teammate',
  created_at  timestamptz not null default now()
);

comment on table public.profiles is
  'One row per login. role=admin grants full read/write; role=teammate is read + status updates only.';

-- Auto-create a profile whenever someone signs up.
--
-- Everyone lands on 'teammate' so a stray signup can never self-promote.
-- The one exception is the bootstrap allowlist below: those addresses are
-- granted admin on first login, which is what saves you from having to run
-- a promotion query by hand after creating the account.
--
-- Editing this array is the only way to mint an admin without already
-- being one. Keep it short.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bootstrap_admins text[] := array[
    'apexideamarketing7@gmail.com'
  ];
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case
      when lower(new.email) = any (bootstrap_admins) then 'admin'::public.app_role
      else 'teammate'::public.app_role
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
--  clients — one podcast channel
--  This is what fills the page heading.
-- ============================================================
create table if not exists public.clients (
  id            uuid primary key default gen_random_uuid(),
  channel_name  text not null,
  email         text,
  youtube_url   text,
  notes         text,
  is_archived   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column public.clients.channel_name is 'Podcast / YouTube channel name — shown in the tracker heading.';
comment on column public.clients.youtube_url  is 'Channel URL or @handle. Used by the YouTube sync step.';

create index if not exists clients_active_idx
  on public.clients (is_archived, channel_name);


-- ============================================================
--  videos — one episode, tracked across the four blocks
-- ============================================================
create table if not exists public.videos (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,

  title         text not null,
  episode_no    integer,
  notes         text,

  -- Block 1..3: production work
  thumbnail_status  public.work_status   not null default 'not_started',
  intro_status      public.work_status   not null default 'not_started',
  copy_status       public.work_status   not null default 'not_started',

  -- Block 4: where it stands
  status            public.upload_status not null default 'to_be_uploaded',

  -- Filled in once the episode is live (or pulled in by the YouTube sync)
  youtube_video_id  text,
  published_at      timestamptz,
  due_date          date,

  -- 'manual' = you typed it in; 'youtube' = pulled from the channel feed
  source        text not null default 'manual',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists videos_client_idx  on public.videos (client_id, created_at desc);
create index if not exists videos_status_idx  on public.videos (client_id, status);

-- A given YouTube video should only ever appear once per client.
create unique index if not exists videos_youtube_uniq
  on public.videos (client_id, youtube_video_id)
  where youtube_video_id is not null;


-- ---------- keep updated_at honest ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clients_touch on public.clients;
create trigger clients_touch before update on public.clients
  for each row execute function public.touch_updated_at();

drop trigger if exists videos_touch on public.videos;
create trigger videos_touch before update on public.videos
  for each row execute function public.touch_updated_at();


-- ============================================================
--  Row Level Security
--
--  Nothing is readable without a login. The browser only ever
--  holds the anon key, so RLS is the actual security boundary.
-- ============================================================

-- security definer so the policy can read profiles without
-- recursing back into profiles' own RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid());
$$;


alter table public.profiles enable row level security;
alter table public.clients  enable row level security;
alter table public.videos   enable row level security;

-- ---- profiles ----
drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- clients ----
-- Admin only, for now. When teammates are added, relax the
-- select policy to public.is_member().
drop policy if exists clients_admin_all on public.clients;
create policy clients_admin_all on public.clients
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- videos ----
drop policy if exists videos_admin_all on public.videos;
create policy videos_admin_all on public.videos
  for all using (public.is_admin()) with check (public.is_admin());


-- ============================================================
--  Promote your admin user
--
--  1. Create the login first:
--       Dashboard -> Authentication -> Users -> Add user
--       (tick "Auto Confirm User")
--  2. Then run the line below with that email.
-- ============================================================
-- update public.profiles set role = 'admin' where email = 'you@example.com';
