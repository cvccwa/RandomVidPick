import { spawn } from 'node:child_process';
import { getServiceAccountToken, kvCommand, b64url } from './_lib/serviceAccount.js';
import { isAuthorized, ID_RE } from './_lib/auth.js';

// Compilation mode: random ~10s clips from many videos, played back to back
// in VLC as one HLS stream.
//
//   POST /api/compile   {clips: [{id, d, w, h}], mode}  -> {url}   (owner only)
//   GET  /api/compile/playlist.m3u8?s=SESSION
//   GET  /api/compile/seg.ts?s=SESSION&n=INDEX
//
// Two modes:
// - original: each clip is cut with stream copy - untouched quality, almost
//   no CPU - but clips keep their own codec/resolution/timing, so a
//   discontinuity tag sits between them and VLC visibly resets at each one.
// - smooth: each clip is re-encoded to one format for the whole compilation
//   (same resolution, 30 fps, H.264 + AAC stereo) and to exactly CLIP_S
//   seconds on one continuous timeline, so playback runs straight through
//   and seeking lines up. The resolution is fixed per compilation (auto
//   picks what most of its clips are; see pickHeight). While one clip is
//   being served, the next is already encoding.
//
// The session id is a long random token, so knowing it is what grants access
// to the playlist and segments (VLC can't send headers); it lives in KV for
// SESSION_TTL_S. Only ~CLIP_S seconds of each source file is ever fetched.

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const CLIP_S         = 10;
const MAX_CLIPS      = 360;        // one hour of clips per session
const MAX_INPUT      = 5000;
const SESSION_TTL_S  = 12 * 3600;
const SEGMENT_TRIES  = 3;          // a broken source is swapped for another clip
const DRIVE_API      = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';
const FFMPEG         = process.env.FFMPEG_PATH || 'ffmpeg';
const SID_RE         = /^[\w-]{40,64}$/;
const MODES          = new Set(['original', 'auto', '2160', '1440', '1080']);

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age':       '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function driveUrl(id) {
  return `${DRIVE_API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
}

// Where in a video to cut: somewhere in the middle 80%, so intros/outros are
// skipped. Unknown durations get an early-ish guess; a cut past the end just
// fails and gets replaced by another clip.
function pickStart(durationMs) {
  const d = durationMs / 1000;
  if (!(d > 0)) return 20 + Math.random() * 100;
  if (d < CLIP_S * 3) return 0;
  const lo = d * 0.1, hi = d * 0.9 - CLIP_S;
  return lo + Math.random() * Math.max(0, hi - lo);
}

// Smooth-mode output height. Videos are classed by their short side, so a
// portrait 1080x1920 counts as 1080p. Auto takes the highest class that at
// least half the (known) clips reach - a few 4K videos in a mostly-1080p
// view don't make the whole compilation 4K.
function classOf(w, h) {
  const short = Math.min(w, h);
  return short >= 2000 ? 2160 : short >= 1300 ? 1440 : 1080;
}

function pickHeight(mode, pool) {
  if (mode !== 'auto') return Number(mode);
  const known = pool.filter(c => c.w > 0 && c.h > 0).map(c => classOf(c.w, c.h));
  for (const h of [2160, 1440]) {
    if (known.length && known.filter(k => k >= h).length * 2 >= known.length) return h;
  }
  return 1080;
}

async function createSession(req) {
  if (!(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);
  let body;
  try {
    body = await req.json();
  } catch (err) {
    return json({ error: 'bad json' }, 400);
  }
  const { clips } = body;
  const mode = MODES.has(body.mode) ? body.mode : 'original';
  if (!Array.isArray(clips) || !clips.length || clips.length > MAX_INPUT) {
    return json({ error: 'bad clips' }, 400);
  }

  // Dedupe, validate, shuffle, cap.
  const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
  const seen = new Set();
  const pool = [];
  for (const c of clips) {
    if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    pool.push({ id: c.id, d: num(c.d), w: num(c.w), h: num(c.h) });
  }
  if (!pool.length) return json({ error: 'bad clips' }, 400);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, MAX_CLIPS);
  const session = {
    mode:   mode === 'original' ? 'original' : 'smooth',
    height: mode === 'original' ? null : pickHeight(mode, picked),
    clips:  picked.map(c => ({ id: c.id, s: Math.round(pickStart(c.d) * 10) / 10 })),
  };

  const sid = b64url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  await kvCommand(['SET', `rvp:comp:${sid}`, JSON.stringify(session), 'EX', SESSION_TTL_S]);
  sessions.set(sid, session);

  const base = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || base.protocol.replace(':', '');
  return json({
    url:    `${proto}://${base.host}/api/compile/playlist.m3u8?s=${sid}`,
    clips:  session.clips.length,
    mode:   session.mode,
    height: session.height,
  });
}

// Sessions are read on every segment request; keep recent ones in memory.
const sessions = new Map();
async function loadSession(sid) {
  if (!sid || !SID_RE.test(sid)) return null;
  if (sessions.has(sid)) return sessions.get(sid);
  const raw = await kvCommand(['GET', `rvp:comp:${sid}`]);
  if (!raw) return null;
  let session = JSON.parse(raw);
  if (Array.isArray(session)) session = { mode: 'original', height: null, clips: session }; // pre-modes format
  if (sessions.size > 20) sessions.delete(sessions.keys().next().value);
  sessions.set(sid, session);
  return session;
}

function playlist(sid, session) {
  const smooth = session.mode === 'smooth';
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    // Stream copy starts each cut on the keyframe before the chosen point,
    // so original-mode segments can run a few seconds over CLIP_S.
    `#EXT-X-TARGETDURATION:${smooth ? CLIP_S : CLIP_S * 2}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  session.clips.forEach((_, n) => {
    if (!smooth) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${CLIP_S}.000,`, `seg.ts?s=${sid}&n=${n}`);
  });
  lines.push('#EXT-X-ENDLIST', '');
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
  });
}

// The clip at n first, then a couple of random others from the session to
// fall back on if its source won't cut.
function fallbackOrder(clips, n) {
  const order = [n];
  while (order.length < SEGMENT_TRIES && order.length < clips.length) {
    const alt = Math.floor(Math.random() * clips.length);
    if (!order.includes(alt)) order.push(alt);
  }
  return order;
}

// ─── ORIGINAL MODE ────────────────────────────────────────────────────────────
// Video codecs that stream-copy cleanly into MPEG-TS as-is. MPEG-4 Part 2
// (older DivX/Xvid-style files) also works but needs its headers repeated
// in-band (dump_extra) - a filter that would corrupt H.264/HEVC, so it is
// only applied once ffmpeg reports that codec. Anything else (VP9, AV1...)
// is skipped in favour of another clip.
const COPY_OK  = new Set(['h264', 'hevc']);
const NEEDS_DX = new Set(['mpeg4']);

// Runs ffmpeg for one clip. Resolves once ffmpeg has reported the source
// codec and started writing, with the bytes so far, the rest of stdout and
// the codec; rejects if it exits without output (unreadable file, cut past
// the end, codec the TS muxer refuses).
function cutClip(clip, token, signal, dumpExtra) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, [
      '-hide_banner', '-nostats', '-loglevel', 'info',
      '-headers', `Authorization: Bearer ${token}\r\n`,
      '-ss', String(clip.s),
      '-i', `${DRIVE_API}/drive/v3/files/${encodeURIComponent(clip.id)}?alt=media`,
      '-t', String(CLIP_S),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      ...(dumpExtra ? ['-bsf:v', 'dump_extra'] : []),
      '-f', 'mpegts',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let settled = false;
    const early = [];
    const kill = () => ff.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });

    // stdout and stderr are separate pipes, so hold output until stderr has
    // shown the input streams and the "Output #0" header.
    const trySettle = () => {
      if (settled || !early.length || !/Output #0/.test(stderr)) return;
      settled = true;
      ff.stdout.pause();
      const codec = (/Stream #0:\d+[^:]*: Video: (\w+)/.exec(stderr) || [])[1] || 'unknown';
      resolve({ chunks: early, rest: ff.stdout, kill, codec });
    };
    ff.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; trySettle(); });
    ff.stdout.on('data', chunk => { if (!settled) { early.push(chunk); trySettle(); } });
    ff.on('close', code => {
      signal?.removeEventListener('abort', kill);
      if (!settled) {
        settled = true;
        const why = stderr.split('\n').filter(l => /error|invalid/i.test(l)).slice(-3).join(' | ');
        reject(new Error(`ffmpeg exit ${code}: ${why.slice(0, 300)}`));
      }
    });
    ff.on('error', err => { if (!settled) { settled = true; reject(err); } });
  });
}

async function openClip(clip, token, signal) {
  let cut = await cutClip(clip, token, signal, false);
  if (COPY_OK.has(cut.codec)) return cut;
  cut.kill();
  if (NEEDS_DX.has(cut.codec)) {
    cut = await cutClip(clip, token, signal, true);
    if (cut.codec !== 'unknown') return cut;
    cut.kill();
  }
  throw new Error(`unsupported codec ${cut.codec}`);
}

async function originalSegment(clips, n, signal) {
  const token = await getServiceAccountToken();
  // Try the clip at n; if its source won't cut, fall back to other clips
  // from the same session so playback keeps going.
  for (const i of fallbackOrder(clips, n)) {
    try {
      const { chunks, rest, kill } = await openClip(clips[i], token, signal);
      // Once the viewer disconnects (VLC seeks or closes) the stream is
      // cancelled; ffmpeg's remaining output must not touch it after that.
      let open = true;
      const body = new ReadableStream({
        start(ctrl) {
          for (const c of chunks) ctrl.enqueue(new Uint8Array(c));
          rest.on('data', c => { if (open) ctrl.enqueue(new Uint8Array(c)); });
          rest.on('end', () => { if (open) { open = false; ctrl.close(); } });
          rest.on('error', err => { if (open) { open = false; ctrl.error(err); } });
          rest.resume();
        },
        cancel() { open = false; kill(); },
      });
      return new Response(body, { headers: { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' } });
    } catch (err) {
      if (signal?.aborted) break;
      console.log(`compile clip ${i} failed: ${err.message}`);
    }
  }
  return new Response('clip unavailable', { status: 502 });
}

// ─── SMOOTH MODE ──────────────────────────────────────────────────────────────
const SMOOTH_FPS     = 30;
const MIN_SEGMENT_B  = 128 * 1024; // less than this from an encode = it failed
const audioCache     = new Map();  // file id -> has an audio stream

// Whether a file has audio, from ffmpeg's stream listing (reads only the
// container header). Clips without audio get silence instead, so every
// segment has the same tracks.
function probeAudio(id, token) {
  if (audioCache.has(id)) return Promise.resolve(audioCache.get(id));
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ['-hide_banner', '-headers', `Authorization: Bearer ${token}\r\n`, '-i', driveUrl(id)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
    ff.on('error', reject);
    ff.on('close', () => {
      if (!/Stream #0:\d+[^:]*: Video:/.test(stderr)) return reject(new Error('no video stream'));
      const hasAudio = /Stream #0:\d+[^:]*: Audio:/.test(stderr);
      if (audioCache.size > 500) audioCache.delete(audioCache.keys().next().value);
      audioCache.set(id, hasAudio);
      resolve(hasAudio);
    });
  });
}

function smoothArgs(clip, n, height, token, hasAudio) {
  const width = Math.round(height * 16 / 9);
  // Fit inside the frame (letterbox/pillarbox, never crop), fixed fps, and
  // pad short sources with their last frame / silence so every segment is
  // exactly CLIP_S long.
  const video = `[0:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${SMOOTH_FPS},`
    + `format=yuv420p,tpad=stop_mode=clone:stop_duration=${CLIP_S}[v]`;
  const audio = `[${hasAudio ? '0:a:0' : '1:a'}]aresample=48000,aformat=channel_layouts=stereo,apad[a]`;
  return [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    '-headers', `Authorization: Bearer ${token}\r\n`,
    '-ss', String(clip.s),
    '-i', driveUrl(clip.id),
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
    '-filter_complex', `${video};${audio}`,
    '-map', '[v]', '-map', '[a]',
    '-t', String(CLIP_S),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high',
    '-g', String(SMOOTH_FPS * 2),
    '-c:a', 'aac', '-b:a', '160k',
    // Segment n sits at n*CLIP_S on one shared timeline - no discontinuities.
    '-output_ts_offset', String(n * CLIP_S),
    '-f', 'mpegts',
    'pipe:1',
  ];
}

// One encode job per segment, shared between the request that wants it and
// the encode-ahead that started it early. Output is kept in memory (a 10s
// segment is ~10-35 MB) so a request arriving mid-encode gets what's done so
// far and then the rest as it comes.
const jobs = new Map(); // `${sid}:${n}` -> job

function startJob(sid, session, n) {
  const key = `${sid}:${n}`;
  if (jobs.has(key)) return jobs.get(key);
  const job = { chunks: [], done: false, failed: false, listeners: new Set(), kill: () => {} };
  jobs.set(key, job);
  const emit = () => job.listeners.forEach(fn => fn());

  (async () => {
    const token = await getServiceAccountToken();
    for (const i of fallbackOrder(session.clips, n)) {
      if (job.cancelled) break;
      const clip = session.clips[i];
      try {
        const hasAudio = await probeAudio(clip.id, token);
        const ok = await new Promise(resolve => {
          const ff = spawn(FFMPEG, smoothArgs(clip, n, session.height, token, hasAudio),
            { stdio: ['ignore', 'pipe', 'pipe'] });
          job.kill = () => ff.kill('SIGKILL');
          let stderr = '';
          let size = 0;
          const pending = [];
          let released = false;
          ff.stderr.on('data', d => { if (stderr.length < 4000) stderr += d; });
          ff.stdout.on('data', c => {
            size += c.length;
            // Hold output back until it's clearly a real encode, so a failed
            // source can still be swapped without the viewer seeing it.
            if (released) { job.chunks.push(c); emit(); return; }
            pending.push(c);
            if (size >= MIN_SEGMENT_B) { released = true; job.chunks.push(...pending); emit(); }
          });
          ff.on('error', () => resolve(false));
          ff.on('close', code => {
            if (!released && code === 0 && size > 0) { released = true; job.chunks.push(...pending); }
            if (!released) console.log(`compile smooth clip ${i} failed: exit ${code} ${stderr.trim().slice(0, 200)}`);
            resolve(released);
          });
        });
        if (ok) { job.done = true; emit(); return; }
      } catch (err) {
        console.log(`compile smooth clip ${i} failed: ${err.message}`);
      }
    }
    job.failed = true;
    job.done = true;
    emit();
  })().catch(err => {
    console.log(`compile smooth job failed: ${err.message}`);
    job.failed = true;
    job.done = true;
    emit();
  });
  return job;
}

// Keep only jobs near where this viewer is now; a seek abandons the rest.
function pruneJobs(sid, n) {
  for (const [key, job] of jobs) {
    const [jsid, jn] = key.split(':');
    const stale = jsid === sid ? (Number(jn) < n - 1 || Number(jn) > n + 1) : jobs.size > 8;
    if (stale) {
      job.cancelled = true;
      if (!job.done) job.kill();
      jobs.delete(key);
    }
  }
}

function smoothSegment(sid, session, n) {
  pruneJobs(sid, n);
  const job = startJob(sid, session, n);
  if (n + 1 < session.clips.length) startJob(sid, session, n + 1); // encode ahead

  return new Promise(resolve => {
    let answered = false;
    const answer = () => {
      if (answered) return;
      if (job.failed) {
        answered = true;
        job.listeners.delete(answer);
        return resolve(new Response('clip unavailable', { status: 502 }));
      }
      if (!job.chunks.length) return;
      answered = true;
      job.listeners.delete(answer);
      let sent = 0;
      let open = true;
      let listener = null;
      const body = new ReadableStream({
        start(ctrl) {
          listener = () => {
            if (!open) return;
            while (sent < job.chunks.length) ctrl.enqueue(new Uint8Array(job.chunks[sent++]));
            if (job.done) { open = false; job.listeners.delete(listener); ctrl.close(); }
          };
          job.listeners.add(listener);
          listener();
        },
        // The encode keeps going if the viewer drops: a retry or the next
        // request can still use it, and pruneJobs bounds what's kept.
        cancel() { open = false; job.listeners.delete(listener); },
      });
      resolve(new Response(body, { headers: { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store' } }));
    };
    job.listeners.add(answer);
    answer();
  });
}

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === '/api/compile') {
    const origin = req.headers.get('origin');
    if (origin && origin !== ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return createSession(req);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
  const sid = url.searchParams.get('s');
  let session;
  try {
    session = await loadSession(sid);
  } catch (err) {
    return new Response('session store unavailable', { status: 503 });
  }
  if (!session) return new Response('compilation expired', { status: 404 });

  if (path === '/api/compile/playlist.m3u8') return playlist(sid, session);
  if (path === '/api/compile/seg.ts') {
    const n = Number(url.searchParams.get('n'));
    if (!Number.isInteger(n) || n < 0 || n >= session.clips.length) return new Response('bad segment', { status: 400 });
    if (req.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'video/mp2t' } });
    return session.mode === 'smooth'
      ? smoothSegment(sid, session, n)
      : originalSegment(session.clips, n, req.signal);
  }
  return new Response('not found', { status: 404 });
}
