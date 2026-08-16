-- ============================================================
--  Podcast Client Tracker — v2
--
--  Adds on top of schema.sql:
--    - attachments (file / link / pasted note) on every block
--    - Copywriting split into Description, SEO, Transcript
--    - client approval: Pending / Cleared / Needs change
--    - a third role, 'client', scoped to their own channel
--
--  Safe to re-run.
-- ============================================================

create extension if not exists "pgcrypto";


-- ============================================================
--  Roles: enum -> text + check
--
--  Adding a value to a Postgres enum cannot be used in the same
--  transaction that adds it, which makes enum roles painful to
--  extend in a single re-runnable file. Roles will keep changing;
--  the status columns will not. So roles become text + check and
--  the status enums stay as they are.
-- ============================================================
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'role' and data_type = 'USER-DEFINED'
  ) then
    alter table public.profiles alter column role drop default;
    alter table public.profiles alter column role type text using role::text;
  end if;
end $$;

-- New accounts land on 'client' with no channel mapping, which sees
-- nothing at all. Access is something you grant, never a default.
alter table public.profiles alter column role set default 'client';

do $$ begin
  alter table public.profiles
    add constraint profiles_role_chk check (role in ('admin', 'teammate', 'client'));
exception when duplicate_object then null; end $$;

drop type if exists public.app_role;

comment on column public.profiles.role is
  'admin = everything incl. managing people. teammate = co-founder, everything except managing people. client = read-only on their own channels + approval.';


-- handle_new_user still cast to the dropped enum, which would break
-- every signup. Redefined here against the text column.
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
    case when lower(new.email) = any (bootstrap_admins) then 'admin' else 'client' end
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
--  client_users — which channels a client account may see
--  Only meaningful for role = 'client'; staff see everything.
-- ============================================================
create table if not exists public.client_users (
  client_id   uuid not null references public.clients (id) on delete cascade,
  user_id     uuid not null references auth.users (id)    on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (client_id, user_id)
);

create index if not exists client_users_user_idx on public.client_users (user_id);


-- ============================================================
--  videos — copywriting subgroups + client approval
-- ============================================================
alter table public.videos
  add column if not exists copy_description_status public.work_status not null default 'not_started',
  add column if not exists copy_seo_status         public.work_status not null default 'not_started',
  add column if not exists copy_transcript_status  public.work_status not null default 'not_started',
  add column if not exists approval_status text not null default 'pending',
  add column if not exists approval_note   text,
  add column if not exists approval_by     uuid references auth.users (id),
  add column if not exists approval_at     timestamptz;

do $$ begin
  alter table public.videos
    add constraint videos_approval_chk check (approval_status in ('pending', 'cleared', 'needs_change'));
exception when duplicate_object then null; end $$;

-- "Needs change" is only useful if it says what to change.
do $$ begin
  alter table public.videos
    add constraint videos_change_note_chk
    check (approval_status <> 'needs_change' or coalesce(btrim(approval_note), '') <> '');
exception when duplicate_object then null; end $$;

comment on column public.videos.copy_status is
  'Rollup of the three copywriting subgroups. Maintained by trigger — do not set directly.';

-- copy_status stays as the single Copywriting cell in the table view,
-- derived from its three subgroups so the two can never disagree.
create or replace function public.roll_up_copy_status()
returns trigger language plpgsql as $$
begin
  new.copy_status := case
    when new.copy_description_status = 'done'
     and new.copy_seo_status         = 'done'
     and new.copy_transcript_status  = 'done'        then 'done'
    when new.copy_description_status = 'not_started'
     and new.copy_seo_status         = 'not_started'
     and new.copy_transcript_status  = 'not_started' then 'not_started'
    else 'in_progress'
  end;
  return new;
end;
$$;

drop trigger if exists videos_copy_rollup on public.videos;
create trigger videos_copy_rollup
  before insert or update of copy_description_status, copy_seo_status, copy_transcript_status
  on public.videos
  for each row execute function public.roll_up_copy_status();


-- ============================================================
--  attachments — one row per file, link, or pasted note
--
--  Every block takes all three kinds. Whether a thumbnail arrives
--  as a PNG, a Drive link, or pasted text is the uploader's call.
-- ============================================================
create table if not exists public.attachments (
  id           uuid primary key default gen_random_uuid(),
  video_id     uuid not null references public.videos (id) on delete cascade,

  block        text not null,
  kind         text not null,

  label        text,

  -- kind = 'file': object in the private 'attachments' storage bucket
  storage_path text,
  file_name    text,
  mime_type    text,
  size_bytes   bigint,

  -- kind = 'link'
  url          text,

  -- kind = 'note'
  body         text,

  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),

  constraint attachments_block_chk check (
    block in ('thumbnail', 'intro', 'copy_description', 'copy_seo', 'copy_transcript')),

  constraint attachments_kind_chk check (kind in ('file', 'link', 'note')),

  -- each kind must actually carry its payload
  constraint attachments_payload_chk check (
    (kind = 'file' and storage_path is not null and file_name is not null)
 or (kind = 'link' and coalesce(btrim(url),  '') <> '')
 or (kind = 'note' and coalesce(btrim(body), '') <> '')
  )
);

create index if not exists attachments_video_idx on public.attachments (video_id, block, created_at);


-- ============================================================
--  Access helpers
--
--  All SECURITY DEFINER so policies can read profiles/client_users
--  without recursing into those tables' own RLS.
-- ============================================================
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false);
$$;

-- staff = admin + co-founder. The only thing separating them is
-- managing people, enforced on profiles and client_users below.
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin', 'teammate'), false);
$$;

create or replace function public.can_see_client(p_client_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_staff()
      or exists (
        select 1 from public.client_users
        where client_id = p_client_id and user_id = auth.uid()
      );
$$;

drop function if exists public.is_member();


-- ============================================================
--  Row Level Security
-- ============================================================
alter table public.profiles     enable row level security;
alter table public.clients      enable row level security;
alter table public.videos       enable row level security;
alter table public.attachments  enable row level security;
alter table public.client_users enable row level security;

-- Drop by both the old and the current names, so this file is
-- re-runnable against a database at either version.
drop policy if exists profiles_read_self   on public.profiles;
drop policy if exists profiles_select      on public.profiles;
drop policy if exists profiles_admin_write on public.profiles;
drop policy if exists client_users_select  on public.client_users;
drop policy if exists client_users_admin   on public.client_users;
drop policy if exists clients_admin_all    on public.clients;
drop policy if exists clients_select       on public.clients;
drop policy if exists clients_write        on public.clients;
drop policy if exists videos_admin_all     on public.videos;
drop policy if exists videos_select        on public.videos;
drop policy if exists videos_write         on public.videos;
drop policy if exists attachments_select   on public.attachments;
drop policy if exists attachments_write    on public.attachments;

-- ---- profiles: everyone sees themselves, staff see the roster,
--      only admin may change anyone ----
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_staff());
create policy profiles_admin_write on public.profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- client_users: managing people is admin-only ----
create policy client_users_select on public.client_users
  for select using (user_id = auth.uid() or public.is_staff());
create policy client_users_admin on public.client_users
  for all using (public.is_admin()) with check (public.is_admin());

-- ---- clients ----
create policy clients_select on public.clients
  for select using (public.can_see_client(id));
create policy clients_write on public.clients
  for all using (public.is_staff()) with check (public.is_staff());

-- ---- videos ----
--  Clients get SELECT only. Approval is a column-level permission,
--  which RLS cannot express, so it goes through set_approval() below.
create policy videos_select on public.videos
  for select using (public.can_see_client(client_id));
create policy videos_write on public.videos
  for all using (public.is_staff()) with check (public.is_staff());

-- ---- attachments ----
create policy attachments_select on public.attachments
  for select using (exists (
    select 1 from public.videos v
    where v.id = video_id and public.can_see_client(v.client_id)));
create policy attachments_write on public.attachments
  for all using (public.is_staff()) with check (public.is_staff());


-- ============================================================
--  set_approval — the one write a client is allowed
--
--  RLS grants or denies whole rows, never single columns. Rather
--  than give clients UPDATE on videos and hope they only touch the
--  approval fields, they get no UPDATE policy at all and this
--  function is the only way in.
-- ============================================================
create or replace function public.set_approval(
  p_video_id uuid,
  p_status   text,
  p_note     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
begin
  if p_status not in ('pending', 'cleared', 'needs_change') then
    raise exception 'Invalid approval status: %', p_status;
  end if;

  if p_status = 'needs_change' and coalesce(btrim(p_note), '') = '' then
    raise exception 'Say what needs changing.';
  end if;

  select client_id into v_client from public.videos where id = p_video_id;
  if v_client is null then
    raise exception 'No such video';
  end if;

  -- same visibility rule as reading it
  if not public.can_see_client(v_client) then
    raise exception 'Not allowed';
  end if;

  update public.videos
     set approval_status = p_status,
         approval_note   = case when p_status = 'needs_change' then btrim(p_note) else null end,
         approval_by     = auth.uid(),
         approval_at     = now()
   where id = p_video_id;
end;
$$;

revoke all on function public.set_approval(uuid, text, text) from public;
grant execute on function public.set_approval(uuid, text, text) to authenticated;


-- ============================================================
--  Storage — private 'attachments' bucket
--
--  Path is {client_id}/{video_id}/{uuid}_{filename}, so the first
--  folder segment is the client and visibility falls straight out
--  of can_see_client().
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)     -- 50 MB
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists attachments_obj_select on storage.objects;
drop policy if exists attachments_obj_write  on storage.objects;

create policy attachments_obj_select on storage.objects
  for select using (
    bucket_id = 'attachments'
    and public.can_see_client(((storage.foldername(name))[1])::uuid)
  );

create policy attachments_obj_write on storage.objects
  for all using (bucket_id = 'attachments' and public.is_staff())
       with check (bucket_id = 'attachments' and public.is_staff());
