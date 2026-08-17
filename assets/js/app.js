// ============================================================
//  Podcast Client Tracker — UI
// ============================================================

import {
  MODE, auth, clients, videos, attachments, people, invites, notify, live, isStaff,
  WORK_STATUS, UPLOAD_STATUS, APPROVAL_STATUS, WORK_FIELDS, BLOCKS, LEAF_BLOCKS,
  ROLES, roleLabel,
} from './store.js';

const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  role: null,
  staff: false,
  name: '',
  clients: [],
  activeId: null,
  videos: [],
  attachments: [],
  expanded: new Set(),
  tab: 'tracker',
  people: [],
  invites: [],
  preview: false,      // staff looking at the tracker as a client would
  unsubscribe: null,
  pendingRefresh: false,
};

// ------------------------------------------------------------
//  helpers
// ------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TONE = {
  not_started: 's-grey', in_progress: 's-amber', done: 's-green',
  to_be_uploaded: 's-grey', in_process: 's-amber', uploaded: 's-green',
  pending: 's-grey', cleared: 's-green', needs_change: 's-red',
};
const TONE_HEX = {
  's-grey': 'var(--grey)', 's-amber': 'var(--amber)',
  's-green': 'var(--green)', 's-red': 'var(--red)',
};

const labelOf = (opts, v) => opts.find((o) => o.value === v)?.label ?? v;

// Preview mode renders exactly what a client gets. The session underneath
// is still staff, so nothing may be written while it is on — otherwise you
// would change real data while pretending to be someone who cannot.
const canEdit = () => state.staff && !state.preview;
const viewingAs = () => (state.preview ? 'client' : state.role);

// A due date is only worth flagging while the thing is still outstanding.
// Once it is uploaded, "overdue" is noise.
function dueLabel(v) {
  if (!v.due_date) return null;
  if (v.status === 'uploaded') return 'Due ' + esc(v.due_date);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(v.due_date + 'T00:00:00');
  const days = Math.round((due - today) / 86400000);

  if (days < 0)  return `<span class="due overdue">Overdue by ${-days} day${days === -1 ? '' : 's'}</span>`;
  if (days === 0) return '<span class="due soon">Due today</span>';
  if (days <= 2) return `<span class="due soon">Due in ${days} day${days === 1 ? '' : 's'}</span>`;
  return 'Due ' + esc(v.due_date);
}

function fileSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

function explain(err) {
  const msg = err?.message || String(err);
  if (/row-level security|permission denied|violates row/i.test(msg)) {
    return state.staff
      ? 'Permission denied. This login is not marked as an admin yet — see docs/SETUP.md.'
      : 'Your account has read-only access to this channel.';
  }
  if (/Payload too large|exceeded the maximum/i.test(msg)) return 'That file is over the 50 MB limit.';
  return msg;
}

// ------------------------------------------------------------
//  login
// ------------------------------------------------------------
function showLogin() {
  $('login-view').hidden = false;
  $('app-view').hidden = true;
  // Nothing about the backend belongs on a screen a client sees. The
  // local-mode warning stays, because that one is aimed at whoever is
  // developing and says data is not really being saved.
  const dev = MODE === 'local';
  $('login-mode').hidden = !dev;
  $('login-mode').textContent = dev
    ? 'Local mode — no Supabase key set, so data is saved in this browser only. Any email and password will get you in.'
    : '';
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-submit'), err = $('login-error');
  err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';

  const { user, error } = await auth.signIn($('login-email').value.trim(), $('login-password').value);

  btn.disabled = false; btn.textContent = 'Sign in';
  if (error) { err.textContent = error.message; err.hidden = false; return; }
  state.user = user;
  sessionStorage.removeItem(GREETED_KEY);
  await enterApp({ greet: true });
});

$('forgot-btn').addEventListener('click', () => {
  openModal('Reset your password', `
    <label for="f-remail">Your email</label>
    <input id="f-remail" name="email" type="email" required
           value="${esc($('login-email').value.trim())}" />
    <p class="hint">We'll email you a link to set a new password. It expires in an hour.</p>
  `, async (data) => {
    if (!data.email?.trim()) throw new Error('Enter your email first.');
    await auth.requestPasswordReset(data.email);
    // Never reveal whether an address has an account — that would let
    // anyone test which emails are registered.
    toast('If that email has an account, a reset link is on its way.');
  });
});

// ---- arriving from a recovery email ----
function showRecovery() {
  $('login-view').hidden = true;
  $('app-view').hidden = true;
  $('recovery-view').hidden = false;
  $('rec-pass').focus();
}

$('recovery-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('rec-submit'), err = $('rec-error');
  err.hidden = true;

  if ($('rec-pass').value !== $('rec-pass2').value) {
    err.textContent = 'Those two do not match.';
    err.hidden = false;
    return;
  }

  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await auth.updatePassword($('rec-pass').value);
    // drop the recovery token out of the address bar
    history.replaceState(null, '', location.pathname);
    $('recovery-view').hidden = true;
    state.user = await auth.currentUser();
    await enterApp();
    toast('Password updated. You are signed in.');
  } catch (ex) {
    err.textContent = explain(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Save password';
  }
});

$('sign-out').addEventListener('click', async () => {
  await auth.signOut();
  stopLive();
  sessionStorage.removeItem(GREETED_KEY);
  Object.assign(state, {
    user: null, role: null, staff: false, name: '', activeId: null,
    expanded: new Set(), tab: 'tracker', people: [], invites: [], preview: false,
    unsubscribe: null, pendingRefresh: false,
  });
  showTab('tracker');
  showLogin();
});


// ------------------------------------------------------------
//  Welcome splash
//
//  Shown on sign-in, and once per browser tab thereafter. Showing
//  it on every reload would turn a nice moment into a delay.
// ------------------------------------------------------------
const GREETED_KEY = 'pt-greeted';

function welcomeSubtitle(role) {
  return { admin: 'Apex Idea Marketing', teammate: 'Apex Idea Marketing' }[role]
    || (state.clients[0]?.channel_name ?? '');
}

function showWelcome(name, role) {
  return new Promise((resolve) => {
    const el = $('welcome-view');
    $('welcome-text').textContent = `Welcome, ${name}`;
    $('welcome-sub').textContent = welcomeSubtitle(role);
    el.classList.remove('leaving');
    el.hidden = false;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hold = reduced ? 900 : 1700;

    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => {
        el.hidden = true;
        el.classList.remove('leaving');
        resolve();
      }, reduced ? 0 : 450);
    }, hold);
  });
}

// ------------------------------------------------------------
//  boot
// ------------------------------------------------------------
async function enterApp({ greet = false } = {}) {
  const profile = await auth.currentProfile();
  state.role  = profile?.role ?? null;
  state.staff = isStaff(state.role);
  state.name  = profile?.full_name || '';

  $('login-view').hidden = true;
  $('app-view').hidden = false;
  renderGreeting();

  // "Live" tells a client nothing and reads as debug output. Only the
  // local-mode warning is worth showing, and only to whoever set it.
  const pill = $('mode-pill');
  pill.hidden = MODE !== 'local';
  pill.textContent = 'Local';
  pill.className = 'mode-pill local';

  // Staff see what they are; a client is just themselves. The People
  // tab still shows you that they're a client — this is only their view.
  const rolePill = $('role-pill');
  const staffLabel = { admin: 'Admin', teammate: 'Team' }[state.role];
  rolePill.hidden = !staffLabel;
  if (staffLabel) {
    rolePill.textContent = staffLabel;
    rolePill.className = 'role-pill ' + state.role;
  }

  // clients cannot create anything — hide rather than fail on click
  $('tabs').hidden = !state.staff;      // clients have no roster to see
  $('add-person-btn').hidden = state.role !== 'admin';
  $('add-client-btn').hidden = !state.staff;
  $('add-video-btn').hidden = !state.staff;
  $('edit-client-btn').hidden = !state.staff;

  await loadClients();

  // greeting comes after the data loads, so the tracker is ready
  // behind it rather than flashing empty when it clears
  if (greet || !sessionStorage.getItem(GREETED_KEY)) {
    sessionStorage.setItem(GREETED_KEY, '1');
    await showWelcome(state.name || 'there', state.role);
  }
}

// Everything that shows or hides based on who is looking. Called on
// entry and again whenever preview mode is toggled.
function applyChrome() {
  const role = viewingAs();
  const editor = canEdit();

  // Staff see what they are; a client is just themselves. The People
  // tab still shows you that they're a client — this is only their view.
  const rolePill = $('role-pill');
  const staffLabel = { admin: 'Admin', teammate: 'Team' }[role];
  rolePill.hidden = !staffLabel;
  if (staffLabel) {
    rolePill.textContent = staffLabel;
    rolePill.className = 'role-pill ' + role;
  }

  $('tabs').hidden = !editor;           // clients have no roster to see
  $('add-person-btn').hidden = state.role !== 'admin';
  $('add-client-btn').hidden = !editor;
  $('add-video-btn').hidden = !editor;
  $('edit-client-btn').hidden = !editor;
  $('preview-btn').hidden = !state.staff || state.preview;
  $('preview-bar').hidden = !state.preview;
}

// The greeting falls back through display name -> email local part ->
// "there", so it never renders as "Welcome, undefined".
function renderGreeting() {
  const name = state.name || (state.user?.email || '').split('@')[0] || 'there';
  const el = $('who');
  el.textContent = `Welcome, ${name}`;
  el.title = `Signed in as ${state.user?.email || ''} — click to change your name`;
}

$('who').addEventListener('click', () => {
  openModal('Your account', `
    <label for="f-dname">Display name</label>
    <input id="f-dname" name="name" type="text" maxlength="60"
           value="${esc(state.name)}" placeholder="e.g. Shay" />
    <p class="hint">The name the tracker greets you by.</p>

    <label for="f-pw1">New password <span class="opt">(leave blank to keep it)</span></label>
    <input id="f-pw1" name="pw1" type="password" autocomplete="new-password" placeholder="At least 8 characters" />

    <label for="f-pw2">Confirm new password</label>
    <input id="f-pw2" name="pw2" type="password" autocomplete="new-password" />
  `, async (data) => {
    const wantsPw = Boolean(data.pw1 || data.pw2);
    if (wantsPw && data.pw1 !== data.pw2) throw new Error('Those two passwords do not match.');

    if (data.name?.trim() && data.name.trim() !== state.name) {
      state.name = await auth.setDisplayName(data.name);
      renderGreeting();
    }
    if (wantsPw) await auth.updatePassword(data.pw1);

    toast(wantsPw ? 'Password updated.' : 'Name updated.');
  });
});

async function loadClients() {
  try {
    state.clients = await clients.list();
  } catch (e) { toast(explain(e), true); state.clients = []; }

  renderClientList();
  if (state.clients.length && !state.clients.some((c) => c.id === state.activeId)) {
    state.activeId = state.clients[0].id;
  }
  if (!state.clients.length) state.activeId = null;
  await loadVideos();
}

async function loadVideos() {
  if (!state.activeId) { state.videos = []; state.attachments = []; return renderMain(); }
  try {
    state.videos = await videos.listByClient(state.activeId);
    state.attachments = await attachments.listByVideos(state.videos.map((v) => v.id));
  } catch (e) {
    toast(explain(e), true);
    state.videos = []; state.attachments = [];
  }
  renderMain();
}

// ------------------------------------------------------------
//  sidebar
// ------------------------------------------------------------
function renderClientList() {
  const box = $('client-list');
  // a client is scoped to their channels, so preview shows just this one
  const list = state.preview
    ? state.clients.filter((c) => c.id === state.activeId)
    : state.clients;

  if (!list.length) {
    box.innerHTML = `<p class="sidebar-empty">${canEdit()
      ? 'No clients yet.'
      : 'No channel has been shared with your account yet.'}</p>`;
    return;
  }
  box.innerHTML = list.map((c) => `
    <button class="client-item ${c.id === state.activeId ? 'active' : ''}" data-id="${esc(c.id)}">
      <span class="ci-name">${esc(c.channel_name)}</span>
      ${c.email ? `<span class="ci-sub">${esc(c.email)}</span>` : ''}
    </button>`).join('');

  box.querySelectorAll('.client-item').forEach((el) => {
    el.addEventListener('click', async () => {
      state.activeId = el.dataset.id;
      state.expanded.clear();
      renderClientList();
      await loadVideos();
    });
  });
}

// ------------------------------------------------------------
//  main
// ------------------------------------------------------------
function renderMain() {
  const client = state.clients.find((c) => c.id === state.activeId);
  const has = Boolean(client);

  $('client-head').hidden = !has;
  $('stats').hidden = !has || !state.videos.length;
  $('table-wrap').hidden = !has || !state.videos.length;

  if (!has) {
    $('empty-state').innerHTML = canEdit()
      ? '<strong>No client selected</strong>Add a podcast client to start tracking episodes.'
      : '<strong>Nothing shared yet</strong>Ask your producer to give your account access to a channel.';
    return;
  }

  $('client-name').textContent = client.channel_name;

  const yt = $('client-youtube');
  if (client.youtube_url) {
    yt.hidden = false;
    yt.href = normaliseYouTube(client.youtube_url);
    yt.textContent = '▶ ' + client.youtube_url.replace(/^https?:\/\/(www\.)?/, '');
  } else yt.hidden = true;

  const em = $('client-email');
  em.hidden = !client.email;
  em.textContent = client.email || '';

  if (state.videos.length) {
    renderStats(); renderRows(); $('empty-state').innerHTML = '';
  } else {
    $('empty-state').innerHTML = canEdit()
      ? '<strong>No videos yet</strong>Add an episode to start tracking thumbnails, intro, copywriting and status.'
      : '<strong>No videos yet</strong>Nothing has been added to this channel.';
  }
}

function normaliseYouTube(v) {
  const s = v.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://' + (s.startsWith('@') ? 'youtube.com/' + s : s);
}

function renderStats() {
  const blocks = [
    ...WORK_FIELDS.map((f) => ({ ...f, options: WORK_STATUS })),
    { key: 'status', label: 'Status', options: UPLOAD_STATUS },
    { key: 'approval_status', label: 'Client approval', options: APPROVAL_STATUS },
  ];

  $('stats').innerHTML = blocks.map((b) => {
    const counts = b.options.map((o) => ({
      ...o,
      n: state.videos.filter((v) => (v[b.key] ?? 'pending') === o.value).length,
      tone: TONE[o.value],
    }));
    const total = state.videos.length || 1;
    const bar = counts.map((c) => c.n
      ? `<span style="width:${(c.n / total) * 100}%;background:${TONE_HEX[c.tone]}"></span>` : '').join('');
    const legend = counts.map((c) =>
      `<span><i style="background:${TONE_HEX[c.tone]}"></i>${esc(c.label)} ${c.n}</span>`).join('');
    return `<div class="stat">
      <div class="stat-label">${esc(b.label)}</div>
      <div class="stat-bar">${bar}</div>
      <div class="stat-legend">${legend}</div>
    </div>`;
  }).join('');
}

// A dropdown for staff, a static pill for clients. Same colours either
// way, so the board reads identically no matter who is looking at it.
function statusControl(id, field, value, options, editable) {
  const tone = TONE[value] || 's-grey';
  if (!editable) {
    return `<span class="status-pill ${tone}">${esc(labelOf(options, value))}</span>`;
  }
  const opts = options.map((o) =>
    `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<select class="status-select ${tone}" data-id="${esc(id)}" data-field="${field}">${opts}</select>`;
}

function attachCount(videoId, block) {
  return state.attachments.filter((a) => a.video_id === videoId && a.block === block).length;
}

function renderRows() {
  const editable = canEdit();

  $('video-rows').innerHTML = state.videos.map((v) => {
    const bits = [];
    if (v.episode_no != null && v.episode_no !== '') bits.push('Ep ' + esc(v.episode_no));
    const due = dueLabel(v);
    if (due) bits.push(due);
    if (v.youtube_video_id) bits.push(`<a href="https://youtu.be/${esc(v.youtube_video_id)}" target="_blank" rel="noopener">Watch</a>`);

    const files = LEAF_BLOCKS.reduce((n, b) => n + attachCount(v.id, b.key), 0);
    if (files) bits.push(`${files} file${files === 1 ? '' : 's'}`);

    const open = state.expanded.has(v.id);
    const approval = v.approval_status || 'pending';

    return `<tr class="v-row ${open ? 'open' : ''}" data-row="${esc(v.id)}"
             role="button" tabindex="0" aria-expanded="${open}">
      <td class="col-exp">
        <button class="expander ${open ? 'open' : ''}" data-exp="${esc(v.id)}"
                aria-label="${open ? 'Collapse' : 'Expand'} ${esc(v.guest_name || '')}">▸</button>
      </td>
      <td>
        <div class="v-title">${esc(v.guest_name || v.title || 'Untitled')}</div>
        ${v.title ? `<div class="v-episode">${esc(v.title)}</div>` : ''}
        ${bits.length ? `<div class="v-sub">${bits.join(' · ')}</div>` : ''}
      </td>
      <td>${statusControl(v.id, 'thumbnail_status', v.thumbnail_status, WORK_STATUS, editable)}</td>
      <td>${statusControl(v.id, 'intro_status', v.intro_status, WORK_STATUS, editable)}</td>
      <td>${statusControl(v.id, 'copy_status', v.copy_status, WORK_STATUS, false)}</td>
      <td>${statusControl(v.id, 'shorts_status', v.shorts_status, WORK_STATUS, editable)}</td>
      <td>${statusControl(v.id, 'status', v.status, UPLOAD_STATUS, editable)}</td>
      <td>
        <button class="status-pill btn-pill ${TONE[approval]}" data-approve="${esc(v.id)}">
          ${esc(labelOf(APPROVAL_STATUS, approval))}
        </button>
        ${approval === 'needs_change' && v.approval_note
          ? `<div class="v-sub note">“${esc(v.approval_note)}”</div>` : ''}
      </td>
      <td>${editable ? `<button class="btn-icon" data-del="${esc(v.id)}" title="Delete video">✕</button>` : ''}</td>
    </tr>
    ${open ? detailRow(v, editable) : ''}`;
  }).join('');

  wireRows();
}

// ------------------------------------------------------------
//  expanded detail: every block, with its attachments
// ------------------------------------------------------------
function detailRow(v, canEdit) {
  const section = (leaf, nested) => `
    <div class="blk ${nested ? 'nested' : ''}">
      <div class="blk-head">
        <span class="blk-name">${esc(leaf.label)}</span>
        ${leaf.noStatus ? '' : statusControl(v.id, leaf.field, v[leaf.field], WORK_STATUS, canEdit)}
        ${canEdit ? `<button class="btn btn-sm btn-ghost" data-add-att="${esc(v.id)}"
                      data-block="${leaf.key}">+ Add</button>` : ''}
      </div>
      ${attachmentList(v.id, leaf.key, canEdit)}
    </div>`;

  const body = BLOCKS.map((b) => b.children
    ? `<div class="blk group">
         <div class="blk-head">
           <span class="blk-name">${esc(b.label)}</span>
           ${statusControl(v.id, b.rollup, v[b.rollup], WORK_STATUS, false)}
         </div>
         ${b.children.map((c) => section(c, true)).join('')}
       </div>`
    : section(b, false)).join('');

  return `<tr class="detail-row"><td colspan="9">
    <div class="detail">
      ${canEdit ? `<div class="detail-bar">
        <button class="btn btn-sm btn-ghost" data-edit-video="${esc(v.id)}">Edit details</button>
        <button class="btn btn-sm btn-primary" data-notify="${esc(v.id)}">Notify…</button>
      </div>` : ''}
      ${body}
      ${v.notes ? `<div class="blk"><div class="blk-head"><span class="blk-name">Notes</span></div>
        <p class="att-note">${esc(v.notes)}</p></div>` : ''}
    </div>
  </td></tr>`;
}

function attachmentList(videoId, block, canEdit) {
  const rows = state.attachments.filter((a) => a.video_id === videoId && a.block === block);
  if (!rows.length) return '<p class="att-empty">Nothing attached yet.</p>';

  return `<ul class="att-list">${rows.map((a) => {
    const name = a.label || a.file_name || a.url || 'Note';
    let main;
    if (a.kind === 'file') {
      main = `<button class="att-link" data-dl="${esc(a.id)}">${esc(name)}</button>
              <span class="att-meta">${esc(fileSize(a.size_bytes))}</span>`;
    } else if (a.kind === 'link') {
      let host = '';
      try { host = new URL(a.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
      main = `<a class="att-link" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer"
                 title="${esc(a.url)}">${esc(name)}</a>${
        host ? `<span class="att-meta">${esc(host)}</span>` : ''}`;
    } else {
      main = `<span class="att-link static">${esc(name)}</span>
              <p class="att-note">${esc(a.body)}</p>`;
    }
    const icon = { file: '📎', link: '🔗', note: '📝' }[a.kind];
    return `<li class="att">
      <span class="att-kind" title="${a.kind}">${icon}</span>
      <div class="att-body">${main}</div>
      ${canEdit ? `<button class="btn-icon" data-att-del="${esc(a.id)}" title="Remove">✕</button>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

// ------------------------------------------------------------
//  row wiring
// ------------------------------------------------------------
function wireRows() {
  const rows = $('video-rows');

  const toggle = (id) => {
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    renderRows();
  };

  // Clicking anywhere on the row opens it, not just the arrow — but
  // not when the click landed on a control, or the dropdown you were
  // reaching for would collapse the row out from under you.
  rows.querySelectorAll('.v-row').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('select, button, a, input, label')) return;
      if (window.getSelection()?.toString()) return;   // let text selection be
      toggle(tr.dataset.row);
    });
  });

  rows.querySelectorAll('[data-exp]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(btn.dataset.exp); });
  });

  rows.querySelectorAll('.status-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const { id, field } = sel.dataset;
      const row = state.videos.find((v) => v.id === id);
      const previous = row?.[field];
      sel.className = 'status-select ' + (TONE[sel.value] || 's-grey');
      try {
        const updated = await videos.update(id, { [field]: sel.value });
        if (row) Object.assign(row, updated || { [field]: sel.value });
        renderStats();
        // the Copywriting cell is derived, so redraw when a subgroup moves
        if (field.startsWith('copy_')) renderRows();
      } catch (e) {
        sel.value = previous;
        sel.className = 'status-select ' + (TONE[previous] || 's-grey');
        toast(explain(e), true);
      }
    });
  });

  rows.querySelectorAll('[data-notify]').forEach((btn) =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); openNotify(btn.dataset.notify); }));

  rows.querySelectorAll('[data-edit-video]').forEach((btn) =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); openEditVideo(btn.dataset.editVideo); }));

  rows.querySelectorAll('[data-approve]').forEach((btn) =>
    btn.addEventListener('click', () => openApproval(btn.dataset.approve)));

  rows.querySelectorAll('[data-add-att]').forEach((btn) =>
    btn.addEventListener('click', () => openAttach(btn.dataset.addAtt, btn.dataset.block)));

  rows.querySelectorAll('[data-dl]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const a = state.attachments.find((x) => x.id === btn.dataset.dl);

      // Open the tab synchronously, while the click is still the active
      // user gesture — doing it after awaiting the signed URL gets it
      // blocked as a popup.
      //
      // NOT window.open(..., 'noopener'): that feature makes window.open
      // return null, which previously looked like "popup blocked" and sent
      // the tracker itself to the file. Sever the opener afterwards instead.
      const tab = window.open('', '_blank');
      if (tab) {
        try { tab.opener = null; } catch { /* cross-origin, already safe */ }
        tab.document.write(
          '<title>Opening…</title><body style="background:#0a0908;color:#8a8171;' +
          'font:15px -apple-system,Segoe UI,Roboto,sans-serif;display:grid;' +
          'place-items:center;height:100vh;margin:0">Opening ' +
          esc(a.file_name || 'file') + '…</body>');
      }

      try {
        const url = await attachments.signedUrl(a.storage_path);
        if (tab) tab.location.replace(url);
        else toast('Your browser blocked the popup. Allow popups for this site and try again.', true);
      } catch (err) {
        // Never navigate the tracker away on failure — that loses the page
        // the person was working on.
        if (tab) tab.close();
        toast(explain(err), true);
      }
    });
  });

  rows.querySelectorAll('[data-att-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const a = state.attachments.find((x) => x.id === btn.dataset.attDel);
      if (!confirm(`Remove "${a.label || a.file_name || a.url || 'this note'}"?`)) return;
      try {
        await attachments.remove(a);
        state.attachments = state.attachments.filter((x) => x.id !== a.id);
        renderRows();
        toast('Removed.');
      } catch (e) { toast(explain(e), true); }
    });
  });

  rows.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const v = state.videos.find((x) => x.id === btn.dataset.del);
      if (!confirm(`Delete "${v?.guest_name || v?.title}" and everything attached to it?\n\n` +
        'Every file, link and note on it goes too. This cannot be undone.')) return;
      try { await videos.remove(btn.dataset.del); await loadVideos(); toast('Video deleted.'); }
      catch (e) { toast(explain(e), true); }
    });
  });
}

// ------------------------------------------------------------
//  modal
// ------------------------------------------------------------
let onSave = null;

function openModal(title, html, handler, saveLabel = 'Save') {
  $('modal-title').textContent = title;
  $('modal-form').innerHTML = html;
  $('modal-error').hidden = true;
  $('modal-save').textContent = saveLabel;
  $('modal-save').dataset.label = saveLabel;
  $('modal').hidden = false;
  onSave = handler;
  $('modal-form').querySelector('input, textarea, select')?.focus();
}

function closeModal() {
  $('modal').hidden = true;
  onSave = null;
  if (state.pendingRefresh) refreshInPlace();
}

$('modal-cancel').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

$('modal-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); $('modal-save').click(); }
});

$('modal-save').addEventListener('click', async () => {
  if (!onSave) return;
  const data = Object.fromEntries(new FormData($('modal-form')).entries());
  const btn = $('modal-save');
  const label = btn.dataset.label || 'Save';
  btn.disabled = true;
  btn.textContent = label === 'Send' ? 'Sending…' : 'Saving…';
  try { await onSave(data); closeModal(); }
  catch (e) { $('modal-error').textContent = explain(e); $('modal-error').hidden = false; }
  finally { btn.disabled = false; btn.textContent = label; }
});

// ------------------------------------------------------------
//  attachments modal — file, link, or pasted text
// ------------------------------------------------------------
function openAttach(videoId, block) {
  const leaf = LEAF_BLOCKS.find((b) => b.key === block);
  const canUpload = attachments.supportsUpload;

  openModal(`Add to ${leaf.label}`, `
    <div class="seg" role="tablist">
      ${['file', 'link', 'note'].map((k, i) => `
        <button type="button" class="seg-btn ${i === 0 ? 'on' : ''}" data-kind="${k}">
          ${{ file: '📎 File', link: '🔗 Link', note: '📝 Text' }[k]}
        </button>`).join('')}
    </div>

    <div data-pane="file">
      ${canUpload ? `
        <label for="f-file">Choose a file</label>
        <input id="f-file" type="file" />
        <p class="hint">Images, PDFs, docs, audio or video. 50 MB max.</p>`
      : `<p class="hint">File upload needs Supabase. Use Link or Text in local mode.</p>`}
    </div>

    <div data-pane="link" hidden>
      <label for="f-url">URL</label>
      <input id="f-url" name="url" type="text" placeholder="https://drive.google.com/…" />
    </div>

    <div data-pane="note" hidden>
      <label for="f-body">Text</label>
      <textarea id="f-body" name="body" rows="6" placeholder="Paste the description, SEO tags, transcript…"></textarea>
    </div>

    <label for="f-label">Label <span class="opt">(optional)</span></label>
    <input id="f-label" name="label" type="text" placeholder="e.g. Thumbnail v3" />
  `, async (data) => {
    const kind = $('modal-form').querySelector('.seg-btn.on').dataset.kind;
    const clientId = state.activeId;

    let created;
    if (kind === 'file') {
      const f = $('f-file')?.files?.[0];
      if (!f) throw new Error('Choose a file first.');
      created = await attachments.addFile(videoId, clientId, block, f);
    } else if (kind === 'link') {
      if (!data.url?.trim()) throw new Error('Paste a URL first.');
      created = await attachments.addLink(videoId, block, data.url, data.label);
    } else {
      if (!data.body?.trim()) throw new Error('Type or paste something first.');
      created = await attachments.addNote(videoId, block, data.body, data.label);
    }

    state.attachments.push(created);
    state.expanded.add(videoId);
    renderRows();
    toast('Attached.');
  });

  // segmented control swaps which pane is live
  const form = $('modal-form');
  form.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      form.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
      form.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.kind; });
      form.querySelector(`[data-pane="${b.dataset.kind}"] input, [data-pane="${b.dataset.kind}"] textarea`)?.focus();
    });
  });
}

// ------------------------------------------------------------
//  approval modal — the one thing a client can change
// ------------------------------------------------------------
function openApproval(videoId) {
  if (blockedInPreview()) return;
  const v = state.videos.find((x) => x.id === videoId);
  const current = v.approval_status || 'pending';

  openModal('Client approval', `
    <label for="f-appr">Status</label>
    <select id="f-appr" name="status">
      ${APPROVAL_STATUS.map((o) =>
        `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>

    <div id="note-wrap" ${current === 'needs_change' ? '' : 'hidden'}>
      <label for="f-note">What needs changing?</label>
      <textarea id="f-note" name="note" rows="4"
        placeholder="Be specific — the logo is too small, wrong episode number…">${esc(v.approval_note || '')}</textarea>
    </div>
  `, async (data) => {
    if (data.status === 'needs_change' && !data.note?.trim()) {
      throw new Error('Say what needs changing.');
    }
    await videos.setApproval(videoId, data.status, data.note);
    v.approval_status = data.status;
    v.approval_note = data.status === 'needs_change' ? data.note.trim() : null;
    renderRows(); renderStats();
    toast('Approval updated.');
  });

  // the note is required for "needs change", so only show it then
  $('f-appr').addEventListener('change', (e) => {
    $('note-wrap').hidden = e.target.value !== 'needs_change';
    if (!$('note-wrap').hidden) $('f-note').focus();
  });
}

// ------------------------------------------------------------
//  Notify panel
// ------------------------------------------------------------
async function openNotify(videoId) {
  if (blockedInPreview()) return;
  const v = state.videos.find((x) => x.id === videoId);
  if (!v) return;

  let recipients = [], changes = [];
  try {
    [recipients, changes] = await Promise.all([
      notify.recipients(state.activeId),
      notify.pending(videoId),
    ]);
  } catch (e) { return toast(explain(e), true); }

  if (!recipients.length) {
    return toast('Nobody else has access to this channel yet.', true);
  }

  const when = (iso) => new Date(iso).toLocaleDateString(undefined,
    { day: 'numeric', month: 'short' });

  openModal(`Notify about ${v.guest_name}`, `
    ${changes.length ? `
      <label>Since the last update</label>
      <ul class="chg-list">
        ${changes.map((c) => `<li><span>${esc(c.summary)}</span>
          <span class="chg-when">${esc(when(c.created_at))}</span></li>`).join('')}
      </ul>`
    : `<p class="hint">Nothing has changed since the last update — write a note below
        if you still want to send something.</p>`}

    <label>Send to</label>
    <div class="chan-list">
      ${recipients.map((r) => `
        <label class="chan-opt ${r.muted ? 'is-muted' : ''}">
          <input type="checkbox" name="who" value="${esc(r.id)}"
                 ${r.role === 'client' && !r.muted ? 'checked' : ''}
                 ${r.muted ? 'disabled' : ''} />
          <span>${esc(r.full_name || r.email)}
            <span class="chan-role">${esc(roleLabel(r.role))}</span>
            ${r.muted ? '<span class="chan-role">muted</span>' : ''}</span>
        </label>`).join('')}
    </div>

    <label for="f-note-msg">Add a note <span class="opt">(optional)</span></label>
    <textarea id="f-note-msg" name="note" rows="3"
      placeholder="e.g. Thumbnails are ready for your approval."></textarea>
  `, async (data) => {
    const who = [...$('modal-form').querySelectorAll('input[name="who"]:checked')]
      .map((i) => i.value);
    if (!who.length) throw new Error('Pick at least one person.');

    const n = await notify.send(videoId, who, data.note);
    v.last_notified_at = new Date().toISOString();
    toast(`Sent to ${n} ${n === 1 ? 'person' : 'people'}.`);
  }, 'Send');
}

function openEditVideo(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;

  openModal('Edit details', `
    <label for="e-guest">Guest name</label>
    <input id="e-guest" name="guest_name" type="text" required value="${esc(v.guest_name || '')}" />

    <label for="e-title">Episode title <span class="opt">(once you have one)</span></label>
    <input id="e-title" name="title" type="text" value="${esc(v.title || '')}" />

    <div class="field-row">
      <div><label for="e-ep">Episode no.</label>
        <input id="e-ep" name="episode_no" type="number" min="0" value="${esc(v.episode_no ?? '')}" /></div>
      <div><label for="e-due">Due date</label>
        <input id="e-due" name="due_date" type="date" value="${esc(v.due_date || '')}" /></div>
    </div>

    <label for="e-vid">YouTube video ID</label>
    <input id="e-vid" name="youtube_video_id" type="text" value="${esc(v.youtube_video_id || '')}" />

    <label for="e-notes">Notes</label>
    <textarea id="e-notes" name="notes">${esc(v.notes || '')}</textarea>
  `, async (data) => {
    if (!data.guest_name.trim()) throw new Error('Guest name is required.');
    for (const k of ['title', 'episode_no', 'due_date', 'youtube_video_id', 'notes']) {
      if (data[k] === '') data[k] = null;
    }
    const updated = await videos.update(id, data);
    Object.assign(v, updated || data);
    renderRows();
    toast('Updated.');
  });
}

// ------------------------------------------------------------
//  clients + videos
// ------------------------------------------------------------
function clientFields(c = {}) {
  return `
    <label for="f-name">Podcast / channel name</label>
    <input id="f-name" name="channel_name" type="text" required value="${esc(c.channel_name || '')}" />
    <label for="f-email">Client email</label>
    <input id="f-email" name="email" type="email" value="${esc(c.email || '')}" />
    <label for="f-yt">YouTube channel</label>
    <input id="f-yt" name="youtube_url" type="text" placeholder="@handle or full URL" value="${esc(c.youtube_url || '')}" />
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

$('add-video-btn').addEventListener('click', () => {
  openModal('Add video', `
    <label for="f-guest">Guest name</label>
    <input id="f-guest" name="guest_name" type="text" required placeholder="e.g. Rob Brown" />
    <p class="hint">The episode title gets added later, once the footage is in.</p>
    <div class="field-row">
      <div><label for="f-ep">Episode no.</label><input id="f-ep" name="episode_no" type="number" min="0" /></div>
      <div><label for="f-due">Due date</label><input id="f-due" name="due_date" type="date" /></div>
    </div>
    <label for="f-status">Status</label>
    <select id="f-status" name="status">
      ${UPLOAD_STATUS.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}
    </select>
    <label for="f-vid">YouTube video ID <span class="opt">(if already live)</span></label>
    <input id="f-vid" name="youtube_video_id" type="text" placeholder="dQw4w9WgXcQ" />
    <label for="f-vnotes">Notes</label>
    <textarea id="f-vnotes" name="notes"></textarea>
  `, async (data) => {
    if (!data.guest_name.trim()) throw new Error('Guest name is required.');
    for (const k of ['episode_no', 'due_date', 'youtube_video_id', 'notes']) {
      if (data[k] === '') data[k] = null;
    }
    data.client_id = state.activeId;
    await videos.create(data);
    await loadVideos();
    toast('Video added.');
  });
});


// ============================================================
//  Preview as client
//
//  Renders the tracker exactly as a client sees it: their one
//  channel, no editing, no People tab, no role badge. The session
//  underneath is still yours, so every write is refused while it
//  is on — this shows the experience, it does not become them.
//
//  What a client can actually *reach* is enforced by Row Level
//  Security in the database, which this does not simulate and does
//  not need to: the boundary is tested separately.
// ============================================================
function enterPreview() {
  if (!state.activeId) return toast('Pick a channel first.', true);
  state.preview = true;
  state.expanded.clear();
  showTab('tracker');
  applyChrome();
  renderClientList();
  renderMain();
  $('preview-channel').textContent =
    state.clients.find((c) => c.id === state.activeId)?.channel_name || '';
  window.scrollTo(0, 0);
}

function exitPreview() {
  state.preview = false;
  state.expanded.clear();
  applyChrome();
  renderClientList();
  renderMain();
}

$('preview-btn').addEventListener('click', enterPreview);
$('preview-exit').addEventListener('click', exitPreview);

// Refuse anything that would write while previewing.
function blockedInPreview() {
  if (!state.preview) return false;
  toast('Preview only — nothing is saved while viewing as a client.', true);
  return true;
}

// ============================================================
//  Tabs
// ============================================================
function showTab(tab) {
  state.tab = tab;
  $('tabs').querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelector('.layout').hidden = tab !== 'tracker';
  $('people-view').hidden = tab !== 'people';
}

$('tabs').addEventListener('click', async (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  showTab(btn.dataset.tab);
  if (btn.dataset.tab === 'people') await loadPeople();
});

// ============================================================
//  People
// ============================================================
async function loadPeople() {
  try {
    [state.people, state.invites] = await Promise.all([
      people.list(),
      invites.listPending(),
    ]);
  } catch (e) {
    toast(explain(e), true);
    state.people = []; state.invites = [];
  }
  renderPeople();
}

function relTime(iso) {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function renderPeople() {
  const isAdmin = state.role === 'admin';
  const box = $('people-content');

  const roleCell = (p) => {
    if (!isAdmin || p.id === state.user?.id) {
      return `<span class="role-tag ${esc(p.role)}">${esc(roleLabel(p.role))}${
        p.id === state.user?.id ? ' · you' : ''}</span>`;
    }
    return `<select class="role-select" data-role-for="${esc(p.id)}">
      ${ROLES.map((r) => `<option value="${r.value}" ${r.value === p.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
    </select>`;
  };

  const channelCell = (p) => {
    if (p.role !== 'client') return '<span class="dim">All channels</span>';
    const names = (p.channels || []).map((c) => esc(c.name));
    const body = names.length
      ? names.map((n) => `<span class="chan-tag">${n}</span>`).join('')
      : '<span class="warn">No channel yet — sees nothing</span>';
    return `${body}${isAdmin ? `<button class="btn btn-sm btn-ghost chan-edit" data-chan-for="${esc(p.id)}">Edit</button>` : ''}`;
  };

  const joined = state.people.length ? `
    <table class="people-table">
      <thead><tr>
        <th>Name</th><th>Email</th><th>Role</th><th>Channels</th><th>Last active</th><th></th>
      </tr></thead>
      <tbody>${state.people.map((p) => `
        <tr>
          <td><span class="p-name">${esc(p.full_name || '—')}</span>
            ${!p.confirmed ? '<div class="warn sm">Not confirmed — cannot sign in</div>' : ''}</td>
          <td class="dim">${esc(p.email)}</td>
          <td>${roleCell(p)}</td>
          <td class="chan-cell">${channelCell(p)}</td>
          <td class="dim">${p.last_sign_in_at ? esc(relTime(p.last_sign_in_at)) : '<span class="warn">Never</span>'}</td>
          <td>${isAdmin && p.id !== state.user?.id
            ? `<button class="btn-icon" data-revoke="${esc(p.id)}" title="Revoke access">✕</button>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<p class="att-empty">Nobody has joined yet.</p>';

  const pending = state.invites.length ? `
    <h2 class="people-h2">Waiting to join</h2>
    <p class="people-sub">Set up and ready. They appear above once their login is created and they sign in.</p>
    <table class="people-table">
      <thead><tr><th>Name</th><th>Email</th><th>Will be</th><th>Channels</th><th></th></tr></thead>
      <tbody>${state.invites.map((i) => {
        const names = (i.client_ids || [])
          .map((id) => state.clients.find((c) => c.id === id)?.channel_name)
          .filter(Boolean);
        return `<tr class="pending">
          <td><span class="p-name">${esc(i.full_name || '—')}</span></td>
          <td class="dim">${esc(i.email)}</td>
          <td><span class="role-tag ${esc(i.role)}">${esc(roleLabel(i.role))}</span></td>
          <td>${i.role === 'client'
            ? (names.length ? names.map((n) => `<span class="chan-tag">${esc(n)}</span>`).join('') : '<span class="warn">None</span>')
            : '<span class="dim">All channels</span>'}</td>
          <td>${isAdmin ? `<button class="btn-icon" data-uninvite="${esc(i.email)}" title="Cancel">✕</button>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>` : '';

  box.innerHTML = `
    <h2 class="people-h2">Joined</h2>
    ${joined}
    ${pending}
    ${isAdmin ? `<p class="people-foot">
      Adding someone here sets up who they'll be. Their actual login still has to be
      created in Supabase → Authentication → Users, with <strong>Auto Confirm User</strong> ticked.
    </p>` : ''}`;

  wirePeople();
}

function wirePeople() {
  const box = $('people-content');

  box.querySelectorAll('[data-role-for]').forEach((sel) => {
    const before = sel.value;
    sel.addEventListener('change', async () => {
      try {
        await people.setRole(sel.dataset.roleFor, sel.value);
        toast('Role updated.');
        await loadPeople();
      } catch (e) { sel.value = before; toast(explain(e), true); }
    });
  });

  box.querySelectorAll('[data-chan-for]').forEach((btn) =>
    btn.addEventListener('click', () => openChannels(btn.dataset.chanFor)));

  box.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const p = state.people.find((x) => x.id === btn.dataset.revoke);
      if (!confirm(`Revoke access for ${p.full_name || p.email}?\n\n` +
        'They keep their login but will see nothing until you give them access again.')) return;
      try { await people.revoke(p.id); toast('Access revoked.'); await loadPeople(); }
      catch (e) { toast(explain(e), true); }
    });
  });

  box.querySelectorAll('[data-uninvite]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Cancel the invite for ${btn.dataset.uninvite}?`)) return;
      try { await invites.remove(btn.dataset.uninvite); toast('Invite cancelled.'); await loadPeople(); }
      catch (e) { toast(explain(e), true); }
    });
  });
}

function channelChecklist(selected = []) {
  if (!state.clients.length) return '<p class="hint">No channels exist yet.</p>';
  return `<div class="chan-list">${state.clients.map((c) => `
    <label class="chan-opt">
      <input type="checkbox" name="client_ids" value="${esc(c.id)}"
             ${selected.includes(c.id) ? 'checked' : ''} />
      <span>${esc(c.channel_name)}</span>
    </label>`).join('')}</div>`;
}

function openChannels(userId) {
  const p = state.people.find((x) => x.id === userId);
  const current = (p.channels || []).map((c) => c.id);

  openModal(`Channels for ${p.full_name || p.email}`, `
    <label>Which channels can they see?</label>
    ${channelChecklist(current)}
    <p class="hint">A client with no channels can sign in but sees an empty tracker.</p>
  `, async () => {
    const ids = [...$('modal-form').querySelectorAll('input[name="client_ids"]:checked')].map((i) => i.value);
    await people.setChannels(userId, ids);
    toast('Channels updated.');
    await loadPeople();
  });
}

$('add-person-btn').addEventListener('click', () => {
  openModal('Add person', `
    <label for="f-pemail">Email</label>
    <input id="f-pemail" name="email" type="email" required placeholder="them@example.com" />

    <label for="f-pname">Name</label>
    <input id="f-pname" name="full_name" type="text" placeholder="e.g. Rob Brown" />

    <label for="f-prole">Role</label>
    <select id="f-prole" name="role">
      ${ROLES.map((r) => `<option value="${r.value}" ${r.value === 'client' ? 'selected' : ''}>${esc(r.label)} — ${esc(r.hint)}</option>`).join('')}
    </select>

    <div id="chan-wrap">
      <label>Channels they can see</label>
      ${channelChecklist()}
    </div>

    <p class="hint"><strong>One more step after this.</strong> Create their login in
    Supabase → Authentication → Users, with <strong>Auto Confirm User</strong> ticked.
    Everything set here is applied the moment they first sign in.</p>
  `, async (data) => {
    if (!data.email?.trim()) throw new Error('Email is required.');
    const ids = [...$('modal-form').querySelectorAll('input[name="client_ids"]:checked')].map((i) => i.value);
    await invites.create({
      email: data.email, role: data.role,
      full_name: data.full_name, client_ids: ids,
    });
    toast('Added. Now create their login in Supabase.');
    await loadPeople();
  });

  // channels only mean anything for clients
  $('f-prole').addEventListener('change', (e) => {
    $('chan-wrap').hidden = e.target.value !== 'client';
  });
});

// ------------------------------------------------------------
//  start
// ------------------------------------------------------------
(async function init() {
  // A recovery link carries a token that signs you in. Landing straight
  // in the tracker would skip the whole point of the email.
  if (auth.isRecovery && auth.isRecovery()) return showRecovery();
  auth.onRecovery && auth.onRecovery(showRecovery);

  const user = await auth.currentUser();
  if (user) { state.user = user; await enterApp(); }
  else showLogin();
})();
