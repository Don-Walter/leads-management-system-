-- ============================================================
--  AIM Podcast Tracker — v6
--
--  Adds Shorts as a fifth production block, alongside
--  Thumbnails, Intro and Copywriting.
--
--  One status per episode rather than one per short: the
--  individual clips live as attachments on the block, so an
--  episode with six shorts is six files under one "In progress".
--
--  Safe to re-run.
-- ============================================================

alter table public.videos
  add column if not exists shorts_status public.work_status not null default 'not_started';

comment on column public.videos.shorts_status is
  'Progress on the short-form cuts for this episode. The clips themselves are attachments on the ''shorts'' block.';

-- shorts can carry files, links and notes like every other block
alter table public.attachments drop constraint if exists attachments_block_chk;
alter table public.attachments add constraint attachments_block_chk check (
  block in ('thumbnail', 'intro', 'shorts',
            'copy_titles', 'copy_description', 'copy_seo', 'copy_transcript'));
