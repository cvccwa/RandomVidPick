// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CLIENT_ID   = '139266625585-isecrhdfdfkqr5mo7cjhcgvuohjrd0b5.apps.googleusercontent.com';
const ROOT_FOLDER = '1JBAz8KFVSHfnzojWnhECD7gtBRkLBCk9';
const SCOPES      = 'https://www.googleapis.com/auth/drive.readonly';
const VIDEO_MIME_TYPES = [
  'video/mp4', 'video/x-matroska', 'video/webm',
  'video/quicktime', 'video/x-msvideo', 'video/mpeg',
  'video/3gpp', 'video/x-flv', 'video/x-ms-wmv'
];
const FILTER_KEYWORDS = /pixel|censor|blur/i;
const APP_VERSION = 'v18';
const BROWSE_BATCH = 50;
const THUMBNAIL_HOST = 'https://random-vid-pick.vercel.app';
const META_URL       = `${THUMBNAIL_HOST}/api/meta`;
const RECENT_MS      = 30 * 24 * 3600 * 1000; // "recently watched" = past month

// Display-only cleanup of filenames (Drive names and search are untouched):
// - trailing video extensions, including doubled ones like "name.mp4.mp4"
// - a "_Downloaded_YYYY_MM_DD_HH_MM_SS" stamp some download tools append
// - underscores used as word separators
const VIDEO_EXT_RE      = /(\.(mp4|m4v|mkv|webm|mov|avi|mpe?g|3gp|flv|wmv))+$/i;
const DOWNLOAD_STAMP_RE = /[_\s]*downloaded(?:_\d{1,4}){6}$/i;
function displayName(name) {
  const cleaned = name
    .replace(VIDEO_EXT_RE, '')
    .replace(DOWNLOAD_STAMP_RE, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || name;
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let accessToken = null;
let lastPicked  = null;
let videoCache  = null; // full unfiltered list, scanned once per page load

// Browse view: current filtered list and how many of it are rendered so far.
let browseFiltered = [];
let browseRendered = 0;
let browseObserver = null;
let browseSearchDebounce = null;

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const statusBar       = document.getElementById('statusBar');
const statusText      = document.getElementById('statusText');
const pickBtn         = document.getElementById('pickBtn');
const signInBtn       = document.getElementById('signInBtn');
const signOutBtn      = document.getElementById('signOutBtn');
const videoInfo       = document.getElementById('videoInfo');
const videoFilename   = document.getElementById('videoFilename');
const videoPath       = document.getElementById('videoPath');
const openVlcBtn       = document.getElementById('openVlcBtn');
const pickFilteredBtn  = document.getElementById('pickFilteredBtn');
const pickingOverlay   = document.getElementById('pickingOverlay');
const appVersion       = document.getElementById('appVersion');
const browseBtn        = document.getElementById('browseBtn');
const browseView       = document.getElementById('browseView');
const browseSearch     = document.getElementById('browseSearch');
const browseCount      = document.getElementById('browseCount');
const browseGrid       = document.getElementById('browseGrid');
const browseSentinel   = document.getElementById('browseSentinel');
const browseSort       = document.getElementById('browseSort');
const browseDir        = document.getElementById('browseDir');
const browseFilter     = document.getElementById('browseFilter');
const browseTagBar     = document.getElementById('browseTagBar');
const browseRandomBtn  = document.getElementById('browseRandomBtn');
const selectBar        = document.getElementById('selectBar');
const selectCount      = document.getElementById('selectCount');
const sheetBackdrop    = document.getElementById('sheetBackdrop');
const sheet            = document.getElementById('sheet');

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function signIn() {
  const redirectUri = encodeURIComponent(window.location.href.split('?')[0].split('#')[0]);
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth`
    + `?client_id=${encodeURIComponent(CLIENT_ID)}`
    + `&redirect_uri=${redirectUri}`
    + `&response_type=token`
    + `&scope=${encodeURIComponent(SCOPES)}`
    + `&prompt=consent`;
  window.location.href = authUrl;
}

function signOut() {
  accessToken = null;
  lastPicked  = null;
  videoCache  = null;
  localStorage.removeItem('rvp_token');
  localStorage.removeItem('rvp_token_expiry');
  updateUI(false);
}

function handleAuthCallback() {
  const hash = window.location.hash;
  if (!hash) return;
  const params = new URLSearchParams(hash.substring(1));
  const token     = params.get('access_token');
  const expiresIn = params.get('expires_in');
  if (!token) return;

  if (window.parent !== window) {
    // Running inside silent-refresh iframe — send token to parent
    window.parent.postMessage({ type: 'rvp_token', token }, window.location.origin);
    return;
  }

  accessToken = token;
  const expiry = Date.now() + (parseInt(expiresIn) * 1000);
  localStorage.setItem('rvp_token', token);
  localStorage.setItem('rvp_token_expiry', expiry.toString());
  history.replaceState(null, '', window.location.pathname);
  updateUI(true);
  scheduleRefresh();
}

function restoreSession() {
  const token  = localStorage.getItem('rvp_token');
  const expiry = localStorage.getItem('rvp_token_expiry');
  if (token && expiry && Date.now() < parseInt(expiry)) {
    accessToken = token;
    return true;
  }
  return false;
}

function silentRefresh() {
  return new Promise((resolve, reject) => {
    const redirectUri = window.location.href.split('?')[0].split('#')[0];
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth`
      + `?client_id=${encodeURIComponent(CLIENT_ID)}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&response_type=token`
      + `&scope=${encodeURIComponent(SCOPES)}`
      + `&prompt=none`;

    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    iframe.src = authUrl;

    const timer = setTimeout(() => {
      iframe.remove();
      reject(new Error('silent refresh timeout'));
    }, 10000);

    window.addEventListener('message', function handler(e) {
      if (e.origin !== window.location.origin) return;
      if (e.data && e.data.type === 'rvp_token') {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        iframe.remove();
        if (e.data.token) resolve(e.data.token);
        else reject(new Error('no token in message'));
      }
    });

    document.body.appendChild(iframe);
  });
}

function scheduleRefresh() {
  const expiry = parseInt(localStorage.getItem('rvp_token_expiry') || '0');
  const msLeft = expiry - Date.now() - 5 * 60 * 1000;
  if (msLeft <= 0) return;
  setTimeout(() => {
    silentRefresh()
      .then(token => {
        accessToken = token;
        const newExpiry = Date.now() + 3500 * 1000;
        localStorage.setItem('rvp_token', token);
        localStorage.setItem('rvp_token_expiry', newExpiry.toString());
        scheduleRefresh();
      })
      .catch(() => {});
  }, msLeft);
}

// ─── UI ───────────────────────────────────────────────────────────────────────
function setStatus(msg, state = '') {
  statusText.textContent = msg;
  statusBar.className = 'status-bar' + (state ? ' ' + state : '');
}

function updateUI(signedIn) {
  if (signedIn) {
    setStatus('Signed in · Ready to pick', 'ready');
    signInBtn.style.display  = 'none';
    signOutBtn.style.display = '';
    pickBtn.disabled          = false;
    pickFilteredBtn.disabled  = false;
    browseBtn.disabled        = false;
  } else {
    setStatus('Not signed in');
    signInBtn.style.display  = '';
    signOutBtn.style.display = 'none';
    pickBtn.disabled         = true;
    pickFilteredBtn.disabled = true;
    browseBtn.disabled       = true;
    videoInfo.classList.remove('visible');
    openVlcBtn.style.display = 'none';
    closeBrowseView();
  }
}

// ─── DRIVE API ────────────────────────────────────────────────────────────────
async function driveRequest(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.status === 401) {
    signOut();
    throw new Error('Session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  return res.json();
}

async function collectVideos(folderId, pathSoFar = '') {
  const videos = [];
  let pageToken = null;

  do {
    const mimeQuery = VIDEO_MIME_TYPES.map(m => `mimeType='${m}'`).join(' or ');
    let url = `https://www.googleapis.com/drive/v3/files`
      + `?q=(${mimeQuery}) and '${folderId}' in parents and trashed=false`
      + `&fields=nextPageToken,files(id,name,createdTime,size,videoMediaMetadata(durationMillis))`
      + `&pageSize=1000`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const data = await driveRequest(url);
    if (data.files) {
      for (const f of data.files) {
        const driveMs = Number(f.videoMediaMetadata && f.videoMediaMetadata.durationMillis);
        videos.push({
          id:         f.id,
          name:       f.name,
          path:       pathSoFar,
          created:    Date.parse(f.createdTime) || 0,
          size:       Number(f.size) || 0,
          // Drive only knows duration for videos it finished processing;
          // the rest get filled in from KV (loadMeta) or measured in-browser.
          durationMs: driveMs > 0 ? driveMs : null,
        });
      }
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  let subPageToken = null;
  do {
    let url = `https://www.googleapis.com/drive/v3/files`
      + `?q=mimeType='application/vnd.google-apps.folder' and '${folderId}' in parents and trashed=false`
      + `&fields=nextPageToken,files(id,name)`
      + `&pageSize=1000`;
    if (subPageToken) url += `&pageToken=${subPageToken}`;
    const data = await driveRequest(url);
    if (data.files) {
      for (const folder of data.files) {
        const subPath = pathSoFar ? `${pathSoFar} / ${folder.name}` : folder.name;
        const subVideos = await collectVideos(folder.id, subPath);
        videos.push(...subVideos);
      }
    }
    subPageToken = data.nextPageToken || null;
  } while (subPageToken);

  return videos;
}

// ─── META (durations + watched history, stored in KV via /api/meta) ──────────
let metaWatched  = {};   // fileId -> last-watched epoch ms
let metaTags     = {};   // fileId -> {tagName: source}  (m manual, f filename, i imported)
let metaPromise  = null; // load once per page
const pendingDurations = {};
const pendingWatched   = new Set();
let metaFlushTimer = null;

function metaHeaders(extra = {}) {
  return { Authorization: `Bearer ${accessToken}`, ...extra };
}

// Fills in durations Drive didn't have and loads watched history. Optional:
// if KV or the endpoint is unavailable the library still works, just without
// those extras.
function ensureMeta() {
  if (!metaPromise) {
    metaPromise = fetch(META_URL, { headers: metaHeaders() })
      .then(res => (res.ok ? res.json() : { durations: {}, watched: {} }))
      .then(meta => {
        // Merge, don't replace: a watch marked before this load finished wins.
        metaWatched = { ...(meta.watched || {}), ...metaWatched };
        // Same for tags edited before the load returned.
        metaTags = { ...(meta.tags || {}), ...metaTags };
        for (const v of videoCache || []) {
          if (!v.durationMs && meta.durations && meta.durations[v.id]) {
            v.durationMs = meta.durations[v.id];
          }
        }
      })
      .catch(() => {});
  }
  return metaPromise;
}

function scheduleMetaFlush(delay = 3000) {
  clearTimeout(metaFlushTimer);
  metaFlushTimer = setTimeout(flushMeta, delay);
}

function flushMeta() {
  clearTimeout(metaFlushTimer);
  const ids = Object.keys(pendingDurations);
  if (!ids.length && !pendingWatched.size) return;
  const body = { durations: {}, watched: [...pendingWatched] };
  for (const id of ids) {
    body.durations[id] = pendingDurations[id];
    delete pendingDurations[id];
  }
  pendingWatched.clear();
  // keepalive lets this finish even if the page is backgrounded right after
  // (e.g. the VLC intent taking over the screen).
  fetch(META_URL, {
    method:    'POST',
    keepalive: true,
    headers:   metaHeaders({ 'Content-Type': 'application/json' }),
    body:      JSON.stringify(body),
  }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushMeta();
});

function findVideo(id) {
  return (videoCache || []).find(v => v.id === id);
}

function recordDuration(id, seconds) {
  if (!isFinite(seconds) || seconds <= 0) return;
  const video = findVideo(id);
  if (!video || video.durationMs) return;
  video.durationMs = Math.round(seconds * 1000);
  pendingDurations[id] = video.durationMs;
  updateCardBadges(video);
  scheduleMetaFlush();
}

function markWatched(id) {
  metaWatched[id] = Date.now();
  pendingWatched.add(id);
  const video = findVideo(id);
  if (video) updateCardBadges(video);
  flushMeta();
}

function isRecentlyWatched(id) {
  return metaWatched[id] && Date.now() - metaWatched[id] < RECENT_MS;
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// ─── TAGS ─────────────────────────────────────────────────────────────────────
const TAG_SAVE_CHUNK = 150; // ids per POST (server caps at 200)

function tagsOf(id) {
  return metaTags[id] || {};
}

function tagNames(id) {
  return Object.keys(tagsOf(id));
}

// name -> number of videos carrying it, most-used first.
function tagCounts() {
  const counts = new Map();
  for (const tags of Object.values(metaTags)) {
    for (const name of Object.keys(tags)) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

// Tidies a typed tag and reuses an existing tag's spelling when it matches
// case-insensitively, so "Creator" and "creator" don't become two tags.
function canonicalTag(raw) {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!name) return '';
  const lower = name.toLowerCase();
  for (const existing of tagCounts().keys()) {
    if (existing.toLowerCase() === lower) return existing;
  }
  return name;
}

// updates: {fileId: {tag: source}} - each map fully replaces that video's
// tags (an empty map clears them). Applied locally right away, then saved.
async function saveTags(updates) {
  const ids = Object.keys(updates);
  for (const id of ids) {
    if (Object.keys(updates[id]).length) metaTags[id] = updates[id];
    else delete metaTags[id];
    const video = findVideo(id);
    if (video) updateCardBadges(video);
  }
  refreshTagBar();

  let failed = 0;
  for (let i = 0; i < ids.length; i += TAG_SAVE_CHUNK) {
    const chunk = {};
    for (const id of ids.slice(i, i + TAG_SAVE_CHUNK)) chunk[id] = updates[id];
    try {
      const res = await fetch(META_URL, {
        method:  'POST',
        headers: metaHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify({ tags: chunk }),
      });
      if (!res.ok) failed += Object.keys(chunk).length;
    } catch (err) {
      failed += Object.keys(chunk).length;
    }
  }
  if (failed) alert(`Couldn't save tags for ${failed} video(s). Check your connection and try again.`);
}

// ─── VLC LAUNCH ───────────────────────────────────────────────────────────────
function prewarmStream(fileId) {
  return fetch(`https://random-vid-pick.vercel.app/api/stream?id=${encodeURIComponent(fileId)}`, {
    method: 'HEAD',
  }).catch(() => {});
}

function openInVlc() {
  if (!lastPicked) return;
  markWatched(lastPicked.id);
  const title = encodeURIComponent(displayName(lastPicked.name));
  const id    = encodeURIComponent(lastPicked.id);
  const host  = `random-vid-pick.vercel.app/api/stream?id=${id}`;
  window.location.href =
    `intent://${host}` +
    `#Intent;scheme=https;package=org.videolan.vlc;type=video%2F*` +
    `;S.title=${title};end`;
}

// ─── PICK & PLAY ──────────────────────────────────────────────────────────────
async function pickRandom(filter = null) {
  pickBtn.disabled         = true;
  pickFilteredBtn.disabled = true;
  pickingOverlay.classList.add('visible');
  if (!videoCache) setStatus('Scanning library...', 'loading');

  try {
    if (!videoCache) videoCache = await collectVideos(ROOT_FOLDER);
    let videos = filter ? videoCache.filter(v => filter.test(v.name)) : videoCache;

    if (videos.length === 0) {
      setStatus(filter ? 'No matching videos found' : 'No videos found in folder', 'error');
      pickingOverlay.classList.remove('visible');
      pickBtn.disabled         = false;
      pickFilteredBtn.disabled = false;
      return;
    }

    const picked = videos[Math.floor(Math.random() * videos.length)];
    lastPicked = picked;

    pickingOverlay.classList.remove('visible');

    videoFilename.textContent = displayName(picked.name);
    videoPath.textContent     = picked.path || '(root folder)';
    videoInfo.classList.add('visible');
    pickBtn.disabled         = false;
    pickFilteredBtn.disabled = false;

    openVlcBtn.style.display = '';
    openVlcBtn.disabled = true;
    setStatus('Warming stream…', 'loading');

    await prewarmStream(picked.id);

    openVlcBtn.disabled = false;
    setStatus('Picked · tap OPEN IN VLC to play', 'ready');

  } catch (err) {
    pickingOverlay.classList.remove('visible');
    setStatus(err.message || 'Something went wrong', 'error');
    pickBtn.disabled         = false;
    pickFilteredBtn.disabled = false;
  }
}

// ─── BROWSE ───────────────────────────────────────────────────────────────────
// Sort/filter choices, remembered between visits.
const SORT_DEFAULT_DIR = { name: 'asc', created: 'desc', duration: 'desc', size: 'desc', watched: 'desc', random: 'asc' };
let browsePrefs = { sort: 'name', dir: 'asc', filter: 'all', tags: [], tagMode: 'all' };
let randomRank  = new Map(); // fileId -> position, reshuffled on demand

try {
  Object.assign(browsePrefs, JSON.parse(localStorage.getItem('rvp_browse_prefs') || '{}'));
} catch (err) { /* private mode or corrupt value - keep defaults */ }

function saveBrowsePrefs() {
  try { localStorage.setItem('rvp_browse_prefs', JSON.stringify(browsePrefs)); } catch (err) {}
}

function reshuffle() {
  const ids = (videoCache || []).map(v => v.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  randomRank = new Map(ids.map((id, i) => [id, i]));
}

// Sort value for a video, or null when unknown (no duration measured yet,
// never watched). Unknowns always go last, whichever direction is chosen.
function sortValue(v, sort) {
  switch (sort) {
    case 'created':  return v.created || null;
    case 'duration': return v.durationMs || null;
    case 'size':     return v.size || null;
    case 'watched':  return metaWatched[v.id] || null;
    case 'random':   return randomRank.get(v.id) ?? null;
    default:         return displayName(v.name).toLowerCase();
  }
}

function sortVideos(list) {
  const { sort, dir } = browsePrefs;
  const sign = dir === 'desc' && sort !== 'random' ? -1 : 1;
  const keyed = list.map(v => [sortValue(v, sort), v]);
  keyed.sort(([a], [b]) => {
    if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
    const cmp = typeof a === 'string'
      ? a.localeCompare(b, undefined, { numeric: true })
      : a - b;
    return cmp * sign;
  });
  return keyed.map(([, v]) => v);
}

function filterVideos(query) {
  const { filter } = browsePrefs;
  let list = videoCache || [];

  if (filter === 'recent')        list = list.filter(v => isRecentlyWatched(v.id));
  else if (filter === 'unwatched') list = list.filter(v => !isRecentlyWatched(v.id));
  else if (filter === 'untagged') list = list.filter(v => !tagNames(v.id).length);
  else if (filter.startsWith('folder:')) {
    const folder = filter.slice('folder:'.length);
    list = list.filter(v => v.path === folder);
  }

  // Tag chips: videos must carry all selected tags (or any, if toggled).
  const wanted = browsePrefs.tags;
  if (wanted.length) {
    list = list.filter(v => {
      const tags = tagsOf(v.id);
      return browsePrefs.tagMode === 'any'
        ? wanted.some(t => t in tags)
        : wanted.every(t => t in tags);
    });
  }

  if (query) {
    const q = query.toLowerCase();
    list = list.filter(v =>
      v.name.toLowerCase().includes(q) || (v.path && v.path.toLowerCase().includes(q))
    );
  }
  return sortVideos(list);
}

function refreshBrowse() {
  resetBrowseGrid(filterVideos(browseSearch.value.trim()));
  browseGrid.scrollTop = 0;
}

function syncBrowseControls() {
  browseSort.value = browsePrefs.sort;
  browseDir.textContent = browsePrefs.sort === 'random'
    ? '⟳ SHUFFLE'
    : browsePrefs.dir === 'asc' ? '↑ ASC' : '↓ DESC';
}

function populateFolderFilter() {
  const folders = [...new Set((videoCache || []).map(v => v.path))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  browseFilter.innerHTML = '';
  const add = (parent, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    parent.appendChild(o);
  };
  add(browseFilter, 'all', 'All videos');
  add(browseFilter, 'recent', 'Watched in last 30 days');
  add(browseFilter, 'unwatched', 'Not watched in last 30 days');
  add(browseFilter, 'untagged', 'Untagged');
  if (folders.length > 1) {
    const group = document.createElement('optgroup');
    group.label = 'Folder';
    for (const f of folders) add(group, `folder:${f}`, f || '(root folder)');
    browseFilter.appendChild(group);
  }
  // A remembered folder that no longer exists falls back to everything.
  if (![...browseFilter.options].some(o => o.value === browsePrefs.filter)) {
    browsePrefs.filter = 'all';
  }
  browseFilter.value = browsePrefs.filter;
}

browseSort.addEventListener('change', () => {
  browsePrefs.sort = browseSort.value;
  browsePrefs.dir  = SORT_DEFAULT_DIR[browsePrefs.sort] || 'asc';
  if (browsePrefs.sort === 'random') reshuffle();
  saveBrowsePrefs();
  syncBrowseControls();
  refreshBrowse();
});

browseDir.addEventListener('click', () => {
  if (browsePrefs.sort === 'random') reshuffle();
  else browsePrefs.dir = browsePrefs.dir === 'asc' ? 'desc' : 'asc';
  saveBrowsePrefs();
  syncBrowseControls();
  refreshBrowse();
});

browseFilter.addEventListener('change', () => {
  browsePrefs.filter = browseFilter.value;
  saveBrowsePrefs();
  refreshBrowse();
});

function buildCard(video) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  card.classList.toggle('selected', selectedIds.has(video.id));
  card.onclick = () => {
    if (selectMode) toggleSelected(video.id, card);
    else playVideo(video);
  };

  const thumb = document.createElement('div');
  thumb.className = 'browse-thumb';

  const img = document.createElement('img');
  img.loading  = 'lazy';
  img.decoding = 'async';
  img.src      = `${THUMBNAIL_HOST}/api/thumbnail?id=${encodeURIComponent(video.id)}`;
  img.onerror  = () => {
    img.classList.add('thumb-fallback');
    queueFrameThumb(video.id, img);
  };
  img.onload = () => {
    if (!video.durationMs) queueDurationProbe(video, card);
  };
  thumb.appendChild(img);

  const durBadge = document.createElement('span');
  durBadge.className = 'browse-badge browse-duration';
  const watchedBadge = document.createElement('span');
  watchedBadge.className = 'browse-badge browse-watched';
  watchedBadge.textContent = 'WATCHED';
  const tagBtn = document.createElement('button');
  tagBtn.type = 'button';
  tagBtn.className = 'browse-tagbtn';
  tagBtn.setAttribute('aria-label', 'Edit tags');
  tagBtn.onclick = e => {
    e.stopPropagation(); // don't also play the video
    openTagEditor([video.id]);
  };
  const check = document.createElement('span');
  check.className = 'browse-check';
  check.textContent = '✓';
  thumb.append(durBadge, watchedBadge, tagBtn, check);
  cardBadges.set(video.id, { dur: durBadge, watched: watchedBadge, tag: tagBtn });
  updateCardBadges(video);

  const caption = document.createElement('div');
  caption.className = 'browse-caption';
  caption.textContent = displayName(video.name);
  card.title = displayName(video.name); // full name on long-press/hover if still clamped

  card.append(thumb, caption);
  return card;
}

// ─── FRAME THUMBNAILS ─────────────────────────────────────────────────────────
// Drive never generates thumbnails for some files (common for multi-GB
// uploads), so /api/thumbnail 404s for them. For those, grab a frame from
// the video itself via /api/stream (which already sends CORS headers, so
// the canvas isn't tainted) and cache the JPEG in IndexedDB so each video
// is only decoded once, ever.
const FRAME_THUMB_CONCURRENCY = 2;
// Generous: a file whose index (moov) sits at the end needs a few extra
// Range round trips through the proxy before the first frame decodes.
const FRAME_THUMB_TIMEOUT_MS  = 45000;
const FRAME_THUMB_WIDTH       = 320;

let thumbDbPromise = null;
const frameThumbQueue  = [];
const frameThumbFailed = new Set(); // undecodable this session - don't retry
let frameThumbActive = 0;

function openThumbDb() {
  if (!thumbDbPromise) {
    thumbDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('rvp-thumbs', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    }).catch(() => null); // private mode etc. - just skip caching
  }
  return thumbDbPromise;
}

async function thumbDbGet(id) {
  const db = await openThumbDb();
  if (!db) return null;
  return new Promise(resolve => {
    const req = db.transaction('thumbs').objectStore('thumbs').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
}

async function thumbDbPut(id, blob) {
  const db = await openThumbDb();
  if (!db) return;
  db.transaction('thumbs', 'readwrite').objectStore('thumbs').put(blob, id);
}

function showThumbBlob(img, blob) {
  img.onerror = null;
  img.classList.remove('thumb-fallback');
  img.src = URL.createObjectURL(blob);
  img.onload = () => URL.revokeObjectURL(img.src);
}

async function queueFrameThumb(id, img) {
  const cached = await thumbDbGet(id);
  if (cached) {
    showThumbBlob(img, cached);
    // Thumbnails cached before durations were tracked never recorded one.
    const video = findVideo(id);
    const card  = img.closest('.browse-card');
    if (video && card && !video.durationMs) queueDurationProbe(video, card);
    return;
  }
  if (frameThumbFailed.has(id)) return;
  frameThumbQueue.push({ id, img });
  pumpFrameThumbQueue();
}

function pumpFrameThumbQueue() {
  while (frameThumbActive < FRAME_THUMB_CONCURRENCY && frameThumbQueue.length) {
    const job = frameThumbQueue.shift();
    // Grid was reset/filtered since this was queued - card is gone, skip it.
    if (!job.img.isConnected) continue;
    frameThumbActive++;
    captureFrame(job.id)
      .then(blob => {
        thumbDbPut(job.id, blob);
        if (job.img.isConnected) showThumbBlob(job.img, blob);
      })
      .catch(err => {
        frameThumbFailed.add(job.id);
        reportFrameThumbMiss(job.id, err.message);
      })
      .finally(() => {
        frameThumbActive--;
        pumpFrameThumbQueue();
      });
  }
}

// The grab runs on the phone with no devtools, so send the failure reason
// to the server where it shows up in Vercel runtime logs.
function reportFrameThumbMiss(id, reason) {
  fetch(`${THUMBNAIL_HOST}/api/thumbnail?id=${encodeURIComponent(id)}`
    + `&report=${encodeURIComponent(reason)}`).catch(() => {});
}

function captureFrame(id) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted       = true;
    video.playsInline = true;
    video.preload     = 'metadata';

    const cleanup = () => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load(); // releases the network connection
    };
    const fail = reason => { cleanup(); reject(new Error(reason)); };
    const timer = setTimeout(
      () => fail(`timeout-rs${video.readyState}-t${Math.round(video.currentTime)}`),
      FRAME_THUMB_TIMEOUT_MS
    );

    // MediaError codes: 2 network, 3 decode, 4 unsupported codec/container.
    video.onerror = () => fail(`media-err-${video.error ? video.error.code : '?'}`);
    video.onloadedmetadata = () => {
      recordDuration(id, video.duration);
      // 10% in (capped at 30s) skips black intro frames without seeking
      // deep into a multi-GB file.
      const d = isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.min(d * 0.1, 30);
    };
    video.onseeked = () => {
      try {
        const scale  = FRAME_THUMB_WIDTH / (video.videoWidth || FRAME_THUMB_WIDTH);
        const canvas = document.createElement('canvas');
        canvas.width  = FRAME_THUMB_WIDTH;
        canvas.height = Math.round((video.videoHeight || 180) * scale);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(blob => {
          cleanup();
          blob ? resolve(blob) : reject(new Error('empty-frame'));
        }, 'image/jpeg', 0.7);
      } catch (err) {
        fail(`draw-${err.name}`); // SecurityError here = tainted canvas (CORS)
      }
    };

    video.src = `${THUMBNAIL_HOST}/api/stream?id=${encodeURIComponent(id)}`;
  });
}

// For cards whose Drive thumbnail loaded fine but Drive has no duration:
// load only the video's metadata (a few MB at most through the proxy, once
// ever - the result is saved to KV) to learn its length.
const durationProbeQueue = [];
let durationProbeActive = false;

function queueDurationProbe(video, card) {
  if (video.durationMs || durationProbeQueue.some(j => j.video === video)) return;
  durationProbeQueue.push({ video, card });
  pumpDurationProbes();
}

function pumpDurationProbes() {
  if (durationProbeActive) return;
  const job = durationProbeQueue.shift();
  if (!job) return;
  if (job.video.durationMs || !job.card.isConnected) return pumpDurationProbes();
  durationProbeActive = true;

  const el = document.createElement('video');
  el.muted   = true;
  el.preload = 'metadata';
  const done = () => {
    clearTimeout(timer);
    el.removeAttribute('src');
    el.load();
    durationProbeActive = false;
    pumpDurationProbes();
  };
  const timer = setTimeout(done, 20000);
  el.onloadedmetadata = () => { recordDuration(job.video.id, el.duration); done(); };
  el.onerror = done;
  el.src = `${THUMBNAIL_HOST}/api/stream?id=${encodeURIComponent(job.video.id)}`;
}

// id -> badge elements of the currently rendered card, so a duration learned
// later (probe/frame grab) or a new watch can update the card in place.
const cardBadges = new Map();

function updateCardBadges(video) {
  const b = cardBadges.get(video.id);
  if (!b) return;
  b.dur.textContent = video.durationMs ? formatDuration(video.durationMs) : '';
  b.dur.hidden      = !video.durationMs;
  b.watched.hidden  = !isRecentlyWatched(video.id);
  const n = tagNames(video.id).length;
  b.tag.textContent = n ? `🏷 ${n}` : '🏷';
  b.tag.classList.toggle('has-tags', n > 0);
  b.tag.title = n ? tagNames(video.id).join(', ') : 'Add tags';
}

function renderNextBatch() {
  const slice = browseFiltered.slice(browseRendered, browseRendered + BROWSE_BATCH);
  const frag = document.createDocumentFragment();
  for (const v of slice) frag.appendChild(buildCard(v));
  browseGrid.insertBefore(frag, browseSentinel);

  browseRendered += slice.length;
  browseCount.textContent = `Showing ${browseRendered} of ${browseFiltered.length}`;

  if (browseRendered >= browseFiltered.length && browseObserver) {
    browseObserver.disconnect();
    browseObserver = null;
  }
}

function resetBrowseGrid(list) {
  browseFiltered = list;
  browseRendered = 0;

  // Clear rendered cards but keep the sentinel node itself (it's a fixed
  // element referenced by browseSentinel, not recreated) so the observer
  // below can keep watching the same node across resets.
  browseGrid.innerHTML = '';
  browseGrid.appendChild(browseSentinel);

  renderNextBatch();

  if (browseObserver) browseObserver.disconnect();
  if (browseRendered < browseFiltered.length) {
    // root must be the grid itself, not the default (page viewport) — the
    // grid is its own scroll container, so "near the bottom" means near the
    // bottom of ITS scroll area, not the page's.
    browseObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) renderNextBatch();
    }, { root: browseGrid, rootMargin: '300px' });
    browseObserver.observe(browseSentinel);
  } else {
    browseObserver = null;
  }
}

async function openBrowseView() {
  browseBtn.disabled = true;
  try {
    if (!videoCache) {
      pickingOverlay.classList.add('visible');
      setStatus('Scanning library...', 'loading');
      videoCache = await collectVideos(ROOT_FOLDER);
      pickingOverlay.classList.remove('visible');
      setStatus('Signed in · Ready to pick', 'ready');
    }
    await ensureMeta();
    if (!randomRank.size) reshuffle();
    browseSearch.value = '';
    populateFolderFilter();
    // Drop remembered tag chips that no longer exist.
    const known = tagCounts();
    browsePrefs.tags = browsePrefs.tags.filter(t => known.has(t));
    syncBrowseControls();
    refreshTagBar();
    refreshBrowse();
    browseView.classList.add('visible');
  } catch (err) {
    pickingOverlay.classList.remove('visible');
    setStatus(err.message || 'Something went wrong', 'error');
  } finally {
    browseBtn.disabled = false;
  }
}

function closeBrowseView() {
  setSelectMode(false);
  closeSheet();
  browseView.classList.remove('visible');
  if (browseObserver) {
    browseObserver.disconnect();
    browseObserver = null;
  }
}

browseSearch.addEventListener('input', () => {
  clearTimeout(browseSearchDebounce);
  browseSearchDebounce = setTimeout(() => {
    refreshBrowse();
  }, 150);
});

// ─── TAG BAR, SELECT MODE, TAG SHEETS ─────────────────────────────────────────
let selectMode = false;
const selectedIds = new Set();

// Small DOM helper: el('button', { className: 'x', onclick }, 'text', child)
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function refreshTagBar() {
  browseTagBar.innerHTML = '';
  browseTagBar.append(
    el('button', {
      type: 'button',
      className: 'tag-chip tag-chip-action' + (selectMode ? ' active' : ''),
      textContent: selectMode ? '✕ CANCEL SELECT' : '☑ SELECT',
      onclick: () => setSelectMode(!selectMode),
    }),
    el('button', {
      type: 'button',
      className: 'tag-chip tag-chip-action',
      textContent: '⚙ TAGS',
      onclick: openTagManager,
    })
  );
  if (browsePrefs.tags.length > 1) {
    browseTagBar.append(el('button', {
      type: 'button',
      className: 'tag-chip tag-chip-action',
      textContent: browsePrefs.tagMode === 'any' ? 'MATCH ANY' : 'MATCH ALL',
      title: 'Videos must have all selected tags, or any of them',
      onclick: () => {
        browsePrefs.tagMode = browsePrefs.tagMode === 'any' ? 'all' : 'any';
        saveBrowsePrefs();
        refreshTagBar();
        refreshBrowse();
      },
    }));
  }
  for (const [name, count] of tagCounts()) {
    const active = browsePrefs.tags.includes(name);
    browseTagBar.append(el('button', {
      type: 'button',
      className: 'tag-chip' + (active ? ' active' : ''),
      textContent: `${name} ${count}`,
      onclick: () => {
        browsePrefs.tags = active
          ? browsePrefs.tags.filter(t => t !== name)
          : [...browsePrefs.tags, name];
        saveBrowsePrefs();
        refreshTagBar();
        refreshBrowse();
      },
    }));
  }
}

function setSelectMode(on) {
  selectMode = on;
  if (!on) {
    selectedIds.clear();
    browseGrid.querySelectorAll('.browse-card.selected').forEach(c => c.classList.remove('selected'));
  }
  browseView.classList.toggle('selecting', on);
  updateSelectBar();
  if (browseView.classList.contains('visible')) refreshTagBar();
}

function toggleSelected(id, card) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  card.classList.toggle('selected', selectedIds.has(id));
  updateSelectBar();
}

function updateSelectBar() {
  selectBar.hidden = !selectMode;
  selectCount.textContent = `${selectedIds.size} selected`;
}

function selectAllInView() {
  for (const v of browseFiltered) selectedIds.add(v.id);
  browseGrid.querySelectorAll('.browse-card').forEach(c => c.classList.add('selected'));
  updateSelectBar();
}

function tagSelected() {
  if (selectedIds.size) openTagEditor([...selectedIds]);
}

function openSheet(...content) {
  sheet.innerHTML = '';
  sheet.append(...content);
  sheetBackdrop.hidden = false;
}

function closeSheet() {
  sheetBackdrop.hidden = true;
  sheet.innerHTML = '';
}

sheetBackdrop.addEventListener('click', e => {
  if (e.target === sheetBackdrop) closeSheet();
});

// Tag editor for one or many videos. Each tag is in one of three states:
//   'all'  - every chosen video has it (or will, once saved)
//   'none' - no chosen video has it (or will lose it)
//   'some' - mixed; left exactly as-is on save unless changed
// Tapping cycles all <-> none (and a mixed tag goes some -> all -> none -> some).
function openTagEditor(ids) {
  const counts = new Map();
  for (const id of ids) for (const t of tagNames(id)) counts.set(t, (counts.get(t) || 0) + 1);
  const state = new Map();
  for (const name of tagCounts().keys()) {
    const c = counts.get(name) || 0;
    state.set(name, c === ids.length ? 'all' : c === 0 ? 'none' : 'some');
  }
  const original = new Map(state);

  const chips = el('div', { className: 'sheet-chips' });
  const renderChips = () => {
    chips.innerHTML = '';
    // Tags already on the video(s) first, then everything else by usage.
    const order = [...state.keys()].sort((a, b) =>
      (state.get(a) === 'none') - (state.get(b) === 'none'));
    for (const name of order) {
      const st = state.get(name);
      chips.append(el('button', {
        type: 'button',
        className: `tag-chip state-${st}`,
        textContent: st === 'some' ? `${name} (${counts.get(name)}/${ids.length})` : name,
        onclick: () => {
          const next = st === 'all' ? 'none'
            : st === 'none' ? (original.get(name) === 'some' ? 'some' : 'all')
            : 'all';
          state.set(name, next);
          renderChips();
        },
      }));
    }
    if (!state.size) chips.append(el('div', { className: 'sheet-note', textContent: 'No tags yet. Type one below.' }));
  };

  const input = el('input', {
    type: 'text',
    className: 'sheet-input',
    placeholder: 'New tag…',
    maxLength: 40,
  });
  const addTyped = () => {
    const name = canonicalTag(input.value);
    if (!name) return;
    state.set(name, 'all');
    input.value = '';
    renderChips();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addTyped(); });

  const save = async () => {
    const updates = {};
    for (const id of ids) {
      const next = { ...tagsOf(id) };
      for (const [name, st] of state) {
        if (st === 'all' && !(name in next)) next[name] = 'm';
        if (st === 'none') delete next[name];
      }
      const before = JSON.stringify(Object.keys(tagsOf(id)).sort());
      if (JSON.stringify(Object.keys(next).sort()) !== before) updates[id] = next;
    }
    closeSheet();
    if (Object.keys(updates).length) {
      await saveTags(updates);
      refreshBrowse();
    }
  };

  renderChips();
  const title = ids.length === 1
    ? displayName(findVideo(ids[0]).name)
    : `${ids.length} videos`;
  openSheet(
    el('div', { className: 'sheet-title', textContent: `Tags · ${title}` }),
    chips,
    el('div', { className: 'sheet-row' },
      input,
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'ADD', onclick: addTyped })),
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'CANCEL', onclick: closeSheet }),
      el('button', { type: 'button', className: 'sheet-btn primary', textContent: 'SAVE', onclick: save }))
  );
}

function openTagManager() {
  const list = el('div', { className: 'sheet-list' });
  const counts = tagCounts();
  if (!counts.size) list.append(el('div', { className: 'sheet-note', textContent: 'No tags yet.' }));

  for (const [name, count] of counts) {
    list.append(el('div', { className: 'sheet-list-row' },
      el('span', { className: 'sheet-list-name', textContent: `${name}` }),
      el('span', { className: 'sheet-list-count', textContent: String(count) }),
      el('button', { type: 'button', className: 'sheet-btn small', textContent: 'RENAME', onclick: () => renameTag(name) }),
      el('button', { type: 'button', className: 'sheet-btn small danger', textContent: 'DELETE', onclick: () => deleteTag(name, count) })));
  }

  openSheet(
    el('div', { className: 'sheet-title', textContent: 'Manage tags' }),
    list,
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'SUGGEST CREATOR TAGS', onclick: openCreatorSuggestions }),
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'DOWNLOAD BACKUP', onclick: downloadTagBackup })),
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'CLOSE', onclick: closeSheet }))
  );
}

async function renameTag(oldName) {
  const typed = prompt(`Rename tag "${oldName}" to:`, oldName);
  if (typed == null) return;
  const newName = typed.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!newName || newName === oldName) return;
  // Renaming onto an existing tag (any case) merges the two.
  const target = canonicalTag(newName) === oldName ? newName : canonicalTag(newName);
  const updates = {};
  for (const [id, tags] of Object.entries(metaTags)) {
    if (!(oldName in tags)) continue;
    const next = { ...tags };
    const src = next[oldName];
    delete next[oldName];
    if (!(target in next)) next[target] = src;
    updates[id] = next;
  }
  browsePrefs.tags = browsePrefs.tags.map(t => (t === oldName ? target : t));
  saveBrowsePrefs();
  await saveTags(updates);
  refreshBrowse();
  openTagManager();
}

async function deleteTag(name, count) {
  if (!confirm(`Remove tag "${name}" from ${count} video(s)?`)) return;
  const updates = {};
  for (const [id, tags] of Object.entries(metaTags)) {
    if (!(name in tags)) continue;
    const next = { ...tags };
    delete next[name];
    updates[id] = next;
  }
  browsePrefs.tags = browsePrefs.tags.filter(t => t !== name);
  saveBrowsePrefs();
  await saveTags(updates);
  refreshBrowse();
  openTagManager();
}

// Most filenames start with the creator: "Creator_Title..." or
// "Creator - Title...". Proposes those as tags for review - nothing is
// saved until confirmed, and names without that shape are skipped.
function creatorFromName(name) {
  const m = /^([^_]{2,40}?)(?:_| - )/.exec(name);
  if (!m) return null;
  const creator = m[1].replace(/\s+/g, ' ').trim();
  if (!creator || /^\d+$/.test(creator)) return null;
  return creator;
}

function openCreatorSuggestions() {
  const groups = new Map(); // creator -> [video ids lacking that tag]
  for (const v of videoCache || []) {
    const raw = creatorFromName(v.name);
    if (!raw) continue;
    const creator = canonicalTag(raw);
    if (creator in tagsOf(v.id)) continue;
    if (!groups.has(creator)) groups.set(creator, []);
    groups.get(creator).push(v.id);
  }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const list = el('div', { className: 'sheet-list' });
  const boxes = [];
  if (!sorted.length) list.append(el('div', { className: 'sheet-note', textContent: 'No new creator tags to suggest.' }));
  for (const [creator, ids] of sorted) {
    // One-off names are more often a misparse than a real creator.
    const box = el('input', { type: 'checkbox', checked: ids.length >= 2 });
    boxes.push([box, creator, ids]);
    list.append(el('label', { className: 'sheet-list-row' },
      box,
      el('span', { className: 'sheet-list-name', textContent: creator }),
      el('span', { className: 'sheet-list-count', textContent: String(ids.length) })));
  }

  const apply = async () => {
    const updates = {};
    for (const [box, creator, ids] of boxes) {
      if (!box.checked) continue;
      for (const id of ids) {
        updates[id] = { ...(updates[id] || tagsOf(id)), [creator]: 'f' };
      }
    }
    closeSheet();
    if (Object.keys(updates).length) {
      await saveTags(updates);
      refreshBrowse();
    }
  };

  openSheet(
    el('div', { className: 'sheet-title', textContent: 'Suggested creator tags' }),
    el('div', { className: 'sheet-note', textContent: 'From the start of each filename. Untick any that look wrong.' }),
    list,
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'BACK', onclick: openTagManager }),
      el('button', { type: 'button', className: 'sheet-btn primary', textContent: 'APPLY', onclick: apply }))
  );
}

function downloadTagBackup() {
  const rows = Object.entries(metaTags).map(([id, tags]) => {
    const v = findVideo(id);
    return { id, name: v ? v.name : null, tags };
  });
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), videos: rows }, null, 2)],
    { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `rvp-tags-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

browseRandomBtn.addEventListener('click', () => {
  if (!browseFiltered.length) return;
  playVideo(browseFiltered[Math.floor(Math.random() * browseFiltered.length)]);
});

async function playVideo(video) {
  lastPicked = video;
  closeBrowseView();

  videoFilename.textContent = displayName(video.name);
  videoPath.textContent     = video.path || '(root folder)';
  videoInfo.classList.add('visible');

  openVlcBtn.style.display = '';
  openVlcBtn.disabled = true;
  setStatus('Warming stream…', 'loading');

  await prewarmStream(video.id);

  openInVlc();
  openVlcBtn.disabled = false;
  setStatus('Picked · tap OPEN IN VLC to play', 'ready');
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
appVersion.textContent = APP_VERSION;
handleAuthCallback();
if (!accessToken) {
  if (restoreSession()) {
    updateUI(true);
    scheduleRefresh();
  } else {
    setStatus('Checking session...', 'loading');
    silentRefresh()
      .then(token => {
        accessToken = token;
        const expiry = Date.now() + 3500 * 1000;
        localStorage.setItem('rvp_token', token);
        localStorage.setItem('rvp_token_expiry', expiry.toString());
        updateUI(true);
        scheduleRefresh();
      })
      .catch(() => updateUI(false));
  }
} else {
  updateUI(true);
}
