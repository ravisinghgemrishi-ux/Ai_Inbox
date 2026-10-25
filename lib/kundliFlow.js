/**
 * Mannat AI 2.0 - the Kundli-guided sales flow.
 *
 * See the "Kundli Flow Feasibility Checklist" / "Mannat AI 2.0 - Upgrade
 * Proposal" docs for the full design and the diagram this implements.
 *
 * SAFETY / ISOLATION (read this before changing the gate below):
 *   - This entire module is inert unless ENABLE_KUNDLI_FLOW=true is set in
 *     Vercel. maybeHandleKundliTurn() returns null immediately otherwise,
 *     and webhook.js falls through to the existing, unchanged replyEngine
 *     flow. Nothing here runs against live traffic until that flag is on.
 *   - Only DMs/WhatsApp messages can enter this flow (never public
 *     comments) - collecting birth details in a public comment thread
 *     would be both a bad experience and a privacy problem.
 *   - This flow produces the exact same {reply, leadStatus, productInterest,
 *     escalate, escalateReason} shape replyEngine.generateReply() produces,
 *     so webhook.js's existing logLead()/notifyEscalation() calls need no
 *     changes at all - the new flow is a drop-in alternative reply source,
 *     not a parallel pipeline.
 *   - PAYMENT HANDOFF POLICY (confirmed by Ravi, updated 2026-09-23): for a
 *     Rudraksha with a known Shopify product page, the AI shares that plain
 *     product page link (never a pre-loaded cart/checkout link) so the
 *     customer can review and buy it themselves - no escalation needed for
 *     that case. For a gemstone (no product-page mapping yet) or anything
 *     without a link, it never fabricates one - it hands off to the team.
 *
 * STATE: kept in Redis (not the existing 12-turn memoryStore, which is for
 * chat context, not structured slots), one JSON blob per conversation,
 * short TTL so an abandoned flow doesn't linger forever.
 */

const { BRAND_VOICE, GEMSTONE_CATALOG_NOTES, CATALOG_NOTES, CONSULTATION_PLAN_NOTES, detectReplyLanguageNote, detectPlanQuestionNote, looksHinglishOrHindi } = require('./knowledgeBase');
const { getKundliReading, currentMahadasha } = require('./astrologyEngineClient');
const { recommendGemstone } = require('./gemstoneRecommender');
const { buildProductPageLink, getConsultationPaymentLink } = require('./paymentLinks');
const { looksLikePaidPlanSwitch } = require('./consultationFlow');
const { detectCategoryChoice } = require('./conversationGuards');
const { lookupLiveProduct, formatLiveProductData } = require('./productResolver');

// 2026-10-17 audit: real in-stock options for the recommended stone (the old
// path quoted handbook ranges like "Pearl Rs 15,000-50,000/carat" while real
// pearls sell for ~Rs 2,400-2,900). Never throws - '' when nothing is found.
async function liveOptionsFor(gem) {
  if (!gem) return '';
  try { return formatLiveProductData(await lookupLiveProduct(gem)) || ''; }
  catch (err) { console.error('[kundliFlow] live product lookup failed:', err.message); return ''; }
}

// 2026-10-17 audit (bhanusharma_08): after a recommendation, "Written kundli",
// "How much", "Han batao" were all answered with "do you want to buy it?".
// Anything that is a question / request for info is now answered first.
const BUY_STAGE_QUESTION = /\?|how much|price|cost|rate|kitn[aei]|kitne|kya (price|rate|daam|milega|milta)|daam|written|likh|kundli|kundali|plan|consult|astrolog|call|details?|batao|bataiye|batayein|bata do|explain|samjha|what|which|kaun|kaise|kyun|why|how|other|aur koi|dusra|alternative/i;

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days - abandoned flows expire, don't linger

const CANCEL_WORDS = /\b(cancel|never ?mind|not now|skip this|chodo|rehne do|baad mein|stop)\b/i;

// ---------------------------------------------------------------------------
// QUALIFICATION LADDER (2026-10-24, Ravi). The free reading keeps people who
// only want free predictions busy so the sales team only spends time on real
// buyers:
//   Step 1 - free, general reading from the real astrology engine (WARM).
//   Step 2 - filter: "planning to get it? what budget/size?" A budget or size
//            -> HOT + handed to sales with the full case file.
//   Step 3 - anyone who keeps asking for predictions (marriage kab, job kab,
//            more about my chart...) is offered the paid detailed reading
//            (Rs 499 plan: written Kundli + astrologer call, adjusted against
//            a stone purchase). Only a PAID customer is escalated to the team.
// Lead status stays WARM through the free reading, so "HOT lead, number
// given" no longer forwards free-reading chats to sales.
// ---------------------------------------------------------------------------
const PAID_READING_PLAN = process.env.KUNDLI_PAID_PLAN || 'consultation_499';
const PAID_READING_PRICE = process.env.KUNDLI_PAID_PRICE || '499';
const PAID_ADJUSTABLE = process.env.KUNDLI_PAID_ADJUSTABLE !== 'false';
const MANNAT_WHATSAPP = process.env.MANNAT_WHATSAPP_DISPLAY || '+91 74969 97220';
const PAID_STATE_TTL_SECONDS = 30 * 86400;

// Asking the chart for predictions / more free reading.
const PREDICTION_ASK = /\b(kab (tak|hogi|hoga|hogi|milegi|milega|aayega|aayegi|lagegi|lagega)|when will|when (is|am) i|kya hoga|kaisa (rahega|hoga|jayega|rahegi)|hoga ya nahi|future|bhavishya|predict\w*|shaadi kab|shadi kab|marriage kab|marriage (when|date)|job kab|naukri kab|santan|baby kab|bachcha kab|child kab|videsh|abroad kab|lucky (number|colou?r|day)|rashifal|horoscope|aur (batao|bataiye|bataye) (meri|mere|kundli)|meri kundli (me|mein|main)|mere chart|my chart|more about my (kundli|chart|future)|kundli (dekh|check) (ke|kar)|dosh|manglik|sade ?sati|kaal ?sarp)\b/i;
// Clear buying signals - never treat these as "free reading" asks.
const BUYING_SIGNAL = /\b(price|rate|kitn[aei] ka|kitne ka|daam|budget|order|buy|khareed|lena hai|le lunga|le lungi|ring|pendant|ratti|carat|certificate|delivery|cod|payment)\b/i;
// A budget amount or a stone size - the step-2 filter answer.
const BUDGET_OR_SIZE = /(₹|\brs\.?|\binr\b|rupe|budget|hazar|hajar|thousand|\d+\s*k\b|lakh|lac|\d{4,}|\d+(\.\d+)?\s*(ratti|rati|carat|ct)\b)/i;
const UNKNOWN_TIME = /(pata nahi|nahi pata|nhi pata|pta nahi|nahi pta|nahi janta|nahi jaanta|nhi janta|malum nahi|maloom nahi|yaad nahi|don'?t know|not sure|no idea|unknown|not known|exact (time )?(nahi|not))/i;
const PAID_YES = /^\s*\W*(yes|yeah|ya|haan|han|ha|haa|hanji|ji|ok|okay|okk+|theek|thik|chalo|bilkul|zaroor|jarur|sure|send|bhejo|bhej do|link|chahiye|kar do|karna hai)\b/i;
const PAID_NO = /^\s*\W*(no|nahi|nhi|nahin|na|not now|later|baad mein|abhi nahi|rehne do)\b/i;
const PAID_DONE = /(paid|payment (done|complete|successful|ho gaya|kar di|kar diya)|kar diya|kar di hai|bhej diya|screenshot|receipt|transaction|utr|^\s*\[(image|photo|document)\])/i;

function approxBirthTime(text) {
  const t = String(text || '');
  if (/(subah|savere|morning|sunrise|bhor)/i.test(t)) return '07:00';
  if (/(dopahar|dopehar|dophar|afternoon|noon)/i.test(t)) return '13:00';
  if (/(shaam|sham|evening)/i.test(t)) return '18:00';
  if (/(raat|night)/i.test(t)) return '21:00';
  return '12:00';
}

function paidKey(memoryId) { return `gemrishi:kundli-paid:${memoryId}`; }
async function getPaidState(memoryId) {
  try {
    const data = await redisCommand(`/get/${encodeURIComponent(paidKey(memoryId))}`);
    return data?.result ? JSON.parse(data.result) : null;
  } catch (err) { console.error('[kundliFlow] paid state read failed:', err.message); return null; }
}
async function setPaidState(memoryId, value) {
  try {
    await redisCommand(`/set/${encodeURIComponent(paidKey(memoryId))}/${encodeURIComponent(JSON.stringify(value))}/EX/${PAID_STATE_TTL_SECONDS}`);
  } catch (err) { console.error('[kundliFlow] paid state write failed:', err.message); }
}

let currentPlatform = '';
let currentPhone = '';
function whatsappNudge(hindi) {
  if (!currentPlatform || currentPlatform === 'whatsapp') return '';
  return hindi
    ? `\n\nPhotos, certificate aur exact options ke liye ${MANNAT_WHATSAPP} par WhatsApp karein aur "INSTA" likh kar bhejein 😊`
    : `\n\nFor photos, certificates and exact options, WhatsApp "INSTA" to ${MANNAT_WHATSAPP} 😊`;
}

// Added 2026-09-24 (Ravi): a customer directly naming a specific GEMSTONE
// while asking to buy it (intentRouter.js's 'purchase' intent, e.g. "mujhe
// emrald chahiye") should also open this flow - kept in sync with
// gemstoneRecommender.js's GEMSTONE_RULES list. Unlike Rudraksha, gemstones
// have no Shopify product-page mapping yet (see the payment handoff policy
// note below), so today EVERY gemstone purchase ask ends in a blind human
// handoff regardless - routing it through this flow instead means the
// customer gets a real astrology-engine check and a validated recommendation
// (confirming or correcting the gem they asked for) before that handoff,
// instead of a generic "I'll check and get back to you" that never actually
// checks anything. Deliberately scoped to gemstone names only - a Rudraksha
// purchase ask already has a fast, frictionless direct-link path (see
// handleBuyDecision() below) and must not be slowed down by birth-detail
// collection it doesn't need. In practice a Rudraksha-naming message is
// almost always classified 'product_info' before it ever reaches 'purchase'
// (see intentRouter.js's ordering), so this rarely even needs to check, but
// the gemstone-name requirement keeps it safe either way.
// Canonical names for spotting which gemstone a message names (2026-10-07).
const GEM_CANON = [
  ['Ruby (Manik)', /\b(ruby|manik|manikya)\b/i],
  ['Pearl (Moti)', /\b(pearl|moti)\b/i],
  ['Red Coral (Moonga)', /\b(red\s*coral|coral|moonga|munga)\b/i],
  ['Emerald (Panna)', /\b(emerald|emarald|emrald|panna)\b/i],
  ['Yellow Sapphire (Pukhraj)', /\b(yellow\s*sapphire|pukhraj|pukhraaj)\b/i],
  ['Diamond (Heera)', /\b(diamond|heera|hira)\b/i],
  ['Blue Sapphire (Neelam)', /\b(blue\s*sapphire|neelam|nilam)\b/i],
  ['Hessonite (Gomed)', /\b(gomed|gomedh|hessonite)\b/i],
  ["Cat's Eye (Lehsunia)", /\b(cat'?s?\s*eye|lehsunia|lahsuniya)\b/i],
  ['Opal', /\bopal\b/i],
];
function gemNamedIn(text) {
  const t = String(text || '');
  for (const [name, re] of GEM_CANON) if (re.test(t)) return name;
  return '';
}
function sameGem(a, b) {
  if (!a || !b) return false;
  return gemNamedIn(a) === gemNamedIn(b) && gemNamedIn(a) !== '';
}

// 2026-10-26 (Ravi): the free-reading flow was taking over real buyers.
// Jagannath (25 Oct) was choosing a Ceylon Pukhraj for a 22k gold ring; his
// "Ye design m chahiye 22 carat gold m pukhraj" restarted the flow (name?
// DOB?) twice, and "Isme price bta do" got back only "Namaste! Main Mannat".
// A message that asks for a concrete product (price, ring, design, metal,
// size, photos) is a sales question - the normal reply engine answers it.
const PRODUCT_REQUEST = /\b(price|rate|cost|kitn[aei]|kitne|daam|kimat|keemat|ring|anguthi|anguthe|pendant|pendent|locket|bracelet|design|gold|sona|silver|chandi|panch ?dhatu|ashta ?dhatu|ratti|rati|carat|certif\w*|show|dikha\w*|photo|pic|pics|image|video|options?|order|buy|available|stock|making)\b/i;
// Product links in the chat = Mannat is already selling to this customer.
const SALES_CHAT = /gemrishi\.com\/product/i;
// "Call me" / "your name?" are not answers to the buy question - the
// normal reply engine handles call requests (office hours, team handoff).
const CALL_REQUEST = /\b(call (me|kar\w*|kr\w*|kijiye|karein|karo)|mujhe call|phone kar\w*|ring me|baat kar(ni|na|wa\w*|ao|o))\b|^\W*(pls|please|ap|aap)?\s*call\b/i;
const ASKS_NAME = /\b(your name|ur name|apka na+m|aapka na+m|tumhara na+m|who are you|kaun ho)\b/i;
// "ok" right after "shall we go ahead?" is a yes.
const SHORT_YES = /^\W*(ok+|okay|okk+|ok ji|sure|theek hai|thik hai|thik|chalo|done|haan ji|ji haan|ji)\W*$/i;
// A birth "place" that is only a country/state gives the engine the wrong
// coordinates (Avneet, 25 Oct: "Muktar punjab" failed, then "India" was
// accepted and read as the centre of India).
const REGION_ONLY = /^\s*(india|bharat|hindustan|pakistan|nepal|usa|uk|canada|australia|uae|dubai|punjab|haryana|himachal( pradesh)?|uttar pradesh|up|madhya pradesh|mp|rajasthan|gujarat|maharashtra|bihar|jharkhand|west bengal|bengal|delhi ncr|ncr|uttarakhand|j&k|jammu( and| &)? kashmir|kerala|tamil nadu|karnataka|telangana|andhra pradesh|odisha|orissa|assam|chhattisgarh|goa)\s*\.?\s*$/i;

const GEMSTONE_NAME_PATTERN = /\b(ruby|manikya|pearl|moti|red\s*coral|moonga|emerald|panna|yellow\s*sapphire|pukhraj|diamond|heera|blue\s*sapphire|neelam|gomed|hessonite|cat'?s?\s*eye|lehsunia)\b/i;

// ---------------------------------------------------------------- Redis ---

function redisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function redisCommand(path) {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error('Redis credentials are not configured');
  const res = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return res.json().catch(() => ({}));
}

function sessionKey(memoryId) {
  return `gemrishi:kundli-session:${memoryId}`;
}

async function getSession(memoryId) {
  try {
    const data = await redisCommand(`/get/${encodeURIComponent(sessionKey(memoryId))}`);
    return data?.result ? JSON.parse(data.result) : null;
  } catch (err) {
    console.error('[kundliFlow] session read failed:', err.message);
    return null;
  }
}

async function setSession(memoryId, state) {
  try {
    const payload = encodeURIComponent(JSON.stringify(state));
    await redisCommand(`/set/${encodeURIComponent(sessionKey(memoryId))}/${payload}/EX/${SESSION_TTL_SECONDS}`);
  } catch (err) {
    console.error('[kundliFlow] session write failed:', err.message);
  }
}

async function clearSession(memoryId) {
  try { await redisCommand(`/del/${encodeURIComponent(sessionKey(memoryId))}`); }
  catch (err) { console.error('[kundliFlow] session clear failed:', err.message); }
}

// FIX (2026-10-05, Ravi): keep a finished reading (birth details + chart)
// for 60 days, separate from the short-lived session. Before this, saying
// "no" to the first recommendation threw the chart away, and a later
// "recommend me / as per my chart / Rudraksha?" restarted the whole flow and
// asked the customer's name again (real case: saurabh.raj.51, 4 Oct).
const READING_TTL_SECONDS = 60 * 86400;
function readingKey(memoryId) { return `gemrishi:kundli-reading:${memoryId}`; }

async function saveReading(memoryId, state) {
  if (!state?.chart) return;
  try {
    const payload = encodeURIComponent(JSON.stringify({ slots: state.slots, chart: state.chart, savedAt: new Date().toISOString() }));
    await redisCommand(`/set/${encodeURIComponent(readingKey(memoryId))}/${payload}/EX/${READING_TTL_SECONDS}`);
  } catch (err) { console.error('[kundliFlow] reading save failed:', err.message); }
}

async function getReading(memoryId) {
  try {
    const data = await redisCommand(`/get/${encodeURIComponent(readingKey(memoryId))}`);
    return data?.result ? JSON.parse(data.result) : null;
  } catch (err) { console.error('[kundliFlow] reading read failed:', err.message); return null; }
}

// A short message that just names a category ("Rudraksh", "gems", "mukhi
// batao") - used to reopen a saved reading. Named stones ("emerald price?")
// are deliberately NOT included: those are product questions.
const CATEGORY_ONLY = /^\s*\W*(rudraksh\w*|mukhi|mala|gems?|gemstones?|ratna)\b[\w\s?.!]{0,25}$/i;
function namedCategory(message) {
  if (/rudraksh|mukhi|\bmala\b/i.test(message)) return 'rudraksha';
  if (/\b(gems?|gemstones?|ratna|stones?)\b/i.test(message)) return 'gemstone';
  return null;
}

// ---------------------------------------------------------------- Gemini --

async function callGemini({ systemInstruction, userText, schema, maxOutputTokens = 400 }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  // 2026-10-17 audit: one retry on a busy/temporary Gemini error (a 503 on
  // 14 Oct sent a canned reply mid-Kundli), with a 25s cap per attempt.
  let res;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    } catch (err) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw err;
    } finally { clearTimeout(timer); }
    if (res.ok || ![429, 500, 502, 503, 504].includes(res.status) || attempt === 1) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned no response text');
  return JSON.parse(raw);
}

const SLOT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    date: { type: 'string', description: 'ISO YYYY-MM-DD, only if confidently parsed from this message' },
    time: { type: 'string', description: 'HH:MM 24-hour, only if confidently parsed from this message' },
    place: { type: 'string' },
    purpose: { type: 'string', description: 'one or two words for what they want guidance on, e.g. wealth, career, marriage, health, protection' },
    phone: { type: 'string', description: 'a phone number, digits only (keep a leading country code if given), only if confidently parsed from this message' },
  },
  required: ['name', 'date', 'time', 'place', 'purpose', 'phone'],
};

// Extracts ONLY what the customer explicitly stated in this message -
// never invents or carries forward a value; merging with prior slots is
// the caller's job, so a mis-extraction never silently overwrites a
// previously-confirmed value with an empty guess.
async function extractSlots(message, alreadyHave) {
  const systemInstruction = `You extract birth-chart intake details from a single WhatsApp/Instagram DM. The customer is ${alreadyHave} so far. Only fill a field if THIS message clearly states it - leave a field as an empty string if it isn't in this message. Never guess or carry forward information from earlier turns; that's handled separately. Dates may be written DD-MM-YYYY, DD/MM/YYYY, in words, or in Hindi - always normalize to YYYY-MM-DD. Times may be 12h or 24h, with or without AM/PM - normalize to 24h HH:MM; if AM/PM is genuinely ambiguous, leave time empty rather than guessing. A phone number should be digits only (spaces/dashes stripped), keeping a leading country code if the customer gave one.`;
  try {
    const result = await callGemini({ systemInstruction, userText: message, schema: SLOT_SCHEMA, maxOutputTokens: 200 });
    return {
      name: String(result?.name || '').trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(result?.date) ? result.date : '',
      time: /^\d{2}:\d{2}$/.test(result?.time) ? result.time : '',
      place: String(result?.place || '').trim(),
      purpose: String(result?.purpose || '').trim(),
      phone: /^\+?\d{7,15}$/.test(String(result?.phone || '').replace(/[\s-]/g, '')) ? String(result.phone).replace(/[\s-]/g, '') : '',
    };
  } catch (err) {
    console.error('[kundliFlow] slot extraction failed:', err.message);
    return { name: '', date: '', time: '', place: '', purpose: '', phone: '' };
  }
}

const READING_RULES = `RULES FOR EVERY REPLY IN THIS CHAT:
- Use ONLY the chart facts given above (e.g. the Mahadasha lord). Never invent other planets, houses, yogas, doshas, dates or periods.
- Never predict specific life events or their timing (when they will marry, have a child, get a job, go abroad, win a case, recover from an illness) and never promise an outcome. If they ask, say a detailed personal analysis is done by our astrologer.
- Never say you are checking with a senior/team head or that someone will reply by a certain time.
- WhatsApp style: short (about 60 words max), end with at most ONE question.`;

const REPLY_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
};

async function generateStageReply({ instruction, contextSummary, languageNote = '', planQuestionNote = '' }) {
  const systemInstruction = `${BRAND_VOICE}\n\n--- CONSULTATION PLAN NOTES (for context if the customer asks about paid plans) ---\n${CONSULTATION_PLAN_NOTES}\n\n--- KUNDLI FLOW CONTEXT ---\n${contextSummary}\n\n--- WHAT TO DO THIS TURN ---${planQuestionNote ? `\n${planQuestionNote}\n` : ''}\n${instruction}\n\nIf the customer's message also asked something else this turn (pricing, what's included in a paid plan, the difference between free and paid, authenticity, timelines, etc.), answer that briefly first using the notes above, then continue with what this turn needs. Never silently ignore a direct question just to keep collecting details.${languageNote ? `\n\n${languageNote}` : ''}\n\nStay in character as Mannat. Match the customer's language (English/Hindi/Hinglish) based on how they've been writing. Keep it warm and conversational, not like a form.\n\n${READING_RULES}`;
  try {
    const result = await callGemini({ systemInstruction, userText: '(generate the next message now)', schema: REPLY_SCHEMA, maxOutputTokens: 500 });
    const text = String(result?.reply || '').trim();
    // 2026-10-26: "Namaste! Main Mannat GemRishi se." alone was sent as a
    // whole reply. Anything this thin falls back to the caller's fixed line.
    const body = text.replace(/[-–]\s*Mannat\s*$/i, '').replace(/\b(namaste|hello|hi|hari om)\b[!.,]?/gi, '').replace(/\bmain mannat( gemrishi se)?\b[.!]?/gi, '').trim();
    if (body.length < 25) return '';
    return text;
  } catch (err) {
    console.error('[kundliFlow] reply generation failed:', err.message);
    return '';
  }
}

// ---------------------------------------------------------- Slot filling --

// Changed 2026-10-04 (Ravi, FIX 3): the phone number is NO LONGER required
// before the reading. Mahender Verma gave full birth details and was asked
// for his number ~6 times instead of being told which stone to wear. The
// number is still picked up if the customer gives it (OPTIONAL_SLOTS), but
// the reading never waits for it.
const REQUIRED_SLOTS = ['name', 'date', 'time', 'place', 'purpose'];
const OPTIONAL_SLOTS = ['phone'];
const ALL_SLOTS = [...REQUIRED_SLOTS, ...OPTIONAL_SLOTS];
function missingSlots(slots) {
  return REQUIRED_SLOTS.filter((key) => !slots[key]);
}

const SLOT_LABELS = {
  name: 'their name',
  date: 'date of birth',
  time: 'time of birth',
  place: 'place of birth',
  purpose: 'what they want guidance on (career, wealth, marriage, health, protection, etc.)',
  phone: 'a contact phone number (so the team can reach them if needed)',
};

// ------------------------------------------------------------ Main entry --

/**
 * @returns {Promise<null|{reply: string, leadStatus: string, productInterest: string, escalate: boolean, escalateReason: string}>}
 *   null means "not applicable" - caller should fall back to the normal reply flow.
 */
// A message carrying a date / time / "born" is a birth-detail answer even if
// it also says "gold" or "ring" somewhere.
function looksLikeBirthDetails(text) {
  const t = String(text || '');
  return /\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|\b\d{1,2}[:.]\d{2}\s*(am|pm)?\b|\b(dob|d\.o\.b|born|janam|birth|janm)\b|\b(19|20)\d{2}\b/i.test(t);
}

let recentChat = ''; // last few lines of this chat, for context in stage replies

async function maybeHandleKundliTurn({ enabled, type, memoryId, message, intent, existingMemory = '', platform = '', knownPhone = '' }) {
  if (!enabled) return null;
  recentChat = String(existingMemory || '').split('\n').slice(-6).join('\n');
  currentPlatform = String(platform || '').toLowerCase();
  currentPhone = String(knownPhone || '').replace(/[^\d+]/g, '');
  if (type === 'comment') return null; // never run multi-turn birth-detail collection in public

  let state = await getSession(memoryId);
  const isFreshStart = !state;

  // Escape hatch (Ravi, 2026-09-23): if the customer's message clearly names
  // a specific paid consultation-plan price together with buying/payment
  // language - whether they're starting fresh or already mid-way through
  // this free flow - this flow must yield so consultationFlow.js (checked
  // next in webhook.js) can actually hand them the real payment link.
  // Without this, this flow's broad 'consultation' intent match was
  // swallowing explicit purchase requests and the paid flow never got a
  // chance to run at all. Skipped during the one turn where we've just
  // asked the customer for their BUDGET (a bare price number there is an
  // answer to that question, not a plan switch).
  if (!(state?.awaitingBudget) && looksLikePaidPlanSwitch(message)) {
    if (state) await clearSession(memoryId);
    return null;
  }

  // Step 3 (qualification ladder): a paid-reading offer is in progress.
  const paid = await getPaidState(memoryId);
  // "link" typed later, after the offer was declined/ignored -> send it.
  if (paid && paid.status === 'declined' && /^\W*(link|payment link|link (bhejo|bhej do|send)|send (the )?link)\b/i.test(message)) paid.status = 'pitched';
  if (paid && ['pitched', 'need_phone', 'link_sent'].includes(paid.status)) {
    const paidResult = await handlePaidOffer(memoryId, paid, message, existingMemory);
    if (paidResult) return paidResult;
  }
  // Step 3: someone who already had the free reading keeps asking for
  // predictions -> offer the paid detailed reading instead of more free ones.
  if (PREDICTION_ASK.test(message) && !BUYING_SIGNAL.test(message)) {
    let reading = state?.chart ? state : null;
    if (!reading && !state) {
      const saved = await getReading(memoryId);
      if (saved?.chart) reading = saved;
    }
    if (reading) return pitchPaidReading(memoryId, reading, paid, message, existingMemory);
  }

  // Added 2026-09-23 (Ravi): a customer sharing a personal problem in their
  // own words is now also a valid opening for this flow, not just an
  // explicit "astrology/kundli/consultation" ask - see intentRouter.js's
  // 'personal_problem' intent and handleAcknowledging() below for how the
  // two openings are handled differently (a direct ask goes straight to
  // collecting details; a shared problem gets a warm, conversational
  // opening first, and only moves to collecting details once they agree).
  // Fix (2026-09-24, Ravi): a customer directly asking "is this right for
  // me?" / "which one should I wear?" / "suggest for me" (intentRouter.js's
  // 'recommendation' intent) is exactly what this flow exists for, but was
  // being missed - the gate only opened on 'consultation'/'personal_problem'.
  // Real case: a customer named a specific gemstone ('purchase' intent on
  // turn 1), then asked "kya ye mere liye sahi hai" (is this right for me)
  // on turn 2 - a textbook 'recommendation' intent - and even went on to
  // give full birth details unprompted, but the flow never started, so no
  // real Kundli/astrology-engine check ever ran; the generic reply engine
  // just said it would check and then escalated the whole thing to a human
  // instead. Also opens for a gemstone-naming 'purchase' ask on turn 1
  // itself (see GEMSTONE_NAME_PATTERN above for why that's scoped safely).
  // FIX (2026-10-05): a customer who already got a reading and comes back
  // with "recommend me / as per my chart" or just "Rudraksh" picks up from
  // their saved chart - no re-asking name or birth details.
  if (isFreshStart && !CANCEL_WORDS.test(message)) {
    const wantsReading = intent?.intent === 'recommendation' || intent?.intent === 'consultation' || CATEGORY_ONLY.test(message);
    const saved = wantsReading ? await getReading(memoryId) : null;
    if (saved?.chart && saved?.slots?.name) {
      const restored = {
        stage: 'choosing_category', startedFrom: 'consultation', slots: saved.slots, chart: saved.chart,
        categoryAsked: 0, restoredReading: true, createdAt: new Date().toISOString(),
      };
      const languageNoteR = detectReplyLanguageNote(message, existingMemory);
      const cat = namedCategory(message);
      if (cat) return handleChoosingCategory(memoryId, restored, message, languageNoteR, { forcedCategory: cat });
      return handleChoosingCategory(memoryId, restored, message, languageNoteR);
    }
  }

  const isGemstonePurchaseAsk = intent?.intent === 'purchase' && GEMSTONE_NAME_PATTERN.test(message) && !PRODUCT_REQUEST.test(message);
  if (isFreshStart && intent?.intent !== 'consultation' && intent?.intent !== 'personal_problem' && intent?.intent !== 'recommendation' && !isGemstonePurchaseAsk) return null;
  // 2026-10-26: never (re)start the free reading in the middle of a sale -
  // Mannat has already shared product links and the customer is asking about
  // a concrete product.
  if (isFreshStart && SALES_CHAT.test(existingMemory) && PRODUCT_REQUEST.test(message)) return null;
  // Mid-collection, a concrete product request (price, ring, photos...) is
  // answered by the normal reply engine instead of asking for DOB again.
  if (state && ['acknowledging', 'collecting', 'choosing_category'].includes(state.stage)
      && PRODUCT_REQUEST.test(message) && !looksLikeBirthDetails(message)) {
    await clearSession(memoryId);
    return null;
  }

  if (CANCEL_WORDS.test(message) && state) {
    await clearSession(memoryId);
    return {
      reply: looksHinglishOrHindi(message)
        ? 'Bilkul, koi baat nahi! Jab bhi aap Kundli/gemstone guidance ke liye ready hों, main yahin hoon. - Mannat'
        : "No problem at all! Whenever you're ready for Kundli/gemstone guidance, I'm right here. - Mannat",
      leadStatus: 'WARM', productInterest: 'Kundli Consultation (paused)', escalate: false, escalateReason: '',
    };
  }

  const languageNote = detectReplyLanguageNote(message, existingMemory);

  if (!state) {
    const startedFrom = intent?.intent === 'personal_problem' ? 'personal_problem' : 'consultation';
    state = {
      stage: startedFrom === 'personal_problem' ? 'acknowledging' : 'collecting',
      startedFrom,
      slots: { name: '', date: '', time: '', place: '', purpose: '', phone: '' },
      createdAt: new Date().toISOString(),
    };

    // Fix (2026-09-23, Ravi): don't ask for name/other details again if the
    // customer already gave them earlier in this same conversation, before
    // this flow ever started - pre-fill from the recent conversation
    // history the same way a human rep would remember it. This never
    // overwrites anything the customer states fresh in later turns; it only
    // seeds the starting point.
    if (existingMemory) {
      const prefill = await extractSlots(existingMemory, 'nothing yet');
      for (const key of ALL_SLOTS) if (prefill[key]) state.slots[key] = prefill[key];
    }
    // FIX 1 (2026-10-04): remember whether the customer already said
    // gemstone or Rudraksha, so the category question is skipped later.
    const choice = detectCategoryChoice(existingMemory, message);
    if (choice === 'gemstone' || choice === 'rudraksha') state.preferredCategory = choice;
    else if (GEMSTONE_NAME_PATTERN.test(`${existingMemory}\n${message}`)) state.preferredCategory = 'gemstone';

    if (startedFrom === 'personal_problem') {
      // Ravi's explicit ask (2026-09-23): don't jump straight to a form (or
      // straight to the WhatsApp number) the moment someone shares a
      // problem - converse first, offer the free chart-based look, and only
      // start collecting birth details once they say yes. This first reply
      // doesn't touch handleCollecting/generateStageReply's usual "ask for
      // slot X" instruction at all - it's a standalone empathetic opener.
      await setSession(memoryId, state);
      const reply = await generateStageReply({
        contextSummary: `The customer just shared a personal problem/struggle in their own words (not an explicit request for astrology/consultation): "${message}".`,
        instruction: `Respond with genuine warmth and empathy first - briefly acknowledge what they shared, don't rush past it or immediately hand over a phone number/WhatsApp link. Then gently mention that, if they'd like, you can take a quick, completely free look at what their birth details/planetary period suggest about this as a starting point. Ask if they'd like to try that. Do not ask for any birth details yet in this message - just make the offer and wait for them to agree.`,
        languageNote,
      });
      // Fix (2026-09-24, Ravi): same language-mixing bug as the fallbacks in
      // replyEngine.js - this was a single hardcoded Hindi/Hinglish string
      // regardless of what language the customer actually wrote in.
      return {
        reply: reply || (looksHinglishOrHindi(message)
          ? 'Ji, main samajh sakti hoon yeh mushkil hoga. Agar aap chahein, main aapki birth details ke basis pe dekh sakti hoon ki abhi ka samay kya keh raha hai - ye bilkul free hai. Kya aap try karna chahenge? - Mannat'
          : "I understand this must be difficult. If you'd like, I can take a quick, completely free look at what your birth details/current planetary period suggest about this. Would you like to try that? - Mannat"),
        leadStatus: 'WARM', productInterest: 'Kundli Consultation (offered)', escalate: false, escalateReason: '',
      };
    }
  }

  try {
    if (state.stage === 'acknowledging') return await handleAcknowledging(memoryId, state, message, languageNote);
    if (state.stage === 'collecting') return await handleCollecting(memoryId, state, message, languageNote);
    if (state.stage === 'choosing_category') return await handleChoosingCategory(memoryId, state, message, languageNote);
    if (state.stage === 'awaiting_buy_decision') return await handleBuyDecision(memoryId, state, message, languageNote);
  } catch (err) {
    console.error('[kundliFlow] unexpected error, escalating with what we have:', err.message);
    await clearSession(memoryId);
    return {
      reply: looksHinglishOrHindi(message)
        ? 'Aapki details ke saath thodi technical dikkat aa rahi hai - koi baat nahi, main abhi humari team ko connect kar rahi hoon taaki wo aapki Kundli/gemstone guidance personally complete kar sakein. - Mannat'
        : "There's a small technical hiccup with your details - no worries, I'm connecting with our team right now so they can personally complete your Kundli/gemstone guidance. - Mannat",
      leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: true, escalateReason: 'kundli_flow_error',
      customerName: state?.slots?.name || '', customerPhone: state?.slots?.phone || '',
    };
  }

  // Unknown/stale stage - don't get stuck, hand back to the normal flow.
  await clearSession(memoryId);
  return null;
}

const ACKNOWLEDGING_AGREE_WORDS = /\b(yes|ya|ha+n|haa|sure|ok(ay)?|bilkul|zaroor|thik hai|theek hai|chalo|batao|dekhte hain|try|kar(o|te) hain|kijiye|please|go ahead)\b/i;
const ACKNOWLEDGING_DECLINE_WORDS = /\b(no|nahi|not now|rehne do|baad mein|nope)\b/i;

// Handles the turn AFTER the empathetic opener above, when the flow started
// from a shared personal problem rather than an explicit ask. Only moves
// into birth-detail collection once the customer clearly agrees - an
// ambiguous or declining reply keeps the conversation going naturally
// instead of forcing the form or dropping them.
async function handleAcknowledging(memoryId, state, message, languageNote = '') {
  const planQuestionNote = detectPlanQuestionNote(message);

  if (ACKNOWLEDGING_DECLINE_WORDS.test(message) && !ACKNOWLEDGING_AGREE_WORDS.test(message)) {
    await clearSession(memoryId);
    return {
      reply: looksHinglishOrHindi(message)
        ? 'Koi baat nahi, bilkul aapki marzi! Main yahin hoon jab bhi aapko lage ki try karna hai - aap chahein toh aise hi baat bhi kar sakte hain. - Mannat'
        : "No problem at all, totally your call! I'm here whenever you feel like trying it - or we can just keep chatting if you'd like. - Mannat",
      leadStatus: 'WARM', productInterest: 'Kundli Consultation (declined)', escalate: false, escalateReason: '',
    };
  }

  if (!ACKNOWLEDGING_AGREE_WORDS.test(message)) {
    const reply = await generateStageReply({
      contextSummary: `Customer hasn't clearly said yes or no to the free birth-chart-based look offered last turn, for the problem they shared earlier.`,
      instruction: `Respond naturally and warmly to what they just said, and gently check again whether they'd like you to take that quick free look based on their birth details, or if they'd rather just keep talking for now. Don't ask for birth details yet unless they've clearly agreed.`,
      languageNote,
      planQuestionNote,
    });
    await setSession(memoryId, state);
    return {
      reply: reply || (looksHinglishOrHindi(message)
        ? 'Koi jaldi nahi - jab man kare, bata dijiyega agar aap birth chart ke basis pe dekhna chahte hain. - Mannat'
        : "No rush at all - just let me know whenever you'd like me to take a look based on your birth chart. - Mannat"),
      leadStatus: 'WARM', productInterest: 'Kundli Consultation (offered)', escalate: false, escalateReason: '',
    };
  }

  state.stage = 'collecting';
  return handleCollecting(memoryId, state, message, languageNote);
}

async function handleCollecting(memoryId, state, message, languageNote = '') {
  const planQuestionNote = detectPlanQuestionNote(message);
  const known = ALL_SLOTS.filter((k) => state.slots[k]).map((k) => `${k}: ${state.slots[k]}`).join(', ') || 'nothing yet';
  const extracted = await extractSlots(message, known);
  const slots = { ...state.slots };
  for (const key of ALL_SLOTS) if (extracted[key]) slots[key] = extracted[key];
  // 2026-10-26: a bare country/state is not a birth place. After a failed
  // lookup, join it to the town they typed ("Muktar" + "Punjab, India");
  // otherwise ask for the town again.
  if (slots.place && REGION_ONLY.test(slots.place)) {
    slots.place = state.badPlace ? `${state.badPlace}, ${slots.place}` : '';
  }
  state.slots = slots;

  // A customer who doesn't know their exact birth time (real case 24 Oct:
  // asked three times, "Nahi pata", "Nahi janta") - use an approximate time
  // instead of looping, and say the reading is approximate.
  if (!slots.time && slots.date && missingSlots(slots)[0] === 'time') {
    state.timeAsks = (state.timeAsks || 0) + 1;
    if (UNKNOWN_TIME.test(message) || state.timeAsks > 2) {
      slots.time = approxBirthTime(`${recentChat}\n${message}`);
      state.timeApprox = true;
    }
  }

  const missing = missingSlots(slots);
  if (missing.length > 0) {
    const reply = await generateStageReply({
      contextSummary: `Collecting birth details for a Kundli reading before recommending a gemstone or Rudraksha. Already have: ${REQUIRED_SLOTS.filter((k) => slots[k]).map((k) => `${k}=${slots[k]}`).join(', ') || 'nothing yet'}.`,
      instruction: `Ask naturally for ${SLOT_LABELS[missing[0]]}${missing.length > 1 ? ` (you'll ask for the rest after)` : ''}.${missing[0] === 'time' ? ' Mention that an approximate time (like morning/evening) is fine if they do not know the exact time.' : ''} If they just gave you something, briefly acknowledge it first. Ask for ONE thing at a time, don't dump a form. If a detail (like their name) already appears above under "Already have", don't ask for it again. Never ask for their phone number here - it is not needed for the reading.`,
      languageNote,
      planQuestionNote,
    });
    await setSession(memoryId, state);
    return {
      reply: reply || (looksHinglishOrHindi(message)
        ? `Aap apna ${SLOT_LABELS[missing[0]]} bata sakte hain? - Mannat`
        : `Could you share your ${SLOT_LABELS[missing[0]]}? - Mannat`),
      leadStatus: 'WARM', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
    };
  }

  // All slots present - generate the chart.
  const engineResult = await getKundliReading(state.slots);
  if (!engineResult.success) {
    // A geocode miss on the place the customer typed is not the engine being
    // down - clear just the "place" slot and re-ask (reusing the normal
    // missing-slot flow above) instead of escalating as an outage, so
    // Telegram/known-issues don't read "engine unavailable" for what's
    // usually just "Ambala" needing to be "Ambala, Haryana, India".
    // 2026-10-11 (Ravi, after a false-alarm Telegram alert).
    if (engineResult.reason === 'geocode_not_found') {
      const badPlace = state.slots.place;
      state.slots = { ...state.slots, place: '' };
      state.geoMisses = (state.geoMisses || 0) + 1;
      // Third miss: stop looping, the team finishes the reading by hand.
      if (state.geoMisses >= 3) {
        await clearSession(memoryId);
        return {
          reply: looksHinglishOrHindi(message)
            ? 'Aapki details mil gayi, dhanyavaad! Birth place confirm karne ke liye hamari astrology team aapse personally contact karegi aur reading complete karegi. - Mannat'
            : "Thank you for your details! Our astrology team will contact you personally to confirm your birth place and complete the reading. - Mannat",
          leadStatus: 'WARM', productInterest: 'Kundli Consultation', escalate: true,
          escalateReason: `kundli_birth_place_not_found | tried: ${[state.badPlace, badPlace].filter(Boolean).join(' / ')} | Name: ${state.slots?.name || ''} | DOB: ${state.slots?.date || ''} ${state.slots?.time || ''}`,
          customerName: state.slots?.name || '', customerPhone: state.slots?.phone || currentPhone || '',
        };
      }
      state.badPlace = String(badPlace || '').split(',')[0].trim();
      await setSession(memoryId, state);
      return {
        reply: looksHinglishOrHindi(message)
          ? `Mujhe "${badPlace}" location nahi mil paa raha. Kya aap nearest bade city/state/country ke saath bata sakte hain? Jaise "Ambala, Haryana, India". - Mannat`
          : `I couldn't place "${badPlace}" on the map. Could you share it with the nearest bigger city, state and country - like "Ambala, Haryana, India"? - Mannat`,
        leadStatus: 'WARM', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
      };
    }
    await clearSession(memoryId);
    return {
      reply: looksHinglishOrHindi(message)
        ? 'Aapki details mil gayi, dhanyavaad! Kundli generate karte waqt thodi technical dikkat aa rahi hai, toh main aapki details humari astrology team ko bhej rahi hoon - wo aapse jaldi hi Kundli aur recommendation ke saath contact karenge. - Mannat'
        : "Got your details, thank you! There's a small technical hiccup generating the Kundli, so I'm passing your details to our astrology team - they'll contact you shortly with your Kundli and recommendation. - Mannat",
      leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: true, escalateReason: `kundli_engine_unavailable (${engineResult.reason || 'unknown'})`,
      customerName: state.slots.name || '', customerPhone: state.slots.phone || '',
    };
  }

  const data = engineResult.data;
  const activeDasha = currentMahadasha(data.astrology?.dasha);
  state.chart = {
    activeDashaLord: activeDasha?.lord || null,
    rudrakshaRecommendation: data.recommendation || null,
    shopify: data.shopify || null,
  };
  state.stage = 'choosing_category';
  await setSession(memoryId, state);
  await saveReading(memoryId, state);

  // FIX 1 (2026-10-04): if the customer already told us gemstone or
  // Rudraksha earlier in the chat, don't ask - go straight to it.
  if (state.preferredCategory === 'gemstone' || state.preferredCategory === 'rudraksha') {
    return handleChoosingCategory(memoryId, state, state.preferredCategory, languageNote, {
      forcedCategory: state.preferredCategory,
      dashaNote: `Their current Mahadasha lord is ${activeDasha?.lord || 'unavailable'} (purpose: "${state.slots.purpose}") - open with one warm line about what this period traditionally means for that purpose (tradition, never a guarantee).`,
    });
  }
  state.categoryAsked = 1;
  await setSession(memoryId, state);

  const reply = await generateStageReply({
    contextSummary: `Just generated the customer's Kundli. Purpose they gave: "${state.slots.purpose}". Current Mahadasha lord: ${activeDasha?.lord || 'unavailable'}.${state.timeApprox ? ' The birth time is APPROXIMATE (customer did not know it exactly).' : ''}`,
    instruction: `Explain briefly and warmly what their current planetary period (Mahadasha lord: ${activeDasha?.lord || 'unavailable'}) traditionally means in relation to what they asked about ("${state.slots.purpose}") - as tradition, never as a guarantee or medical/outcome claim.${state.timeApprox ? ' Say in a few words that this is a general reading since the exact birth time is not known.' : ''} Then ask: would they like a gemstone recommendation, or a Rudraksha recommendation, based on this.`,
    languageNote,
    planQuestionNote,
  });
  return {
    reply: reply || (looksHinglishOrHindi(message)
      ? `Aapki Kundli ready hai! Aapke current Mahadasha lord ${activeDasha?.lord || 'abhi calculate ho raha hai'} hain. Kya aap gemstone recommendation chahenge ya Rudraksha? - Mannat`
      : `Your Kundli is ready! Your current Mahadasha lord is ${activeDasha?.lord || 'still being calculated'}. Would you like a gemstone recommendation or a Rudraksha one? - Mannat`),
    leadStatus: 'WARM', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
  };
}

const UNSURE_WORDS = /\b(not sure|dont know|don't know|no idea|confus|pata nahi|kuch bhi|aap hi bata|you decide|suggest you|recommend you)\b/i;
const BUDGET_NUMBER = /(\d[\d,]{1,7})/;

const BOTH_PATTERN = /\b(both|dono|dono hi|both of them)\b/i;

async function handleChoosingCategory(memoryId, state, message, languageNote = '', opts = {}) {
  const planQuestionNote = detectPlanQuestionNote(message);
  // FIX 1 (2026-10-04, Ravi): "Both" -> explain the gemstone first, then the
  // Rudraksha, then ask which ONE they want to go deeper on. Asked once only.
  if (!opts.forcedCategory && BOTH_PATTERN.test(message) && !state.bothExplained) {
    const activeDasha = state.chart?.activeDashaLord ? { lord: state.chart.activeDashaLord } : null;
    const gem = recommendGemstone({ purpose: state.slots.purpose, activeDasha });
    const rud = state.chart?.rudrakshaRecommendation?.recommendation || {};
    const gemName = gem?.primary?.gem || '';
    const rudName = rud?.primary?.name || '';
    state.bothExplained = true;
    state.categoryAsked = 2;
    await setSession(memoryId, state);
    const reply = await generateStageReply({
      contextSummary: `The customer wants to hear about BOTH. Gemstone pick: ${gemName || 'none matched'}. Rudraksha pick: ${rudName || 'none matched'}. Purpose: "${state.slots.purpose}".\n\nGEMSTONE CATALOG NOTES:\n${GEMSTONE_CATALOG_NOTES}\n\nRUDRAKSHA CATALOG NOTES:\n${CATALOG_NOTES}`,
      instruction: `In 2-3 short blocks: first explain the gemstone pick briefly (why it suits, indicative range if listed, framed as indicative). Then explain the Rudraksha pick briefly. Then ask which ONE of the two they would like to know more about or buy. Never a guarantee.`,
      languageNote,
      planQuestionNote,
    });
    return {
      reply: reply || (looksHinglishOrHindi(message)
        ? `Aapke liye gemstone mein ${gemName || 'ek suitable ratna'} aur Rudraksha mein ${rudName || 'ek suitable Rudraksha'} achha rahega. In dono mein se aap kis ke baare mein aur jaanna ya lena chahenge?`
        : `For you, the gemstone pick is ${gemName || 'a suitable stone'} and the Rudraksha pick is ${rudName || 'a suitable Rudraksha'}. Which one would you like to know more about or buy?`),
      leadStatus: 'WARM', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
    };
  }
  // Customer is answering the budget question we asked last turn - decide
  // gemstone vs Rudraksha using their budget, purpose, and both catalogs,
  // rather than guessing with a hardcoded price rule.
  if (state.awaitingBudget) {
    const match = message.replace(/,/g, '').match(BUDGET_NUMBER);
    const budget = match ? match[1] : '';
    state.slots.budget = budget || 'not specified';
    state.awaitingBudget = false;
    await setSession(memoryId, state);

    const reply = await generateStageReply({
      contextSummary: `The customer wasn't sure whether they want a gemstone or a Rudraksha, so we asked their budget. Budget they gave: ${state.slots.budget}. Purpose: "${state.slots.purpose}".\n\nGEMSTONE CATALOG NOTES:\n${GEMSTONE_CATALOG_NOTES}\n\nRUDRAKSHA CATALOG NOTES:\n${CATALOG_NOTES}`,
      instruction: `Using the indicative price ranges in the catalog notes and their stated purpose, suggest whether a gemstone or a Rudraksha is likely a better fit for their budget - as guidance, never a guarantee, and never a fixed price. End by asking them to confirm which one (gemstone or Rudraksha) they'd like to go with.`,
      languageNote,
      planQuestionNote,
    });
    return {
      reply: reply || (looksHinglishOrHindi(message)
        ? 'Aapke budget ke hisaab se main aapko suggest kar sakti hoon - kya aap gemstone try karna chahenge ya Rudraksha? - Mannat'
        : "Based on your budget, I can suggest what would fit best - would you like to try a gemstone or a Rudraksha? - Mannat"),
      leadStatus: budget ? 'HOT' : 'WARM', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
    };
  }

  let wantsGemstone = opts.forcedCategory ? opts.forcedCategory === 'gemstone' : /gem(stone)?|ratna|stone/i.test(message);
  let wantsRudraksha = opts.forcedCategory ? opts.forcedCategory === 'rudraksha' : /rudraksh|mukhi|mala/i.test(message);
  // FIX 1: the category question is asked at most ONCE. Any unclear or
  // unsure answer after that defaults to GEMSTONE (our ads are gemstone
  // ads) instead of asking again.
  if (!wantsGemstone && !wantsRudraksha && (state.categoryAsked >= 1 || UNSURE_WORDS.test(message))) wantsGemstone = true;
  if (wantsGemstone && wantsRudraksha) wantsRudraksha = false;

  if (!wantsGemstone && !wantsRudraksha) {
    if (UNSURE_WORDS.test(message)) {
      state.awaitingBudget = true;
      await setSession(memoryId, state);
      const reply = await generateStageReply({
        contextSummary: `The customer isn't sure whether they want a gemstone or a Rudraksha recommendation.`,
        instruction: `Warmly say that's totally fine, and ask what budget they have in mind - that'll help suggest whichever (gemstone or Rudraksha) fits best.`,
        languageNote,
        planQuestionNote,
      });
      return { reply: reply || (looksHinglishOrHindi(message)
        ? 'Koi baat nahi! Aap apna budget bata sakte hain? Usse main aapko sahi suggestion de sakti hoon. - Mannat'
        : "No worries at all! Could you share what budget you have in mind? That'll help me suggest the right fit for you. - Mannat"), leadStatus: 'WARM', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '' };
    }
    const reply = await generateStageReply({
      contextSummary: `Waiting for the customer to pick gemstone or Rudraksha guidance.`,
      instruction: `Their message didn't clearly say gemstone or Rudraksha - ask again warmly, offering both options plainly (and mention they can also just say they're not sure and share a budget instead).`,
      languageNote,
      planQuestionNote,
    });
    await setSession(memoryId, state);
    return { reply: reply || (looksHinglishOrHindi(message)
      ? 'Kya aap gemstone ke baare mein jaanna chahenge ya Rudraksha ke baare mein? - Mannat'
      : "Would you like to know more about a gemstone or a Rudraksha? - Mannat"), leadStatus: 'WARM', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '' };
  }

  let recommendation;
  let category;
  if (wantsGemstone) {
    category = 'gemstone';
    const activeDasha = state.chart?.activeDashaLord ? { lord: state.chart.activeDashaLord } : null;
    recommendation = recommendGemstone({ purpose: state.slots.purpose, activeDasha });
  } else {
    category = 'rudraksha';
    recommendation = state.chart?.rudrakshaRecommendation?.recommendation || { primary: null, alternatives: [] };
  }

  state.category = category;
  state.recommendation = recommendation;
  state.stage = 'awaiting_buy_decision';
  await setSession(memoryId, state);

  const primaryName = category === 'gemstone' ? recommendation.primary?.gem : recommendation.primary?.name;
  if (!primaryName) {
    await clearSession(memoryId);
    return {
      reply: looksHinglishOrHindi(message)
        ? 'Iske liye main aapko humari team se personally connect karwati hoon taaki wo aapke liye best option suggest kar sakein. - Mannat'
        : "For this, let me connect you personally with our team so they can suggest the best option for you. - Mannat",
      leadStatus: 'HOT', productInterest: category === 'gemstone' ? 'Gemstone Consultation' : 'Rudraksha Consultation', escalate: true, escalateReason: 'no_recommendation_match',
      customerName: state.slots.name || '', customerPhone: state.slots.phone || '',
    };
  }

  const catalogNotes = category === 'gemstone' ? GEMSTONE_CATALOG_NOTES : CATALOG_NOTES;
  const reasons = (recommendation.primary?.reasons || []).join('; ');
  const live = await liveOptionsFor(category === 'gemstone' ? primaryName : `${primaryName} rudraksha`);
  const reply = await generateStageReply({
    contextSummary: `Recommending in the ${category} category. Top pick: ${primaryName} (reasons: ${reasons || 'general fit'}). Relevant catalog notes (background only - NOT a price source):\n${catalogNotes}${live ? `\n\nLIVE IN-STOCK OPTIONS (the ONLY prices and links you may quote):\n${live}` : ''}`,
    instruction: `${opts.dashaNote ? `${opts.dashaNote} Then present` : 'Present'} ${primaryName} as the top recommendation with a brief, warm reason (never a guarantee).${category === 'gemstone' ? ' Talk only about gemstones - do not mention Rudraksha.' : ''} ${live ? 'Share 1-2 of the LIVE IN-STOCK OPTIONS with their exact price and link.' : 'Do not quote any price or per-carat rate; say the exact options and prices can be shared.'} Then end with ONE filter question: are they planning to get it, and what budget (or ratti/carat size) do they have in mind? Do not pitch the paid consultation plans in this message.`,
    languageNote,
    planQuestionNote,
  });
  const hindiRec = looksHinglishOrHindi(message) || looksHinglishOrHindi(recentChat);
  return {
    reply: (reply || (hindiRec
      ? `Aapke liye ${primaryName} sabse suitable lag raha hai! Kya aap ise lene ka soch rahe hain? Aapka budget ya ratti size kitna hai? - Mannat`
      : `${primaryName} looks like the best fit for you! Are you planning to get it? What budget or size do you have in mind? - Mannat`)) + whatsappNudge(hindiRec),
    leadStatus: 'WARM', productInterest: primaryName, escalate: false, escalateReason: '',
  };
}

async function handleBuyDecision(memoryId, state, message, languageNote = '') {
  // FIX (2026-10-05): the customer names the OTHER category instead of
  // answering yes/no (e.g. offered a Pearl, replies "Rudraksh") - switch and
  // give the chart-based pick for that category, instead of pushing the
  // first product again.
  const asked = namedCategory(message);
  if (asked && asked !== state.category && !/\b(yes|haan|buy|order|confirm)\b/i.test(message)) {
    state.stage = 'choosing_category';
    return handleChoosingCategory(memoryId, state, message, languageNote, { forcedCategory: asked });
  }
  // FIX (2026-10-07, Ravi): the reading suggested Gomed; Amit Choudhary then
  // replied "I have been advised to wear emerald - panna by an astrologer" and
  // Mannat just asked again whether he wanted to buy the Gomed. If the customer
  // names a DIFFERENT gemstone at this point, respect it: no more pushing the
  // chart pick, acknowledge their choice, and hand the chat to sales with both
  // stones noted so the gemologist can guide them.
  const namedGem = gemNamedIn(message);
  const recommendedGem = state.category === 'gemstone' ? (state.recommendation?.primary?.gem || '') : '';
  if (namedGem && !sameGem(namedGem, recommendedGem)) {
    const chartPick = recommendedGem || (state.recommendation?.primary?.name || 'the chart-based pick');
    await clearSession(memoryId);
    const reply = await generateStageReply({
      contextSummary: `A free chart-based look suggested ${chartPick}. The customer has now named ${namedGem} instead (for example because their own astrologer advised it).`,
      instruction: `Respect the customer's choice. Do NOT push ${chartPick} again and do not argue with their astrologer. Warmly acknowledge that ${namedGem} works and say our gemologist will personally help them pick the right ${namedGem} (size, quality and budget), and can also explain the chart reading if they want. Ask one short question: their budget or preferred size. Do not quote any price.`,
      languageNote,
    });
    return {
      reply: reply || (looksHinglishOrHindi(message)
        ? `Bilkul, ${namedGem} aapke liye theek rahega. Hamare gemologist aapko sahi ${namedGem} chunne mein personally madad karenge. Aapka budget ya preferred size kya hai? - Mannat`
        : `Of course, ${namedGem} it is. Our gemologist will personally help you choose the right ${namedGem}. What budget or size do you have in mind? - Mannat`),
      leadStatus: 'HOT', productInterest: namedGem, escalate: true,
      escalateReason: `kundli_customer_named_other_gem | chart suggested ${chartPick}, customer wants ${namedGem} | Name: ${state.slots?.name || 'not given'} | DOB: ${state.slots?.date || ''} ${state.slots?.time || ''} | Place: ${state.slots?.place || ''}`,
      customerName: state.slots?.name || '', customerPhone: state.slots?.phone || '',
    };
  }
  const planQuestionNote = detectPlanQuestionNote(message);
  // Step 2 (qualification ladder): the customer answered the filter question
  // with a budget or a size -> a real buyer. Hand to sales now with the full
  // case file; Mannat shares live options and says the team will follow up.
  if (BUDGET_OR_SIZE.test(message) && /\d/.test(message) && !planQuestionNote) {
    const recName = state.category === 'gemstone' ? state.recommendation?.primary?.gem : state.recommendation?.primary?.name;
    const live = await liveOptionsFor(state.category === 'gemstone' ? recName : `${recName} rudraksha`);
    const caseFile = [
      'Kundli flow - QUALIFIED (budget/size given)',
      `Budget/size: ${message.slice(0, 80)}`,
      `Name: ${state.slots?.name || 'not given'}`,
      `Phone: ${state.slots?.phone || currentPhone || 'not given'}`,
      `DOB: ${state.slots?.date || ''} ${state.slots?.time || ''}${state.timeApprox ? ' (approx)' : ''}`,
      `Place: ${state.slots?.place || ''}`,
      `Purpose: ${state.slots?.purpose || ''}`,
      `Recommended: ${recName || 'unknown'}`,
    ].join(' | ');
    await clearSession(memoryId);
    const reply = await generateStageReply({
      contextSummary: `The free reading recommended ${recName}. The customer just gave their budget/size: "${message}".${live ? `\n\nLIVE IN-STOCK OPTIONS (the ONLY prices and links you may quote):\n${live}` : ''}`,
      instruction: `Thank them. ${live ? 'If any LIVE IN-STOCK OPTION fits their budget/size, share 1-2 of them with exact price and link; if none fits, say so honestly and mention the nearest option.' : 'Do not quote any price.'} Then say our gemologist will personally share the best options in their budget shortly. No question needed.`,
      languageNote,
    });
    const hindi = looksHinglishOrHindi(message) || looksHinglishOrHindi(recentChat);
    return {
      reply: reply || (hindi
        ? `Dhanyavaad! Aapke budget ke hisaab se hamare gemologist aapko best ${recName || ''} options personally share karenge. - Mannat`
        : `Thank you! Our gemologist will personally share the best ${recName || ''} options in your budget shortly. - Mannat`),
      leadStatus: 'HOT', productInterest: recName || 'Kundli Consultation', escalate: true,
      escalateReason: `kundli_qualified_budget | ${caseFile}`,
      customerName: state.slots?.name || '', customerPhone: state.slots?.phone || currentPhone || '',
    };
  }
  // 2026-10-26 (Tushar, 25 Oct): "please call me" / "your name?" were
  // answered with the plans or "shall we go ahead and purchase?" again.
  // Hand those to the normal reply engine; the session stays, so a later
  // budget or "yes" still lands here.
  if (CALL_REQUEST.test(message) || ASKS_NAME.test(message)) {
    state.buyAskedLast = false;
    await setSession(memoryId, state);
    return null;
  }
  const okAfterBuyAsk = Boolean(state.buyAskedLast) && SHORT_YES.test(message);
  const readyToBuy = okAfterBuyAsk || (/\b(yes|haan|ha|han|ready|buy|confirm|order|le[nl]ooo?|proceed|book)\b/i.test(message) && !/\b(batao|bataiye|details?|explain|plan|kundli|written)\b/i.test(message));
  const declining = /\b(no|nahi|not now|later)\b/i.test(message);
  const recommendedName = state.category === 'gemstone' ? state.recommendation?.primary?.gem : state.recommendation?.primary?.name;

  if (!readyToBuy && !declining && (BUY_STAGE_QUESTION.test(message) || planQuestionNote)) {
    const live = await liveOptionsFor(state.category === 'gemstone' ? recommendedName : `${recommendedName} rudraksha`);
    const reply = await generateStageReply({
      contextSummary: `The free chart look recommended ${recommendedName}. RECENT CHAT:\n${recentChat}${live ? `\n\nLIVE IN-STOCK OPTIONS for ${recommendedName} (the ONLY prices and links you may quote):\n${live}` : ''}`,
      instruction: `The customer asked something instead of saying yes/no. Answer THAT directly and specifically first: if it is about the price of ${recommendedName}, give 1-2 LIVE IN-STOCK OPTIONS with exact prices and links (if none are listed, say the team will share exact options - never invent a price or per-carat rate); if it is about a written Kundli, an astrologer call or the paid plans, explain the paid consultation plans clearly with their prices from the CONSULTATION PLAN NOTES (a detailed written Kundli comes with the paid plans); if they want a different stone or a "life stone" overall, explain kindly what the free look covers and that a full reading is done by our astrologer in the paid plan. Do NOT ask whether they want to purchase in this reply - end with one short question about what they asked.`,
      languageNote,
      planQuestionNote,
    });
    state.buyAskedLast = false;
    await setSession(memoryId, state);
    return { reply: reply || (looksHinglishOrHindi(message)
      ? 'Ji zaroor! Main aapko iski poori details share karti hoon - aap kis cheez ke baare mein jaanna chahenge, stone ke options ya consultation plans? - Mannat'
      : "Of course! Would you like the stone options with prices, or the details of our consultation plans? - Mannat"),
    leadStatus: 'WARM', productInterest: recommendedName || 'Kundli Consultation', escalate: false, escalateReason: '' };
  }

  // 2026-10-26 (Tushar got "would you like to purchase the Pearl now?" 8
  // times while asking other things): ask the buy question at most ONCE.
  // Any later unclear message goes to the normal reply engine, which answers
  // what they actually said.
  if (!readyToBuy && !declining && (state.buyAsks || 0) >= 1) {
    state.buyAskedLast = false;
    await setSession(memoryId, state);
    return null;
  }
  if (!readyToBuy || declining) {
    if (!declining) { state.buyAsks = (state.buyAsks || 0) + 1; state.buyAskedLast = true; }
    const reply = await generateStageReply({
      contextSummary: `Customer hasn't confirmed they're ready to buy yet. Recommended product: ${state.category === 'gemstone' ? state.recommendation?.primary?.gem : state.recommendation?.primary?.name}.`,
      instruction: declining ? `They're not ready yet - reassure them there's no pressure, and that you're happy to answer more questions whenever.` : `It's unclear if they're confirming - ask plainly if they'd like to go ahead and purchase this.`,
      languageNote,
      planQuestionNote,
    });
    if (declining) await clearSession(memoryId);
    else await setSession(memoryId, state);
    return { reply: reply || (looksHinglishOrHindi(message)
      ? 'Koi jaldi nahi hai, jab aap ready hों batayein! - Mannat'
      : "No rush at all, just let me know whenever you're ready! - Mannat"), leadStatus: 'WARM', productInterest: state.category === 'gemstone' ? state.recommendation?.primary?.gem : state.recommendation?.primary?.name, escalate: false, escalateReason: '' };
  }

  const productName = state.category === 'gemstone' ? state.recommendation?.primary?.gem : state.recommendation?.primary?.name;

  // Payment handoff policy (Ravi, confirmed 2026-09-23): a Rudraksha with a
  // known Shopify product page gets that plain product-page link (never a
  // pre-loaded cart link, never Razorpay directly) so the customer can look
  // it over and buy it themselves - no human needed for that step. Anything
  // without a link (gemstones have no product-page mapping yet) still hands
  // off to the team rather than guessing a link or price.
  let productLink = null;
  if (state.category === 'rudraksha') {
    const productHandle = state.chart?.shopify?.productHandle || state.recommendation?.primary?.productHandle;
    if (productHandle) productLink = buildProductPageLink(productHandle);
  }

  const caseFile = [
    `Kundli flow - ready to buy`,
    `Name: ${state.slots.name}`,
    `Phone: ${state.slots.phone || currentPhone || 'not given'}`,
    `DOB: ${state.slots.date} ${state.slots.time}${state.timeApprox ? ' (approx)' : ''}`,
    `Place: ${state.slots.place}`,
    `Purpose: ${state.slots.purpose}`,
    `Category: ${state.category}`,
    `Recommended: ${productName || 'unknown'}`,
    productLink ? `Product link sent to customer: ${productLink}` : 'Payment: handed off to team (no product link available)',
  ].join(' | ');

  await clearSession(memoryId);

  const reply = await generateStageReply({
    contextSummary: `Customer confirmed they want to buy ${productName}. ${productLink ? `Product page link: ${productLink}` : 'No direct product link is available for this item.'}`,
    instruction: productLink
      ? `Confirm warmly, share the product page link exactly as given, and let them know they can review and complete the purchase there directly (checkout/payment happens on the website itself, not with you). Mention the team is also available if they need any help.`
      : `Confirm warmly and let them know the team will personally reach out shortly to finalize the price and take payment. Never mention, imply, or fabricate a payment/checkout link.`,
    languageNote,
    planQuestionNote,
  });
  return {
    reply: reply || (looksHinglishOrHindi(message)
      ? (productLink
        ? `Bahut accha! Yeh raha aapka product link, aap yahin se order kar sakte hain: ${productLink} - Mannat`
        : `Bahut accha! Hamari team aapse jaldi contact karegi exact price aur payment details ke saath. - Mannat`)
      : (productLink
        ? `Great! Here's your product link, you can order directly from here: ${productLink} - Mannat`
        : `Great! Our team will reach out to you shortly with the exact price and payment details. - Mannat`)),
    leadStatus: 'HOT', productInterest: productName || 'Kundli Consultation', escalate: !productLink, escalateReason: `kundli_ready_to_buy | ${caseFile}`,
    customerName: state.slots.name || '', customerPhone: state.slots.phone || currentPhone || '',
  };
}

// ------------------------------------------------- Step 3: paid reading --

function paidPitchText(hindi) {
  const adj = PAID_ADJUSTABLE;
  return hindi
    ? `Ye detailed sawaal hamare astrologer aapki poori Kundli dekh kar hi sahi bata sakte hain 🙏\n\nDetailed Kundli consultation sirf Rs ${PAID_READING_PRICE} mein hai - personalised written Kundli + hamare astrologer se call.${adj ? ` Aur agar aap baad mein stone lete hain, toh ye Rs ${PAID_READING_PRICE} stone ke price mein adjust ho jayega ✅` : ''}\n\nKya main aapko payment link bhej doon?`
    : `A detailed question like this is best answered by our astrologer after studying your full Kundli 🙏\n\nThe detailed Kundli consultation is just Rs ${PAID_READING_PRICE} - a personalised written Kundli + a call with our astrologer.${adj ? ` And if you buy a stone later, the Rs ${PAID_READING_PRICE} is adjusted in the stone price ✅` : ''}\n\nShall I send you the payment link?`;
}

async function pitchPaidReading(memoryId, reading, paid, message, existingMemory) {
  const hindi = looksHinglishOrHindi(message) || looksHinglishOrHindi(existingMemory);
  const pitches = Number(paid?.pitches || 0);
  if (pitches >= 3) return null; // stop nagging - normal reply takes over
  const base = { name: reading?.slots?.name || paid?.name || '', phone: reading?.slots?.phone || paid?.phone || currentPhone || '', dob: `${reading?.slots?.date || ''} ${reading?.slots?.time || ''}`.trim(), place: reading?.slots?.place || '', purpose: reading?.slots?.purpose || '' };
  if (paid?.status === 'declined' || pitches >= 1) {
    await setPaidState(memoryId, { ...paid, ...base, status: 'declined', pitches: pitches + 1 });
    return {
      reply: hindi
        ? `Iska sahi jawab hamare astrologer hi aapki poori Kundli dekh kar de payenge 🙏 Jab bhi aap chahein, Rs ${PAID_READING_PRICE} wali detailed Kundli consultation ke liye bas "link" likh dijiye.`
        : `Our astrologer can answer this properly after studying your full Kundli 🙏 Whenever you'd like the Rs ${PAID_READING_PRICE} detailed consultation, just type "link".`,
      leadStatus: 'WARM', productInterest: `Kundli Consultation Rs ${PAID_READING_PRICE} (offered)`, escalate: false, escalateReason: '',
    };
  }
  await setPaidState(memoryId, { ...base, status: 'pitched', pitches: pitches + 1, pitchedAt: new Date().toISOString() });
  return {
    reply: paidPitchText(hindi),
    leadStatus: 'WARM', productInterest: `Kundli Consultation Rs ${PAID_READING_PRICE} (offered)`, escalate: false, escalateReason: '',
  };
}

function paidLinkReply(hindi, url) {
  return hindi
    ? `Ye raha aapka Rs ${PAID_READING_PRICE} Detailed Kundli consultation ka payment link:\n${url}\n\nPayment ke baad bas yahan screenshot bhej dijiye - uske baad aapki detailed Kundli ka process shuru ho jayega 🙏`
    : `Here's the payment link for the Rs ${PAID_READING_PRICE} Detailed Kundli consultation:\n${url}\n\nOnce paid, just send the screenshot here - that starts your detailed Kundli 🙏`;
}

async function handlePaidOffer(memoryId, paid, message, existingMemory) {
  const hindi = looksHinglishOrHindi(message) || looksHinglishOrHindi(existingMemory);
  const text = String(message || '').trim();
  const interest = `Kundli Consultation Rs ${PAID_READING_PRICE}`;
  const sendLink = async (phone) => {
    const link = getConsultationPaymentLink(PAID_READING_PLAN);
    if (!link.configured) {
      await setPaidState(memoryId, { ...paid, phone, status: 'paid' });
      return {
        reply: hindi ? 'Bahut badhiya! Hamari team aapko payment link ke saath jaldi contact karegi 🙏' : 'Great! Our team will contact you shortly with the payment link 🙏',
        leadStatus: 'HOT', productInterest: interest, escalate: true,
        escalateReason: `kundli_paid_reading_wanted (no link configured) | Name: ${paid.name || 'not given'} | Phone: ${phone || 'not given'}`,
        customerName: paid.name || '', customerPhone: phone || '',
      };
    }
    await setPaidState(memoryId, { ...paid, phone, status: 'link_sent', linkSentAt: new Date().toISOString() });
    return { reply: paidLinkReply(hindi, link.url), leadStatus: 'WARM', productInterest: interest, escalate: false, escalateReason: '' };
  };

  if (paid.status === 'link_sent') {
    if (!PAID_DONE.test(text)) return null; // anything else -> normal flow
    await setPaidState(memoryId, { ...paid, status: 'paid', paidAt: new Date().toISOString() });
    return {
      reply: hindi
        ? 'Dhanyavaad! 🙏 Aapka payment note kar liya hai. Hamare astrologer aapse jaldi contact karenge aur aapki detailed Kundli taiyaar karenge.'
        : "Thank you! 🙏 Your payment is noted. Our astrologer will contact you shortly and prepare your detailed Kundli.",
      leadStatus: 'HOT', productInterest: interest, escalate: true,
      escalateReason: `PAID kundli consultation Rs ${PAID_READING_PRICE} - PRIORITY, please verify payment | Name: ${paid.name || 'not given'} | Phone: ${paid.phone || currentPhone || 'not given'} | DOB: ${paid.dob || ''} | Place: ${paid.place || ''} | Purpose: ${paid.purpose || ''}`,
      customerName: paid.name || '', customerPhone: paid.phone || currentPhone || '',
    };
  }

  if (paid.status === 'need_phone') {
    const digits = text.replace(/[\s-]/g, '').match(/\+?\d{10,13}/);
    if (digits) return sendLink(digits[0]);
    await setPaidState(memoryId, { ...paid, status: 'declined' });
    return null;
  }

  // status === 'pitched'
  if (PAID_YES.test(text) && !PAID_NO.test(text)) {
    const phone = paid.phone || currentPhone;
    if (phone) return sendLink(phone);
    await setPaidState(memoryId, { ...paid, status: 'need_phone' });
    return {
      reply: hindi
        ? `Bahut badhiya! Apna WhatsApp number share kar dijiye, main aapko link bhej deti hoon. (Ya seedha ${MANNAT_WHATSAPP} par "INSTA" likh kar WhatsApp karein.)`
        : `Great! Please share your WhatsApp number and I'll send you the link. (Or WhatsApp "INSTA" to ${MANNAT_WHATSAPP}.)`,
      leadStatus: 'WARM', productInterest: interest, escalate: false, escalateReason: '',
    };
  }
  if (PAID_NO.test(text)) {
    await setPaidState(memoryId, { ...paid, status: 'declined' });
    return {
      reply: hindi
        ? 'Koi baat nahi 🙏 Stone ya Rudraksha ke baare mein kuch bhi poochna ho toh main yahin hoon.'
        : "No problem at all 🙏 I'm here if you have any questions about a stone or Rudraksha.",
      leadStatus: 'WARM', productInterest: interest + ' (declined)', escalate: false, escalateReason: '',
    };
  }
  // Something else (a new question) - stop waiting for an answer, carry on.
  await setPaidState(memoryId, { ...paid, status: 'declined' });
  return null;
}

module.exports = { maybeHandleKundliTurn, _internal: { gemNamedIn, sameGem, approxBirthTime, PREDICTION_ASK, BUDGET_OR_SIZE, PRODUCT_REQUEST, CALL_REQUEST, ASKS_NAME, SHORT_YES, REGION_ONLY, looksLikeBirthDetails } };
