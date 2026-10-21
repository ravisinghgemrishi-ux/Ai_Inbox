// 2026-10-21: lead alerts that Meta failed to deliver are re-sent on check-in.
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis.test';
process.env.REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZERNIO_API_KEY = 'k';
const store = {}; const sent = [];
const now = new Date().toISOString();
const msgs = [
  { id: 'm3', direction: 'outgoing', deliveryStatus: 'failed', message: '🔔 New lead for Yogesh (Mannat AI)\nName: B', createdAt: now },
  { id: 'm2', direction: 'outgoing', deliveryStatus: 'read', message: '🔔 New lead for Yogesh (Mannat AI)\nName: OK', createdAt: now },
  { id: 'm1', direction: 'outgoing', deliveryStatus: 'failed', message: '🔔 New lead for Yogesh (Mannat AI)\nName: A', createdAt: now },
  { id: 'm0', direction: 'outgoing', deliveryStatus: 'failed', message: '🔔 New lead old', createdAt: '2026-01-01T00:00:00Z' },
];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'fake-redis.test') {
    const [cmd, key, val, ...rest] = decodeURIComponent(u.pathname).split('/').filter(Boolean);
    let result = null;
    if (cmd === 'get') result = store[key] ?? null;
    else if (cmd === 'set') { if (rest.includes('NX') && key in store) result = null; else { store[key] = val; result = 'OK'; } }
    else if (cmd === 'lrange') result = [];
    else result = 1;
    return { ok: true, json: async () => ({ result }) };
  }
  if ((opts.method || 'GET') === 'GET') return { ok: true, json: async () => ({ status: 'success', messages: msgs }) };
  sent.push(JSON.parse(opts.body || '{}').message || JSON.parse(opts.body || '{}').text);
  return { ok: true, json: async () => ({}) };
};
const h = require('../lib/handoff');
(async () => {
  const r = await h.staffCheckIn({ route: 'yogesh', conversationId: '917015868891', accountId: 'acc' });
  assert.strictEqual(r.delivered, 2, JSON.stringify(r));
  assert.ok(/2 leads waiting/.test(sent[0]) && /Name: A/.test(sent[1]) && /Name: B/.test(sent[2]), JSON.stringify(sent));
  sent.length = 0;
  const r2 = await h.staffCheckIn({ route: 'yogesh', conversationId: '917015868891', accountId: 'acc' });
  assert.strictEqual(r2.delivered, 0); assert.ok(r2.quiet, 'not re-sent twice');
  console.log('resend-failed tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
