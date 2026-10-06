import { kvCommand } from './_lib/serviceAccount.js';

export const config = { runtime: 'edge' };

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const ROOT_FOLDER    = '1JBAz8KFVSHfnzojWnhECD7gtBRkLBCk9';
const DUR_KEY        = 'rvp:dur';     // hash: fileId -> duration ms
const WATCHED_KEY    = 'rvp:watched'; // hash: fileId -> last-watched epoch ms
const AUTH_TTL_S     = 3000;          // re-verify a user token at most every ~50 min
const ID_RE          = /^[\w-]{10,100}$/;

const KV_CONFIGURED = Boolean(
  (process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL) &&
  (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
);

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age':       '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The watched list holds Drive file IDs, and /api/stream will stream any ID
// it's handed - so this endpoint must not answer anonymous callers. A caller
// is authorized if their own Google token can read the library folder. The
// result is cached in KV by token hash so it's one Drive call per token, not
// per request.
async function isAuthorized(req) {
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

// HGETALL comes back from Upstash REST as a flat [field, value, ...] array.
function pairsToObject(arr) {
  const out = {};
  for (let i = 0; i + 1 < (arr || []).length; i += 2) out[arr[i]] = Number(arr[i + 1]);
  return out;
}

export default async function handler(req) {
  const origin = req.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) {
    return new Response('forbidden', { status: 403 });
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!KV_CONFIGURED) return json({ error: 'kv not configured' }, 503);
  if (!(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);

  if (req.method === 'GET') {
    const [dur, watched] = await Promise.all([
      kvCommand(['HGETALL', DUR_KEY]),
      kvCommand(['HGETALL', WATCHED_KEY]),
    ]);
    return json({ durations: pairsToObject(dur), watched: pairsToObject(watched) });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch (err) {
      return json({ error: 'bad json' }, 400);
    }

    // Validate everything before writing - ids must look like Drive ids,
    // durations must be plausible (0 < ms < 48h), batches stay small.
    const durArgs = [];
    for (const [id, ms] of Object.entries(body.durations || {}).slice(0, 200)) {
      if (ID_RE.test(id) && Number.isFinite(ms) && ms > 0 && ms < 48 * 3600e3) {
        durArgs.push(id, String(Math.round(ms)));
      }
    }
    const now = String(Date.now());
    const watchedArgs = [];
    for (const id of (Array.isArray(body.watched) ? body.watched : []).slice(0, 50)) {
      if (typeof id === 'string' && ID_RE.test(id)) watchedArgs.push(id, now);
    }

    const writes = [];
    if (durArgs.length)     writes.push(kvCommand(['HSET', DUR_KEY, ...durArgs]));
    if (watchedArgs.length) writes.push(kvCommand(['HSET', WATCHED_KEY, ...watchedArgs]));
    await Promise.all(writes);
    return json({ ok: true, durations: durArgs.length / 2, watched: watchedArgs.length / 2 });
  }

  return json({ error: 'method not allowed' }, 405);
}
