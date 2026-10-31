// Staff check-in + WhatsApp lead delivery (2026-10-20). Fake Redis + Zernio, no network.
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis.test';
process.env.REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZERNIO_API_KEY = 'k';
process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID = 'acc220';
process.env.LEAD_ALERT_TEMPLATE = 'mannat_lead_alert';
process.env.LEAD_ALERT_TEMPLATE_CONFIRMED = 'true'; // template + Direct Send are opt-in since 2026-10-21
process.env.LEAD_ALERT_DIRECT_SEND = 'on';
const store = {}; const lists = {}; const sent = [];
let templateOk = false; let directOk = false;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === 'fake-redis.test') {
    const [cmd, key, val] = decodeURIComponent(u.pathname).split('/').filter(Boolean);
    let result = null;
    if (cmd === 'get') result = store[key] ?? null;
    else if (cmd === 'set') { store[key] = val; result = 'OK'; }
    else if (cmd === 'rpush') { (lists[key] = lists[key] || []).push(val); result = lists[key].length; }
    else if (cmd === 'lrange') result = lists[key] || [];
    else if (cmd === 'del') { delete lists[key]; delete store[key]; result = 1; }
    else if (cmd === 'expire' || cmd === 'incr') result = 1;
    return { ok: true, json: async () => ({ result }) };
  }
  if ((opts.method || 'GET') === 'GET') return { ok: true, json: async () => ({ messages: [] }) }; // message history lookup
  const body = JSON.parse(opts.body || '{}');
  const isTemplate = Boolean(body.templateName); const isDirect = body.category === 'utility' && !u.pathname.includes('/messages');
  if ((isTemplate && !templateOk) || (isDirect && !directOk)) return { ok: false, status: 400, text: async () => 'not allowed' };
  sent.push({ path: u.pathname, body });
  return { ok: true, json: async () => ({}) };
};
const h = require('../lib/handoff');
const alert = h._internal.sendWhatsAppAlert;
(async () => {
  assert.strictEqual(h.routeForStaffNumber('919817975972'), 'neel');
  assert.strictEqual(h.routeForStaffNumber('+91 70158 68891'), 'yogesh');
  assert.strictEqual(h.routeForStaffNumber('919817975977'), 'vishvas');
  assert.strictEqual(h.routeForStaffNumber('919999999999'), '');

  const item = (n) => ({ route: 'yogesh', id: `yogesh:c${n}`, key: `c${n}`, customerPhone: `+91900000000${n}`, productInterest: 'Opal 5 ratti', platform: 'whatsapp', contact: `91900000000${n}`, trigger: 'HOT lead' });

  // 1. no window, template not approved, Direct Send not eligible -> waits
  assert.strictEqual(await alert(item(1), 'Customer: opal chahiye'), 'pending');
  assert.strictEqual(lists['gemrishi:staff-pending:yogesh'].length, 1);

  // 2. Yogesh checks in -> confirmation + the waiting lead, window open
  const res = await h.staffCheckIn({ route: 'yogesh', conversationId: 'conv-y', accountId: 'acc220' });
  assert.strictEqual(res.delivered, 1);
  assert.ok(/1 lead waiting/.test(sent[0].body.message));
  assert.ok(/Opal 5 ratti/.test(sent[1].body.message));
  assert.ok(!lists['gemrishi:staff-pending:yogesh']);

  // 3. next lead goes straight into Yogesh's chat
  sent.length = 0;
  assert.strictEqual(await alert(item(2), ''), 'window');
  assert.ok(sent[0].path.includes('/conv-y/messages'));

  // 4. Vishvas has no window: template approved -> template
  sent.length = 0; templateOk = true;
  assert.strictEqual(await alert({ ...item(3), route: 'vishvas', id: 'vishvas:c3' }, ''), 'template');
  // 5. template fails but Direct Send eligible -> direct send
  templateOk = false; directOk = true;
  assert.strictEqual(await alert({ ...item(4), route: 'neel', id: 'neel:c4' }, ''), 'direct_send');

  // check-in with nothing waiting
  sent.length = 0;
  await h.staffCheckIn({ route: 'neel', conversationId: 'conv-n', accountId: 'acc220' });
  assert.ok(/no new leads right now/.test(sent[0].body.message));
  console.log('Staff check-in tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
