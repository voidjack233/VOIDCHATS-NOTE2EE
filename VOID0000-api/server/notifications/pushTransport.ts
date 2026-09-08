import dns from 'node:dns/promises';
import https from 'node:https';
import webPush, { type PushSubscription } from 'web-push';
import { isPublicNetworkAddress } from '../utils/publicNetworkAddress.js';

const MAX_ACTIVE = 8;
const MAX_WAITING = 64;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
let active = 0;
const waiting: Array<() => void> = [];

export function validatePushSubscription(value: unknown): PushSubscription {
  const invalid = () => Object.assign(new Error('Invalid or unsupported push subscription'), { status: 400 });
  if (!value || typeof value !== 'object') throw invalid();
  const { endpoint, keys } = value as Partial<PushSubscription>;
  if (typeof endpoint !== 'string' || endpoint.length > 2048 || !keys) throw invalid();
  let url: URL;
  try { url = new URL(endpoint); } catch { throw invalid(); }
  const host = url.hostname;
  const supported = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (!supported || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) {
    throw invalid();
  }
  for (const [key, bytes] of [[keys.p256dh, 65], [keys.auth, 16]] as const) {
    if (typeof key !== 'string' || key.length > 128 || !/^[A-Za-z0-9_-]+={0,2}$/.test(key) ||
      Buffer.from(key, 'base64url').length !== bytes) throw invalid();
  }
  if (Buffer.from(keys.p256dh, 'base64url')[0] !== 4) throw invalid();
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export async function withPushCapacity<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING) throw new Error('Push delivery queue full');
    await new Promise<void>((resolve, reject) => {
      const start = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error('Push delivery queue timed out'));
      }, TIMEOUT_MS);
      waiting.push(start);
    });
  } else active++;
  try { return await task(); } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

export async function sendPrivatePush(subscription: PushSubscription, body: string): Promise<void> {
  const validated = validatePushSubscription(subscription);
  const details = webPush.generateRequestDetails(validated, body);
  const url = new URL(validated.endpoint);
  await new Promise<void>((resolve, reject) => {
    const req = https.request(url, {
      method: details.method,
      headers: details.headers,
      agent: false,
      lookup(hostname, options, callback) {
        void dns.lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
          if (!addresses.length || addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
            callback(new Error('Blocked push destination'), '', 4);
          } else if (options.all) {
            callback(null, addresses);
          } else {
            callback(null, addresses[0].address, addresses[0].family);
          }
        }, (error) => callback(error, '', 4));
      },
    }, (res) => {
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) req.destroy(new Error('Push response too large'));
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(Object.assign(new Error('Push provider rejected delivery'), { statusCode: res.statusCode }));
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error('Push delivery timed out')), TIMEOUT_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(details.body);
  });
}
