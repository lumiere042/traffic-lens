const API = '/api';
const DIRECTORY_URL = 'http://jsonplaceholder.typicode.com/users';
const QUOTE_URL = 'https://dummyjson.com/quotes/random';
const STATUS_URL = 'http://localhost:4002/health';

const $ = (sel) => document.querySelector(sel);
const state = { token: sessionStorage.getItem('token'), user: null, posts: [] };

// ---------- helpers ----------
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `${method} ${path} failed (${res.status})`);
  return data;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- auth ----------
async function loadDirectory() {
  const users = await (await fetch(DIRECTORY_URL)).json();
  $('#login-user').innerHTML = users.map((u) => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.name)} (@${escapeHtml(u.username)})</option>`).join('');
}

async function signIn(username, password) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  state.token = data.token;
  sessionStorage.setItem('token', data.token);
  await loadMe();
}

async function loadMe() {
  if (!state.token) return renderAuth();
  const res = await fetch('/auth/me', { headers: { authorization: `Bearer ${state.token}` } });
  state.user = res.ok ? await res.json() : null;
  if (!res.ok) { state.token = null; sessionStorage.removeItem('token'); }
  renderAuth();
}

function renderAuth() {
  document.body.classList.toggle('signed-in', Boolean(state.user));
  $('#whoami').textContent = state.user ? `${state.user.name} · ${state.user.postCount} posts` : '';
}

// ---------- posts ----------
async function loadPosts() {
  state.posts = await api('/posts');
  renderPosts();
}

async function search(q) {
  if (!q) return loadPosts();
  state.posts = await api(`/posts/search?q=${encodeURIComponent(q)}`);
  renderPosts();
}

function renderPosts() {
  $('#posts').innerHTML = state.posts.map((p) => `
    <li class="post${p.pinned ? ' pinned' : ''}" data-id="${p.id}">
      <div class="post-main" data-action="open">
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml((p.body || '').slice(0, 140))}</p>
        <span class="muted">#${p.id} · ${p.author ? escapeHtml(p.author.name) : `user ${p.userId ?? '–'}`}</span>
      </div>
      <div class="post-actions">
        <button class="ghost" data-action="pin" title="Pin">${p.pinned ? '★' : '☆'}</button>
        <button class="ghost" data-action="edit">Edit</button>
        <button class="ghost danger" data-action="delete">Delete</button>
      </div>
    </li>`).join('') || '<li class="empty">No posts.</li>';
}

async function openPost(id) {
  const post = await api(`/posts/${id}`);
  $('#detail-title').textContent = post.title;
  $('#detail-author').textContent = post.author ? `by ${post.author.name} (@${post.author.username})` : '';
  $('#detail-body').textContent = post.body;
  $('#comments').textContent = 'Loading…';
  $('#detail').showModal();
  try {
    const comments = await api(`/posts/${id}/comments`);
    $('#comments').innerHTML = comments.map((c) => `<p><b>${escapeHtml(c.name)}</b><br>${escapeHtml(c.body)}</p>`).join('');
  } catch {
    $('#comments').textContent = 'Comments are unavailable right now.';
  }
}

async function togglePin(id) {
  const post = state.posts.find((p) => p.id === id);
  await fetch(`${API}/posts/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned: !post.pinned }),
  });
  await loadPosts();
}

function editPost(id) {
  const post = state.posts.find((p) => p.id === id);
  $('#post-id').value = id;
  $('#post-title').value = post.title;
  $('#post-body').value = post.body;
  $('#save-post').textContent = 'Save';
  $('#composer').hidden = false;
  $('#post-title').focus();
}

async function savePost() {
  const id = $('#post-id').value;
  const body = { title: $('#post-title').value.trim(), body: $('#post-body').value.trim() };
  const saved = id ? await api(`/posts/${id}`, { method: 'PUT', body }) : await api('/posts', { method: 'POST', body });
  toast(saved.warning ? `Saved locally — ${saved.warning}` : id ? 'Post updated' : 'Post published', saved.warning ? 'warn' : 'ok');
  closeComposer();
  await loadPosts();
}

async function deletePost(id) {
  await api(`/posts/${id}`, { method: 'DELETE' });
  toast('Post deleted', 'ok');
  await loadPosts();
}

function closeComposer() {
  $('#composer').reset();
  $('#post-id').value = '';
  $('#save-post').textContent = 'Publish';
  $('#composer').hidden = true;
}

// ---------- extras ----------
async function loadQuote() {
  try {
    const q = await (await fetch(QUOTE_URL)).json();
    $('#quote').textContent = `“${q.quote}” — ${q.author}`;
  } catch {
    $('#quote').textContent = '';
  }
}

async function checkStatus() {
  try {
    const res = await fetch(STATUS_URL);
    $('#api-dot').dataset.ok = String(res.ok);
    $('#api-status').textContent = res.ok ? 'API healthy' : 'API degraded';
  } catch {
    $('#api-dot').dataset.ok = 'false';
    $('#api-status').textContent = 'API unreachable';
  }
}

async function resetDemo() {
  await fetch(`${API}/admin/reset`, { method: 'POST' });
  toast('Demo data reset', 'ok');
  await loadPosts();
}

// ---------- wiring ----------
const run = (fn) => (...args) => fn(...args).catch((err) => toast(err.message, 'error'));

$('#login-form').addEventListener('submit', run(async (e) => {
  e.preventDefault();
  await signIn($('#login-user').value, $('#login-pass').value);
  toast(`Signed in as ${state.user.name}`, 'ok');
}));
$('#logout').addEventListener('click', () => {
  state.token = null; state.user = null;
  sessionStorage.removeItem('token');
  renderAuth();
});
$('#search-form').addEventListener('submit', run(async (e) => { e.preventDefault(); await search($('#search').value.trim()); }));
$('#new-post').addEventListener('click', () => { closeComposer(); $('#composer').hidden = false; $('#post-title').focus(); });
$('#cancel-post').addEventListener('click', closeComposer);
$('#composer').addEventListener('submit', run(async (e) => { e.preventDefault(); await savePost(); }));
$('#detail-close').addEventListener('click', () => $('#detail').close());
$('#reset').addEventListener('click', run(resetDemo));
$('#posts').addEventListener('click', run(async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  const id = Number(e.target.closest('.post')?.dataset.id);
  if (!action || !id) return;
  if (action === 'open') await openPost(id);
  if (action === 'pin') await togglePin(id);
  if (action === 'edit') editPost(id);
  if (action === 'delete') await deletePost(id);
}));

run(loadDirectory)();
run(loadQuote)();
run(loadMe)();
run(loadPosts)();
run(checkStatus)();
