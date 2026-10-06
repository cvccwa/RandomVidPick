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
const APP_VERSION = 'v13';
const BROWSE_BATCH = 50;
const THUMBNAIL_HOST = 'https://random-vid-pick.vercel.app';

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
      + `&fields=nextPageToken,files(id,name)`
      + `&pageSize=1000`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const data = await driveRequest(url);
    if (data.files) {
      for (const f of data.files) {
        videos.push({ id: f.id, name: f.name, path: pathSoFar });
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

// ─── VLC LAUNCH ───────────────────────────────────────────────────────────────
function prewarmStream(fileId) {
  return fetch(`https://random-vid-pick.vercel.app/api/stream?id=${encodeURIComponent(fileId)}`, {
    method: 'HEAD',
  }).catch(() => {});
}

function openInVlc() {
  if (!lastPicked) return;
  const title = encodeURIComponent(lastPicked.name);
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

    videoFilename.textContent = picked.name;
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
function filterVideos(query) {
  if (!query) return videoCache || [];
  const q = query.toLowerCase();
  return (videoCache || []).filter(v =>
    v.name.toLowerCase().includes(q) || (v.path && v.path.toLowerCase().includes(q))
  );
}

function buildCard(video) {
  const card = document.createElement('div');
  card.className = 'browse-card';
  card.onclick = () => playVideo(video);

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
  thumb.appendChild(img);

  const caption = document.createElement('div');
  caption.className = 'browse-caption';
  caption.textContent = video.name;

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
const FRAME_THUMB_TIMEOUT_MS  = 20000;
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
  if (cached) return showThumbBlob(img, cached);
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
      .catch(() => frameThumbFailed.add(job.id))
      .finally(() => {
        frameThumbActive--;
        pumpFrameThumbQueue();
      });
  }
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
    const fail = () => { cleanup(); reject(new Error('frame capture failed')); };
    const timer = setTimeout(fail, FRAME_THUMB_TIMEOUT_MS);

    video.onerror = fail; // e.g. a codec this browser can't decode
    video.onloadedmetadata = () => {
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
          blob ? resolve(blob) : reject(new Error('empty frame'));
        }, 'image/jpeg', 0.7);
      } catch (err) {
        fail();
      }
    };

    video.src = `${THUMBNAIL_HOST}/api/stream?id=${encodeURIComponent(id)}`;
  });
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
    browseSearch.value = '';
    resetBrowseGrid(videoCache);
    browseView.classList.add('visible');
  } catch (err) {
    pickingOverlay.classList.remove('visible');
    setStatus(err.message || 'Something went wrong', 'error');
  } finally {
    browseBtn.disabled = false;
  }
}

function closeBrowseView() {
  browseView.classList.remove('visible');
  if (browseObserver) {
    browseObserver.disconnect();
    browseObserver = null;
  }
}

browseSearch.addEventListener('input', () => {
  clearTimeout(browseSearchDebounce);
  browseSearchDebounce = setTimeout(() => {
    resetBrowseGrid(filterVideos(browseSearch.value.trim()));
  }, 150);
});

async function playVideo(video) {
  lastPicked = video;
  closeBrowseView();

  videoFilename.textContent = video.name;
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
