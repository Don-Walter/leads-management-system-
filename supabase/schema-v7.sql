-- ============================================================
--  AIM Podcast Tracker — v7
--
--  Repair link attachments that hold pasted text rather than a URL.
--
--  The form stored whatever was pasted, so a copied chat message
--  went in whole. The browser then treated the sentence as a
--  relative path and the link 404'd on our own domain. The app now
--  extracts the URL on save; this fixes what is already stored.
--
--  Safe to re-run.
-- ============================================================

-- 1. text with a real URL inside it -> keep just the URL
--    (and drop a trailing full stop or bracket the paste picked up)
update public.attachments
   set label = coalesce(
         nullif(label, ''),
         nullif(btrim(regexp_replace(
           btrim(replace(url, substring(url from 'https?://[^\s]+'), '')),
           '[-–—[:space:]]+$', '')), '')),
       url = regexp_replace(substring(url from 'https?://[^\s]+'), '[.,;:)\]]+$', '')
 where kind = 'link'
   and url !~ '^https?://'
   and url ~ 'https?://';

-- 2. bare domain with no protocol -> assume https
update public.attachments
   set url = 'https://' || btrim(url)
 where kind = 'link'
   and url !~ '^https?://'
   and btrim(url) ~ '^(www\.)?[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+([/?#].*)?$';

-- 3. anything left is not a link at all — keep the text, but as a note,
--    where it will render as text instead of a dead hyperlink
update public.attachments
   set kind = 'note',
       body = url,
       url  = null
 where kind = 'link'
   and url !~ '^https?://';

-- What is left should all be openable.
do $$
declare bad int;
begin
  select count(*) into bad from public.attachments
   where kind = 'link' and url !~ '^https?://';
  raise notice 'link attachments still unopenable: %', bad;
end $$;
