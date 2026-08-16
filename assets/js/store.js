// ============================================================
//  Data layer
//
//  One interface, two backends:
//    - "supabase": real, shared, multi-device.
//    - "local":    browser localStorage, used when no anon key is
//      configured. File uploads need Storage, so local mode takes
//      links and notes only.
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cfg = window.APP_CONFIG || {};
const USING_SUPABASE = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

export const MODE = USING_SUPABASE ? 'supabase' : 'local';

const sb = USING_SUPABASE
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
  : null;

const BUCKET = 'attachments';

// ------------------------------------------------------------
//  Vocabulary
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

export const APPROVAL_STATUS = [
  { value: 'pending', label: 'Pending review' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'needs_change', label: 'Needs change' },
];

// The blocks a video is tracked across. Copywriting is a heading
// with three children; everything else is a leaf. Attachments hang
// off leaves only, so there is never an ambiguous place to put a file.
export const BLOCKS = [
  { key: 'thumbnail', field: 'thumbnail_status', label: 'Thumbnails' },
  { key: 'intro',     field: 'intro_status',     label: 'Intro' },
  {
    label: 'Copywriting',
    rollup: 'copy_status',
    children: [
      { key: 'copy_description', field: 'copy_description_status', label: 'Description' },
      { key: 'copy_seo',         field: 'copy_seo_status',         label: 'SEO' },
      // A transcript is either attached or it isn't — tracking it
      // through Not started / In progress / Done says nothing extra,
      // so this block is an attachment slot with no status control.
      { key: 'copy_transcript',  label: 'Transcript', noStatus: true },
    ],
  },
];

// flat list of leaves, for iteration
export const LEAF_BLOCKS = BLOCKS.flatMap((b) => (b.children ? b.children : [b]));

// the three columns shown in the table, plus Status
export const WORK_FIELDS = [
  { key: 'thumbnail_status', label: 'Thumbnails' },
  { key: 'intro_status', label: 'Intro' },
  { key: 'copy_status', label: 'Copywriting' },
];

// ------------------------------------------------------------
//  localStorage backend
// ------------------------------------------------------------
const LS_KEY = 'podcast-tracker-v1';

const lsRead = () => {
  try {
    const db = JSON.parse(localStorage.getItem(LS_KEY)) || {};
    return { clients: db.clients || [], videos: db.videos || [], attachments: db.attachments || [] };
  } catch {
    return { clients: [], videos: [], attachments: [] };
  }
};
const lsWrite = (db) => localStorage.setItem(LS_KEY, JSON.stringify(db));

const uid = () => (crypto.randomUUID && crypto.randomUUID()) ||
  'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const CLIENT_FIELDS = ['channel_name', 'email', 'youtube_url', 'notes', 'is_archived'];

// copy_status is intentionally absent: a database trigger derives it
// from the three subgroups, so sending it would be ignored at best.
const VIDEO_FIELDS = [
  'client_id', 'title', 'episode_no', 'notes',
  'thumbnail_status', 'intro_status',
  'copy_description_status', 'copy_seo_status',
  'status', 'youtube_video_id', 'published_at', 'due_date', 'source',
];

// ------------------------------------------------------------
//  Auth
// ------------------------------------------------------------
export const auth = {
  async signIn(email, password) {
    if (!sb) {
      localStorage.setItem('pt-local-user', email);
      return { user: { email }, error: null };
    }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    return { user: data?.user ?? null, error };
  },

  async signOut() {
    if (!sb) return localStorage.removeItem('pt-local-user');
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

  // Role and display name come from the same row, so fetch once.
  async currentProfile() {
    if (!sb) {
      const email = localStorage.getItem('pt-local-user') || '';
      return {
        role: 'admin',
        full_name: localStorage.getItem('pt-local-name') || titleCase(email.split('@')[0]),
      };
    }
    const { data } = await sb.auth.getSession();
    const id = data?.session?.user?.id;
    if (!id) return null;
    const { data: profile } = await sb
      .from('profiles').select('role, full_name').eq('id', id).single();
    return profile ?? null;
  },

  // Same reasoning as set_approval: an UPDATE policy on your own
  // profile row would also let you edit your own role, so renaming
  // goes through a function that touches one column.
  async setDisplayName(name) {
    if (!sb) {
      const clean = (name || '').trim();
      if (!clean) throw new Error('Name cannot be empty.');
      localStorage.setItem('pt-local-name', clean);
      return clean;
    }
    const { data, error } = await sb.rpc('set_display_name', { p_name: name });
    if (error) throw error;
    return data;
  },
};

function titleCase(s) {
  return String(s || '').replace(/[._-]+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'there';
}

// Staff can change the work; clients can only read it and approve.
export const isStaff = (role) => role === 'admin' || role === 'teammate';

// ------------------------------------------------------------
//  Clients
// ------------------------------------------------------------
export const clients = {
  async list() {
    if (!sb) {
      return lsRead().clients.filter((c) => !c.is_archived)
        .sort((a, b) => a.channel_name.localeCompare(b.channel_name));
    }
    const { data, error } = await sb.from('clients').select('*')
      .eq('is_archived', false).order('channel_name');
    if (error) throw error;
    return data;
  },

  async create(input) {
    const row = pick(input, CLIENT_FIELDS);
    if (!sb) {
      const db = lsRead();
      const rec = { id: uid(), is_archived: false, created_at: new Date().toISOString(), ...row };
      db.clients.push(rec); lsWrite(db); return rec;
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
      lsWrite(db); return rec;
    }
    const { data, error } = await sb.from('clients').update(row).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },
};

// ------------------------------------------------------------
//  Videos
// ------------------------------------------------------------
export const videos = {
  async listByClient(clientId) {
    if (!sb) {
      return lsRead().videos.filter((v) => v.client_id === clientId)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    }
    const { data, error } = await sb.from('videos').select('*')
      .eq('client_id', clientId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  async create(input) {
    const row = {
      thumbnail_status: 'not_started', intro_status: 'not_started',
      copy_description_status: 'not_started', copy_seo_status: 'not_started',
      status: 'to_be_uploaded', source: 'manual',
      ...pick(input, VIDEO_FIELDS),
    };
    if (!sb) {
      const db = lsRead();
      const rec = { id: uid(), created_at: new Date().toISOString(), approval_status: 'pending', ...row };
      rec.copy_status = rollupCopy(rec);
      db.videos.push(rec); lsWrite(db); return rec;
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
      if (rec) { Object.assign(rec, row); rec.copy_status = rollupCopy(rec); }
      lsWrite(db); return rec;
    }
    const { data, error } = await sb.from('videos').update(row).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  async remove(id) {
    if (!sb) {
      const db = lsRead();
      db.videos = db.videos.filter((v) => v.id !== id);
      db.attachments = db.attachments.filter((a) => a.video_id !== id);
      lsWrite(db); return;
    }
    const { error } = await sb.from('videos').delete().eq('id', id);
    if (error) throw error;
  },

  // Clients have no UPDATE policy on videos — RLS grants whole rows,
  // never single columns — so approval goes through an RPC that
  // checks visibility and writes only the approval fields.
  async setApproval(videoId, status, note) {
    if (!sb) {
      const db = lsRead();
      const rec = db.videos.find((v) => v.id === videoId);
      if (rec) {
        rec.approval_status = status;
        rec.approval_note = status === 'needs_change' ? (note || '').trim() : null;
        rec.approval_at = new Date().toISOString();
      }
      lsWrite(db); return rec;
    }
    const { error } = await sb.rpc('set_approval', {
      p_video_id: videoId, p_status: status, p_note: note ?? null,
    });
    if (error) throw error;
  },
};

// mirrors the roll_up_copy_status() trigger, for local mode.
// Transcript is excluded: it has no status to roll up.
function rollupCopy(v) {
  const s = [v.copy_description_status, v.copy_seo_status];
  if (s.every((x) => x === 'done')) return 'done';
  if (s.every((x) => x === 'not_started')) return 'not_started';
  return 'in_progress';
}

// ------------------------------------------------------------
//  Attachments — a file, a link, or pasted text, on any block
// ------------------------------------------------------------
export const attachments = {
  supportsUpload: Boolean(sb),

  async listByVideos(videoIds) {
    if (!videoIds.length) return [];
    if (!sb) return lsRead().attachments.filter((a) => videoIds.includes(a.video_id));
    const { data, error } = await sb.from('attachments').select('*')
      .in('video_id', videoIds).order('created_at');
    if (error) throw error;
    return data;
  },

  async addLink(videoId, block, url, label) {
    return insert({ video_id: videoId, block, kind: 'link', url: url.trim(), label: label?.trim() || null });
  },

  async addNote(videoId, block, body, label) {
    return insert({ video_id: videoId, block, kind: 'note', body: body.trim(), label: label?.trim() || null });
  },

  async addFile(videoId, clientId, block, file) {
    if (!sb) throw new Error('File upload needs Supabase. Add a link instead while in local mode.');

    // {client_id}/{video_id}/... — the first path segment is what the
    // storage policy reads to decide who may download it.
    const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
    const path = `${clientId}/${videoId}/${uid()}_${safe}`;

    const { error: upErr } = await sb.storage.from(BUCKET)
      .upload(path, file, { cacheControl: '3600', upsert: false });
    if (upErr) throw upErr;

    try {
      return await insert({
        video_id: videoId, block, kind: 'file',
        storage_path: path, file_name: file.name,
        mime_type: file.type || null, size_bytes: file.size,
      });
    } catch (e) {
      // don't leave an orphaned object behind if the row insert fails
      await sb.storage.from(BUCKET).remove([path]).catch(() => {});
      throw e;
    }
  },

  async remove(row) {
    if (!sb) {
      const db = lsRead();
      db.attachments = db.attachments.filter((a) => a.id !== row.id);
      lsWrite(db); return;
    }
    const { error } = await sb.from('attachments').delete().eq('id', row.id);
    if (error) throw error;
    if (row.storage_path) await sb.storage.from(BUCKET).remove([row.storage_path]).catch(() => {});
  },

  // The bucket is private, so downloads need a short-lived signed URL.
  async signedUrl(storagePath) {
    if (!sb) return null;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(storagePath, 300);
    if (error) throw error;
    return data.signedUrl;
  },
};

async function insert(row) {
  if (!sb) {
    const db = lsRead();
    const rec = { id: uid(), created_at: new Date().toISOString(), ...row };
    db.attachments.push(rec); lsWrite(db); return rec;
  }
  const { data: sess } = await sb.auth.getSession();
  const { data, error } = await sb.from('attachments')
    .insert({ ...row, created_by: sess?.session?.user?.id ?? null })
    .select().single();
  if (error) throw error;
  return data;
}
