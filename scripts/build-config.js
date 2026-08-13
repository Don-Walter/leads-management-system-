#!/usr/bin/env node
/* ============================================================
   Generates assets/js/config.js from environment variables.

   Runs as the Vercel build command. The browser can't read
   env vars, so they have to be baked into a file at build time.

   Local development needs nothing: with no env vars set, this
   leaves the committed config.js exactly as it is.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(__dirname, '..', 'assets', 'js', 'config.js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;

// ---- nothing to do ----
if (!url && !key) {
  console.log('[build-config] No SUPABASE_* env vars set — keeping the committed config.js.');
  process.exit(0);
}

// ---- half-configured is worse than not configured ----
if (!url || !key) {
  console.error(
    `[build-config] Both variables are required, but ${url ? 'SUPABASE_ANON_KEY' : 'SUPABASE_URL'} is missing.\n` +
    '               Set both in Vercel -> Settings -> Environment Variables, or neither.',
  );
  process.exit(1);
}

/* ------------------------------------------------------------
   Refuse to ship a service_role key to the browser.

   This is the one mistake that would matter: service_role
   bypasses Row Level Security entirely, and anything written
   into config.js is readable by every visitor. Fail the build
   rather than publish it.
   ------------------------------------------------------------ */
function jwtRole(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).role || null;
  } catch {
    return null;   // not a JWT we understand — let it through, the app will fail loudly
  }
}

const role = jwtRole(key);

if (role && role !== 'anon') {
  console.error(
    `\n[build-config] REFUSING TO BUILD: SUPABASE_ANON_KEY contains a "${role}" key.\n\n` +
    '               config.js is served to every visitor. A service_role key there\n' +
    '               grants full read/write on every table, ignoring RLS.\n\n' +
    '               Use the key labelled "anon / public" in\n' +
    '               Project Settings -> API Keys.\n',
  );
  process.exit(1);
}

if (!role) {
  console.warn('[build-config] Warning: SUPABASE_ANON_KEY does not look like a Supabase JWT.');
}

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)) {
  console.warn(`[build-config] Warning: SUPABASE_URL "${url}" is not the usual https://<ref>.supabase.co shape.`);
}

// ---- write it ----
const contents = `// ============================================================
//  GENERATED AT BUILD TIME by scripts/build-config.js
//  Edits here are overwritten on every deploy.
//  Change the values in Vercel -> Settings -> Environment Variables.
// ============================================================

window.APP_CONFIG = {
  SUPABASE_URL: ${JSON.stringify(url.replace(/\/$/, ''))},
  SUPABASE_ANON_KEY: ${JSON.stringify(key)},
};
`;

fs.writeFileSync(TARGET, contents, 'utf8');

console.log(`[build-config] Wrote assets/js/config.js`);
console.log(`[build-config]   url  : ${url}`);
console.log(`[build-config]   key  : ${key.slice(0, 12)}… (role: ${role || 'unknown'})`);
