// 2026-10-21 (Ravi): comments are solved under the comment; WhatsApp "INSTA"
// line only when the same customer keeps asking. Run: node test/comments-public.manual-test.js
const assert = require('assert');
const bridge = require('../lib/identityBridge');
let state = null;
bridge.isEnabled = () => true;
bridge.getCustomer = async () => ({ channels: {} });
const cc = require('../lib/crossChannel');
const wh = require('../api/webhook.js');

(async () => {
  assert.ok(wh._shouldDmCommenter({ platform: 'instagram', commentText: 'Blue sapphire price', result: { leadStatus: 'HOT' } }), 'private DM still sent');
  assert.ok(/40 words/.test(wh._WHATSAPP_SHORT_NOTE));
  const identity = { grId: 'gr_test', channel: 'instagram' };
  const base = { identity, reply: 'Our 5 ratti Neelam is ₹45,000.', intent: 'price_query', leadStatus: 'HOT', isComment: true };
  // inviteState lives in Redis; without Redis the try/catch path returns unchanged,
  // so stub the invite helpers through the module's own exports when available.
  let r = await cc.maybeAppendInvite({ ...base, existingMemory: '' });
  assert.strictEqual(r.invited, false, 'first comment: answered publicly, no WhatsApp line');
  r = await cc.maybeAppendInvite({ ...base, existingMemory: 'Customer: Pp\nMannat: ...', leadStatus: 'COLD' });
  assert.strictEqual(r.invited, false, 'cold repeat: no invite');
  r = await cc.maybeAppendInvite({ ...base, existingMemory: 'Customer: Neelam price?\nMannat: ...', leadStatus: 'WARM', intent: 'general' });
  assert.strictEqual(r.invited, true, 'keeps asking under comments -> WhatsApp INSTA line');
  assert.ok(/INSTA/.test(r.reply) && /74969 97220/.test(r.reply) && r.reply.startsWith('Our 5 ratti'));
  r = await cc.maybeAppendInvite({ ...base, existingMemory: 'Customer: Neelam price?\nMannat: ...', hindi: true });
  assert.ok(/INSTA/.test(r.reply) && /WhatsApp karein/.test(r.reply), 'Hindi line');
  // DMs unchanged: never in the first reply
  r = await cc.maybeAppendInvite({ ...base, isComment: false, existingMemory: '' });
  assert.strictEqual(r.invited, false);
  console.log('comments-public tests passed');
})().catch((e) => { console.error(e); process.exit(1); });

// 2026-10-21: customer is told their requirement went to the team
{
  const wh2 = require('../api/webhook.js');
  const night = new Date('2026-10-21T17:30:00Z'); // 11 PM IST
  const day = new Date('2026-10-21T06:30:00Z'); // 12 PM IST
  const early = new Date('2026-10-21T02:30:00Z'); // 8 AM IST
  let t = wh2._withForwardedLine('Our 5 ratti Neelam is ₹45,000.', { trigger: 'HOT lead, number given', now: night });
  assert.ok(/shared your requirements with our team/.test(t) && /tomorrow after 10 AM/.test(t) && /10 AM - 8 PM/.test(t), t);
  t = wh2._withForwardedLine('Ji, 5 ratti Neelam ₹45,000 ka hai.', { trigger: 'x', hindi: true, now: early });
  assert.ok(/team ko share kar di hai/.test(t) && /aaj subah 10 baje/.test(t), t);
  t = wh2._withForwardedLine('Great choice.', { trigger: 'x', now: day });
  assert.ok(/get in touch with you shortly/.test(t));
  assert.strictEqual(wh2._withForwardedLine('Great choice.', { trigger: '', now: day }), 'Great choice.', 'no forward, no line');
  assert.strictEqual(wh2._withForwardedLine('Great choice.', { trigger: 'x', existingMemory: "Mannat: I've shared your requirements with our team ✅", now: day }), 'Great choice.', 'only once per chat');
  console.log('forwarded-line tests passed');
}
