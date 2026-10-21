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
  assert.ok(!wh._shouldDmCommenter({ platform: 'instagram', commentText: 'Blue sapphire price', result: { leadStatus: 'HOT' } }), 'no DM by default');
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
