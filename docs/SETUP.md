# Setup

Two parts: connect Supabase (the database), then publish to GitHub Pages.

**Status:** steps 1–3 are done. The schema is applied to project
`qppedffzzsavdumwpjdd` (region `ap-south-1`) and the anon key is in
`config.js`. What's left is step 4 — creating the admin login.

---

## Part 1 — Supabase

### 1. Create the tables ✅ done

Applied via a direct pooler connection. To re-apply or change it later:
Dashboard → **SQL Editor** → **New query** → paste
[`supabase/schema.sql`](../supabase/schema.sql) → **Run**. Safe to re-run.

Verified in place: `profiles`, `clients`, `videos`, all three enums, and RLS
enabled with policies on every table.

### 2. Get the anon key ✅ done

Dashboard → **Project Settings** → **API Keys** → the key labelled
**`anon` / `public`**.

> Take the **anon** key, not `service_role`. `service_role` bypasses Row Level
> Security entirely — putting it in a public repo hands over the whole database.

### 3. Put it in the app ✅ done

It's in [`assets/js/config.js`](../assets/js/config.js). The login screen now
reads "Connected to Supabase" and the top-bar pill reads **Live**.

Confirmed working: an anonymous `SELECT` returns empty, an anonymous `INSERT`
is rejected with Postgres error `42501`, and a bad password is rejected with
"Invalid login credentials".

### 4. Create the admin login ⬅️ you need to do this

**Do these two in order.** Public signups are open right now, and the bootstrap
allowlist in `handle_new_user()` grants admin to `apexideamarketing7@gmail.com`
on first login. Until signups are closed, a stranger could register that address
first and take the admin row with it.

**4a. Close public signups.**
Dashboard → **Authentication** → **Sign In / Providers** → turn off
**Allow new users to sign up**.

**4b. Create the user.**
Dashboard → **Authentication** → **Users** → **Add user**.
Enter the email and password, and tick **Auto Confirm User** — otherwise
Supabase waits on an email confirmation and sign-in fails.

No SQL needed afterwards. The allowlist assigns `role = 'admin'` automatically
on the first login. Verify with:

```sql
select email, role from public.profiles;
```

> Pick a password you have not shared anywhere. Anything sent over chat or
> email should be considered public.

To add another admin later, add the address to the `bootstrap_admins` array in
[`supabase/schema.sql`](../supabase/schema.sql) and re-run the file — or, once
you're signed in as admin, just promote them directly:
>
> ```sql
> update public.profiles set role = 'admin' where email = 'someone@example.com';
> ```

---

## Part 2 — GitHub Pages

### 1. Push

The repo is initialised, committed, and the remote is already set. What's
missing is authentication — this machine has no stored GitHub credentials and
no `gh` CLI.

Create a **Personal Access Token** at <https://github.com/settings/tokens>
with the **`repo`** scope, then push from Terminal:

```bash
git -C /Users/ss/leads push -u origin main
```

When prompted: username `Don-Walter`, password = **the token**, not your
account password (GitHub stopped accepting those in 2021).

The `osxkeychain` credential helper is configured for this repo, so macOS
stores the token after that first push and you won't be asked again.

### 2. Turn on Pages

Repo → **Settings** → **Pages** → Source: **Deploy from a branch** →
Branch **`main`**, folder **`/ (root)`** → **Save**.

The site goes live at:

```
https://don-walter.github.io/leads-management-system-/
```

First deploy takes a minute or two.

### 3. Allow that URL in Supabase

Dashboard → **Authentication** → **URL Configuration** → add the Pages URL to
**Redirect URLs**, and set it as the **Site URL**.

---

## Adding teammates later

The `teammate` role and its policies are already in the schema; they just
aren't granted access yet. When you're ready, run this to let teammates read
clients and update episode statuses without being able to add or delete:

```sql
-- teammates can see clients
drop policy if exists clients_admin_all on public.clients;
create policy clients_read on public.clients
  for select using (public.is_member());
create policy clients_admin_write on public.clients
  for all using (public.is_admin()) with check (public.is_admin());

-- teammates can see videos and move statuses
drop policy if exists videos_admin_all on public.videos;
create policy videos_read on public.videos
  for select using (public.is_member());
create policy videos_update on public.videos
  for update using (public.is_member()) with check (public.is_member());
create policy videos_admin_write on public.videos
  for all using (public.is_admin()) with check (public.is_admin());
```

Then add each teammate under **Authentication → Users**. They land on
`teammate` automatically — no SQL needed per person.

---

---

## Recommended hardening

**Close public signups** — see step 4a. This one is not optional while the
bootstrap allowlist is active.

**Rotate the `service_role` key.** It was shared in chat, and it bypasses RLS
completely. Dashboard → **Project Settings** → **API Keys** → rotate. Nothing in
this project uses it, so rotating breaks nothing.

**Rotate the database password** for the same reason.

**Rotate any GitHub token that was shared in chat.**
<https://github.com/settings/tokens> → revoke → issue a fresh one. A `repo`-scoped
token can push to every repository on the account.

---

## Troubleshooting

**Pill still says "Local"** — `SUPABASE_ANON_KEY` is empty or still has quotes
around a blank string. Hard-reload (Cmd+Shift+R) to clear the cached JS.

**"Permission denied" after signing in** — step 4 wasn't run, or was run with a
different email than the one you logged in with. Check with
`select email, role from public.profiles;`.

**"Invalid login credentials"** — the user wasn't auto-confirmed. Delete and
re-add them with **Auto Confirm User** ticked.

**Blank page** — open the browser console. If it complains about modules, you
opened `index.html` directly; serve it over HTTP instead.

**Push fails: `Permission to ... denied to Don-Walter` (403)** — the token
authenticated but isn't allowed to write. Note the difference: bad credentials
give you `Invalid username or password`, so a 403 means the token is *valid* and
simply lacks permission.

Almost always a **fine-grained** token (one starting `github_pat_`). These grant
nothing by default — both of the following must be set, and missing either one
produces exactly this error:

| Setting | Required value |
|---|---|
| Resource owner | `Don-Walter` |
| Repository access | *All repositories*, or *Only select repositories* **including `leads-management-system-`** |
| Permissions → Repository → **Contents** | **Read and write** |

`Contents: Read and write` is the one people miss — read-only is the default and
it lets you clone but not push. Metadata: Read-only is added automatically.

Note that a fine-grained token scoped to *selected repositories* does not cover
repos created after it was issued; you have to go back and add them.

Edit an existing token at <https://github.com/settings/tokens?type=beta> — the
permission change takes effect immediately, no reissue needed.

A classic token (<https://github.com/settings/tokens/new>) with the single `repo`
scope also works and has fewer moving parts, but it grants access to *every*
repository on the account. The fine-grained one, scoped to this repo alone, is
the better choice for a public project.
