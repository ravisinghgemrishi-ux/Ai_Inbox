// Manual test for the 2026-10-16 takeover fix. Run: node test/humanTakeover.manual-test.js
// Uses an in-memory fake Redis (via a fetch stub); no network, no Zernio.
const assert = require('assert');

process.env.REDIS_KV_REST_API_URL = 'https://fake-redis';
process.env.REDIS_KV_REST_API_TOKEN = 't';
process.env.HUMAN_TYPING_DELAY_SCALE = '0';

const store = new Map();
global.fetch = async (url) => {
  const parts = String(url).replace('https://fake-redis/', '').split('/').map(decodeURIComponent);
  const [cmd, key, val] = parts;
  let result = null;
  if (cmd === 'get') result = store.has(key) ? store.get(key) : null;
  if (cmd === 'set') { store.set(key, val); result = 'OK'; }
  if (cmd === 'del') { store.delete(key); result = 1; }
  return { ok: true, json: async () => ({ result }) };
};

const { markAiSent, recordOutgoingMessage, isHumanActive } = require('../lib/humanTakeoverGuard');
const { sendLikeHuman } = require('../lib/humanTyping');

(async () => {
  const chat = 'instagram:conv-1';

  // 1. Mannat's own sent message echoed back as message.sent -> NOT a takeover.
  await markAiSent(chat, 'Namaste! Main Mannat hoon.');
  let r = await recordOutgoingMessage({ memoryId: chat, text: '  namaste!  main mannat hoon. ' });
  assert.strictEqual(r.human, false, 'own message must not trigger takeover');
  assert.strictEqual(await isHumanActive(chat), false);

  // 2. Team member types in Instagram -> takeover, immediately.
  r = await recordOutgoingMessage({ memoryId: chat, text: 'Ji sir, main Yogesh, aapko call karta hoon' });
  assert.strictEqual(r.human, true, 'team message must trigger takeover');
  assert.strictEqual(await isHumanActive(chat), true);
  assert.ok(store.get('gemrishi:takeover-baseline-v2:instagram:conv-1'), 'baseline set so it is not wiped');

  // 3. The exact bug: Mannat was mid-typing when the team member jumped in.
  const chat2 = 'instagram:conv-2';
  const sent = [];
  let bubble = 0;
  const res = await sendLikeHuman({
    reply: 'First part of a long reply about Neelam stones.\n\nSecond part with the price.\n\nThird part asking for the number.',
    beforeSend: (t) => markAiSent(chat2, t),
    shouldStop: () => isHumanActive(chat2),
    send: async (t) => {
      sent.push(t);
      bubble += 1;
      // Team member replies right after Mannat's first bubble lands.
      if (bubble === 1) await recordOutgoingMessage({ memoryId: chat2, text: 'Main dekh leta hoon - Neel' });
    },
  });
  assert.strictEqual(res.stopped, true, 'reply must stop when a human takes over');
  assert.strictEqual(sent.length, 1, 'only the bubble sent before the human message goes out');

  // 4. Normal chat with no human -> full reply goes out.
  const chat3 = 'instagram:conv-3';
  const sent3 = [];
  const res3 = await sendLikeHuman({
    reply: 'Hello there friend.\n\nHere is the price info.',
    beforeSend: (t) => markAiSent(chat3, t),
    shouldStop: () => isHumanActive(chat3),
    send: async (t) => {
      sent3.push(t);
      await recordOutgoingMessage({ memoryId: chat3, text: t }); // Mannat's own echo
    },
  });
  assert.ok(!res3.stopped, 'own echoes must never stop Mannat');
  assert.strictEqual(sent3.length, 2);

  console.log('All human-takeover tests passed');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
