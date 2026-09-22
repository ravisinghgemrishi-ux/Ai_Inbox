/**
 * Manual, offline verification of the consultation-payment flow.
 *
 * Mocks Redis and the Gemini API so it can run without real credentials or
 * network access - it exercises the STATE MACHINE LOGIC in
 * lib/consultationFlow.js, not the real external services.
 * Run with: node test/consultationFlow.manual-test.js
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

// ---- Fake Gemini: deterministic canned answers per call type ----
let geminiCallCount = 0;
function fakeGeminiResponse(requestBody) {
  geminiCallCount += 1;
  const sys = requestBody.systemInstruction.parts[0].text;
  const userText = requestBody.contents[0].parts[0].text;

  if (sys.includes("You extract a customer's name and phone number")) {
    const out = { name: '', phone: '' };
    const nameMatch = userText.match(/my name is ([A-Za-z ]+)/i);
    if (nameMatch) out.name = nameMatch[1].trim();
    if (/^Rohit Sharma$/i.test(userText.trim())) out.name = 'Rohit Sharma';
    if (/^Priya$/i.test(userText.trim())) out.name = 'Priya';
    const phoneMatch = userText.match(/\b(\d{10})\b/);
    if (phoneMatch) out.phone = phoneMatch[1];
    return out;
  }
  if (sys.includes('WHAT TO DO THIS TURN')) {
    return { reply: 'MOCKED_REPLY' };
  }
  throw new Error('Unexpected Gemini call in test: ' + sys.slice(0, 80));
}

// ---- Fake fetch: routes by URL ----
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
  throw new Error('Unexpected fetch in test: ' + u);
};

const { maybeHandleConsultationPayment } = require('../lib/consultationFlow');

async function run() {
  const memoryId = 'test:consultation:1';

  // 1. Disabled -> null, no matter what.
  let result = await maybeHandleConsultationPayment({ enabled: false, type: 'dm', memoryId, message: 'I want to pay for the 499 plan', intent: { intent: 'purchase' } });
  assert.strictEqual(result, null, 'disabled flag must return null');

  // 2. Comments never enter this flow, even enabled + a plan number present.
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'comment', memoryId, message: 'I want to pay for the 499 plan', intent: { intent: 'purchase' } });
  assert.strictEqual(result, null, 'comments must never enter the flow');

  // 3. A generic plan-info question (no buying language) must NOT start the flow.
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId, message: 'whats included in the 499 plan?', intent: { intent: 'consultation' } });
  assert.strictEqual(result, null, 'plain info question about a plan must fall through to the normal reply');

  // 4. Plan number with no plan-shaped price at all -> null (not a plan mention).
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId, message: 'hi there', intent: { intent: 'general_engagement' } });
  assert.strictEqual(result, null, 'no plan number -> not applicable');

  // 5. Entry: explicit intent to pay for the 1,199 plan starts collecting contact.
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId, message: 'I want to pay for the 1,199 plan please', intent: { intent: 'purchase' } });
  assert.ok(result && result.reply, 'should start collecting contact details');
  assert.strictEqual(result.escalate, false);
  assert.strictEqual(result.productInterest, 'Consultation - Rs 1,199');
  console.log('OK: flow entry (1,199 plan) ->', result.reply);

  // 6. Give only the name -> should still ask for phone, never share the link.
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId, message: 'my name is Rohit Sharma', intent: { intent: 'purchase' } });
  assert.ok(!/rzp\.io/.test(result.reply), 'must not share the link before phone is known');
  assert.strictEqual(result.escalate, false);
  console.log('OK: name given, still asking for phone ->', result.reply);

  // 7. Give the phone -> link should now be shared, case logged, not yet escalated.
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId, message: '9876543210', intent: { intent: 'purchase' } });
  assert.strictEqual(result.escalate, false, 'sharing the link itself should not escalate');
  assert.ok(result.escalateReason.includes('Name: Rohit Sharma'), 'case file should include the name');
  assert.ok(result.escalateReason.includes('Phone: 9876543210'), 'case file should include the phone');
  assert.ok(result.escalateReason.includes('Astrologer_Consulatation_1199'), 'case file should include the real Rs 1,199 payment link');
  console.log('OK: contact complete -> link shared, case logged ->', result.escalateReason);

  // 8. Customer replies "paid" -> acknowledged, escalated (so the team can verify + follow up), session cleared.
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId, message: 'Done, payment kar diya hai', intent: { intent: 'general_engagement' } });
  assert.strictEqual(result.escalate, true, 'a receipt/paid confirmation should escalate to the team');
  assert.ok(result.escalateReason.includes('Customer indicates payment is done.'));
  console.log('OK: payment confirmation -> escalated for team follow-up ->', result.escalateReason);

  // 9. Session cleared after that - a fresh unrelated message returns null again.
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId, message: 'thanks!', intent: { intent: 'general_engagement' } });
  assert.strictEqual(result, null, 'session should be cleared after the follow-up turn');
  console.log('OK: session cleared after follow-up');

  // 10. Cancel mid-flow.
  const memoryId2 = 'test:consultation:2';
  await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId: memoryId2, message: 'I want to book the 199 plan', intent: { intent: 'purchase' } });
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId: memoryId2, message: 'actually never mind', intent: { intent: 'purchase' } });
  assert.strictEqual(result.escalate, false);
  assert.ok(/Mannat/i.test(result.reply));
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId: memoryId2, message: 'hi again', intent: { intent: 'general_engagement' } });
  assert.strictEqual(result, null, 'cancelled session should not resume on an unrelated message');
  console.log('OK: cancel path clears session');

  // 11. Everything given in ONE message (name + phone + plan intent together) should skip straight to sharing the link.
  const memoryId3 = 'test:consultation:3';
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId: memoryId3, message: 'I want to pay for the 4999 plan, my name is Priya, number is 9123456780', intent: { intent: 'purchase' } });
  assert.strictEqual(result.escalate, false);
  assert.ok(result.escalateReason.includes('Name: Priya'));
  assert.ok(result.escalateReason.includes('Phone: 9123456780'));
  assert.ok(result.escalateReason.includes('Astrologer_Consulatation_4999'));
  console.log('OK: single-message fast path (name+phone+plan together) ->', result.escalateReason);

  // 12. A plan number with a wrong/garbled price close to a real one (e.g. 599) must not falsely match.
  const memoryId4 = 'test:consultation:4';
  result = await maybeHandleConsultationPayment({ enabled: true, type: 'dm', memoryId: memoryId4, message: 'I want to pay 599 rupees', intent: { intent: 'purchase' } });
  assert.strictEqual(result, null, 'a price that is not one of the 5 real plans must not start the flow');
  console.log('OK: unrecognised price does not falsely start the flow');

  console.log(`\nAll assertions passed. (${geminiCallCount} mocked Gemini calls)`);
}

run().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
