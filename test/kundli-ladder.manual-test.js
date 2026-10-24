/**
 * Qualification ladder (2026-10-24, Ravi): free reading stays WARM, a budget
 * after the recommendation goes to sales, prediction-seekers are offered the
 * paid Rs 499 reading, and only a PAID customer is escalated.
 * Run: node test/kundli-ladder.manual-test.js  (offline - mocks everything)
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
    if (/^Anil Kumar/i.test(userText.trim())) { out.name = 'Anil Kumar'; out.date = '1974-12-12'; out.place = 'Ghaziabad'; }
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
let forceGeocodeMiss = false;
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
    if (forceGeocodeMiss) {
      // Mirrors the real astrology engine's actual 404 shape (see Vercel
      // logs: "/api/geocode returned 404 - Birth place not found").
      return { ok: false, status: 404, json: async () => ({ success: false, error: '/api/geocode returned 404 - Birth place not found' }) };
    }
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
  if (u.includes('docs.google.com')) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  throw new Error('Unexpected fetch in test: ' + u);
};


const { maybeHandleKundliTurn, _internal } = require('../lib/kundliFlow');
const ask = (memoryId, message, extra = {}) => maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId, message, intent: { intent: 'consultation' }, platform: 'whatsapp', knownPhone: '919560963312', ...extra });

async function run() {
  // Regex sanity
  assert.ok(_internal.PREDICTION_ASK.test('meri shaadi kab hogi'));
  assert.ok(_internal.PREDICTION_ASK.test('job kab lagegi'));
  assert.ok(!_internal.PREDICTION_ASK.test('gemstone please'));
  assert.ok(_internal.BUDGET_OR_SIZE.test('budget 20000') && _internal.BUDGET_OR_SIZE.test('5 ratti') && _internal.BUDGET_OR_SIZE.test('15k'));
  assert.strictEqual(_internal.approxBirthTime('time nahi pata but evening ka hai'), '18:00');
  console.log('OK: regexes + approx time');

  // A. Unknown birth time no longer loops (real case 24 Oct, Anil ji)
  const m1 = 'ladder:1';
  let r = await ask(m1, 'kundli dekh ke stone batao');
  r = await ask(m1, 'Anil Kumar DOB 12-12-1974 Ghaziabad, time nahi pata but evening ka hai');
  assert.strictEqual(r.leadStatus, 'WARM', 'collecting stays WARM');
  r = await ask(m1, 'Nahi pata');
  assert.strictEqual(r.leadStatus, 'WARM');
  r = await ask(m1, 'wealth');
  assert.strictEqual(r.productInterest, 'Kundli Consultation', `chart should generate with approx time, got ${r.productInterest}`);
  assert.strictEqual(r.escalate, false);
  console.log('OK: unknown birth time -> approximate time, chart generated, WARM');

  // B. Recommendation stays WARM and asks the filter question
  r = await ask(m1, 'gemstone please');
  assert.strictEqual(r.leadStatus, 'WARM');
  assert.strictEqual(r.escalate, false);
  console.log('OK: recommendation WARM ->', r.productInterest);

  // C. Prediction question after the reading -> paid pitch (not escalated)
  r = await ask(m1, 'meri shaadi kab hogi?');
  assert.ok(/499/.test(r.reply) && /adjust/i.test(r.reply), r.reply);
  assert.strictEqual(r.leadStatus, 'WARM'); assert.strictEqual(r.escalate, false);
  console.log('OK: prediction ask -> Rs 499 pitch');

  // D. Yes -> link (phone known on WhatsApp), still WARM
  r = await ask(m1, 'haan bhej do');
  assert.ok(r.reply.includes('rzp.io/rzp/Astrologer_Consulatation_1'), r.reply);
  assert.strictEqual(r.leadStatus, 'WARM'); assert.strictEqual(r.escalate, false);
  console.log('OK: yes -> Rs 499 payment link');

  // E. Screenshot -> PAID, HOT, escalated with priority
  r = await ask(m1, '[image]');
  assert.strictEqual(r.leadStatus, 'HOT'); assert.strictEqual(r.escalate, true);
  assert.ok(/PAID kundli consultation/.test(r.escalateReason) && /919560963312/.test(r.escalateReason), r.escalateReason);
  console.log('OK: payment screenshot -> HOT + escalated ->', r.escalateReason.slice(0, 70));

  // F. Decline path and nag limit
  const m2 = 'ladder:2';
  for (const t of ['astrology guidance please', 'Test Customer', '15-08-1995', '10:30', 'Ambala', 'wealth']) await ask(m2, t);
  await ask(m2, 'gemstone');
  r = await ask(m2, 'job kab lagegi?');
  assert.ok(/499/.test(r.reply));
  r = await ask(m2, 'nahi');
  assert.ok(/Koi baat nahi|No problem/.test(r.reply)); assert.strictEqual(r.escalate, false);
  r = await ask(m2, 'videsh kab jaunga?');
  assert.ok(/link/.test(r.reply) && r.escalate === false, 'soft reminder, no repeat pitch');
  r = await ask(m2, 'link');
  assert.ok(r.reply.includes('rzp.io'), '"link" later still sends it');
  console.log('OK: decline -> soft reminder -> "link" later works');

  // G. Budget after recommendation -> qualified -> HOT + sales
  const m3 = 'ladder:3';
  for (const t of ['astrology guidance please', 'Test Customer', '15-08-1995', '10:30', 'Ambala', 'wealth', 'gemstone']) r = await ask(m3, t);
  r = await ask(m3, 'mera budget 15000 hai');
  assert.strictEqual(r.leadStatus, 'HOT'); assert.strictEqual(r.escalate, true);
  assert.ok(r.escalateReason.startsWith('kundli_qualified_budget') && /919560963312/.test(r.escalateReason));
  console.log('OK: budget -> qualified lead to sales');

  // H. Instagram: recommendation carries the Mannat WhatsApp nudge
  const m4 = 'ladder:4';
  for (const t of ['astrology guidance please', 'Test Customer', '15-08-1995', '10:30', 'Ambala', 'wealth']) await ask(m4, t, { platform: 'instagram', knownPhone: '' });
  r = await ask(m4, 'gemstone', { platform: 'instagram', knownPhone: '' });
  assert.ok(/74969 97220/.test(r.reply) && /INSTA/.test(r.reply), r.reply);
  r = await ask(m4, 'marriage kab hogi', { platform: 'instagram', knownPhone: '' });
  r = await ask(m4, 'yes', { platform: 'instagram', knownPhone: '' });
  assert.ok(/number/i.test(r.reply) && !/rzp/.test(r.reply), 'no phone -> ask number first');
  r = await ask(m4, '98765 43210', { platform: 'instagram', knownPhone: '' });
  assert.ok(r.reply.includes('rzp.io'), 'number given -> link');
  console.log('OK: Instagram -> WhatsApp 220 nudge; number asked before link');

  console.log('\nAll ladder assertions passed.');
}
run().catch((err) => { console.error('TEST FAILED:', err); process.exit(1); });
