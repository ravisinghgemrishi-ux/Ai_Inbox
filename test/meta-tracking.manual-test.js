// Meta CTWA tracking (2026-10-20). Fake Zernio, no network.
const assert = require('assert');
process.env.ZERNIO_API_KEY = 'k';
process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID = 'acc220';
const calls = [];
global.fetch = async (url, opts = {}) => { calls.push({ url, body: JSON.parse(opts.body || '{}') }); return { ok: true, json: async () => ({ eventsReceived: 1 }) }; };
const m = require('../lib/metaTracking');
(async () => {
  assert.deepStrictEqual(m.parseSaleCommand('sold 9876543210 45000'), { phone: '9876543210', amount: 45000 });
  assert.deepStrictEqual(m.parseSaleCommand('Sold +91 98765-43210 45k'), { phone: '9876543210', amount: 45000 });
  assert.strictEqual(m.parseSaleCommand('sold 45000').error, 'phone');
  assert.strictEqual(m.parseSaleCommand('Any new lead for me'), null);
  await m.leadSubmitted({ phone: '+919876543210', budget: '50k tak' });
  assert.ok(calls[0].url.endsWith('/whatsapp/conversions'));
  assert.deepStrictEqual([calls[0].body.eventName, calls[0].body.phoneE164, calls[0].body.value, calls[0].body.currency, calls[0].body.eventId], ['LeadSubmitted', '919876543210', 50000, 'INR', 'lead-919876543210']);
  await m.purchase({ phone: '9876543210', amount: 45000 });
  assert.deepStrictEqual([calls[1].body.eventName, calls[1].body.value], ['Purchase', 45000]);
  console.log('Meta tracking tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
