// Budget routing (2026-10-20). Run: node test/budget-routing.manual-test.js
// Uses an in-memory fake of the Upstash REST API - no network.
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis.test';
process.env.REDIS_KV_REST_API_TOKEN = 'x';
const store = {};
global.fetch = async (url) => {
  const parts = decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
  const [cmd, key, val] = parts;
  let result = null;
  if (cmd === 'get') result = store[key] ?? null;
  else if (cmd === 'set') { store[key] = val; result = 'OK'; }
  else if (cmd === 'incr') { store[key] = String(Number(store[key] || 0) + 1); result = Number(store[key]); }
  return { ok: true, json: async () => ({ result }) };
};
const h = require('../lib/handoff');

for (const [b, v] of [['50000', 50000], ['₹25,000', 25000], ['40-45k', 45000], ['1.5 lakh', 150000], ['15000 hzr tak', 15000], ['not given', 0], ['5 ratti 20k', 20000]]) {
  assert.strictEqual(h.parseBudget(b), v, b);
}

(async () => {
  const a = await h.assignRoute({ contact: 'c1', platform: 'whatsapp', customerBudget: '20k' });
  const b = await h.assignRoute({ contact: 'c2', platform: 'instagram', customerBudget: '' });
  const c = await h.assignRoute({ contact: 'c3', platform: 'whatsapp', customerBudget: '49999' });
  assert.deepStrictEqual([a, b, c], ['yogesh', 'vishvas', 'yogesh'], 'alternates one by one, under 50k');
  // 2026-10-24 (Ravi): Rs 50,000 or more -> Neel.
  assert.strictEqual(await h.assignRoute({ contact: 'c3b', platform: 'whatsapp', customerBudget: '50000' }), 'neel', '50k exactly -> Neel');
  assert.strictEqual(await h.assignRoute({ contact: 'c1', platform: 'whatsapp', customerBudget: '30k' }), 'yogesh', 'same customer keeps same person');
  assert.strictEqual(await h.assignRoute({ contact: 'c4', platform: 'whatsapp', customerBudget: '60k' }), 'neel', 'above 50k -> Neel');
  assert.strictEqual(await h.assignRoute({ contact: 'c1', platform: 'whatsapp', customerBudget: '1 lakh' }), 'neel', 'budget went up -> Neel');
  assert.strictEqual(await h.assignRoute({ contact: 'c5', platform: 'whatsapp', customerBudget: '10k' }, { escalateToNeel: true }), 'neel');
  assert.ok(h.needsNeel({ escalate: true, escalateReason: 'refund request' }));
  assert.ok(h.needsNeel({ intent: 'b2b_inquiry' }));
  assert.ok(!h.needsNeel({ escalate: true, escalateReason: 'customer_asked_for_a_call' }), 'a call request follows the budget rule');
  const at = (h, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m)); // UTC
  assert.strictEqual(h.isLateNight(at(15, 0)), true, '20:30 IST');
  assert.strictEqual(h.isLateNight(at(17, 30)), true, '23:00 IST');
  assert.strictEqual(h.isLateNight(at(3, 0)), true, '08:30 IST');
  assert.strictEqual(h.isLateNight(at(5, 0)), false, '10:30 IST');
  assert.strictEqual(h.isLateNight(at(14, 0)), false, '19:30 IST');
  assert.deepStrictEqual(h.LATE_NIGHT_ROUTES, ['neel', 'yogesh', 'vishvas']);
  console.log('Budget routing tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
