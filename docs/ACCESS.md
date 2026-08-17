# Access control

Three roles. Everyone lands on the most restrictive one and is moved up
deliberately — access is granted, never defaulted.

| | Admin (you) | Co-founder | Client |
|---|---|---|---|
| See all channels | ✅ | ✅ | ❌ only theirs |
| Add / edit / delete clients | ✅ | ✅ | ❌ |
| Add / edit / delete videos | ✅ | ✅ | ❌ |
| Move work statuses | ✅ | ✅ | ❌ |
| Add / remove attachments | ✅ | ✅ | ❌ |
| Download attachments | ✅ | ✅ | ✅ |
| Set approval | ✅ | ✅ | ✅ |
| See the People tab | ✅ | ✅ (read-only) | ❌ |
| **Grant or revoke access** | ✅ | ❌ | ❌ |

Managing people is yours alone. Your co-founder has full run of the work but
cannot widen their own permissions or anyone else's.

## How it is enforced

Not in the browser. Hiding a button stops an honest mistake, not a determined
one — anyone can open the console and call the API directly. The real boundary
is Postgres Row Level Security, which runs inside the database on every query
regardless of what the client sends.

The UI hiding is a convenience on top of that, not the mechanism.

Two pieces are worth knowing about:

**`can_see_client()`** decides visibility. Staff see everything; a client sees a
channel only if there is a row in `client_users` linking them to it.

**`set_approval()`** exists because RLS grants or denies *whole rows* and cannot
restrict individual columns. Giving clients `UPDATE` on `videos` so they could
set `approval_status` would also let them set every other column, including work
statuses. Instead they get no `UPDATE` policy at all, and this one
`SECURITY DEFINER` function is the only way in — it checks visibility, validates
the status, and writes only the approval fields.

## Adding someone

The **People** tab in the tracker is the normal way to do this. It shows who has
joined, their role, which channels each client can see, and when they were last
active. Admins can change roles and channel access there directly.

**Add person** records who someone will be *before* they exist. Fill in their
email, name, role and — for clients — their channels. Then create the login in
Supabase; everything you set is applied automatically on their first sign-in, and
they move from "Waiting to join" to "Joined".

Creating the login is the one step that stays in the Supabase dashboard.

The SQL below does the same thing by hand, if you'd rather.

### 1. Create their login

Dashboard → **Authentication** → **Users** → **Add user**, with
**Auto Confirm User** ticked. They land on `client` with no channels, which sees
nothing at all.

### 2. Set their role

Two addresses are on a bootstrap list in `handle_new_user()` and get their role
automatically on first login — no SQL needed:

| Address | Role | Display name |
|---|---|---|
| `apexideamarketing7@gmail.com` | admin | |
| `shay999.in@gmail.com` | teammate | Shay |

For anyone else:

```sql
-- co-founder: everything except managing people
update public.profiles set role = 'teammate' where email = 'them@example.com';
```

Clients need no role change — `client` is already the default.

To put another teammate on the bootstrap list, add their address to the
`bootstrap_teammates` array in [`supabase/schema-v3.sql`](../supabase/schema-v3.sql)
and re-run that file.

### 3. For clients, link them to their channel

```sql
insert into public.client_users (client_id, user_id)
select c.id, p.id
from public.clients c, public.profiles p
where c.channel_name = 'Accounting Voices'
  and p.email = 'rob@accountingvoices.com';
```

One row per channel. A client with two shows gets two rows; a client with none
sees an empty tracker rather than an error.

### Check who has what

```sql
select p.email, p.role, coalesce(string_agg(c.channel_name, ', '), '—') as channels
from public.profiles p
left join public.client_users cu on cu.user_id = p.id
left join public.clients c on c.id = cu.client_id
group by p.email, p.role
order by p.role, p.email;
```

### Revoke

```sql
-- one channel
delete from public.client_users
where user_id = (select id from public.profiles where email = 'them@example.com');

-- all access: delete the user in Authentication → Users
```

## Attachments

Every block — Thumbnails, Intro, and each of Description, SEO and Transcript —
takes three kinds:

- **File** — uploaded to a private Supabase Storage bucket. 50 MB cap.
- **Link** — Drive, Frame.io, Dropbox, anywhere. Better than uploading for large
  video files.
- **Text** — pasted directly. Handy for descriptions, tag lists and transcripts,
  which are read far more often than they are downloaded.

Files are stored at `{client_id}/{video_id}/{uuid}_{filename}`. The first path
segment is the client, so the storage policy reuses `can_see_client()` and
download permission matches what the person can already see in the tracker.

The bucket is private. Downloads go through short-lived signed URLs generated on
demand, so a copied link stops working after five minutes.

## Approval

Clients mark each video **Pending review**, **Cleared**, or **Needs change**.
"Needs change" requires a note saying what — enforced in three places: the form,
the `set_approval()` function, and a table constraint. Even a direct API call
cannot record a change request with no explanation.

## Copywriting rollup

The Copywriting column in the table is derived from its three subgroups by a
database trigger: all done → Done, all untouched → Not started, anything else →
In progress. It cannot be set directly, so the summary and the detail can never
disagree.

## Seeing it for yourself

**View as client** in the channel header renders the tracker exactly as that
channel's client sees it: their one channel, read-only, no People tab, no role
badge. A gold bar across the top makes it obvious you are in it.

Every write is refused while it is on. The session underneath is still yours, so
without that guard, approving something "as the client" would really approve it.

It shows the *experience*, not the boundary. What a client can actually reach is
enforced by Row Level Security in the database — proven by the role tests, not by
this. A preview that hid buttons would prove nothing on its own.

## What a client sees

A client is never labelled one in their own view. The role badge is shown to
staff only, so Rob signing in sees "Welcome, Rob" and no mention of being a
client. The People tab still shows you his role — that page is staff-only.

The welcome screen names his channel underneath, since a client belongs to one
show; staff see the agency name instead.

## Display names

The tracker greets everyone by name — "Welcome, Shay". The name comes from
`profiles.full_name`, resolved on first login in this order:

1. a name supplied at signup
2. the `known_names` map in `handle_new_user()` (this is what makes Shay "Shay"
   rather than "Shay999 In")
3. the email's local part, title-cased

Anyone can change their own by clicking their name in the top bar.

That goes through `set_display_name()` rather than a direct update, for the same
reason as `set_approval()`: an UPDATE policy letting someone edit their own
profile row would also let them edit their own `role`. The function touches one
column and nothing else.

## Guard rails on managing people

- You cannot demote yourself or revoke your own access. One wrong click would
  otherwise leave the project with nobody who can grant access to anyone.
- Promoting a client to staff clears their channel mappings, since staff see
  everything and a stale mapping would be misleading.
- **Revoke** drops someone to `client` with no channels — they keep their login
  but see nothing. Deleting the login itself is a dashboard action, deliberately
  kept out of the tracker.
- Invite emails are lower-cased on write, so `Rob@Example.com` and
  `rob@example.com` cannot become two different invites.

## Notifications

Outbound updates are deliberate. Work happening in the tracker is **logged**,
not emailed — pressing **Notify…** in an expanded row is what sends it.

The panel shows everything that has changed since the last time anyone notified
about that episode, a tick list of who can be told, and an optional note. The
client is ticked by default; staff are not, since you are both in the tracker
already. It refuses to send if nothing has changed and no note was written.

Two things stay automatic, because they are the cases where waiting for a human
to press a button would break the loop:

- **A client's verdict.** Rob approves or requests changes and the team hears
  immediately. He will never press Notify to pass that on.
- **Deadline reminders.** Forgetting is the exact problem they exist to solve.

This also means a client never sees half-finished work land in their inbox. You
attach a rough cut, nothing happens; you press Notify when it is genuinely ready.

Recipients are validated server-side — `notify_now()` silently drops anyone
picked who cannot see that channel, so a stale UI can never leak an update to
the wrong client.
