import { kvCommand, b64url } from './serviceAccount.js';

// Stream links carry an expiry and an HMAC over "id.exp", so a copied link
// stops working once it expires and can't be pointed at another file.
// The signing secret comes from STREAM_SIGNING_KEY if set; otherwise one is
// generated on first use and kept in KV, so there is nothing to configure.
export const STREAM_LINK_TTL_S = 12 * 3600; // outlasts a long viewing session

const KEY_NAME = 'rvp:streamkey';
const enc = new TextEncoder();
let keyPromise = null;

async function loadSecret() {
  if (process.env.STREAM_SIGNING_KEY) return process.env.STREAM_SIGNING_KEY;
  let secret = await kvCommand(['GET', KEY_NAME]);
  if (!secret) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const fresh = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    // NX: if two instances race on first use, both end up with the winner's.
    await kvCommand(['SET', KEY_NAME, fresh, 'NX']);
    secret = await kvCommand(['GET', KEY_NAME]);
  }
  if (!secret) throw new Error('no stream signing key');
  return secret;
}

function getKey() {
  if (!keyPromise) {
    keyPromise = loadSecret()
      .then(secret => crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']))
      .catch(err => { keyPromise = null; throw err; });
  }
  return keyPromise;
}

export async function signStream(id, exp) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await getKey(), enc.encode(`${id}.${exp}`)));
  let binary = '';
  for (const b of sig) binary += String.fromCharCode(b);
  return b64url(binary);
}

export async function verifyStream(id, exp, sig) {
  if (!id || !sig || !/^\d{1,12}$/.test(exp || '')) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  const expected = await signStream(id, exp);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
