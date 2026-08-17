-- ============================================================
--  AIM Podcast Tracker — v10
--
--  A way to prove the mail path works before switching real
--  notifications on. Sends one email to one address, ignoring
--  the enabled flag, and touching nothing else.
--
--  Safe to re-run.
-- ============================================================

create or replace function public.send_test_email(p_to text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg     public.notification_settings%rowtype;
  api_key text;
  req     bigint;
begin
  if not public.is_admin() and current_user <> 'postgres' then
    raise exception 'Admin only.';
  end if;

  select * into cfg from public.notification_settings where id;

  select decrypted_secret into api_key
  from vault.decrypted_secrets where name = 'RESEND_API_KEY';

  if api_key is null then
    return 'NO KEY — run vault.create_secret(''re_...'', ''RESEND_API_KEY'') first.';
  end if;

  select net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || api_key,
                                  'Content-Type', 'application/json'),
    body    := jsonb_build_object(
      'from', cfg.from_email,
      'to', jsonb_build_array(p_to),
      'subject', 'AIM Podcast Tracker — test',
      'html', '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;'
           || 'background:#0a0908;color:#f3efe6;padding:32px 24px">'
           || '<div style="max-width:520px;margin:0 auto;background:#121110;'
           || 'border:1px solid #2b2721;border-radius:14px;padding:28px">'
           || '<p style="color:#f2c230;font-size:12px;letter-spacing:.12em;'
           || 'text-transform:uppercase;font-weight:700;margin:0 0 18px">AIM Podcast Tracker</p>'
           || '<p style="margin:0 0 8px;font-size:16px">Mail is working.</p>'
           || '<p style="color:#8a8171;font-size:13px;margin:0">'
           || 'Sent from ' || cfg.from_email || '. If you can read this, the key, '
           || 'the domain and the sending path are all correct.</p>'
           || '</div></div>')
  ) into req;

  return 'queued as request ' || req || ' — check status with: select * from public.test_email_result(' || req || ')';
end;
$$;

-- Reads what Resend actually said back, so a failure is legible.
create or replace function public.test_email_result(p_request_id bigint)
returns table (status_code integer, response text, error text)
language sql
security definer
set search_path = public
as $$
  select r.status_code, left(r.content, 500), r.error_msg
  from net._http_response r where r.id = p_request_id;
$$;

revoke all on function public.send_test_email(text) from public;
revoke all on function public.test_email_result(bigint) from public;
grant execute on function public.send_test_email(text) to authenticated;
grant execute on function public.test_email_result(bigint) to authenticated;
