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
    // Bearer token sent defensively — Drive's signed thumbnail URLs typically
    // don't require it, but it costs nothing and guards against that changing.
    thumbRes = await fetch(thumbnailLink, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    return new Response('upstream fetch failed', { status: 502 });
  }
  if (!thumbRes.ok) return new Response('upstream fetch failed', { status: 502 });

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
