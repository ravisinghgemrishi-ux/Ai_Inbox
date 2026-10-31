// Meta tracking (2026-10-20, updated 2026-10-31 for the datasets path). Fake Zernio, no network.
const assert = require('assert');
process.env.ZERNIO_API_KEY = 'k';
process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID = 'acc220';
process.env.META_ADS_ACCOUNT_ID = 'adsacc';
process.env.META_CAPI_DATASETS = '111,1662532008560197,222'; // middle one is blocked
const calls = [];
global.fetch = async (url, opts = {}) => { calls.push({ url: String(url), body: JSON.parse(opts.body || '{}') }); return { ok: true, json: async () => ({ eventsReceived: 1 }) }; };
const m = require('../lib/metaTracking');
const flat = (c) => JSON.stringify(c.body);
(async () => {
  assert.deepStrictEqual(m.parseSaleCommand('sold 9876543210 45000'), { phone: '9876543210', amount: 45000 });
  assert.deepStrictEqual(m.parseSaleCommand('Sold +91 98765-43210 45k'), { phone: '9876543210', amount: 45000 });
  assert.strictEqual(m.parseSaleCommand('sold 45000').error, 'phone');
  assert.strictEqual(m.parseSaleCommand('Any new lead for me'), null);
  assert.deepStrictEqual(m._internal.datasetIds(), ['111', '222']);

  // Lead: one call per allowed dataset, phone matched, NO value/currency (a budget is not revenue).
  const lead = await m.leadSubmitted({ phone: '+919876543210', productInterest: 'Opal' });
  assert.ok(lead.sent);
  assert.strictEqual(calls.length, 2);
  for (const c of calls) {
    assert.ok(/Lead/.test(flat(c)) && /919876543210/.test(flat(c)));
    assert.ok(!/"value"/.test(flat(c)) && !/"currency"/.test(flat(c)));
    assert.ok(!/9876543210/.test(JSON.stringify(m._internal.eventId('lead', '919876543210'))), 'event id must not contain the phone');
  }
  assert.strictEqual((await m.leadSubmitted({ phone: '' })).reason, 'no_phone');

  // Purchase: value + INR sent; zero amount refused.
  calls.length = 0;
  const sale = await m.purchase({ phone: '9876543210', amount: 45000 });
  assert.ok(sale.sent && calls.length === 2);
  assert.ok(/Purchase/.test(flat(calls[0])) && /45000/.test(flat(calls[0])) && /INR/.test(flat(calls[0])));
  assert.strictEqual((await m.purchase({ phone: '9876543210', amount: 0 })).reason, 'purchase_requires_positive_actual_sale_amount');
  console.log('Meta tracking tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
