import { isAuthorized, ID_RE } from './_lib/auth.js';
import { signStream, STREAM_LINK_TTL_S } from './_lib/streamSig.js';

export const config = { runtime: 'edge' };

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const MAX_IDS        = 200;

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age':       '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// POST {ids: [...]} -> {exp, sigs: {id: sig}}. The app builds stream links
// from these; /api/stream refuses anything unsigned or expired. Only the
// signed-in owner (same check as /api/meta) can get links.
export default async function handler(req) {
  const origin = req.headers.get('origin');
  if (origin && origin !== ALLOWED_ORIGIN) {
    return new Response('forbidden', { status: 403 });
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!(await isAuthorized(req))) return json({ error: 'unauthorized' }, 401);

  let ids;
  try {
    ids = (await req.json()).ids;
  } catch (err) {
    return json({ error: 'bad json' }, 400);
  }
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS
      || !ids.every(id => typeof id === 'string' && ID_RE.test(id))) {
    return json({ error: 'bad ids' }, 400);
  }

  const exp = String(Math.floor(Date.now() / 1000) + STREAM_LINK_TTL_S);
  const sigs = {};
  try {
    for (const id of new Set(ids)) sigs[id] = await signStream(id, exp);
  } catch (err) {
    console.log(`sign failed: ${err.message}`);
    return json({ error: 'signing unavailable' }, 503);
  }
  return json({ exp, sigs });
}
