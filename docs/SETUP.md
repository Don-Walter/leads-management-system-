# Setup

Two parts: connect Supabase (the database), then publish to GitHub Pages.
The app already works in local mode — this is what makes it real and shared.

---

## Part 1 — Supabase

### 1. Create the tables

Supabase Dashboard → **SQL Editor** → **New query**.
Paste all of [`supabase/schema.sql`](../supabase/schema.sql) and hit **Run**.

That creates `profiles`, `clients` and `videos`, plus the enums, triggers and
Row Level Security policies. It's safe to re-run.

### 2. Get the anon key

Dashboard → **Project Settings** → **API Keys** → copy the key labelled
**`anon` / `public`**.

> Take the **anon** key, not `service_role`. `service_role` bypasses Row Level
> Security entirely — putting it in a public repo hands over the whole database.

### 3. Put it in the app

Open [`assets/js/config.js`](../assets/js/config.js) and paste it in:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://qppedffzzsavdumwpjdd.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',   // <- here
};
```

Reload. The top-bar pill should now read **Live** instead of **Local**.

### 4. Create the admin login

Dashboard → **Authentication** → **Users** → **Add user**.

Enter the admin email and password, and tick **Auto Confirm User** — otherwise
Supabase waits on an email confirmation and sign-in will fail.

Then grant admin, in the SQL Editor:

```sql
update public.profiles set role = 'admin' where email = 'admin@example.com';
```

**This step is required.** New accounts default to `teammate`, which has no
access yet — skip it and you'll sign in fine but see "Permission denied".

Confirm it took:

```sql
select email, role from public.profiles;
```

---

## Part 2 — GitHub Pages

### 1. Push

```bash
git remote add origin https://github.com/Don-Walter/leads-management-system-.git
git push -u origin main
```

The repo is already initialised and committed locally.

Pushing over HTTPS needs a **Personal Access Token** as the password — GitHub
stopped accepting account passwords in 2021. Create one at
<https://github.com/settings/tokens> with the **`repo`** scope, then use your
username plus that token when prompted.

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
