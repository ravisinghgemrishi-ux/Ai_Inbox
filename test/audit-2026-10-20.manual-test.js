// Manual test for the 2026-10-20 audit fixes. Run: node test/audit-2026-10-20.manual-test.js
// Pure functions only - no network. Messages are real ones from the lead log.
const assert = require('assert');
const r = require('../lib/replyEngine');
const g = require('../lib/conversationGuards');
const h = require('../lib/handoff');

// ---- Fix 1: price safety line -------------------------------------------
const live = JSON.stringify({ products: [
  { url: 'https://gemrishi.com/product/yellow-sapphire-8-20-carats-pkraj-320', price_inr: 51762 },
] });
const hindiChat = 'RECENT CONVERSATION:\nCustomer: Hloo sir 9.15 ratti pukhraj milega apke pas\nMannat: Hello!\nCustomer: 15000 ki rage ma chahiye bhai';

// A verified price stays -> no "I'll confirm the price" line tacked on.
let out = r._applyPriceSafety('Ek option ₹51,762 ka hai. Doosra ₹49,999 ka hai.', live, 'Kam rage hogi koi 50 hzr tk', hindiChat);
assert.ok(out.text.includes('₹51,762') && !out.text.includes('49,999'), 'unverified price removed, verified kept');
assert.ok(!/confirm/i.test(out.text), 'no confirm line while a real price is still there');
assert.ok(out.removed && out.priceLeft);

// No price left -> line in the chat's language (Hindi from earlier turns).
out = r._applyPriceSafety('Yeh 8.20 carat wala ₹49,999 ka hai. Aapko ring chahiye ya loose?', live, 'Kam rage hogi koi 50 hzr tk', hindiChat);
assert.ok(/team se confirm/i.test(out.text), 'Hindi line for a Hindi chat');
assert.ok(!/I'll confirm/.test(out.text));
assert.ok(out.removed && !out.priceLeft);
assert.ok(h.promisesTeamFollowUp("I'll confirm the exact current price with the team and get back to you."), 'English line still alerts the team');

// No price left -> the chat is escalated (jaiinterior.8103 "6.5 panna price").
const norm = r._normalizeResult({ reply: 'The 6.5 ratti Panna is ₹23,000. Could you share your preferred budget?', leadStatus: 'HOT', productInterest: 'Emerald (Panna)', escalate: false, escalateReason: '' }, live, '6.5 panna price', '');
assert.strictEqual(norm.escalate, true, 'customer left without a price -> escalate');
assert.ok(/price_needed/.test(norm.escalateReason));
assert.ok(!norm.reply.includes('23,000'));

// Real price, nothing removed -> no escalation.
const ok = r._normalizeResult({ reply: 'This one is ₹51,762.', leadStatus: 'HOT', escalate: false, escalateReason: '' }, live, 'price?', '');
assert.strictEqual(ok.escalate, false);

// ---- Fix 2: handover for repeated asks / frustration ----------------------
const mem = (lines) => lines.map(([who, t]) => `${who}: ${t}`).join('\n');
const aju = [
  ['Customer', 'Hloo sir 9.15 ratti pukhraj milega apke pas'],
  ['Mannat', 'Hello! Yes, we have 9.15 ratti ...'],
  ['Customer', '15000 hzr tak ni hai\nGold'],
  ['Mannat', '...'],
  ['Customer', '9.15 ratti bala chahiye'],
  ['Mannat', '...'],
];
let c = g.handoverCheck({ memory: mem(aju.slice(0, 2)), message: '9.15 ratti bala chahiye' });
assert.strictEqual(c.escalate, false, '2nd ask is fine');
c = g.handoverCheck({ memory: mem(aju), message: '15000 ki rage ma chahiye bhai 9.15 ratti bala mil skta hai yes no kro' });
assert.strictEqual(c.escalate, true, '3rd ask of the same size -> handover');
assert.ok(/9\.15 ratti/.test(c.reason) && /do NOT suggest any other product/.test(c.note));
c = g.handoverCheck({ memory: mem(aju), message: 'Tbse bol rha 9.15 chahiye phir bar bar dusra bta rha' });
assert.strictEqual(c.escalate, true, 'bare 9.15 after two asks + "bar bar"');
for (const m of ['Block kr rha', 'Chahiye hi ni mujhe', 'Bye MSG krna hi bekar hai', 'not interested, stop messaging']) {
  assert.strictEqual(g.handoverCheck({ memory: '', message: m }).escalate, true, m);
}
c = g.handoverCheck({ memory: '', message: 'Thankuu reply ke liye bye' });
assert.strictEqual(c.escalate, false); assert.ok(c.leaving && /CLOSING/.test(c.note), 'polite bye -> short close, no pitch');
for (const m of ['6.5 panna price', 'Ring', 'Ineed emerald', 'Kitne tak mil skta ha', '25000 tak']) {
  const x = g.handoverCheck({ memory: mem(aju), message: m });
  assert.ok(!x.escalate && !x.leaving, `normal turn untouched: ${m}`);
}
assert.ok(/do not ask for it/.test(g.handoverCheck({ memory: '', message: 'block', knownPhone: '+919999999999' }).note));

console.log('2026-10-20 audit tests passed');
