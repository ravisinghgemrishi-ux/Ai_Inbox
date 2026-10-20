// Sales interview flow (2026-10-20). Fake Redis, no network.
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis.test';
process.env.REDIS_KV_REST_API_TOKEN = 'x';
const store = {}; const hashes = {};
global.fetch = async (url) => {
  const [cmd, key, a, b] = new URL(url).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let result = null;
  if (cmd === 'get') result = store[key] ?? null;
  else if (cmd === 'set') { store[key] = a; result = 'OK'; }
  else if (cmd === 'hset') { (hashes[key] = hashes[key] || {})[a] = b; result = 1; }
  else if (cmd === 'hgetall') result = Object.entries(hashes[key] || {}).flat();
  return { ok: true, json: async () => ({ result }) };
};
const iv = require('../lib/salesInterview');
(async () => {
  const sent = []; const logs = [];
  const send = async (t) => sent.push(t); const log = async (r) => logs.push(r);
  await iv.start({ route: 'neel', person: 'Neel Das', send });
  assert.ok(/Q1\//.test(sent[1]));
  assert.ok(await iv.isActive('neel'));
  await iv.handleReply({ route: 'neel', person: 'Neel Das', text: '1', send, log });
  assert.ok(/Q2\//.test(sent.at(-1)));
  await iv.handleReply({ route: 'neel', person: 'Neel Das', text: 'Max 5% de sakti hai', send, log });
  await iv.handleReply({ route: 'neel', person: 'Neel Das', text: 'skip', send, log });
  await iv.handleReply({ route: 'neel', person: 'Neel Das', text: 'back', send, log });
  assert.ok(/Q3\//.test(sent.at(-1)), 'back goes to the skipped question');
  await iv.handleReply({ route: 'neel', person: 'Neel Das', text: 'pause', send, log });
  await iv.handleReply({ route: 'neel', person: 'Neel Das', text: 'hi', send, log });
  assert.ok(/Q3\//.test(sent.at(-1)), 'resumes at the same question, "hi" not taken as an answer');
  await iv.handleReply({ route: 'neel', person: 'Neel Das', text: '2 ad wala stone', send, log });
  const ans = await iv.answers('neel');
  assert.deepStrictEqual(ans.map((x) => x.q), [1, 2, 3]);
  assert.ok(/Own answer: Max 5%/.test(ans[1].answer));
  assert.ok(/Option 2: .*Note: ad wala stone/.test(ans[2].answer));
  assert.strictEqual(logs.length, 3);
  assert.strictEqual(logs[0].type, 'sales_training');
  console.log('Sales interview tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

// Round 2: follow-up set after the main set is done.
(async () => {
  await new Promise((r) => setTimeout(r, 50));
  const iv2 = require('../lib/salesInterview');
  const sent = []; const logs = [];
  const send = async (t) => sent.push(t); const log = async (r) => logs.push(r);
  // pretend main finished the old way (no doneSets field)
  store['gemrishi:interview:yogesh'] = JSON.stringify({ idx: 57, done: true });
  assert.strictEqual(await iv2.nextSet('yogesh'), 'followup');
  await iv2.start({ route: 'yogesh', person: 'Yogesh', send });
  assert.ok(/purane rules se alag/.test(sent[0]) && /Q1\/6/.test(sent[1]));
  for (const t of ['2', '2 Ambala Cantt, Sadar Bazar 133001', '1', '1', '3', '1']) await iv2.handleReply({ route: 'yogesh', person: 'Yogesh', text: t, send, log });
  assert.ok(/Saare 6 sawal/.test(sent.at(-1)));
  assert.strictEqual(await iv2.nextSet('yogesh'), '');
  const fa = await iv2.answers('yogesh', 'followup');
  assert.strictEqual(fa.length, 6);
  assert.ok(/Note: Ambala Cantt/.test(fa[1].answer));
  assert.ok(/^FQ1 /.test(logs[0].message));
  console.log('Follow-up round tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
