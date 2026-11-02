// =============================================================================
// crm-whatsapp.js - Mannat on the CRM WhatsApp line (+91 91388 49110, "110")
//
// Added 2026-11-02 (Ravi): Mannat should answer customers on the CRM's own
// WhatsApp number the same way she answers on 220. The 110 number lives in
// the Zaptriq CRM (one WhatsApp provider per number), so the CRM does the
// sending and Mannat only does the thinking:
//
//   customer -> 110 -> CRM workflow "Message Received"
//     -> Outgoing Webhook POST here {phone, name, message, message_id}
//     <- {"reply": "..."}   (stored by the CRM as {{variables.api_response}})
//     -> 24 h window check -> "Send WABA Message" (free-form) -> customer
//
// The same brain as 220 runs (api/webhook.js handleMessage): memory, live
// product data, Kundli / consultation flows, guards, lead log sheet, staff
// handoffs and the CRM lead sync. Differences on 110:
//   - no Meta-ad-only gate: every customer chat gets an answer;
//   - staff numbers never get an AI reply;
//   - staff take over by tagging the contact "mannat-off" in the CRM (the
//     workflow skips this call), because Mannat cannot see CRM inbox replies;
//   - "say nothing" (e.g. this message was folded into a combined answer to
//     several quick messages, staff number, outside rollout) is answered
//     with HTTP 409; the webhook step's "If this step fails" = Stop workflow,
//     so the CRM sends nothing.
//
// Vercel settings:
//   MANNAT_CRM_SECRET           required; the CRM sends it as header
//                               x-mannat-secret
//   MANNAT_CRM_ALLOWED_NUMBERS  optional, comma separated; when set, ONLY
//                               these numbers get replies (rollout / tests)
//   MANNAT_CRM_REPLIES          off = acknowledge everything, never reply
// =============================================================================

const crypto = require('crypto');
const handoff = require('../lib/handoff');

let webhook = null;
function brain() {
  // Loaded lazily so a config error here never breaks the 220 webhook.
  if (!webhook) webhook = require('./webhook');
  return webhook;
}

function digitsOf(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && /^[6-9]/.test(d)) return `91${d}`;
  return d.length >= 10 && d.length <= 15 ? d : '';
}

function secretOk(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function allowedNumber(digits, list = process.env.MANNAT_CRM_ALLOWED_NUMBERS) {
  const allowed = String(list || '').split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.some((a) => digits.endsWith(a.slice(-10)));
}

function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Pure decision + synthetic event, kept separate for tests.
function buildEvent({ phone, name, message, messageId }) {
  const digits = digitsOf(phone);
  return {
    event: 'message.received',
    // No accountId: Mannat's Zernio sending / takeover checks are skipped.
    account: { platform: 'whatsapp' },
    conversation: {
      id: `crm110-${digits}`, platform: 'whatsapp',
      participantId: digits, participantPhone: digits,
      participantUsername: digits, participantName: String(name || '').trim(),
    },
    message: {
      // The CRM has no per-message id; a fresh id per call keeps the brain's
      // id gate from swallowing a repeated "ok" later. Same-text bursts are
      // still caught by its content dedupe.
      id: `crm110-${messageId ? String(messageId).slice(0, 120) : `${digits}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`}`,
      text: String(message || '').slice(0, 4000),
    },
    _crm: { reply: '' },
  };
}

async function handle(body, { env = process.env, run = (ev) => brain()._handleMessage(ev) } = {}) {
  const digits = digitsOf(body.phone);
  const text = String(body.message || body.text || '').trim();
  if (String(env.MANNAT_STANDBY || '').toLowerCase() === 'on') return { reply: '', reason: 'standby' };
  if (String(env.MANNAT_CRM_REPLIES || 'on').toLowerCase() === 'off') return { reply: '', reason: 'switched_off' };
  if (!digits || !text) return { reply: '', reason: 'missing_phone_or_message' };
  if (handoff.routeForStaffNumber(digits)) return { reply: '', reason: 'staff_number' };
  if (!allowedNumber(digits, env.MANNAT_CRM_ALLOWED_NUMBERS)) return { reply: '', reason: 'not_in_rollout' };

  const event = buildEvent({ phone: digits, name: body.name, message: text, messageId: body.message_id || body.messageId });
  await run(event);
  return { reply: event._crm.reply || '', reason: event._crm.reply ? 'replied' : 'no_reply' };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!secretOk(req.headers['x-mannat-secret'], process.env.MANNAT_CRM_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  try {
    const out = await handle(body || {});
    console.log('[crm-110]', JSON.stringify({ reason: out.reason, chars: out.reply.length }));
    // The CRM's Filter step cannot read webhook variables, so "say nothing"
    // is signalled with a non-2xx status: the workflow step is set to
    // "Stop workflow" on failure, so nothing is sent to the customer.
    if (!out.reply) return res.status(409).json({ reply: '', send: 'no', reason: out.reason });
    return res.status(200).json({ reply: out.reply, send: 'yes' });
  } catch (err) {
    // Crash: say nothing (the CRM stops the run), log loudly.
    console.error('[crm-110] failed:', err.message);
    return res.status(500).json({ reply: '', send: 'no', error: 'internal' });
  }
};

module.exports.config = { maxDuration: 60 };
module.exports._internal = { handle, buildEvent, digitsOf, allowedNumber, secretOk };
