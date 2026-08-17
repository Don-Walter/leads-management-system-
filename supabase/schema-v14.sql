-- ============================================================
--  AIM Podcast Tracker — v14
--
--  attachments carries its own client_id.
--
--  Its RLS policy previously reached into videos to find out which
--  channel a row belonged to. That is a subquery against another
--  table evaluated once per row, which is both slower than it needs
--  to be and a known trouble spot for Realtime, which evaluates
--  policies in a restricted context.
--
--  Denormalising one column makes the policy self-contained.
--
--  Safe to re-run.
-- ============================================================

alter table public.attachments
  add column if not exists client_id uuid references public.clients (id) on delete cascade;

update public.attachments a
   set client_id = v.client_id
  from public.videos v
 where v.id = a.video_id
   and a.client_id is distinct from v.client_id;

alter table public.attachments alter column client_id set not null;

create index if not exists attachments_client_idx on public.attachments (client_id);

-- Fill it in automatically so no caller has to remember, and so it
-- cannot drift from the video it belongs to.
create or replace function public.set_attachment_client()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select client_id into new.client_id from public.videos where id = new.video_id;
  return new;
end;
$$;

drop trigger if exists attachments_set_client on public.attachments;
create trigger attachments_set_client
  before insert or update of video_id on public.attachments
  for each row execute function public.set_attachment_client();

-- The policy no longer touches another table.
drop policy if exists attachments_select on public.attachments;
create policy attachments_select on public.attachments
  for select using (public.can_see_client(client_id));
