-- ============================================================
--  AIM Podcast Tracker — v8
--
--  Fixes a real bug in handle_new_user().
--
--  FOUND is reset by every INSERT/UPDATE/DELETE, not just by
--  SELECT. The function tested `if found` a second time *after*
--  inserting the profile row, so FOUND reflected that insert
--  rather than the earlier invite lookup. For a user with no
--  invite it then tried to iterate a NULL client_ids array and
--  raised "FOREACH expression must not be null" — which aborts
--  the trigger and the whole signup.
--
--  Anyone created without a matching invite could not be created
--  at all. Existing accounts were unaffected because they either
--  predate this or had an invite.
--
--  Safe to re-run.
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
  known_names jsonb := '{"shay999.in@gmail.com": "Shay"}'::jsonb;

  v_email   text := lower(btrim(new.email));
  inv       public.invites%rowtype;
  has_invite boolean;          -- FOUND is volatile; hold onto the answer
  v_role    text;
  v_name    text;
  v_cid     uuid;
begin
  select * into inv from public.invites where email = v_email;
  has_invite := found;

  if has_invite then
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

  if has_invite then
    -- coalesce as well, so a null array can never reach FOREACH
    foreach v_cid in array coalesce(inv.client_ids, '{}'::uuid[]) loop
      insert into public.client_users (client_id, user_id)
      values (v_cid, new.id)
      on conflict do nothing;
    end loop;

    update public.invites set accepted_at = now() where email = v_email;
  end if;

  return new;
exception
  -- A signup must never be lost to a bookkeeping failure. Worst case
  -- the person lands with no role and you fix it in the People tab.
  when others then
    raise warning 'handle_new_user failed for %: %', new.email, sqlerrm;
    insert into public.profiles (id, email, full_name, role)
    values (new.id, new.email, initcap(split_part(new.email, '@', 1)), 'client')
    on conflict (id) do nothing;
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
