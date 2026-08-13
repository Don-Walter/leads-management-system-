// ============================================================
//  Runtime configuration
//
//  SAFE TO COMMIT. The anon key is a public, RLS-scoped key —
//  it is meant to ship in the browser. Every table is locked
//  behind Row Level Security (see supabase/schema.sql), so the
//  key alone grants nothing without a login.
//
//  NEVER put the database password or the service_role key in
//  this file. Those are server-side only and this repo is public.
// ============================================================

window.APP_CONFIG = {
  SUPABASE_URL: 'https://qppedffzzsavdumwpjdd.supabase.co',

  // Dashboard -> Project Settings -> API Keys -> "anon / public"
  // Paste it here. Until then the app runs in local demo mode.
  SUPABASE_ANON_KEY: '',
};
