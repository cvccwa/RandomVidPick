export const config = { runtime: 'edge' };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const id    = searchParams.get('id');
  const token = searchParams.get('token');

  if (!id || !token) return new Response('missing id or token', { status: 400 });

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
  const reqHeaders = { Authorization: `Bearer ${token}` };
  const range = req.headers.get('range');
  if (range) reqHeaders['Range'] = range;

  const driveRes = await fetch(driveUrl, { method: req.method, headers: reqHeaders });

  const resHeaders = new Headers({ 'Accept-Ranges': 'bytes' });
  for (const h of ['content-type', 'content-length', 'content-range']) {
    const v = driveRes.headers.get(h);
    if (v) resHeaders.set(h, v);
  }

  return new Response(req.method === 'HEAD' ? null : driveRes.body, {
    status: driveRes.status,
    headers: resHeaders,
  });
}
