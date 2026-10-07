import { kvCommand } from './_lib/serviceAccount.js';

// Called once a day by Cloud Scheduler (job rvp-keepalive). Upstash archives
// free-plan databases that see no traffic for a while (that's what took the
// KV store offline after a few idle months), so this writes one small key
// daily to keep it counted as active. The value is the run time, so the
// last successful ping can be checked from the Upstash console.
//
// If CRON_SECRET is set on the service, requests must send it as a Bearer
// token (Cloud Scheduler can add that header). Without it the endpoint
// still only ever does this one SET.
export default async function handler(req) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    await kvCommand(['SET', 'rvp:keepalive', new Date().toISOString()]);
  } catch (err) {
    console.log(`keepalive failed: ${err.message}`);
    return new Response('kv unavailable', { status: 503 });
  }
  return new Response('ok', { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
