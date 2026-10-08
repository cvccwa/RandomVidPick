import { spawn } from 'node:child_process';
import { sourceUrl, pieceArgs } from './driveSource.js';

// Shared by compilations (api/compile.js) and highlight analysis
// (api/analyze.js). ffmpeg reads Drive files through driveSource.js so the
// bytes are counted and Drive's refusal reasons logged.
export const DRIVE_API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';
export const FFMPEG    = process.env.FFMPEG_PATH || 'ffmpeg';

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

// A file's audio presence, frame rate, duration (seconds) and picture size
// as players show it, from ffmpeg's stream listing - reads only the
// container header. width/height are 0 when the header doesn't say.
export function probeInfo(id, token, purpose = 'compile', signal) {
  if (probeCache.has(id)) return Promise.resolve(probeCache.get(id));
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ['-hide_banner', ...(purpose === 'analyze' ? pieceArgs() : []), '-i', sourceUrl(id, purpose)],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const kill = () => ff.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    let stderr = '';
    ff.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
    ff.on('error', reject);
    ff.on('close', () => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new Error('probe cancelled'));
      const videoLine = (/Stream #0:\d+[^:]*: Video:.*/.exec(stderr) || [])[0];
      if (!videoLine) return reject(probeError(stderr));
      const rate = /([\d.]+) fps/.exec(videoLine) || /([\d.]+) tbr/.exec(videoLine);
      const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
      const info = {
        hasAudio: /Stream #0:\d+[^:]*: Audio:/.test(stderr),
        fps:      rate ? Number(rate[1]) : 0,
        duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
        ...shownSize(stderr, videoLine),
      };
      if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value);
      probeCache.set(id, info);
      resolve(info);
    });
  });
}

// The stream line gives the stored size; players also apply the pixel
// aspect (SAR) and any rotation flag - phones often store video sideways
// and mark it "rotate 90". Drive reports the stored size, so its shape can
// be wrong for those.
function shownSize(stderr, videoLine) {
  const size = /, (\d{2,5})x(\d{2,5})[, ]/.exec(videoLine);
  if (!size) return { width: 0, height: 0, rotation: 0 };
  let width = Number(size[1]);
  let height = Number(size[2]);
  const sar = /\[SAR (\d+):(\d+)/.exec(videoLine);
  if (sar && Number(sar[1]) > 0 && Number(sar[2]) > 0) width = Math.round(width * Number(sar[1]) / Number(sar[2]));
  // This stream's own block only (up to the next stream).
  const start = stderr.indexOf(videoLine);
  const next = stderr.indexOf('Stream #', start + 1);
  const block = stderr.slice(start, next === -1 ? undefined : next);
  const rot = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(block) || /rotate\s*:\s*(-?\d+)/.exec(block);
  const rotation = rot ? ((Math.round(Number(rot[1])) % 360) + 360) % 360 : 0;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return { width, height, rotation };
}
