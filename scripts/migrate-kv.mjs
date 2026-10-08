// One-off copy of the app's Upstash Redis data from one database to another
// (moving off the Vercel-managed database). Runs as a Cloud Run job from the
// same image: `node scripts/migrate-kv.mjs`.
//
//   FROM_KV_URL / FROM_KV_TOKEN   source REST endpoint + token (only read)
//   TO_KV_URL   / TO_KV_TOKEN     destination REST endpoint + token
//   DRY_RUN=1                     list what would be copied, write nothing
//   OVERWRITE=1                   allow writing into a destination that
//                                 already holds keys this would copy
//
// Copies every key except short-lived ones the app recreates on its own
// (compilation sessions, the analysis lock and to-do list). Keeps types and
// expiry times, then checks sizes match. Logs key names, types and sizes -
// never values.

const SKIP = [/^rvp:comp:/, /^rvp:analyze:lock$/, /^rvp:analyze:todo$/, /^rvp:analyze:listedAt$/];
const HASH_CHUNK = 500; // fields per HSET

function client(url, token, label) {
  if (!url || !token) throw new Error(`${label}_KV_URL and ${label}_KV_TOKEN are required`);
  return async command => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`${label} ${command[0]}: ${res.status} ${body.error || ''}`);
    return body.result;
  };
}

async function allKeys(kv) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await kv(['SCAN', cursor, 'COUNT', '1000']);
    keys.push(...batch);
    cursor = String(next);
  } while (cursor !== '0');
  return [...new Set(keys)].sort();
}

// -> { type, size, write(dst) } for one key.
async function readKey(src, key) {
  const type = await src(['TYPE', key]);
  switch (type) {
    case 'string': {
      const v = await src(['GET', key]);
      return { type, size: v.length, write: dst => dst(['SET', key, v]), check: dst => dst(['STRLEN', key]) };
    }
    case 'hash': {
      const flat = await src(['HGETALL', key]);
      return {
        type, size: flat.length / 2,
        write: async dst => {
          for (let i = 0; i < flat.length; i += HASH_CHUNK * 2) await dst(['HSET', key, ...flat.slice(i, i + HASH_CHUNK * 2)]);
        },
        check: dst => dst(['HLEN', key]),
      };
    }
    case 'list': {
      const items = await src(['LRANGE', key, '0', '-1']);
      return { type, size: items.length, write: dst => dst(['RPUSH', key, ...items]), check: dst => dst(['LLEN', key]) };
    }
    case 'set': {
      const items = await src(['SMEMBERS', key]);
      return { type, size: items.length, write: dst => dst(['SADD', key, ...items]), check: dst => dst(['SCARD', key]) };
    }
    case 'zset': {
      const flat = await src(['ZRANGE', key, '0', '-1', 'WITHSCORES']);
      const pairs = [];
      for (let i = 0; i < flat.length; i += 2) pairs.push(flat[i + 1], flat[i]);
      return { type, size: flat.length / 2, write: dst => dst(['ZADD', key, ...pairs]), check: dst => dst(['ZCARD', key]) };
    }
    default:
      return { type, size: 0, write: null };
  }
}

async function main() {
  const src = client(process.env.FROM_KV_URL, process.env.FROM_KV_TOKEN, 'FROM');
  const dst = client(process.env.TO_KV_URL, process.env.TO_KV_TOKEN, 'TO');
  const dry = process.env.DRY_RUN === '1';

  const keys = (await allKeys(src)).filter(k => !SKIP.some(re => re.test(k)));
  console.log(`source: ${keys.length} keys to copy${dry ? ' (dry run)' : ''}`);

  const existing = (await allKeys(dst)).filter(k => keys.includes(k));
  if (existing.length && !dry && process.env.OVERWRITE !== '1') {
    throw new Error(`destination already has ${existing.length} of these keys (${existing.slice(0, 5).join(', ')}...); set OVERWRITE=1 to replace them`);
  }

  let problems = 0;
  for (const key of keys) {
    const item = await readKey(src, key);
    const ttl = Number(await src(['PTTL', key]));
    const ttlText = ttl > 0 ? `, expires in ${Math.round(ttl / 1000)} s` : '';
    if (!item.write) { console.log(`  skip ${key}: unsupported type ${item.type}`); problems++; continue; }
    if (dry) { console.log(`  would copy ${key} (${item.type}, ${item.size}${ttlText})`); continue; }
    if (existing.includes(key)) await dst(['DEL', key]);
    await item.write(dst);
    if (ttl > 0) await dst(['PEXPIRE', key, String(ttl)]);
    const got = Number(await item.check(dst));
    const ok = got === item.size;
    if (!ok) problems++;
    console.log(`  ${ok ? 'copied' : 'MISMATCH'} ${key} (${item.type}, ${item.size}${ok ? '' : ` -> ${got}`}${ttlText})`);
  }
  console.log(problems ? `done with ${problems} problem(s)` : `done: ${keys.length} keys ${dry ? 'listed' : 'copied and verified'}`);
  if (problems) process.exitCode = 1;
}

main().catch(err => { console.error(`migrate-kv failed: ${err.message}`); process.exitCode = 1; });
