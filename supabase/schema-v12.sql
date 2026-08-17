-- ============================================================
--  AIM Podcast Tracker — v12
--
--  Copywriting drops SEO as its own subgroup. Description takes
--  it on and is renamed "Description & SEO Tags", since the tags
--  are written alongside the description anyway.
--
--  Safe to re-run.
-- ============================================================

-- Anything already filed under SEO moves rather than disappearing.
-- Nothing matches today, but this file should stay correct if it is
-- ever run against a database where something does.
update public.attachments
   set block = 'copy_description'
 where block = 'copy_seo';

alter table public.attachments drop constraint if exists attachments_block_chk;
alter table public.attachments add constraint attachments_block_chk check (
  block in ('thumbnail', 'intro', 'shorts',
            'copy_titles', 'copy_description', 'copy_transcript'));

-- The rollup now derives from Titles and Description only. Transcript
-- never had a status, and SEO no longer exists.
create or replace function public.roll_up_copy_status()
returns trigger language plpgsql as $$
begin
  new.copy_status := case
    when new.copy_titles_status      = 'done'
     and new.copy_description_status = 'done'        then 'done'
    when new.copy_titles_status      = 'not_started'
     and new.copy_description_status = 'not_started' then 'not_started'
    else 'in_progress'
  end;
  return new;
end;
$$;

drop trigger if exists videos_copy_rollup on public.videos;
create trigger videos_copy_rollup
  before insert or update of copy_titles_status, copy_description_status
  on public.videos
  for each row execute function public.roll_up_copy_status();

-- recompute under the new rule
update public.videos set copy_description_status = copy_description_status;

comment on column public.videos.copy_seo_status is
  'Retired in v12 — SEO merged into Description. Kept so the column drop is a separate, reversible decision.';
