export const config = { runtime: 'edge' };

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';

// Cap how much of a Range we ever relay to Drive in one invocation. Without
// this, a large/open-ended VLC Range request (e.g. "bytes=X-" = rest of
// file) ties one invocation's lifetime to the whole remaining transfer,
// which was hitting Vercel's 300s execution ceiling and its memory ceiling
// on real requests. Tunable via env var without a redeploy.
const CHUNK_SIZE = parseInt(process.env.STREAM_CHUNK_BYTES) || 8 * 1024 * 1024;

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

// Shared token cache in Vercel KV (Upstash Redis) — readable in low-single-digit ms
// from ANY Edge instance/region, unlike a module-level variable which only lives
// inside one isolate. This is what actually eliminates the cold-isolate JWT+OAuth
// round trip that was causing VLC to hang on first playback attempts.
const KV_URL    = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TOKEN_KEY = 'rvp_drive_token';

async function kvCommand(command) {
  const res = await fetch(KV_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`kv error ${res.status}`);
  return (await res.json()).result;
}

function b64url(binaryStr) {
  return btoa(binaryStr).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getServiceAccountToken() {
  if (KV_URL && KV_TOKEN) {
    try {
      const cached = await kvCommand(['GET', TOKEN_KEY]);
      if (cached) return cached;
    } catch (err) {
      // KV unreachable/misconfigured — fall through and mint a fresh token directly
    }
  }

  const email  = process.env.GOOGLE_CLIENT_EMAIL;
  const rawKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const now     = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss:   email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  }));

  const signingInput = `${header}.${payload}`;

  // Strip PEM headers and decode to raw DER bytes
  const pemBody  = rawKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  // Convert signature bytes to binary string for btoa
  const sigArr = new Uint8Array(sigBytes);
  let binary = '';
  for (let i = 0; i < sigArr.length; i++) binary += String.fromCharCode(sigArr[i]);
  const sig = b64url(binary);

  const jwt = `${signingInput}.${sig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  if (!tokenRes.ok) {
    const msg = await tokenRes.text();
    throw new Error(`token exchange ${tokenRes.status}: ${msg}`);
  }

  const { access_token, expires_in } = await tokenRes.json();

  if (KV_URL && KV_TOKEN) {
    // Fire-and-forget — don't let a slow/failed KV write delay this response
    kvCommand(['SET', TOKEN_KEY, access_token, 'EX', expires_in - 60]).catch(() => {});
  }

  return access_token;
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

  let driveRes;
  try {
    driveRes = await fetch(driveUrl, { method: req.method, headers: reqHeaders });
  } catch (err) {
    return new Response('upstream fetch failed', { status: 502 });
  }

  const resHeaders = new Headers({
    'Accept-Ranges':                'bytes',
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  });
  for (const h of ['content-type', 'content-length', 'content-range']) {
    const v = driveRes.headers.get(h);
    if (v) resHeaders.set(h, v);
  }

  return new Response(req.method === 'HEAD' ? null : driveRes.body, {
    status:  driveRes.status,
    headers: resHeaders,
  });
}
