import { spawn } from 'node:child_process';
import { getServiceAccountToken, kvCommand } from './_lib/serviceAccount.js';
import { isAuthorized } from './_lib/auth.js';
import { FFMPEG, driveUrl, authHeader, probeInfo } from './_lib/media.js';
import { listLibrary } from './_lib/library.js';

// Highlight analysis for smart compilations. Each video is sampled at
// SAMPLES points; at each, WINDOW_S seconds are measured for motion (how
// much the picture changes frame to frame) and loudness. The strongest few
// moments are kept in KV (PEAKS_KEY: fileId -> JSON) for /api/compile to
// cut around.
//
//   POST /api/analyze   analyse a batch for up to RUN_BUDGET_S, then stop
//                       (Cloud Scheduler with `Authorization: Bearer
//                       $ANALYZE_SECRET`, or the signed-in owner)
//   GET  /api/analyze   how many videos have been analysed (owner)
//
// Work left is kept in KV, so each run picks up where the last stopped.
// The library is re-listed from Drive at most hourly to catch new uploads,
// so a run with nothing to do ends in milliseconds.

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const PEAKS_KEY      = 'rvp:peaks';
const TODO_KEY       = 'rvp:analyze:todo';
const LISTED_KEY     = 'rvp:analyze:listedAt';
const LOCK_KEY       = 'rvp:analyze:lock';
const VERSION        = 1;
const SAMPLES        = 16;
const WINDOW_S       = 2;
const KEEP_PEAKS     = 5;
const MIN_DURATION_S = 30;   // shorter videos just get random cuts
const RUN_BUDGET_S   = 150;  // under Cloud Scheduler's default 180 s attempt deadline
const START_MARGIN_S = 25;   // don't start a video this close to the deadline
const PARALLEL       = 6;    // videos at once; each runs one ffmpeg at a time
const RELIST_MS      = 3600e3;
const RETRY_FAILED_MS = 7 * 86400e3; // a failure may have been a passing Drive error
const MEASURE_TIMEOUT_MS = 30e3;

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age':       '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isScheduler(req) {
  const secret = process.env.ANALYZE_SECRET;
  return Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`;
}

// One sample: motion = mean absolute luma difference between consecutive
// frames (downscaled, 8 fps); loudness = mean volume in dB.
function measure(id, t, token, hasAudio) {
  return new Promise((resolve, reject) => {
    const video = '[0:v:0]scale=128:72,fps=8,format=gray,tblend=all_mode=difference,'
      + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-[v]';
    const graph = hasAudio ? `${video};[0:a:0]volumedetect[a]` : video;
    const ff = spawn(FFMPEG, [
      '-hide_banner', '-nostats', '-loglevel', 'info',
      ...authHeader(token),
      '-ss', t.toFixed(2), '-t', String(WINDOW_S),
      '-i', driveUrl(id),
      '-filter_complex', graph,
      '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []),
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => ff.kill('SIGKILL'), MEASURE_TIMEOUT_MS);
    ff.stdout.on('data', d => { if (out.length < 200000) out += d; });
    ff.stderr.on('data', d => { if (err.length < 50000) err += d; });
    ff.on('error', reject);
    ff.on('close', () => {
      clearTimeout(timer);
      const diffs = [...out.matchAll(/signalstats\.YAVG=([\d.]+)/g)].map(m => Number(m[1]));
      if (!diffs.length) return reject(new Error('no frames'));
      const vol = /mean_volume: (-?[\d.]+) dB/.exec(err);
      resolve({
        motion: diffs.reduce((a, b) => a + b, 0) / diffs.length,
        loud:   vol ? Number(vol[1]) : null,
      });
    });
  });
}

// 0..1 by rank, so the two measures (different units) weigh equally.
// Equal values share their average rank - a flat stretch scores the same
// everywhere instead of being ordered arbitrarily.
function ranks(values) {
  const n = values.length;
  if (n < 2) return values.map(() => 0.5);
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n);
  for (let r = 0; r < n;) {
    let end = r;
    while (end + 1 < n && order[end + 1][0] === order[r][0]) end++;
    const rank = (r + end) / 2 / (n - 1);
    for (let k = r; k <= end; k++) out[order[k][1]] = rank;
    r = end + 1;
  }
  return out;
}

export async function analyzeVideo(id, durationMs, token) {
  const info = await probeInfo(id, token);
  const d = durationMs > 0 ? durationMs / 1000 : info.duration;
  if (!(d >= MIN_DURATION_S)) return { v: VERSION, d: Math.round(d || 0), peaks: [] };

  const span = d * 0.84 - WINDOW_S;
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = d * 0.08 + span * (i + 0.5) / SAMPLES;
    try {
      samples.push({ t, ...(await measure(id, t, token, info.hasAudio)) });
    } catch (err) { /* unreadable spot - skip it */ }
  }
  if (!samples.length) throw new Error('no samples measured');

  const motionRank = ranks(samples.map(s => s.motion));
  const useAudio = samples.every(s => s.loud !== null);
  const loudRank = useAudio ? ranks(samples.map(s => s.loud)) : null;
  samples.forEach((s, i) => { s.score = useAudio ? (motionRank[i] + loudRank[i]) / 2 : motionRank[i]; });

  // Best first, spaced apart so the peaks aren't all one scene.
  const gap = Math.max(15, d / 30);
  const peaks = [];
  for (const s of [...samples].sort((a, b) => b.score - a.score)) {
    if (peaks.length >= KEEP_PEAKS) break;
    if (peaks.every(p => Math.abs(p[0] - s.t) >= gap)) peaks.push([Math.round(s.t * 10) / 10, Math.round(s.score * 1000) / 1000]);
  }
  return { v: VERSION, d: Math.round(d), peaks };
}

async function loadTodo(token) {
  const [raw, listedAt] = await Promise.all([kvCommand(['GET', TODO_KEY]), kvCommand(['GET', LISTED_KEY])]);
  let todo = raw ? JSON.parse(raw) : null;
  if (todo && Date.now() - Number(listedAt || 0) < RELIST_MS) return todo;
  const [library, stored] = await Promise.all([listLibrary(token), kvCommand(['HGETALL', PEAKS_KEY])]);
  const doneSet = new Set();
  for (let i = 0; i + 1 < (stored || []).length; i += 2) {
    let entry = {};
    try { entry = JSON.parse(stored[i + 1]); } catch (err) { /* re-analyse */ continue; }
    if (entry.v === VERSION && !(entry.failed && Date.now() - (entry.at || 0) > RETRY_FAILED_MS)) doneSet.add(stored[i]);
  }
  todo = library.filter(v => !doneSet.has(v.id)).map(v => [v.id, v.durationMs]);
  await Promise.all([
    kvCommand(['SET', TODO_KEY, JSON.stringify(todo)]),
    kvCommand(['SET', LISTED_KEY, String(Date.now())]),
  ]);
  return todo;
}

async function runBatch() {
  const deadline = Date.now() + RUN_BUDGET_S * 1000;
  const token = await getServiceAccountToken();
  const todo = await loadTodo(token);
  if (!todo.length) return { analyzed: 0, remaining: 0 };

  const finished = new Set();
  let next = 0;
  async function worker() {
    while (next < todo.length && Date.now() < deadline - START_MARGIN_S * 1000) {
      const [id, durationMs] = todo[next++];
      let result;
      try {
        result = await analyzeVideo(id, durationMs, token);
      } catch (err) {
        console.log(`analyze ${id.slice(0, 6)}… failed: ${err.message}`);
        result = { v: VERSION, failed: true, at: Date.now(), peaks: [] };
      }
      await kvCommand(['HSET', PEAKS_KEY, id, JSON.stringify(result)]);
      finished.add(id);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const remaining = todo.filter(([id]) => !finished.has(id));
  await kvCommand(['SET', TODO_KEY, JSON.stringify(remaining)]);
  return { analyzed: finished.size, remaining: remaining.length };
}

export default async function handler(req) {
  const origin = req.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const scheduler = isScheduler(req);
  if (!scheduler && !(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);

  if (req.method === 'GET') {
    return json({ analyzed: Number(await kvCommand(['HLEN', PEAKS_KEY])) || 0 });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // One run at a time; the lock outlives a run so overlapping triggers skip.
  const locked = await kvCommand(['SET', LOCK_KEY, '1', 'NX', 'EX', String(RUN_BUDGET_S + 60)]);
  if (!locked) return json({ busy: true });
  try {
    const result = await runBatch();
    console.log(`analyze run: ${result.analyzed} analysed, ${result.remaining} left`);
    return json(result);
  } finally {
    await kvCommand(['DEL', LOCK_KEY]).catch(() => {});
  }
}
