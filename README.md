# AIM Podcast Tracker

A per-client production tracker for podcast channels. Pick a client, see every
episode, and track each one across five blocks.

A video is identified by its **guest**, not a title — titles get written once the
footage is in, so asking for one up front was asking too early. The episode
title is optional and can be filled in later from **Edit details**.

| Block | Values |
|---|---|
| **Thumbnails** | Not started · In progress · Done |
| **Intro** | Not started · In progress · Done |
| **Copywriting** | Titles · Description & SEO Tags (each with a status) · Transcript (attachment only) |
| **Shorts** | Not started · In progress · Done |
| **Status** | To be uploaded · In process · Uploaded |
| **Client approval** | Pending review · Cleared · Needs change |

Expand any row to reach the detail panel, where every block takes attachments —
an uploaded **file**, a **link** to Drive or Frame.io, or **pasted text**.

Three roles: admin, co-founder, and clients scoped to their own channel.
See [docs/ACCESS.md](docs/ACCESS.md).

The client's **podcast channel name**, **email** and **YouTube channel** sit in the
page heading. Status changes save the moment you pick them.

Static HTML/CSS/JS — no build step, no dependencies to install. Runs on GitHub
Pages, backed by Supabase (Postgres + Auth + Row Level Security).

## Run it

```bash
python3 -m http.server 4173
```

Then open <http://localhost:4173>. It must be served over HTTP — the app uses ES
modules, which `file://` blocks.

## Two modes

The app picks its backend from `assets/js/config.js`:

- **Local** — no Supabase anon key set. Data lives in this browser's
  `localStorage`. Any email/password signs you in. Good for trying it out; not
  shared between devices.
- **Live** — anon key present. Real Supabase auth, shared Postgres data.

The pill in the top bar tells you which one you're in.

To go live, follow [docs/SETUP.md](docs/SETUP.md).

## Layout

```
index.html                app shell + login gate
assets/css/app.css        styling (light + dark)
assets/js/config.js       Supabase URL + anon key
assets/js/store.js        data layer — Supabase or localStorage
assets/js/app.js          UI, rendering, event wiring
assets/img/logo.svg       Apex Idea Marketing mark (topbar + login + favicon)
supabase/schema.sql       base tables, enums, triggers, RLS
supabase/schema-v2.sql    attachments, subgroups, approval, three roles
scripts/build-config.js   regenerates config.js from env vars at deploy time
vercel.json               Vercel build command + security headers
docs/SETUP.md             Supabase + GitHub Pages setup
docs/VERCEL.md            Vercel deployment + environment variables
docs/ACCESS.md            who can see and do what, and how to grant it
```

## Deploying

Works on **GitHub Pages** (no config — see [docs/SETUP.md](docs/SETUP.md)) or
**Vercel** (see [docs/VERCEL.md](docs/VERCEL.md)).

Environment variables are optional. There's no framework here, so the browser
can't read them — `scripts/build-config.js` writes them into `config.js` during
the Vercel build. With none set, the committed config is used as-is and local
development is unaffected.

## Security

- The **anon key** is public by design and safe to commit. Every table is behind
  Row Level Security, so the key alone reads nothing without a login.
- The **database password** and **service_role key** must never be committed.
  This repository is public. `.gitignore` blocks the usual secret filenames, but
  that is a safety net, not a substitute for checking.
- Only users with `role = 'admin'` in `public.profiles` can read or write.
  Signups default to `teammate`, which currently has no access — so a stray
  account can't reach client data.

## Not built yet

- **YouTube sync.** Episodes are added by hand. The schema already carries
  `youtube_video_id`, `published_at` and `source`, so pulling the channel feed
  in is additive. Needs a YouTube Data API key and a small serverless function
  (the key can't live in the browser).
- **Teammate access.** The `teammate` role and its policies exist; the access
  grant is switched on in SQL when you're ready.
