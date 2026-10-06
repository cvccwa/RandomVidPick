// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CLIENT_ID   = '139266625585-isecrhdfdfkqr5mo7cjhcgvuohjrd0b5.apps.googleusercontent.com';
const ROOT_FOLDER = '1JBAz8KFVSHfnzojWnhECD7gtBRkLBCk9';
const SCOPES      = 'https://www.googleapis.com/auth/drive.readonly';
const VIDEO_MIME_TYPES = [
  'video/mp4', 'video/x-matroska', 'video/webm',
  'video/quicktime', 'video/x-msvideo', 'video/mpeg',
  'video/3gpp', 'video/x-flv', 'video/x-ms-wmv'
];
const APP_VERSION = 'v26';
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
const signInBtn       = document.getElementById('signInBtn');
const signOutBtn      = document.getElementById('signOutBtn');
const nowPlaying      = document.getElementById('nowPlaying');
const nowPlayingTitle = document.getElementById('nowPlayingTitle');
const nowPlayingBtn   = document.getElementById('nowPlayingBtn');
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
    // No prompt=consent: once access is granted, Google skips the consent
    // screen (and the "unverified app" warning shown with it) on later
    // sign-ins instead of forcing it every time.
    + `&prompt=select_account`;
  window.location.href = authUrl;
}

// The library's top-left button sits where BACK used to be, so ask first
// rather than signing out on a tap from old muscle memory.
function confirmSignOut() {
  if (confirm('Sign out?')) signOut();
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
    setStatus('Signed in', 'ready');
    signInBtn.style.display  = 'none';
    signOutBtn.style.display = '';
    browseBtn.style.display  = '';
    // The library is the app; this page is just the way in.
    openBrowseView();
  } else {
    setStatus('Not signed in');
    signInBtn.style.display  = '';
    signOutBtn.style.display = 'none';
    browseBtn.style.display  = 'none';
    nowPlaying.hidden = true;
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

// Creator tags are stored as "creator:<name>" so they can be filtered and
// managed separately from ordinary tags; the prefix is never shown.
const CREATOR_PREFIX = 'creator:';
const TAG_NAME_MAX   = 40;

function isCreatorTag(name) {
  return name.startsWith(CREATOR_PREFIX);
}

function tagLabel(name) {
  return isCreatorTag(name) ? name.slice(CREATOR_PREFIX.length) : name;
}

function tagKind(name) {
  return isCreatorTag(name) ? 'creator' : 'tag';
}

// name -> number of videos carrying it, most-used first. kind narrows it to
// 'creator' or 'tag'; omitted means both.
function tagCounts(kind) {
  const counts = new Map();
  for (const tags of Object.values(metaTags)) {
    for (const name of Object.keys(tags)) {
      if (kind && tagKind(name) !== kind) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

// Tidies a typed name into a full tag (adding the creator prefix if asked)
// and reuses an existing tag's spelling when it matches case-insensitively,
// so "Jane" and "jane" don't become two tags.
function canonicalTag(raw, creator = false) {
  const label = raw.replace(/\s+/g, ' ').trim().slice(0, TAG_NAME_MAX);
  if (!label) return '';
  const full  = (creator ? CREATOR_PREFIX : '') + label;
  const lower = full.toLowerCase();
  for (const existing of tagCounts().keys()) {
    if (existing.toLowerCase() === lower) return existing;
  }
  // Creators also ignore spaces and separators, so "Jane All Day" reuses an
  // existing "JaneAllDay" instead of becoming a second creator.
  if (creator) {
    const key = creatorKey(label);
    for (const existing of tagCounts('creator').keys()) {
      if (creatorKey(tagLabel(existing)) === key) return existing;
    }
  }
  return full;
}

// Identity of a creator name for duplicate detection: case, spaces and
// separators ignored ("Jane All Day" = "JaneAllDay" = "jane_all-day").
function creatorKey(name) {
  return name.toLowerCase().replace(/[\s_\-.'\u2019]+/g, '');
}

// Creator tags from before creators had their own category were saved with
// source 'f' (filename suggestions) and no prefix. Convert them once.
async function migrateCreatorTags() {
  const updates = {};
  for (const [id, tags] of Object.entries(metaTags)) {
    let changed = false;
    const next = {};
    for (const [name, src] of Object.entries(tags)) {
      const target = src === 'f' && !isCreatorTag(name) ? CREATOR_PREFIX + name : name;
      if (target !== name) changed = true;
      if (!(target in next)) next[target] = src;
    }
    if (changed) updates[id] = next;
  }
  if (Object.keys(updates).length) await saveTags(updates);
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

// ─── BROWSE ───────────────────────────────────────────────────────────────────
// Sort/filter choices, remembered between visits.
const SORT_DEFAULT_DIR = { name: 'asc', created: 'desc', duration: 'desc', size: 'desc', watched: 'desc', random: 'asc' };
let browsePrefs = { sort: 'name', dir: 'asc', filter: 'all', creators: [], tags: [], excluded: [], tagMode: 'all' };
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

  // Creators: a video matches if it has any of the chosen creators.
  const creators = browsePrefs.creators;
  if (creators.length) list = list.filter(v => creators.some(c => c in tagsOf(v.id)));

  // Exclusions (creators or tags): hide any video carrying one.
  const excluded = browsePrefs.excluded || [];
  if (excluded.length) list = list.filter(v => !excluded.some(t => t in tagsOf(v.id)));

  // Tags: videos must carry all chosen tags (or any, if toggled).
  const wanted = browsePrefs.tags;
  if (wanted.length) {
    list = list.filter(v => {
      const tags = tagsOf(v.id);
      return browsePrefs.tagMode === 'any'
        ? wanted.some(t => t in tags)
        : wanted.every(t => t in tags);
    });
  }

  if (query) list = list.filter(searchMatcher(query));
  return sortVideos(list);
}

// Lowercase, with underscores/dashes/dots/punctuation all treated as spaces,
// so a search typed the way names are displayed ("Creator Some Title")
// matches the raw filename ("Creator_Some_Title.mp4").
// A dot between digits ("2.1") is kept, so "Part2.1" and "Part2.2" stay
// distinct instead of both becoming "part2" plus a lone digit.
function searchNormalize(text) {
  return text.toLowerCase()
    .replace(/(\d)\.(?=\d)/g, '$1\u0001')
    .replace(/[\s_\-\u2013\u2014.,:;|()[\]'"!?&+]+/g, ' ')
    .replace(/\u0001/g, '.')
    .trim();
}

// Every word of the query must appear somewhere in the video's filename,
// display name, folder, creators or tags - checked both with spaces and
// with spaces removed, so "jane all day" finds "JaneAllDay" and vice versa.
function searchMatcher(query) {
  const words   = searchNormalize(query).split(' ').filter(Boolean);
  const compact = words.join('');
  return v => {
    const hay = searchNormalize([
      v.name, displayName(v.name), v.path || '', ...tagNames(v.id).map(tagLabel),
    ].join(' '));
    const hayCompact = hay.replace(/ /g, '');
    return hayCompact.includes(compact)
      || words.every(w => hay.includes(w) || hayCompact.includes(w));
  };
}

function refreshBrowse() {
  resetBrowseGrid(filterVideos(browseSearch.value.trim()));
  browseGrid.scrollTop = 0;
}

function syncBrowseControls() {
  browseSort.value = browsePrefs.sort;
  browseDir.textContent = browsePrefs.sort === 'random'
    ? '⟳ Shuffle'
    : browsePrefs.dir === 'asc' ? '↑ Asc' : '↓ Desc';
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

// Calls onLong after a ~0.5s press that doesn't move (a scroll cancels
// it), with a short vibration; the click that follows is swallowed so the
// card doesn't also play. Right-click does the same on desktop.
const LONG_PRESS_MS = 500;

// Android sends a tap when the finger lifts after a long-press, aimed at
// whatever is under it by then - the tag sheet's backdrop, which closes
// the sheet. So once a long-press fires, swallow taps until the finger
// is released, then just the one click that release produces (with a
// short timeout in case none comes), so real taps right after still work.
const RELEASE_GRACE_MS = 400;
let swallowTaps = false;
let swallowTapsUntil = 0;

function swallowTapsUntilRelease() {
  swallowTaps = true;
  // Failsafe in case no release event ever arrives.
  setTimeout(() => { swallowTaps = false; }, 5000);
}

for (const type of ['pointerup', 'touchend', 'mouseup', 'pointercancel', 'touchcancel']) {
  document.addEventListener(type, () => {
    if (!swallowTaps) return;
    swallowTaps = false;
    swallowTapsUntil = Date.now() + RELEASE_GRACE_MS;
  }, true);
}

document.addEventListener('click', e => {
  if (swallowTaps || Date.now() < swallowTapsUntil) {
    e.stopPropagation();
    e.preventDefault();
    if (!swallowTaps) swallowTapsUntil = 0; // that was the release click - done
  }
}, true);

function attachLongPress(target, onLong) {
  let timer = null;
  let fired = false;
  let startX = 0;
  let startY = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  // armSwallow: false for a desktop right-click, which produces no stray
  // release click to swallow.
  const fire = (armSwallow = true) => {
    cancel();
    fired = true;
    if (armSwallow) swallowTapsUntilRelease();
    if (navigator.vibrate) navigator.vibrate(15);
    onLong();
  };
  target.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    cancel();
    timer = setTimeout(fire, LONG_PRESS_MS);
  });
  target.addEventListener('pointermove', e => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) target.addEventListener(type, cancel);
  target.addEventListener('contextmenu', e => {
    e.preventDefault(); // no browser menu on long-press / right-click
    if (!fired) fire(e.button !== 2);
  });
  target.addEventListener('click', e => {
    if (!fired) return;
    fired = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

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
  img.draggable = false; // no image drag/save menu getting in the way of long-press
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
  watchedBadge.textContent = 'Watched';
  // Display-only tag count; tagging is a long-press on the card.
  const tagBtn = document.createElement('span');
  tagBtn.className = 'browse-tagbtn';
  attachLongPress(card, () => openTagEditor([video.id]));
  const check = document.createElement('span');
  check.className = 'browse-check';
  check.textContent = '✓';
  thumb.append(durBadge, watchedBadge, tagBtn, check);
  const creatorRow = document.createElement('div');
  creatorRow.className = 'browse-creator';

  const caption = document.createElement('div');
  caption.className = 'browse-caption';
  card.title = displayName(video.name); // full name on long-press/hover if still clamped

  card.append(creatorRow, thumb, caption);
  cardBadges.set(video.id, { dur: durBadge, watched: watchedBadge, tag: tagBtn, creator: creatorRow, caption });
  updateCardBadges(video);
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
const frameThumbAttempts = new Map(); // id -> failed attempts that looked transient
const FRAME_THUMB_RETRIES = 2;
const FRAME_THUMB_RETRY_DELAY_MS = 20000; // x attempt number: 20s, then 40s
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
      .catch(async err => {
        // A grab can fail because the video truly can't be decoded here, or
        // because the stream itself didn't answer (Drive slow/throttling, the
        // proxy's 25s first-byte limit) - which the browser also reports as
        // "can't play". Retry the second kind later; give up on the first.
        const transient = err.message.startsWith('timeout')
          || (err.message.startsWith('media-err') && await streamLooksDown(job.id));
        const attempt = (frameThumbAttempts.get(job.id) || 0) + 1;
        frameThumbAttempts.set(job.id, attempt);
        if (transient && attempt <= FRAME_THUMB_RETRIES) {
          reportFrameThumbMiss(job.id, `${err.message}-retry${attempt}`);
          setTimeout(() => {
            if (!job.img.isConnected) return;
            frameThumbQueue.push(job);
            pumpFrameThumbQueue();
          }, FRAME_THUMB_RETRY_DELAY_MS * attempt);
        } else {
          frameThumbFailed.add(job.id);
          reportFrameThumbMiss(job.id, transient ? `${err.message}-gaveup` : err.message);
        }
      })
      .finally(() => {
        frameThumbActive--;
        pumpFrameThumbQueue();
      });
  }
}

// The grab runs on the phone with no devtools, so send the failure reason
// to the server where it shows up in Vercel runtime logs.
// Asks the stream for its first byte. A healthy response means the earlier
// failure was the video itself; an error status or no answer means the
// stream was the problem and a retry may succeed.
async function streamLooksDown(id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${THUMBNAIL_HOST}/api/stream?id=${encodeURIComponent(id)}`, {
      headers: { Range: 'bytes=0-0' },
      signal:  ctrl.signal,
    });
    if (res.body) res.body.cancel().catch(() => {});
    return !res.ok;
  } catch (err) {
    return true;
  } finally {
    clearTimeout(timer);
  }
}

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

function creatorsOf(id) {
  return tagNames(id).filter(isCreatorTag).map(tagLabel)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Card title with a leading creator name removed, since the creator is
// shown on its own line above the thumbnail. Only strips when the name is
// followed by a separator (or is the whole title), so a creator called
// "Ann" doesn't eat the start of "Annual ...".
function titleWithoutCreator(video) {
  const name = displayName(video.name);
  const creators = creatorsOf(video.id).sort((a, b) => b.length - a.length);
  for (const c of creators) {
    if (!name.toLowerCase().startsWith(c.toLowerCase())) continue;
    const rest = name.slice(c.length);
    if (rest && !/^[\s\-\u2013\u2014_:|.,]/.test(rest)) continue;
    return rest.replace(/^[\s\-\u2013\u2014_:|.,]+/, '') || name;
  }
  return name;
}

function updateCardBadges(video) {
  const b = cardBadges.get(video.id);
  if (!b) return;
  const creators = creatorsOf(video.id);
  b.creator.textContent = creators.join(', ');
  b.caption.textContent = titleWithoutCreator(video);
  b.dur.textContent = video.durationMs ? formatDuration(video.durationMs) : '';
  b.dur.hidden      = !video.durationMs;
  b.watched.hidden  = !isRecentlyWatched(video.id);
  const n = tagNames(video.id).length;
  b.tag.textContent = n ? `🏷 ${n}` : '';
  b.tag.hidden = n === 0;
  b.tag.classList.toggle('has-tags', n > 0);
  b.tag.title = n
    ? tagNames(video.id).sort((x, y) => isCreatorTag(y) - isCreatorTag(x)).map(tagLabel).join(', ')
    : 'Add creator / tags';
}

function renderNextBatch() {
  const slice = browseFiltered.slice(browseRendered, browseRendered + BROWSE_BATCH);
  const frag = document.createDocumentFragment();
  for (const v of slice) frag.appendChild(buildCard(v));
  browseGrid.insertBefore(frag, browseSentinel);

  browseRendered += slice.length;
  browseCount.textContent = `Showing ${browseRendered} of ${browseFiltered.length} · Long-press a video to tag it`;

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
      setStatus('Signed in', 'ready');
    }
    await ensureMeta();
    if (!randomRank.size) reshuffle();
    browseSearch.value = '';
    populateFolderFilter();
    await migrateCreatorTags();
    // Drop remembered filters for tags/creators that no longer exist.
    const known = tagCounts();
    browsePrefs.creators = (browsePrefs.creators || []).filter(t => known.has(t) && isCreatorTag(t));
    browsePrefs.tags     = (browsePrefs.tags || []).filter(t => known.has(t) && !isCreatorTag(t));
    browsePrefs.excluded = (browsePrefs.excluded || []).filter(t => known.has(t));
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

// ─── FILTER BAR, SELECT MODE, TAG SHEETS ──────────────────────────────────────
let selectMode = false;
const selectedIds = new Set();

// Small DOM helper: el('button', { className: 'x', onclick }, 'text', child)
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function chipButton(text, className, onclick, title) {
  return el('button', { type: 'button', className: `tag-chip ${className || ''}`, textContent: text, onclick, title: title || '' });
}

// Bar under the sort controls: SELECT, a CREATOR and a TAGS filter button
// (each opens a searchable picker), manage, then the active filters as
// removable chips so it's clear what's narrowing the grid.
function refreshTagBar() {
  const { creators, tags } = browsePrefs;
  const excluded = browsePrefs.excluded || [];
  const creatorCount = creators.length + excluded.filter(isCreatorTag).length;
  const tagCount     = tags.length + excluded.filter(t => !isCreatorTag(t)).length;
  browseTagBar.innerHTML = '';
  browseTagBar.append(
    chipButton(selectMode ? '✕ Cancel' : '☑ Select',
      'tag-chip-action' + (selectMode ? ' active' : ''), () => setSelectMode(!selectMode)),
    chipButton(creatorCount ? `👤 Creator · ${creatorCount}` : '👤 Creator ▾',
      'tag-chip-action' + (creatorCount ? ' filtering' : ''), () => openFilterPicker('creator')),
    chipButton(tagCount ? `🏷 Tags · ${tagCount}` : '🏷 Tags ▾',
      'tag-chip-action' + (tagCount ? ' filtering' : ''), () => openFilterPicker('tag')),
    chipButton('⚙', 'tag-chip-action', () => openTagManager(), 'Manage creators and tags')
  );
  const removeFilter = name => () => {
    browsePrefs.creators = browsePrefs.creators.filter(t => t !== name);
    browsePrefs.tags     = browsePrefs.tags.filter(t => t !== name);
    browsePrefs.excluded = excluded.filter(t => t !== name);
    saveBrowsePrefs();
    refreshTagBar();
    refreshBrowse();
  };
  for (const name of [...creators, ...tags]) {
    browseTagBar.append(chipButton(`${isCreatorTag(name) ? '👤 ' : ''}${tagLabel(name)} ✕`, 'active',
      removeFilter(name), 'Remove this filter'));
  }
  for (const name of excluded) {
    browseTagBar.append(chipButton(`− ${isCreatorTag(name) ? '👤 ' : ''}${tagLabel(name)} ✕`, 'excluded',
      removeFilter(name), 'Excluded - tap to remove this filter'));
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

const SHEET_BACKDROP_GRACE_MS = 600;
let sheetOpenedAt = 0;

function openSheet(...content) {
  sheet.innerHTML = '';
  sheet.append(...content);
  sheetBackdrop.hidden = false;
  sheetOpenedAt = Date.now();
}

function closeSheet() {
  sheetBackdrop.hidden = true;
  sheet.innerHTML = '';
}

sheetBackdrop.addEventListener('click', e => {
  // Ignore a backdrop tap right after opening - it's almost always the
  // tail of the gesture that opened the sheet, not a deliberate dismiss.
  if (e.target === sheetBackdrop && Date.now() - sheetOpenedAt > SHEET_BACKDROP_GRACE_MS) closeSheet();
});

function searchInput(placeholder, oninput) {
  const input = el('input', { type: 'search', className: 'sheet-input', placeholder });
  input.addEventListener('input', oninput);
  return input;
}

function matchesQuery(name, query) {
  return !query || tagLabel(name).toLowerCase().includes(query);
}

// Searchable multi-select picker for the creator or tag filter. Changes
// apply on DONE.
// Searchable picker for the creator or tag filter. Tapping a row cycles
// off -> include (✓) -> exclude (✕) -> off. Changes apply on Done.
function openFilterPicker(kind) {
  const isCreator = kind === 'creator';
  const prefKey   = isCreator ? 'creators' : 'tags';
  const counts    = tagCounts(kind);
  const state     = new Map(); // name -> 'include' | 'exclude'
  for (const n of browsePrefs[prefKey]) state.set(n, 'include');
  for (const n of browsePrefs.excluded || []) if (tagKind(n) === kind) state.set(n, 'exclude');
  let query  = '';
  let byName = isCreator; // creators default to A-Z, tags to most-used
  let mode   = browsePrefs.tagMode;

  const list = el('div', { className: 'sheet-list picker-list' });
  const sortBtn = el('button', { type: 'button', className: 'sheet-btn small' });
  const modeBtn = el('button', { type: 'button', className: 'sheet-btn small' });

  const render = () => {
    sortBtn.textContent = byName ? 'Sort: A–Z' : 'Sort: Most videos';
    modeBtn.textContent = mode === 'any' ? 'Match any' : 'Match all';
    list.innerHTML = '';
    let names = [...counts.keys()].filter(n => matchesQuery(n, query));
    if (byName) names.sort((a, b) => tagLabel(a).localeCompare(tagLabel(b), undefined, { numeric: true }));
    // Keep included/excluded ones on top so they're easy to change.
    names.sort((a, b) => state.has(b) - state.has(a));
    if (!names.length) {
      list.append(el('div', { className: 'sheet-note',
        textContent: counts.size ? 'No matches.' : `No ${isCreator ? 'creators' : 'tags'} yet.` }));
    }
    for (const name of names) {
      const st = state.get(name);
      list.append(el('button', {
        type: 'button',
        className: `sheet-list-row tri-row ${st || ''}`,
        onclick: () => {
          if (!st) state.set(name, 'include');
          else if (st === 'include') state.set(name, 'exclude');
          else state.delete(name);
          render();
        },
      },
        el('span', { className: 'tri-box', textContent: st === 'include' ? '✓' : st === 'exclude' ? '✕' : '' }),
        el('span', { className: 'sheet-list-name', textContent: tagLabel(name) }),
        el('span', { className: 'sheet-list-count', textContent: String(counts.get(name)) })));
    }
  };
  sortBtn.onclick = () => { byName = !byName; render(); };
  modeBtn.onclick = () => { mode = mode === 'any' ? 'all' : 'any'; render(); };

  const done = () => {
    browsePrefs[prefKey] = [...state].filter(([, st]) => st === 'include').map(([n]) => n);
    browsePrefs.excluded = [
      ...(browsePrefs.excluded || []).filter(n => tagKind(n) !== kind),
      ...[...state].filter(([, st]) => st === 'exclude').map(([n]) => n),
    ];
    if (!isCreator) browsePrefs.tagMode = mode;
    saveBrowsePrefs();
    closeSheet();
    refreshTagBar();
    refreshBrowse();
  };

  render();
  openSheet(
    el('div', { className: 'sheet-title', textContent: isCreator ? 'Filter by creator' : 'Filter by tag' }),
    el('div', { className: 'sheet-note', textContent: (isCreator
      ? 'Shows videos by any of the ✓ creators. '
      : 'Match all: videos with every ✓ tag. Match any: videos with at least one. ')
      + 'Tap once to include (✓), twice to exclude (✕), again to clear.' }),
    searchInput(isCreator ? 'Search creators…' : 'Search tags…', e => { query = e.target.value.trim().toLowerCase(); render(); }),
    el('div', { className: 'sheet-row' }, sortBtn, isCreator ? null : modeBtn),
    list,
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'Clear', onclick: () => { state.clear(); render(); } }),
      el('button', { type: 'button', className: 'sheet-btn primary', textContent: 'Done', onclick: done }))
  );
}

// Tag editor for one or many videos, split into Creator and Tags sections.
// Each tag is in one of three states:
//   'all'  - every chosen video has it (or will, once saved)
//   'none' - no chosen video has it (or will lose it)
//   'some' - mixed; left exactly as-is on save unless changed
// Tapping cycles all <-> none (and a mixed tag goes some -> all -> none -> some).
// With many tags, only the ones already on the video(s) show until you
// type in the section's box, which then lists matches.
const EDITOR_SHOW_ALL_MAX = 24;

function openTagEditor(ids) {
  const counts = new Map();
  for (const id of ids) for (const t of tagNames(id)) counts.set(t, (counts.get(t) || 0) + 1);
  const state = new Map();
  for (const name of tagCounts().keys()) {
    const c = counts.get(name) || 0;
    state.set(name, c === ids.length ? 'all' : c === 0 ? 'none' : 'some');
  }
  const original = new Map(state);

  const section = kind => {
    const isCreator = kind === 'creator';
    let query = '';
    const chips = el('div', { className: 'sheet-chips' });
    const render = () => {
      chips.innerHTML = '';
      const names = [...state.keys()].filter(n => tagKind(n) === kind);
      const showAll = names.length <= EDITOR_SHOW_ALL_MAX;
      const visible = names.filter(n =>
        query ? matchesQuery(n, query) : (showAll || state.get(n) !== 'none' || original.get(n) !== 'none'));
      visible.sort((a, b) => (state.get(a) === 'none') - (state.get(b) === 'none')
        || tagLabel(a).localeCompare(tagLabel(b), undefined, { numeric: true }));
      for (const name of visible.slice(0, 60)) {
        const st = state.get(name);
        chips.append(chipButton(
          st === 'some' ? `${tagLabel(name)} (${counts.get(name)}/${ids.length})` : tagLabel(name),
          `state-${st}`,
          () => {
            const next = st === 'all' ? 'none'
              : st === 'none' ? (original.get(name) === 'some' ? 'some' : 'all')
              : 'all';
            state.set(name, next);
            render();
          }));
      }
      if (!visible.length) {
        chips.append(el('div', { className: 'sheet-note', textContent: query
          ? `No match. Press ADD to create "${query}".`
          : names.length ? 'None yet. Type to search or add.' : `No ${isCreator ? 'creators' : 'tags'} yet. Type one below.` }));
      }
    };
    const input = el('input', {
      type: 'search',
      className: 'sheet-input',
      placeholder: isCreator ? 'Search or add creator…' : 'Search or add tag…',
      maxLength: TAG_NAME_MAX,
    });
    input.addEventListener('input', () => { query = input.value.trim().toLowerCase(); render(); });
    const add = () => {
      const name = canonicalTag(input.value, isCreator);
      if (!name) return;
      state.set(name, 'all');
      input.value = '';
      query = '';
      render();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    render();
    return el('div', { className: 'sheet-section' },
      el('div', { className: 'sheet-section-title', textContent: isCreator ? '👤 Creator' : '🏷 Tags' }),
      chips,
      el('div', { className: 'sheet-row' },
        input,
        el('button', { type: 'button', className: 'sheet-btn', textContent: 'Add', onclick: add })));
  };

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

  const title = ids.length === 1 ? displayName(findVideo(ids[0]).name) : `${ids.length} videos`;
  openSheet(
    el('div', { className: 'sheet-title', textContent: title }),
    section('creator'),
    section('tag'),
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'Cancel', onclick: closeSheet }),
      el('button', { type: 'button', className: 'sheet-btn primary', textContent: 'Save', onclick: save }))
  );
}

// Manage creators and tags: switch between the two lists, search, rename,
// move between creator/tag, delete; plus suggestions and backup.
function openTagManager(kind = 'creator') {
  let query = '';
  const list = el('div', { className: 'sheet-list picker-list' });
  const render = () => {
    list.innerHTML = '';
    const counts = tagCounts(kind);
    const names = [...counts.keys()].filter(n => matchesQuery(n, query))
      .sort((a, b) => tagLabel(a).localeCompare(tagLabel(b), undefined, { numeric: true }));
    if (!names.length) list.append(el('div', { className: 'sheet-note', textContent: counts.size ? 'No matches.' : 'None yet.' }));
    for (const name of names) {
      list.append(el('div', { className: 'sheet-list-row' },
        el('span', { className: 'sheet-list-name', textContent: tagLabel(name) }),
        el('span', { className: 'sheet-list-count', textContent: String(counts.get(name)) }),
        el('button', { type: 'button', className: 'sheet-btn small', textContent: 'Rename', onclick: () => renameTag(name) }),
        el('button', { type: 'button', className: 'sheet-btn small',
          textContent: kind === 'creator' ? '→ Tag' : '→ Creator',
          title: kind === 'creator' ? 'Make this an ordinary tag' : 'Make this a creator',
          onclick: () => convertTag(name) }),
        el('button', { type: 'button', className: 'sheet-btn small danger', textContent: 'Delete', onclick: () => deleteTag(name, counts.get(name)) })));
    }
  };
  const tab = (k, label) => el('button', {
    type: 'button',
    className: 'sheet-tab' + (k === kind ? ' active' : ''),
    textContent: `${label} (${tagCounts(k).size})`,
    onclick: () => openTagManager(k),
  });

  render();
  openSheet(
    el('div', { className: 'sheet-title', textContent: 'Manage creators & tags' }),
    el('div', { className: 'sheet-row' }, tab('creator', '👤 Creators'), tab('tag', '🏷 Tags')),
    searchInput('Search…', e => { query = e.target.value.trim().toLowerCase(); render(); }),
    list,
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'Suggest creators', onclick: openCreatorSuggestions }),
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'Download backup', onclick: downloadTagBackup }),
      el('button', { type: 'button', className: 'sheet-btn', textContent: 'Close', onclick: closeSheet }))
  );
}

// Moves every use of oldName to target (merging if target already exists),
// keeping each video's original source marker, and fixes saved filters.
async function moveTag(oldName, target) {
  const updates = {};
  for (const [id, tags] of Object.entries(metaTags)) {
    if (!(oldName in tags)) continue;
    const next = { ...tags };
    const src = next[oldName];
    delete next[oldName];
    if (!(target in next)) next[target] = src;
    updates[id] = next;
  }
  const swap = arr => [...new Set(arr.map(t => (t === oldName ? target : t)))];
  browsePrefs.creators = swap(browsePrefs.creators).filter(isCreatorTag);
  browsePrefs.tags     = swap(browsePrefs.tags).filter(t => !isCreatorTag(t));
  browsePrefs.excluded = swap(browsePrefs.excluded || []);
  saveBrowsePrefs();
  await saveTags(updates);
  refreshBrowse();
}

async function renameTag(oldName) {
  const creator = isCreatorTag(oldName);
  const typed = prompt(`Rename ${creator ? 'creator' : 'tag'} "${tagLabel(oldName)}" to:`, tagLabel(oldName));
  if (typed == null) return;
  let target = canonicalTag(typed, creator);
  if (!target) return;
  if (target === oldName) {
    // Same name ignoring case: allow a pure capitalization change.
    const wanted = (creator ? CREATOR_PREFIX : '') + typed.replace(/\s+/g, ' ').trim().slice(0, TAG_NAME_MAX);
    if (wanted === oldName) return;
    target = wanted;
  }
  await moveTag(oldName, target);
  openTagManager(tagKind(oldName));
}

async function convertTag(name) {
  const toCreator = !isCreatorTag(name);
  await moveTag(name, canonicalTag(tagLabel(name), toCreator));
  openTagManager(tagKind(name));
}

async function deleteTag(name, count) {
  if (!confirm(`Remove ${isCreatorTag(name) ? 'creator' : 'tag'} "${tagLabel(name)}" from ${count} video(s)?`)) return;
  const updates = {};
  for (const [id, tags] of Object.entries(metaTags)) {
    if (!(name in tags)) continue;
    const next = { ...tags };
    delete next[name];
    updates[id] = next;
  }
  browsePrefs.creators = browsePrefs.creators.filter(t => t !== name);
  browsePrefs.tags     = browsePrefs.tags.filter(t => t !== name);
  browsePrefs.excluded = (browsePrefs.excluded || []).filter(t => t !== name);
  saveBrowsePrefs();
  await saveTags(updates);
  refreshBrowse();
  openTagManager(tagKind(name));
}

// Most filenames start with the creator: "Creator_Title..." or
// "Creator - Title...". Proposes those as creator tags for review - nothing
// is saved until confirmed, and names without that shape are skipped.
function creatorFromName(name) {
  const m = /^([^_]{2,40}?)(?:_| - )/.exec(name);
  if (!m) return null;
  const creator = m[1].replace(/\s+/g, ' ').trim();
  if (!creator || /^\d+$/.test(creator)) return null;
  return creator;
}

// A filename prefix looks like a title rather than a creator when it only
// shows up once, or reads like a sentence.
const CREATOR_MAX_WORDS = 4;

function looksLikeTitle(name, count) {
  return count < 2 || name.split(' ').length > CREATOR_MAX_WORDS;
}

function openCreatorSuggestions() {
  // Existing creator tags by key, most-used spelling first.
  const existingByKey = new Map();
  for (const name of tagCounts('creator').keys()) {
    const key = creatorKey(tagLabel(name));
    if (!existingByKey.has(key)) existingByKey.set(key, name);
  }

  // Group filename prefixes by key so spelling variants become one creator.
  const groups = new Map(); // key -> { spellings: Map(label -> count), ids: [] }
  for (const v of videoCache || []) {
    const raw = creatorFromName(v.name);
    if (!raw) continue;
    const key = creatorKey(raw);
    if (!key) continue;
    const has = tagNames(v.id).some(t => isCreatorTag(t) && creatorKey(tagLabel(t)) === key);
    if (has) continue;
    if (!groups.has(key)) groups.set(key, { spellings: new Map(), ids: [] });
    const g = groups.get(key);
    g.spellings.set(raw, (g.spellings.get(raw) || 0) + 1);
    g.ids.push(v.id);
  }

  const suggestions = [...groups].map(([key, g]) => {
    const spellings = [...g.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const known = existingByKey.has(key); // already a confirmed creator tag
    const tag = known ? existingByKey.get(key) : CREATOR_PREFIX + spellings[0][0];
    return { tag, known, ids: g.ids, variants: spellings.map(([s]) => s).filter(s => s !== tagLabel(tag)) };
  }).sort((a, b) => b.ids.length - a.ids.length || a.tag.localeCompare(b.tag));

  // A name you've already tagged as a creator is never treated as a title.
  const isTitle = x => !x.known && looksLikeTitle(tagLabel(x.tag), x.ids.length);
  const likely = suggestions.filter(x => !isTitle(x));
  const titles = suggestions.filter(isTitle);

  const boxes = [];
  const row = (x, checked) => {
    const box = el('input', { type: 'checkbox', checked });
    boxes.push([box, x]);
    return el('label', { className: 'sheet-list-row' },
      box,
      el('span', { className: 'sheet-list-name' },
        tagLabel(x.tag),
        x.variants.length ? el('span', { className: 'sheet-list-variants', textContent: ` · also: ${x.variants.join(', ')}` }) : null),
      el('span', { className: 'sheet-list-count', textContent: String(x.ids.length) }));
  };

  // Creator tags already saved that only differ by case/spaces/separators.
  const dupGroups = new Map();
  for (const [name, count] of tagCounts('creator')) {
    const key = creatorKey(tagLabel(name));
    if (!dupGroups.has(key)) dupGroups.set(key, []);
    dupGroups.get(key).push([name, count]);
  }
  const dups = [...dupGroups.values()].filter(g => g.length > 1);

  const content = [
    el('div', { className: 'sheet-title', textContent: 'Suggested creators' }),
    el('div', { className: 'sheet-note', textContent: 'From the start of each filename. Spellings that differ only by capitals, spaces or separators are combined. Untick any that look wrong.' }),
  ];

  if (dups.length) {
    const dupList = el('div', { className: 'sheet-list' });
    for (const group of dups) {
      const [keep] = group; // most-used spelling (tagCounts is sorted by count)
      const others = group.slice(1);
      dupList.append(el('div', { className: 'sheet-list-row' },
        el('span', { className: 'sheet-list-name' },
          tagLabel(keep[0]),
          el('span', { className: 'sheet-list-variants', textContent: ` ← ${others.map(([n]) => tagLabel(n)).join(', ')}` })),
        el('button', { type: 'button', className: 'sheet-btn small', textContent: 'Merge', onclick: async () => {
          for (const [name] of others) await moveTag(name, keep[0]);
          openCreatorSuggestions();
        } })));
    }
    content.push(
      el('div', { className: 'sheet-section-title', textContent: `Duplicate creators (${dups.length})` }),
      dupList);
  }

  const likelyList = el('div', { className: 'sheet-list picker-list' });
  if (!likely.length) likelyList.append(el('div', { className: 'sheet-note', textContent: 'No new creators to suggest.' }));
  for (const x of likely) likelyList.append(row(x, true));
  content.push(el('div', { className: 'sheet-section-title', textContent: `Likely creators (${likely.length})` }), likelyList);

  if (titles.length) {
    const titleList = el('div', { className: 'sheet-list picker-list' });
    for (const x of titles) titleList.append(row(x, false));
    content.push(el('details', { className: 'sheet-details' },
      el('summary', { textContent: `Probably titles, not creators (${titles.length})` }),
      el('div', { className: 'sheet-note', textContent: 'Seen only once or reads like a sentence. Tick any that are real creators.' }),
      titleList));
  }

  const apply = async () => {
    const updates = {};
    for (const [box, x] of boxes) {
      if (!box.checked) continue;
      for (const id of x.ids) {
        updates[id] = { ...(updates[id] || tagsOf(id)), [x.tag]: 'f' };
      }
    }
    closeSheet();
    if (Object.keys(updates).length) {
      await saveTags(updates);
      refreshBrowse();
    }
  };

  content.push(el('div', { className: 'sheet-row sheet-actions' },
    el('button', { type: 'button', className: 'sheet-btn', textContent: 'Back', onclick: () => openTagManager('creator') }),
    el('button', { type: 'button', className: 'sheet-btn primary', textContent: 'Apply', onclick: apply })));
  openSheet(...content);
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

// Stays in the library: the bar at the bottom shows what was last opened,
// with a button to send it to VLC again if the first launch didn't take.
async function playVideo(video) {
  lastPicked = video;
  nowPlayingTitle.textContent = `Warming stream… ${displayName(video.name)}`;
  nowPlayingBtn.disabled = true;
  nowPlaying.hidden = false;

  await prewarmStream(video.id);
  if (lastPicked !== video) return; // another video was tapped meanwhile

  openInVlc();
  nowPlayingTitle.textContent = displayName(video.name);
  nowPlayingBtn.disabled = false;
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
