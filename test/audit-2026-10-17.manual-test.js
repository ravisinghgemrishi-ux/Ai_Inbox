// Manual test for the 2026-10-17 audit fixes. Run: node test/audit-2026-10-17.manual-test.js
// Pure functions only - no network.
const assert = require('assert');
const r = require('../lib/replyEngine');
const h = require('../lib/handoff');
const kb = require('../lib/knowledgeBase');
const leads = require('../lib/instagramLeads');
const { formatMemory } = require('../lib/memoryStore');

// #1 fake "check your DM" claims (real replies from the lead log)
for (const reply of ['Please check your DM, I have shared the details with you there.', 'Please check your DM for details - Mannat', 'I have sent a message to your DMs with the details to find the right gemstone for you.']) {
  const out = r._removeFakeDmClaims(reply, 'Pp', 'comment');
  assert.ok(!/check your dm|sent a message to your dm/i.test(out), `DM claim must be removed: ${reply}`);
}
assert.strictEqual(r._removeFakeDmClaims('Yellow Sapphire starts at ₹8,080. Feel free to DM us.', 'Pp', 'comment'), 'Yellow Sapphire starts at ₹8,080. Feel free to DM us.', 'an invitation to DM us is fine');

// #4 invented links -> home page; real links kept
const live = JSON.stringify({ products: [{ url: 'https://gemrishi.com/product/ruby-manik-6-4-carats-ruby-114', price_inr: 4768 }] });
assert.ok(r._enforceRealLinks('See rudraksha.gemrishi.com/products/5-mukhi-rudraksha', '').endsWith('https://rudraksha.gemrishi.com'));
assert.ok(r._enforceRealLinks('See https://gemrishi.com/product/ruby-manik-6-4-carats-ruby-114.', live).includes('ruby-manik-6-4-carats-ruby-114'));

// #4/#5 invented prices removed even when live data exists; real + customer figures kept
const priced = r._enforcePriceSafety('This 6.4 ct Ruby is ₹4,768. A natural pearl costs ₹15,000 per carat.', live, 'price?', '');
assert.ok(priced.includes('₹4,768') && !priced.includes('15,000'));
assert.ok(r._enforcePriceSafety('Within your 45k budget the ₹4,768 one works.', live, '40-45k', '').includes('₹4,768'));

// #4 routing: Rudraksha / Kundli / budget go to the better model
assert.strictEqual(r._pickTier({ intent: 'general_question', message: 'मेरी राशि के अनुसार कौन सा रुद्राक्ष' }), 'smart');
assert.strictEqual(r._pickTier({ intent: 'general_question', message: '40-45k' }), 'smart');
assert.strictEqual(r._pickTier({ intent: 'price', message: 'Pp' }), 'lite');

// #2 promises now alert the team
assert.ok(h.promisesTeamFollowUp('I will have our gemologist personally select a clean Blue Sapphire for you.'));
assert.ok(h.promisesTeamFollowUp("I'll confirm the exact current price for you."));
assert.ok(!h.promisesTeamFollowUp('Would you like it loose or set in a ring?'));

// #3 plan questions recognised
for (const m of ['Written kundli', 'price of consultation', 'consultation ka price kitna hai']) assert.ok(kb.detectPlanQuestionNote(m), m);

// #6 phone numbers
assert.strictEqual(leads._normalizePhone('+61 424 002 700'), '+61424002700');
assert.strictEqual(leads._normalizePhone('9913858835'), '+919913858835');
assert.strictEqual(leads._normalizePhone('09068008500'), '+919068008500');

// #9 team messages in memory
assert.ok(formatMemory([{ role: 'team', text: 'hi' }]).startsWith('GemRishi team:'));

console.log('All audit tests passed');

// Comment -> DM (2026-10-17)
const wh = require('../api/webhook.js');
const lead = { leadStatus: 'WARM' };
// 2026-10-21: comment DMs are off by default (answered publicly); these check the opt-in path.
assert.ok(!wh._shouldDmCommenter({ platform: 'instagram', commentText: 'Pp', result: lead }), 'default off');
process.env.COMMENT_DM_PLATFORMS = 'instagram';
assert.ok(wh._shouldDmCommenter({ platform: 'instagram', commentText: 'Pp', result: lead }));
assert.ok(wh._shouldDmCommenter({ platform: 'instagram', commentText: 'Blue sapphire price', result: { leadStatus: 'HOT' } }));
assert.ok(!wh._shouldDmCommenter({ platform: 'instagram', commentText: '🔥🔥', result: lead }), 'emoji only -> no DM');
assert.ok(!wh._shouldDmCommenter({ platform: 'instagram', commentText: 'Beautiful', result: lead }), 'praise -> no DM');
assert.ok(!wh._shouldDmCommenter({ platform: 'facebook', commentText: 'Pp', result: lead }), 'Facebook off by default');
assert.ok(!wh._shouldDmCommenter({ platform: 'instagram', commentText: 'Pp', result: { leadStatus: 'NOT_A_LEAD' } }));
assert.ok(/DM/.test(wh._commentDmPublicReply('Price batao')));
delete process.env.COMMENT_DM_PLATFORMS;
console.log('Comment-DM tests passed');

// 2026-10-17 live bug: decimals must not split sentences
const r2 = require('../lib/replyEngine');
assert.ok(!/^05-carat/.test(r2._removeFakeDmClaims('I have sent you a DM with the details of a 5.05-carat Ceylon Yellow Sapphire with you.', 'Pp', 'comment')));
assert.ok(r2._removeFakeDmClaims('Our 5.05 carat Ceylon Pukhraj is lovely. I have sent you a DM with details. Which size?', 'Pp', 'comment').includes('5.05 carat'));
console.log('Decimal-split test passed');
