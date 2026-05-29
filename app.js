// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CLIENT_ID   = '139266625585-isecrhdfdfkqr5mo7cjhcgvuohjrd0b5.apps.googleusercontent.com';
const ROOT_FOLDER = '1JBAz8KFVSHfnzojWnhECD7gtBRkLBCk9';
const SCOPES      = 'https://www.googleapis.com/auth/drive.readonly';
const VIDEO_MIME_TYPES = [
  'video/mp4', 'video/x-matroska', 'video/webm',
  'video/quicktime', 'video/x-msvideo', 'video/mpeg',
  'video/3gpp', 'video/x-flv', 'video/x-ms-wmv'
];

// ─── STATE ────────────────────────────────────────────────────────────────────
let accessToken   = null;
let lastPicked    = null; // { id, name, path }

// ─── DOM REFS ─────────────────────────────────────────────────────────────────
const statusBar       = document.getElementById('statusBar');
const statusText      = document.getElementById('statusText');
const pickBtn         = document.getElementById('pickBtn');
const signInBtn       = document.getElementById('signInBtn');
const signOutBtn      = document.getElementById('signOutBtn');
const videoInfo       = document.getElementById('videoInfo');
const videoFilename   = document.getElementById('videoFilename');
const videoPath       = document.getElementById('videoPath');
const openVlcBtn      = document.getElementById('openVlcBtn');
const pickingOverlay  = document.getElementById('pickingOverlay');

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
  sessionStorage.removeItem('rvp_token');
  sessionStorage.removeItem('rvp_token_expiry');
  updateUI(false);
}

function handleAuthCallback() {
  const hash = window.location.hash;
  if (!hash) return;
  const params = new URLSearchParams(hash.substring(1));
  const token      = params.get('access_token');
  const expiresIn  = params.get('expires_in');
  if (token) {
    accessToken = token;
    const expiry = Date.now() + (parseInt(expiresIn) * 1000);
    sessionStorage.setItem('rvp_token', token);
    sessionStorage.setItem('rvp_token_expiry', expiry.toString());
    // Clean URL
    history.replaceState(null, '', window.location.pathname);
    updateUI(true);
  }
}

function restoreSession() {
  const token  = sessionStorage.getItem('rvp_token');
  const expiry = sessionStorage.getItem('rvp_token_expiry');
  if (token && expiry && Date.now() < parseInt(expiry)) {
    accessToken = token;
    return true;
  }
  return false;
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
    pickBtn.disabled         = false;
  } else {
    setStatus('Not signed in');
    signInBtn.style.display  = '';
    signOutBtn.style.display = 'none';
    pickBtn.disabled         = true;
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

// Recursively collect all video file objects under a folder
async function collectVideos(folderId, pathSoFar = '') {
  const videos = [];
  let pageToken = null;

  // First get all video files in this folder
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

  // Then recurse into subfolders
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

// ─── PICK & PLAY ──────────────────────────────────────────────────────────────
async function pickRandom() {
  pickBtn.disabled = true;
  pickingOverlay.classList.add('visible');
  setStatus('Scanning library...', 'loading');

  try {
    const videos = await collectVideos(ROOT_FOLDER);

    if (videos.length === 0) {
      setStatus('No videos found in folder', 'error');
      pickingOverlay.classList.remove('visible');
      pickBtn.disabled = false;
      return;
    }

    const picked = videos[Math.floor(Math.random() * videos.length)];
    lastPicked = picked;

    pickingOverlay.classList.remove('visible');
    setStatus(`Picked 1 of ${videos.length} videos`, 'ready');

    videoFilename.textContent = picked.name;
    videoPath.textContent     = picked.path || '(root folder)';
    videoInfo.classList.add('visible');
    openVlcBtn.style.display  = '';
    pickBtn.disabled          = false;

    openInVlc();

  } catch (err) {
    pickingOverlay.classList.remove('visible');
    setStatus(err.message || 'Something went wrong', 'error');
    pickBtn.disabled = false;
  }
}

function openInVlc() {
  if (!lastPicked) return;
  // VLC Android can open Google Drive files via their web content link
  const driveUrl = `https://drive.google.com/uc?export=download&id=${lastPicked.id}`;
  // Try vlc:// deep link first; Android will fall back to intent if VLC handles it
  const vlcIntent = `intent:${driveUrl}#Intent;package=org.videolan.vlc;action=android.intent.action.VIEW;end`;
  window.location.href = vlcIntent;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
handleAuthCallback();
if (!accessToken) {
  if (restoreSession()) {
    updateUI(true);
  } else {
    updateUI(false);
  }
} else {
  updateUI(true);
}
