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

// A file's audio presence, frame rate and duration (seconds), from ffmpeg's
// stream listing - reads only the container header.
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
      };
      if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value);
      probeCache.set(id, info);
      resolve(info);
    });
  });
}
