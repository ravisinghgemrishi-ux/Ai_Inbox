// =============================================================================
// contactAsk.js - ask engaged Instagram DM customers for name + number
//
// Added 2026-10-31 (Ravi): the CRM matches leads by phone, so an Instagram
// lead with no number never reaches the sales team. Once a customer is
// actually talking to Mannat (their 2nd message or later), Mannat asks for
// their name and WhatsApp number - politely, after answering their question.
//
// At most 2 asks per chat:
//   1st - on the customer's 2nd+ message, if they are a buying lead
//   2nd - only when the chat later becomes HOT / escalated and there is
//         still no number (the moment the team needs it)
// Never asked when: we already have the number, the reply already asks for
// it, the "continue on WhatsApp?" invite was added this turn, it's a support
// case or not a lead, or a team member is handling the chat.
// Switch off with IG_CONTACT_ASK=false.
// =============================================================================

const { _patterns: { PHONE_ASK } } = require('./conversationGuards');

const SUPPORT_RE = /return|refund|replace|exchange|damaged|wrong item|complaint/i;

function enabled() {
  return process.env.IG_CONTACT_ASK !== 'false';
}

// How many customer messages are in the saved chat (before this one).
function priorCustomerTurns(memory) {
  return (String(memory || '').match(/^Customer:/gm) || []).length;
}

function askLine({ hindi, haveName }) {
  if (hindi) {
    return haveName
      ? 'Exact options aur photos personally share karne ke liye, kya aap apna WhatsApp number bata sakte hain? Hamare gem expert aapse connect karenge.'
      : 'Exact options aur photos personally share karne ke liye, kya aap apna naam aur WhatsApp number bata sakte hain? Hamare gem expert aapse connect karenge.';
  }
  return haveName
    ? 'So our gem expert can personally share exact options and photos, could you share your WhatsApp number?'
    : 'So our gem expert can personally share exact options and photos, could you share your name and WhatsApp number?';
}

// Returns '' (do nothing) or the line to append. asksSoFar comes from Redis.
function decide({
  platform, type, reply, priorMemory, knownPhone, knownName, leadStatus, escalated,
  intent, escalateReason, invitedThisTurn, asksSoFar = 0, hindi = false,
}) {
  if (!enabled()) return '';
  if (!String(platform || '').toLowerCase().includes('instagram') || type === 'comment') return '';
  if (knownPhone) return '';
  if (!reply || PHONE_ASK.test(reply) || /\bnumber\b/i.test(reply)) return '';
  if (invitedThisTurn) return '';
  if (intent === 'support_issue' || SUPPORT_RE.test(String(escalateReason || ''))) return '';
  const status = String(leadStatus || '').toUpperCase();
  if (status === 'NOT_A_LEAD' || status === 'COLD') return '';
  if (/human_takeover|team member/i.test(String(escalateReason || ''))) return '';
  if (priorCustomerTurns(priorMemory) < 1) return ''; // not until they reply to Mannat
  if (asksSoFar >= 2) return '';
  if (asksSoFar === 1 && !(status === 'HOT' || escalated)) return '';
  return askLine({ hindi, haveName: Boolean(knownName) });
}

module.exports = { decide, _internal: { priorCustomerTurns, askLine } };
