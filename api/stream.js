export const config = { runtime: 'edge' };

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';

// Module-level token cache — survives across requests within the same Edge instance
let cachedToken = null;
let tokenExpiry = 0;

function b64url(binaryStr) {
  return btoa(binaryStr).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getServiceAccountToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

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
  cachedToken  = access_token;
  tokenExpiry  = Date.now() + (expires_in - 60) * 1000; // refresh 60 s early
  return cachedToken;
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
  const range = req.headers.get('range');
  if (range) reqHeaders['Range'] = range;

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
