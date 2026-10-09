import { spawn } from 'node:child_process';
import { getServiceAccountToken, kvCommand, b64url } from './_lib/serviceAccount.js';
import { isAuthorized, ID_RE } from './_lib/auth.js';
import { FFMPEG, probeInfo, inputStreams } from './_lib/media.js';
import { sourceUrl, pieceArgs, driveBytesRead } from './_lib/driveSource.js';

// Compilation mode: random ~10s clips from many videos, played back to back
// in VLC as one HLS stream.
//
//   POST /api/compile   {clips: [{id, d, w, h}], mode, res, fps, pick, len}  -> {url}   (owner only)
//   GET  /api/compile/playlist.m3u8?s=SESSION
//   GET  /api/compile/seg.ts?s=SESSION&n=INDEX
//
// Two modes:
// - original: each clip is cut with stream copy - untouched quality, almost
//   no CPU - but clips keep their own codec/resolution/timing, so a
//   discontinuity tag sits between them and VLC visibly resets at each one.
// - smooth: each clip is re-encoded to one format for the whole compilation
//   (same resolution and frame rate, H.264 + AAC stereo) and to exactly
//   its clip length on one continuous timeline, so playback runs straight
//   through and seeking lines up. Resolution and frame rate are fixed per
//   compilation, each chosen or Auto (what most of its clips are; see
//   pickHeight / pickFps). While one clip is served, the next ones are
//   already encoding.
//
// The session id is a long random token, so knowing it is what grants access
// to the playlist and segments (VLC can't send headers); it lives in KV for
// SESSION_TTL_S. Only a clip's worth of each source file is ever fetched.
//
// Clip length (len): a fixed 5/10/15/20 s, or 'auto' - with highlights,
// each clip lasts about as long as the busy stretch it was cut from
// (AUTO_MIN_S..AUTO_MAX_S); without, CLIP_S. Each clip stores its length
// (l) and its start on the compilation timeline (o).

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const CLIP_S         = 10;   // default clip length
const LEN_OPTIONS    = new Set(['auto', '5', '10', '15', '20']);
const AUTO_MIN_S     = 6;
const AUTO_MAX_S     = 20;
const AUTO_PAD_S     = 6;    // a burst's measured length + this = its clip
const MAX_CLIPS      = 360;        // one hour of clips per session
const MAX_INPUT      = 5000;
const SESSION_TTL_S  = 12 * 3600;
const SEGMENT_TRIES  = 3;          // a broken source is swapped for another clip
const SID_RE         = /^[\w-]{40,64}$/;
const RES_OPTIONS    = new Set(['auto', '2160', '1440', '1080']);
const FPS_OPTIONS    = new Set(['auto', '60', '30']);
// Smooth frame: 'fit' letterboxes every clip into one 16:9 frame (seamless
// everywhere); 'native' keeps each clip's own shape, scaled so its short side
// is the chosen height - the stream then changes shape between clips, which
// VLC follows with a brief black frame.
const FRAME_OPTIONS  = new Set(['fit', 'native']);

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
function pickStart(durationMs, len = CLIP_S) {
  const d = durationMs / 1000;
  if (!(d > 0)) return 20 + Math.random() * 100;
  if (d < len * 3) return 0;
  const lo = d * 0.1, hi = d * 0.9 - len;
  return lo + Math.random() * Math.max(0, hi - lo);
}

// pick: 'highlights' cuts around a video's analysed peaks (api/analyze.js),
// choosing randomly among its best few so repeat compilations still vary;
// videos not analysed yet fall back to pickStart.
const PEAKS_KEY = 'rvp:peaks';
const PEAK_CHOICES = 3;
const PEAK_LEAD_S = 3; // start a little before the measured moment
const PEAK_SCORE_SPREAD = 0.25;

// -> { t, from, extent } for one of the video's best moments, or null:
// the peak's time, where its busy stretch starts (newer analyses only) and
// how long the stretch lasts.
function highlightPick(raw) {
  try {
    // Best first; only moments close to the video's best are candidates, so
    // an uneventful video's middling "peaks" aren't treated as highlights.
    const all = JSON.parse(raw).peaks || [];
    if (!all.length) return null;
    const peaks = all.filter(p => p[1] >= all[0][1] - PEAK_SCORE_SPREAD).slice(0, PEAK_CHOICES);
    const [t, , extent, from] = peaks[Math.floor(Math.random() * peaks.length)];
    return { t, from, extent: extent || 0 };
  } catch (err) {
    return null;
  }
}

// Where a highlight clip of `len` seconds starts: at the start of the busy
// stretch (a second early), so a sustained scene opens at its beginning -
// but never so early that the peak falls outside the clip (a long stretch
// with a short fixed length). Older analyses without `from` lead the peak
// by PEAK_LEAD_S.
function highlightStart(pick, len) {
  if (pick.from === undefined) return Math.max(0, pick.t - PEAK_LEAD_S);
  return Math.max(0, pick.from - 1, pick.t - (len - 2));
}

function clipLength(lenChoice, pick) {
  if (lenChoice !== 'auto') return Number(lenChoice);
  if (!pick) return CLIP_S;
  return Math.min(AUTO_MAX_S, Math.max(AUTO_MIN_S, Math.round(pick.extent + AUTO_PAD_S)));
}

// Smooth-mode output height. Videos are classed by their short side, so a
// portrait 1080x1920 counts as 1080p. Auto takes the highest class that at
// least half the (known) clips reach - a few 4K videos in a mostly-1080p
// view don't make the whole compilation 4K.
function classOf(w, h) {
  const short = Math.min(w, h);
  return short >= 2000 ? 2160 : short >= 1300 ? 1440 : 1080;
}

function pickHeight(res, pool) {
  if (res !== 'auto') return Number(res);
  const known = pool.filter(c => c.w > 0 && c.h > 0).map(c => classOf(c.w, c.h));
  for (const h of [2160, 1440]) {
    if (known.length && known.filter(k => k >= h).length * 2 >= known.length) return h;
  }
  return 1080;
}

// Smooth-mode frame rate. Drive doesn't report it, so Auto reads it from the
// first clips that will play (container header only) and uses 60 when at
// least half of those are 50 fps or more. 4K stays at 30 under Auto - 4K60
// is far more than the compile service can encode in real time.
const FPS_SAMPLE = 6;
async function pickFps(fps, height, picked, media) {
  if (fps !== 'auto') return Number(fps);
  if (height >= 2160) return 30;
  const token = await getServiceAccountToken();
  const rates = (await Promise.all(picked.slice(0, FPS_SAMPLE).map((c, i) => media[i]?.fps
    || probeInfo(c.id, token, 'compile', undefined, PIECE_UNITS > 0).then(info => info.fps, () => 0)))).filter(r => r > 0);
  return rates.length && rates.filter(r => r >= 47).length * 2 >= rates.length ? 60 : 30;
}

// What the header check (api/analyze.js) recorded for each clip's file:
// { a: 1/0 audio, vc: video codec, fps }, or null when it hasn't checked it
// or couldn't read it.
const MEDIA_KEY = 'rvp:media';
async function storedMedia(picked) {
  const raw = await kvCommand(['HMGET', MEDIA_KEY, ...picked.map(c => c.id)]).catch(() => []);
  return picked.map((c, i) => {
    try {
      const r = JSON.parse((raw || [])[i]);
      return r.vc ? { a: r.ac ? 1 : 0, vc: r.vc, fps: r.fps || 0 } : null;
    } catch (err) {
      return null;
    }
  });
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
  // Older clients sent the resolution as the mode ('auto', '1080', ...).
  const legacyRes = RES_OPTIONS.has(body.mode);
  const smooth    = body.mode === 'smooth' || legacyRes;
  const res       = RES_OPTIONS.has(body.res) ? body.res : legacyRes ? body.mode : 'auto';
  const fpsChoice = FPS_OPTIONS.has(body.fps) ? body.fps : 'auto';
  const frame     = FRAME_OPTIONS.has(body.frame) ? body.frame : 'fit';
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
  const pick = body.pick === 'highlights' ? 'highlights' : 'random';
  const lenChoice = LEN_OPTIONS.has(String(body.len)) ? String(body.len) : 'auto';
  const starts = picked.map(() => null);
  if (pick === 'highlights') {
    const raw = await kvCommand(['HMGET', PEAKS_KEY, ...picked.map(c => c.id)]).catch(() => []);
    (raw || []).forEach((r, i) => { if (r) starts[i] = highlightPick(r); });
  }
  const height = smooth ? pickHeight(res, picked) : null;
  const media = smooth ? await storedMedia(picked) : [];
  const session = {
    mode:  smooth ? 'smooth' : 'original',
    height,
    fps:   smooth ? await pickFps(fpsChoice, height, picked, media) : null,
    ...(smooth && frame === 'native' ? { frame } : {}),
    clips: timeline(picked.map((c, i) => {
      const l = clipLength(lenChoice, starts[i]);
      const s = starts[i] ? highlightStart(starts[i], l) : pickStart(c.d, l);
      // a / vc: audio and video codec from the header check, so the encode
      // needn't read the header first to find out (see runJob).
      const m = media[i];
      return { id: c.id, s: Math.round(s * 10) / 10, l, ...(m ? { a: m.a, vc: m.vc } : {}) };
    })),
  };

  const sid = b64url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  await kvCommand(['SET', `rvp:comp:${sid}`, JSON.stringify(session), 'EX', SESSION_TTL_S]);
  sessions.set(sid, session);
  if (session.mode === 'smooth' && session.height >= WARM_START_HEIGHT) await warmStart(sid, session);

  const base = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || base.protocol.replace(':', '');
  return json({
    url:    `${proto}://${base.host}/api/compile/playlist.m3u8?s=${sid}`,
    clips:  session.clips.length,
    mode:   session.mode,
    height: session.height,
    fps:    session.fps,
    frame:  session.frame || (session.mode === 'smooth' ? 'fit' : null),
    pick,
    highlights: starts.filter(s => s !== null).length,
    len:        lenChoice,
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

// Places clips back to back: o = where each starts on the compilation's
// timeline (smooth mode offsets each segment's timestamps by it).
function timeline(clips) {
  let o = 0;
  return clips.map(c => { const placed = { ...c, o }; o += c.l; return placed; });
}

// Older sessions stored neither length nor offset.
const lenOf    = (session, n) => session.clips[n].l || CLIP_S;
const offsetOf = (session, n) => (session.clips[n].o ?? n * CLIP_S);

function playlist(sid, session) {
  const smooth = session.mode === 'smooth';
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    // Stream copy starts each cut on the keyframe before the chosen point,
    // so original-mode segments can run a few seconds over their length.
    `#EXT-X-TARGETDURATION:${Math.max(...session.clips.map((_, n) => lenOf(session, n))) * (smooth ? 1 : 2)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  session.clips.forEach((_, n) => {
    if (!smooth) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${lenOf(session, n)}.000,`, `seg.ts?s=${sid}&n=${n}`);
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
function cutClip(clip, len, token, signal, dumpExtra) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, [
      '-hide_banner', '-nostats', '-loglevel', 'info',
      '-ss', String(clip.s),
      '-i', sourceUrl(clip.id, 'compile'),
      '-t', String(len),
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

async function openClip(clip, len, token, signal) {
  let cut = await cutClip(clip, len, token, signal, false);
  if (COPY_OK.has(cut.codec)) return cut;
  cut.kill();
  if (NEEDS_DX.has(cut.codec)) {
    cut = await cutClip(clip, len, token, signal, true);
    if (cut.codec !== 'unknown') return cut;
    cut.kill();
  }
  throw new Error(`unsupported codec ${cut.codec}`);
}

async function originalSegment(session, n, signal) {
  const { clips } = session;
  const token = await getServiceAccountToken();
  // Try the clip at n; if its source won't cut, fall back to other clips
  // from the same session so playback keeps going.
  for (const i of fallbackOrder(clips, n)) {
    try {
      // A stand-in clip plays for this slot's length.
      const { chunks, rest, kill } = await openClip(clips[i], lenOf(session, n), token, signal);
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
const MIN_SEGMENT_B  = 128 * 1024; // less than this from an encode = it failed
// Encoder speed/size by workload (pixels per second). veryfast keeps
// 1080p30 well ahead of real time; heavier outputs use faster presets so
// the encode keeps up, at the cost of more bits - capped by maxrate so
// data use stays bounded.
const MAXRATE_MBPS = { 1080: 12, 1440: 20, 2160: 35 };
function encoderFor(height, fps) {
  const pixelRate = Math.round(height * 16 / 9) * height * fps;
  const preset = pixelRate <= 130e6 ? 'veryfast' : pixelRate <= 260e6 ? 'superfast' : 'ultrafast';
  const maxrate = Math.round((MAXRATE_MBPS[height] || 12) * (fps > 30 ? 1.5 : 1));
  return ['-preset', preset, '-crf', '20', '-maxrate', `${maxrate}M`, '-bufsize', `${maxrate * 2}M`];
}

// Smooth encodes read Drive in pieces (see driveSource.js) of up to
// PIECE_UNITS x 256 KB - more when Drive is slow to answer - so little
// more than the clip itself is fetched: ~3x less than plain pass-through.
// COMPILE_PIECES=0 goes back to pass-through.
const PIECE_UNITS = process.env.COMPILE_PIECES === '0' ? 0 : 8;

// source = the clip whose video is cut (a stand-in if clip n's source
// failed); n = the timeline slot it fills, which sets length and offset.
function smoothArgs(source, n, session, token, hasAudio) {
  const { height } = session;
  const len = lenOf(session, n);
  const fps = session.fps || 30;
  const width = Math.round(height * 16 / 9);
  // Fit inside the frame (letterbox/pillarbox, never crop), fixed fps, and
  // pad short sources with their last frame / silence so every segment is
  // exactly its slot's length.
  const shape = session.frame === 'native'
    // Own shape, short side = height (even dimensions).
    ? `scale=w='if(gte(iw\\,ih)\\,-2\\,${height})':h='if(gte(iw\\,ih)\\,${height}\\,-2)',`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,`;
  const video = `[0:v:0]${shape}setsar=1,fps=${fps},`
    + `format=yuv420p,tpad=stop_mode=clone:stop_duration=${len}[v]`;
  const audio = `[${hasAudio ? '0:a:0' : '1:a'}]aresample=48000,aformat=channel_layouts=stereo,apad[a]`;
  return [
    // info: the input listing shows what the file really holds (runJob).
    '-hide_banner', '-nostats', '-loglevel', 'info',
    ...(PIECE_UNITS ? pieceArgs() : []),
    '-ss', String(source.s),
    '-i', sourceUrl(source.id, 'compile', { pieces: PIECE_UNITS }),
    ...(hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
    '-filter_complex', `${video};${audio}`,
    '-map', '[v]', '-map', '[a]',
    '-t', String(len),
    '-c:v', 'libx264', ...encoderFor(height, fps), '-profile:v', 'high',
    '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '160k',
    // Segment n sits at its offset on one shared timeline - no discontinuities.
    '-output_ts_offset', String(offsetOf(session, n)),
    '-f', 'mpegts',
    'pipe:1',
  ];
}

// One encode job per segment, shared between the request that wants it and
// the encode-ahead that started it early. Output is kept in memory (a 10s
// segment is ~10-35 MB) so a request arriving mid-encode gets what's done so
// far and then the rest as it comes.
const jobs = new Map(); // `${sid}:${n}` -> job
const ENCODE_AHEAD = 2;
// VLC holds only a few clips of buffer, so a source that is slow to start
// producing output is swapped for another clip rather than freezing
// playback. While a segment is still being encoded ahead it gets
// FIRST_OUTPUT_S (sparse keyframes or a slow Drive read can make a fine
// clip start slowly); once VLC is actually waiting for it, only
// WAITING_GRACE_S more - a short pause instead of a long one.
const FIRST_OUTPUT_S  = { 1080: 20, 1440: 30, 2160: 45 };
const WAITING_GRACE_S = { 1080: 5, 1440: 7, 2160: 10 };
// Video formats too slow to decode in software for a live compilation
// (seen: a 4K AV1 clip took 99 s for 5 s of output). Skipped as soon as
// the header shows them.
const SLOW_CODECS = new Set(['av1', 'prores']);

// How long sources take to start producing output, logged every few
// minutes, to tune the limits above from real numbers.
const START_REPORT_MS = 5 * 60e3;
let startTimes = [];
let startSwaps = 0;
let startReportTimer = null;
let startReportBytes = 0;
function noteStart(seconds, swapped) {
  if (swapped) startSwaps++; else startTimes.push(seconds);
  if (startReportTimer) return;
  startReportTimer = setTimeout(() => {
    startReportTimer = null;
    const t = startTimes.sort((a, b) => a - b);
    const at = q => t[Math.min(t.length - 1, Math.floor(q * t.length))].toFixed(1);
    const bytes = driveBytesRead('compile');
    const mbPerClip = (bytes - startReportBytes) / 1e6 / Math.max(1, t.length + startSwaps);
    startReportBytes = bytes;
    console.log(`smooth start times (${START_REPORT_MS / 60e3} min): ${t.length} clips`
      + (t.length ? `, median ${at(0.5)} s, 90% ${at(0.9)} s, max ${t[t.length - 1].toFixed(1)} s` : '')
      + `, ${startSwaps} swapped for being slow, Drive ${mbPerClip.toFixed(1)} MB per clip${PIECE_UNITS ? '' : ' (pieces off)'}`);
    startTimes = [];
    startSwaps = 0;
  }, START_REPORT_MS);
  startReportTimer.unref?.();
}

// At most two encodes run at once so they don't starve each other; the
// segment VLC is waiting for jumps the queue ahead of encode-ahead work.
const MAX_PARALLEL_ENCODES = 2;
let encodesRunning = 0;
const encodeWaiters = []; // resolve fns, front = next to run

function acquireEncodeSlot(job, urgent) {
  return new Promise(resolve => {
    if (encodesRunning < MAX_PARALLEL_ENCODES) { encodesRunning++; resolve(true); return; }
    job.waiter = resolve;
    if (urgent) encodeWaiters.unshift(resolve); else encodeWaiters.push(resolve);
  });
}
function releaseEncodeSlot() {
  const next = encodeWaiters.shift();
  if (next) next(true); else encodesRunning--;
}
function promoteWaiter(job) {
  const i = encodeWaiters.indexOf(job.waiter);
  if (i > 0) { encodeWaiters.splice(i, 1); encodeWaiters.unshift(job.waiter); }
}
function dropWaiter(job) {
  const i = encodeWaiters.indexOf(job.waiter);
  if (i >= 0) { encodeWaiters.splice(i, 1); job.waiter(false); }
}

function startJob(sid, session, n, urgent) {
  const key = `${sid}:${n}`;
  if (jobs.has(key)) {
    const existing = jobs.get(key);
    if (urgent) promoteWaiter(existing);
    return existing;
  }
  const job = { chunks: [], done: false, failed: false, listeners: new Set(), kill: () => {}, waiter: null, waitingSince: null };
  jobs.set(key, job);
  const emit = () => job.listeners.forEach(fn => fn());

  (async () => {
    const got = await acquireEncodeSlot(job, urgent);
    job.waiter = null;
    if (!got) throw new Error('cancelled before start');
    try {
      await runJob(job, session, n, emit);
    } finally {
      releaseEncodeSlot();
    }
  })().catch(err => {
    if (!job.cancelled) console.log(`compile smooth job failed: ${err.message}`);
    job.failed = true;
    job.done = true;
    emit();
  });
  return job;
}

async function runJob(job, session, n, emit) {
  const token = await getServiceAccountToken();
  const limitS = FIRST_OUTPUT_S[session.height] || FIRST_OUTPUT_S[1080];
  const graceS = WAITING_GRACE_S[session.height] || WAITING_GRACE_S[1080];
  for (const i of fallbackOrder(session.clips, n)) {
    if (job.cancelled) break;
    const clip = session.clips[i];
    const label = `${clip.id.slice(0, 6)}… at ${clip.s} s`;
    // One attempt = (probe +) encode of this source. If it hasn't produced
    // real output in time (see FIRST_OUTPUT_S) it is dropped for another.
    const attempt = new AbortController();
    job.kill = () => attempt.abort();
    let released = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (released || job.cancelled) return;
      const now = Date.now();
      const waitedS = job.waitingSince ? (now - Math.max(job.waitingSince, started)) / 1000 : 0;
      const ranS = (now - started) / 1000;
      if (ranS < limitS && waitedS < graceS) return;
      console.log(`compile smooth clip ${i} too slow: no output after ${ranS.toFixed(1)} s`
        + `${waitedS >= graceS ? ` (VLC waiting ${waitedS.toFixed(1)} s)` : ''} (${label}), trying another`);
      noteStart(ranS, true);
      attempt.abort();
    }, 250);
    try {
      // Audio and codec as the header check recorded them, else read the
      // header now. A file replaced since its check may differ: the encode
      // checks its own input listing, and on a mismatch starts over once
      // with what it found (the header is cached by then, so that costs
      // almost nothing).
      let info = clip.vc ? { hasAudio: clip.a === 1, videoCodec: clip.vc }
        : await probeInfo(clip.id, token, 'compile', attempt.signal, PIECE_UNITS > 0);
      for (let tries = 0; tries < 2 && !job.cancelled && !attempt.signal.aborted; tries++) {
        if (SLOW_CODECS.has(info.videoCodec)) {
          console.log(`compile smooth clip ${i} skipped: ${info.videoCodec} is too slow to decode live (${label})`);
          break;
        }
        const result = await encodeClip(job, clip, n, session, token, info, attempt.signal, emit, () => {
          released = true;
          noteStart((Date.now() - started) / 1000, false);
        });
        if (result.ok) { job.done = true; emit(); return; }
        const found = result.found;
        if (!found || (found.hasAudio === info.hasAudio && !SLOW_CODECS.has(found.videoCodec))) {
          if (!attempt.signal.aborted) console.log(`compile smooth clip ${i} failed: exit ${result.code} ${result.why} (${label})`);
          break;
        }
        console.log(`compile smooth clip ${i}: file has ${found.videoCodec}${found.hasAudio ? '' : ', no audio'}, `
          + `not ${info.videoCodec}${info.hasAudio ? '' : ', no audio'} as recorded (${label})`);
        info = found;
      }
    } catch (err) {
      if (!attempt.signal.aborted) console.log(`compile smooth clip ${i} failed: ${err.message}`);
    } finally {
      clearInterval(timer);
    }
  }
  job.failed = true;
  job.done = true;
  emit();
}

// One ffmpeg encode of `clip` into job.chunks, assuming `info` (audio,
// codec). Resolves { ok: true } once it has finished with real output,
// else { ok: false, found, code, why } - found = what the input listing
// showed (null if it never got that far), why = ffmpeg's error lines.
function encodeClip(job, clip, n, session, token, info, signal, emit, onRelease) {
  return new Promise(resolve => {
    const ff = spawn(FFMPEG, smoothArgs(clip, n, session, token, info.hasAudio),
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => ff.kill('SIGKILL');
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    let stderr = '';
    let found = null;
    let size = 0;
    let released = false;
    const pending = [];
    const release = () => {
      released = true;
      onRelease();
      job.chunks.push(...pending);
      emit();
    };
    ff.stderr.on('data', d => {
      if (stderr.length < 64000) stderr += d;
      if (found) return;
      found = inputStreams(stderr);
      // A stream it should use is missing, it has audio being replaced by
      // silence, or a codec too slow to keep up: stop now.
      if (found && (found.hasAudio !== info.hasAudio || SLOW_CODECS.has(found.videoCodec))) kill();
      else if (found && size >= MIN_SEGMENT_B && !released) release();
    });
    ff.stdout.on('data', c => {
      size += c.length;
      // Hold output back until it's clearly a real encode of the right
      // file, so a failed source can still be swapped without the viewer
      // seeing it.
      if (released) { job.chunks.push(c); emit(); return; }
      pending.push(c);
      if (size >= MIN_SEGMENT_B && found) release();
    });
    ff.on('error', err => resolve({ ok: false, found: null, code: -1, why: err.message }));
    ff.on('close', code => {
      signal.removeEventListener('abort', kill);
      found ||= inputStreams(stderr);
      const mismatch = found && (found.hasAudio !== info.hasAudio || SLOW_CODECS.has(found.videoCodec));
      if (!released && code === 0 && size > 0 && !mismatch) release();
      const why = stderr.split('\n').filter(l => /error|invalid|failed|no such|matches no/i.test(l)).slice(-3).join(' | ');
      resolve({ ok: released, found, code, why: why.slice(0, 300) });
    });
  });
}

// Keep only jobs near where this viewer is now; a seek abandons the rest.
function pruneJobs(sid, n) {
  for (const [key, job] of jobs) {
    const [jsid, jn] = key.split(':');
    const stale = jsid === sid ? (Number(jn) < n - 1 || Number(jn) > n + ENCODE_AHEAD) : jobs.size > 8;
    if (stale) {
      job.cancelled = true;
      if (job.waiter) dropWaiter(job);
      else if (!job.done) job.kill();
      jobs.delete(key);
    }
  }
}

// Warm start: for 4K, encode the first clip (with the next ones queued
// behind it) before handing the compilation to VLC. Otherwise VLC asks for
// clip 0 the instant it opens and catches the encoder from a standing
// start, stalling the first few clips. Holding this request open also
// keeps the CPU at full speed under request-based billing while it runs.
const WARM_START_HEIGHT    = 2160;
const WARM_START_TIMEOUT_S = 45;

function warmStart(sid, session) {
  const first = startJob(sid, session, 0, true);
  for (let k = 1; k <= ENCODE_AHEAD && k < session.clips.length; k++) startJob(sid, session, k, false);
  return new Promise(resolve => {
    const timer = setTimeout(finish, WARM_START_TIMEOUT_S * 1000);
    function finish() {
      clearTimeout(timer);
      first.listeners.delete(check);
      resolve();
    }
    function check() { if (first.done) finish(); }
    first.listeners.add(check);
    check();
  });
}

function smoothSegment(sid, session, n) {
  pruneJobs(sid, n);
  const job = startJob(sid, session, n, true);
  // VLC is now waiting for this segment: a source still not producing
  // output gets only WAITING_GRACE_S more (see runJob).
  if (!job.done && !job.chunks.length) job.waitingSince ??= Date.now();
  for (let k = 1; k <= ENCODE_AHEAD && n + k < session.clips.length; k++) {
    startJob(sid, session, n + k, false); // encode ahead
  }

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
      : originalSegment(session, n, req.signal);
  }
  return new Response('not found', { status: 404 });
}
