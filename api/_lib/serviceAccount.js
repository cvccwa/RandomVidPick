// Shared token cache in Vercel KV (Upstash Redis) — readable in low-single-digit ms
// from ANY Edge instance/region, unlike a module-level variable which only lives
// inside one isolate. This is what actually eliminates the cold-isolate JWT+OAuth
// round trip that was causing VLC to hang on first playback attempts.
const KV_URL    = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN  = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TOKEN_KEY = 'rvp_drive_token';

export async function kvCommand(command) {
  const res = await fetch(KV_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`kv error ${res.status}`);
  return (await res.json()).result;
}

export function b64url(binaryStr) {
  return btoa(binaryStr).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function getServiceAccountToken() {
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
