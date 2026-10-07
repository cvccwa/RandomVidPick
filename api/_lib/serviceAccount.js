const KV_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

// Upstash Redis REST: POST a command array, get back {result}.
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

// The Cloud Run service runs as the Drive service account, so the platform
// hands out its tokens directly - no private key anywhere. The process stays
// up between requests, so a plain variable is enough of a cache.
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
  + '?scopes=' + encodeURIComponent('https://www.googleapis.com/auth/drive.readonly');
let cachedToken = null; // { token, expiresAt }

export async function getServiceAccountToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const { access_token, expires_in } = await res.json();
  cachedToken = { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
  return access_token;
}
