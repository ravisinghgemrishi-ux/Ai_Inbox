// node test/meta-datasets.manual-test.js
const assert = require('assert');

process.env.ZERNIO_API_KEY = 'test-key';
process.env.META_ADS_ACCOUNT_ID = 'adsacct1';
process.env.META_CAPI_DATASETS = '430058849371405, 1769461664367572,1751833699257860,1662532008560197';
process.env.META_CAPI_TEST_CODE = 'TEST30784';

const calls = [];
global.fetch = async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({ eventsReceived: 1, eventsFailed: 0, failures: [] }) };
};

const mt = require('../lib/metaTracking');

(async () => {
  // Lead -> exactly the three confirmed datasets, never the "unknown" one.
  const lead = await mt.leadSubmitted({ phone: '+91 98765 43210' });
  assert.strictEqual(lead.sent, true);
  const dests = calls.map((c) => c.body.destinationId).sort();
  assert.deepStrictEqual(dests, ['1751833699257860', '1769461664367572', '430058849371405']);
  assert(!dests.includes('1662532008560197'), 'unknown dataset must never receive events');
  assert(calls.every((c) => c.url.endsWith('/ads/conversions')), 'must not use /whatsapp/conversions');
  const ev = calls[0].body.events[0];
  assert.strictEqual(ev.eventName, 'Lead');
  assert.strictEqual(ev.actionSource, 'offline');
  assert.strictEqual(ev.user.phone, '919876543210');
  assert.strictEqual(calls[0].body.testCode, 'TEST30784');
  assert.strictEqual(ev.value, undefined, 'lead must not carry a value');

  // Purchase carries real value in INR.
  calls.length = 0;
  const sale = await mt.purchase({ phone: '9876543210', amount: 45000 });
  assert.strictEqual(sale.sent, true);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0].body.events[0].value, 45000);
  assert.strictEqual(calls[0].body.events[0].currency, 'INR');

  // No phone -> nothing sent. Zero/negative sale -> nothing sent.
  calls.length = 0;
  assert.strictEqual((await mt.leadSubmitted({})).sent, false);
  assert.strictEqual((await mt.purchase({ phone: '9876543210', amount: 0 })).sent, false);
  assert.strictEqual(calls.length, 0);

  // Off-switch and missing config send nothing.
  process.env.META_TRACKING = 'off';
  assert.strictEqual((await mt.leadSubmitted({ phone: '9876543210' })).sent, false);
  process.env.META_TRACKING = 'on';
  delete process.env.META_CAPI_DATASETS;
  assert.strictEqual((await mt.leadSubmitted({ phone: '9876543210' })).sent, false);
  assert.strictEqual(calls.length, 0);

  // Only the unknown dataset configured -> nothing sent.
  process.env.META_CAPI_DATASETS = '1662532008560197';
  assert.strictEqual((await mt.leadSubmitted({ phone: '9876543210' })).sent, false);
  assert.strictEqual(calls.length, 0);

  console.log('meta-datasets: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
