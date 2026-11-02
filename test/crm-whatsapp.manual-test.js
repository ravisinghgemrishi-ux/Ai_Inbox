// Run: node test/crm-whatsapp.manual-test.js  (no network: the brain is faked)
const assert = require('assert');
const { handle, buildEvent, digitsOf, allowedNumber, secretOk } = require('../api/crm-whatsapp')._internal;
const handoff = require('../lib/handoff');

(async () => {
  assert.strictEqual(digitsOf('9235621260'), '919235621260');
  assert.strictEqual(digitsOf('+91 92356 21260'), '919235621260');
  assert.strictEqual(digitsOf('abc'), '');

  assert(secretOk('s3cret', 's3cret'));
  assert(!secretOk('s3cret', 'other!'));
  assert(!secretOk('', 's3cret'));
  assert(!secretOk('s3cret', ''));

  assert(allowedNumber('919235621260', ''));
  assert(allowedNumber('919235621260', '9235621260, 9999999999'));
  assert(!allowedNumber('918888888888', '9235621260'));

  // Synthetic event: whatsapp, own conversation id per number, no Zernio account.
  const ev = buildEvent({ phone: '9235621260', name: 'Ravi', message: 'price?', messageId: 'wamid.1' });
  assert.strictEqual(ev.account.platform, 'whatsapp');
  assert(!ev.account.accountId);
  assert.strictEqual(ev.conversation.id, 'crm110-919235621260');
  assert.strictEqual(ev.conversation.participantPhone, '919235621260');
  assert.strictEqual(ev.message.id, 'crm110-wamid.1');
  assert.strictEqual(ev._crm.reply, '');
  // No id from the CRM -> a fresh one every call (never a shared id).
  const a = buildEvent({ phone: '9235621260', message: 'ok' }).message.id;
  const b = buildEvent({ phone: '9235621260', message: 'ok' }).message.id;
  assert(a.startsWith('crm110-919235621260-') && a !== b);

  // Brain reply is returned.
  const env = { MANNAT_CRM_REPLIES: 'on' };
  let seen = null;
  let out = await handle({ phone: '+919235621260', name: 'Ravi', message: 'Pukhraj price?' }, { env, run: async (e) => { seen = e; e._crm.reply = '₹8,080 for 5.40 ct'; } });
  assert.strictEqual(out.reply, '₹8,080 for 5.40 ct');
  assert.strictEqual(seen.message.text, 'Pukhraj price?');

  // Folded into a combined answer -> empty reply (CRM must send nothing).
  out = await handle({ phone: '9235621260', message: 'hi' }, { env, run: async () => {} });
  assert.strictEqual(out.reply, '');
  assert.strictEqual(out.reason, 'no_reply');

  // Never runs the brain for: standby, switched off, missing data, staff, outside rollout.
  const never = async () => { throw new Error('brain should not run'); };
  assert.strictEqual((await handle({ phone: '9235621260', message: 'x' }, { env: { MANNAT_STANDBY: 'on' }, run: never })).reason, 'standby');
  assert.strictEqual((await handle({ phone: '9235621260', message: 'x' }, { env: { MANNAT_CRM_REPLIES: 'off' }, run: never })).reason, 'switched_off');
  assert.strictEqual((await handle({ phone: '', message: 'x' }, { env, run: never })).reason, 'missing_phone_or_message');
  assert.strictEqual((await handle({ phone: '9235621260', message: '  ' }, { env, run: never })).reason, 'missing_phone_or_message');
  const staffPhone = Object.values(handoff.ROUTES).map((r) => r.phone).find(Boolean);
  if (staffPhone) assert.strictEqual((await handle({ phone: staffPhone, message: 'any lead?' }, { env, run: never })).reason, 'staff_number');
  assert.strictEqual((await handle({ phone: '9888888888', message: 'x' }, { env: { MANNAT_CRM_ALLOWED_NUMBERS: '9235621260' }, run: never })).reason, 'not_in_rollout');

  // The real brain exports the handler this endpoint calls.
  assert.strictEqual(typeof require('../api/webhook')._handleMessage, 'function');

  console.log('crm-whatsapp: all assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
