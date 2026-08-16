-- ============================================================
--  AIM Podcast Tracker — v5
--
--  - a video is identified by its guest, not by a title
--  - Copywriting gains a Titles subgroup
--
--  Titles are written once the raw footage is in, so a title was
--  the wrong thing to ask for at the moment a video is created.
--  The guest is known first and is what people actually recall.
--
--  Safe to re-run.
-- ============================================================

alter table public.videos
  add column if not exists guest_name       text,
  add column if not exists copy_titles_status public.work_status not null default 'not_started';

-- Existing rows were created with a title in the only field there was,
-- so that value is the best guess at what identifies them.
update public.videos
   set guest_name = nullif(btrim(title), '')
 where guest_name is null;

update public.videos
   set guest_name = 'Untitled'
 where guest_name is null or btrim(guest_name) = '';

alter table public.videos alter column guest_name set not null;

-- title becomes optional: it gets filled in later, once there is one.
-- Where it only ever held the guest's name, it is not worth keeping.
alter table public.videos alter column title drop not null;

update public.videos
   set title = null
 where btrim(coalesce(title, '')) = btrim(coalesce(guest_name, ''));

comment on column public.videos.guest_name is 'Who is on the episode. Set at creation — this is how a row is recognised.';
comment on column public.videos.title      is 'Episode title, once written. Optional; added after the footage arrives.';


-- ============================================================
--  Copywriting rollup now covers Titles too
--
--  Transcript stays excluded: it has no status, it is either
--  attached or it is not.
-- ============================================================
create or replace function public.roll_up_copy_status()
returns trigger language plpgsql as $$
begin
  new.copy_status := case
    when new.copy_titles_status      = 'done'
     and new.copy_description_status = 'done'
     and new.copy_seo_status         = 'done'        then 'done'
    when new.copy_titles_status      = 'not_started'
     and new.copy_description_status = 'not_started'
     and new.copy_seo_status         = 'not_started' then 'not_started'
    else 'in_progress'
  end;
  return new;
end;
$$;

drop trigger if exists videos_copy_rollup on public.videos;
create trigger videos_copy_rollup
  before insert or update of copy_titles_status, copy_description_status, copy_seo_status
  on public.videos
  for each row execute function public.roll_up_copy_status();

-- recompute existing rows under the new rule
update public.videos set copy_description_status = copy_description_status;


-- ============================================================
--  Attachments can hang off the new subgroup
-- ============================================================
alter table public.attachments drop constraint if exists attachments_block_chk;
alter table public.attachments add constraint attachments_block_chk check (
  block in ('thumbnail', 'intro',
            'copy_titles', 'copy_description', 'copy_seo', 'copy_transcript'));
