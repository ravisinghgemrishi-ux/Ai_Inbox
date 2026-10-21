// 2026-10-21: one Meta form arriving on Instagram DM and WhatsApp -> one forward.
// Run: node test/form-dedupe.manual-test.js
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake.redis';
process.env.REDIS_KV_REST_API_TOKEN = 't';
const store = new Map();
global.fetch = async (url) => {
  const parts = String(url).replace('https://fake.redis/', '').split('/').map((p) => p);
  const [cmd, rawKey, rawVal, ...rest] = parts;
  const key = decodeURIComponent(rawKey || ''); const val = decodeURIComponent(rawVal || '');
  let result = null;
  if (cmd === 'get') result = store.has(key) ? store.get(key) : null;
  if (cmd === 'set') { if (rest.includes('NX') && store.has(key)) result = null; else { store.set(key, val); result = 'OK'; } }
  return { ok: true, json: async () => ({ result }) };
};
const wh = require('../api/webhook.js');
(async () => {
  assert.strictEqual(await wh._formLeadDedupeKey('GR-1', '+91 98112 59585'), '', 'first channel owns the lead');
  assert.strictEqual(await wh._formLeadDedupeKey('GR-2', '9811259585'), 'GR-1', 'second channel linked to the first');
  assert.strictEqual(await wh._formLeadDedupeKey('GR-2', ''), 'GR-1', 'follow-up messages on the second channel stay linked');
  assert.strictEqual(await wh._formLeadDedupeKey('GR-1', ''), '', 'owner follow-ups use their own id');
  assert.strictEqual(await wh._formLeadDedupeKey('GR-9', ''), '', 'normal chats untouched');
  const h = require('../lib/handoff');
  assert.strictEqual(h._internal.customerKey({ grId: 'GR-2', dedupeKey: 'GR-1' }), 'GR-1');
  console.log('form dedupe tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
