// Run: node test/staff-whatsapp-off.manual-test.js  (no network)
// 2026-11-03 (Ravi): only CRM, no WhatsApp lead alerts to team phones.
const assert = require('assert');
delete process.env.STAFF_WHATSAPP_ALERTS;
process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID = 'acc-test';
const handoff = require('../lib/handoff');

(async () => {
  assert.strictEqual(handoff.staffWhatsAppOn(), false, 'off by default');
  // Nothing may touch the network: any fetch is a failure.
  global.fetch = async () => { throw new Error('network call while staff WhatsApp is off'); };
  assert.strictEqual(await handoff.notifyStaff('sales', 'x', 'k'), false);
  assert.strictEqual(await handoff._internal.sendWhatsAppAlert({ route: 'yogesh', id: '1' }, ''), 'off');
  const r = await handoff.staffCheckIn({ route: 'yogesh', conversationId: 'c', accountId: 'a' });
  assert(r.ok && r.off && r.delivered === 0);
  process.env.STAFF_WHATSAPP_ALERTS = 'on';
  assert.strictEqual(handoff.staffWhatsAppOn(), true, 'can be switched back on');
  console.log('staff-whatsapp-off: all assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
