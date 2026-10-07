import { getServiceAccountToken } from './_lib/serviceAccount.js';
import { verifyStream } from './_lib/streamSig.js';
import { countDriveBytes, refusalReason } from './_lib/driveSource.js';

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';

// Cap how much of a Range we ever relay to Drive in one request. Without
// this, an open-ended VLC Range request (e.g. "bytes=X-" = rest of file)
// ties one request's lifetime to the whole remaining transfer, which would
// run into the request timeout on multi-GB files. VLC simply asks for the
// next chunk. Tunable via env var without a code change.
const CHUNK_SIZE = parseInt(process.env.STREAM_CHUNK_BYTES) || 8 * 1024 * 1024;

const RETRYABLE       = new Set([403, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [400, 1200, 2500];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Drive's error JSON names the reason (userRateLimitExceeded, ...).
async function driveReason(res, method) {
  if (method === 'HEAD') return `HTTP ${res.status}`;
  return refusalReason(res.status, await res.text().catch(() => ''));
}

// A 403 is worth retrying only when it's a rate limit, which clears in
// seconds; others (downloadQuotaExceeded, no access) won't change, and
// retrying just delays VLC's error.
function worthRetrying(status, reason) {
  if (status !== 403) return RETRYABLE.has(status);
  return /rateLimitExceeded/i.test(reason);
}

function buildCappedRange(clientRangeHeader) {
  if (!clientRangeHeader) return `bytes=0-${CHUNK_SIZE - 1}`;
  const match = /^bytes=(\d+)-(\d*)$/.exec(clientRangeHeader.trim());
  if (!match) return clientRangeHeader; // suffix-range/multi-range: pass through rather than misinterpret as start=0
  const start = parseInt(match[1], 10);
  if (match[2]) {
    const clientEnd = parseInt(match[2], 10);
    if (clientEnd - start + 1 <= CHUNK_SIZE) return `bytes=${start}-${clientEnd}`;
  }
  return `bytes=${start}-${start + CHUNK_SIZE - 1}`;
}

export default async function handler(req) {
  // Block cross-origin browser requests from unknown origins;
  // absent Origin header (VLC, direct API calls) is allowed through.
  const origin = req.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) {
    return new Response('forbidden', { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return new Response('missing id', { status: 400 });

  // Links come from /api/sign and expire; a bare or copied-and-stale id
  // gets nothing.
  let valid;
  try {
    valid = await verifyStream(id, searchParams.get('exp'), searchParams.get('sig'));
  } catch (err) {
    return new Response('signing unavailable', { status: 503 });
  }
  if (!valid) return new Response('link expired or invalid', { status: 403 });

  let token;
  try {
    token = await getServiceAccountToken();
  } catch (err) {
    return new Response('auth error', { status: 500 });
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
  const reqHeaders = { Authorization: `Bearer ${token}` };
  if (req.method === 'HEAD') {
    const range = req.headers.get('range');
    if (range) reqHeaders['Range'] = range;
  } else {
    // Deliberate RFC 7233 §4.1 deviation: always send a capped Range to
    // Drive, even for a bare GET with no client Range header, so a 206
    // comes back instead of the whole file in one shot. Safe here because
    // the only real client (VLC) always sends its own Range in practice.
    reqHeaders['Range'] = buildCappedRange(req.headers.get('range'));
  }

  // Drive sometimes refuses a request it would serve a moment later (403
  // rate limiting, 429, 5xx) - most noticeably when the service account has
  // been busy. Retry briefly rather than handing VLC an error mid-video, and
  // log Drive's reason when it still refuses.
  let driveRes;
  for (let attempt = 0; ; attempt++) {
    try {
      driveRes = await fetch(driveUrl, { method: req.method, headers: reqHeaders });
      countDriveBytes('stream', 0, { request: true, refused: !driveRes.ok });
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) { await sleep(RETRY_DELAYS_MS[attempt]); continue; }
      return new Response('upstream fetch failed', { status: 502 });
    }
    if (!RETRYABLE.has(driveRes.status)) break;
    const reason = await driveReason(driveRes, req.method);
    if (attempt >= RETRY_DELAYS_MS.length || !worthRetrying(driveRes.status, reason)) {
      console.log(`stream ${id.slice(0, 6)}… Drive ${driveRes.status} after ${attempt + 1} tries: ${reason}`);
      return new Response(`drive refused: ${reason}`, {
        status: driveRes.status,
        headers: { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN },
      });
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }

  const resHeaders = new Headers({
    'Accept-Ranges':                'bytes',
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  });
  for (const h of ['content-type', 'content-length', 'content-range']) {
    const v = driveRes.headers.get(h);
    if (v) resHeaders.set(h, v);
  }

  // Counted toward the "drive reads" usage log (see driveSource.js).
  const body = req.method === 'HEAD' || !driveRes.body ? null : driveRes.body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) { countDriveBytes('stream', chunk.byteLength); ctrl.enqueue(chunk); },
  }));
  return new Response(body, {
    status:  driveRes.status,
    headers: resHeaders,
  });
}
