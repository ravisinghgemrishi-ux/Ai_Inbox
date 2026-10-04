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

// Model tiering (2026-10-04, Ravi FIX 7): simple messages (greetings, plain
// price / yes-no / photo requests) go to the cheap Flash-Lite model with a
// trimmed prompt; anything needing judgement (Kundli, confused customers,
// recommendations, form leads, complaints) stays on Flash. Both are env-
// configurable; set GEMINI_TIERING=off to send everything to the smart model.
const GEMINI_MODEL = process.env.GEMINI_MODEL_SMART || process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_MODEL_LITE = process.env.GEMINI_MODEL_LITE || 'gemini-3.5-flash-lite';
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

--- CHAT STYLE (DMs and WhatsApp) ---
Added 2026-09-29 (Ravi): write like a real person chatting on WhatsApp/Instagram, not like an email. Short sentences. Put each separate thought on its own line with a blank line between them - each block is sent as its own message bubble with a natural typing pause. Use at most 3 blocks, usually 2. The last block is usually your one question. No long paragraphs, no bullet lists unless listing product options.
(Public comments and Google reviews are a single message - keep those to one short block.)

--- LESSONS FROM REAL GEMRISHI CHATS (updated 2026-09-29 from 468 logged conversations and 143 of your own self-critiques) ---
1. PRICES: customers ask about price more than anything. When CURRENT_LIVE_PRODUCT_DATA has matching stones, give 2-3 real in-stock options with their prices and product links instead of saying "I'll confirm with the team". Only fall back to "our team will confirm" when nothing matching is listed.
2. ASK THE ONE MISSING DETAIL: for a gemstone price question with no size given, ask the ratti (or budget) in the same reply - one question, not a list.
3. LOOSE STONE OR JEWELLERY: once a stone is chosen (your most common self-critique), ask whether they want it loose or set in a ring/pendant, and if set, which metal (silver, gold or panchdhatu). Remember rings/pendants are the setting only; the stone is priced separately.
4. NOT SURE WHICH STONE: if the customer doesn't know which gemstone suits them, or asks "which stone for me", offer a Kundli-based recommendation from their birth details (your second most common self-critique). Offer it once, not in every reply.
5. AUTHENTICITY: when asked if stones are real/original/certified: every GemRishi stone is natural and comes with a free lab certificate; an IIGJ certificate is available for ₹2,100 (adds 5 days) and an IGI certificate for ₹3,500 (adds 10 days). Delivery is usually 5 days.
6. USE THE NAME: once you know the customer's name, use it naturally (not in every line).
7. NAME AND NUMBER AT THE RIGHT MOMENT: ask for name and phone once, when the customer is clearly interested (HOT) - not in the first reply, and never again once given.
8. FIRST REPLY: avoid the generic "How can I help you today? Are you looking for gemstones, Rudraksha or a consultation?". If the post/message gives any clue, respond to that specifically.
9. STORE VISITS: store/location is the second most common question - always give the full address block, and if the customer mentions their city, mention the nearest showroom.
10. KEEP IT SHORT: 2-3 short blocks. Customers on Instagram and WhatsApp skim.
11. WHATSAPP: do not invite the customer to WhatsApp yourself and do not paste WhatsApp numbers unprompted - a separate step asks them once, politely, at the right moment. If the customer asks for WhatsApp themselves, just answer warmly.

--- CUSTOMER FACTS (internal only, never shown to the customer) ---
Added 2026-09-29 (Ravi): in every response, also fill customerName, customerPhone, customerCity, customerBudget and customerPurpose with what the customer has actually told us - in this message, in RECENT CONVERSATION, or in KNOWN CUSTOMER FACTS. Copy the customer's own words/numbers (e.g. customerBudget "50000", customerPurpose "career growth"). Never guess or invent; use an empty string for anything not stated. When KNOWN CUSTOMER FACTS are provided, treat them as true, use them naturally (e.g. greet the customer by name), and never ask again for a detail that is already known.

--- SELF-IMPROVEMENT NOTE (internal only, never shown to the customer) ---
Added 2026-09-24 (Ravi): after you finish the reply above, briefly self-critique it in replyImprovement - one short sentence on how this exact reply could have been even better (a missing detail, a better follow-up question, closer language match, etc). This is logged to GemRishi's internal lead sheet for the team to review, never sent to the customer. If you genuinely can't think of anything worth improving, leave replyImprovement as an empty string - don't invent a nitpick just to fill it in.
`.trim();

const COMMON_TAIL = SYSTEM_INSTRUCTION.slice(SYSTEM_INSTRUCTION.indexOf('--- PRICE SAFETY (NON-NEGOTIABLE) ---'));

// Added 2026-10-04 (Ravi, quality batch FIX 1-4). These come LAST so they
// override any older rule above that says otherwise.
const QUALITY_RULES = `
--- QUALITY RULES (2026-10-04, these override anything above) ---
1. ANSWER FIRST: always answer what the customer actually asked in this message before anything else. Never hold back an answer, a recommendation or a price because you do not have their phone number yet.
2. PHONE / NAME: ask for name and number at most ONCE in the whole conversation, only when they are clearly ready to buy. If they ignore it, never ask again. If KNOWN CUSTOMER FACTS or RECENT CONVERSATION already has it, never ask.
3. GEMSTONE OR RUDRAKSHA: ask this at most once per conversation. Our ads are gemstone ads, so lean to gemstones and do not bring up Rudraksha unless the customer does. If they say gemstone, talk only about gemstones from then on. If they say "both", explain the gemstone first, then the Rudraksha, then ask which one they want to go deeper on.
4. SHOW WHAT THEY ASK FOR: if the customer asks to see or know about a gemstone, tell them about that gemstone straight away (options, prices from CURRENT_LIVE_PRODUCT_DATA, product links). Do not deflect into another question.
5. PRICES ALREADY GIVEN: if you (Mannat) already quoted real prices earlier in RECENT CONVERSATION, you may repeat or compare them. Do not say "I'll confirm the price with the team" for something you already priced.
6. WHATSAPP: never invite the customer to WhatsApp yourself and never paste a WhatsApp number or link. Name, number, date of birth, Kundli and price questions are all handled right here.
7. SIGN-OFF: only sign "- Mannat" on your very first reply in a conversation, never mid-conversation.
8. NO HARD SELLING: for timing questions (e.g. wedding muhurat), answer helpfully first; mention a paid consultation only if they ask for more.
`.trim();

// Trimmed prompt for the Lite tier: everything except the two big catalog
// handbooks and the consultation-plan notes (prices come from
// CURRENT_LIVE_PRODUCT_DATA anyway). Saves most of the input tokens.
const SYSTEM_INSTRUCTION_LITE = `${BRAND_VOICE}

--- ESCALATION RULES ---
${ESCALATION_RULES}

--- LEAD SCORING ---
${LEAD_QUALIFICATION_RUBRIC}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    leadStatus: { type: 'string', enum: ['HOT', 'WARM', 'COLD', 'NOT_A_LEAD'] },
    productInterest: { type: 'string' },
    escalate: { type: 'boolean' },
    escalateReason: { type: 'string' },
    replyImprovement: { type: 'string' },
    customerName: { type: 'string' },
    customerPhone: { type: 'string' },
    customerCity: { type: 'string' },
    customerBudget: { type: 'string' },
    customerPurpose: { type: 'string' },
  },
  required: ['reply', 'leadStatus', 'productInterest', 'escalate', 'escalateReason'],
};

const SYSTEM_INSTRUCTION_FULL = `${SYSTEM_INSTRUCTION}\n\n${QUALITY_RULES}`;
const SYSTEM_INSTRUCTION_LITE_FULL = `${SYSTEM_INSTRUCTION_LITE}\n\n${COMMON_TAIL}\n\n${QUALITY_RULES}`;
const PROMPTS = {
  smart: { model: GEMINI_MODEL, text: SYSTEM_INSTRUCTION_FULL },
  lite: { model: GEMINI_MODEL_LITE, text: SYSTEM_INSTRUCTION_LITE_FULL },
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
// 2026-10-04: one cache per tier (a Gemini cache belongs to one model).
function cacheRedisKey(tier) {
  return tier === 'lite' ? 'gemrishi:gemini-cache:system-instruction:lite' : 'gemrishi:gemini-cache:system-instruction';
}
// Fingerprints the prompt text + model, so an edited knowledge base or a
// changed model automatically gets a fresh cache - no manual clearing.
function promptHash(tier) {
  const p = PROMPTS[tier] || PROMPTS.smart;
  return crypto.createHash('sha256').update(`${p.model}|${p.text}`).digest('hex').slice(0, 16);
}

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

async function readStoredGeminiCache(tier) {
  try {
    const data = await geminiCacheRedisCommand(`/get/${encodeURIComponent(cacheRedisKey(tier))}`);
    if (!data?.result) return null;
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function writeStoredGeminiCache(tier, entry, ttlSeconds) {
  try {
    await geminiCacheRedisCommand(`/set/${encodeURIComponent(cacheRedisKey(tier))}/${encodeURIComponent(JSON.stringify(entry))}/EX/${ttlSeconds}`, 'POST');
  } catch (err) {
    console.error('[replyEngine] failed to persist Gemini cache reference:', err.message);
  }
}

async function invalidateStoredGeminiCache(tier) {
  try {
    await geminiCacheRedisCommand(`/del/${encodeURIComponent(cacheRedisKey(tier))}`, 'POST');
  } catch (err) {
    console.error('[replyEngine] failed to clear Gemini cache reference:', err.message);
  }
}

async function createGeminiSystemCache(tier) {
  const p = PROMPTS[tier] || PROMPTS.smart;
  const url = `${GEMINI_API_BASE}/cachedContents?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${p.model}`,
      systemInstruction: { parts: [{ text: p.text }] },
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
  return { name: data.name, hash: promptHash(tier), expiresAt };
}

// Returns a usable { name, expiresAt } cache reference, or null if caching
// isn't available right now for any reason - callers must treat null as
// "send the system instruction inline", never as an error.
async function getGeminiSystemCache(tier = 'smart') {
  if (!process.env.GEMINI_API_KEY) return null;
  const { url, token } = geminiCacheRedisConfig();
  if (!url || !token) return null;

  const hash = promptHash(tier);
  const stored = await readStoredGeminiCache(tier);
  if (stored?.hash === hash) {
    if (stored.disabled) return null;
    const expiresAtMs = Date.parse(stored.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > GEMINI_CACHE_REFRESH_BUFFER_MS) {
      return stored;
    }
  }

  try {
    const created = await createGeminiSystemCache(tier);
    await writeStoredGeminiCache(tier, created, GEMINI_CACHE_TTL_SECONDS);
    return created;
  } catch (err) {
    console.error(`[replyEngine] Gemini context-cache create failed (${tier}), using inline system instruction for now:`, err.message);
    await writeStoredGeminiCache(tier, { disabled: true, hash }, GEMINI_CACHE_DISABLED_TTL_SECONDS);
    return null;
  }
}

// Which tier for this message? (FIX 7) Cheap Lite only for simple turns.
const LITE_INTENTS = new Set(['general_engagement', 'price', 'purchase', 'product_info', 'order_status', 'general_question']);
function pickTier({ intent = '', message = '', contextText = '', forceSmart = false } = {}) {
  if (forceSmart || String(process.env.GEMINI_TIERING || 'on').toLowerCase() === 'off') return 'smart';
  const text = String(message || '');
  if (text.length > 220) return 'smart';
  if (!LITE_INTENTS.has(intent)) return 'smart';
  if (/META AD FORM LEAD|CATEGORY: the customer said BOTH|CUSTOMER CONTINUITY/.test(contextText)) return 'smart';
  // confused / frustrated customers get the better model
  if (/(\?\s*){2,}|not clear|samajh nahi|confus|again|phir se|already told|bata diya|first tell|pehle batao/i.test(text)) return 'smart';
  return 'lite';
}

// FIX 7: keep only the most recent part of the conversation in the prompt.
function trimContext(contextText, tier) {
  const maxTurns = tier === 'lite' ? 6 : 10;
  return String(contextText || '').replace(/RECENT CONVERSATION:\n([\s\S]*?)(\n\n[A-Z][A-Z _]+:|$)/, (all, conv, tail) => {
    const lines = conv.split('\n');
    const turnStarts = lines.map((l, i) => (/^(Customer|Mannat):/.test(l) ? i : -1)).filter((i) => i >= 0);
    if (turnStarts.length <= maxTurns) return all;
    return `RECENT CONVERSATION (latest ${maxTurns} messages):\n${lines.slice(turnStarts[turnStarts.length - maxTurns]).join('\n')}${tail}`;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 8000);
  return Math.min(1000 * (2 ** attempt) + Math.floor(Math.random() * 300), 8000);
}

// Added 2026-09-29 (Ravi): the check below used to throw away ANY reply
// containing a rupee amount whenever there was no live product data. In the
// live memory test the customer said "my budget is 50000"; from then on every
// reply that repeated the customer's OWN budget back ("within your 50,000
// budget...") was wiped and replaced by the stock "I'll confirm the price"
// line - even "what's my name". Amounts the customer themselves wrote (in this
// message or earlier in the conversation) are not invented prices, so they
// are now allowed. Any other amount is still blocked, exactly as before.
function toRupees(numText, unitText = '') {
  const n = Number(String(numText).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = String(unitText).toLowerCase();
  if (/^(k|thousand|hazar|hajar|hazaar)/.test(u)) return Math.round(n * 1000);
  if (/^(l|lac|lakh|lakhs)/.test(u)) return Math.round(n * 100000);
  return Math.round(n);
}

// 2026-10-04 (Ravi, audit): also allow amounts Mannat HERSELF already quoted
// earlier in this chat (those came from live product data at the time) -
// this was firing "I'll confirm the price with the team" right after real
// prices had been given (amitsoni1__ / GR-10053), which read as evasive.
function customerStatedAmounts(message, contextText) {
  const customerText = [
    String(message || ''),
    ...String(contextText || '').split('\n').filter((line) => /^\s*(Customer|Mannat)\b/i.test(line) || /^\s*-\s*Budget:/i.test(line)),
  ].join('\n');
  const amounts = new Set();
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k\b|thousand|hazar|hajar|hazaar|lakhs?\b|lacs?\b|l\b)?/gi;
  let m;
  while ((m = re.exec(customerText))) {
    const v = toRupees(m[1], m[2] || '');
    if (v !== null && v >= 100) amounts.add(v);
  }
  return amounts;
}

function replyCurrencyAmounts(text) {
  const out = [];
  const re = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)\s*(k\b|lakhs?\b|lacs?\b)?|([\d,]+(?:\.\d+)?)\s*(k\b|lakhs?\b|lacs?\b)?\s*(?:₹|Rs\.?|INR)/gi;
  let m;
  while ((m = re.exec(text))) out.push(toRupees(m[1] || m[3], m[2] || m[4] || ''));
  return out;
}

const FIXED_PUBLISHED_FEES = [2100, 3500];

function enforcePriceSafety(reply, liveProductData, message, contextText = '') {
  if (liveProductData) return String(reply || '').trim();
  const text = String(reply || '').trim();
  const amounts = replyCurrencyAmounts(text);
  if (!amounts.length) return text;
  const stated = customerStatedAmounts(message, contextText);
  // Fixed, published service fees (certificate upgrades) are not product
  // prices and may always be mentioned: IIGJ ₹2,100, IGI ₹3,500.
  for (const fee of FIXED_PUBLISHED_FEES) stated.add(fee);
  if (amounts.every((a) => a !== null && stated.has(a))) return text; // only the customer's own figures / fixed fees
  // 2026-10-04: remove only the sentences carrying an unverified amount and
  // keep the rest of a good reply, instead of replacing the whole thing.
  const hindiCustomer = looksHinglishOrHindi(message);
  const unsafe = (sentence) => replyCurrencyAmounts(sentence).some((a) => a === null || !stated.has(a));
  const kept = text.split(/\n\s*\n/).map((block) => (block.match(/[^.?!\n]+[.?!]*\s*/g) || [block]).filter((x) => !unsafe(x)).join('').trim()).filter(Boolean).join('\n\n');
  if (kept.length >= 40) {
    return `${kept}\n\n${hindiCustomer ? 'Exact current price main abhi confirm karke batati hoon.' : "I'll confirm the exact current price for you."}`;
  }
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

function normalizeResult(result, liveProductData, message, contextText = '') {
  const leadStatus = ['HOT', 'WARM', 'COLD', 'NOT_A_LEAD'].includes(result?.leadStatus)
    ? result.leadStatus
    : 'WARM';
  const safeReply = enforcePriceSafety(result?.reply, liveProductData, message, contextText);
  const ackReply = ensureEscalationAcknowledgement(safeReply, Boolean(result?.escalate), result?.escalateReason, result?.productInterest, message);
  return {
    reply: enforceAddressCompleteness(ackReply, message),
    leadStatus,
    productInterest: String(result?.productInterest || ''),
    escalate: Boolean(result?.escalate),
    escalateReason: String(result?.escalateReason || ''),
    replyImprovement: String(result?.replyImprovement || '').trim(),
    customerName: String(result?.customerName || '').trim(),
    customerPhone: String(result?.customerPhone || '').trim(),
    customerCity: String(result?.customerCity || '').trim(),
    customerBudget: String(result?.customerBudget || '').trim(),
    customerPurpose: String(result?.customerPurpose || '').trim(),
  };
}

async function generateReply({ platform, type, message, contextText, liveProductData = '', intent = '', forceSmart = false }) {
  let tier = pickTier({ intent, message, contextText, forceSmart });
  const first = await generateWithTier({ platform, type, message, contextText: trimContext(contextText, tier), liveProductData, tier });
  if (first.ok) return first.result;
  // Lite model refused / failed -> one more try on the smart model.
  if (tier === 'lite') {
    console.error('[replyEngine] lite tier failed, retrying on smart model:', first.error?.message);
    tier = 'smart';
    const second = await generateWithTier({ platform, type, message, contextText: trimContext(contextText, tier), liveProductData, tier });
    if (second.ok) return second.result;
    return fallbackResult(second.error);
  }
  return fallbackResult(first.error);
}

function fallbackResult(lastError) {
  console.error('[replyEngine] generation failed:', lastError?.message || 'Unknown error');
  return {
    reply: 'Thanks for reaching out! Our team will get back to you shortly.',
    leadStatus: 'WARM',
    productInterest: '',
    escalate: true,
    escalateReason: `Model call failed after retries: ${lastError?.message || 'Unknown error'}`,
    replyImprovement: '',
    generationFailed: true,
  };
}

async function generateWithTier({ platform, type, message, contextText, liveProductData = '', tier = 'smart' }) {
  const prompt = PROMPTS[tier] || PROMPTS.smart;
  const userParts = [];
  if (contextText) userParts.push({ text: `[Context: this is a ${type} on ${platform}. The post/thread context is: "${contextText}"]` });
  userParts.push({
    text: liveProductData
      ? `[CURRENT_LIVE_PRODUCT_DATA — may be used for current availability/price/product details: ${liveProductData}]`
      : '[CURRENT_LIVE_PRODUCT_DATA: none available. Do not quote any current product price.]',
  });
  userParts.push({ text: `Customer's ${type} message on ${platform}: "${message}"` });

  if (!process.env.GEMINI_API_KEY) {
    return { ok: true, result: { reply: 'Thanks for reaching out! Our team will get back to you shortly.', leadStatus: 'WARM', productInterest: '', escalate: true, escalateReason: 'GEMINI_API_KEY is not configured.', replyImprovement: '', generationFailed: true } };
  }

  const url = `${GEMINI_API_BASE}/models/${prompt.model}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const cache = await getGeminiSystemCache(tier);
  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 500,
    thinkingConfig: { thinkingBudget: 0 },
  };
  function buildBody(useCache) {
    return useCache && cache
      ? { cachedContent: cache.name, contents: [{ role: 'user', parts: userParts }], generationConfig }
      : { systemInstruction: { parts: [{ text: prompt.text }] }, contents: [{ role: 'user', parts: userParts }], generationConfig };
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
          await invalidateStoredGeminiCache(tier);
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
      const normalized = normalizeResult(result, liveProductData, message, contextText);
      return { ok: true, result: { ...normalized, modelTier: tier } };
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

  return { ok: false, error: lastError };
}

module.exports = {
  _enforcePriceSafety: enforcePriceSafety, generateReply, _pickTier: pickTier, _trimContext: trimContext,
  GEMINI_MODEL, GEMINI_MODEL_LITE,
  // Read-only: lets the team monitor judge staff against the same knowledge.
  KNOWLEDGE_BASE: SYSTEM_INSTRUCTION };
