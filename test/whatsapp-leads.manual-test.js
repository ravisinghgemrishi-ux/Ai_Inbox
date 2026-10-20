// Manual test for WhatsApp leads -> Neel (2026-10-20). Run: node test/whatsapp-leads.manual-test.js
const assert = require('assert');
const h = require('../lib/handoff');

// every WhatsApp lead -> Neel, whatever the type
for (const x of [{}, { escalate: true, escalateReason: 'refund' }, { intent: 'price' }, { category: 'b2b' }]) {
  assert.strictEqual(h.routeFor({ ...x, platform: 'whatsapp' }), 'neel', JSON.stringify(x));
}
// Instagram unchanged
assert.strictEqual(h.routeFor({ platform: 'instagram', intent: 'price' }), 'sales');
assert.strictEqual(h.routeFor({ platform: 'instagram', escalate: true, escalateReason: 'refund' }), 'neel');

// template values: one line each, never empty, 7 values
const p = h._internal.whatsappAlertParams(
  { customerName: 'Ravi', customerPhone: '+919999999999', productInterest: 'Yellow Sapphire', platform: 'whatsapp', contact: '919999999999', trigger: 'HOT lead, number given' },
  'Customer: hi\nMannat: hello\nCustomer: 9.15 ratti pukhraj\nprice?\nMannat: ...\nCustomer: 50k tak',
);
assert.strictEqual(p.length, 7);
for (const v of p) assert.ok(v && !/[\n\t]/.test(v) && !/ {4,}/.test(v), v);
assert.strictEqual(p[3], 'not given');
assert.ok(p[6].includes('50k tak'));

console.log('WhatsApp lead tests passed');

// Language (2026-10-20): mirror the customer's language; explicit request wins.
const kb = require('../lib/knowledgeBase');
const hi = (m, mem, p) => kb.replyShouldBeHindi(m, mem, { platform: p });
assert.strictEqual(hi('I need opal 5 ratti', '', 'whatsapp'), false, 'English message -> English');
assert.strictEqual(hi('opal 5 ratti chahiye', '', 'whatsapp'), true, 'Hinglish message -> Hinglish');
assert.strictEqual(hi('ok', 'Customer: I need opal\nCustomer: Hindi me baat kijiye plz', 'whatsapp'), true);
assert.strictEqual(hi('ok', 'Customer: kitna price hai\nCustomer: English please', 'whatsapp'), false, 'asked for English');
assert.strictEqual(hi('I would like to know the price of a natural blue sapphire', 'Customer: Hello I am looking for a certified blue sapphire for my father', 'whatsapp'), false, 'clear English writer');
assert.strictEqual(hi('I need opal 5 ratti', '', 'instagram'), false, 'Instagram unchanged');
console.log('WhatsApp language tests passed');
