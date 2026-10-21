// =============================================================================
// metaTracking.js - report Click-to-WhatsApp ad results back to Meta
// (2026-10-20, Ravi). Uses the CTWA dataset on Mannat's WhatsApp account.
//
//   LeadSubmitted - sent once per customer when Mannat forwards a genuine
//                   lead from a chat that came from a Meta ad.
//   Purchase      - sent when a team member reports a sale on WhatsApp to
//                   the 220 number:  "sold 9876543210 45000"
//
// Meta attributes the event to the ad click (Zernio replays the ctwa_clid
// it captured on the first message). Events for chats that did not come
// from an ad are simply not attributed. Off-switch: META_TRACKING=off.
// =============================================================================
const { sendWhatsAppConversion } = require('./zernioClient');
const { parseBudget, last10 } = require('./handoff');

function enabled() {
  return String(process.env.META_TRACKING || 'on').toLowerCase() !== 'off';
}
function accountId() {
  return process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID || String(process.env.MANNAT_WHATSAPP_ACCOUNT_IDS || '').split(',')[0].trim();
}

async function leadSubmitted({ phone, conversationId, budget, productInterest }) {
  if (!enabled() || !accountId()) return { sent: false, reason: 'off' };
  const n = last10(phone);
  if (!n && !conversationId) return { sent: false, reason: 'no phone or conversation' };
  const value = parseBudget(budget) || undefined;
  try {
    // Prefer the actual inbox conversation: phone lookup fails for customers
    // whose number is not linked to a Click-to-WhatsApp ad conversation.
    await sendWhatsAppConversion({
      apiKey: process.env.ZERNIO_API_KEY, accountId: accountId(), eventName: 'LeadSubmitted',
      eventId: `lead-${conversationId || `91${n}`}`, conversationId: conversationId || undefined,
      phone: conversationId ? undefined : `91${n}`, value,
    });
    console.log('[meta] LeadSubmitted sent', n ? n.slice(-4) : 'conversation', productInterest || '');
    return { sent: true };
  } catch (err) {
    const message = String(err.message || '');
    // A chat without CTWA attribution is not a conversion API failure that
    // needs retrying; keep it out of the error stream and continue handoff.
    if (/No CTWA-attributed conversation found/i.test(message)) {
      console.log('[meta] LeadSubmitted skipped: conversation has no CTWA attribution');
      return { sent: false, reason: 'not_ctwa_attributed' };
    }
    console.error('[meta] LeadSubmitted failed:', message);
    return { sent: false, reason: message };
  }
}

// "sold 9876543210 45000" / "sale 98765 43210 1.2 lakh" / "sold +91 98765-43210 45k"
const SALE_RE = /^\s*(sold|sale|bika|bik\s*gaya|order\s*done)\b/i;
function parseSaleCommand(text) {
  const t = String(text || '');
  if (!SALE_RE.test(t)) return null;
  const tokens = t.replace(SALE_RE, ' ').trim().split(/\s+/).filter(Boolean);
  // The phone is the first run of number tokens that adds up to exactly
  // 10 digits (or 12 starting 91); whatever is left is the amount.
  for (let i = 0; i < tokens.length; i += 1) {
    let digits = '';
    for (let j = i; j < tokens.length && /^[+\d-]+$/.test(tokens[j]); j += 1) {
      digits += tokens[j].replace(/\D/g, '');
      const ok = digits.length === 10 || (digits.length === 12 && digits.startsWith('91'));
      if (ok) {
        const phone = digits.slice(-10);
        const amount = parseBudget([...tokens.slice(0, i), ...tokens.slice(j + 1)].join(' '));
        return amount ? { phone, amount } : { error: 'amount', phone };
      }
      if (digits.length > 12) break;
    }
  }
  return { error: 'phone' };
}

async function purchase({ phone, amount, reportedBy }) {
  if (!enabled() || !accountId()) return { sent: false, reason: 'off' };
  try {
    await sendWhatsAppConversion({
      apiKey: process.env.ZERNIO_API_KEY, accountId: accountId(), eventName: 'Purchase',
      eventId: `sale-91${phone}-${amount}`, phone: `91${phone}`, value: amount,
    });
    console.log('[meta] Purchase sent', phone.slice(-4), amount, reportedBy || '');
    return { sent: true };
  } catch (err) {
    console.error('[meta] Purchase failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { leadSubmitted, purchase, parseSaleCommand };
