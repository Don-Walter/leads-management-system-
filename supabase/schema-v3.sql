-- ============================================================
--  AIM Podcast Tracker — v3
--
--  - a bootstrap list for teammates, alongside the admin one
--  - display names, editable by their owner
--
--  Safe to re-run.
-- ============================================================

-- ============================================================
--  handle_new_user — assign role and display name on first login
--
--  Two allowlists now. An address on neither one lands on 'client'
--  with no channels, which sees nothing: access is granted, never
--  defaulted.
--
--  The display name matters because the fallback is the email's
--  local part, and "shay999.in" is not what anyone wants to be
--  greeted by.
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bootstrap_admins    text[] := array['apexideamarketing7@gmail.com'];
  bootstrap_teammates text[] := array['shay999.in@gmail.com'];

  -- addresses whose display name we already know
  known_names jsonb := '{
    "shay999.in@gmail.com": "Shay"
  }'::jsonb;

  v_email text := lower(new.email);
  v_role  text;
  v_name  text;
begin
  v_role := case
    when v_email = any (bootstrap_admins)    then 'admin'
    when v_email = any (bootstrap_teammates) then 'teammate'
    else 'client'
  end;

  v_name := coalesce(
    new.raw_user_meta_data ->> 'full_name',    -- what they signed up with
    known_names ->> v_email,                   -- what we were told
    initcap(split_part(new.email, '@', 1))     -- last resort
  );

  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, v_name, v_role)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
--  set_display_name — let people rename themselves
--
--  Same reasoning as set_approval(): RLS grants whole rows and
--  cannot restrict columns, so an UPDATE policy letting someone
--  edit their own profile would also let them edit their own
--  role. Nobody gets that policy; this function is the only way
--  in, and it touches one column.
-- ============================================================
create or replace function public.set_display_name(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if v_name = '' then
    raise exception 'Name cannot be empty.';
  end if;
  if length(v_name) > 60 then
    raise exception 'Name is too long (60 characters max).';
  end if;

  update public.profiles set full_name = v_name where id = auth.uid();
  return v_name;
end;
$$;

revoke all on function public.set_display_name(text) from public;
grant execute on function public.set_display_name(text) to authenticated;


-- ============================================================
--  Tidy up names that predate this
--  Only touches rows still carrying the raw email local part.
-- ============================================================
update public.profiles
   set full_name = 'Shay'
 where lower(email) = 'shay999.in@gmail.com'
   and coalesce(full_name, '') in ('', 'shay999.in');

update public.profiles
   set full_name = initcap(split_part(email, '@', 1))
 where full_name is null or btrim(full_name) = '';
