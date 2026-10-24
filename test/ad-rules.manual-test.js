// 2026-10-24: ad/reel context + the three requirement fallback rules.
// Run: node test/ad-rules.manual-test.js
const assert = require('assert');
const ads = require('../lib/adCatalog');
const rules = require('../lib/requirementRules');

// Ad matching: by ad id, Instagram post id, keyword; unknown ad is reported.
assert.strictEqual(ads.matchAd({ message: { metadata: { referral: { ad_id: '120251046304200262' } } } }).entry.key, 'ys21');
assert.strictEqual(ads.matchAd({ conversation: { metadata: { ig_post: '17973555030157272' } } }).entry.key, 'ys21');
assert.strictEqual(ads.matchAd({ metadata: { referral: { source_id: '120250828372390262' } } }).entry.key, 'kashmir');
assert.strictEqual(ads.matchAd({ metadata: { ctwa_headline: 'The Reality of Kashmir Sapphire' } }).entry.key, 'kashmir');
const unk = ads.matchAd({ metadata: { referral: { ad_id: '999999999999999999' } } });
assert.strictEqual(unk.entry, null); assert.strictEqual(unk.adRef, '999999999999999999');
assert.deepStrictEqual(ads.matchAd({ message: { text: 'hi' } }), { entry: null, adRef: '' });
console.log('OK: ad / reel matching');

const wa = { haveName: false, havePhone: true, haveBudget: false };
// Rule 1: 10+ carat / ratti.
let r = rules.evaluate({ message: 'Do have 21ct radiant cut yellow sapphire', known: wa });
assert.strictEqual(r.rule, 'big_stone'); assert.ok(/very unique requirement/.test(r.reply) && /name and budget/.test(r.reply));
r = rules.evaluate({ message: 'mujhe 12 ratti neelam chahiye', known: wa });
assert.ok(/bahut unique requirement/.test(r.reply));
assert.strictEqual(rules.evaluate({ message: '5 ratti neelam ka price?', intent: 'price', live: { found: true }, known: wa }), null);
assert.strictEqual(rules.evaluate({ message: '14k gold ring price', intent: 'price', live: { found: true }, known: wa }), null);
// From the 21 ct ad, "Can you check the price of a product?" -> rule 1.
r = rules.evaluate({ message: 'Can you check the price of a product?', adEntry: ads.entryFor('ys21'), known: { haveName: false, havePhone: false, haveBudget: false } });
assert.ok(/very unique/.test(r.reply) && /name, number and budget/.test(r.reply));
// Never in public comments.
assert.strictEqual(rules.evaluate({ message: '20 carat ruby?', type: 'comment', known: wa }), null);
console.log('OK: rule 1 (10+ carat/ratti)');

// Rule 3: specific item not on the website; never on a sheet outage.
r = rules.evaluate({ message: 'do you have tanzanite?', intent: 'general_question', live: { found: false, source: 'google_sheet' }, known: wa });
assert.strictEqual(r.rule, 'unique'); assert.strictEqual(r.reason, 'unique_requirement_not_on_website');
assert.strictEqual(rules.evaluate({ message: 'tanzanite price?', intent: 'price', live: { found: false, source: 'sheet_unavailable' }, known: wa }), null);
r = rules.evaluate({ message: 'how much?', adEntry: ads.entryFor('kashmir'), known: wa });
assert.strictEqual(r.rule, 'unique');
// Second time: no fixed reply, only a note for the normal answer.
r = rules.evaluate({ message: 'tanzanite price?', intent: 'price', live: { found: false, source: 'google_sheet' }, known: wa, alreadyFired: true });
assert.strictEqual(r.reply, null); assert.ok(r.note);
console.log('OK: rule 3 (special / not on website)');

console.log('\nAll ad + rule assertions passed.');
