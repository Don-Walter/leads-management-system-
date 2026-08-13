# Deploying to Vercel

## Read this first

This project is **static HTML/CSS/JS with no framework**. `assets/js/config.js`
is loaded by the browser with a plain `<script>` tag, and a browser cannot read
environment variables — `process.env` doesn't exist there.

So env vars only reach the app if something writes them into a file at build
time. That's what [`scripts/build-config.js`](../scripts/build-config.js) does,
wired up as the build command in [`vercel.json`](../vercel.json).

**You do not have to use env vars at all.** The anon key is already committed
(it's public by design, scoped by Row Level Security), so importing the repo
into Vercel and deploying works with zero configuration. Use env vars if you
want to point the same code at different Supabase projects, or change keys
without a commit.

---

## The variables

Exactly two. Both are required together — setting one without the other fails
the build on purpose, rather than deploying something half-configured.

| Name | Value | Environments |
|---|---|---|
| `SUPABASE_URL` | `https://qppedffzzsavdumwpjdd.supabase.co` | Production, Preview, Development |
| `SUPABASE_ANON_KEY` | the **`anon` / `public`** key from Project Settings → API Keys | Production, Preview, Development |

### Do not add these

| Never set | Why |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses Row Level Security completely. Anything in `config.js` is served to every visitor, so this would hand the whole database to anyone who views source. **The build script refuses to run if it finds a `service_role` key in `SUPABASE_ANON_KEY`.** |
| Database password / `postgres://…` | Nothing in this app connects directly to Postgres. Everything goes through PostgREST with the anon key. |

> **Vercel env vars are not secret once they reach the browser.** Vercel keeps
> them private on its servers, but this build *inlines* them into a public JS
> file. A value is only as secret as the file it lands in. That's fine for the
> anon key, which is designed for exactly this — and it's why nothing else
> belongs here.
>
> If the YouTube sync gets built later, its API key is genuinely secret and must
> live in a **Serverless Function**, read via `process.env` on the server. It
> must never go through `build-config.js`.

---

## Setup

### 1. Import the repo

<https://vercel.com/new> → **Import Git Repository** →
`Don-Walter/leads-management-system-`.

Vercel reads `vercel.json`, so leave Framework Preset as **Other**. Build
command and output directory are already configured — don't override them.

### 2. Add the variables

**Settings → Environment Variables.** Add both from the table above, ticking
all three environments.

Order doesn't matter, but if you add them *after* the first deploy you need to
**redeploy** — env vars are read at build time, so an existing deployment won't
pick them up on its own. Deployments → ⋯ → **Redeploy**.

### 3. Point Supabase at the domain

Supabase Dashboard → **Authentication** → **URL Configuration**:

- **Site URL:** your production domain, e.g. `https://leads-management-system.vercel.app`
- **Redirect URLs:** add the same, plus `https://*-don-walter.vercel.app` if you
  want preview deployments to be able to sign in.

Skip this and sign-in will fail on the deployed site while working fine locally.

---

## Checking it worked

The build log should end with:

```
[build-config] Wrote assets/js/config.js
[build-config]   url  : https://qppedffzzsavdumwpjdd.supabase.co
[build-config]   key  : eyJhbGciOiJI… (role: anon)
```

`(role: anon)` is the line worth reading — it confirms what actually got
published.

If you see `No SUPABASE_* env vars set`, the variables aren't reaching the build
and the deploy is using the committed key instead. Working, but not from your
env vars.

On the live site, the login screen should read **"Connected to Supabase"**.

---

## Vercel and GitHub Pages together

Both can serve this repo at once — they're independent. The only shared piece is
Supabase's **Redirect URLs** list, which needs every domain you actually sign in
from:

```
https://don-walter.github.io/leads-management-system-/
https://leads-management-system.vercel.app
http://localhost:4173
```

Pick one as the real one and use the others for testing, otherwise you'll be
maintaining two live sites.

---

## Troubleshooting

**Build fails: `REFUSING TO BUILD: SUPABASE_ANON_KEY contains a "service_role" key`**
— exactly what it says, and it saved you. Swap in the `anon / public` key.

**Build fails: `Both variables are required`** — you set one and not the other.
Add the missing one, or remove both to fall back to the committed config.

**Site loads but says "Local" / no Supabase** — `config.js` wasn't generated
*and* the committed one is empty. Check the build log.

**Sign-in works locally, fails on Vercel** — step 3. The deployed domain isn't in
Supabase's Redirect URLs.

**Changed a variable, nothing happened** — redeploy. Env vars are baked in at
build time, not read live.
