import { kvCommand } from './serviceAccount.js';

const ROOT_FOLDER = '1JBAz8KFVSHfnzojWnhECD7gtBRkLBCk9';
const AUTH_TTL_S  = 3000; // re-verify a user token at most every ~50 min
export const ID_RE = /^[\w-]{10,100}$/;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Used by /api/meta and /api/sign: both hand out things (file IDs, stream
// links) that must not reach anonymous callers. A caller is authorized if
// their own Google token can read the library folder. The
// result is cached in KV by token hash so it's one Drive call per token, not
// per request.
export async function isAuthorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
  if (!m) return false;
  const cacheKey = `rvp:auth:${await sha256Hex(m[1])}`;

  try {
    if (await kvCommand(['GET', cacheKey])) return true;
  } catch (err) { /* fall through to a live check */ }

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${ROOT_FOLDER}?fields=id`,
    { headers: { Authorization: `Bearer ${m[1]}` } }
  );
  if (!res.ok) return false;
  kvCommand(['SET', cacheKey, '1', 'EX', AUTH_TTL_S]).catch(() => {});
  return true;
}
