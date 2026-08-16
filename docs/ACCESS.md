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

### 1. Create their login

Dashboard → **Authentication** → **Users** → **Add user**, with
**Auto Confirm User** ticked. They land on `client` with no channels, which sees
nothing at all.

### 2. Set their role

```sql
-- co-founder: everything except managing people
update public.profiles set role = 'teammate' where email = 'them@example.com';
```

Clients need no role change — `client` is already the default.

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
