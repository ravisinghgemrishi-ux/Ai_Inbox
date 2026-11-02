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

// The CRM can only send Mannat's text as an approved template variable.
// Meta rejects variables containing new lines, tabs or more than four
// spaces in a row, and the whole body must stay under 1,024 characters.
// The 110 template already opens with "Namaste 🙏" and closes with
// "Warm regards, Mannat", so Mannat's own greeting / sign-off is dropped here.
const GREETING_WORD = /^(namaste|namaskar|hello|hi|hey)\b/i;
const TRAILING_SIGNOFF = /\n+\s*(?:warm\s+)?regards[\s\S]{0,60}$/i;

function dropGreeting(text) {
  const s = text.trimStart();
  if (!GREETING_WORD.test(s)) return text;
  const lines = s.split('\n');
  // "Namaste Ravi 🙏" alone on the first line -> drop the line.
  if (lines.length > 1 && lines[0].length <= 40) return lines.slice(1).join('\n');
  // "Namaste! 🙏 Pukhraj ..." / "Hi Ravi, the price ..." -> drop up to the first ! , .
  const m = s.match(/^[^\n!,.]{0,30}[!,.][\s\p{Extended_Pictographic}]*/u);
  return m ? s.slice(m[0].length) : text;
}

function templateParam(reply, max = 900) {
  let s = String(reply || '').replace(TRAILING_SIGNOFF, '');
  const stripped = dropGreeting(s).trim();
  if (stripped) s = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  s = s
    .replace(/\r/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => (/[.!?:;,…)]$/.test(l) || /\p{Extended_Pictographic}$/u.test(l) ? l : `${l}.`))
    .join(' ')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return s;
}

function secretOk(given, expected) {
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const OPT_OUT = /^\s*(stop|stop all|unsubscribe|band karo|mat bhejo|no more messages?)\s*[.!]*\s*$/i;

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
  // "STOP" (opt-out from a broadcast) never gets an AI reply; the CRM's own
  // WABA compliance handles the unsubscribe.
  if (OPT_OUT.test(text)) return { reply: '', reason: 'opt_out' };

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
    return res.status(200).json({ reply: out.reply, reply_param: templateParam(out.reply), send: 'yes' });
  } catch (err) {
    // Crash: say nothing (the CRM stops the run), log loudly.
    console.error('[crm-110] failed:', err.message);
    return res.status(500).json({ reply: '', send: 'no', error: 'internal' });
  }
};

module.exports.config = { maxDuration: 60 };
module.exports._internal = { handle, buildEvent, digitsOf, allowedNumber, secretOk, templateParam, OPT_OUT };
