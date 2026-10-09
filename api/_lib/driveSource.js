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
let recent = new Map();   // purpose -> { bytes, requests, refused, waits } since last report
let reportTimer = null;

export function countDriveBytes(purpose, bytes, { request = false, refused = false, waitS } = {}) {
  totals.set(purpose, (totals.get(purpose) || 0) + bytes);
  const r = recent.get(purpose) || { bytes: 0, requests: 0, refused: 0, waits: [] };
  r.bytes += bytes;
  if (request) r.requests++;
  if (refused) r.refused++;
  if (waitS !== undefined && r.waits.length < 2000) r.waits.push(waitS);
  recent.set(purpose, r);
  if (!reportTimer) {
    reportTimer = setTimeout(() => {
      reportTimer = null;
      // Drive's time to answer (first byte), for piece requests.
      const waitNote = w => {
        if (!w.length) return '';
        const t = w.sort((a, b) => a - b);
        return `, Drive answers in ${t[Math.floor(t.length / 2)].toFixed(2)} s (90% ${t[Math.floor(t.length * 0.9)].toFixed(2)} s)`;
      };
      const parts = [...recent].map(([p, v]) =>
        `${p} ${(v.bytes / 1048576).toFixed(1)} MiB / ${v.requests} req${v.refused ? ` (${v.refused} refused)` : ''}${waitNote(v.waits)}`);
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

// --- small pieces ----------------------------------------------------------
//
// A highlight sample needs ~1-3 MB and a compilation clip ~10-20 MB, but
// ffmpeg asks for "from here to the end" and its connection runs megabytes
// ahead before it hangs up; every sample or clip also re-reads the file's
// start and its index. In piece mode each request is answered with a short
// 206 instead: ffmpeg, run with -reconnect_at_eof (pieceArgs), asks again
// from where it stopped, so little is fetched ahead of what it reads.
//
// Pieces are whole PIECE_BYTES units, cached per file, so the start and
// index every sample re-reads come from memory. Analysis gets one unit per
// request. Compilations read long runs, so a request that carries straight
// on from where the last one for that file ended gets more units - 2, then
// PIECE_GROWTH times as many as the last - up to maxUnits (more when Drive
// is slow to answer): a jump (the header, the index, the seek to the clip) costs one
// small unit, a straight run soon moves in big pieces with few requests.
// Measured offline: ~16x less read per analysed video and ~3x less per
// compilation clip than plain pass-through.

const PIECE_BYTES = Number(process.env.DRIVE_PIECE_BYTES) || 256 * 1024;
const PIECE_CACHE_BYTES = 64 * 1024 * 1024;
const PIECE_GROWTH = 8;
// Each piece costs one round trip to Drive, and ffmpeg waits for it. When
// Drive answers slowly, runs use bigger pieces (up to MAX_RUN_UNITS) so a
// clip still starts quickly: about PIECE_BYTES_PER_S worth of Drive's
// response time per piece.
const MAX_RUN_UNITS = 32; // 8 MB
const PIECE_BYTES_PER_S = 20e6;
let driveWaitS = 0.2; // Drive's time to answer, smoothed
const units = new Map();    // `${id}:${index}` -> { buf, size, type }, oldest first
const fileSizes = new Map(); // id -> total bytes, from Drive's Content-Range
const inFlight = new Map(); // `${id}:${index}` -> promise for the fetch covering it
let pieceCacheBytes = 0;

function cacheUnit(key, unit) {
  if (units.has(key)) return;
  units.set(key, unit);
  pieceCacheBytes += unit.buf.length;
  while (pieceCacheBytes > PIECE_CACHE_BYTES) {
    const [oldKey, old] = units.entries().next().value;
    units.delete(oldKey);
    pieceCacheBytes -= old.buf.length;
  }
}

function cachedUnit(key) {
  const hit = units.get(key);
  if (hit) { units.delete(key); units.set(key, hit); }
  return hit;
}

// One Range request to Drive for units first..first+count-1, each cached.
async function fetchRun(id, first, count, signal, purpose) {
  const token = await getServiceAccountToken();
  const start = first * PIECE_BYTES;
  let drive;
  for (let attempt = 0; ; attempt++) {
    const asked = Date.now();
    drive = await fetch(mediaUrl(id), {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${start + count * PIECE_BYTES - 1}` },
      signal,
    });
    const waitS = (Date.now() - asked) / 1000;
    if (drive.ok) driveWaitS = driveWaitS * 0.8 + waitS * 0.2;
    countDriveBytes(purpose, 0, { request: true, refused: !drive.ok, waitS: drive.ok ? waitS : undefined });
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
  const type = drive.headers.get('content-type') || 'application/octet-stream';
  fileSizes.set(id, size);
  if (fileSizes.size > 500) fileSizes.delete(fileSizes.keys().next().value);
  for (let i = 0; i * PIECE_BYTES < buf.length; i++) {
    // Copied out, so evicting a unit frees it (a slice would keep the
    // whole run's buffer alive).
    const unit = count === 1 ? buf : Buffer.from(buf.subarray(i * PIECE_BYTES, (i + 1) * PIECE_BYTES));
    cacheUnit(`${id}:${first + i}`, { buf: unit, size, type });
  }
  return { ok: true };
}

// Units first..first+count-1 (fewer at the end of the file) as one buffer,
// from the cache where possible; what's missing is fetched in one request.
async function fetchPiece(id, first, count, signal, purpose) {
  for (;;) {
    const have = [];
    let unit;
    while (have.length < count && (unit = cachedUnit(`${id}:${first + have.length}`))) {
      have.push(unit);
      if ((first + have.length) * PIECE_BYTES >= unit.size) break; // end of the file
    }
    if (have.length === count || (have.length && (first + have.length) * PIECE_BYTES >= have[0].size)) {
      const { size, type } = have[0];
      return { ok: true, buf: have.length === 1 ? have[0].buf : Buffer.concat(have.map(u => u.buf)), size, type };
    }
    // Someone is already fetching the next unit needed: wait for that.
    const missing = first + have.length;
    const pending = inFlight.get(`${id}:${missing}`);
    if (pending) {
      const r = await pending.catch(err => ({ ok: false, err }));
      if (r.ok) continue;
      if (r.err) throw r.err;
      return r;
    }
    let run = count - have.length;
    while (run > 1 && units.has(`${id}:${missing + run - 1}`)) run--;
    const fetching = fetchRun(id, missing, run, signal, purpose);
    const keys = Array.from({ length: run }, (_, i) => `${id}:${missing + i}`);
    for (const k of keys) inFlight.set(k, fetching);
    let r;
    try {
      r = await fetching;
    } finally {
      for (const k of keys) if (inFlight.get(k) === fetching) inFlight.delete(k);
    }
    if (!r.ok) return r;
  }
}

// `length` bytes from `start` (fewer at the end of the file) plus the file's
// total size, through the same cached pieces - reading a few bytes near
// where ffmpeg already read costs nothing more.
export async function readDriveBytes(id, start, length, purpose = 'analyze', signal) {
  const parts = [];
  let size = 0;
  for (let at = start; at < start + length;) {
    const index = Math.floor(at / PIECE_BYTES);
    const pieceStart = index * PIECE_BYTES;
    const p = await fetchPiece(id, index, 1, signal, purpose);
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

// Where the last piece for each file ended, how many units it had and
// where its straight run began, so a request that carries straight on can
// get a bigger one.
const runs = new Map(); // `${purpose}:${id}` -> { next, count, from }

// A clip needs about `secs` of the file from where its run starts. At the
// file's average rate (size / duration) that's a byte budget; pieces
// don't reach past it, so the last one doesn't fetch megabytes after the
// clip ends - past the budget (a busier stretch than average) the run
// carries on in pieces of BUDGET_OVER_UNITS.
const BUDGET_SLACK = 1.05;
const BUDGET_EXTRA_BYTES = 256 * 1024;
const BUDGET_OVER_UNITS = 2;
function runBudgetEnd(id, from, budget) {
  const size = fileSizes.get(id);
  if (!budget || !size) return Infinity;
  return from + budget.secs * (size / budget.dur) * BUDGET_SLACK + BUDGET_EXTRA_BYTES;
}

async function servePiece(req, res, id, purpose, maxUnits, signal, budget) {
  const m = /^bytes=(\d+)-(\d*)$/.exec((req.headers.range || 'bytes=0-').trim());
  if (!m) { res.writeHead(416); return res.end(); }
  const start = Number(m[1]);
  const runKey = `${purpose}:${id}`;
  const last = runs.get(runKey);
  const cap = maxUnits > 1
    ? Math.min(MAX_RUN_UNITS, Math.max(maxUnits, Math.ceil(driveWaitS * PIECE_BYTES_PER_S / PIECE_BYTES)))
    : maxUnits;
  // 1 unit after a jump, then 2, then x PIECE_GROWTH: ffmpeg's first read
  // past a jump is often just the rest of one frame (opening a file it
  // looks at the first frame, a few KB past the first unit), and a real
  // run still reaches big pieces by its third request.
  const carriesOn = last && last.next === start;
  const from = carriesOn ? last.from : start;
  let count = !carriesOn ? 1 : last.count === 1 ? Math.min(2, cap) : Math.min(last.count * PIECE_GROWTH, cap);
  // Aligned, so repeated reads of the same region hit the cache.
  const first = Math.floor(start / PIECE_BYTES);
  const pieceStart = first * PIECE_BYTES;
  const budgetEnd = runBudgetEnd(id, from, budget);
  if (budgetEnd < Infinity) {
    const allowed = Math.ceil((budgetEnd - pieceStart) / PIECE_BYTES);
    count = Math.min(count, allowed >= 1 ? allowed : BUDGET_OVER_UNITS);
  }
  const p = await fetchPiece(id, first, count, signal, purpose);
  if (!p.ok) {
    res.writeHead(p.status, { 'Content-Type': 'application/json' });
    return res.end(p.text);
  }
  if (start >= p.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${p.size}` });
    return res.end();
  }
  const end = Math.min(m[2] ? Number(m[2]) : p.size - 1, pieceStart + p.buf.length - 1);
  runs.delete(runKey);
  runs.set(runKey, { next: end + 1, count, from });
  if (runs.size > 200) runs.delete(runs.keys().next().value);
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
  const maxUnits = Number(url.searchParams.get('pieces')) || 0;
  const secs = Number(url.searchParams.get('secs')), dur = Number(url.searchParams.get('dur'));
  const budget = secs > 0 && dur > 0 ? { secs, dur } : null;
  const aborter = new AbortController();
  res.on('close', () => aborter.abort());
  try {
    if (maxUnits > 0 && req.method === 'GET') return await servePiece(req, res, id, purpose, maxUnits, aborter.signal, budget);
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
// With `pieces` (max units per piece) it is read in piece mode - ffmpeg
// must then be run with pieceArgs(). Analysis always reads in pieces.
// `secs` (seconds needed from where the read starts) and `dur` (the
// file's length in seconds) set a byte budget for long runs (see
// runBudgetEnd).
export function sourceUrl(id, purpose, { pieces = purpose === 'analyze' ? 1 : 0, secs = 0, dur = 0 } = {}) {
  const budget = pieces && secs > 0 && dur > 0 ? `&secs=${secs}&dur=${dur}` : '';
  return `http://127.0.0.1:${PORT}/${encodeURIComponent(id)}?for=${purpose}${pieces ? `&pieces=${pieces}` : ''}${budget}`;
}

// ffmpeg input options for reading in pieces: reconnect when a short
// response ends - straight away, and only once, so the end of the file or a
// refusal ends the read instead of retrying for minutes - and inspect only
// the container's index, not megabytes of the file, before seeking.
export function pieceArgs() {
  return ['-reconnect', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '0', '-probesize', '32768', '-analyzeduration', '0'];
}
