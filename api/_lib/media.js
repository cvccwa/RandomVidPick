import { spawn } from 'node:child_process';

// Shared by compilations (api/compile.js) and highlight analysis
// (api/analyze.js): ffmpeg reads Drive files directly over HTTP with the
// service account's token.
export const DRIVE_API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';
export const FFMPEG    = process.env.FFMPEG_PATH || 'ffmpeg';

export function driveUrl(id) {
  return `${DRIVE_API}/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
}

export function authHeader(token) {
  return ['-headers', `Authorization: Bearer ${token}\r\n`];
}

// ffmpeg only reports "403 Forbidden (access denied)". When it does, ask
// Drive directly a few ways to see why: a plain one-byte read (what the
// stream endpoint does), the same read with ffmpeg's User-Agent, and an
// open-ended range like ffmpeg's. Logged at most once a minute.
let lastDiagnosis = 0;
async function tryRead(id, token, headers) {
  try {
    const res = await fetch(driveUrl(id), { headers: { Authorization: `Bearer ${token}`, ...headers } });
    if (res.ok) { res.body?.cancel(); return String(res.status); }
    const body = await res.json().catch(() => ({}));
    const e = body.error || {};
    const reasons = (e.errors || []).map(x => x.reason).filter(Boolean).join(',');
    return `${res.status} ${reasons || e.status || ''} ${(e.message || '').slice(0, 120)}`.trim();
  } catch (err) {
    return `failed (${err.message})`;
  }
}
export async function driveDiagnosis(id, token, { force = false } = {}) {
  if (!force && Date.now() - lastDiagnosis < 60e3) return null;
  lastDiagnosis = Date.now();
  const [plain, ua, open] = await Promise.all([
    tryRead(id, token, { Range: 'bytes=0-0' }),
    tryRead(id, token, { Range: 'bytes=0-0', 'User-Agent': 'Lavf/59.27.100' }),
    tryRead(id, token, { Range: 'bytes=0-' }),
  ]);
  return `plain: ${plain} | ffmpeg agent: ${ua} | open range: ${open}`;
}
export function logDriveDiagnosis(where, id, token) {
  driveDiagnosis(id, token).then(d => { if (d) console.log(`${where}: Drive check ${id.slice(0, 6)}… ${d}`); }, () => {});
}

const probeCache = new Map(); // file id -> { hasAudio, fps, duration }

// Why ffmpeg couldn't read a file. HTTP / network trouble (Drive refusing
// or rate-limiting, timeouts) is marked transient - worth retrying later -
// as opposed to a file that genuinely has no readable video.
export const TRANSIENT_RE = /HTTP error|Server returned|4\d\d |5\d\d |Connection|timed out|Input\/output error|Network is unreachable|Temporary failure/i;
function probeError(stderr) {
  const lines = stderr.trim().split('\n').filter(l => !/^\s*(built with|configuration:|lib\w+ )/.test(l));
  const detail = (lines.filter(l => /error|returned|failed|invalid/i.test(l)).pop() || lines.pop() || '').trim().slice(0, 200);
  const err = new Error(`no video stream${detail ? `: ${detail}` : ''}`);
  err.transient = TRANSIENT_RE.test(stderr);
  return err;
}

// A file's audio presence, frame rate and duration (seconds), from ffmpeg's
// stream listing - reads only the container header.
export function probeInfo(id, token) {
  if (probeCache.has(id)) return Promise.resolve(probeCache.get(id));
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ['-hide_banner', ...authHeader(token), '-i', driveUrl(id)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
    ff.on('error', reject);
    ff.on('close', () => {
      const videoLine = (/Stream #0:\d+[^:]*: Video:.*/.exec(stderr) || [])[0];
      if (!videoLine) return reject(probeError(stderr));
      const rate = /([\d.]+) fps/.exec(videoLine) || /([\d.]+) tbr/.exec(videoLine);
      const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
      const info = {
        hasAudio: /Stream #0:\d+[^:]*: Audio:/.test(stderr),
        fps:      rate ? Number(rate[1]) : 0,
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
      };
      if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value);
      probeCache.set(id, info);
      resolve(info);
    });
  });
}
