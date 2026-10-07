import { spawn } from 'node:child_process';
import { getServiceAccountToken, kvCommand, b64url } from './_lib/serviceAccount.js';
import { isAuthorized, ID_RE } from './_lib/auth.js';

// Compilation mode: random ~10s clips from many videos, played back to back
// in VLC as one HLS stream.
//
//   POST /api/compile               {clips: [{id, d}]}  -> {url}   (owner only)
//   GET  /api/compile/playlist.m3u8?s=SESSION
//   GET  /api/compile/seg.ts?s=SESSION&n=INDEX
//
// The session id is a long random token, so knowing it is what grants access
// to the playlist and segments (VLC can't send headers); it lives in KV for
// SESSION_TTL_S. Each segment is cut on request by ffmpeg straight from
// Drive with stream copy (no re-encode), so only ~10s of each source file is
// ever fetched and CPU cost stays small. A discontinuity tag before every
// segment lets VLC handle clips with different codecs/resolutions.

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const CLIP_S         = 10;
const MAX_CLIPS      = 360;        // one hour of clips per session
const MAX_INPUT      = 5000;
const SESSION_TTL_S  = 12 * 3600;
const SEGMENT_TRIES  = 3;          // a broken source is swapped for another clip
const DRIVE_API      = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';
const FFMPEG         = process.env.FFMPEG_PATH || 'ffmpeg';
const SID_RE         = /^[\w-]{40,64}$/;

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

async function createSession(req) {
  if (!(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);
  let clips;
  try {
    clips = (await req.json()).clips;
  } catch (err) {
    return json({ error: 'bad json' }, 400);
  }
  if (!Array.isArray(clips) || !clips.length || clips.length > MAX_INPUT) {
    return json({ error: 'bad clips' }, 400);
  }

  // Dedupe, validate, shuffle, cap.
  const seen = new Set();
  const pool = [];
  for (const c of clips) {
    if (!c || typeof c.id !== 'string' || !ID_RE.test(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    pool.push({ id: c.id, d: Number.isFinite(c.d) ? c.d : 0 });
  }
  if (!pool.length) return json({ error: 'bad clips' }, 400);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const session = pool.slice(0, MAX_CLIPS).map(c => ({ id: c.id, s: Math.round(pickStart(c.d) * 10) / 10 }));

  const sid = b64url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  await kvCommand(['SET', `rvp:comp:${sid}`, JSON.stringify(session), 'EX', SESSION_TTL_S]);
  sessions.set(sid, session);

  const base = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || base.protocol.replace(':', '');
  return json({ url: `${proto}://${base.host}/api/compile/playlist.m3u8?s=${sid}`, clips: session.length });
}

// Sessions are read on every segment request; keep recent ones in memory.
const sessions = new Map();
async function loadSession(sid) {
  if (!sid || !SID_RE.test(sid)) return null;
  if (sessions.has(sid)) return sessions.get(sid);
  const raw = await kvCommand(['GET', `rvp:comp:${sid}`]);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (sessions.size > 20) sessions.delete(sessions.keys().next().value);
  sessions.set(sid, session);
  return session;
}

function playlist(sid, session) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    // Stream copy starts each cut on the keyframe before the chosen point,
    // so segments can run a few seconds over CLIP_S.
    `#EXT-X-TARGETDURATION:${CLIP_S * 2}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  session.forEach((_, n) => {
    lines.push('#EXT-X-DISCONTINUITY', `#EXTINF:${CLIP_S}.0,`, `seg.ts?s=${sid}&n=${n}`);
  });
  lines.push('#EXT-X-ENDLIST', '');
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
  });
}

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

async function segment(session, n, signal) {
  const token = await getServiceAccountToken();
  // Try the clip at n; if its source won't cut, fall back to other clips
  // from the same session so playback keeps going.
  const order = [n];
  while (order.length < SEGMENT_TRIES && order.length < session.length) {
    const alt = Math.floor(Math.random() * session.length);
    if (!order.includes(alt)) order.push(alt);
  }
  for (const i of order) {
    try {
      const { chunks, rest, kill } = await openClip(session[i], token, signal);
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
    if (!Number.isInteger(n) || n < 0 || n >= session.length) return new Response('bad segment', { status: 400 });
    if (req.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'video/mp2t' } });
    return segment(session, n, req.signal);
  }
  return new Response('not found', { status: 404 });
}
