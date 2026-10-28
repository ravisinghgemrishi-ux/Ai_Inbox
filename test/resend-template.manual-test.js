// Failed / stuck template alerts must be re-sent on check-in. Run: node test/resend-template.manual-test.js
const assert = require('assert');
process.env.REDIS_KV_REST_API_URL = 'https://fake-redis.test';
process.env.REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZERNIO_API_KEY = 'x';
const store = {};
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const tpl = (ph) => `New GemRishi lead for not given.\n\nCustomer: not given\nPhone: ${ph}\nInterested in: Yellow Sapphire\nBudget: not given\nSource: whatsapp (${ph})\nReason for forwarding: HOT lead, number given\nRecent customer messages: price?\n\nPlease follow up with this lead.`;
const m = (id, status, text, min) => ({ id, direction: 'outgoing', deliveryStatus: status, message: text, createdAt: ago(min), metadata: { templateName: 'mannat_lead_alert_new' } });
global.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname.includes('zernio')) {
    return { ok: true, json: async () => ({ messages: [
      m('t1', 'failed', tpl('+917011620816'), 600),
      m('t2', 'sent', tpl('+919213241706'), 120),        // stuck on "sent"
      m('t3', 'sent', tpl('+919999999999'), 5),          // too fresh, leave alone
      m('t4', 'delivered', tpl('+918888888888'), 120),   // delivered, ignore
      m('t5', 'failed', tpl('+918218731735'), 600),      // already passed on manually (spaced format)
      { id: 'h1', direction: 'outgoing', deliveryStatus: 'read', message: 'Lakshya ye lead: +91 82187 31735 Yellow Sapphire', createdAt: ago(30) },
    ] }) };
  }
  const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean);
  const [cmd, key] = parts; let result = null;
  if (cmd === 'set') { const nx = parts.includes('NX'); if (nx && store[key]) result = null; else { store[key] = '1'; result = 'OK'; } }
  return { ok: true, json: async () => ({ result }) };
};
const h = require('../lib/handoff');
(async () => {
  const out = await h._internal.failedAlerts({ route: 'yogesh', conversationId: 'c', accountId: 'a' });
  assert.strictEqual(out.length, 2, 'failed + stuck-sent re-sent; fresh, delivered and already-passed skipped');
  assert.ok(out.every((t) => /Yogesh, naya lead/.test(t)));
  assert.ok(out.some((t) => t.includes('+917011620816')) && out.some((t) => t.includes('+919213241706')));
  const again = await h._internal.failedAlerts({ route: 'yogesh', conversationId: 'c', accountId: 'a' });
  assert.strictEqual(again.length, 0, 'never re-sent twice');
  console.log('resend template tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
