'use strict';

// ─── Service Worker Registration ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─── State ───────────────────────────────────────────────────────────────────
let selectedQuality = '1080';
let activeJobId = null;          // currently downloading job id
let activeSSE = null;            // EventSource connection
let activeJobMeta = {};          // { title, thumbnail, fileSize }
let currentPlayerObjectURL = null;
const LIBRARY_KEY = 'planevids_library'; // localStorage key for OPFS metadata

// ─── View management ─────────────────────────────────────────────────────────
const SCREENS = ['home', 'mac-dl', 'ready', 'transfer', 'library', 'player'];

function showView(name) {
  SCREENS.forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('active', s === name);
  });
  const backBtn = document.getElementById('btn-back');
  backBtn.hidden = ['home', 'library'].includes(name);
  document.getElementById('nav-download').classList.toggle('active', ['home', 'mac-dl', 'ready', 'transfer'].includes(name));
  document.getElementById('nav-library').classList.toggle('active', name === 'library');
}

// ─── Quality selection ────────────────────────────────────────────────────────
document.querySelectorAll('.quality-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.quality-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedQuality = btn.dataset.quality;
  });
});

// ─── OPFS support check ───────────────────────────────────────────────────────
async function checkOPFS() {
  try {
    await navigator.storage.getDirectory();
    return true;
  } catch { return false; }
}
checkOPFS().then(ok => {
  if (!ok) document.getElementById('opfs-warning').hidden = false;
});

// ─── Back button ─────────────────────────────────────────────────────────────
document.getElementById('btn-back').addEventListener('click', () => {
  if (currentPlayerObjectURL) {
    URL.revokeObjectURL(currentPlayerObjectURL);
    currentPlayerObjectURL = null;
  }
  const player = document.getElementById('video-player');
  player.pause();
  player.src = '';
  showView('library');
});

// ─── Fetch + Start Download ───────────────────────────────────────────────────
document.getElementById('btn-fetch').addEventListener('click', startDownload);
document.getElementById('yt-url').addEventListener('keydown', e => {
  if (e.key === 'Enter') startDownload();
});

async function startDownload() {
  const url = document.getElementById('yt-url').value.trim();
  if (!url) return;

  const btn = document.getElementById('btn-fetch');
  const errEl = document.getElementById('home-error');
  errEl.hidden = true;
  btn.querySelector('.btn-label').classList.add('hidden');
  btn.querySelector('.btn-spinner').classList.remove('hidden');
  btn.disabled = true;

  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, quality: selectedQuality }),
    });
    if (!res.ok) throw new Error('Server error');
    const { id } = await res.json();
    activeJobId = id;
    activeJobMeta = {};

    showView('mac-dl');
    document.getElementById('mac-dl-phase-label').textContent = 'Fetching video info…';
    document.getElementById('mac-dl-video-title').textContent = '';
    document.getElementById('mac-progress-fill').style.width = '0%';
    document.getElementById('mac-progress-pct').textContent = '0%';
    document.getElementById('mac-progress-speed').textContent = '';
    document.getElementById('mac-progress-eta').textContent = '';
    document.getElementById('mac-progress-size').textContent = '';

    connectSSE(id);
  } catch (err) {
    errEl.textContent = err.message || 'Failed to start download';
    errEl.hidden = false;
  } finally {
    btn.querySelector('.btn-label').classList.remove('hidden');
    btn.querySelector('.btn-spinner').classList.add('hidden');
    btn.disabled = false;
  }
}

// ─── Progress display (SSE + polling fallback) ────────────────────────────────
let pollTimer = null;

function applyProgressData(data, id) {
  if (!data || data.status === 'not-found') return;

  if (data.title) {
    activeJobMeta.title = data.title;
    activeJobMeta.thumbnail = data.thumbnail;
    document.getElementById('mac-dl-video-title').textContent = data.title || '';
  }

  if (data.status === 'fetching-info') {
    document.getElementById('mac-dl-phase-label').textContent = 'Fetching video info…';
  }

  if (data.status === 'info-ready') {
    document.getElementById('mac-dl-phase-label').textContent = 'Downloading on Mac…';
  }

  if (data.status === 'downloading') {
    const phaseLabel = { video: 'Downloading video…', audio: 'Downloading audio…', merging: 'Merging…' }[data.phase] || 'Downloading…';
    document.getElementById('mac-dl-phase-label').textContent = phaseLabel;
    const pct = Math.round(data.percent || 0);
    document.getElementById('mac-progress-fill').style.width = `${pct}%`;
    document.getElementById('mac-progress-pct').textContent = `${pct}%`;
    if (data.speed) document.getElementById('mac-progress-speed').textContent = data.speed;
    if (data.eta && data.eta !== '00:00' && data.eta !== 'Unknown') document.getElementById('mac-progress-eta').textContent = `ETA ${data.eta}`;
    if (data.size) document.getElementById('mac-progress-size').textContent = data.size;
  }

  if (data.status === 'merging') {
    document.getElementById('mac-dl-phase-label').textContent = 'Merging video + audio…';
    document.getElementById('mac-progress-fill').style.width = '99%';
    document.getElementById('mac-progress-pct').textContent = '99%';
  }

  if (data.status === 'complete') {
    stopPolling();
    if (activeSSE) { activeSSE.close(); activeSSE = null; }
    activeJobMeta.fileSize = data.fileSize;
    if (data.title) activeJobMeta.title = data.title;
    if (data.thumbnail) activeJobMeta.thumbnail = data.thumbnail;
    showReadyScreen(activeJobId, activeJobMeta);
  }

  if (data.status === 'error') {
    stopPolling();
    if (activeSSE) { activeSSE.close(); activeSSE = null; }
    showView('home');
    const errEl = document.getElementById('home-error');
    errEl.textContent = data.message || 'Download failed';
    errEl.hidden = false;
  }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPolling(id) {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!activeJobId || activeJobId !== id) { stopPolling(); return; }
    try {
      const res = await fetch(`/api/status/${id}`);
      if (res.ok) applyProgressData(await res.json(), id);
    } catch {}
  }, 2000);
}

function connectSSE(id) {
  if (activeSSE) { activeSSE.close(); activeSSE = null; }
  startPolling(id); // polling runs regardless — SSE is bonus

  const es = new EventSource(`/api/progress/${id}`);
  activeSSE = es;

  es.onmessage = e => {
    try { applyProgressData(JSON.parse(e.data), id); } catch {}
  };

  es.onerror = () => {
    es.close(); activeSSE = null;
    // polling already running — no action needed
  };
}

// ─── Cancel Mac download ──────────────────────────────────────────────────────
document.getElementById('btn-cancel-mac').addEventListener('click', async () => {
  stopPolling();
  if (activeSSE) { activeSSE.close(); activeSSE = null; }
  if (activeJobId) {
    await fetch(`/api/cancel/${activeJobId}`, { method: 'POST' });
    activeJobId = null;
  }
  showView('home');
});

// ─── Save to iPhone (LAN transfer → OPFS) ────────────────────────────────────
document.getElementById('btn-save-to-phone').addEventListener('click', saveToPhone);

async function saveToPhone() {
  if (!activeJobId) return;
  const id = activeJobId;
  const meta = { ...activeJobMeta };

  showView('transfer');
  document.getElementById('transfer-video-title').textContent = meta.title || '';
  document.getElementById('transfer-progress-fill').style.width = '0%';
  document.getElementById('transfer-progress-pct').textContent = '0%';
  document.getElementById('transfer-received').textContent = '';
  document.getElementById('transfer-speed').textContent = '';

  // Request Wake Lock to keep screen on during LAN transfer
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}

  try {
    const response = await fetch(`/api/file/${id}`);
    if (!response.ok) throw new Error('Transfer failed');

    const total = parseInt(response.headers.get('content-length') || '0', 10);

    const root = await navigator.storage.getDirectory();
    const fileName = `${id}.mp4`;
    const fileHandle = await root.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();

    const reader = response.body.getReader();
    let received = 0;
    let lastTime = Date.now();
    let lastBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.length;

      // Speed calc (update every 500ms)
      const now = Date.now();
      if (now - lastTime > 500) {
        const elapsed = (now - lastTime) / 1000;
        const speed = (received - lastBytes) / elapsed;
        const pct = total ? Math.round((received / total) * 100) : 0;
        const eta = total && speed > 0 ? Math.round((total - received) / speed) : 0;

        document.getElementById('transfer-progress-fill').style.width = `${pct}%`;
        document.getElementById('transfer-progress-pct').textContent = `${pct}%`;
        document.getElementById('transfer-received').textContent = formatBytes(received);
        document.getElementById('transfer-speed').textContent = `${formatBytes(speed)}/s`;
        if (eta > 0) document.getElementById('transfer-progress-eta').textContent = `~${formatSecs(eta)}`;

        lastTime = now;
        lastBytes = received;
      }
    }

    await writable.close();
    if (wakeLock) await wakeLock.release();

    // Save metadata to localStorage
    const lib = getLibrary();
    lib[fileName] = {
      fileName,
      title: meta.title || 'Untitled Video',
      thumbnail: meta.thumbnail || '',
      fileSize: received,
      quality: selectedQuality,
      savedAt: Date.now(),
    };
    saveLibrary(lib);
    updateBadge();

    showView('library');
    renderLibrary();

  } catch (err) {
    if (wakeLock) try { await wakeLock.release(); } catch {}
    showView('ready');
    alert('Transfer failed: ' + err.message + '\n\nMake sure you are on the same WiFi as your Mac.');
  }
}

// ─── Library helpers ──────────────────────────────────────────────────────────
function getLibrary() {
  try { return JSON.parse(localStorage.getItem(LIBRARY_KEY) || '{}'); } catch { return {}; }
}
function saveLibrary(lib) {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
}
function updateBadge() {
  const count = Object.keys(getLibrary()).length;
  const badge = document.getElementById('nav-badge');
  if (count > 0) { badge.textContent = count; badge.hidden = false; }
  else { badge.hidden = true; }
}

// ─── Open Library ─────────────────────────────────────────────────────────────
async function openLibrary() {
  showView('library');
  renderLibrary();
  loadServerLibrary();
}

async function renderLibrary() {
  const lib = getLibrary();
  const phoneList = document.getElementById('library-phone-list');
  const phoneSection = document.getElementById('library-phone-section');
  const emptyEl = document.getElementById('library-empty');

  phoneList.innerHTML = '';
  const items = Object.values(lib).sort((a, b) => b.savedAt - a.savedAt);

  if (items.length === 0) {
    phoneSection.hidden = true;
  } else {
    phoneSection.hidden = false;
    emptyEl.hidden = true;
    for (const item of items) {
      phoneList.appendChild(buildLibraryItem(item, 'phone'));
    }
  }

  if (items.length === 0 && document.getElementById('library-server-list').children.length === 0) {
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
  }

  updateBadge();
}

function buildLibraryItem(item, source) {
  const div = document.createElement('div');
  div.className = 'library-item';
  div.innerHTML = `
    <img class="lib-thumb" src="${item.thumbnail || ''}" alt="" onerror="this.style.display='none'"/>
    <div class="lib-info">
      <div class="lib-title">${item.title || 'Untitled'}</div>
      <div class="lib-meta">${formatBytes(item.fileSize || 0)} · ${item.quality || '?'}p${source === 'phone' ? ' · 📱 On iPhone' : ' · 💻 On Mac'}</div>
      <div class="lib-actions">
        ${source === 'phone'
          ? `<button class="btn-sm btn-sm-gold" onclick="playVideo('${item.fileName}','${escHtml(item.title)}')">▶ Play</button>`
          : `<button class="btn-sm btn-sm-gold" onclick="sendServerFileToPhone('${item.id}')">📲 Save to iPhone</button>`
        }
        ${source === 'phone'
          ? `<button class="btn-sm btn-sm-danger" onclick="deleteFromPhone('${item.fileName}')">Delete</button>`
          : `<button class="btn-sm btn-sm-danger" onclick="deleteFromServer('${item.id}')">Delete</button>`
        }
      </div>
    </div>`;
  return div;
}

async function loadServerLibrary() {
  const serverSection = document.getElementById('library-server-section');
  const serverList = document.getElementById('library-server-list');
  try {
    const res = await fetch('/api/server-library');
    const files = await res.json();
    const phoneLib = getLibrary();
    // Only show files not already on phone
    const onPhone = new Set(Object.keys(phoneLib).map(f => f.replace('.mp4', '')));
    const notOnPhone = files.filter(f => !onPhone.has(f.id));

    serverList.innerHTML = '';
    if (notOnPhone.length > 0) {
      serverSection.hidden = false;
      notOnPhone.forEach(f => serverList.appendChild(buildLibraryItem(f, 'server')));
      document.getElementById('library-empty').hidden = true;
    } else {
      serverSection.hidden = true;
    }
  } catch {
    serverSection.hidden = true;
  }
}

// ─── Send server file to phone (from Library) ─────────────────────────────────
async function sendServerFileToPhone(id) {
  activeJobId = id;
  // fetch meta from server library
  try {
    const res = await fetch('/api/server-library');
    const files = await res.json();
    const file = files.find(f => f.id === id);
    activeJobMeta = { title: file?.title || '', thumbnail: file?.thumbnail || '', fileSize: file?.fileSize || 0 };
  } catch {}
  showView('ready');
  document.getElementById('ready-video-title').textContent = activeJobMeta.title;
  document.getElementById('ready-filesize').textContent = formatBytes(activeJobMeta.fileSize) + ' ready on Mac';
}

// ─── Play from OPFS ───────────────────────────────────────────────────────────
async function playVideo(fileName, title) {
  try {
    const root = await navigator.storage.getDirectory();
    const fileHandle = await root.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    if (currentPlayerObjectURL) URL.revokeObjectURL(currentPlayerObjectURL);
    currentPlayerObjectURL = URL.createObjectURL(file);

    const player = document.getElementById('video-player');
    player.src = currentPlayerObjectURL;
    document.getElementById('player-title').textContent = title || '';
    showView('player');
    player.play();
  } catch (err) {
    alert('Could not play video: ' + err.message);
  }
}

// ─── Delete from phone ────────────────────────────────────────────────────────
async function deleteFromPhone(fileName) {
  if (!confirm('Remove this video from your iPhone?')) return;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(fileName);
  } catch {}
  const lib = getLibrary();
  delete lib[fileName];
  saveLibrary(lib);
  renderLibrary();
}

// ─── Delete from server ───────────────────────────────────────────────────────
async function deleteFromServer(id) {
  if (!confirm('Delete this video from your Mac?')) return;
  await fetch(`/api/file/${id}`, { method: 'DELETE' });
  loadServerLibrary();
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatSecs(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function escHtml(str) {
  return (str || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
updateBadge();
