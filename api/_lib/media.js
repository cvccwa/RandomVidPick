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

const probeCache = new Map(); // file id -> { hasAudio, fps, duration }

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
      if (!videoLine) return reject(new Error('no video stream'));
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
