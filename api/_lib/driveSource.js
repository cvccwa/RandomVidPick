import http from 'node:http';
import { getServiceAccountToken } from './serviceAccount.js';

// Every byte the server takes from Drive is counted here, by purpose
// (stream / compile / analyze), because Drive caps how much can be
// downloaded from the owner's files in a day and going over it blocks all
// playback for up to 24 hours. Totals are logged every few minutes as
// "drive reads: ...", and analysis checks its own total against a daily
// byte budget.
//
// ffmpeg reads Drive through this small pass-through server on 127.0.0.1
// (sourceUrl) so its reads can be counted too: each request is relayed to
// Drive as-is with the service account's token, and dropped as soon as
// ffmpeg hangs up.

const DRIVE_API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';
const RETRYABLE = new Set([429, 500, 502, 503, 504]); // 403s (quota, rate limit) are not retried here
const RETRY_DELAYS_MS = [400, 1500];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- usage accounting -------------------------------------------------------

const REPORT_EVERY_MS = 5 * 60e3;
const totals = new Map(); // purpose -> bytes since start (never reset)
let recent = new Map();   // purpose -> { bytes, requests, refused } since last report
let reportTimer = null;

export function countDriveBytes(purpose, bytes, { request = false, refused = false } = {}) {
  totals.set(purpose, (totals.get(purpose) || 0) + bytes);
  const r = recent.get(purpose) || { bytes: 0, requests: 0, refused: 0 };
  r.bytes += bytes;
  if (request) r.requests++;
  if (refused) r.refused++;
  recent.set(purpose, r);
  if (!reportTimer) {
    reportTimer = setTimeout(() => {
      reportTimer = null;
      const parts = [...recent].map(([p, v]) =>
        `${p} ${(v.bytes / 1048576).toFixed(1)} MiB / ${v.requests} req${v.refused ? ` (${v.refused} refused)` : ''}`);
      console.log(`drive reads (${REPORT_EVERY_MS / 60e3} min): ${parts.join(', ')}`);
      recent = new Map();
    }, REPORT_EVERY_MS);
    reportTimer.unref?.();
  }
}

// Bytes read from Drive for this purpose since the process started.
export function driveBytesRead(purpose) {
  return totals.get(purpose) || 0;
}

// --- pass-through for ffmpeg ------------------------------------------------

function mediaUrl(id) {
  return `${DRIVE_API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
}

async function relay(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = decodeURIComponent(url.pathname.slice(1));
  const purpose = url.searchParams.get('for') || 'other';
  const aborter = new AbortController();
  res.on('close', () => aborter.abort());
  try {
    const token = await getServiceAccountToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (req.headers.range) headers.Range = req.headers.range;
    let drive;
    for (let attempt = 0; ; attempt++) {
      drive = await fetch(mediaUrl(id), { method: req.method, headers, signal: aborter.signal });
      countDriveBytes(purpose, 0, { request: true, refused: !drive.ok });
      if (drive.ok || !RETRYABLE.has(drive.status) || attempt >= RETRY_DELAYS_MS.length) break;
      drive.body?.cancel();
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
    const out = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = drive.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(drive.status, out);
    if (!drive.body || req.method === 'HEAD') return res.end();
    for await (const chunk of drive.body) {
      countDriveBytes(purpose, chunk.length);
      if (!res.write(chunk)) {
        await new Promise(r => {
          const done = () => { res.off('drain', done); res.off('close', done); r(); };
          res.on('drain', done);
          res.on('close', done);
        });
      }
      if (aborter.signal.aborted) break;
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`drive read failed: ${err.message}`);
    } else {
      res.destroy();
    }
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { relay(req, res); });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.unref();
  });
}
const PORT = await startServer();

// The URL ffmpeg should read a Drive file from; `purpose` labels the bytes.
export function sourceUrl(id, purpose) {
  return `http://127.0.0.1:${PORT}/${encodeURIComponent(id)}?for=${purpose}`;
}
