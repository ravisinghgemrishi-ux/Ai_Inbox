const crypto = require('crypto');
const {
  BRAND_VOICE,
  GEMSTONE_CATALOG_NOTES,
  CATALOG_NOTES,
  CONSULTATION_PLAN_NOTES,
  ESCALATION_RULES,
  LEAD_QUALIFICATION_RUBRIC,
  SHOWROOM_LOCATIONS,
  looksHinglishOrHindi,
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

--- SELF-IMPROVEMENT NOTE (internal only, never shown to the customer) ---
Added 2026-09-24 (Ravi): after you finish the reply above, briefly self-critique it in replyImprovement - one short sentence on how this exact reply could have been even better (a missing detail, a better follow-up question, closer language match, etc). This is logged to GemRishi's internal lead sheet for the team to review, never sent to the customer. If you genuinely can't think of anything worth improving, leave replyImprovement as an empty string - don't invent a nitpick just to fill it in.
`.trim();

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    leadStatus: { type: 'string', enum: ['HOT', 'WARM', 'COLD', 'NOT_A_LEAD'] },
    productInterest: { type: 'string' },
    escalate: { type: 'boolean' },
    escalateReason: { type: 'string' },
    replyImprovement: { type: 'string' },
  },
  required: ['reply', 'leadStatus', 'productInterest', 'escalate', 'escalateReason'],
};

// Added 2026-09-24 (Ravi): the block above (brand voice + both catalogs +
// consultation notes + escalation rules + lead rubric, ~34K characters) was
// being sent to Gemini as a fresh systemInstruction on EVERY single customer
// message, in every conversation - full price every time, even though it
// almost never changes between messages. Gemini's context-caching feature
// exists exactly for this shape of problem (a large, mostly-static prompt
// reused across many calls): cache it once, then reference the cache by name
// on every request instead of resending the whole thing. This cuts input
// tokens (and therefore cost) on nearly every reply, and shaves real
// processing time off each one too.
//
// This is a pure optimization layered on top of the existing behavior, never
// a requirement - every failure path below (no Redis configured, Gemini
// rejects the cache create call for any reason, the cache expires between
// requests) falls straight back to sending SYSTEM_INSTRUCTION inline exactly
// as before, so a caching problem can never break an actual customer reply.
const GEMINI_CACHE_TTL_SECONDS = 12 * 60 * 60; // 12h - comfortably covers a business day without re-sending mid-conversation
const GEMINI_CACHE_DISABLED_TTL_SECONDS = 60 * 60; // if caching fails, don't retry it on every single message - re-check hourly
const GEMINI_CACHE_REFRESH_BUFFER_MS = 10 * 60 * 1000; // don't use a cache that's about to expire mid-request
const GEMINI_CACHE_REDIS_KEY = 'gemrishi:gemini-cache:system-instruction';
// Fingerprints the current SYSTEM_INSTRUCTION text so that if Ravi edits the
// knowledge base and redeploys, the next request detects the mismatch and
// builds a fresh cache automatically - no manual cache-clearing step needed.
const SYSTEM_INSTRUCTION_HASH = crypto.createHash('sha256').update(SYSTEM_INSTRUCTION).digest('hex').slice(0, 16);

function geminiCacheRedisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function geminiCacheRedisCommand(path, method = 'GET') {
  const { url, token } = geminiCacheRedisConfig();
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return res.json().catch(() => ({}));
}

async function readStoredGeminiCache() {
  try {
    const data = await geminiCacheRedisCommand(`/get/${encodeURIComponent(GEMINI_CACHE_REDIS_KEY)}`);
    if (!data?.result) return null;
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function writeStoredGeminiCache(entry, ttlSeconds) {
  try {
    await geminiCacheRedisCommand(`/set/${encodeURIComponent(GEMINI_CACHE_REDIS_KEY)}/${encodeURIComponent(JSON.stringify(entry))}/EX/${ttlSeconds}`, 'POST');
  } catch (err) {
    console.error('[replyEngine] failed to persist Gemini cache reference:', err.message);
  }
}

async function invalidateStoredGeminiCache() {
  try {
    await geminiCacheRedisCommand(`/del/${encodeURIComponent(GEMINI_CACHE_REDIS_KEY)}`, 'POST');
  } catch (err) {
    console.error('[replyEngine] failed to clear Gemini cache reference:', err.message);
  }
}

async function createGeminiSystemCache() {
  const url = `${GEMINI_API_BASE}/cachedContents?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${GEMINI_MODEL}`,
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini cachedContents.create failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (!data?.name) throw new Error('Gemini cachedContents.create returned no cache name.');
  const expiresAt = data.expireTime || new Date(Date.now() + GEMINI_CACHE_TTL_SECONDS * 1000).toISOString();
  return { name: data.name, hash: SYSTEM_INSTRUCTION_HASH, expiresAt };
}

// Returns a usable { name, expiresAt } cache reference, or null if caching
// isn't available right now for any reason - callers must treat null as
// "send the system instruction inline", never as an error.
async function getGeminiSystemCache() {
  if (!process.env.GEMINI_API_KEY) return null;
  const { url, token } = geminiCacheRedisConfig();
  if (!url || !token) return null; // no persistent store to remember the cache reference in - skip rather than recreate it on every single request, which would add overhead instead of removing it.

  const stored = await readStoredGeminiCache();
  if (stored?.hash === SYSTEM_INSTRUCTION_HASH) {
    if (stored.disabled) return null; // recent failed attempt - don't hammer the API every message, this key self-expires hourly
    const expiresAtMs = Date.parse(stored.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > GEMINI_CACHE_REFRESH_BUFFER_MS) {
      return stored;
    }
  }

  try {
    const created = await createGeminiSystemCache();
    await writeStoredGeminiCache(created, GEMINI_CACHE_TTL_SECONDS);
    return created;
  } catch (err) {
    console.error('[replyEngine] Gemini context-cache create failed, using inline system instruction for now:', err.message);
    await writeStoredGeminiCache({ disabled: true, hash: SYSTEM_INSTRUCTION_HASH }, GEMINI_CACHE_DISABLED_TTL_SECONDS);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 8000);
  return Math.min(1000 * (2 ** attempt) + Math.floor(Math.random() * 300), 8000);
}

function enforcePriceSafety(reply, liveProductData, message) {
  if (liveProductData) return String(reply || '').trim();
  const text = String(reply || '').trim();
  const hasCurrency = /(?:₹|Rs\.?|INR)\s*[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s*(?:₹|Rs\.?|INR)/i.test(text);
  if (!hasCurrency) return text;
  // Generic fallback — must not name a specific product category, since this
  // path can fire for a gemstone reply just as easily as a Rudraksha reply.
  //
  // Fix (2026-09-24, Ravi): this used to be a single hardcoded Hindi/Hinglish
  // string, always, regardless of what language the customer was actually
  // writing in - so an English-only customer whose reply happened to trip
  // this safety net would suddenly get a Hindi reply out of nowhere. Now
  // picks based on the customer's own message, same detector used everywhere
  // else in this codebase for language matching.
  return looksHinglishOrHindi(message)
    ? 'Hari Om! Main aapko exact current price team se confirm karke batati hoon. Agar aap chahein, main aapke liye suitable option bhi check karwa sakti hoon. - Mannat'
    : "Thanks for asking! I'll confirm the exact current price with the team and get back to you. I'm happy to check a suitable option for you too, if you'd like. - Mannat";
}

// Added 2026-09-23 (Ravi): found real conversations where a customer asked
// "where are your stores" and got only city names back ("Ambala, Solan,
// aur Shimla mein hain") with no street/pincode/phone - even though the
// prompt already instructs giving the full address. Same lesson as
// enforcePriceSafety below - a prose instruction alone isn't reliable
// enough for something this important, so this is a deterministic backstop:
// if the customer's message reads like a store-location question and the
// reply doesn't already contain a recognisable piece of a full address
// (a pin code digit-string, or a distinctive street/mall name), append the
// full address block automatically rather than leaving it incomplete.
const LOCATION_QUESTION_PATTERN = /\b(store|showroom|shop)s?\b.*\b(where|location|address|kahan)|\bwhere\b.*\b(store|showroom|shop|located)|\bkahan\b.*\b(store|showroom|shop|hai|ho)|address\b|located\b|visit.*(store|showroom|shop)|(store|showroom|shop).*visit/i;

function replyHasFullAddress(text) {
  const t = String(text || '');
  // A pin code (6 digits) or a distinctive street/mall fragment already
  // present means the model did include real address detail, not just a
  // city name.
  if (/\b\d{6}\b/.test(t)) return true;
  return SHOWROOM_LOCATIONS.some((loc) => t.includes(loc.address.split(',')[0]));
}

function enforceAddressCompleteness(reply, message) {
  const text = String(reply || '').trim();
  if (!text) return text;
  if (!LOCATION_QUESTION_PATTERN.test(String(message || ''))) return text;
  if (replyHasFullAddress(text)) return text;

  // Only append the specific city's full address if the reply already named
  // one; otherwise append all three, so the customer always ends up with a
  // complete, usable answer rather than just city names.
  const mentioned = SHOWROOM_LOCATIONS.filter((loc) => text.includes(loc.city));
  const toAppend = mentioned.length > 0 ? mentioned : SHOWROOM_LOCATIONS;
  const addressLines = toAppend.map((loc) => `${loc.label}: ${loc.address}. Phone: ${loc.phone}.`).join('\n');
  return `${text}\n\n${addressLines}`;
}

// Fix (2026-09-24, Ravi): same language-mixing bug as enforcePriceSafety -
// these three fallback lines were always Hindi/Hinglish regardless of the
// customer's own language. Now picks the matching variant instead.
function ensureEscalationAcknowledgement(reply, escalate, escalateReason, productInterest, message) {
  if (!escalate) return String(reply || '').trim();
  const text = String(reply || '').trim();
  if (text && !/^\(held for human review\)$/i.test(text) && !/^held for human review$/i.test(text)) return text;

  const hindi = looksHinglishOrHindi(message);
  const reason = `${escalateReason || ''} ${productInterest || ''}`.toLowerCase();
  if (/order|track|tracking|status|delivery|shipment/.test(reason)) {
    return hindi
      ? 'Ji, main aapki help karti hoon. Order status/tracking ke liye team se check karwa deti hoon. Aap apna order number share kar dijiye. - Mannat'
      : "I'll help you with that. I'm getting the team to check your order status/tracking - could you share your order number? - Mannat";
  }
  if (/refund|return|replacement|wrong|damaged|complaint/.test(reason)) {
    return hindi
      ? 'Ji, mujhe afsos hai ki aapko ye issue face karna pada. Main aapki request team tak escalate kar rahi hoon. Aap apna order number share kar dijiye, please. - Mannat'
      : "I'm sorry you're dealing with this. I'm passing your request on to the team right away - could you please share your order number? - Mannat";
  }
  return hindi
    ? 'Ji, main aapki request team ke saath check karwa deti hoon. Thoda sa time dijiye, hum aapki help karte hain. - Mannat'
    : "I'm getting the team to look into this for you - please give us a little time, we'll help you out. - Mannat";
}

function normalizeResult(result, liveProductData, message) {
  const leadStatus = ['HOT', 'WARM', 'COLD', 'NOT_A_LEAD'].includes(result?.leadStatus)
    ? result.leadStatus
    : 'WARM';
  const safeReply = enforcePriceSafety(result?.reply, liveProductData, message);
  const ackReply = ensureEscalationAcknowledgement(safeReply, Boolean(result?.escalate), result?.escalateReason, result?.productInterest, message);
  return {
    reply: enforceAddressCompleteness(ackReply, message),
    leadStatus,
    productInterest: String(result?.productInterest || ''),
    escalate: Boolean(result?.escalate),
    escalateReason: String(result?.escalateReason || ''),
    replyImprovement: String(result?.replyImprovement || '').trim(),
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
    return { reply: 'Thanks for reaching out! Our team will get back to you shortly.', leadStatus: 'WARM', productInterest: '', escalate: true, escalateReason: 'GEMINI_API_KEY is not configured.', replyImprovement: '' };
  }

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const cache = await getGeminiSystemCache();
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 500,
    thinkingConfig: { thinkingBudget: 0 },
  };
  function buildBody(useCache) {
    return useCache && cache
      ? { cachedContent: cache.name, contents: [{ role: 'user', parts: userParts }], generationConfig }
      : { systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }, contents: [{ role: 'user', parts: userParts }], generationConfig };
  }

  let lastError;
  let useCache = Boolean(cache);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildBody(useCache)) });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // The cache itself may have gone stale between our check and this
        // call (expired, or deleted on Google's side) - drop it and retry
        // once with the system instruction sent inline, same as before this
        // feature existed, rather than failing the whole reply over it.
        if (useCache && [400, 404].includes(res.status) && attempt < MAX_RETRIES) {
          console.error('[replyEngine] cachedContent call failed, retrying without cache:', text);
          await invalidateStoredGeminiCache();
          useCache = false;
          continue;
        }
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
      return normalizeResult(result, liveProductData, message);
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
    replyImprovement: '',
  };
}

module.exports = { generateReply };
