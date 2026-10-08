import { spawn } from 'node:child_process';
import { getServiceAccountToken, kvCommand } from './_lib/serviceAccount.js';
import { isAuthorized } from './_lib/auth.js';
import { FFMPEG, TRANSIENT_RE, probeInfo } from './_lib/media.js';
import { sourceUrl, driveBytesRead, lastDriveRefusal } from './_lib/driveSource.js';
import { listLibrary } from './_lib/library.js';
import { libraryStats } from './_lib/libraryStats.js';

// Highlight analysis for smart compilations. Each video is sampled about
// once a minute (MIN_SAMPLES..MAX_SAMPLES points); at each, WINDOW_S
// seconds are measured for motion (how much the picture changes frame to
// frame) and loudness. A second pass then samples around the best few
// spots to land on the actual peak within those scenes. The strongest few
// moments are kept in KV (PEAKS_KEY: fileId -> JSON) for /api/compile to
// cut around.
//
//   POST /api/analyze   analyse a batch for up to RUN_BUDGET_S, then stop
//                       (Cloud Scheduler with `Authorization: Bearer
//                       $ANALYZE_SECRET`, or the signed-in owner)
//   GET  /api/analyze   how many videos have been analysed (owner)
//
// Work left is kept in KV, so each run picks up where the last stopped.
// Run time is capped per UTC day (ANALYZE_DAILY_MINUTES, default 30), as
// is what it reads from Drive (ANALYZE_DAILY_GB, default 10), so the
// backlog spreads over several days instead of eating the month's free CPU
// or Drive's daily download allowance at once.
// The library is re-listed from Drive at most hourly to catch new uploads,
// so a run with nothing to do ends in milliseconds.

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const PEAKS_KEY      = 'rvp:peaks';
const TODO_KEY       = 'rvp:analyze:todo';
const LISTED_KEY     = 'rvp:analyze:listedAt';
const LOCK_KEY       = 'rvp:analyze:lock';
const VERSION        = 1;
const MIN_SAMPLES    = 16;
const MAX_SAMPLES    = 48;
const SAMPLE_EVERY_S = 60;
const REFINE_TOP     = 3;                 // spots refined in the second pass
const REFINE_OFFSETS = [-1 / 3, 1 / 3, 2 / 3]; // x coarse spacing; forward-leaning, as clips run forward
const EXTENT_DROP    = 0.15;              // neighbours within this of a peak's score count as the same busy stretch
const WINDOW_S       = 2;
const KEEP_PEAKS     = 5;
const MIN_DURATION_S = 30;   // shorter videos just get random cuts
const RUN_BUDGET_S   = 120;  // well under Cloud Scheduler's default 180 s attempt deadline
const HARD_STOP_S    = 150;  // a video still running at this point is dropped and retried next run
const START_MARGIN_S = 20;   // don't start a video this close to the deadline
const DAILY_MINUTES  = Number(process.env.ANALYZE_DAILY_MINUTES) || 30;
const DAY_KEY        = 'rvp:analyze:day:';
// Drive limits how much can be downloaded from the owner's files per day,
// and hitting that limit blocks normal playback too. Each sample reads from
// the nearest keyframe before it, so a video costs a sizeable share of its
// file (about half of a 1 GB test video). Analysis stops for the day once
// it has read this much.
const DAILY_GB       = Number(process.env.ANALYZE_DAILY_GB) || 10;
const BYTES_KEY      = 'rvp:analyze:bytes:';
// Kept gentle: bursts of reads get the service account rate-limited by
// Drive. 2 x 2 = at most 4 reads in flight (was 24), with a pause after
// each and a longer one whenever Drive refuses.
const PARALLEL       = 2;    // videos at once
const SAMPLE_PARALLEL = 2;   // samples per video at once
const SAMPLE_PAUSE_MS = 300;  // after each sample, per lane
const REFUSED_PAUSE_MS = 5e3; // after a sample Drive refused
const RELIST_MS      = 3600e3;
const RETRY_FAILED_MS = 7 * 86400e3; // permanent failures (unreadable file) are re-checked weekly
const STOP_AFTER_TRANSIENT = 5;       // this many Drive refusals in a row ends the run early
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
      '-ss', t.toFixed(2), '-t', String(WINDOW_S),
      '-i', sourceUrl(id, 'analyze'),
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
      if (!diffs.length) {
        const e = new Error('no frames');
        e.transient = TRANSIENT_RE.test(err);
        return reject(e);
      }
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

// Runs async jobs with at most `limit` in flight.
async function runLimited(jobs, limit) {
  let next = 0;
  const lane = async () => { while (next < jobs.length) await jobs[next++](); };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, lane));
}

class OutOfTime extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function analyzeVideo(id, durationMs, token, stopAt = Infinity) {
  const info = await probeInfo(id, token, 'analyze');
  const d = durationMs > 0 ? durationMs / 1000 : info.duration;
  if (!(d >= MIN_DURATION_S)) return { v: VERSION, d: Math.round(d || 0), peaks: [] };

  const lo = d * 0.08;
  const span = d * 0.84 - WINDOW_S;
  const count = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(d / SAMPLE_EVERY_S)));
  const step = span / count;
  const samples = [];
  const sampleAt = async t => {
    if (Date.now() > stopAt) throw new OutOfTime('out of time');
    let pause = SAMPLE_PAUSE_MS;
    try {
      samples.push({ t, ...(await measure(id, t, token, info.hasAudio)) });
    } catch (err) {
      // Unreadable spot - skip it; if Drive refused, back off before the next.
      if (err.transient) pause = REFUSED_PAUSE_MS;
    }
    await sleep(Math.max(0, Math.min(pause, stopAt - Date.now())));
  };

  // Pass 1: evenly across the middle of the video.
  await runLimited(Array.from({ length: count }, (_, i) => () => sampleAt(lo + step * (i + 0.5))), SAMPLE_PARALLEL);
  if (!samples.length) {
    // Every spot failed to read: almost always Drive refusing requests, not the file.
    const err = new Error('no samples measured');
    err.transient = true;
    throw err;
  }
  scoreSamples(samples);

  // Pass 2: around the best few spots, to find the peak inside each scene.
  const best = [...samples].sort((a, b) => b.score - a.score).slice(0, REFINE_TOP);
  const refine = best.flatMap(s => REFINE_OFFSETS.map(k => s.t + k * step)).filter(t => t >= lo && t <= lo + span);
  await runLimited(refine.map(t => () => sampleAt(t)), SAMPLE_PARALLEL);
  scoreSamples(samples);

  // Best first, spaced apart so the peaks aren't all one scene. Each peak
  // is [time, score, length]: length is how long the busy stretch around
  // it lasts, judged from neighbouring samples that score nearly as high -
  // coarse (samples are tens of seconds apart), but enough to tell a
  // short burst from a sustained scene for variable clip lengths.
  const byTime = [...samples].sort((a, b) => a.t - b.t);
  const extentOf = s => {
    let i = byTime.indexOf(s);
    let j = i;
    while (i > 0 && byTime[i - 1].score >= s.score - EXTENT_DROP) i--;
    while (j < byTime.length - 1 && byTime[j + 1].score >= s.score - EXTENT_DROP) j++;
    return byTime[j].t + WINDOW_S - byTime[i].t;
  };
  const gap = Math.max(15, d / 30);
  const peaks = [];
  for (const s of [...samples].sort((a, b) => b.score - a.score)) {
    if (peaks.length >= KEEP_PEAKS) break;
    if (peaks.every(p => Math.abs(p[0] - s.t) >= gap)) {
      peaks.push([Math.round(s.t * 10) / 10, Math.round(s.score * 1000) / 1000, Math.round(extentOf(s))]);
    }
  }
  return { v: VERSION, d: Math.round(d), peaks };
}

// Scores every sample 0..1 against the others in the same video.
function scoreSamples(samples) {
  const motionRank = ranks(samples.map(s => s.motion));
  const useAudio = samples.every(s => s.loud !== null);
  const loudRank = useAudio ? ranks(samples.map(s => s.loud)) : null;
  samples.forEach((s, i) => { s.score = useAudio ? (motionRank[i] + loudRank[i]) / 2 : motionRank[i]; });
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
    // Failures not marked permanent (older entries included) are retried.
    const retry = entry.failed && (!entry.permanent || Date.now() - (entry.at || 0) > RETRY_FAILED_MS);
    if (entry.v === VERSION && !retry) doneSet.add(stored[i]);
  }
  todo = library.filter(v => !doneSet.has(v.id)).map(v => [v.id, v.durationMs]);
  await Promise.all([
    kvCommand(['SET', TODO_KEY, JSON.stringify(todo)]),
    kvCommand(['SET', LISTED_KEY, String(Date.now())]),
  ]);
  return todo;
}

async function runBatch() {
  const started = Date.now();
  const dayKey = DAY_KEY + new Date(started).toISOString().slice(0, 10);
  const day = new Date(started).toISOString().slice(0, 10);
  const bytesKey = BYTES_KEY + day;
  const [usedRaw, usedBytesRaw] = await Promise.all([kvCommand(['GET', dayKey]), kvCommand(['GET', bytesKey])]);
  const usedS = Number(usedRaw) || 0;
  const usedBytes = Number(usedBytesRaw) || 0;
  const budgetBytes = DAILY_GB * 1e9 - usedBytes;
  if (budgetBytes <= 0) return { analyzed: 0, capped: `${DAILY_GB} GB read from Drive` };
  const budgetS = Math.min(RUN_BUDGET_S, DAILY_MINUTES * 60 - usedS);
  if (budgetS < START_MARGIN_S + 10) return { analyzed: 0, capped: `${DAILY_MINUTES} min` };
  const startBytes = driveBytesRead('analyze');
  const runBytes = () => driveBytesRead('analyze') - startBytes;
  const deadline = started + budgetS * 1000;
  const token = await getServiceAccountToken();
  const todo = await loadTodo(token);
  if (!todo.length) return { analyzed: 0, remaining: 0 };

  const finished = new Set();
  let videoSeconds = 0;
  let transientStreak = 0;
  let stopReason = null;
  let next = 0;
  async function worker() {
    while (!stopReason && next < todo.length && Date.now() < deadline - START_MARGIN_S * 1000
      && runBytes() < budgetBytes) {
      const [id, durationMs] = todo[next++];
      const videoStart = Date.now();
      let result;
      try {
        result = await analyzeVideo(id, durationMs, token, started + HARD_STOP_S * 1000);
      } catch (err) {
        if (err instanceof OutOfTime) continue; // left in the to-do list for next run
        if (err.transient) {
          // Not the file's fault: leave it for a later run, and stop early if
          // Drive keeps refusing rather than burning through the list.
          if (++transientStreak >= STOP_AFTER_TRANSIENT && !stopReason) {
            stopReason = `${err.message} [Drive says: ${lastDriveRefusal('analyze') || 'no reason given'}]`;
          }
          continue;
        }
        console.log(`analyze ${id.slice(0, 6)}… failed: ${err.message}`);
        result = { v: VERSION, failed: true, permanent: true, at: Date.now(), peaks: [] };
      }
      transientStreak = 0;
      await kvCommand(['HSET', PEAKS_KEY, id, JSON.stringify(result)]);
      finished.add(id);
      videoSeconds += (Date.now() - videoStart) / 1000;
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  const remaining = todo.filter(([id]) => !finished.has(id));
  const ranS = Math.ceil((Date.now() - started) / 1000);
  const readBytes = runBytes();
  await Promise.all([
    kvCommand(['SET', TODO_KEY, JSON.stringify(remaining)]),
    kvCommand(['INCRBY', dayKey, String(ranS)]).then(() => kvCommand(['EXPIRE', dayKey, String(2 * 86400)])),
    kvCommand(['INCRBY', bytesKey, String(readBytes)]).then(() => kvCommand(['EXPIRE', bytesKey, String(2 * 86400)])),
  ]);
  return {
    analyzed: finished.size,
    remaining: remaining.length,
    ranSeconds: ranS,
    secondsPerVideo: finished.size ? Math.round(videoSeconds / finished.size) : null,
    readMB: Math.round(readBytes / 1e6),
    dayReadGB: Math.round((usedBytes + readBytes) / 1e8) / 10,
    stopReason,
  };
}

// Library lengths/resolutions/bitrates to the log, at most hourly, when the
// app checks progress (see _lib/libraryStats.js). Doesn't delay the reply.
let statsLoggedAt = 0;
function logLibraryStats() {
  if (Date.now() - statsLoggedAt < 3600e3) return;
  statsLoggedAt = Date.now();
  getServiceAccountToken()
    .then(listLibrary)
    .then(videos => console.log(libraryStats(videos)))
    .catch(err => { statsLoggedAt = 0; console.log(`library stats failed: ${err.message}`); });
}

export default async function handler(req) {
  const origin = req.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const scheduler = isScheduler(req);
  if (!scheduler && !(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);

  if (req.method === 'GET') {
    // Only real results count as ready; stored failures are retried later.
    const stored = (await kvCommand(['HGETALL', PEAKS_KEY])) || [];
    let analyzed = 0;
    let failed = 0;
    for (let i = 1; i < stored.length; i += 2) {
      let entry = {};
      try { entry = JSON.parse(stored[i]); } catch (err) { /* counted as neither */ }
      if (entry.failed) failed++;
      else if (entry.v === VERSION) analyzed++;
    }
    logLibraryStats();
    return json({ analyzed, failed });
  }
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // One run at a time; the lock outlives a run so overlapping triggers skip.
  const locked = await kvCommand(['SET', LOCK_KEY, '1', 'NX', 'EX', String(RUN_BUDGET_S + 60)]);
  if (!locked) return json({ busy: true });
  try {
    const result = await runBatch();
    console.log(result.capped
      ? `analyze run: daily cap reached (${result.capped})`
      : result.ranSeconds === undefined
      ? 'analyze run: nothing left to analyse'
      : `analyze run: ${result.analyzed} analysed in ${result.ranSeconds} s `
        + `(~${result.secondsPerVideo} s per video, ${PARALLEL} at once), ${result.remaining} left; `
        + `read ${result.readMB} MB from Drive (${result.dayReadGB} of ${DAILY_GB} GB today)`
        + (result.stopReason ? `; stopped early, Drive refusing: ${result.stopReason}` : ''));
    return json(result);
  } finally {
    await kvCommand(['DEL', LOCK_KEY]).catch(() => {});
  }
}
