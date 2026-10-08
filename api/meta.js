import { kvCommand } from './_lib/serviceAccount.js';
import { isAuthorized, ID_RE } from './_lib/auth.js';

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';
const DUR_KEY        = 'rvp:dur';     // hash: fileId -> duration ms
const WATCHED_KEY    = 'rvp:watched'; // hash: fileId -> last-watched epoch ms
const TAGS_KEY       = 'rvp:tags';    // hash: fileId -> JSON {tagName: source}
const MEDIA_KEY      = 'rvp:media';   // hash: fileId -> JSON from the header check (api/analyze.js)
const TAG_SOURCES    = new Set(['m', 'f', 'i']); // manual, filename-derived, imported
const MAX_TAGS       = 50;
const MAX_TAG_LEN    = 60;            // 40-char name + 'creator:' prefix, with margin

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

// Returns a cleaned {tag: source} map, or null if anything is malformed.
function cleanTags(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_TAGS) return null;
  const out = {};
  for (const [tag, src] of entries) {
    const name = tag.replace(/\s+/g, ' ').trim();
    if (!name || name.length > MAX_TAG_LEN || /[\u0000-\u001f]/.test(name)) return null;
    if (!TAG_SOURCES.has(src)) return null;
    out[name] = src;
  }
  return out;
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
    const [dur, watched, tagPairs, mediaPairs] = await Promise.all([
      kvCommand(['HGETALL', DUR_KEY]),
      kvCommand(['HGETALL', WATCHED_KEY]),
      kvCommand(['HGETALL', TAGS_KEY]),
      kvCommand(['HGETALL', MEDIA_KEY]),
    ]);
    const tags = {};
    for (let i = 0; i + 1 < (tagPairs || []).length; i += 2) {
      try { tags[tagPairs[i]] = JSON.parse(tagPairs[i + 1]); } catch (err) { /* skip corrupt row */ }
    }
    // Compact for the app: [width, height (as shown), fps, has audio 1/0,
    // duration ms, stored short side (resolution), audio only 1/0, video codec].
    const media = {};
    for (let i = 0; i + 1 < (mediaPairs || []).length; i += 2) {
      let m;
      try { m = JSON.parse(mediaPairs[i + 1]); } catch (err) { continue; }
      if (m.audioOnly) media[mediaPairs[i]] = [0, 0, 0, 1, m.d || 0, 0, 1, ''];
      else if (!m.err) media[mediaPairs[i]] = [m.w || 0, m.h || 0, m.fps || 0, m.ac ? 1 : 0, m.d || 0, Math.min(m.sw || 0, m.sh || 0), 0, m.vc || ''];
    }
    return json({ durations: pairsToObject(dur), watched: pairsToObject(watched), tags, media });
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

    // Tags: each entry fully replaces that video's tag map; an empty map
    // (or null) clears it. Any malformed entry rejects the whole request so
    // a buggy client can't half-apply a bulk edit.
    const tagSetArgs = [];
    const tagDelIds  = [];
    const tagEntries = Object.entries(body.tags || {});
    if (tagEntries.length > 200) return json({ error: 'too many tag updates' }, 400);
    for (const [id, raw] of tagEntries) {
      if (!ID_RE.test(id)) return json({ error: 'bad id' }, 400);
      if (raw === null) { tagDelIds.push(id); continue; }
      const cleaned = cleanTags(raw);
      if (!cleaned) return json({ error: 'bad tags' }, 400);
      if (Object.keys(cleaned).length) tagSetArgs.push(id, JSON.stringify(cleaned));
      else tagDelIds.push(id);
    }

    const writes = [];
    if (tagSetArgs.length) writes.push(kvCommand(['HSET', TAGS_KEY, ...tagSetArgs]));
    if (tagDelIds.length)  writes.push(kvCommand(['HDEL', TAGS_KEY, ...tagDelIds]));
    if (durArgs.length)     writes.push(kvCommand(['HSET', DUR_KEY, ...durArgs]));
    if (watchedArgs.length) writes.push(kvCommand(['HSET', WATCHED_KEY, ...watchedArgs]));
    await Promise.all(writes);
    return json({
      ok:        true,
      durations: durArgs.length / 2,
      watched:   watchedArgs.length / 2,
      tags:      tagSetArgs.length / 2 + tagDelIds.length,
    });
  }

  return json({ error: 'method not allowed' }, 405);
}
