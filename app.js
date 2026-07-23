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

// ─── STATE ────────────────────────────────────────────────────────────────────
let accessToken = null;
let lastPicked  = null;

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
  } else {
    setStatus('Not signed in');
    signInBtn.style.display  = '';
    signOutBtn.style.display = 'none';
    pickBtn.disabled         = true;
    pickFilteredBtn.disabled = true;
    videoInfo.classList.remove('visible');
    openVlcBtn.style.display = 'none';
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
  setStatus('Scanning library...', 'loading');

  try {
    let videos = await collectVideos(ROOT_FOLDER);

    if (filter) videos = videos.filter(v => filter.test(v.name));

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
    openVlcBtn.disabled = false;
    setStatus('Picked · tap OPEN IN VLC to play', 'ready');

  } catch (err) {
    pickingOverlay.classList.remove('visible');
    setStatus(err.message || 'Something went wrong', 'error');
    pickBtn.disabled         = false;
    pickFilteredBtn.disabled = false;
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
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
