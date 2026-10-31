// 31 Oct audit fixes, replayed with the real customer messages. Run: node test/audit-2026-10-31.manual-test.js
const assert = require('assert');
const re = require('../lib/replyEngine');
const k = require('../lib/kundliFlow');
const guards = require('../lib/conversationGuards');

let failed = 0;
async function t(name, fn) { try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); } }

const live = JSON.stringify({ products: [
  { name: 'Yellow Sapphire : 6.4 Carats', price_inr: 161758, url: 'https://gemrishi.com/product/yellow-sapphire-6-4-carats-pkraj-279' },
  { name: 'Yellow Sapphire 6.15 Carats', price_inr: 74725, url: 'https://gemrishi.com/product/yellow-sapphire-6-15-carats-pkraj-398' },
  { name: 'Yellow Sapphire 6.75 Carats', price_inr: 20808, url: 'https://gemrishi.com/product/yellow-sapphire-6-75-carats-pkraj-2' },
  { name: 'Minor Oil Emerald 9.88 Carats', price_inr: 88998, url: 'https://gemrishi.com/product/minor-oil-emerald-9-88-carats-panna-511' },
] });

(async () => {
  // 9 - Kundli flow must not restart mid-sale when only prices / sizes are left in the chat
  await t('Neelu: certificate question after ring-sizer loop stays out of Kundli', async () => {
    const mem = 'Customer: Gold\nMannat: Gold ring mein banwane ke liye aap is 5.40 carat Yellow Sapphire ke sath yeh setting select kar sakte hain.\nCustomer: Okay\nMannat: Ring size nikalne mein hamari team aapko guide karegi.';
    const r = await k.maybeHandleKundliTurn({ enabled: true, type: 'dm', memoryId: 'audit-31-a', message: 'And ye lab certificate konsa h ek bar dikha sakte h', intent: { intent: 'recommendation' }, existingMemory: mem, platform: 'whatsapp' });
    assert.strictEqual(r, null);
  });
  await t('A pure "which stone suits me" chat can still start Kundli', () => {
    assert(!k._internal.SALES_CHAT.test('Customer: Hi\nMannat: Namaste! Aap kaunsa gemstone dekh rahe hain?'));
  });

  // 10 - "budget no issue" is not a refusal
  await t('Sumit: "budget no issue" is not a no', () => {
    const D = /\b(no|nahi|not now|later)\b/i;
    assert(!k._internal.isRefusal('in ring\nsuggest me size\nbudget no issue', D));
    assert(!k._internal.isRefusal('koi dikkat nahi', D));
    assert(k._internal.isRefusal('No', D) && k._internal.isRefusal('abhi nahi', D));
  });

  // 11 - promises Mannat can't keep become honest + go to the team
  await t('Tushar: "team is sending videos" replaced + escalated', () => {
    const r = re._normalizeResult({ reply: 'Ji Tushar ji! Team abhi aapko videos aur pictures send kar rahi hai.', leadStatus: 'HOT' }, '', 'Ap please video aur pic dono send kr dijiye');
    assert(!/send kar rahi hai/.test(r.reply), r.reply);
    assert(/team ko .*photos aur video share karne ke liye bol diya/i.test(r.reply), r.reply);
    assert(r.escalate && /photos_video/.test(r.escalateReason));
  });
  await t('Neelu: "ring sizer courier" replaced + escalated', () => {
    const r = re._normalizeResult({ reply: 'Koi baat nahi, hum aapko ek ring sizer courier kar denge.\n\nAap apna ring size confirm karke bata dena.', leadStatus: 'HOT' }, '', 'Nhi pta');
    assert(!/courier/.test(r.reply), r.reply);
    assert(r.escalate && /ring_sizer/.test(r.escalateReason));
  });
  await t('Machh Mani: "I\'ll update you once the team replies" replaced', () => {
    const r = re._normalizeResult({ reply: 'Theek hai ji, jaise hi team se Machh Mani ki availability aur price ki update milti hai, main aapko turant bhejti hoon.', leadStatus: 'HOT' }, '', 'Ok');
    assert(/directly contact/.test(r.reply), r.reply);
  });
  await t('Product-page photo pointer is NOT treated as a false promise', () => {
    const r = re._normalizeResult({ reply: 'You can view the photos and video for this 5.50-carat piece on its product page.', leadStatus: 'HOT' }, '', 'Send me the photo & video');
    assert(!r.escalate, r.escalateReason);
  });

  // 12 - wrong prices / invented products / cheapest first
  await t('"₹8,8998" (garbled) is removed', () => {
    const r = re._normalizeResult({ reply: 'Our natural Zambian emeralds in that size range start at ₹8,8998 for 9.88 carats.\n\nWould you prefer this loose or set in a ring?', leadStatus: 'HOT' }, live, 'Price please');
    assert(!/8,8998/.test(r.reply), r.reply);
    assert.strictEqual(re._validGrouping('88,998'), true);
    assert.strictEqual(re._validGrouping('1,61,758'), true);
    assert.strictEqual(re._validGrouping('8,8998'), false);
  });
  await t('Invented "10.50 Carat Emerald" with a fake product link is dropped', () => {
    const out = re._dropInventedProducts('We have gorgeous natural Zambian emeralds in that size range.\n\nTake a look at this 10.50 Carat Zambian Emerald: https://gemrishi.com/product/emerald-10-50-carats-fake-1', live);
    assert(!/10\.50/.test(out), out);
    const real = 'This 9.88 carat emerald is ₹88,998: https://gemrishi.com/product/minor-oil-emerald-9-88-carats-panna-511';
    assert.strictEqual(re._dropInventedProducts(real, live), real);
  });
  await t('Fallback options are cheapest first', () => {
    const r = re._applyPriceSafety('6-7 ratti Pukhraj starts at ₹9,999.', live, 'Loose ka ky rate h aur ring me kitne ka benga');
    const first = r.text.indexOf('20,808'); const exp = r.text.indexOf('1,61,758');
    assert(first > -1 && (exp === -1 || first < exp), r.text);
  });

  // 13 - IGI vs IIGJ
  await t('Satbir: "Gii" is IGI, not IIGJ', () => {
    const notes = guards.contextNotes({ memory: '', message: 'I want to purchase Gii lab certificate' });
    assert(/IGI certificate/.test(notes) && /Do NOT switch to IIGJ/.test(notes));
    assert(!/IGI certificate/.test(guards.contextNotes({ memory: '', message: 'IIGJ certificate chahiye' })));
  });

  // 14 - call time already passed today -> tomorrow
  await t('Megha: "aaj 12 PM ke baad" at 6:43 PM becomes kal', () => {
    const at643pm = new Date('2026-10-31T13:13:26Z');
    const out = re._fixPastCallTimes('Hamare Gemologist aapko aaj 12 PM ke baad call kar lenge.', at643pm);
    assert(/kal 12 PM/.test(out), out);
    const at1am = new Date('2026-10-30T19:30:00Z'); // 1 AM IST
    assert(/aaj subah 10 baje/.test(re._fixPastCallTimes('Team aapse aaj subah 10 baje ke baad contact karegi.', at1am)));
    assert(/today after 10 AM/.test(re._fixPastCallTimes("They'll contact you today after 10 AM.", at1am)));
  });

  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
