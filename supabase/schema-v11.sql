-- ============================================================
--  AIM Podcast Tracker — v11
--
--  Outbound notifications become deliberate.
--
--  Staff are in the tracker all day and know when work is
--  actually ready to show, so they press Notify. A client is not
--  and never will, so anything coming *from* them stays
--  automatic — otherwise their approval would go unheard.
--
--  Everything that happens is still recorded. It just feeds the
--  "since you last notified" summary instead of firing an email.
--
--  Safe to re-run.
-- ============================================================

alter table public.videos
  add column if not exists last_notified_at timestamptz;

comment on column public.videos.last_notified_at is
  'When someone last pressed Notify. Everything after this is what the next Notify will summarise.';


-- ============================================================
--  notification_events — the log the Notify panel reads
-- ============================================================
create table if not exists public.notification_events (
  id         bigserial primary key,
  video_id   uuid not null references public.videos (id) on delete cascade,
  client_id  uuid not null references public.clients (id) on delete cascade,
  actor_id   uuid references auth.users (id),
  summary    text not null,
  created_at timestamptz not null default now()
);

create index if not exists notif_events_video_idx
  on public.notification_events (video_id, created_at desc);

alter table public.notification_events enable row level security;

drop policy if exists notif_events_read on public.notification_events;
create policy notif_events_read on public.notification_events
  for select using (public.is_staff());


create or replace function public.log_event(
  p_video_id uuid, p_client_id uuid, p_actor uuid, p_summary text)
returns void language sql security definer set search_path = public as $$
  insert into public.notification_events (video_id, client_id, actor_id, summary)
  values (p_video_id, p_client_id, p_actor, p_summary);
$$;


-- ============================================================
--  Triggers: log everything, email only what cannot wait
-- ============================================================
create or replace function public.notify_video_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_chan  text;
  v_who   text;
begin
  select channel_name into v_chan from public.clients where id = new.client_id;
  select coalesce(full_name, email, 'Someone') into v_who from public.profiles where id = v_actor;

  -- A client's verdict is the one thing nobody will press a button
  -- to pass on, so it still sends the moment it happens.
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
    perform public.log_event(new.id, new.client_id, v_actor,
      coalesce(v_who,'Someone') || ' marked it ' ||
      replace(new.approval_status, '_', ' '));
  end if;

  -- Work progress is logged, not sent. Notify decides when it goes.
  if new.status is distinct from old.status then
    perform public.log_event(new.id, new.client_id, v_actor,
      'Status moved to ' || replace(new.status::text, '_', ' '));
  end if;

  if new.thumbnail_status is distinct from old.thumbnail_status then
    perform public.log_event(new.id, new.client_id, v_actor,
      'Thumbnails marked ' || replace(new.thumbnail_status::text, '_', ' '));
  end if;
  if new.intro_status is distinct from old.intro_status then
    perform public.log_event(new.id, new.client_id, v_actor,
      'Intro marked ' || replace(new.intro_status::text, '_', ' '));
  end if;
  if new.shorts_status is distinct from old.shorts_status then
    perform public.log_event(new.id, new.client_id, v_actor,
      'Shorts marked ' || replace(new.shorts_status::text, '_', ' '));
  end if;
  if new.copy_status is distinct from old.copy_status then
    perform public.log_event(new.id, new.client_id, v_actor,
      'Copywriting marked ' || replace(new.copy_status::text, '_', ' '));
  end if;

  return new;
end;
$$;


create or replace function public.notify_attachment_added()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_client uuid; v_who text;
begin
  select client_id into v_client from public.videos where id = new.video_id;
  select coalesce(full_name, email, 'Someone') into v_who from public.profiles where id = v_actor;

  perform public.log_event(new.video_id, v_client, v_actor,
    coalesce(new.label, new.file_name, 'An item') || ' added to ' ||
    initcap(replace(replace(new.block, 'copy_', ''), '_', ' ')));

  return new;
end;
$$;


-- ============================================================
--  Who can be notified about this channel
-- ============================================================
create or replace function public.notify_recipients(p_client_id uuid)
returns table (id uuid, email text, full_name text, role text, muted boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;

  return query
  select p.id, p.email, p.full_name, p.role,
         coalesce(np.muted, false)
  from public.profiles p
  left join public.notification_prefs np on np.user_id = p.id
  where p.id <> auth.uid()
    and coalesce(p.email, '') <> ''
    and (p.role in ('admin', 'teammate')
      or exists (select 1 from public.client_users cu
                 where cu.user_id = p.id and cu.client_id = p_client_id))
  order by (p.role = 'client') desc, p.full_name;   -- the client first
end;
$$;


-- ============================================================
--  What has happened since the last Notify
-- ============================================================
create or replace function public.pending_changes(p_video_id uuid)
returns table (summary text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;

  return query
  select e.summary, e.created_at
  from public.notification_events e
  join public.videos v on v.id = e.video_id
  where e.video_id = p_video_id
    and (v.last_notified_at is null or e.created_at > v.last_notified_at)
  order by e.created_at;
end;
$$;


-- ============================================================
--  notify_now — the button
-- ============================================================
alter table public.notification_outbox
  add column if not exists body_html text;

create or replace function public.notify_now(
  p_video_id uuid,
  p_user_ids uuid[],
  p_note     text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg     public.notification_settings%rowtype;
  v       record;
  r       record;
  changes text := '';
  n_chg   integer := 0;
  sent    integer := 0;
  body    text;
begin
  if not public.is_staff() then
    raise exception 'Only the team can send notifications.';
  end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    raise exception 'Pick at least one person to notify.';
  end if;

  select * into cfg from public.notification_settings where id;
  if not found or not cfg.enabled then
    raise exception 'Notifications are switched off.';
  end if;

  select vi.*, c.channel_name into v
  from public.videos vi join public.clients c on c.id = vi.client_id
  where vi.id = p_video_id;
  if not found then raise exception 'No such video'; end if;

  for r in select * from public.pending_changes(p_video_id) loop
    changes := changes || '<li style="margin:0 0 6px">' || r.summary || '</li>';
    n_chg := n_chg + 1;
  end loop;

  if n_chg = 0 and coalesce(btrim(p_note), '') = '' then
    raise exception 'Nothing has changed since the last update, and no note was written.';
  end if;

  for r in
    select p.id, p.email, p.full_name
    from public.profiles p
    left join public.notification_prefs np on np.user_id = p.id
    where p.id = any (p_user_ids)
      and p.id <> auth.uid()
      and coalesce(np.muted, false) = false
      and coalesce(p.email, '') <> ''
      -- never let a pick reach someone who cannot see this channel
      and (p.role in ('admin', 'teammate')
        or exists (select 1 from public.client_users cu
                   where cu.user_id = p.id and cu.client_id = v.client_id))
  loop
    body :=
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
      || 'background:#0a0908;color:#f3efe6;padding:32px 24px">'
      || '<div style="max-width:520px;margin:0 auto;background:#121110;border:1px solid #2b2721;'
      || 'border-radius:14px;padding:28px">'
      || '<p style="color:#f2c230;font-size:12px;letter-spacing:.12em;text-transform:uppercase;'
      || 'font-weight:700;margin:0 0 18px">' || v.channel_name || '</p>'
      || '<p style="margin:0 0 6px;font-size:19px;font-weight:600">' || v.guest_name || '</p>'
      || '<p style="margin:0 0 20px;color:#9c9384;font-size:15px">Hi '
      || coalesce(r.full_name, 'there') || ',</p>'
      || case when coalesce(btrim(p_note), '') <> '' then
           '<p style="margin:0 0 20px;font-size:15px;line-height:1.6;padding:14px 16px;'
           || 'background:#1a1815;border-left:3px solid #f2c230;border-radius:6px">'
           || btrim(p_note) || '</p>'
         else '' end
      || case when n_chg > 0 then
           '<p style="color:#8a8171;font-size:12px;letter-spacing:.1em;text-transform:uppercase;'
           || 'font-weight:700;margin:0 0 10px">What''s new</p>'
           || '<ul style="margin:0 0 22px;padding-left:18px;font-size:15px;line-height:1.5">'
           || changes || '</ul>'
         else '' end
      || '<a href="' || cfg.app_url || '" style="display:inline-block;background:#f2c230;'
      || 'color:#17130a;text-decoration:none;font-weight:650;padding:11px 20px;'
      || 'border-radius:8px">Open the tracker</a>'
      || '</div></div>';

    insert into public.notification_outbox
      (to_email, to_name, subject, line, body_html, event_key, client_id, send_after)
    values
      (r.email, r.full_name,
       v.guest_name || ' — update from ' || v.channel_name,
       'Update on ' || v.guest_name,
       body, 'manual_notify', v.client_id, now());

    sent := sent + 1;
  end loop;

  if sent = 0 then raise exception 'None of those people can see this channel.'; end if;

  update public.videos set last_notified_at = now() where id = p_video_id;
  return sent;
end;
$$;

revoke all on function public.notify_now(uuid, uuid[], text) from public;
revoke all on function public.notify_recipients(uuid) from public;
revoke all on function public.pending_changes(uuid) from public;
grant execute on function public.notify_now(uuid, uuid[], text) to authenticated;
grant execute on function public.notify_recipients(uuid) to authenticated;
grant execute on function public.pending_changes(uuid) to authenticated;


-- ============================================================
--  Dispatcher: a hand-written notice is sent as written
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
  one     record;
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

  -- 1. anything with its own body goes out on its own, unmerged
  for one in
    select * from public.notification_outbox
    where status = 'pending' and send_after <= now()
      and attempts < 5 and body_html is not null
    limit 20
  loop
    update public.notification_outbox
       set status = 'sending', attempts = attempts + 1 where id = one.id;

    select net.http_post(
      url     := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || api_key,
                                    'Content-Type', 'application/json'),
      body    := jsonb_build_object('from', cfg.from_email,
                                    'to', jsonb_build_array(one.to_email),
                                    'subject', one.subject,
                                    'html', one.body_html)
    ) into req;

    update public.notification_outbox set request_id = req where id = one.id;
    sent := sent + 1;
  end loop;

  -- 2. everything else merges per recipient as before
  for grp in
    select to_email,
           max(to_name)              as to_name,
           min(subject)              as subject,
           array_agg(id order by id) as ids,
           string_agg('<li style="margin:0 0 8px">' || line || '</li>', '' order by id) as items,
           count(*)                  as n
    from public.notification_outbox
    where status = 'pending' and send_after <= now()
      and attempts < 5 and body_html is null
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
      || '<a href="' || cfg.app_url || '" style="display:inline-block;background:#f2c230;'
      || 'color:#17130a;text-decoration:none;font-weight:650;padding:11px 20px;'
      || 'border-radius:8px">Open the tracker</a>'
      || '</div></div>';

    update public.notification_outbox
       set status = 'sending', attempts = attempts + 1 where id = any (ids);

    select net.http_post(
      url     := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || api_key,
                                    'Content-Type', 'application/json'),
      body    := jsonb_build_object('from', cfg.from_email,
                                    'to', jsonb_build_array(grp.to_email),
                                    'subject', case when grp.n > 1
                                        then grp.subject || ' (+' || (grp.n - 1) || ' more)'
                                        else grp.subject end,
                                    'html', body)
    ) into req;

    update public.notification_outbox set request_id = req where id = any (ids);
    sent := sent + 1;
  end loop;

  return sent;
end;
$$;
