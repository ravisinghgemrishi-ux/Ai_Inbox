// 2026-10-26 fixes, checked against the real 25 Oct chats.
// Run: node test/oct26-fixes.manual-test.js
const assert = require('assert');
const { _applyPriceSafety } = require('../lib/replyEngine');
const { maybeHandleKundliTurn, _internal: k } = require('../lib/kundliFlow');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const live = JSON.stringify({ source: 'gemstones', products: [
  { name: 'Yellow Sapphire 5.40 Carats', price_inr: 8080, mrp_inr: 9580, url: 'https://gemrishi.com/product/yellow-sapphire-5-40-carats-pkraj-tsg42' },
  { name: 'Yellow Sapphire 5.50 Carats', price_inr: 10066, mrp_inr: null, url: 'https://gemrishi.com/product/yellow-sapphire-5-50-carats-pkraj-352' },
] });

(async () => {
  // --- Price guard ---------------------------------------------------------
  await t('price ask + model figure cut -> real live options are quoted', () => {
    const r = _applyPriceSafety('Our Yellow Sapphires start at ₹7,500.\n\nWould you like this loose, or set in a ring or pendant?', live, 'What is the price of this Yellow Sapphire set?');
    assert(r.priceLeft, 'customer must be left with a price');
    assert(r.text.includes('₹8,080') && r.text.includes('pkraj-tsg42'), r.text);
    assert(!r.text.includes('7,500'), 'unverified figure must still be removed');
  });
  await t('verified live price passes untouched', () => {
    const msg = 'Yellow Sapphire 5.40 Carats is ₹8,080: https://gemrishi.com/product/yellow-sapphire-5-40-carats-pkraj-tsg42';
    const r = _applyPriceSafety(msg, live, 'price?');
    assert(!r.removed && r.text === msg);
  });
  await t('making charge (playbook Rs 1,700-5,000) is allowed', () => {
    const r = _applyPriceSafety('Silver ring making charges are ₹1,700 to ₹5,000 depending on the design.', live, 'Ur making charge ?');
    assert(!r.removed, r.text);
  });
  await t('Rs 5,000 as a STONE price is still checked', () => {
    const r = _applyPriceSafety('This Emerald is ₹5,000.\n\nWould you like it in a ring?', live, 'emerald price');
    assert(r.removed && !r.text.includes('5,000'), r.text);
  });
  await t('consultation package Rs 599 allowed only in a plan sentence', () => {
    assert(!_applyPriceSafety('Our astrologer consultation packages start at ₹599.', '', 'astrologer?').removed);
    assert(_applyPriceSafety('This Pearl costs ₹599 only.', '', 'pearl price').removed);
  });

  // --- Kundli flow ---------------------------------------------------------
  await t('Jagannath: product request is never treated as birth details', () => {
    assert(k.PRODUCT_REQUEST.test('Ye design m chahiye 22 carat gold m pukhraj'));
    assert(k.PRODUCT_REQUEST.test('Isme price bta do kitna pdega'));
    assert(k.PRODUCT_REQUEST.test('Show me south sea orignal pearl'));
    assert(!k.looksLikeBirthDetails('Ye design m chahiye 22 carat gold m pukhraj'));
  });
  await t('birth-detail answers are not product requests', () => {
    for (const m of ['Jagannath \n17 october 1980\n11:05am ghaziabad', '13-09-1972', '15.05', 'Name-Tushar Sharma D.O.B-03/11/89 Time-6:30am Place-Muzaffarnagar']) {
      assert(!k.PRODUCT_REQUEST.test(m) || k.looksLikeBirthDetails(m), m);
    }
    assert(!k.PRODUCT_REQUEST.test('Delhi') && !k.PRODUCT_REQUEST.test('Neerja Rajput'));
  });
  await t('fresh start in the middle of a sale -> flow stays out', async () => {
    const memory = 'Mannat: Sri Lankan 5.40 carats is ₹8,080: https://gemrishi.com/product/yellow-sapphire-5-40-carats-pkraj-tsg42';
    const r = await maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: 'test-oct26', message: 'Ye design m chahiye 22 carat gold m pukhraj', intent: { intent: 'purchase' }, existingMemory: memory, platform: 'whatsapp' });
    assert.strictEqual(r, null);
  });
  await t('Tushar: call / name requests leave the buy question', () => {
    for (const m of ['Can u just call me', 'Please call me', 'Ap pls call kr lijiye']) assert(k.CALL_REQUEST.test(m), m);
    for (const m of ['Your Name', 'Pls tell me ur name so it will be very easy to me remember you', 'Apka nam']) assert(k.ASKS_NAME.test(m), m);
    assert(!k.CALL_REQUEST.test('Pearl m not sure'));
  });
  await t('"ok" after the buy question counts as yes', () => {
    for (const m of ['Okay', 'ok', 'Okk', 'theek hai']) assert(k.SHORT_YES.test(m), m);
    assert(!k.SHORT_YES.test('Okk please guide me'));
  });
  await t('Avneet: country/state alone is not a birth place', () => {
    for (const m of ['India', 'Punjab', 'uttar pradesh']) assert(k.REGION_ONLY.test(m), m);
    for (const m of ['Delhi', 'Muktsar, Punjab', 'Ambala, Haryana, India']) assert(!k.REGION_ONLY.test(m), m);
  });

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
