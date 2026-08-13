// ============================================================
//  Data layer
//
//  One interface, two backends:
//    - "supabase": real, shared, multi-device. Used as soon as
//      an anon key is present in config.js.
//    - "local":    browser localStorage. Lets the tracker be used
//      the moment you open it, before Supabase is wired up.
//
//  Every method returns the same shape in both modes, so nothing
//  above this file needs to know which one is running.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cfg = window.APP_CONFIG || {};
const USING_SUPABASE = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

export const MODE = USING_SUPABASE ? 'supabase' : 'local';

const sb = USING_SUPABASE
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
  : null;

// ------------------------------------------------------------
//  Shared vocabulary — the four blocks
// ------------------------------------------------------------
export const WORK_STATUS = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
];

export const UPLOAD_STATUS = [
  { value: 'to_be_uploaded', label: 'To be uploaded' },
  { value: 'in_process', label: 'In process' },
  { value: 'uploaded', label: 'Uploaded' },
];

export const WORK_FIELDS = [
  { key: 'thumbnail_status', label: 'Thumbnails' },
  { key: 'intro_status', label: 'Intro' },
  { key: 'copy_status', label: 'Copywriting' },
];

// ------------------------------------------------------------
//  localStorage backend
// ------------------------------------------------------------
const LS_KEY = 'podcast-tracker-v1';

function lsRead() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || { clients: [], videos: [] };
  } catch {
    return { clients: [], videos: [] };
  }
}

function lsWrite(db) {
  localStorage.setItem(LS_KEY, JSON.stringify(db));
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Anything the caller sends that isn't a real column would be
// rejected by Postgres, so keep local mode to the same fields.
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const CLIENT_FIELDS = ['channel_name', 'email', 'youtube_url', 'notes', 'is_archived'];
const VIDEO_FIELDS = [
  'client_id', 'title', 'episode_no', 'notes',
  'thumbnail_status', 'intro_status', 'copy_status', 'status',
  'youtube_video_id', 'published_at', 'due_date', 'source',
];

// ------------------------------------------------------------
//  Auth
// ------------------------------------------------------------
export const auth = {
  async signIn(email, password) {
    if (!sb) {
      // Local mode has no real accounts — there is nothing to
      // protect, since the data never leaves this browser.
      localStorage.setItem('pt-local-user', email);
      return { user: { email }, error: null };
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    return { user: data?.user ?? null, error };
  },

  async signOut() {
    if (!sb) {
      localStorage.removeItem('pt-local-user');
      return;
    }
    await sb.auth.signOut();
  },

  async currentUser() {
    if (!sb) {
      const email = localStorage.getItem('pt-local-user');
      return email ? { email } : null;
    }
    const { data } = await sb.auth.getSession();
    return data?.session?.user ?? null;
  },

  // Resolves the caller's role so the UI can hide what they can't do.
  async currentRole() {
    if (!sb) return 'admin';
    const { data } = await sb.auth.getSession();
    const id = data?.session?.user?.id;
    if (!id) return null;
    const { data: profile } = await sb
      .from('profiles').select('role').eq('id', id).single();
    return profile?.role ?? null;
  },

  onChange(fn) {
    if (!sb) return;
    sb.auth.onAuthStateChange((_event, session) => fn(session?.user ?? null));
  },
};

// ------------------------------------------------------------
//  Clients
// ------------------------------------------------------------
export const clients = {
  async list() {
    if (!sb) {
      return lsRead().clients
        .filter((c) => !c.is_archived)
        .sort((a, b) => a.channel_name.localeCompare(b.channel_name));
    }
    const { data, error } = await sb
      .from('clients').select('*')
      .eq('is_archived', false)
      .order('channel_name');
    if (error) throw error;
    return data;
  },

  async create(input) {
    const row = pick(input, CLIENT_FIELDS);
    if (!sb) {
      const db = lsRead();
      const rec = { id: uid(), is_archived: false, created_at: new Date().toISOString(), ...row };
      db.clients.push(rec);
      lsWrite(db);
      return rec;
    }
    const { data, error } = await sb.from('clients').insert(row).select().single();
    if (error) throw error;
    return data;
  },

  async update(id, patch) {
    const row = pick(patch, CLIENT_FIELDS);
    if (!sb) {
      const db = lsRead();
      const rec = db.clients.find((c) => c.id === id);
      if (rec) Object.assign(rec, row);
      lsWrite(db);
      return rec;
    }
    const { data, error } = await sb.from('clients').update(row).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  // Archive rather than delete — an accidental click shouldn't
  // take a client's whole episode history with it.
  async archive(id) {
    return clients.update(id, { is_archived: true });
  },
};

// ------------------------------------------------------------
//  Videos
// ------------------------------------------------------------
export const videos = {
  async listByClient(clientId) {
    if (!sb) {
      return lsRead().videos
        .filter((v) => v.client_id === clientId)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    }
    const { data, error } = await sb
      .from('videos').select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  async create(input) {
    const row = {
      thumbnail_status: 'not_started',
      intro_status: 'not_started',
      copy_status: 'not_started',
      status: 'to_be_uploaded',
      source: 'manual',
      ...pick(input, VIDEO_FIELDS),
    };
    if (!sb) {
      const db = lsRead();
      const rec = { id: uid(), created_at: new Date().toISOString(), ...row };
      db.videos.push(rec);
      lsWrite(db);
      return rec;
    }
    const { data, error } = await sb.from('videos').insert(row).select().single();
    if (error) throw error;
    return data;
  },

  async update(id, patch) {
    const row = pick(patch, VIDEO_FIELDS);
    if (!sb) {
      const db = lsRead();
      const rec = db.videos.find((v) => v.id === id);
      if (rec) Object.assign(rec, row, { updated_at: new Date().toISOString() });
      lsWrite(db);
      return rec;
    }
    const { data, error } = await sb.from('videos').update(row).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  async remove(id) {
    if (!sb) {
      const db = lsRead();
      db.videos = db.videos.filter((v) => v.id !== id);
      lsWrite(db);
      return;
    }
    const { error } = await sb.from('videos').delete().eq('id', id);
    if (error) throw error;
  },
};
