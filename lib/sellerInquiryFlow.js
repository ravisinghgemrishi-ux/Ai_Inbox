/**
 * Mannat AI 2.0 - the seller / manufacturer inquiry flow.
 *
 * Handles the case where someone messaging GemRishi is NOT a customer buying
 * a product, but a seller/manufacturer/supplier offering to sell gemstones,
 * Rudraksha, or raw material/stock to GemRishi. Ravi's explicit instruction
 * (2026-09-24): before forwarding this to the team, collect City, Name, and
 * phone Number (in that order) so Neel can call them back - then notify
 * Sameer and Neel by email (and Telegram, alongside every other escalation).
 *
 * SAFETY / ISOLATION (read this before changing anything below):
 *   - Separate, additive branch from kundliFlow.js / consultationFlow.js.
 *     Checked FIRST in api/webhook.js's dispatch chain (before those two),
 *     since a seller message could otherwise be mis-read as a customer
 *     asking about buying/consultation.
 *   - LIVE BY DEFAULT, same convention as consultationFlow.js - set
 *     ENABLE_SELLER_INQUIRY_FLOW=false in Vercel only if you ever need to
 *     switch it off without a code change.
 *   - Only DMs/WhatsApp messages can enter this flow (never public
 *     comments) - collecting a phone number in a public comment thread
 *     would be both a bad experience and a privacy problem.
 *   - Produces the exact same {reply, leadStatus, productInterest, escalate,
 *     escalateReason} shape the other flows produce, PLUS category,
 *     customerName, customerPhone, customerCity - the extra fields
 *     lib/escalationNotifier.js uses to route this to Sameer + Neel by email
 *     (instead of the general Mannat Chawla inbox) and to surface contact
 *     details in every channel.
 *
 * STATE: kept in Redis (same pattern/TTL as the other flows), one JSON blob
 * per conversation, short-lived so an abandoned flow doesn't linger.
 */

const { BRAND_VOICE, detectReplyLanguageNote } = require('./knowledgeBase');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days - abandoned flows expire, don't linger

const CANCEL_WORDS = /\b(cancel|never ?mind|not now|skip this|chodo|rehne do|baad mein|stop)\b/i;

// ---------------------------------------------------------------- Redis ---
// (same helper shape as the other flow files, kept local/independent on
// purpose so this file has zero dependency on them.)

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
  return `gemrishi:seller-session:${memoryId}`;
}

async function getSession(memoryId) {
  try {
    const data = await redisCommand(`/get/${encodeURIComponent(sessionKey(memoryId))}`);
    return data?.result ? JSON.parse(data.result) : null;
  } catch (err) {
    console.error('[sellerInquiryFlow] session read failed:', err.message);
    return null;
  }
}

async function setSession(memoryId, state) {
  try {
    const payload = encodeURIComponent(JSON.stringify(state));
    await redisCommand(`/set/${encodeURIComponent(sessionKey(memoryId))}/${payload}/EX/${SESSION_TTL_SECONDS}`);
  } catch (err) {
    console.error('[sellerInquiryFlow] session write failed:', err.message);
  }
}

async function clearSession(memoryId) {
  try { await redisCommand(`/del/${encodeURIComponent(sessionKey(memoryId))}`); }
  catch (err) { console.error('[sellerInquiryFlow] session clear failed:', err.message); }
}

// ---------------------------------------------------------------- Gemini --

async function callGemini({ systemInstruction, userText, schema, maxOutputTokens = 300 }) {
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
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned no response text');
  return JSON.parse(raw);
}

const CONTACT_SCHEMA = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'the city they are messaging/operating from, only if confidently stated in this message' },
    name: { type: 'string', description: "the person's name, only if confidently stated in this message" },
    phone: { type: 'string', description: 'a phone number, digits only (keep a leading country code if given), only if confidently parsed from this message' },
  },
  required: ['city', 'name', 'phone'],
};

// Extracts ONLY what the person explicitly stated in this message - never
// invents or carries forward a value; merging with prior slots is the
// caller's job.
async function extractContact(message, alreadyHave) {
  const systemInstruction = `You extract a city, name, and phone number from a single WhatsApp/Instagram message from someone offering to sell gemstones/Rudraksha/raw material to GemRishi (a seller/manufacturer/supplier inquiry, not a customer). They have already given: ${alreadyHave}. Only fill a field if THIS message clearly states it - leave it as an empty string if it isn't in this message. A phone number should be digits only (spaces/dashes stripped), keeping a leading country code if given. Never guess or invent a name/city from a greeting or brand name.`;
  try {
    const result = await callGemini({ systemInstruction, userText: message, schema: CONTACT_SCHEMA, maxOutputTokens: 150 });
    return {
      city: String(result?.city || '').trim(),
      name: String(result?.name || '').trim(),
      phone: /^\+?\d{7,15}$/.test(String(result?.phone || '').replace(/[\s-]/g, '')) ? String(result.phone).replace(/[\s-]/g, '') : '',
    };
  } catch (err) {
    console.error('[sellerInquiryFlow] contact extraction failed:', err.message);
    return { city: '', name: '', phone: '' };
  }
}

const REPLY_SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };

async function generateStageReply({ instruction, contextSummary, languageNote = '' }) {
  const systemInstruction = `${BRAND_VOICE}\n\n--- SELLER/MANUFACTURER INQUIRY CONTEXT ---\n${contextSummary}\n\n--- WHAT TO DO THIS TURN ---\n${instruction}\n\nThis person is NOT a customer buying a product - they are offering to sell gemstones/Rudraksha/raw material/stock to GemRishi. Do not pitch them GemRishi's own products, prices, or consultation plans. Keep this short, warm, and professional - collect what's needed so the sourcing team can call them back.${languageNote ? `\n\n${languageNote}` : ''}\n\nStay in character as Mannat. Match the person's language (English/Hindi/Hinglish) based on how they've been writing.`;
  try {
    const result = await callGemini({ systemInstruction, userText: '(generate the next message now)', schema: REPLY_SCHEMA, maxOutputTokens: 300 });
    return String(result?.reply || '').trim();
  } catch (err) {
    console.error('[sellerInquiryFlow] reply generation failed:', err.message);
    return '';
  }
}

// ---------------------------------------------------------- Slot filling --

// Order matters here per Ravi's explicit instruction: City, Name, then Number.
const REQUIRED_SLOTS = ['city', 'name', 'phone'];
function missingSlots(slots) {
  return REQUIRED_SLOTS.filter((key) => !slots[key]);
}
const SLOT_LABELS = {
  city: 'which city they are in / operating from',
  name: 'their name',
  phone: 'a contact phone number (so Neel can call them back)',
};

// ------------------------------------------------------------ Main entry --

/**
 * @returns {Promise<null|{reply: string, leadStatus: string, productInterest: string, escalate: boolean, escalateReason: string, category: string, customerName: string, customerPhone: string, customerCity: string}>}
 *   null means "not applicable" - caller should fall back to the normal flow.
 */
async function maybeHandleSellerInquiry({ enabled, type, memoryId, message, intent, existingMemory = '' }) {
  if (!enabled) return null;
  if (type === 'comment') return null; // never collect a phone number in public

  let state = await getSession(memoryId);
  const isFreshStart = !state;

  if (isFreshStart && intent?.intent !== 'seller_inquiry') return null;

  if (CANCEL_WORDS.test(message) && state) {
    await clearSession(memoryId);
    return {
      reply: 'Bilkul, koi baat nahi! Jab bhi aap details share karna chahein, main yahin hoon. - Mannat',
      leadStatus: 'WARM', productInterest: 'Seller/Manufacturer Inquiry (paused)', escalate: false, escalateReason: '',
      category: 'seller', customerName: '', customerPhone: '', customerCity: '',
    };
  }

  const languageNote = detectReplyLanguageNote(message, existingMemory);

  if (!state) {
    state = { stage: 'collecting', slots: { city: '', name: '', phone: '' }, createdAt: new Date().toISOString() };
    // Don't ask again for anything already given earlier in this same
    // conversation, before this flow ever started.
    if (existingMemory) {
      const prefill = await extractContact(existingMemory, 'nothing yet');
      for (const key of REQUIRED_SLOTS) if (prefill[key]) state.slots[key] = prefill[key];
    }
  }

  try {
    return await handleCollecting(memoryId, state, message, languageNote);
  } catch (err) {
    console.error('[sellerInquiryFlow] unexpected error, escalating with what we have:', err.message);
    await clearSession(memoryId);
    return {
      reply: 'Isme thodi technical dikkat aa rahi hai - koi baat nahi, main aapki details humari sourcing team ko bhej rahi hoon, wo aapse jaldi contact karenge. - Mannat',
      leadStatus: 'HOT', productInterest: 'Seller/Manufacturer Inquiry', escalate: true,
      escalateReason: 'seller_inquiry_flow_error',
      category: 'seller', customerName: state?.slots?.name || '', customerPhone: state?.slots?.phone || '', customerCity: state?.slots?.city || '',
    };
  }
}

async function handleCollecting(memoryId, state, message, languageNote = '') {
  const known = REQUIRED_SLOTS.filter((k) => state.slots[k]).map((k) => `${k}: ${state.slots[k]}`).join(', ') || 'nothing yet';
  const extracted = await extractContact(message, known);
  const slots = { ...state.slots };
  for (const key of REQUIRED_SLOTS) if (extracted[key]) slots[key] = extracted[key];
  state.slots = slots;

  const missing = missingSlots(slots);
  if (missing.length > 0) {
    const reply = await generateStageReply({
      contextSummary: `Someone has reached out wanting to sell gemstones/Rudraksha/raw material/stock to GemRishi. Already have: ${REQUIRED_SLOTS.filter((k) => slots[k]).map((k) => `${k}=${slots[k]}`).join(', ') || 'nothing yet'}.`,
      instruction: `Thank them for reaching out, and ask naturally for ${SLOT_LABELS[missing[0]]}${missing.length > 1 ? ` (you'll ask for the rest after)` : ''} so our sourcing team (Neel) can connect back with them. If they just gave you something, briefly acknowledge it first. Ask for ONE thing at a time, don't dump a form. Don't ask again for anything already listed under "Already have".`,
      languageNote,
    });
    await setSession(memoryId, state);
    return {
      reply: reply || `Dhanyavaad! Kya aap apna ${SLOT_LABELS[missing[0]]} bata sakte hain? - Mannat`,
      leadStatus: 'HOT', productInterest: 'Seller/Manufacturer Inquiry', escalate: false, escalateReason: '',
      category: 'seller', customerName: slots.name, customerPhone: slots.phone, customerCity: slots.city,
    };
  }

  // All three collected - hand off to Sameer + Neel.
  const caseFile = [
    'Seller/Manufacturer inquiry',
    `City: ${slots.city}`,
    `Name: ${slots.name}`,
    `Phone: ${slots.phone}`,
    `Customer's message: ${message}`,
  ].join(' | ');

  await clearSession(memoryId);

  const reply = await generateStageReply({
    contextSummary: `Just collected city (${slots.city}), name (${slots.name}), and phone (${slots.phone}) from someone offering to sell to GemRishi.`,
    instruction: 'Thank them warmly and let them know Neel from the sourcing team will call them back shortly to discuss further.',
    languageNote,
  });

  return {
    reply: reply || `Dhanyavaad ${slots.name} ji! Humari sourcing team (Neel) aapko jald hi call karegi. - Mannat`,
    leadStatus: 'HOT', productInterest: 'Seller/Manufacturer Inquiry', escalate: true, escalateReason: caseFile,
    category: 'seller', customerName: slots.name, customerPhone: slots.phone, customerCity: slots.city,
  };
}

module.exports = { maybeHandleSellerInquiry };
