-- ============================================================
--  AIM Podcast Tracker — v13
--
--  Live updates. Add the tables people actually change to the
--  realtime publication, so a browser hears about a change
--  instead of waiting to be refreshed.
--
--  Row Level Security still applies: Supabase filters realtime
--  events through the subscriber's own policies, so a client is
--  told about their channel and nothing else.
--
--  Safe to re-run.
-- ============================================================

do $$
declare
  t text;
begin
  foreach t in array array['clients', 'videos', 'attachments'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'added public.% to supabase_realtime', t;
    end if;
  end loop;
end $$;

-- An UPDATE event only carries the changed columns unless the table
-- replicates the whole row. Without this, a status change would arrive
-- without the client_id needed to decide whether it is even on screen.
alter table public.clients     replica identity full;
alter table public.videos      replica identity full;
alter table public.attachments replica identity full;
