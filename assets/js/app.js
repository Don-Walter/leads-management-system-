// ============================================================
//  Podcast Client Tracker — UI
// ============================================================

import {
  MODE, auth, clients, videos,
  WORK_STATUS, UPLOAD_STATUS, WORK_FIELDS,
} from './store.js';

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  role: null,
  clients: [],
  activeId: null,
  videos: [],
};

// ------------------------------------------------------------
//  helpers
// ------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Every status maps to one of three colours, so a row can be read
// at a glance without anyone parsing the words.
const TONE = {
  not_started: 's-grey',  in_progress: 's-amber', done: 's-green',
  to_be_uploaded: 's-grey', in_process: 's-amber', uploaded: 's-green',
};
const TONE_HEX = { 's-grey': 'var(--grey)', 's-amber': 'var(--amber)', 's-green': 'var(--green)' };

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// Supabase surfaces RLS denials as a permissions error; translate
// that into something that says what to actually do about it.
function explain(err) {
  const msg = err?.message || String(err);
  if (/row-level security|permission denied|violates/i.test(msg)) {
    return 'Permission denied. This login is not marked as an admin yet — ' +
           'see step 4 in docs/SETUP.md.';
  }
  return msg;
}

// ------------------------------------------------------------
//  login
// ------------------------------------------------------------
function showLogin() {
  $('login-view').hidden = false;
  $('app-view').hidden = true;
  $('login-mode').textContent = MODE === 'local'
    ? 'Local mode — no Supabase key set yet, so data is saved in this browser only. ' +
      'Any email and password will get you in.'
    : 'Connected to Supabase.';
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-submit');
  const err = $('login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  const { user, error } = await auth.signIn(
    $('login-email').value.trim(),
    $('login-password').value,
  );

  btn.disabled = false;
  btn.textContent = 'Sign in';

  if (error) {
    err.textContent = error.message;
    err.hidden = false;
    return;
  }
  state.user = user;
  await enterApp();
});

$('sign-out').addEventListener('click', async () => {
  await auth.signOut();
  state.user = null;
  state.activeId = null;
  showLogin();
});

// ------------------------------------------------------------
//  boot
// ------------------------------------------------------------
async function enterApp() {
  state.role = await auth.currentRole();

  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('who').textContent = state.user?.email || '';

  const pill = $('mode-pill');
  pill.textContent = MODE === 'local' ? 'Local' : 'Live';
  pill.className = 'mode-pill ' + (MODE === 'local' ? 'local' : 'live');

  await loadClients();
}

async function loadClients() {
  try {
    state.clients = await clients.list();
  } catch (e) {
    toast(explain(e), true);
    state.clients = [];
  }
  renderClientList();

  if (state.clients.length && !state.clients.some((c) => c.id === state.activeId)) {
    state.activeId = state.clients[0].id;
  }
  if (!state.clients.length) state.activeId = null;

  await loadVideos();
}

async function loadVideos() {
  if (!state.activeId) {
    state.videos = [];
    renderMain();
    return;
  }
  try {
    state.videos = await videos.listByClient(state.activeId);
  } catch (e) {
    toast(explain(e), true);
    state.videos = [];
  }
  renderMain();
}

// ------------------------------------------------------------
//  render: sidebar
// ------------------------------------------------------------
function renderClientList() {
  const box = $('client-list');
  if (!state.clients.length) {
    box.innerHTML = '<p class="sidebar-empty">No clients yet.</p>';
    return;
  }
  box.innerHTML = state.clients.map((c) => `
    <button class="client-item ${c.id === state.activeId ? 'active' : ''}" data-id="${esc(c.id)}">
      <span class="ci-name">${esc(c.channel_name)}</span>
      ${c.email ? `<span class="ci-sub">${esc(c.email)}</span>` : ''}
    </button>`).join('');

  box.querySelectorAll('.client-item').forEach((el) => {
    el.addEventListener('click', async () => {
      state.activeId = el.dataset.id;
      renderClientList();
      await loadVideos();
    });
  });
}

// ------------------------------------------------------------
//  render: main
// ------------------------------------------------------------
function renderMain() {
  const client = state.clients.find((c) => c.id === state.activeId);
  const has = Boolean(client);

  $('client-head').hidden = !has;
  $('stats').hidden = !has || !state.videos.length;
  $('table-wrap').hidden = !has || !state.videos.length;

  if (!has) {
    $('empty-state').innerHTML =
      '<strong>No client selected</strong>Add a podcast client to start tracking episodes.';
    return;
  }

  // ---- heading: channel name + email ----
  $('client-name').textContent = client.channel_name;

  const yt = $('client-youtube');
  if (client.youtube_url) {
    yt.hidden = false;
    yt.href = normaliseYouTube(client.youtube_url);
    yt.textContent = '▶ ' + client.youtube_url.replace(/^https?:\/\/(www\.)?/, '');
  } else {
    yt.hidden = true;
  }

  const em = $('client-email');
  em.hidden = !client.email;
  em.textContent = client.email || '';

  // ---- the four blocks ----
  if (state.videos.length) {
    renderStats();
    renderRows();
    $('empty-state').innerHTML = '';
  } else {
    $('empty-state').innerHTML =
      '<strong>No videos yet</strong>Add an episode to start tracking thumbnails, intro, copywriting and status.';
  }
}

function normaliseYouTube(v) {
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('@')) return 'https://youtube.com/' + s;
  return 'https://' + s;
}

// One card per block, showing how the episodes are distributed.
function renderStats() {
  const blocks = [
    ...WORK_FIELDS.map((f) => ({ ...f, options: WORK_STATUS })),
    { key: 'status', label: 'Status', options: UPLOAD_STATUS },
  ];

  $('stats').innerHTML = blocks.map((b) => {
    const counts = b.options.map((o) => ({
      ...o,
      n: state.videos.filter((v) => v[b.key] === o.value).length,
      tone: TONE[o.value],
    }));
    const total = state.videos.length || 1;

    const bar = counts.map((c) => c.n
      ? `<span style="width:${(c.n / total) * 100}%;background:${TONE_HEX[c.tone]}"></span>`
      : '').join('');

    const legend = counts.map((c) =>
      `<span><i style="background:${TONE_HEX[c.tone]}"></i>${esc(c.label)} ${c.n}</span>`).join('');

    return `<div class="stat">
      <div class="stat-label">${esc(b.label)}</div>
      <div class="stat-bar">${bar}</div>
      <div class="stat-legend">${legend}</div>
    </div>`;
  }).join('');
}

function selectHTML(id, field, value, options) {
  const opts = options.map((o) =>
    `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<select class="status-select ${TONE[value] || 's-grey'}"
                  data-id="${esc(id)}" data-field="${field}">${opts}</select>`;
}

function renderRows() {
  $('video-rows').innerHTML = state.videos.map((v) => {
    const bits = [];
    if (v.episode_no != null && v.episode_no !== '') bits.push('Ep ' + esc(v.episode_no));
    if (v.due_date) bits.push('Due ' + esc(v.due_date));
    if (v.youtube_video_id) {
      bits.push(`<a href="https://youtu.be/${esc(v.youtube_video_id)}" target="_blank" rel="noopener">Watch</a>`);
    }

    return `<tr>
      <td>
        <div class="v-title">${esc(v.title)}</div>
        ${bits.length ? `<div class="v-sub">${bits.join(' · ')}</div>` : ''}
      </td>
      <td>${selectHTML(v.id, 'thumbnail_status', v.thumbnail_status, WORK_STATUS)}</td>
      <td>${selectHTML(v.id, 'intro_status',     v.intro_status,     WORK_STATUS)}</td>
      <td>${selectHTML(v.id, 'copy_status',      v.copy_status,      WORK_STATUS)}</td>
      <td>${selectHTML(v.id, 'status',           v.status,           UPLOAD_STATUS)}</td>
      <td><button class="btn-icon" data-del="${esc(v.id)}" title="Delete video">✕</button></td>
    </tr>`;
  }).join('');

  // Status changes save immediately — this is a tracker, not a form.
  $('video-rows').querySelectorAll('.status-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const { id, field } = sel.dataset;
      const previous = state.videos.find((v) => v.id === id)?.[field];

      sel.className = 'status-select ' + (TONE[sel.value] || 's-grey');
      try {
        await videos.update(id, { [field]: sel.value });
        const row = state.videos.find((v) => v.id === id);
        if (row) row[field] = sel.value;
        renderStats();
      } catch (e) {
        sel.value = previous;                                  // put it back
        sel.className = 'status-select ' + (TONE[previous] || 's-grey');
        toast(explain(e), true);
      }
    });
  });

  $('video-rows').querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const v = state.videos.find((x) => x.id === btn.dataset.del);
      if (!confirm(`Delete "${v?.title}"? This cannot be undone.`)) return;
      try {
        await videos.remove(btn.dataset.del);
        await loadVideos();
        toast('Video deleted.');
      } catch (e) {
        toast(explain(e), true);
      }
    });
  });
}

// ------------------------------------------------------------
//  modal
// ------------------------------------------------------------
let onSave = null;

function openModal(title, fieldsHTML, handler) {
  $('modal-title').textContent = title;
  $('modal-form').innerHTML = fieldsHTML;
  $('modal-error').hidden = true;
  $('modal').hidden = false;
  onSave = handler;
  $('modal-form').querySelector('input, textarea, select')?.focus();
}

function closeModal() {
  $('modal').hidden = true;
  onSave = null;
}

$('modal-cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

// Enter submits, except in the notes textarea.
$('modal-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    $('modal-save').click();
  }
});

$('modal-save').addEventListener('click', async () => {
  if (!onSave) return;
  const data = Object.fromEntries(new FormData($('modal-form')).entries());
  const btn = $('modal-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await onSave(data);
    closeModal();
  } catch (e) {
    $('modal-error').textContent = explain(e);
    $('modal-error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
});

// ------------------------------------------------------------
//  add / edit client
// ------------------------------------------------------------
function clientFields(c = {}) {
  return `
    <label for="f-name">Podcast / channel name</label>
    <input id="f-name" name="channel_name" type="text" required value="${esc(c.channel_name || '')}" />

    <label for="f-email">Client email</label>
    <input id="f-email" name="email" type="email" value="${esc(c.email || '')}" />

    <label for="f-yt">YouTube channel</label>
    <input id="f-yt" name="youtube_url" type="text" placeholder="@handle or full URL"
           value="${esc(c.youtube_url || '')}" />

    <label for="f-notes">Notes</label>
    <textarea id="f-notes" name="notes">${esc(c.notes || '')}</textarea>`;
}

$('add-client-btn').addEventListener('click', () => {
  openModal('Add podcast client', clientFields(), async (data) => {
    if (!data.channel_name.trim()) throw new Error('Channel name is required.');
    const created = await clients.create(data);
    state.activeId = created.id;
    await loadClients();
    toast('Client added.');
  });
});

$('edit-client-btn').addEventListener('click', () => {
  const c = state.clients.find((x) => x.id === state.activeId);
  if (!c) return;
  openModal('Edit client', clientFields(c), async (data) => {
    if (!data.channel_name.trim()) throw new Error('Channel name is required.');
    await clients.update(c.id, data);
    await loadClients();
    toast('Client updated.');
  });
});

// ------------------------------------------------------------
//  add video
// ------------------------------------------------------------
$('add-video-btn').addEventListener('click', () => {
  const statusOpts = UPLOAD_STATUS.map((o) =>
    `<option value="${o.value}">${esc(o.label)}</option>`).join('');

  openModal('Add video', `
    <label for="f-title">Video title</label>
    <input id="f-title" name="title" type="text" required />

    <div class="field-row">
      <div>
        <label for="f-ep">Episode no.</label>
        <input id="f-ep" name="episode_no" type="number" min="0" />
      </div>
      <div>
        <label for="f-due">Due date</label>
        <input id="f-due" name="due_date" type="date" />
      </div>
    </div>

    <label for="f-status">Status</label>
    <select id="f-status" name="status">${statusOpts}</select>

    <label for="f-vid">YouTube video ID <span style="text-transform:none">(if already live)</span></label>
    <input id="f-vid" name="youtube_video_id" type="text" placeholder="dQw4w9WgXcQ" />

    <label for="f-vnotes">Notes</label>
    <textarea id="f-vnotes" name="notes"></textarea>
  `, async (data) => {
    if (!data.title.trim()) throw new Error('Video title is required.');

    // Empty form fields arrive as '' — Postgres wants null for
    // the integer, date and text columns.
    for (const k of ['episode_no', 'due_date', 'youtube_video_id', 'notes']) {
      if (data[k] === '') data[k] = null;
    }
    data.client_id = state.activeId;

    await videos.create(data);
    await loadVideos();
    toast('Video added.');
  });
});

// ------------------------------------------------------------
//  start
// ------------------------------------------------------------
(async function init() {
  const user = await auth.currentUser();
  if (user) {
    state.user = user;
    await enterApp();
  } else {
    showLogin();
  }
})();
