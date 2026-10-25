// Failed short-format alerts must be re-sent on check-in. Run: node test/resend-new-format.manual-test.js
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis.test';
process.env.REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZERNIO_API_KEY = 'x';
const store = {};
const failedMsg = (id, body) => ({ id, direction: 'outgoing', deliveryStatus: 'failed', message: body, createdAt: new Date().toISOString() });
global.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname.includes('zernio')) {
    return { ok: true, json: async () => ({ messages: [
      failedMsg('w1', '🔔 Lakshya, naya lead: *Rohit Baimaniya, +91 96257 37873* (whatsapp)\nMaine inse baat kar li hai.'),
      failedMsg('w2', '🔔 New lead for Lakshya (Mannat AI)\nName: Old Lead\nPhone: +91 90000 11111'),
      failedMsg('w3', 'random failed text'),
    ] }) };
  }
  const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean);
  const [cmd, key] = parts; let result = null;
  if (cmd === 'set') { const nx = parts.includes('NX'); if (nx && store[key]) result = null; else { store[key] = '1'; result = 'OK'; } }
  return { ok: true, json: async () => ({ result }) };
};
const h = require('../lib/handoff');
(async () => {
  const out = await h._internal.failedAlerts({ route: 'lakshya', conversationId: 'c', accountId: 'a' });
  assert.strictEqual(out.length, 2, 'both formats re-sent, random text ignored');
  assert.ok(out.some((t) => /naya lead/.test(t)) && out.some((t) => /New lead/.test(t)));
  console.log('resend new-format tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
