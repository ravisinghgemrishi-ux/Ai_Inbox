const {
  BRAND_VOICE,
  GEMSTONE_CATALOG_NOTES,
  CATALOG_NOTES,
  CONSULTATION_PLAN_NOTES,
  ESCALATION_RULES,
  LEAD_QUALIFICATION_RUBRIC,
} = require('./knowledgeBase');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_RETRIES = 2;

const SYSTEM_INSTRUCTION = `${BRAND_VOICE}

--- GEMSTONE CATALOG NOTES ---
${GEMSTONE_CATALOG_NOTES}

--- RUDRAKSHA CATALOG NOTES ---
${CATALOG_NOTES}

--- CONSULTATION PLAN NOTES ---
${CONSULTATION_PLAN_NOTES}

--- ESCALATION RULES ---
${ESCALATION_RULES}

--- LEAD SCORING ---
${LEAD_QUALIFICATION_RUBRIC}

--- PRICE SAFETY (NON-NEGOTIABLE) ---
Never quote, repeat, infer, calculate, or describe an indicative/handbook price as the current GemRishi selling price.
The only price that may be presented as a current price is a price explicitly supplied to you in CURRENT_LIVE_PRODUCT_DATA.
If CURRENT_LIVE_PRODUCT_DATA is absent, empty, or does not contain the requested product, say that you will confirm the exact current price with the team. You may still identify the product and mark the lead HOT when appropriate.
The handbooks are knowledge/reference material, not a live pricing source.

--- ESCALATION ACKNOWLEDGEMENT (IMPORTANT) ---
When a message requires human help (order tracking/status, refund/return/replacement, damaged/wrong item, complaint, discount negotiation, medical/legal/guarantee requests, or another case requiring account/order access), set escalate=true BUT still provide a short customer-facing acknowledgement in reply. Never use placeholders such as "held for human review" in the customer-facing reply. Acknowledge the request, say the team will check/help, and ask for only the minimum information needed (for example, order number for order issues). Do not invent order data, tracking details, refunds, guarantees, or other unavailable facts.
`.trim();

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    leadStatus: { type: 'string', enum: ['HOT', 'WARM', 'COLD', 'NOT_A_LEAD'] },
    productInterest: { type: 'string' },
    escalate: { type: 'boolean' },
    escalateReason: { type: 'string' },
  },
  required: ['reply', 'leadStatus', 'productInterest', 'escalate', 'escalateReason'],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 8000);
  return Math.min(1000 * (2 ** attempt) + Math.floor(Math.random() * 300), 8000);
}

function enforcePriceSafety(reply, liveProductData) {
  if (liveProductData) return String(reply || '').trim();
  const text = String(reply || '').trim();
  const hasCurrency = /(?:₹|Rs\.?|INR)\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:₹|Rs\.?|INR)/i.test(text);
  if (!hasCurrency) return text;
  // Generic fallback — must not name a specific product category, since this
  // path can fire for a gemstone reply just as easily as a Rudraksha reply.
  return 'Hari Om! Main aapko exact current price team se confirm karke batati hoon. Agar aap chahein, main aapke liye suitable option bhi check karwa sakti hoon. - Mannat';
}

function ensureEscalationAcknowledgement(reply, escalate, escalateReason, productInterest) {
  if (!escalate) return String(reply || '').trim();
  const text = String(reply || '').trim();
  if (text && !/^\(held for human review\)$/i.test(text) && !/^held for human review$/i.test(text)) return text;

  const reason = `${escalateReason || ''} ${productInterest || ''}`.toLowerCase();
  if (/order|track|tracking|status|delivery|shipment/.test(reason)) {
    return 'Ji, main aapki help karti hoon. Order status/tracking ke liye team se check karwa deti hoon. Aap apna order number share kar dijiye. - Mannat';
  }
  if (/refund|return|replacement|wrong|damaged|complaint/.test(reason)) {
    return 'Ji, mujhe afsos hai ki aapko ye issue face karna pada. Main aapki request team tak escalate kar rahi hoon. Aap apna order number share kar dijiye, please. - Mannat';
  }
  return 'Ji, main aapki request team ke saath check karwa deti hoon. Thoda sa time dijiye, hum aapki help karte hain. - Mannat';
}

function normalizeResult(result, liveProductData) {
  const leadStatus = ['HOT', 'WARM', 'COLD', 'NOT_A_LEAD'].includes(result?.leadStatus)
    ? result.leadStatus
    : 'WARM';
  const safeReply = enforcePriceSafety(result?.reply, liveProductData);
  return {
    reply: ensureEscalationAcknowledgement(safeReply, Boolean(result?.escalate), result?.escalateReason, result?.productInterest),
    leadStatus,
    productInterest: String(result?.productInterest || ''),
    escalate: Boolean(result?.escalate),
    escalateReason: String(result?.escalateReason || ''),
  };
}

async function generateReply({ platform, type, message, contextText, liveProductData = '' }) {
  const userParts = [];
  if (contextText) userParts.push({ text: `[Context: this is a ${type} on ${platform}. The post/thread context is: "${contextText}"]` });
  userParts.push({
    text: liveProductData
      ? `[CURRENT_LIVE_PRODUCT_DATA — may be used for current availability/price/product details: ${liveProductData}]`
      : '[CURRENT_LIVE_PRODUCT_DATA: none available. Do not quote any current product price.]',
  });
  userParts.push({ text: `Customer's ${type} message on ${platform}: "${message}"` });

  if (!process.env.GEMINI_API_KEY) {
    return { reply: 'Thanks for reaching out! Our team will get back to you shortly.', leadStatus: 'WARM', productInterest: '', escalate: true, escalateReason: 'GEMINI_API_KEY is not configured.' };
  }

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 500,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const error = new Error(`Gemini API error ${res.status}: ${text}`);
        error.status = res.status;
        if ([408, 429, 500, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
          await sleep(retryDelayMs(attempt, res.headers.get('retry-after')));
          lastError = error;
          continue;
        }
        throw error;
      }

      const data = await res.json();
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error('Gemini returned no response text.');
      const result = JSON.parse(raw);
      return normalizeResult(result, liveProductData);
    } catch (err) {
      lastError = err;
      if (attempt >= MAX_RETRIES) break;
      if (err?.name === 'TypeError' || /fetch failed/i.test(err?.message || '')) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      break;
    }
  }

  console.error('[replyEngine] generation failed:', lastError?.message || 'Unknown error');
  return {
    reply: 'Thanks for reaching out! Our team will get back to you shortly.',
    leadStatus: 'WARM',
    productInterest: '',
    escalate: true,
    escalateReason: `Model call failed after retries: ${lastError?.message || 'Unknown error'}`,
  };
}

module.exports = { generateReply };
