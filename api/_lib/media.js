import { spawn } from 'node:child_process';
import { sourceUrl, pieceArgs, readDriveBytes } from './driveSource.js';

// Shared by compilations (api/compile.js) and highlight analysis
// (api/analyze.js). ffmpeg reads Drive files through driveSource.js so the
// bytes are counted and Drive's refusal reasons logged.
export const DRIVE_API = process.env.DRIVE_API_BASE || 'https://www.googleapis.com';
export const FFMPEG    = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE   = process.env.FFPROBE_PATH || 'ffprobe';

const probeCache = new Map(); // file id -> { hasAudio, fps, duration }

// Why ffmpeg couldn't read a file. HTTP / network trouble (Drive refusing
// or rate-limiting, timeouts) is marked transient - worth retrying later -
// as opposed to a file that genuinely has no readable video.
const TRANSIENT_RE = /HTTP error|Server returned|4\d\d |5\d\d |Connection|timed out|Input\/output error|Network is unreachable|Temporary failure/i;
// Reading in small pieces (driveSource.js), ffmpeg logs "Will reconnect at
// ... error=Input/output error" at the end of every piece; that's normal,
// not trouble.
const PIECE_END_RE = /Will reconnect at \d+.*error=(Input\/output error|End of file)/;
export function isTransient(stderr) {
  return TRANSIENT_RE.test(String(stderr).split('\n').filter(l => !PIECE_END_RE.test(l)).join('\n'));
}
function probeError(stderr) {
  const lines = stderr.trim().split('\n').filter(l => !/^\s*(built with|configuration:|lib\w+ )/.test(l) && !PIECE_END_RE.test(l));
  const detail = (lines.filter(l => /error|returned|failed|invalid/i.test(l)).pop() || lines.pop() || '').trim().slice(0, 200);
  const err = new Error(`no video stream${detail ? `: ${detail}` : ''}`);
  err.transient = isTransient(stderr);
  return err;
}

// A file's audio presence, frame rate, duration (seconds), codecs and
// picture size as players show it, from ffmpeg's stream listing - reads
// only the container header, in small pieces unless `pieces` is false.
// width/height are 0 when the header doesn't say.
export function probeInfo(id, token, purpose = 'compile', signal, pieces = true) {
  if (probeCache.has(id)) return Promise.resolve(probeCache.get(id));
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ['-hide_banner', ...(pieces ? pieceArgs() : []), '-i', sourceUrl(id, purpose, { pieces: pieces ? 1 : 0 })],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    const kill = () => ff.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    let stderr = '';
    ff.stderr.on('data', d => { if (stderr.length < 20000) stderr += d; });
    ff.on('error', reject);
    ff.on('close', () => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new Error('probe cancelled'));
      // Cover art in an audio file shows up as an "attached pic" video stream.
      const videoLine = (stderr.match(/Stream #0:\d+[^:]*: Video:.*/g) || []).find(l => !/attached pic/.test(l));
      const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
      const audioLine = (/Stream #0:\d+[^:]*: Audio: (\w+)/.exec(stderr) || [])[1];
      if (!videoLine) {
        const err = probeError(stderr);
        if (audioLine && !err.transient) {
          // Readable, just no picture: an audio-only file.
          err.message = 'audio only';
          err.audioOnly = true;
          err.audioCodec = audioLine;
          err.duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
        }
        return reject(err);
      }
      const rate = /([\d.]+) fps/.exec(videoLine) || /([\d.]+) tbr/.exec(videoLine);
      const info = {
        hasAudio: Boolean(audioLine),
        videoCodec: (/Video: (\w+)/.exec(videoLine) || [])[1] || '',
        audioCodec: audioLine || '',
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

// Where a seek to `t` seconds lands: { at } = the time of the keyframe at
// or before it (on the same scale as ffmpeg's -ss), null if it can't tell;
// duration = the file's length in seconds (0 if unknown); refused = Drive
// refused the read. Reads
// the container's index and the keyframe itself, in pieces of up to
// `pieces` units - what an encode starting there reads first anyway, so it
// then comes from the cache.
export function keyframeBefore(id, t, purpose, signal, pieces = 1) {
  return new Promise(resolve => {
    const ff = spawn(FFPROBE, ['-v', 'error', ...pieceArgs({ noProbe: true }), '-select_streams', 'v:0',
      '-read_intervals', `${t}%+#1`, '-show_entries', 'packet=pts_time,dts_time,flags:stream=duration',
      '-of', 'json', sourceUrl(id, purpose, { pieces })], { stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => ff.kill('SIGKILL');
    signal?.addEventListener('abort', kill, { once: true });
    let out = '';
    let err = '';
    ff.stdout.on('data', d => { if (out.length < 20000) out += d; });
    ff.stderr.on('data', d => { if (err.length < 4000) err += d; });
    ff.on('error', () => resolve({ at: null, refused: false }));
    ff.on('close', () => {
      signal?.removeEventListener('abort', kill);
      const refused = /HTTP error 4\d\d|Server returned 4\d\d/.test(err);
      try {
        const j = JSON.parse(out);
        // From the index (MP4 / MOV); 0 where it only comes from probing.
        const duration = Number((j.streams || [])[0]?.duration) || 0;
        const p = (j.packets || [])[0];
        const at = Number(p?.pts_time ?? p?.dts_time);
        if (!p || !/K/.test(p.flags || '') || !Number.isFinite(at)) return resolve({ at: null, duration, refused });
        // Packet times as they stand: the encode skips the probe too, so its
        // -ss doesn't add the file's start time either.
        resolve({ at, duration, refused });
      } catch (e) {
        resolve({ at: null, duration: 0, refused });
      }
    });
  });
}

// Audio presence and video codec from the input listing ffmpeg prints
// (log level info) before it starts - what an encode actually found in the
// file. null until the listing is complete.
export function inputStreams(stderr) {
  const end = stderr.search(/Stream mapping:|Output #0|matches no streams/);
  if (end === -1) return null;
  const listing = stderr.slice(0, end);
  const videoLine = (listing.match(/Stream #0:\d+[^:]*: Video:.*/g) || []).find(l => !/attached pic/.test(l));
  return {
    hasAudio: /Stream #0:\d+[^:]*: Audio:/.test(listing),
    videoCodec: videoLine ? (/Video: (\w+)/.exec(videoLine) || [])[1] || '' : '',
  };
}

// The stream line gives the stored size, which is what resolution (quality)
// means; players also apply the pixel aspect (SAR) and any rotation flag -
// phones often store video sideways and mark it "rotate 90". Drive reports
// the stored size, so its shape can be wrong for those.
function shownSize(stderr, videoLine) {
  const size = /, (\d{2,5})x(\d{2,5})[, ]/.exec(videoLine);
  if (!size) return { width: 0, height: 0, storedWidth: 0, storedHeight: 0, rotation: 0 };
  const storedWidth = Number(size[1]);
  const storedHeight = Number(size[2]);
  let width = storedWidth;
  let height = storedHeight;
  const sar = /\[SAR (\d+):(\d+)/.exec(videoLine);
  if (sar && Number(sar[1]) > 0 && Number(sar[2]) > 0) width = Math.round(width * Number(sar[1]) / Number(sar[2]));
  // This stream's own block only (up to the next stream).
  const start = stderr.indexOf(videoLine);
  const next = stderr.indexOf('Stream #', start + 1);
  const block = stderr.slice(start, next === -1 ? undefined : next);
  const rot = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(block) || /rotate\s*:\s*(-?\d+)/.exec(block);
  const rotation = rot ? ((Math.round(Number(rot[1])) % 360) + 360) % 360 : 0;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return { width, height, storedWidth, storedHeight, rotation };
}

// MP4 / MOV files are a run of top-level boxes, each starting with its own
// size, so a file cut short (an interrupted upload) has a last box that
// claims to end past the end of the file. Walking them costs a few small
// reads, mostly from pieces ffmpeg already read. Returns null when the file
// isn't MP4-style (MKV, WebM, TS...) or has too many boxes to walk cheaply
// (fragmented), { cut: bytes missing } otherwise (0 = complete), or
// { bad: true } when the box structure itself is broken.
const MP4_FIRST_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'styp', 'sidx']);
const MAX_BOXES = 64;
export async function mp4Truncation(id, signal) {
  let at = 0;
  let size = Infinity;
  for (let n = 0; n < MAX_BOXES; n++) {
    if (at >= size) return { cut: at - size };
    const read = await readDriveBytes(id, at, 16, 'analyze', signal);
    size = read.size;
    const buf = read.buf;
    if (buf.length < 8) return { bad: true };
    const type = buf.toString('latin1', 4, 8);
    if (n === 0 && !MP4_FIRST_BOXES.has(type)) return null;
    if (!/^[\x20-\x7e]{4}$/.test(type)) return { bad: true };
    let boxSize = buf.readUInt32BE(0);
    if (boxSize === 0) return { cut: 0 }; // runs to the end of the file
    if (boxSize === 1) {
      if (buf.length < 16) return { bad: true };
      boxSize = Number(buf.readBigUInt64BE(8));
    }
    if (boxSize < 8) return { bad: true };
    at += boxSize;
  }
  return null;
}
