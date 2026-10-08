// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CLIENT_ID   = '139266625585-isecrhdfdfkqr5mo7cjhcgvuohjrd0b5.apps.googleusercontent.com';
const ROOT_FOLDER = '1JBAz8KFVSHfnzojWnhECD7gtBRkLBCk9';
const SCOPES      = 'https://www.googleapis.com/auth/drive.readonly';
const VIDEO_MIME_TYPES = [
  'video/mp4', 'video/x-matroska', 'video/webm',
  'video/quicktime', 'video/x-msvideo', 'video/mpeg',
  'video/3gpp', 'video/x-flv', 'video/x-ms-wmv'
];
const APP_VERSION = 'v46';
const BROWSE_BATCH = 50;
// Where api/ (stream, thumbnails, tags) is served from.
const API_BASE = 'https://randomvidpick-139266625585.us-east1.run.app';
const META_URL = `${API_BASE}/api/meta`;
// Compilations run on their own Cloud Run service with more CPU (smooth mode
// re-encodes); the main API stays small so normal playback stays cheap.
const COMPILE_BASE = 'https://rvp-compile-139266625585.us-east1.run.app';
const RECENT_MS      = 30 * 24 * 3600 * 1000; // "recently watched" = past month

// Display-only cleanup of filenames (Drive names and search are untouched):
// - trailing video extensions, including doubled ones like "name.mp4.mp4"
// - a "_Downloaded_YYYY_MM_DD_HH_MM_SS" stamp some download tools append
// - an "_original" suffix some downloads carry
// - resolution labels ("1080p", "720p", "1080HD", "4K", "UHD"...) - the
//   quality tags show resolution, from Drive's own metadata
// - underscores used as word separators
const VIDEO_EXT_RE      = /(\.(mp4|m4v|mkv|webm|mov|avi|mpe?g|3gp|flv|wmv))+$/i;
const DOWNLOAD_STAMP_RE = /[_\s]*downloaded(?:_\d{1,4}){6}$/i;
const ORIGINAL_RE       = /[_\s]+original$/i;
// A label standing alone between separators (start/end, space, _ - . brackets).
const RESOLUTION_RE     = /(^|[\s_\-.(\[])(?:\d{3,4}[pi](?:HD)?|\d{3,4}HD|[2-8]K|UHD|FHD|QHD)(?=$|[\s_\-.)\],])/gi;
const GLUED_4K_RE       = /(?<=[a-z])[4-8]K$/i; // "...Tease4K" at the very end
function displayName(name) {
  const cleaned = name
    .replace(VIDEO_EXT_RE, '')
    .replace(DOWNLOAD_STAMP_RE, '')
    .replace(ORIGINAL_RE, '')
    .replace(RESOLUTION_RE, '$1')
    .replace(GLUED_4K_RE, '')
    .replace(/_+/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, '')         // brackets left empty
    .replace(/\s+([,.])/g, '$1')
    .replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, '') // separators left dangling at either end
    .replace(/\s+/g, ' ')
    .trim();
  // A name that was nothing but labels keeps them rather than going blank.
  return cleaned || name.replace(VIDEO_EXT_RE, '') || name;
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
const browseFiltersBtn = document.getElementById('browseFiltersBtn');
const browseFiltersClear = document.getElementById('browseFiltersClear');
const browseSelectBtn  = document.getElementById('browseSelectBtn');
const browseTagBar     = document.getElementById('browseTagBar');
const browseRandomBtn  = document.getElementById('browseRandomBtn');
const browseCompileBtn = document.getElementById('browseCompileBtn');
const selectBar        = document.getElementById('selectBar');
const selectCount      = document.getElementById('selectCount');
const sheetBackdrop    = document.getElementById('sheetBackdrop');
const sheet            = document.getElementById('sheet');

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function signInUrl(state) {
  const redirectUri = encodeURIComponent(window.location.href.split('?')[0].split('#')[0]);
  return `https://accounts.google.com/o/oauth2/v2/auth`
    + `?client_id=${encodeURIComponent(CLIENT_ID)}`
    + `&redirect_uri=${redirectUri}`
    + `&response_type=token`
    + `&scope=${encodeURIComponent(SCOPES)}`
    // No prompt=consent: once access is granted, Google skips the consent
    // screen (and the "unverified app" warning shown with it) on later
    // sign-ins instead of forcing it every time.
    + `&prompt=select_account`
    + (state ? `&state=${state}` : '');
}

// Google's sign-in opens in its own window, so the app page never leaves
// itself: a browser setting that applies to Google's pages (e.g. "Desktop
// site" for google.com) can't carry back into the app the way it did when
// the app navigated there and back. The window hands the token over
// through localStorage (shared with this page) and closes. If the window
// can't open, sign-in falls back to navigating there as before.
const SIGN_IN_POPUP_STATE = 'rvp_popup';

function signIn() {
  const popup = window.open(signInUrl(SIGN_IN_POPUP_STATE), 'rvp_signin', 'popup,width=480,height=680');
  if (!popup) {
    window.location.href = signInUrl();
    return;
  }
  setStatus('Finish signing in in the Google window…', 'loading');
  waitForSignInWindow();
}

function waitForSignInWindow() {
  const before = localStorage.getItem('rvp_token');
  const check = () => {
    const token  = localStorage.getItem('rvp_token');
    const expiry = Number(localStorage.getItem('rvp_token_expiry') || 0);
    if (!token || token === before || Date.now() >= expiry) return;
    stop();
    accessToken = token;
    updateUI(true);
    scheduleRefresh();
  };
  const onMessage = e => { if (e.origin === window.location.origin && e.data && e.data.type === 'rvp_signed_in') check(); };
  const timer = setInterval(check, 1000);
  const giveUp = setTimeout(() => { stop(); if (!accessToken) updateUI(false); }, 10 * 60e3);
  function stop() {
    clearInterval(timer);
    clearTimeout(giveUp);
    window.removeEventListener('message', onMessage);
    window.removeEventListener('storage', check);
    window.removeEventListener('focus', check);
    document.removeEventListener('visibilitychange', check);
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('storage', check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
}

// In the sign-in window: nothing left to do but close.
function showSignedInWindow() {
  document.body.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;font-family:inherit;color:#e8eaed;background:#0f1115;padding:2rem;text-align:center';
  const text = document.createElement('div');
  text.textContent = 'Signed in. You can close this window and go back to the app.';
  const btn = document.createElement('button');
  btn.textContent = 'Close';
  btn.className = 'btn btn-primary';
  btn.style.width = 'auto';
  btn.onclick = () => window.close();
  box.append(text, btn);
  document.body.append(box);
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
  pendingLibrary = null;
  localStorage.removeItem('rvp_token');
  localStorage.removeItem(LIBRARY_CACHE_KEY);
  localStorage.removeItem('rvp_token_expiry');
  updateUI(false);
}

// Returns 'window' when this page is the sign-in window (see signIn) and
// should do nothing else.
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

  const expiry = Date.now() + (parseInt(expiresIn) * 1000);
  localStorage.setItem('rvp_token', token);
  localStorage.setItem('rvp_token_expiry', expiry.toString());
  history.replaceState(null, '', window.location.pathname);

  // The sign-in window: hand over and close. (If the phone instead brought
  // the reply back into the installed app itself, just carry on there.)
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  if (params.get('state') === SIGN_IN_POPUP_STATE && !standalone) {
    try { if (window.opener) window.opener.postMessage({ type: 'rvp_signed_in' }, window.location.origin); } catch (err) {}
    window.close();
    showSignedInWindow(); // still open: the browser didn't let it close itself
    return 'window';
  }

  accessToken = token;
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

// Walks the library folder tree with several Drive requests in flight at
// once (each folder's videos and subfolders are listed together, and
// sibling folders in parallel) - a one-request-at-a-time walk took 10+ s.
const DRIVE_PARALLEL = 8;
const VIDEO_FIELDS   = 'nextPageToken,files(id,name,createdTime,size,videoMediaMetadata(durationMillis,width,height))';

async function collectVideos(rootId) {
  const videos = [];
  let active = 0;
  const waiting = [];
  const acquire = () => (active < DRIVE_PARALLEL
    ? (active++, Promise.resolve())
    : new Promise(resolve => waiting.push(resolve)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  async function listAll(query, fields, onFile) {
    let pageToken = null;
    do {
      let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}`
        + `&fields=${encodeURIComponent(fields)}&pageSize=1000`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      await acquire();
      let data;
      try { data = await driveRequest(url); } finally { release(); }
      (data.files || []).forEach(onFile);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
  }

  const mimeQuery = VIDEO_MIME_TYPES.map(m => `mimeType='${m}'`).join(' or ');
  async function walk(folderId, path) {
    const subfolders = [];
    await Promise.all([
      listAll(`(${mimeQuery}) and '${folderId}' in parents and trashed=false`, VIDEO_FIELDS, f => {
        const meta = f.videoMediaMetadata || {};
        const driveMs = Number(meta.durationMillis);
        videos.push({
          id:         f.id,
          name:       f.name,
          path,
          created:    Date.parse(f.createdTime) || 0,
          size:       Number(f.size) || 0,
          // Drive only knows duration for videos it finished processing;
          // the rest get filled in from KV (loadMeta) or measured in-browser.
          durationMs: driveMs > 0 ? driveMs : null,
          // Lets smooth compilations pick an output resolution.
          width:      Number(meta.width) || 0,
          height:     Number(meta.height) || 0,
        });
      }),
      listAll(`mimeType='application/vnd.google-apps.folder' and '${folderId}' in parents and trashed=false`,
        'nextPageToken,files(id,name)', f => subfolders.push(f)),
    ]);
    await Promise.all(subfolders.map(f => walk(f.id, path ? `${path} / ${f.name}` : f.name)));
  }

  await walk(rootId, '');
  return videos;
}

// The last scan is kept on the device so the library opens instantly; a
// fresh scan then runs in the background (see refreshLibraryInBackground).
const LIBRARY_CACHE_KEY = 'rvp_library';

function loadLibraryCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_CACHE_KEY) || 'null');
    return saved && Array.isArray(saved.videos) ? saved.videos : null;
  } catch (err) {
    return null;
  }
}

function saveLibraryCache(videos) {
  try {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), videos }));
  } catch (err) { /* full or private mode - the next open just scans again */ }
}

function librarySignature(videos) {
  return videos.map(v => `${v.id}\u0001${v.name}\u0001${v.path}`).sort().join('\u0002');
}

// ─── META (durations + watched history, stored in KV via /api/meta) ──────────
let metaWatched  = {};   // fileId -> last-watched epoch ms
let metaTags     = {};   // fileId -> {tagName: source}  (m manual, f filename, i imported)
let metaMedia    = {};   // fileId -> [width, height (as shown), fps, has audio 1/0, duration ms, stored short side, audio only 1/0], from the server's header check
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
        metaMedia = meta.media || {};
        for (const v of videoCache || []) {
          if (!v.durationMs && meta.durations && meta.durations[v.id]) {
            v.durationMs = meta.durations[v.id];
          }
          if (!v.durationMs && metaMedia[v.id] && metaMedia[v.id][4]) v.durationMs = metaMedia[v.id][4];
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

function formatBytes(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
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

// Picture size as players show it: from the server's header check
// (api/analyze.js, via /api/meta) once it has read the file, else Drive's.
// Drive gives the stored size, which is sideways for phone videos marked
// "rotate 90", and none at all for some files.
function sizeOf(video) {
  const m = metaMedia[video.id];
  return m && m[0] && m[1] ? [m[0], m[1]] : [video.width || 0, video.height || 0];
}

// Quality tags ("quality:4K" ...) are worked out from the resolution - the
// stored size's short side, before any pixel-aspect stretch - never stored:
// always right, nothing to back-fill, and the tag editor and manager can't
// change them. They only take part in filtering and search.
const QUALITY_PREFIX = 'quality:';

function isQualityTag(name) {
  return name.startsWith(QUALITY_PREFIX);
}

function qualityTag(video) {
  const m = metaMedia[video.id];
  const short = m && m[5] ? m[5] : Math.min(video.width || 0, video.height || 0);
  if (!short) return null;
  const label = short >= 2000 ? '4K' : short >= 1300 ? '1440p' : short >= 1000 ? '1080p' : short >= 700 ? '720p' : 'SD';
  return QUALITY_PREFIX + label;
}

// Shape tags ("shape:Portrait" ...) work the same way: filter to one shape
// and a Smooth compilation has no mixed frames.
const SHAPE_PREFIX = 'shape:';
const SHAPE_ORDER  = ['Landscape', 'Portrait', 'Square'];

function isShapeTag(name) {
  return name.startsWith(SHAPE_PREFIX);
}

function shapeTag(video) {
  const [w, h] = sizeOf(video);
  if (!w || !h) return null;
  const label = w > h * 1.1 ? 'Landscape' : h > w * 1.1 ? 'Portrait' : 'Square';
  return SHAPE_PREFIX + label;
}

// Frame rate ("fps:60", shown "60 fps"), "audio:none" ("No audio") and
// "audio:only" ("Audio only" - no picture at all) come only from the
// header check, so videos it hasn't read yet have none of them.
const FPS_PREFIX     = 'fps:';
const NO_AUDIO_TAG   = 'audio:none';
const AUDIO_ONLY_TAG = 'audio:only';

function isFpsTag(name) {
  return name.startsWith(FPS_PREFIX);
}

// Frame rates are grouped to the nearest common rate: 24 takes film and
// PAL (23.98-26), 30 NTSC (27-36), 45 the odd 43-47, 60 takes 48-69 (50
// included); faster ones snap to 90 / 120 / 144 / 240. The library has no
// videos near the boundaries.
function fpsBin(fps) {
  if (!fps) return null;
  if (fps < 27) return 24;
  if (fps < 37) return 30;
  if (fps < 48) return 45;
  if (fps < 70) return 60;
  return [90, 120, 144, 240].reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
}

function fpsTag(video) {
  const m = metaMedia[video.id];
  const bin = m && fpsBin(m[2]);
  return bin ? FPS_PREFIX + bin : null;
}

function audioTag(video) {
  const m = metaMedia[video.id];
  return !m ? null : m[6] ? AUDIO_ONLY_TAG : !m[3] ? NO_AUDIO_TAG : null;
}

// Stored tags plus the video's computed tags (quality, shape, frame rate,
// no audio) - for filters and search only.
function computedTags(video) {
  return [qualityTag(video), shapeTag(video), fpsTag(video), audioTag(video)].filter(Boolean);
}

function filterTagsOf(video) {
  const computed = {};
  for (const t of computedTags(video)) computed[t] = 'q';
  return { ...tagsOf(video.id), ...computed };
}

function tagLabel(name) {
  if (isQualityTag(name)) return name.slice(QUALITY_PREFIX.length);
  if (isShapeTag(name)) return name.slice(SHAPE_PREFIX.length);
  if (isFpsTag(name)) return `${name.slice(FPS_PREFIX.length)} fps`;
  if (name === NO_AUDIO_TAG) return 'No audio';
  if (name === AUDIO_ONLY_TAG) return 'Audio only';
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

const QUALITY_ORDER = ['4K', '1440p', '1080p', '720p', 'SD'];

// Videos per computed tag ('quality:1080p' -> 2363), for the Format tab.
function formatCounts() {
  const counts = new Map();
  for (const v of videoCache || []) {
    for (const t of computedTags(v)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
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

// ─── STREAM LINKS ─────────────────────────────────────────────────────────────
// The server only streams signed links that expire (see api/sign.js), so
// every stream URL comes from here. Links are cached until close to expiry,
// and ids asked for in the same moment (e.g. a screenful of frame grabs)
// are signed in one request.
const SIGN_BATCH_MAX   = 200;
const SIGN_REFRESH_MS  = 30 * 60 * 1000; // re-sign links with <30 min left
const signedStreams    = new Map();      // id -> { url, exp }
const signWaiters      = new Map();      // id -> [{ resolve, reject }]
let signTimer = null;

function streamUrl(id) {
  const hit = signedStreams.get(id);
  if (hit && hit.exp * 1000 - Date.now() > SIGN_REFRESH_MS) return Promise.resolve(hit.url);
  return new Promise((resolve, reject) => {
    if (!signWaiters.has(id)) signWaiters.set(id, []);
    signWaiters.get(id).push({ resolve, reject });
    if (!signTimer) signTimer = setTimeout(flushSignRequests, 20);
  });
}

async function flushSignRequests() {
  signTimer = null;
  const batch = [...signWaiters].slice(0, SIGN_BATCH_MAX);
  for (const [id] of batch) signWaiters.delete(id);
  if (signWaiters.size) signTimer = setTimeout(flushSignRequests, 0);

  try {
    const res = await fetch(`${API_BASE}/api/sign`, {
      method:  'POST',
      headers: metaHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({ ids: batch.map(([id]) => id) }),
    });
    if (!res.ok) throw new Error(`sign ${res.status}`);
    const { exp, sigs } = await res.json();
    for (const [id, waiters] of batch) {
      if (!sigs[id]) { waiters.forEach(w => w.reject(new Error('unsigned'))); continue; }
      const url = `${API_BASE}/api/stream?id=${encodeURIComponent(id)}&exp=${exp}&sig=${sigs[id]}`;
      signedStreams.set(id, { url, exp: Number(exp) });
      waiters.forEach(w => w.resolve(url));
    }
  } catch (err) {
    for (const [, waiters] of batch) waiters.forEach(w => w.reject(err));
  }
}

// ─── VLC LAUNCH ───────────────────────────────────────────────────────────────
function prewarmStream(fileId) {
  return streamUrl(fileId)
    .then(url => fetch(url, { method: 'HEAD' }))
    .catch(() => {});
}

async function openInVlc() {
  const video = lastPicked;
  if (!video) return;
  let url;
  try {
    url = await streamUrl(video.id);
  } catch (err) {
    alert("Couldn't get a play link. Check your connection and try again.");
    return;
  }
  markWatched(video.id);
  launchVlc(url, displayName(video.name));
}

function launchVlc(url, title) {
  window.location.href =
    `intent://${url.replace(/^https:\/\//, '')}` +
    `#Intent;scheme=https;package=org.videolan.vlc;type=video%2F*` +
    `;S.title=${encodeURIComponent(title)};end`;
}

// What the now-playing bar's VLC button re-sends: the last video, or the
// last compilation.
let nowPlayingAction = null;
function replayNowPlaying() {
  nowPlayingBtn.classList.remove('ready');
  if (nowPlayingAction) nowPlayingAction();
}

// Chrome only lets a page open an app (VLC) without asking for a few
// seconds after the user's tap. If getting ready took longer than that
// (4K warm start, a cold server), don't trigger Chrome's "Open in VLC?"
// prompt - light up the bar's VLC button instead, so the next tap opens it.
const AUTO_LAUNCH_WINDOW_MS = 4000;
function launchOrOffer(tappedAt, title) {
  nowPlayingBtn.disabled = false;
  if (Date.now() - tappedAt <= AUTO_LAUNCH_WINDOW_MS) {
    nowPlayingTitle.textContent = title;
    nowPlayingAction();
    return;
  }
  nowPlayingTitle.textContent = `Ready · tap ▶ VLC · ${title}`;
  nowPlayingBtn.classList.add('ready');
  if (navigator.vibrate) navigator.vibrate(40);
}

// ─── BROWSE ───────────────────────────────────────────────────────────────────
// Sort/filter choices, remembered between visits.
const SORT_DEFAULT_DIR = { name: 'asc', created: 'desc', duration: 'desc', size: 'desc', watched: 'desc', random: 'asc' };
// Filters (the Filters sheet, openFilters):
//   watched   'any' | 'only' | 'hide'   - watched in the last 30 days
//   folder    null (all) or one folder path
//   uploaded  'any' | 'week' | 'month' | 'quarter'
//   lenMin/lenMax  minutes; 0 / LEN_MAX mean no bound
//   formats   computed tags picked in the Format tab ('quality:1080p',
//             'fps:60', 'shape:Portrait'): any within a group, all groups
//   creators  any of them; excluded: creators or tags to hide
//   tags, tagMode ('all' | 'any'), untagged
const LEN_MAX = 120;
const FILTER_DEFAULTS = {
  watched: 'any', folder: null, uploaded: 'any', lenMin: 0, lenMax: LEN_MAX,
  formats: [], creators: [], tags: [], excluded: [], tagMode: 'all', untagged: false,
};
let browsePrefs = { sort: 'name', dir: 'asc', ...structuredClone(FILTER_DEFAULTS) };
let randomRank  = new Map(); // fileId -> position, reshuffled on demand

try {
  Object.assign(browsePrefs, JSON.parse(localStorage.getItem('rvp_browse_prefs') || '{}'));
} catch (err) { /* private mode or corrupt value - keep defaults */ }
migrateBrowsePrefs();

// Before v45 one dropdown held watched / untagged / folder, and quality,
// shape and frame-rate tags were picked among the ordinary tags.
function migrateBrowsePrefs() {
  const f = browsePrefs.filter;
  if (f === 'recent') browsePrefs.watched = 'only';
  else if (f === 'unwatched') browsePrefs.watched = 'hide';
  else if (f === 'untagged') browsePrefs.untagged = true;
  else if (typeof f === 'string' && f.startsWith('folder:')) browsePrefs.folder = f.slice('folder:'.length);
  delete browsePrefs.filter;
  const computed = t => isQualityTag(t) || isShapeTag(t) || isFpsTag(t) || t.startsWith('audio:');
  browsePrefs.formats = [...new Set([...(browsePrefs.formats || []),
    ...(browsePrefs.tags || []).filter(t => isQualityTag(t) || isShapeTag(t) || isFpsTag(t))])];
  browsePrefs.tags = (browsePrefs.tags || []).filter(t => !computed(t));
  browsePrefs.excluded = (browsePrefs.excluded || []).filter(t => !computed(t));
}

function filterPrefs(p = browsePrefs) {
  const out = {};
  for (const k of Object.keys(FILTER_DEFAULTS)) out[k] = structuredClone(p[k] ?? FILTER_DEFAULTS[k]);
  return out;
}

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

const UPLOAD_DAYS = { week: 7, month: 30, quarter: 90 };

// Format groups: the Format tab's sections, in order.
const FORMAT_GROUPS = [
  { id: 'quality', title: 'Resolution', test: t => isQualityTag(t), rank: t => QUALITY_ORDER.indexOf(tagLabel(t)) },
  { id: 'fps', title: 'Frame rate', test: t => isFpsTag(t), rank: t => Number(t.slice(FPS_PREFIX.length)) },
  { id: 'shape', title: 'Orientation', test: t => isShapeTag(t), rank: t => SHAPE_ORDER.indexOf(tagLabel(t)) },
];

function filterVideos(query, p = browsePrefs) {
  let list = videoCache || [];

  if (p.watched === 'only') list = list.filter(v => isRecentlyWatched(v.id));
  else if (p.watched === 'hide') list = list.filter(v => !isRecentlyWatched(v.id));
  if (p.folder != null) list = list.filter(v => v.path === p.folder);
  if (UPLOAD_DAYS[p.uploaded]) {
    const since = Date.now() - UPLOAD_DAYS[p.uploaded] * 864e5;
    list = list.filter(v => v.created >= since);
  }
  // Length: videos whose length isn't known yet are left out while it's set.
  if (p.lenMin > 0 || p.lenMax < LEN_MAX) {
    list = list.filter(v => {
      const min = (v.durationMs || 0) / 60000;
      return v.durationMs && min >= p.lenMin && (p.lenMax >= LEN_MAX || min <= p.lenMax);
    });
  }

  // Format: any picked value within a group, and every group that has one.
  const groups = FORMAT_GROUPS.map(g => p.formats.filter(g.test)).filter(g => g.length);
  if (groups.length) {
    list = list.filter(v => {
      const tags = computedTags(v);
      return groups.every(g => g.some(t => tags.includes(t)));
    });
  }

  if (p.untagged) list = list.filter(v => !tagNames(v.id).length);

  // Creators: a video matches if it has any of the chosen creators.
  if (p.creators.length) list = list.filter(v => p.creators.some(c => c in tagsOf(v.id)));

  // Exclusions (creators or tags): hide any video carrying one.
  if (p.excluded.length) list = list.filter(v => !p.excluded.some(t => t in tagsOf(v.id)));

  // Tags: videos must carry all chosen tags (or any, if toggled).
  if (p.tags.length) {
    list = list.filter(v => {
      const tags = tagsOf(v.id);
      return p.tagMode === 'any' ? p.tags.some(t => t in tags) : p.tags.every(t => t in tags);
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
      v.name, displayName(v.name), v.path || '', ...Object.keys(filterTagsOf(v)).map(tagLabel),
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

function libraryFolders() {
  return [...new Set((videoCache || []).map(v => v.path))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
  img.src      = `${API_BASE}/api/thumbnail?id=${encodeURIComponent(video.id)}`;
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
// to the server where it shows up in the Cloud Run logs.
// Asks the stream for its first byte. A healthy response means the earlier
// failure was the video itself; an error status or no answer means the
// stream was the problem and a retry may succeed.
async function streamLooksDown(id) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(await streamUrl(id), {
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
  fetch(`${API_BASE}/api/thumbnail?id=${encodeURIComponent(id)}`
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

    streamUrl(id).then(url => { video.src = url; }, () => fail('sign-failed'));
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
  streamUrl(job.video.id).then(url => { el.src = url; }, done);
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
  updateBrowseCount();

  if (browseRendered >= browseFiltered.length && browseObserver) {
    browseObserver.disconnect();
    browseObserver = null;
  }
}

function updateBrowseCount() {
  const update = pendingLibrary ? ' · Library updated, tap to refresh' : ' · Long-press a video for details & tags';
  browseCount.textContent = `Showing ${browseRendered} of ${browseFiltered.length}${update}`;
  browseCount.classList.toggle('has-update', Boolean(pendingLibrary));
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
    let usedCache = false;
    if (!videoCache) {
      videoCache = loadLibraryCache();
      usedCache = Boolean(videoCache);
    }
    if (!videoCache) {
      pickingOverlay.classList.add('visible');
      setStatus('Scanning library...', 'loading');
      videoCache = await collectVideos(ROOT_FOLDER);
      saveLibraryCache(videoCache);
      pickingOverlay.classList.remove('visible');
      setStatus('Signed in', 'ready');
    }
    await ensureMeta();
    if (!randomRank.size) reshuffle();
    browseSearch.value = '';
    await migrateCreatorTags();
    // Drop remembered filters for tags, creators or folders that no longer exist.
    const known = tagCounts();
    browsePrefs.creators = browsePrefs.creators.filter(t => known.has(t) && isCreatorTag(t));
    browsePrefs.tags     = browsePrefs.tags.filter(t => known.has(t) && !isCreatorTag(t));
    browsePrefs.excluded = browsePrefs.excluded.filter(t => known.has(t));
    if (browsePrefs.folder != null && !libraryFolders().includes(browsePrefs.folder)) browsePrefs.folder = null;
    syncBrowseControls();
    refreshTagBar();
    refreshBrowse();
    browseView.classList.add('visible');
    if (usedCache) refreshLibraryInBackground();
  } catch (err) {
    pickingOverlay.classList.remove('visible');
    setStatus(err.message || 'Something went wrong', 'error');
  } finally {
    browseBtn.disabled = false;
  }
}

// After opening from the saved copy, rescan quietly. If anything changed,
// the count line offers the update rather than reshuffling the grid under
// the viewer's finger.
let pendingLibrary = null;
async function refreshLibraryInBackground() {
  let fresh;
  try {
    fresh = await collectVideos(ROOT_FOLDER);
  } catch (err) {
    return; // offline or token trouble - keep showing the saved copy
  }
  if (!videoCache) return; // signed out meanwhile
  // Keep durations learned since the last scan (KV, in-browser measuring).
  const known = new Map(videoCache.map(v => [v.id, v]));
  for (const v of fresh) {
    const old = known.get(v.id);
    if (old && !v.durationMs && old.durationMs) v.durationMs = old.durationMs;
  }
  saveLibraryCache(fresh);
  if (librarySignature(fresh) === librarySignature(videoCache)) return;
  pendingLibrary = fresh;
  updateBrowseCount();
}

function applyPendingLibrary() {
  if (!pendingLibrary) return;
  videoCache = pendingLibrary;
  pendingLibrary = null;
  reshuffle();
  refreshTagBar();
  refreshBrowse();
}

browseCount.addEventListener('click', applyPendingLibrary);

function closeBrowseView() {
  setSelectMode(false);
  closeSheet();
  browseView.classList.remove('visible');
  if (browseObserver) {
    browseObserver.disconnect();
    browseObserver = null;
  }
}

document.getElementById('browseManageBtn').addEventListener('click', () => openTagManager());
browseFiltersBtn.addEventListener('click', () => openFilters());
browseFiltersClear.addEventListener('click', () => { browseSearch.value = ''; applyFilters(FILTER_DEFAULTS); });
browseSelectBtn.addEventListener('click', () => setSelectMode(!selectMode));

browseSearch.addEventListener('input', () => {
  clearTimeout(browseSearchDebounce);
  browseSearchDebounce = setTimeout(() => {
    refreshTagBar();
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
// The active filters as chips under the controls, each tapped to remove:
// row 1 the search, creators, then the General and Format filters; row 2
// the tags. The ✕ half of the Filters button clears everything, search
// included.
const UPLOAD_LABELS = { week: 'Past week', month: 'Past month', quarter: 'Past 3 months' };

function lengthLabel(p) {
  if (p.lenMin <= 0 && p.lenMax >= LEN_MAX) return 'Any length';
  if (p.lenMax >= LEN_MAX) return `${p.lenMin}+ min`;
  if (p.lenMin <= 0) return `Up to ${p.lenMax} min`;
  return `${p.lenMin}–${p.lenMax} min`;
}

function activeFilterCount(p = browsePrefs) {
  return (p.watched !== 'any') + (p.folder != null) + (p.uploaded !== 'any')
    + (p.lenMin > 0 || p.lenMax < LEN_MAX) + p.formats.length
    + p.creators.length + p.tags.length + p.excluded.length + p.untagged;
}

function applyFilters(next) {
  Object.assign(browsePrefs, filterPrefs(next));
  saveBrowsePrefs();
  refreshTagBar();
  refreshBrowse();
}

function refreshTagBar() {
  const p = browsePrefs;
  const count = activeFilterCount();
  browseFiltersBtn.textContent = count ? `Filters · ${count}` : 'Filters';
  browseFiltersBtn.parentElement.classList.toggle('filtering', count > 0);

  const chip = (label, className, change) => chipButton(`${label} ✕`, className, () => {
    const next = filterPrefs();
    change(next);
    applyFilters(next);
  }, 'Remove this filter');
  const row1 = [];
  const row2 = [];
  const query = browseSearch.value.trim();
  if (query) {
    const shown = query.length > 24 ? `${query.slice(0, 23)}…` : query;
    row1.push(chipButton(`🔍 "${shown}" ✕`, 'active', () => {
      browseSearch.value = '';
      refreshTagBar();
      refreshBrowse();
    }, 'Clear the search'));
  }
  const remove = (key, name) => n => { n[key] = n[key].filter(t => t !== name); };
  for (const c of p.creators) row1.push(chip(`👤 ${tagLabel(c)}`, 'active', remove('creators', c)));
  for (const c of p.excluded.filter(isCreatorTag)) row1.push(chip(`− 👤 ${tagLabel(c)}`, 'excluded', remove('excluded', c)));
  if (p.lenMin > 0 || p.lenMax < LEN_MAX) row1.push(chip(lengthLabel(p), 'active', n => { n.lenMin = 0; n.lenMax = LEN_MAX; }));
  if (p.uploaded !== 'any') row1.push(chip(UPLOAD_LABELS[p.uploaded], 'active', n => { n.uploaded = 'any'; }));
  if (p.folder != null) row1.push(chip(`📁 ${p.folder || '(root folder)'}`, 'active', n => { n.folder = null; }));
  if (p.watched !== 'any') {
    row1.push(chip(p.watched === 'only' ? 'Watched recently' : 'Not watched recently',
      p.watched === 'only' ? 'active' : 'excluded', n => { n.watched = 'any'; }));
  }
  for (const g of FORMAT_GROUPS) {
    for (const t of p.formats.filter(g.test).sort((a, b) => g.rank(a) - g.rank(b))) {
      row1.push(chip(tagLabel(t), 'active', remove('formats', t)));
    }
  }
  for (const t of p.tags) row2.push(chip(tagLabel(t), 'active', remove('tags', t)));
  for (const t of p.excluded.filter(t => !isCreatorTag(t))) row2.push(chip(`− ${tagLabel(t)}`, 'excluded', remove('excluded', t)));
  if (p.untagged) row2.push(chip('Untagged', 'active', n => { n.untagged = false; }));

  browseFiltersClear.hidden = browseTagBar.hidden = !row1.length && !row2.length;
  browseTagBar.innerHTML = '';
  if (row1.length) browseTagBar.append(el('div', { className: 'filter-row' }, ...row1));
  if (row2.length) browseTagBar.append(el('div', { className: 'filter-row' }, ...row2));
}

function setSelectMode(on) {
  selectMode = on;
  if (!on) {
    selectedIds.clear();
    browseGrid.querySelectorAll('.browse-card.selected').forEach(c => c.classList.remove('selected'));
  }
  browseView.classList.toggle('selecting', on);
  browseSelectBtn.classList.toggle('active', on);
  browseSelectBtn.textContent = on ? '✕' : '☑';
  browseSelectBtn.title = on ? 'Stop selecting' : 'Select videos to tag';
  updateSelectBar();
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
  sheet.className = 'sheet'; // drop a layout class a previous sheet added (filter-sheet)
  // Skipped parts (e.g. Smooth-only rows in Original mode) are null; append
  // would print them as the text "null".
  sheet.append(...content.filter(c => c != null));
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
// One Filters sheet with four tabs. Changes go into a draft that the
// "Show N videos" button applies (the count updates as you go); closing the
// sheet any other way leaves the filters as they were.
const FILTER_TABS = [['general', 'General'], ['format', 'Format'], ['creator', 'Creator'], ['tag', 'Tags']];

function openFilters(tab = 'general') {
  const draft = filterPrefs();
  const query = { creator: '', tag: '' };
  const byName = { creator: true, tag: false }; // creators A-Z, tags most-used
  const tabBar = el('div', { className: 'filter-tabs', role: 'tablist' });
  const body = el('div', { className: 'filter-body' });
  const showBtn = el('button', { type: 'button', className: 'sheet-btn primary filter-show', onclick: () => { closeSheet(); applyFilters(draft); } });

  const tabCount = t => t === 'general'
    ? (draft.watched !== 'any') + (draft.folder != null) + (draft.uploaded !== 'any') + (draft.lenMin > 0 || draft.lenMax < LEN_MAX)
    : t === 'format' ? draft.formats.length
    : t === 'creator' ? draft.creators.length + draft.excluded.filter(isCreatorTag).length
    : draft.tags.length + draft.excluded.filter(n => !isCreatorTag(n)).length + draft.untagged;

  const segmented = (options, value, onPick) => el('div', { className: 'segmented' },
    ...options.map(([v, label]) => el('button', {
      type: 'button', className: v === value ? 'active' : '', textContent: label,
      onclick: () => { onPick(v); render(); },
    })));
  const sectionTitle = text => el('div', { className: 'sheet-section-title', textContent: text });

  const general = () => {
    const lenValue = el('span', { className: 'filter-value', textContent: lengthLabel(draft) });
    const fill = el('div', { className: 'dual-fill' });
    const paint = () => {
      lenValue.textContent = lengthLabel(draft);
      fill.style.left = `${(draft.lenMin / LEN_MAX) * 100}%`;
      fill.style.width = `${((draft.lenMax - draft.lenMin) / LEN_MAX) * 100}%`;
      renderTabs();
      updateCount();
    };
    const slider = (key, label) => {
      const input = el('input', { type: 'range', min: '0', max: String(LEN_MAX), step: '1', value: String(draft[key]), ariaLabel: label });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (key === 'lenMin') draft.lenMin = Math.min(v, draft.lenMax - 1);
        else draft.lenMax = Math.max(v, draft.lenMin + 1);
        input.value = String(draft[key]);
        paint();
      });
      return input;
    };
    const dual = el('div', { className: 'dual-range' }, el('div', { className: 'dual-track' }), fill,
      slider('lenMin', 'Shortest length in minutes'), slider('lenMax', 'Longest length in minutes'));
    paint();

    const folder = el('select', { className: 'sheet-input', ariaLabel: 'Folder' });
    folder.append(el('option', { value: '', textContent: 'All folders' }));
    for (const f of libraryFolders()) folder.append(el('option', { value: `f:${f}`, textContent: f || '(root folder)' }));
    folder.value = draft.folder == null ? '' : `f:${draft.folder}`;
    folder.addEventListener('change', () => { draft.folder = folder.value ? folder.value.slice(2) : null; render(); });

    return [
      el('div', { className: 'sheet-section' },
        el('div', { className: 'filter-head' }, sectionTitle('Length'), lenValue),
        dual,
        el('div', { className: 'filter-scale' }, el('span', { textContent: '0 min' }), el('span', { textContent: `${LEN_MAX}+ min` }))),
      el('div', { className: 'sheet-section' }, sectionTitle('Uploaded'),
        segmented([['any', 'Any'], ['week', 'Week'], ['month', 'Month'], ['quarter', '3 months']], draft.uploaded, v => { draft.uploaded = v; })),
      el('div', { className: 'sheet-section' }, sectionTitle('Folder'), folder),
      el('div', { className: 'sheet-section' }, sectionTitle('Watched in the last 30 days'),
        segmented([['any', 'Any'], ['only', 'Only these'], ['hide', 'Hide these']], draft.watched, v => { draft.watched = v; })),
    ];
  };

  const format = () => {
    const counts = formatCounts();
    return FORMAT_GROUPS.map(g => {
      const names = [...counts.keys()].filter(g.test).sort((a, b) => g.rank(a) - g.rank(b));
      const picked = names.filter(n => draft.formats.includes(n));
      return el('details', { className: 'filter-group', open: true },
        el('summary', {},
          el('span', { textContent: g.title }),
          el('span', { className: 'filter-value', textContent: picked.length ? picked.map(tagLabel).join(', ') : 'Any' })),
        el('div', { className: 'sheet-chips' },
          ...names.map(n => {
            const on = draft.formats.includes(n);
            return el('button', {
              type: 'button', className: `tag-chip${on ? ' active' : ''}`, ariaPressed: String(on),
              onclick: () => {
                draft.formats = on ? draft.formats.filter(t => t !== n) : [...draft.formats, n];
                render();
              },
            }, tagLabel(n), el('span', { className: 'chip-count', textContent: counts.get(n).toLocaleString() }));
          }),
          names.length ? null : el('div', { className: 'sheet-note', textContent: 'Shows once the server has read the files.' })));
    });
  };

  const picker = kind => {
    const isCreator = kind === 'creator';
    const counts = tagCounts(kind);
    const list = el('div', { className: 'sheet-list' });
    const stateOf = n => (isCreator ? draft.creators : draft.tags).includes(n) ? 'include'
      : draft.excluded.includes(n) ? 'exclude' : null;
    const fill = () => {
      list.innerHTML = '';
      let names = [...counts.keys()].filter(n => matchesQuery(n, query[kind]));
      if (byName[kind]) names.sort((a, b) => tagLabel(a).localeCompare(tagLabel(b), undefined, { numeric: true }));
      names.sort((a, b) => !!stateOf(b) - !!stateOf(a)); // chosen ones on top
      if (!names.length) {
        list.append(el('div', { className: 'sheet-note',
          textContent: counts.size ? 'No matches.' : `No ${isCreator ? 'creators' : 'tags'} yet.` }));
      }
      for (const name of names) {
        const st = stateOf(name);
        list.append(el('button', {
          type: 'button',
          className: `sheet-list-row tri-row ${st || ''}`,
          onclick: () => {
            const key = isCreator ? 'creators' : 'tags';
            draft[key] = draft[key].filter(t => t !== name);
            draft.excluded = draft.excluded.filter(t => t !== name);
            if (!st) draft[key].push(name);
            else if (st === 'include') draft.excluded.push(name);
            renderTabs();
            fill();
            updateCount();
          },
        },
          el('span', { className: 'tri-box', textContent: st === 'include' ? '✓' : st === 'exclude' ? '✕' : '' }),
          el('span', { className: 'sheet-list-name', textContent: tagLabel(name) }),
          el('span', { className: 'sheet-list-count', textContent: String(counts.get(name)) })));
      }
    };
    const search = searchInput(isCreator ? 'Search creators…' : 'Search tags…', e => {
      query[kind] = e.target.value.trim().toLowerCase();
      fill();
    });
    search.value = query[kind];
    const sort = segmented([['count', 'Most'], ['name', 'A–Z']], byName[kind] ? 'name' : 'count', v => { byName[kind] = v === 'name'; });
    sort.classList.add('fit');
    sort.ariaLabel = 'Sort';
    fill();
    return [
      el('div', { className: 'sheet-row' }, search, sort),
      isCreator ? null : el('div', { className: 'sheet-row' },
        segmented([['all', 'Match all'], ['any', 'Match any']], draft.tagMode, v => { draft.tagMode = v; }),
        el('div', { className: 'segmented fit' }, el('button', {
          type: 'button', className: draft.untagged ? 'on' : '', textContent: 'Untagged only',
          ariaPressed: String(draft.untagged), onclick: () => { draft.untagged = !draft.untagged; render(); },
        }))),
      el('div', { className: 'sheet-note', textContent: (isCreator
        ? 'Shows videos by any ✓ creator. '
        : draft.tagMode === 'any' ? 'Videos with at least one ✓ tag. ' : 'Videos with every ✓ tag. ')
        + 'Tap once to include (✓), twice to exclude (✕), again to clear.' }),
      list,
    ];
  };

  function updateCount() {
    const n = filterVideos(browseSearch.value.trim(), draft).length;
    showBtn.textContent = `Show ${n.toLocaleString()} video${n === 1 ? '' : 's'}`;
  }

  function renderTabs() {
    tabBar.innerHTML = '';
    for (const [id, label] of FILTER_TABS) {
      const n = tabCount(id);
      tabBar.append(el('button', {
        type: 'button', role: 'tab', ariaSelected: String(id === tab),
        className: `filter-tab${id === tab ? ' active' : ''}`,
        onclick: () => { tab = id; render(); },
      }, label, n ? el('span', { className: 'filter-tab-count', textContent: String(n) }) : null));
    }
  }

  function render() {
    renderTabs();
    body.innerHTML = '';
    body.append(...(tab === 'general' ? general() : tab === 'format' ? format() : picker(tab)).filter(Boolean));
    updateCount();
  }

  render();
  openSheet(
    el('div', { className: 'filter-top' },
      el('div', { className: 'sheet-title filter-title', textContent: 'Filters' }),
      el('button', { type: 'button', className: 'sheet-btn small', textContent: 'Close', onclick: closeSheet })),
    tabBar,
    body,
    el('div', { className: 'sheet-row sheet-actions filter-actions' },
      el('button', {
        type: 'button', className: 'sheet-btn', textContent: 'Clear all',
        onclick: () => { Object.assign(draft, filterPrefs(FILTER_DEFAULTS)); render(); },
      }),
      showBtn));
  // One fixed height for every tab, with only the middle scrolling, so the
  // title, tabs and buttons stay put and switching tabs doesn't jump.
  sheet.classList.add('filter-sheet');
}

// Read-only facts about one video, for the top of its long-press sheet:
// what the computed tags are worked out from, plus length, size and folder.

function detailsSection(video) {
  const m = metaMedia[video.id];
  const [w, h] = sizeOf(video);
  const rows = [];
  if (m && m[6]) {
    rows.push(['Picture', 'None (audio only)']);
  } else if (w && h) {
    const q = qualityTag(video);
    rows.push(['Resolution', `${w}×${h}${q ? ` · ${tagLabel(q)}` : ''}`]);
    rows.push(['Orientation', tagLabel(shapeTag(video))]);
  }
  if (m && m[2]) rows.push(['Frame rate', `${Number(m[2].toFixed(2))} fps`]);
  if (video.durationMs) rows.push(['Length', formatDuration(video.durationMs)]);
  if (video.size) rows.push(['File size', formatBytes(video.size)]);
  if (m) rows.push(['Audio', m[3] ? 'Yes' : 'None']);
  if (video.path) rows.push(['Folder', video.path]);
  const grid = el('div', { className: 'video-facts' });
  for (const [label, value] of rows) {
    grid.append(el('span', { className: 'video-facts-label', textContent: label }),
      el('span', { textContent: value }));
  }
  return el('div', { className: 'sheet-section' },
    el('div', { className: 'sheet-section-title', textContent: 'ℹ️ Details' }),
    grid,
    m ? null : el('div', { className: 'sheet-note', textContent: 'Frame rate and audio show once the server has read this file.' }));
}

// Tag editor for one or many videos, split into Creator and Tags sections.
// For a single video it opens with its details (detailsSection) on top.
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
    ids.length === 1 ? detailsSection(findVideo(ids[0])) : null,
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

// Compilation: random ~10s clips from everything in the current view, played
// as one stream in VLC. The server picks, orders and cuts the clips (see
// api/compile.js); durations help it cut from the middle of each video.
// Long-press 🎬 to choose how compilations are made; the choice is remembered.
// Long-press 🎬 to choose how compilations are made; the choice is remembered.
// Smooth has its own resolution and frame rate, each with Auto (what most of
// the clips in the view are - decided by the server).
const COMPILE_RES = [['auto', 'Auto'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p']];
const COMPILE_FPS = [['auto', 'Auto'], ['60', '60 fps'], ['30', '30 fps']];
// Highlights cuts around each video's loudest / most active moments
// (analysed in the background by api/analyze.js); Random picks anywhere.
const COMPILE_PICK = [['highlights', 'Highlights'], ['random', 'Random']];
// Auto: with highlights, each clip lasts about as long as the action it was
// cut from (6-20 s); otherwise 10 s.
const COMPILE_LEN  = [['auto', 'Auto'], ['5', '5 s'], ['10', '10 s'], ['15', '15 s'], ['20', '20 s']];
// Smooth only. Native keeps each clip's own shape instead of fitting all of
// them into one 16:9 frame; see FRAME_OPTIONS in api/compile.js.
const COMPILE_FRAME = [['fit', 'Fit 16:9'], ['native', 'Native']];
let compilePrefs = { mode: 'smooth', res: 'auto', fps: 'auto', pick: 'highlights', len: 'auto', frame: 'fit' };
try {
  const saved = localStorage.getItem('rvp_compile_mode');
  if (saved && saved.startsWith('{')) {
    const p = JSON.parse(saved);
    compilePrefs = {
      mode: p.mode === 'original' ? 'original' : 'smooth',
      res:  COMPILE_RES.some(r => r[0] === p.res) ? p.res : 'auto',
      fps:  COMPILE_FPS.some(f => f[0] === p.fps) ? p.fps : 'auto',
      pick: COMPILE_PICK.some(k => k[0] === p.pick) ? p.pick : 'highlights',
      len:  COMPILE_LEN.some(k => k[0] === p.len) ? p.len : 'auto',
      frame: COMPILE_FRAME.some(k => k[0] === p.frame) ? p.frame : 'fit',
    };
  } else if (saved === 'original') {
    compilePrefs.mode = 'original';
  } else if (COMPILE_RES.some(r => r[0] === saved)) {
    compilePrefs.res = saved; // pre-fps setting: smooth at that resolution
  }
} catch (err) { /* private mode or corrupt value - keep defaults */ }

function saveCompilePrefs() {
  try { localStorage.setItem('rvp_compile_mode', JSON.stringify(compilePrefs)); } catch (err) { /* ignore */ }
}

function openCompileMenu() {
  const modeRow = (id, label, note) => el('div', {
    className: 'tri-row' + (compilePrefs.mode === id ? ' include' : ''),
    onclick: () => { compilePrefs.mode = id; saveCompilePrefs(); openCompileMenu(); },
  },
    el('span', { className: 'tri-box', textContent: compilePrefs.mode === id ? '✓' : '' }),
    el('span', { className: 'sheet-list-name' }, label, el('div', { className: 'sheet-note', textContent: note })));
  const choiceRow = (title, options, key) => el('div', { className: 'sheet-section' },
    el('div', { className: 'sheet-section-title', textContent: title }),
    el('div', { className: 'sheet-chips' }, ...options.map(([value, label]) =>
      chipButton(label, compilePrefs[key] === value ? 'active' : '', () => {
        compilePrefs[key] = value; saveCompilePrefs(); openCompileMenu();
      }))));
  const smooth = compilePrefs.mode === 'smooth';
  const highlightNote = el('div', { className: 'sheet-note', textContent: 'Checking highlight analysis…' });
  loadHighlightProgress().then(text => { highlightNote.textContent = text; });
  openSheet(
    el('div', { className: 'sheet-title', textContent: 'Compilation mode' }),
    el('div', { className: 'sheet-section' },
      modeRow('original', 'Original', 'Untouched quality · brief flash between clips'),
      modeRow('smooth', 'Smooth', 'Seamless playback and seeking · every clip re-encoded to one format')),
    smooth ? choiceRow('Resolution', COMPILE_RES, 'res') : null,
    smooth ? choiceRow('Frame rate', COMPILE_FPS, 'fps') : null,
    smooth ? el('div', { className: 'sheet-note', textContent: 'Auto picks what most clips in the view are. Auto frame rate stays at 30 for 4K; 4K at 60 fps will likely stall.' }) : null,
    smooth ? choiceRow('Frame', COMPILE_FRAME, 'frame') : null,
    smooth ? el('div', { className: 'sheet-note', textContent: 'Fit puts every clip in one 16:9 frame (black bars on other shapes). Native keeps each clip\'s own shape; VLC resizes to match (a brief black flash when the shape changes).' }) : null,
    choiceRow('Clip picks', COMPILE_PICK, 'pick'),
    highlightNote,
    choiceRow('Clip length', COMPILE_LEN, 'len'),
    el('div', { className: 'sheet-note', textContent: 'Auto follows the action: short bursts get short clips, sustained scenes up to 20 s (needs Highlights; otherwise 10 s).' }),
    el('div', { className: 'sheet-row sheet-actions' },
      el('button', { type: 'button', className: 'sheet-btn primary', textContent: 'Done', onclick: closeSheet })));
}
attachLongPress(browseCompileBtn, openCompileMenu);

// "Highlights ready for 340 of 2,100 videos" - analysed counts come from the
// compile service; videos not analysed yet get random cuts.
async function loadHighlightProgress() {
  try {
    const res = await fetch(`${COMPILE_BASE}/api/analyze`, { headers: metaHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    const { analyzed } = await res.json();
    const total = (videoCache || []).length;
    const done = Math.min(analyzed, total);
    return done >= total
      ? 'Highlights are ready for every video.'
      : `Highlights ready for ${done.toLocaleString()} of ${total.toLocaleString()} videos; the rest get random cuts until they're analysed.`;
  } catch (err) {
    return "Couldn't check highlight analysis; videos without it get random cuts.";
  }
}

function compileModeLabel(mode, height, fps) {
  if (mode !== 'smooth') return 'Original';
  return `Smooth ${height === 2160 ? '4K' : `${height}p`}${fps || 30}`;
}

browseCompileBtn.addEventListener('click', async () => {
  if (!browseFiltered.length || browseCompileBtn.disabled) return;
  const tappedAt = Date.now();
  browseCompileBtn.disabled = true;
  nowPlayingBtn.classList.remove('ready');
  lastPicked = null;
  nowPlayingAction = null;
  // 4K compilations wait on the server for their first clip (warm start).
  const fourK = compilePrefs.mode === 'smooth' && compilePrefs.res === '2160';
  nowPlayingTitle.textContent = `Building compilation from ${browseFiltered.length} videos…${fourK ? ' (preparing 4K)' : ''}`;
  nowPlayingBtn.disabled = true;
  nowPlaying.hidden = false;
  try {
    const res = await fetch(`${COMPILE_BASE}/api/compile`, {
      method:  'POST',
      headers: metaHeaders({ 'Content-Type': 'application/json' }),
      body:    JSON.stringify({
        mode:  compilePrefs.mode,
        res:   compilePrefs.res,
        fps:   compilePrefs.fps,
        pick:  compilePrefs.pick,
        len:   compilePrefs.len,
        frame: compilePrefs.frame,
        clips: browseFiltered.map(v => { const [w, h] = sizeOf(v); return { id: v.id, d: v.durationMs || 0, w, h }; }),
      }),
    });
    if (!res.ok) throw new Error(`compile ${res.status}`);
    const { url, clips, mode, height, fps, pick, highlights } = await res.json();
    const picks = pick === 'highlights' ? ` · ${highlights} highlights` : '';
    const title = `Compilation · ${clips} clips · ${compileModeLabel(mode, height, fps)}${picks}`;
    nowPlayingAction = () => launchVlc(url, title);
    launchOrOffer(tappedAt, title);
  } catch (err) {
    nowPlayingTitle.textContent = "Couldn't build a compilation. Try again.";
  } finally {
    browseCompileBtn.disabled = false;
  }
});

// Stays in the library: the bar at the bottom shows what was last opened,
// with a button to send it to VLC again if the first launch didn't take.
async function playVideo(video) {
  const tappedAt = Date.now();
  lastPicked = video;
  nowPlayingAction = openInVlc;
  nowPlayingBtn.classList.remove('ready');
  nowPlayingTitle.textContent = `Warming stream… ${displayName(video.name)}`;
  nowPlayingBtn.disabled = true;
  nowPlaying.hidden = false;

  await prewarmStream(video.id);
  if (lastPicked !== video) return; // another video was tapped meanwhile

  launchOrOffer(tappedAt, displayName(video.name));
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
appVersion.textContent = APP_VERSION;
if (handleAuthCallback() === 'window') {
  // the sign-in window - the app itself runs in the window that opened it
} else if (!accessToken) {
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
