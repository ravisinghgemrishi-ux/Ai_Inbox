// =============================================================================
// metaTracking.js - report qualified Click-to-WhatsApp leads and confirmed sales
// to Meta through Zernio. Only supported WhatsApp conversion events are sent.
// Off-switch: META_TRACKING=off.
// =============================================================================
const crypto = require('crypto');
const { sendWhatsAppConversion } = require('./zernioClient');
const { parseBudget, last10 } = require('./handoff');

function enabled() {
  return String(process.env.META_TRACKING || 'on').toLowerCase() !== 'off';
}
function accountId(sourceAccountId) {
  // Prefer the account that actually received this customer conversation.
  // Never fan one conversion out to every connected number: that duplicates events
  // and can misattribute a CTWA click to the wrong WhatsApp Business account.
  return String(sourceAccountId || process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID ||
    String(process.env.MANNAT_WHATSAPP_ACCOUNT_IDS || '').split(',')[0] || '').trim();
}
function eventId(prefix, identity) {
  // Stable and safely bounded; do not include customer PII in Meta's event id.
  const digest = crypto.createHash('sha256').update(String(identity || '')).digest('hex').slice(0, 32);
  return `${prefix}-${digest}`;
}
function attributionSkip(err) {
  return /No CTWA-attributed conversation found/i.test(String(err?.message || ''));
}

async function leadSubmitted({ phone, conversationId, accountId: sourceAccountId, productInterest } = {}) {
  const conversionAccountId = accountId(sourceAccountId);
  if (!enabled() || !conversionAccountId) return { sent: false, reason: 'off_or_missing_account' };
  const n = last10(phone);
  if (!n && !conversationId) return { sent: false, reason: 'no_phone_or_conversation' };
  try {
    // A lead's stated budget is NOT revenue. Omit value/currency on LeadSubmitted
    // rather than teaching Meta that a budget is a completed purchase.
    const result = await sendWhatsAppConversion({
      apiKey: process.env.ZERNIO_API_KEY,
      accountId: conversionAccountId,
      eventName: 'LeadSubmitted',
      eventId: eventId('lead', conversationId || `91${n}`),
      conversationId: conversationId || undefined,
      phone: conversationId ? undefined : `91${n}`,
    });
    const receipt = conversionReceipt(result);
    console.log('[meta] LeadSubmitted API response', JSON.stringify({ productInterest: productInterest || '', ...receipt }));
    if (receipt.failed) return { sent: false, reason: 'provider_reported_failure', ...receipt };
    return { sent: true, ...receipt };
  } catch (err) {
    if (attributionSkip(err)) {
      console.log('[meta] LeadSubmitted skipped: conversation has no CTWA attribution');
      return { sent: false, reason: 'not_ctwa_attributed' };
    }
    console.error('[meta] LeadSubmitted failed:', String(err.message || err));
    return { sent: false, reason: String(err.message || err) };
  }
}

function conversionReceipt(result) {
  const data = result && typeof result === 'object' ? result : {};
  const eventsReceived = Number(data.eventsReceived ?? data.events_received ?? NaN);
  const eventsFailed = Number(data.eventsFailed ?? data.events_failed ?? NaN);
  const failures = Array.isArray(data.failures) ? data.failures : [];
  return {
    traceId: data.traceId || data.trace_id || undefined,
    eventsReceived: Number.isFinite(eventsReceived) ? eventsReceived : undefined,
    eventsFailed: Number.isFinite(eventsFailed) ? eventsFailed : undefined,
    failures: failures.length ? failures : undefined,
    // A 200 response alone is not proof Meta accepted the event.
    failed: (Number.isFinite(eventsFailed) && eventsFailed > 0) || failures.length > 0 ||
      (Number.isFinite(eventsReceived) && eventsReceived === 0),
  };
}

// Accepted team command examples:
// "sold 9876543210 45000", "sale 98765 43210 1.2 lakh",
// "sold +91 98765-43210 45k"
const SALE_RE = /^\s*(sold|sale|bika|bik\s*gaya|order\s*done)\b/i;
function parseSaleCommand(text) {
  const t = String(text || '');
  if (!SALE_RE.test(t)) return null;
  const tokens = t.replace(SALE_RE, ' ').trim().split(/\s+/).filter(Boolean);
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

async function purchase({ phone, amount, reportedBy, orderId, conversationId } = {}) {
  if (!enabled() || !accountId()) return { sent: false, reason: 'off_or_missing_account' };
  const n = last10(phone);
  const value = Number(amount);
  if (!n) return { sent: false, reason: 'invalid_phone' };
  if (!Number.isFinite(value) || value <= 0) {
    return { sent: false, reason: 'purchase_requires_positive_actual_sale_amount' };
  }
  // Use orderId when available so two separate orders with the same value
  // from one customer remain distinct; otherwise retain deterministic dedupe.
  const identity = orderId ? `order:${orderId}` : `sale:91${n}:${value}`;
  try {
    const result = await sendWhatsAppConversion({
      apiKey: process.env.ZERNIO_API_KEY,
      accountId: accountId(),
      eventName: 'Purchase',
      eventId: eventId('purchase', identity),
      conversationId: conversationId || undefined,
      phone: conversationId ? undefined : `91${n}`,
      value,
      currency: 'INR',
    });
    const receipt = conversionReceipt(result);
    console.log('[meta] Purchase API response', JSON.stringify({
      phoneLast4: n.slice(-4), value, currency: 'INR', reportedBy: reportedBy || '', ...receipt,
    }));
    if (receipt.failed) return { sent: false, reason: 'provider_reported_failure', ...receipt };
    return { sent: true, ...receipt };
  } catch (err) {
    if (attributionSkip(err)) {
      console.log('[meta] Purchase skipped: conversation has no CTWA attribution');
      return { sent: false, reason: 'not_ctwa_attributed' };
    }
    console.error('[meta] Purchase failed:', String(err.message || err));
    return { sent: false, reason: String(err.message || err) };
  }
}

module.exports = { leadSubmitted, purchase, parseSaleCommand, _internal: { conversionReceipt, eventId } };
