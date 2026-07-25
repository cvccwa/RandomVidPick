import { getServiceAccountToken } from './_lib/serviceAccount.js';

export const config = { runtime: 'edge' };

const ALLOWED_ORIGIN = 'https://cvccwa.github.io';

export default async function handler(req) {
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

  let thumbnailLink;
  try {
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=thumbnailLink`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!metaRes.ok) return new Response('upstream fetch failed', { status: 502 });
    const meta = await metaRes.json();
    thumbnailLink = meta.thumbnailLink;
  } catch (err) {
    return new Response('upstream fetch failed', { status: 502 });
  }

  // Not every file has a thumbnail yet (very recent uploads, unsupported
  // types). Short cache so a miss doesn't stick around once Drive generates
  // one, unlike the 7-day cache on an actual hit below.
  if (!thumbnailLink) {
    return new Response('no thumbnail', {
      status:  404,
      headers: { 'Cache-Control': 'max-age=300' },
    });
  }

  let thumbRes;
  try {
    // No Authorization header here on purpose: thumbnailLink is a separate,
    // pre-signed CDN URL, not a googleapis.com endpoint - the proof of access
    // is baked into its own query params. Sending an unrelated Bearer token
    // alongside a signed URL is exactly the kind of thing a strict CDN can
    // reject outright, which would break an otherwise-working thumbnail.
    thumbRes = await fetch(thumbnailLink);
  } catch (err) {
    return new Response('upstream fetch failed', { status: 502 });
  }
  // Pass through the real status instead of collapsing every failure to a
  // flat 502, so a genuine upstream problem is distinguishable from this
  // proxy's own errors if it ever needs diagnosing again.
  if (!thumbRes.ok) return new Response('upstream fetch failed', { status: thumbRes.status });

  const resHeaders = new Headers({
    'Cache-Control':                'public, max-age=604800, immutable',
    'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  });
  const contentType = thumbRes.headers.get('content-type');
  if (contentType) resHeaders.set('content-type', contentType);

  return new Response(thumbRes.body, {
    status:  200,
    headers: resHeaders,
  });
}
