// 2026-10-24: Mannat must go quiet the moment a person replies in the chat -
// including photos/voice notes, replies hidden behind a later Mannat message,
// and brand-new chats. Run: node test/takeover-signal.manual-test.js
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis';
process.env.REDIS_KV_REST_API_TOKEN = 't';

const store = new Map();
let zernioMessages = [];
global.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://fake-redis/')) {
    const [cmd, key, val] = u.replace('https://fake-redis/', '').split('/').map(decodeURIComponent);
    let result = null;
    if (cmd === 'get') result = store.has(key) ? store.get(key) : null;
    if (cmd === 'set') { store.set(key, val); result = 'OK'; }
    if (cmd === 'del') { store.delete(key); result = 1; }
    return { ok: true, json: async () => ({ result }) };
  }
  if (u.includes('/inbox/conversations/') && u.includes('/messages')) {
    const sorted = [...zernioMessages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { ok: true, status: 200, text: async () => JSON.stringify({ messages: sorted }), json: async () => ({ messages: sorted }) };
  }
  throw new Error('unexpected fetch ' + u);
};

const g = require('../lib/humanTakeoverGuard');
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const mannat = (text, min) => ({ direction: 'outgoing', message: text, createdAt: ago(min), sentVia: 'api', metadata: { sentVia: 'api' } });
const customer = (text, min) => ({ direction: 'incoming', message: text, createdAt: ago(min), sentVia: null });
const appMsg = (text, min, extra = {}) => ({ direction: 'outgoing', message: text, createdAt: ago(min), sentVia: null, metadata: { source: 'whatsapp_business_app' }, ...extra });
const check = (memoryId) => g.checkHumanTakeover({ apiKey: 'k', conversationId: memoryId, accountId: 'a', memoryId });

(async () => {
  // A. Team member sends a PHOTO from the WhatsApp Business app -> quiet.
  let id = 'whatsapp:A';
  await g.markAiSent(id, 'Hello! Which gemstone?');
  zernioMessages = [customer('price?', 30), mannat('Hello! Which gemstone?', 29), appMsg('', 10, { attachments: [{ type: 'image' }] }), customer('ok thanks', 1)];
  let r = await check(id);
  assert.strictEqual(r.silence, true, 'photo from the app must silence Mannat');
  console.log('OK A: team photo/video/voice note -> Mannat quiet');

  // B. Team reply hidden behind a later Mannat message (old bug) -> quiet.
  id = 'whatsapp:B';
  await g.markAiSent(id, 'Sure, sharing details.');
  zernioMessages = [customer('rate?', 20), appMsg('Sir 5 ratti 25000 ka hai', 12), mannat('Sure, sharing details.', 11), customer('theek hai', 1)];
  r = await check(id);
  assert.strictEqual(r.silence, true, 'team reply before Mannat\'s last message must still count');
  console.log('OK B: team reply not "latest" -> still quiet');

  // C. Brand-new chat (no baseline) where the team already replied -> quiet.
  id = 'instagram:C';
  zernioMessages = [customer('Can you check the price of a product?', 15), { direction: 'outgoing', message: 'Hi! It is 21 carat, sending video', createdAt: ago(8), sentVia: null }, customer('ok', 1)];
  r = await check(id);
  assert.strictEqual(r.silence, true, 'first check in a new chat must not skip a human reply');
  console.log('OK C: new chat, human already replied -> quiet (no baseline skip)');

  // D. Only Mannat - an OLDER api message with slightly different stored text
  // must NOT silence her (only the newest is judged by fingerprint).
  id = 'whatsapp:D';
  await g.markAiSent(id, 'Would you like it loose or in a ring?');
  zernioMessages = [customer('hi', 30), mannat('Hello!  We have Sri Lankan Neelam (formatted)', 29), customer('loose', 5), mannat('Would you like it loose or in a ring?', 4), customer('ring', 1)];
  r = await check(id);
  assert.strictEqual(r.silence, false, 'older unmatched Mannat text must not cause a false takeover');
  console.log('OK D: only Mannat in chat -> she replies normally');

  // E. After the 4-working-hour resume, the same old human reply must not
  // silence her again; a NEW human reply must.
  id = 'whatsapp:E';
  zernioMessages = [customer('price?', 600), appMsg('Ji sir', 590), customer('?', 2)];
  r = await check(id);
  assert.strictEqual(r.silence, true);
  store.set(`gemrishi:human-active:${id}`, JSON.stringify({ since: ago(590), lastHumanAt: ago(590), pendingSince: ago(60 * 24 * 3) }));
  r = await check(id);
  assert.strictEqual(r.resumed, true, 'resumes after 4 working hours of waiting');
  r = await check(id);
  assert.strictEqual(r.silence, false, 'old human reply does not re-silence after resume');
  zernioMessages.push(appMsg('Sir video bhej raha hoon', 0.5));
  r = await check(id);
  assert.strictEqual(r.silence, true, 'a new human reply silences again');
  assert.strictEqual(await g.isHumanActive(id), true);
  console.log('OK E: resume after 4 working hours; new team reply -> quiet again');

  // F. Pre-send check: a person replies while Mannat is typing -> stop.
  id = 'whatsapp:F';
  const started = Date.now();
  zernioMessages = [customer('kitne ka hai', 0.2)];
  assert.strictEqual(await g.humanRepliedSince({ apiKey: 'k', conversationId: id, accountId: 'a', memoryId: id, sinceMs: started - 5000 }), false);
  zernioMessages.push({ direction: 'outgoing', message: 'Sir main batata hoon', createdAt: new Date().toISOString(), metadata: { source: 'whatsapp_business_app' } });
  assert.strictEqual(await g.humanRepliedSince({ apiKey: 'k', conversationId: id, accountId: 'a', memoryId: id, sinceMs: started - 5000 }), true);
  assert.strictEqual(await g.isHumanActive(id), true);
  console.log('OK F: team reply while Mannat is typing -> rest of her reply dropped');

  // G. Real-time message.sent with only a voice note -> quiet.
  id = 'whatsapp:G';
  r = await g.recordOutgoingMessage({ memoryId: id, text: '', message: { direction: 'outgoing', message: '', attachments: [{ type: 'audio' }], metadata: { source: 'whatsapp_business_app' } } });
  assert.strictEqual(r.human, true);
  console.log('OK G: real-time voice note from team -> quiet');

  console.log('\nAll takeover-signal assertions passed.');
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
