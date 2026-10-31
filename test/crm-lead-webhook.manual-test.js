// Run: node test/crm-lead-webhook.manual-test.js  (no network: fake fetch + fake Redis)
const assert = require('assert');
const { sendQualifiedLead, _internal: c } = require('../lib/crmLeadWebhook');

const URL = 'https://example.test/hook';
function fakeRedis() {
  const store = {};
  return {
    store,
    fn: async (path) => {
      const parts = path.split('/').filter(Boolean);
      const key = decodeURIComponent(parts[1]);
      if (parts[0] === 'get') return { result: store[key] || null };
      if (parts[0] === 'set') { store[key] = parts[2]; return { result: 'OK' }; }
      return { result: null };
    },
  };
}
function fakeFetch(calls, ok = true) {
  return async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok, status: ok ? 200 : 500 }; };
}

(async () => {
  // Platform labels: Instagram must contain "Instagram" (CRM routes on it).
  assert.strictEqual(c.platformLabel('instagram'), 'Instagram DM');
  assert.strictEqual(c.platformLabel('whatsapp', { fromAd: true }), 'WhatsApp Ad');
  assert.strictEqual(c.platformLabel('whatsapp'), 'WhatsApp');
  assert.strictEqual(c.phoneDigits('9810757533'), '919810757533');
  assert.strictEqual(c.phoneDigits('+91 98107 57533'), '919810757533');
  assert.strictEqual(c.phoneDigits('abc'), '');

  const base = { platform: 'whatsapp', phone: '919810757533', name: 'Test', leadStatus: 'HOT', escalated: false, productInterest: 'Yellow Sapphire', fromAd: true, lastMessage: 'price?', reply: '₹8,080' };

  // HOT WhatsApp ad lead -> sent once with the documented shape.
  let r = fakeRedis(); let calls = [];
  let out = await sendQualifiedLead(base, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL });
  assert(out.sent && calls.length === 1);
  const body = calls[0].body;
  for (const k of ['name', 'phone', 'email', 'platform', 'lead_status', 'escalated', 'product_interest', 'budget', 'purpose', 'summary', 'chat_link']) assert(k in body, `missing ${k}`);
  assert.strictEqual(body.phone, '+919810757533');
  assert.strictEqual(body.platform, 'WhatsApp Ad');
  assert.strictEqual(body.escalated, 'No');

  // Same HOT lead again -> not re-sent; escalation later -> sent once more; then never again.
  out = await sendQualifiedLead(base, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL });
  assert(!out.sent && out.reason === 'already_sent');
  out = await sendQualifiedLead({ ...base, escalated: true }, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL });
  assert(out.sent && calls.length === 2 && calls[1].body.escalated === 'Yes');
  out = await sendQualifiedLead({ ...base, escalated: true }, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL });
  assert(!out.sent && calls.length === 2);

  // Not sent: WARM, support case, no phone, switched off.
  calls = []; r = fakeRedis();
  assert.strictEqual((await sendQualifiedLead({ ...base, leadStatus: 'WARM' }, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL })).reason, 'not_qualified');
  assert.strictEqual((await sendQualifiedLead({ ...base, escalated: true, escalateReason: 'damaged item, wants refund' }, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL })).reason, 'not_qualified');
  assert.strictEqual((await sendQualifiedLead({ ...base, platform: 'instagram', phone: '' }, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL })).reason, 'no_phone');
  assert.strictEqual((await sendQualifiedLead(base, { redis: r.fn, fetchFn: fakeFetch(calls), url: '' })).reason, 'disabled');
  assert.strictEqual(calls.length, 0);

  // Instagram with a phone -> "Instagram DM", handle kept in the summary.
  out = await sendQualifiedLead({ ...base, platform: 'instagram', handle: 'kapil_bairagi05', name: '', phone: '9876543210' }, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL });
  assert(out.sent && calls[0].body.platform === 'Instagram DM' && calls[0].body.name === '@kapil_bairagi05' && /Handle: kapil_bairagi05/.test(calls[0].body.summary));

  // CRM error -> not marked as sent (will retry on the next HOT turn); never throws.
  r = fakeRedis(); calls = [];
  out = await sendQualifiedLead(base, { redis: r.fn, fetchFn: fakeFetch(calls, false), url: URL });
  assert(!out.sent && Object.keys(r.store).length === 0);
  out = await sendQualifiedLead(base, { redis: r.fn, fetchFn: async () => { throw new Error('network'); }, url: URL });
  assert(!out.sent && out.reason === 'error');

  console.log('crm-lead-webhook: all assertions passed');
})();
