-- ============================================================
--  AIM Podcast Tracker — v9
--
--  Email notifications, run entirely from Postgres.
--
--  The rule: everyone on a channel hears about a change except
--  whoever made it. Staff see every channel, so they hear about
--  everything; a client only hears about theirs.
--
--  Moving a dropdown is a click, so notifying on every one would
--  produce eight emails from one editing session and train people
--  to filter you. Events therefore carry a send_after, and the
--  dispatcher merges everything due for a person into one email.
--
--  Safe to re-run.
-- ============================================================

create extension if not exists pg_net;
create extension if not exists pg_cron;


-- ============================================================
--  Settings — the Resend key lives in Vault, never in a table
-- ============================================================
create table if not exists public.notification_settings (
  id            boolean primary key default true check (id),
  from_email    text not null default 'AIM Podcast Tracker <notifications@example.com>',
  reply_to      text,
  app_url       text not null default 'https://leads-management-system-sigma.vercel.app',
  enabled       boolean not null default false,   -- off until the key is in
  batch_minutes integer not null default 15
);

insert into public.notification_settings (id) values (true) on conflict do nothing;

alter table public.notification_settings enable row level security;
drop policy if exists notif_settings_admin on public.notification_settings;
create policy notif_settings_admin on public.notification_settings
  for all using (public.is_admin()) with check (public.is_admin());


-- ============================================================
--  Templates — editable text, not code
-- ============================================================
create table if not exists public.notification_templates (
  event_key text primary key,
  subject   text not null,
  line      text not null,
  enabled   boolean not null default true
);

insert into public.notification_templates (event_key, subject, line) values
  ('approval_cleared',
   '{{channel}} — {{guest}} approved',
   '{{actor}} marked {{guest}} as Cleared.'),
  ('approval_needs_change',
   '{{channel}} — changes requested on {{guest}}',
   '{{actor}} requested changes on {{guest}}: "{{note}}"'),
  ('attachment_added',
   '{{channel}} — new work ready to review',
   '{{actor}} added {{label}} to {{block}} on {{guest}}.'),
  ('status_changed',
   '{{channel}} — progress update',
   '{{actor}} moved {{block}} on {{guest}} to {{status}}.'),
  ('deadline_due',
   '{{channel}} — {{guest}} is waiting for your approval',
   '{{guest}} is due {{due}} and has not been approved yet.')
on conflict (event_key) do nothing;

alter table public.notification_templates enable row level security;
drop policy if exists notif_tpl_read  on public.notification_templates;
drop policy if exists notif_tpl_admin on public.notification_templates;
create policy notif_tpl_read on public.notification_templates
  for select using (public.is_staff());
create policy notif_tpl_admin on public.notification_templates
  for all using (public.is_admin()) with check (public.is_admin());


-- ============================================================
--  Per-person mute
-- ============================================================
create table if not exists public.notification_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  muted   boolean not null default false
);

alter table public.notification_prefs enable row level security;
drop policy if exists notif_prefs_self on public.notification_prefs;
create policy notif_prefs_self on public.notification_prefs
  for all using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());


-- ============================================================
--  Outbox — one row per recipient per event
-- ============================================================
create table if not exists public.notification_outbox (
  id          bigserial primary key,
  to_email    text not null,
  to_name     text,
  subject     text not null,
  line        text not null,
  event_key   text not null,
  client_id   uuid,
  send_after  timestamptz not null default now(),
  status      text not null default 'pending',
  attempts    integer not null default 0,
  request_id  bigint,
  last_error  text,
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),

  constraint outbox_status_chk check (status in ('pending', 'sending', 'sent', 'failed'))
);

create index if not exists outbox_due_idx
  on public.notification_outbox (status, send_after)
  where status = 'pending';

alter table public.notification_outbox enable row level security;
drop policy if exists outbox_admin on public.notification_outbox;
create policy outbox_admin on public.notification_outbox
  for select using (public.is_admin());


-- ============================================================
--  queue_notification — resolve recipients and fill the outbox
--
--  Recipients are everyone who can see the channel, minus the
--  actor. can_see_client() is not reusable here because it reads
--  auth.uid(), and this runs inside a trigger for other people.
-- ============================================================
create or replace function public.queue_notification(
  p_event_key text,
  p_client_id uuid,
  p_actor_id  uuid,
  p_vars      jsonb,
  p_delay_min integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tpl      public.notification_templates%rowtype;
  cfg      public.notification_settings%rowtype;
  rcpt     record;
  v_subject text;
  v_line    text;
  k         text;
begin
  select * into cfg from public.notification_settings where id;
  if not found or not cfg.enabled then return; end if;

  select * into tpl from public.notification_templates where event_key = p_event_key;
  if not found or not tpl.enabled then return; end if;

  v_subject := tpl.subject;
  v_line    := tpl.line;

  -- {{placeholder}} substitution
  for k in select jsonb_object_keys(p_vars) loop
    v_subject := replace(v_subject, '{{' || k || '}}', coalesce(p_vars ->> k, ''));
    v_line    := replace(v_line,    '{{' || k || '}}', coalesce(p_vars ->> k, ''));
  end loop;

  for rcpt in
    select p.id, p.email, p.full_name
    from public.profiles p
    left join public.notification_prefs np on np.user_id = p.id
    where p.id is distinct from p_actor_id            -- never tell the actor
      and coalesce(np.muted, false) = false
      and coalesce(p.email, '') <> ''
      and (
        p.role in ('admin', 'teammate')               -- staff hear everything
        or exists (                                   -- clients, only their own
          select 1 from public.client_users cu
          where cu.user_id = p.id and cu.client_id = p_client_id
        )
      )
  loop
    insert into public.notification_outbox
      (to_email, to_name, subject, line, event_key, client_id, send_after)
    values
      (rcpt.email, rcpt.full_name, v_subject, v_line, p_event_key, p_client_id,
       now() + make_interval(mins => p_delay_min));
  end loop;
end;
$$;


-- ============================================================
--  Triggers
-- ============================================================
create or replace function public.notify_video_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor  uuid := auth.uid();
  v_chan   text;
  v_who    text;
  v_batch  integer;
begin
  select channel_name into v_chan from public.clients where id = new.client_id;
  select coalesce(full_name, email, 'Someone') into v_who from public.profiles where id = v_actor;
  select batch_minutes into v_batch from public.notification_settings where id;

  -- approval is the loop that stalls, so it goes out immediately
  if new.approval_status is distinct from old.approval_status then
    if new.approval_status = 'cleared' then
      perform public.queue_notification('approval_cleared', new.client_id, v_actor,
        jsonb_build_object('channel', v_chan, 'guest', new.guest_name,
                           'actor', coalesce(v_who, 'Someone')), 0);
    elsif new.approval_status = 'needs_change' then
      perform public.queue_notification('approval_needs_change', new.client_id, v_actor,
        jsonb_build_object('channel', v_chan, 'guest', new.guest_name,
                           'actor', coalesce(v_who, 'Someone'),
                           'note', coalesce(new.approval_note, '')), 0);
    end if;
  end if;

  -- routine progress is batched
  if new.status is distinct from old.status then
    perform public.queue_notification('status_changed', new.client_id, v_actor,
      jsonb_build_object('channel', v_chan, 'guest', new.guest_name,
                         'actor', coalesce(v_who, 'Someone'),
                         'block', 'Status', 'status', replace(new.status::text, '_', ' ')),
      coalesce(v_batch, 15));
  end if;

  return new;
end;
$$;

drop trigger if exists videos_notify on public.videos;
create trigger videos_notify
  after update on public.videos
  for each row execute function public.notify_video_change();


create or replace function public.notify_attachment_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_chan  text; v_guest text; v_client uuid; v_who text; v_batch integer;
begin
  select v.client_id, v.guest_name, c.channel_name
    into v_client, v_guest, v_chan
  from public.videos v join public.clients c on c.id = v.client_id
  where v.id = new.video_id;

  select coalesce(full_name, email, 'Someone') into v_who from public.profiles where id = v_actor;
  select batch_minutes into v_batch from public.notification_settings where id;

  perform public.queue_notification('attachment_added', v_client, v_actor,
    jsonb_build_object(
      'channel', v_chan, 'guest', v_guest, 'actor', coalesce(v_who, 'Someone'),
      'label', coalesce(new.label, new.file_name, 'an item'),
      'block', initcap(replace(replace(new.block, 'copy_', ''), '_', ' '))),
    coalesce(v_batch, 15));

  return new;
end;
$$;

drop trigger if exists attachments_notify on public.attachments;
create trigger attachments_notify
  after insert on public.attachments
  for each row execute function public.notify_attachment_added();


-- ============================================================
--  Deadline reminders
--
--  No per-video view tracking, so the proxy is: due soon or past,
--  and still not approved. Approve it and the nudges stop.
-- ============================================================
create or replace function public.queue_deadline_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v record;
  n integer := 0;
begin
  for v in
    select vi.id, vi.guest_name, vi.due_date, vi.client_id, c.channel_name
    from public.videos vi
    join public.clients c on c.id = vi.client_id
    where vi.due_date is not null
      and vi.approval_status = 'pending'
      and vi.due_date <= current_date + 2
      -- at most one reminder per video per day
      and not exists (
        select 1 from public.notification_outbox o
        where o.event_key = 'deadline_due'
          and o.line like '%' || vi.guest_name || '%'
          and o.created_at > now() - interval '20 hours'
      )
  loop
    perform public.queue_notification('deadline_due', v.client_id, null,
      jsonb_build_object('channel', v.channel_name, 'guest', v.guest_name,
                         'due', to_char(v.due_date, 'FMDay DD Mon')), 0);
    n := n + 1;
  end loop;
  return n;
end;
$$;


-- ============================================================
--  dispatch_notifications — merge per recipient, then send
--
--  Everything due for one person becomes one email. The subject
--  of the first item is used; the rest are bullets in the body.
-- ============================================================
create or replace function public.dispatch_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg     public.notification_settings%rowtype;
  api_key text;
  grp     record;
  body    text;
  ids     bigint[];
  req     bigint;
  sent    integer := 0;
begin
  select * into cfg from public.notification_settings where id;
  if not found or not cfg.enabled then return 0; end if;

  select decrypted_secret into api_key
  from vault.decrypted_secrets where name = 'RESEND_API_KEY';
  if api_key is null then return 0; end if;

  for grp in
    select to_email,
           max(to_name)                                as to_name,
           min(subject)                                as subject,
           array_agg(id order by id)                   as ids,
           string_agg('<li style="margin:0 0 8px">' || line || '</li>', '' order by id) as items,
           count(*)                                    as n
    from public.notification_outbox
    where status = 'pending' and send_after <= now() and attempts < 5
    group by to_email
    limit 40
  loop
    ids := grp.ids;

    body :=
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
      || 'background:#0a0908;color:#f3efe6;padding:32px 24px">'
      || '<div style="max-width:520px;margin:0 auto;background:#121110;border:1px solid #2b2721;'
      || 'border-radius:14px;padding:28px">'
      || '<p style="color:#f2c230;font-size:12px;letter-spacing:.12em;text-transform:uppercase;'
      || 'font-weight:700;margin:0 0 18px">AIM Podcast Tracker</p>'
      || '<p style="margin:0 0 16px;font-size:16px">Hi ' || coalesce(grp.to_name, 'there') || ',</p>'
      || '<ul style="margin:0 0 22px;padding-left:18px;font-size:15px;line-height:1.55">'
      || grp.items || '</ul>'
      || '<a href="' || cfg.app_url || '" style="display:inline-block;background:#f2c230;color:#17130a;'
      || 'text-decoration:none;font-weight:650;padding:11px 20px;border-radius:8px">Open the tracker</a>'
      || '<p style="color:#8a8171;font-size:12px;margin:22px 0 0">'
      || 'You are receiving this because you have access to this channel.</p>'
      || '</div></div>';

    update public.notification_outbox
       set status = 'sending', attempts = attempts + 1
     where id = any (ids);

    select net.http_post(
      url     := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
                   'Authorization', 'Bearer ' || api_key,
                   'Content-Type',  'application/json'),
      body    := jsonb_build_object(
                   'from',    cfg.from_email,
                   'to',      jsonb_build_array(grp.to_email),
                   'subject', case when grp.n > 1
                                then grp.subject || ' (+' || (grp.n - 1) || ' more)'
                                else grp.subject end,
                   'html',    body)
                 || case when cfg.reply_to is not null
                      then jsonb_build_object('reply_to', cfg.reply_to) else '{}'::jsonb end
    ) into req;

    update public.notification_outbox
       set request_id = req
     where id = any (ids);

    sent := sent + 1;
  end loop;

  return sent;
end;
$$;


-- ============================================================
--  reconcile_notifications — did the send actually work?
--
--  pg_net is asynchronous, so "posted" is not "delivered". This
--  reads the response and either confirms or puts the row back
--  for another attempt.
-- ============================================================
create or replace function public.reconcile_notifications()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- succeeded
  update public.notification_outbox o
     set status = 'sent', sent_at = now(), last_error = null
    from net._http_response r
   where r.id = o.request_id
     and o.status = 'sending'
     and r.status_code between 200 and 299;

  -- failed: retry until attempts run out
  update public.notification_outbox o
     set status = case when o.attempts >= 5 then 'failed' else 'pending' end,
         last_error = left(coalesce(r.error_msg, r.content, 'http ' || r.status_code), 400),
         send_after = now() + interval '5 minutes'
    from net._http_response r
   where r.id = o.request_id
     and o.status = 'sending'
     and (r.status_code is null or r.status_code >= 300);

  -- anything stuck in 'sending' with no response after 15 minutes
  update public.notification_outbox
     set status = case when attempts >= 5 then 'failed' else 'pending' end,
         last_error = 'no response from mail API'
   where status = 'sending' and created_at < now() - interval '15 minutes';
end;
$$;


-- ============================================================
--  Schedule
-- ============================================================
select cron.unschedule(jobid) from cron.job
 where jobname in ('dispatch-notifications', 'reconcile-notifications', 'deadline-reminders');

select cron.schedule('dispatch-notifications',  '* * * * *',   $$select public.dispatch_notifications()$$);
select cron.schedule('reconcile-notifications', '* * * * *',   $$select public.reconcile_notifications()$$);
select cron.schedule('deadline-reminders',      '0 9 * * *',   $$select public.queue_deadline_reminders()$$);
