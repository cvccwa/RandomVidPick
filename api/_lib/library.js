import { DRIVE_API } from './media.js';
import { ROOT_FOLDER } from './auth.js';

// Every video in the library folder tree, as the service account sees it:
// [{ id, durationMs }]. Same walk as the app's collectVideos - each
// folder's videos and subfolders listed together, siblings in parallel.
const PARALLEL = 8;
// Same list as VIDEO_MIME_TYPES in app.js.
const VIDEO_MIME = ['video/mp4', 'video/x-matroska', 'video/webm', 'video/quicktime', 'video/x-msvideo',
  'video/mpeg', 'video/3gpp', 'video/x-flv', 'video/x-ms-wmv'];

export async function listLibrary(token) {
  const videos = [];
  let active = 0;
  const waiting = [];
  const acquire = () => (active < PARALLEL ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r)));
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

  async function listAll(query, fields, onFile) {
    let pageToken = null;
    do {
      let url = `${DRIVE_API}/drive/v3/files?q=${encodeURIComponent(query)}`
        + `&fields=${encodeURIComponent(fields)}&pageSize=1000`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      await acquire();
      let data;
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`drive list ${res.status}`);
        data = await res.json();
      } finally {
        release();
      }
      (data.files || []).forEach(onFile);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
  }

  const mimeQuery = VIDEO_MIME.map(m => `mimeType='${m}'`).join(' or ');
  async function walk(folderId) {
    const subfolders = [];
    await Promise.all([
      listAll(`(${mimeQuery}) and '${folderId}' in parents and trashed=false`,
        'nextPageToken,files(id,videoMediaMetadata(durationMillis))',
        f => videos.push({ id: f.id, durationMs: Number(f.videoMediaMetadata && f.videoMediaMetadata.durationMillis) || 0 })),
      listAll(`mimeType='application/vnd.google-apps.folder' and '${folderId}' in parents and trashed=false`,
        'nextPageToken,files(id)', f => subfolders.push(f.id)),
    ]);
    await Promise.all(subfolders.map(walk));
  }

  await walk(ROOT_FOLDER);
  return videos;
}
