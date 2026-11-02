// Run: node test/crm-lead-webhook.manual-test.js  (no network: fake fetch + fake Redis)
const assert = require('assert');
const { sendQualifiedLead, sendChatUpdate, _internal: c } = require('../lib/crmLeadWebhook');

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

  // 2026-11-01: full chat goes into summary + transcript.
  r = fakeRedis(); calls = [];
  const chat = 'Customer: hi\nMannat: Namaste!\nCustomer: price?\nMannat: ₹8,080';
  out = await sendQualifiedLead({ ...base, transcript: chat }, { redis: r.fn, fetchFn: fakeFetch(calls), url: URL });
  assert(out.sent && calls[0].body.transcript === chat && calls[0].body.summary.includes('Full chat with Mannat') && calls[0].body.summary.includes('Customer: hi'));
  assert(Object.keys(r.store).some((k) => k.startsWith('gemrishi:crm-in:')), 'in-CRM marker set');
  // Long chats keep the most recent part.
  const long = c.clipTranscript('x'.repeat(5000) + 'END');
  assert(long.endsWith('END') && long.length < 3600 && long.startsWith('(earlier messages cut)'));

  // Chat updates: only for leads already in the CRM, only this turn, never re-alerting.
  const updCalls = [];
  const UPD = 'https://example.test/update';
  out = await sendChatUpdate({ ...base, lastMessage: 'loose stone please', reply: 'Here is a 5.40 ct option' }, { redis: r.fn, fetchFn: fakeFetch(updCalls), url: UPD });
  assert(out.sent && updCalls.length === 1 && updCalls[0].url === UPD);
  assert.strictEqual(updCalls[0].body.transcript, 'Customer: loose stone please\nMannat: Here is a 5.40 ct option');
  assert.strictEqual(updCalls[0].body.phone, '+919810757533');
  // Not in CRM / switched off / no phone -> nothing sent.
  const fresh = fakeRedis();
  assert.strictEqual((await sendChatUpdate({ ...base, phone: '9123456789' }, { redis: fresh.fn, fetchFn: fakeFetch(updCalls), url: UPD })).reason, 'not_in_crm');
  assert.strictEqual((await sendChatUpdate(base, { redis: r.fn, fetchFn: fakeFetch(updCalls), url: '' })).reason, 'disabled');
  assert.strictEqual((await sendChatUpdate({ ...base, phone: '' }, { redis: r.fn, fetchFn: fakeFetch(updCalls), url: UPD })).reason, 'no_phone');
  assert.strictEqual(updCalls.length, 1);
  // Lead sent before this change (only the 24 h dedupe key) still gets updates.
  const old = fakeRedis(); old.store['gemrishi:crm-lead:919810757533'] = 'hot';
  assert((await sendChatUpdate(base, { redis: old.fn, fetchFn: fakeFetch(updCalls), url: UPD })).sent);
  // CRM error never throws.
  assert.strictEqual((await sendChatUpdate(base, { redis: r.fn, fetchFn: async () => { throw new Error('net'); }, url: UPD })).reason, 'error');

  console.log('crm-lead-webhook: all assertions passed');
})();

// 2026-11-02: names and timeouts
(async () => {
  const { _internal: c2 } = require('../lib/crmLeadWebhook');
  const assert2 = require('assert');
  assert2.strictEqual(c2.displayName({ handle: '+919690200444', profileName: 'Sanjay DIWAKAR' }), 'Sanjay DIWAKAR');
  assert2.strictEqual(c2.displayName({ handle: '+919690200444' }), 'Customer');
  assert2.strictEqual(c2.displayName({ name: 'Ravi', handle: '+91999', profileName: 'X' }), 'Ravi');
  assert2.strictEqual(c2.displayName({ name: '+91 99109 53175', profileName: 'Ravi Bharati' }), 'Ravi Bharati');
  assert2.strictEqual(c2.displayName({ handle: 'kapil_bairagi05', profileName: '' }), '@kapil_bairagi05');

  // timeout once, then success -> one retry
  let n = 0;
  const flaky = async (url, opts) => { n++; if (n === 1) { const e = new Error('This operation was aborted'); throw e; } return { ok: true, status: 200 }; };
  const res = await c2.postJson(flaky, 'https://x.test', {}, { timeoutMs: 50, retryDelayMs: 1 });
  assert2(res.ok && n === 2, `retries once (n=${n})`);
  // 500 then 200
  n = 0;
  const f500 = async () => { n++; return n === 1 ? { ok: false, status: 502 } : { ok: true, status: 200 }; };
  assert2((await c2.postJson(f500, 'u', {}, { retryDelayMs: 1 })).ok && n === 2);
  // 400 is not retried
  n = 0;
  const f400 = async () => { n++; return { ok: false, status: 400 }; };
  assert2(!(await c2.postJson(f400, 'u', {}, { retryDelayMs: 1 })).ok && n === 1);
  // a hung CRM is cut at the timeout
  n = 0;
  const hang = (url, opts) => new Promise((_, rej) => { n++; opts.signal.addEventListener('abort', () => rej(new Error('aborted'))); });
  await assert2.rejects(c2.postJson(hang, 'u', {}, { timeoutMs: 30, retryDelayMs: 1 }));
  assert2.strictEqual(n, 2);
  console.log('crm-lead-webhook (names/timeouts): all assertions passed');
})();
