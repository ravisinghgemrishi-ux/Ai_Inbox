const {
  BRAND_VOICE,
  CATALOG_NOTES,
  ESCALATION_RULES,
  LEAD_QUALIFICATION_RUBRIC,
} = require('./knowledgeBase');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_RETRIES = 2;

const SYSTEM_INSTRUCTION = `${BRAND_VOICE}

--- CATALOG NOTES ---
${CATALOG_NOTES}

--- ESCALATION RULES ---
${ESCALATION_RULES}

--- LEAD SCORING ---
${LEAD_QUALIFICATION_RUBRIC}

--- PRICE SAFETY (NON-NEGOTIABLE) ---
Never quote, repeat, infer, calculate, or describe an indicative/handbook price as the current GemRishi selling price.
The only price that may be presented as a current price is a price explicitly supplied to you in CURRENT_LIVE_PRODUCT_DATA.
If CURRENT_LIVE_PRODUCT_DATA is absent, empty, or does not contain the requested product, say that you will confirm the exact current price with the team. You may still identify the product and mark the lead HOT when appropriate.
The handbook is knowledge/reference material, not a live pricing source.
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
      return {
        reply: String(result.reply || '').trim(),
        leadStatus: result.leadStatus,
        productInterest: String(result.productInterest || ''),
        escalate: Boolean(result.escalate),
        escalateReason: String(result.escalateReason || ''),
      };
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
