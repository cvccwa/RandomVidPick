// Cloud Run entry point. Serves the same handlers Vercel runs from api/:
// each one takes a web-standard Request and returns a Response, so this
// file only converts between those and Node's http objects.
import http from 'node:http';
import { Readable } from 'node:stream';
import stream from '../api/stream.js';
import thumbnail from '../api/thumbnail.js';
import meta from '../api/meta.js';
import keepalive from '../api/keepalive.js';
import sign from '../api/sign.js';

const routes = {
  '/api/stream':    stream,
  '/api/thumbnail': thumbnail,
  '/api/meta':      meta,
  '/api/keepalive': keepalive,
  '/api/sign':      sign,
};

function toRequest(req, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method:  req.method,
    headers,
    body:    hasBody ? Readable.toWeb(req) : undefined,
    duplex:  hasBody ? 'half' : undefined,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const handler = routes[url.pathname];
  if (!handler) {
    res.writeHead(url.pathname === '/' ? 200 : 404, { 'Content-Type': 'text/plain' });
    return res.end(url.pathname === '/' ? 'ok' : 'not found');
  }

  try {
    const response = await handler(toRequest(req, url));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body || req.method === 'HEAD') return res.end();

    const body = Readable.fromWeb(response.body);
    // VLC drops connections whenever it seeks; stop pulling from Drive
    // as soon as the viewer goes away instead of finishing the chunk.
    res.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch (err) {
    console.error(`${url.pathname} failed: ${err.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('internal error');
  }
});

server.listen(parseInt(process.env.PORT) || 8080);
