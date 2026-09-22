/**
 * Manual, offline verification of the Kundli flow state machine.
 *
 * This mocks Redis, the Gemini API, and the astrology engine's /api/finder
 * endpoint so it can run without any real credentials or network access -
 * it is exercising the STATE MACHINE LOGIC in lib/kundliFlow.js, not the
 * real external services. Run with: node test/kundliFlow.manual-test.js
 *
 * This is not wired into any CI - it's a repeatable way to sanity-check
 * the flow before turning ENABLE_KUNDLI_FLOW on anywhere.
 */

const assert = require('assert');

process.env.GEMINI_API_KEY = 'test-key';
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis.example';
process.env.REDIS_KV_REST_API_TOKEN = 'test-token';

// ---- In-memory fake Redis (just enough of the Upstash REST shape) ----
const fakeStore = new Map();
function fakeRedisResponse(url) {
  const path = decodeURIComponent(url.replace('https://fake-redis.example', ''));
  const parts = path.split('/').filter(Boolean);
  const [cmd, key, ...rest] = parts;
  if (cmd === 'get') return { result: fakeStore.has(key) ? fakeStore.get(key) : null };
  if (cmd === 'set') { fakeStore.set(key, decodeURIComponent(rest[0])); return { result: 'OK' }; }
  if (cmd === 'del') { fakeStore.delete(key); return { result: 1 }; }
  return { result: null };
}

// ---- Fake Gemini: deterministic canned answers per call type, driven by
// looking at the system instruction text so the test doesn't need a real
// model. ----
let geminiCallCount = 0;
function fakeGeminiResponse(requestBody) {
  geminiCallCount += 1;
  const sys = requestBody.systemInstruction.parts[0].text;
  const userText = requestBody.contents[0].parts[0].text;

  if (sys.includes('You extract birth-chart intake details')) {
    // Slot-extraction call - parse the userText ourselves (test-only stand-in for Gemini).
    const out = { name: '', date: '', time: '', place: '', purpose: '', phone: '' };
    if (/^Test Customer$/i.test(userText.trim())) out.name = 'Test Customer';
    if (/1995|15-08-1995/.test(userText)) out.date = '1995-08-15';
    if (/10:30/.test(userText)) out.time = '10:30';
    if (/Ambala/i.test(userText)) out.place = 'Ambala';
    if (/wealth/i.test(userText)) out.purpose = 'wealth';
    if (/^9876543210$/.test(userText.trim())) out.phone = '9876543210';
    return out;
  }
  if (sys.includes('WHAT TO DO THIS TURN')) {
    return { reply: 'MOCKED_REPLY' };
  }
  throw new Error('Unexpected Gemini call in test: ' + sys.slice(0, 80));
}

// ---- Fake fetch: routes by URL ----
let forceFinderFailure = false;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://fake-redis.example')) {
    return { ok: true, json: async () => fakeRedisResponse(u) };
  }
  if (u.includes('generativelanguage.googleapis.com')) {
    const body = JSON.parse(opts.body);
    const data = fakeGeminiResponse(body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }] }) };
  }
  if (u.includes('/api/finder')) {
    if (forceFinderFailure) {
      return { ok: false, status: 500, json: async () => ({ success: false, error: 'Finder processing failed' }) };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        astrology: { dasha: { output: { mahadashas: [{ lord: 'Saturn', start: '2020-01-01', end: '2039-01-01' }] } } },
        recommendation: { recommendation: { primary: { name: '7 Mukhi', planet: 'Saturn', reasons: ['matches the current Mahadasha lord Saturn'], variantId: '53971290292538' }, alternatives: [] } },
        shopify: { productHandle: '7-mukhi-rudraksha-premium-nepal', variantId: '53971290292538', price: 3500, available: true },
      }),
    };
  }
  throw new Error('Unexpected fetch in test: ' + u);
};

const { maybeHandleKundliTurn } = require('../lib/kundliFlow');

async function run() {
  const memoryId = 'test:conversation:1';

  // 1. Not applicable when disabled.
  let result = await maybeHandleKundliTurn({ enabled: false, type: 'dm', memoryId, message: 'I want a consultation', intent: { intent: 'consultation' } });
  assert.strictEqual(result, null, 'disabled flag must return null');

  // 2. Not applicable for comments even if enabled.
  result = await maybeHandleKundliTurn({ enabled: true, type: 'comment', memoryId, message: 'I want a consultation', intent: { intent: 'consultation' } });
  assert.strictEqual(result, null, 'comments must never enter the flow');

  // 3. Not applicable when enabled but intent isn't consultation and no session exists.
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId, message: 'hi', intent: { intent: 'general' } });
  assert.strictEqual(result, null, 'non-consultation intent with no session must return null');

  // 4. Entry: consultation intent starts collecting.
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId, message: 'I want astrology guidance', intent: { intent: 'consultation' } });
  assert.ok(result && result.reply, 'should start collecting and ask for a slot');
  assert.strictEqual(result.escalate, false);
  console.log('OK: flow entry ->', result.reply);

  // 5. Feed slots one at a time (each a separate inbound message/turn).
  const turns = ['Test Customer', '15-08-1995', '10:30', 'Ambala', 'wealth', '9876543210'];
  for (const turn of turns) {
    result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId, message: turn, intent: { intent: 'consultation' } });
    assert.ok(result, `turn "${turn}" should produce a result`);
    console.log(`OK: after "${turn}" ->`, result.reply, '| stage progressing');
  }

  // After all 5 slots, the chart should have generated and moved to choosing_category.
  assert.strictEqual(result.escalate, false, 'chart generation success should not escalate');

  // 6. Choose Rudraksha.
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId, message: 'Rudraksha please', intent: { intent: 'consultation' } });
  assert.ok(result.productInterest, 'should recommend a product');
  assert.strictEqual(result.escalate, false);
  console.log('OK: category chosen, recommendation ->', result.productInterest);

  // 7. Confirm ready to buy - Rudraksha has a known Shopify product page, so
  // the AI shares a plain PRODUCT PAGE link (never a pre-loaded cart link)
  // and does NOT escalate - the customer can buy it themselves.
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId, message: 'yes I want to buy this', intent: { intent: 'consultation' } });
  assert.strictEqual(result.escalate, false, 'rudraksha with a known product page should NOT escalate - self-serve');
  assert.ok(result.escalateReason.includes('kundli_ready_to_buy'), 'case notes should still be tagged for the lead sheet');
  assert.ok(!result.escalateReason.includes('/cart/'), 'must NEVER be a pre-loaded cart link');
  assert.ok(result.escalateReason.includes('/products/7-mukhi-rudraksha-premium-nepal'), 'should include the real product PAGE link');
  assert.ok(result.escalateReason.includes('Phone: 9876543210'), 'case notes should include the phone number collected earlier');
  console.log('OK: ready-to-buy -> self-serve product link, no escalation ->', result.escalateReason);

  // 8. Session should be cleared after completion - a fresh non-consultation message returns null again.
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId, message: 'thanks', intent: { intent: 'general' } });
  assert.strictEqual(result, null, 'session should be cleared after completion');
  console.log('OK: session cleared after completion');

  // 9. Cancel path on a fresh session.
  const memoryId2 = 'test:conversation:2';
  await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId2, message: 'astrology consultation please', intent: { intent: 'consultation' } });
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId2, message: 'never mind', intent: { intent: 'consultation' } });
  assert.strictEqual(result.escalate, false);
  assert.ok(/paused|Mannat/i.test(result.reply));
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId2, message: 'hi again', intent: { intent: 'general' } });
  assert.strictEqual(result, null, 'cancelled session should not resume on an unrelated message');
  console.log('OK: cancel path clears session');

  // 10. Gemstone branch: purpose="wealth" + dasha lord="Saturn" -> Yellow
  // Sapphire (pure purpose match, score 50) ties with and beats Blue
  // Sapphire (pure dasha match, score 50) by stable sort order - verifying
  // the scoring mirrors the real Rudraksha engine's weighting.
  const memoryId3 = 'test:conversation:3';
  for (const turn of ['astrology guidance please', ...turns]) {
    result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId3, message: turn, intent: { intent: 'consultation' } });
  }
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId3, message: 'gemstone please', intent: { intent: 'consultation' } });
  assert.strictEqual(result.productInterest, 'Yellow Sapphire (Pukhraj)', `expected Yellow Sapphire, got ${result.productInterest}`);
  console.log('OK: gemstone branch recommendation ->', result.productInterest);
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId3, message: 'yes lets buy', intent: { intent: 'consultation' } });
  assert.strictEqual(result.escalate, true);
  assert.ok(!/https?:\/\//.test(result.escalateReason), 'gemstones must never include any payment/cart link');
  assert.ok(result.escalateReason.includes('handed off to team'), 'gemstone buy-confirm should hand payment to a human, same as every other category');
  console.log('OK: gemstone buy-confirm escalates without a fabricated link ->', result.escalateReason);

  // 11. Astrology engine failure - must still respond and escalate with
  // what was collected, never leave the customer with silence.
  const memoryId4 = 'test:conversation:4';
  forceFinderFailure = true;
  for (const turn of ['astrology guidance please', ...turns]) {
    result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId4, message: turn, intent: { intent: 'consultation' } });
  }
  assert.strictEqual(result.escalate, true, 'engine failure must escalate');
  assert.strictEqual(result.escalateReason, 'kundli_engine_unavailable');
  assert.ok(result.reply && result.reply.length > 0, 'must still send the customer a reply on failure');
  forceFinderFailure = false;
  console.log('OK: astrology engine failure escalates gracefully with a reply ->', result.escalateReason);

  // 12. "Not sure" branch: when the customer doesn't know gemstone vs
  // Rudraksha, ask for budget, then give guidance (never forcing a choice
  // via a hardcoded price rule) and still require them to confirm one.
  const memoryId5 = 'test:conversation:5';
  for (const turn of ['astrology guidance please', ...turns]) {
    result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId5, message: turn, intent: { intent: 'consultation' } });
  }
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId5, message: "I'm not sure, you decide", intent: { intent: 'consultation' } });
  assert.strictEqual(result.escalate, false);
  console.log('OK: unsure -> asked for budget ->', result.reply);
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId5, message: '2000 rupees', intent: { intent: 'consultation' } });
  assert.strictEqual(result.escalate, false);
  console.log('OK: budget given -> guidance reply ->', result.reply);
  // Must still land back in the normal category choice - confirming Rudraksha now works.
  result = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: memoryId5, message: 'Rudraksha please', intent: { intent: 'consultation' } });
  assert.ok(result.productInterest, 'should still recommend a product after the budget detour');
  console.log('OK: budget detour -> confirmed Rudraksha ->', result.productInterest);

  console.log(`\nAll assertions passed. (${geminiCallCount} mocked Gemini calls)`);
}

run().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
