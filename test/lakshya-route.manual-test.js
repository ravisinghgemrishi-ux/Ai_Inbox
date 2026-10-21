// 2026-10-21 (Ravi): all Rudraksha leads -> Lakshya (+91 91388 49106).
const assert = require('assert');
const h = require('../lib/handoff');
(async () => {
  assert.strictEqual(await h.assignRoute({ productInterest: '5 Mukhi Rudraksha Nepal', customerBudget: '' }), 'lakshya');
  assert.strictEqual(await h.assignRoute({ productInterest: 'Collector Rudraksha (Gauri Shankar)', customerBudget: '2 lakh' }), 'lakshya', 'even above 50k');
  assert.strictEqual(await h.assignRoute({ productInterest: 'Rudraksha', customerBudget: '' }, { escalateToNeel: true }), 'neel', 'complaints/B2B stay with Neel');
  assert.strictEqual(await h.assignRoute({ productInterest: 'Blue Sapphire', customerBudget: '1 lakh' }), 'neel');
  assert.strictEqual(h.routeForStaffNumber('+91 91388 49106'), 'lakshya', 'Lakshya can check in');
  console.log('lakshya route tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
