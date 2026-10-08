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

// --- refusals ---------------------------------------------------------------

// Drive's JSON error names the reason (downloadQuotaExceeded,
// userRateLimitExceeded, ...); ffmpeg only ever says "403 Forbidden".
export function refusalReason(status, bodyText) {
  try {
    const e = JSON.parse(bodyText).error || {};
    const reasons = (e.errors || []).map(x => x.reason).filter(Boolean).join(',');
    return [reasons, e.message].filter(Boolean).join(': ').slice(0, 200) || `HTTP ${status}`;
  } catch (err) {
    return `HTTP ${status}`;
  }
}

const lastRefusal = new Map(); // purpose -> { reason, loggedAt }

// The most recent reason Drive gave for refusing a read for this purpose.
export function lastDriveRefusal(purpose) {
  return lastRefusal.get(purpose)?.reason || null;
}

function noteRefusal(purpose, id, status, reason) {
  const prev = lastRefusal.get(purpose);
  const loggedAt = prev && Date.now() - prev.loggedAt < 60e3 ? prev.loggedAt : Date.now();
  if (loggedAt !== prev?.loggedAt) console.log(`${purpose}: Drive refused ${id.slice(0, 6)}… ${status} ${reason}`);
  lastRefusal.set(purpose, { reason: `${status} ${reason}`, loggedAt });
}

function mediaUrl(id) {
  return `${DRIVE_API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
}

// --- small pieces for analysis --------------------------------------------
//
// A highlight sample needs ~1-3 MB, but ffmpeg asks for "from here to the
// end" and its connection runs megabytes ahead before it hangs up; every
// sample also re-reads the file's start and its index. For analysis each
// request is answered with at most PIECE_BYTES (a 206 shorter than asked):
// ffmpeg, run with -reconnect_at_eof (pieceArgs), asks again from where it
// stopped, so nothing is fetched ahead of what it reads. Pieces are cached
// per file, so the start and index every sample re-reads come from memory.
// Measured offline: ~16x less read per video than plain pass-through.

const PIECE_BYTES = Number(process.env.DRIVE_PIECE_BYTES) || 256 * 1024;
const PIECE_CACHE_BYTES = 64 * 1024 * 1024;
const pieces = new Map(); // `${id}:${start}` -> { buf, size, type }, oldest first
let pieceCacheBytes = 0;

async function fetchPiece(id, start, signal, purpose) {
  const key = `${id}:${start}`;
  const hit = pieces.get(key);
  if (hit) { pieces.delete(key); pieces.set(key, hit); return { ok: true, ...hit }; }
  const token = await getServiceAccountToken();
  let drive;
  for (let attempt = 0; ; attempt++) {
    drive = await fetch(mediaUrl(id), {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${start + PIECE_BYTES - 1}` },
      signal,
    });
    countDriveBytes(purpose, 0, { request: true, refused: !drive.ok });
    if (drive.ok || !RETRYABLE.has(drive.status) || attempt >= RETRY_DELAYS_MS.length) break;
    drive.body?.cancel();
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  if (!drive.ok) {
    const text = await drive.text().catch(() => '');
    noteRefusal(purpose, id, drive.status, refusalReason(drive.status, text));
    return { ok: false, status: drive.status, text };
  }
  const buf = Buffer.from(await drive.arrayBuffer());
  countDriveBytes(purpose, buf.length);
  const size = Number((/\/(\d+)$/.exec(drive.headers.get('content-range') || '') || [])[1]) || buf.length;
  const piece = { buf, size, type: drive.headers.get('content-type') || 'application/octet-stream' };
  pieces.set(key, piece);
  pieceCacheBytes += buf.length;
  while (pieceCacheBytes > PIECE_CACHE_BYTES) {
    const [oldKey, old] = pieces.entries().next().value;
    pieces.delete(oldKey);
    pieceCacheBytes -= old.buf.length;
  }
  return { ok: true, ...piece };
}

// `length` bytes from `start` (fewer at the end of the file) plus the file's
// total size, through the same cached pieces - reading a few bytes near
// where ffmpeg already read costs nothing more.
export async function readDriveBytes(id, start, length, purpose = 'analyze', signal) {
  const parts = [];
  let size = 0;
  for (let at = start; at < start + length;) {
    const pieceStart = Math.floor(at / PIECE_BYTES) * PIECE_BYTES;
    const p = await fetchPiece(id, pieceStart, signal, purpose);
    if (!p.ok) {
      const err = new Error(`Drive ${p.status}: ${refusalReason(p.status, p.text)}`);
      err.transient = true;
      throw err;
    }
    size = p.size;
    if (at >= size) break;
    const end = Math.min(start + length, pieceStart + p.buf.length, size);
    parts.push(p.buf.subarray(at - pieceStart, end - pieceStart));
    at = end;
    if (end >= size) break;
  }
  return { buf: Buffer.concat(parts), size };
}

async function servePiece(req, res, id, purpose, signal) {
  const m = /^bytes=(\d+)-(\d*)$/.exec((req.headers.range || 'bytes=0-').trim());
  if (!m) { res.writeHead(416); return res.end(); }
  const start = Number(m[1]);
  // Aligned, so repeated reads of the same region hit the cache.
  const pieceStart = Math.floor(start / PIECE_BYTES) * PIECE_BYTES;
  const p = await fetchPiece(id, pieceStart, signal, purpose);
  if (!p.ok) {
    res.writeHead(p.status, { 'Content-Type': 'application/json' });
    return res.end(p.text);
  }
  if (start >= p.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${p.size}` });
    return res.end();
  }
  const end = Math.min(m[2] ? Number(m[2]) : p.size - 1, pieceStart + p.buf.length - 1);
  res.writeHead(206, {
    'Content-Type':   p.type,
    'Content-Length': String(end - start + 1),
    'Content-Range':  `bytes ${start}-${end}/${p.size}`,
    'Accept-Ranges':  'bytes',
  });
  res.end(p.buf.subarray(start - pieceStart, end - pieceStart + 1));
}

// --- pass-through for ffmpeg ------------------------------------------------

async function relay(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = decodeURIComponent(url.pathname.slice(1));
  const purpose = url.searchParams.get('for') || 'other';
  const aborter = new AbortController();
  res.on('close', () => aborter.abort());
  try {
    if (purpose === 'analyze' && req.method === 'GET') return await servePiece(req, res, id, purpose, aborter.signal);
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
    if (!drive.ok) {
      // Logged here (at most once a minute per purpose) because ffmpeg
      // drops the reason.
      const text = req.method === 'HEAD' ? '' : await drive.text().catch(() => '');
      noteRefusal(purpose, id, drive.status, refusalReason(drive.status, text));
      res.writeHead(drive.status, out);
      return res.end(text);
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

// ffmpeg input options for reading in small pieces (purpose 'analyze'):
// reconnect when a short response ends, and inspect only the container's
// index, not megabytes of the file, before seeking.
export function pieceArgs() {
  return ['-reconnect', '1', '-reconnect_at_eof', '1', '-probesize', '32768', '-analyzeduration', '0'];
}
