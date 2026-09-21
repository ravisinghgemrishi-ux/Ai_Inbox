const HUMAN_INTENT_PATTERNS = [
  /order\s*(status|number|tracking)|track\s*(my|the)?\s*order|where.*order|shipment|delivery/i,
  /refund|return|replacement|wrong\s*(item|product)|damaged|broken|complaint|angry|disappointed/i,
  /discount|coupon|promo|negotiate|kam\s*price|lower\s*price/i,
  /medical|medicine|legal|lawyer|guarantee|guaranteed|guarantee\s*result/i,
  /how\s*do\s*i\s*pay|payment\s*(issue|problem)|payment\s*link/i,
];

function getDeterministicEscalation(message = '', sendFailed = false) {
  const text = String(message || '').trim();
  if (sendFailed) return { escalate: true, reason: 'reply_send_failed' };
  for (const pattern of HUMAN_INTENT_PATTERNS) {
    if (pattern.test(text)) return { escalate: true, reason: 'human_required_intent' };
  }
  return { escalate: false, reason: '' };
}

function mergeEscalation(aiResult = {}, message = '', sendFailed = false) {
  const deterministic = getDeterministicEscalation(message, sendFailed);
  if (deterministic.escalate) {
    return {
      ...aiResult,
      escalate: true,
      escalateReason: aiResult.escalateReason || deterministic.reason,
    };
  }
  return aiResult;
}

module.exports = { getDeterministicEscalation, mergeEscalation };
