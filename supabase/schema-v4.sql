-- ============================================================
--  AIM Podcast Tracker — v4
--
--  A People tab: see who has joined, and set up who they'll be
--  before they do.
--
--  The account itself still gets created in the Supabase dashboard
--  — that is the one step that stays manual. Everything around it
--  (role, display name, which channels a client can see) is set up
--  here in advance and applied automatically on first login.
--
--  Safe to re-run.
-- ============================================================

-- ============================================================
--  invites — who someone will be, recorded before they exist
-- ============================================================
create table if not exists public.invites (
  email       text primary key,
  role        text not null,
  full_name   text,
  client_ids  uuid[] not null default '{}',
  note        text,
  created_by  uuid references auth.users (id),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,

  constraint invites_role_chk check (role in ('admin', 'teammate', 'client'))
);

comment on table public.invites is
  'Pending access. handle_new_user() consumes the matching row on first login and stamps accepted_at.';

-- emails are matched case-insensitively everywhere else, so store them folded
create or replace function public.fold_invite_email()
returns trigger language plpgsql as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

drop trigger if exists invites_fold_email on public.invites;
create trigger invites_fold_email
  before insert or update on public.invites
  for each row execute function public.fold_invite_email();

alter table public.invites enable row level security;

drop policy if exists invites_select on public.invites;
drop policy if exists invites_admin  on public.invites;

-- staff can see the roster; only admin can change who gets what
create policy invites_select on public.invites
  for select using (public.is_staff());
create policy invites_admin on public.invites
  for all using (public.is_admin()) with check (public.is_admin());


-- ============================================================
--  handle_new_user — apply the invite
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- kept as a fallback for the two founding accounts
  bootstrap_admins    text[] := array['apexideamarketing7@gmail.com'];
  bootstrap_teammates text[] := array['shay999.in@gmail.com'];
  known_names jsonb := '{"shay999.in@gmail.com": "Shay"}'::jsonb;

  v_email text := lower(btrim(new.email));
  inv     public.invites%rowtype;
  v_role  text;
  v_name  text;
  v_cid   uuid;
begin
  select * into inv from public.invites where email = v_email;

  if found then
    v_role := inv.role;
    v_name := coalesce(new.raw_user_meta_data ->> 'full_name', inv.full_name);
  else
    v_role := case
      when v_email = any (bootstrap_admins)    then 'admin'
      when v_email = any (bootstrap_teammates) then 'teammate'
      else 'client'
    end;
    v_name := coalesce(new.raw_user_meta_data ->> 'full_name', known_names ->> v_email);
  end if;

  v_name := coalesce(nullif(btrim(v_name), ''), initcap(split_part(new.email, '@', 1)));

  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, v_name, v_role)
  on conflict (id) do nothing;

  -- a client invited against specific channels gets them straight away
  if found then
    foreach v_cid in array inv.client_ids loop
      insert into public.client_users (client_id, user_id)
      values (v_cid, new.id)
      on conflict do nothing;
    end loop;

    update public.invites set accepted_at = now() where email = v_email;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
--  list_people — the roster
--
--  auth.users is not reachable through the API, so "has this person
--  ever signed in" has to come from a function that can read it.
-- ============================================================
create or replace function public.list_people()
returns table (
  id uuid,
  email text,
  full_name text,
  role text,
  confirmed boolean,
  last_sign_in_at timestamptz,
  joined_at timestamptz,
  channels jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Not allowed';
  end if;

  return query
  select p.id, p.email, p.full_name, p.role,
         u.email_confirmed_at is not null,
         u.last_sign_in_at,
         u.created_at,
         coalesce(
           jsonb_agg(jsonb_build_object('id', c.id, 'name', c.channel_name)
                     order by c.channel_name)
           filter (where c.id is not null),
           '[]'::jsonb)
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.client_users cu on cu.user_id = p.id
  left join public.clients      c  on c.id = cu.client_id
  group by p.id, p.email, p.full_name, p.role,
           u.email_confirmed_at, u.last_sign_in_at, u.created_at
  order by u.created_at;
end;
$$;

revoke all on function public.list_people() from public;
grant execute on function public.list_people() to authenticated;


-- ============================================================
--  set_person_role
--
--  Admin only, and you cannot demote yourself — otherwise one
--  wrong click leaves the project with nobody who can grant access.
-- ============================================================
create or replace function public.set_person_role(p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change roles.';
  end if;
  if p_role not in ('admin', 'teammate', 'client') then
    raise exception 'Unknown role: %', p_role;
  end if;
  if p_user_id = auth.uid() and p_role <> 'admin' then
    raise exception 'You cannot remove your own admin access.';
  end if;

  update public.profiles set role = p_role where id = p_user_id;

  -- channel mappings only mean anything for clients
  if p_role <> 'client' then
    delete from public.client_users where user_id = p_user_id;
  end if;
end;
$$;

revoke all on function public.set_person_role(uuid, text) from public;
grant execute on function public.set_person_role(uuid, text) to authenticated;


-- ============================================================
--  set_person_channels — replace a client's channel list atomically
-- ============================================================
create or replace function public.set_person_channels(p_user_id uuid, p_client_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cid uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can change channel access.';
  end if;

  delete from public.client_users where user_id = p_user_id;

  foreach v_cid in array coalesce(p_client_ids, '{}') loop
    insert into public.client_users (client_id, user_id)
    values (v_cid, p_user_id)
    on conflict do nothing;
  end loop;
end;
$$;

revoke all on function public.set_person_channels(uuid, uuid[]) from public;
grant execute on function public.set_person_channels(uuid, uuid[]) to authenticated;


-- ============================================================
--  remove_person — revoke everything without deleting the login
--
--  Deleting the auth user is a dashboard action. This drops them to
--  'client' with no channels, which sees nothing at all.
-- ============================================================
create or replace function public.revoke_person(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an admin can revoke access.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot revoke your own access.';
  end if;

  delete from public.client_users where user_id = p_user_id;
  update public.profiles set role = 'client' where id = p_user_id;
end;
$$;

revoke all on function public.revoke_person(uuid) from public;
grant execute on function public.revoke_person(uuid) to authenticated;
