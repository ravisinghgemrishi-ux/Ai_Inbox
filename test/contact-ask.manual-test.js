// Run: node test/contact-ask.manual-test.js
const assert = require('assert');
const { decide } = require('../lib/contactAsk');

const engaged = 'Customer: Hi\nMannat: Hello! Which gemstone are you looking for?';
const base = {
  platform: 'instagram', type: 'dm', reply: 'We have 6.5 ratti Red Coral for ₹4,122.', priorMemory: engaged,
  knownPhone: '', knownName: '', leadStatus: 'HOT', escalated: false, intent: 'price', escalateReason: '',
  invitedThisTurn: false, asksSoFar: 0, hindi: false,
};

// Asks on the customer's 2nd message, with name + number.
let line = decide(base);
assert(/name and WhatsApp number/.test(line), line);
assert(/naam aur WhatsApp number/.test(decide({ ...base, hindi: true })));
assert(/WhatsApp number/.test(decide({ ...base, knownName: 'Kapil' })) && !/name and/.test(decide({ ...base, knownName: 'Kapil' })));

// Not on the very first message (they haven't replied to Mannat yet).
assert.strictEqual(decide({ ...base, priorMemory: '' }), '');
// Not when we have the number, or the reply already asks for it.
assert.strictEqual(decide({ ...base, knownPhone: '+919876543210' }), '');
assert.strictEqual(decide({ ...base, reply: 'Please share your name and contact number so the team can reach you.' }), '');
// Not on WhatsApp, comments, support cases, non-leads, or with the WhatsApp invite this turn.
assert.strictEqual(decide({ ...base, platform: 'whatsapp' }), '');
assert.strictEqual(decide({ ...base, type: 'comment' }), '');
assert.strictEqual(decide({ ...base, intent: 'support_issue' }), '');
assert.strictEqual(decide({ ...base, escalateReason: 'damaged item, refund' }), '');
assert.strictEqual(decide({ ...base, leadStatus: 'NOT_A_LEAD' }), '');
assert.strictEqual(decide({ ...base, invitedThisTurn: true }), '');

// Second ask only when HOT / escalated; never a third.
assert.strictEqual(decide({ ...base, asksSoFar: 1, leadStatus: 'WARM' }), '');
assert(decide({ ...base, asksSoFar: 1, leadStatus: 'WARM', escalated: true }));
assert(decide({ ...base, asksSoFar: 1, leadStatus: 'HOT' }));
assert.strictEqual(decide({ ...base, asksSoFar: 2 }), '');
// WARM buyer still gets the first ask.
assert(decide({ ...base, leadStatus: 'WARM' }));

// Off switch.
process.env.IG_CONTACT_ASK = 'false';
assert.strictEqual(decide(base), '');
delete process.env.IG_CONTACT_ASK;

console.log('contact-ask: all assertions passed');
