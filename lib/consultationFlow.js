/**
 * Mannat AI 2.0 - the astrologer-consultation PAYMENT flow.
 *
 * Handles the "I want to pay for the Rs X consultation plan" journey in
 * the normal (non-Kundli) chat: collect the customer's name + phone number
 * FIRST, then share that plan's real payment link (from lib/paymentLinks.js),
 * then ask for a screenshot/receipt once they've paid so the team can
 * confirm and follow up either way.
 *
 * SAFETY / ISOLATION (read this before changing anything below):
 *   - This is a separate, additive branch from lib/kundliFlow.js. It does
 *     NOT touch that module, and Kundli staying OFF (ENABLE_KUNDLI_FLOW
 *     unset) has zero effect on this flow - the two are independent.
 *   - LIVE BY DEFAULT - unlike the Kundli flow, this does not need a new
 *     Vercel setting to work. Set ENABLE_CONSULTATION_PAYMENT_FLOW=false in
 *     Vercel only if you ever need to switch it off without a code change.
 *   - Only DMs/WhatsApp messages can enter this flow (never public
 *     comments) - collecting a phone number in a public comment thread
 *     would be both a bad experience and a privacy problem.
 *   - Only starts when the customer's message names a specific paid plan
 *     price (199 / 499 / 1,199 / 2,999 / 4,999) together with buying
 *     language - a general "tell me about your consultation plans"
 *     question is left untouched and gets the normal reply.
 *   - NEVER shares the payment link before both name and phone are
 *     collected (Ravi's explicit instruction, 2026-09-23).
 *   - Produces the exact same {reply, leadStatus, productInterest,
 *     escalate, escalateReason} shape replyEngine.generateReply() and
 *     kundliFlow.maybeHandleKundliTurn() produce, so webhook.js's existing
 *     logLead()/notifyEscalation() calls need no changes at all.
 *
 * STATE: kept in Redis (same pattern/TTL as kundliFlow.js), one JSON blob
 * per conversation, short-lived so an abandoned flow doesn't linger.
 */

const { BRAND_VOICE, CONSULTATION_PLAN_NOTES, detectReplyLanguageNote, detectPlanQuestionNote, looksHinglishOrHindi } = require('./knowledgeBase');
const { getConsultationPaymentLink } = require('./paymentLinks');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days - abandoned flows expire, don't linger

const CANCEL_WORDS = /\b(cancel|never ?mind|not now|skip this|chodo|rehne do|baad mein|stop)\b/i;
const PAID_WORDS = /\b(paid|payment done|payment complete|payment successful|sent (the )?(payment|receipt|screenshot)|receipt attached|done kar diya|maine kar diya|kar diya hai|bhej diya|maine pay|payment kar diya|paisa bhej diya)\b/i;

// ---------------------------------------------------------------- Redis ---
// (same helper shape as kundliFlow.js, kept local/independent on purpose so
// this file has zero dependency on that module.)

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
  return `gemrishi:consultation-session:${memoryId}`;
}

async function getSession(memoryId) {
  try {
    const data = await redisCommand(`/get/${encodeURIComponent(sessionKey(memoryId))}`);
    return data?.result ? JSON.parse(data.result) : null;
  } catch (err) {
    console.error('[consultationFlow] session read failed:', err.message);
    return null;
  }
}

async function setSession(memoryId, state) {
  try {
    const payload = encodeURIComponent(JSON.stringify(state));
    await redisCommand(`/set/${encodeURIComponent(sessionKey(memoryId))}/${payload}/EX/${SESSION_TTL_SECONDS}`);
  } catch (err) {
    console.error('[consultationFlow] session write failed:', err.message);
  }
}

async function clearSession(memoryId) {
  try { await redisCommand(`/del/${encodeURIComponent(sessionKey(memoryId))}`); }
  catch (err) { console.error('[consultationFlow] session clear failed:', err.message); }
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
    name: { type: 'string', description: "the customer's name, only if confidently stated in this message" },
    phone: { type: 'string', description: 'a phone number, digits only (keep a leading country code if given), only if confidently parsed from this message' },
  },
  required: ['name', 'phone'],
};

// Extracts ONLY what the customer explicitly stated in this message - never
// invents or carries forward a value; merging with prior slots is the
// caller's job.
async function extractContact(message, alreadyHave) {
  const systemInstruction = `You extract a customer's name and phone number from a single WhatsApp/Instagram message about paying for a consultation plan. They have already given: ${alreadyHave}. Only fill a field if THIS message clearly states it - leave it as an empty string if it isn't in this message. A phone number should be digits only (spaces/dashes stripped), keeping a leading country code if the customer gave one. Never guess or invent a name from a greeting, sign-off, or brand name.`;
  try {
    const result = await callGemini({ systemInstruction, userText: message, schema: CONTACT_SCHEMA, maxOutputTokens: 150 });
    return {
      name: String(result?.name || '').trim(),
      phone: /^\+?\d{7,15}$/.test(String(result?.phone || '').replace(/[\s-]/g, '')) ? String(result.phone).replace(/[\s-]/g, '') : '',
    };
  } catch (err) {
    console.error('[consultationFlow] contact extraction failed:', err.message);
    return { name: '', phone: '' };
  }
}

const REPLY_SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };

async function generateStageReply({ instruction, contextSummary, languageNote = '', planQuestionNote = '' }) {
  const systemInstruction = `${BRAND_VOICE}\n\n--- CONSULTATION PLAN NOTES ---\n${CONSULTATION_PLAN_NOTES}\n\n--- CONSULTATION PAYMENT FLOW CONTEXT ---\n${contextSummary}\n\n--- WHAT TO DO THIS TURN ---${planQuestionNote ? `\n${planQuestionNote}\n` : ''}\n${instruction}\n\nIf the customer's message also asked something else this turn (a question about pricing, what's included, authenticity, timelines, etc.), answer that briefly first, then continue with what this turn needs. Never silently ignore a direct question just to keep the flow moving.${languageNote ? `\n\n${languageNote}` : ''}\n\nStay in character as Mannat. Match the customer's language (English/Hindi/Hinglish) based on how they've been writing. Keep it warm and conversational, not like a form.`;
  try {
    const result = await callGemini({ systemInstruction, userText: '(generate the next message now)', schema: REPLY_SCHEMA, maxOutputTokens: 400 });
    return String(result?.reply || '').trim();
  } catch (err) {
    console.error('[consultationFlow] reply generation failed:', err.message);
    return '';
  }
}

// ------------------------------------------------------------ Plan match --

// Ordered longest-amount-first so "1,199" is never mis-matched by the bare
// "199" that sits inside it. Handles both digit-grouped ("1,199") and plain
// ("1199") forms.
const PLAN_PATTERNS = [
  { key: 'consultation_4999', re: /4[,.]?999/ },
  { key: 'consultation_2999', re: /2[,.]?999/ },
  { key: 'consultation_1199', re: /1[,.]?199/ },
  { key: 'consultation_499', re: /\b499\b/ },
  { key: 'consultation_199', re: /\b199\b/ },
];

function detectPlanKey(message) {
  const text = String(message || '');
  for (const { key, re } of PLAN_PATTERNS) {
    if (re.test(text)) return key;
  }
  return null;
}

const PAY_INTENT_WORDS = /\b(pay|payment|proceed|confirm|book|buy|purchase|link bhejo|link send|send.*link|ready|chahiye|kar do|karwa do|lena hai|le loon|le lo|interested)\b/i;

// Exported for kundliFlow.js (2026-09-23 fix): the free Kundli flow needs to
// recognise, using the exact same rule this flow uses to decide whether to
// start, when a customer's message clearly signals switching to a paid plan
// - so it can yield instead of swallowing the message. Single source of
// truth here avoids the two files' detection logic drifting apart.
function looksLikePaidPlanSwitch(message) {
  return Boolean(detectPlanKey(message)) && PAY_INTENT_WORDS.test(String(message || ''));
}

// ------------------------------------------------------------ Main entry --

/**
 * @returns {Promise<null|{reply: string, leadStatus: string, productInterest: string, escalate: boolean, escalateReason: string}>}
 *   null means "not applicable" - caller should fall back to the normal reply flow.
 */
async function maybeHandleConsultationPayment({ enabled, type, memoryId, message, intent, existingMemory = '' }) {
  if (!enabled) return null;
  if (type === 'comment') return null; // never collect a phone number in public

  let state = await getSession(memoryId);

  if (!state) {
    // Only start when the message clearly names a specific paid plan AND
    // reads like buying language - a general plan-info question is left
    // untouched so it still gets the normal catalogue reply.
    const planKey = detectPlanKey(message);
    if (!planKey) return null;
    // Deliberately NOT triggered by intent === 'consultation' alone - a
    // message like "tell me about the 499 consultation plan" contains the
    // word "consultation" but is an info question, not buying language.
    const looksLikeBuying = PAY_INTENT_WORDS.test(message) || intent?.intent === 'purchase';
    if (!looksLikeBuying) return null;

    const plan = getConsultationPaymentLink(planKey);
    if (!plan.configured) return null; // safety net: never proceed without a real configured link

    state = { stage: 'collecting_contact', planKey, planLabel: plan.label, slots: { name: '', phone: '' }, createdAt: new Date().toISOString() };

    // Fix (2026-09-23, Ravi): don't ask for name/phone again if the customer
    // already gave them earlier in this same conversation, before this
    // payment flow ever started - pre-fill from the recent conversation
    // history the same way a human rep would remember it.
    if (existingMemory) {
      const prefill = await extractContact(existingMemory, 'nothing yet');
      if (prefill.name) state.slots.name = prefill.name;
      if (prefill.phone) state.slots.phone = prefill.phone;
    }
  }

  if (CANCEL_WORDS.test(message)) {
    await clearSession(memoryId);
    return {
      // Fix (2026-09-24, Ravi): language-matched, was hardcoded Hindi/Hinglish before.
      reply: looksHinglishOrHindi(message)
        ? 'Bilkul, koi baat nahi! Jab bhi aap consultation plan ke liye ready hon, bata dijiyega. - Mannat'
        : "No problem at all! Whenever you're ready for the consultation plan, just let me know. - Mannat",
      leadStatus: 'WARM', productInterest: state.planLabel || 'Consultation', escalate: false, escalateReason: '',
    };
  }

  const languageNote = detectReplyLanguageNote(message, existingMemory);
  const planQuestionNote = detectPlanQuestionNote(message);

  try {
    if (state.stage === 'collecting_contact') return await handleCollectingContact(memoryId, state, message, languageNote, planQuestionNote);
    if (state.stage === 'awaiting_receipt') return await handleAwaitingReceipt(memoryId, state, message, languageNote, planQuestionNote);
  } catch (err) {
    console.error('[consultationFlow] unexpected error, escalating with what we have:', err.message);
    await clearSession(memoryId);
    return {
      reply: looksHinglishOrHindi(message)
        ? 'Isme thodi technical dikkat aa rahi hai - koi baat nahi, main is conversation ko humari team se connect kar rahi hoon taaki wo aapki payment/consultation personally sort kar sakein. - Mannat'
        : "There's a small technical hiccup on my end - no worries, I'm connecting this conversation with our team so they can personally sort out your payment/consultation. - Mannat",
      leadStatus: 'HOT', productInterest: state.planLabel || 'Consultation', escalate: true, escalateReason: `consultation_flow_error | plan=${state.planKey || 'unknown'}`,
      customerName: state?.slots?.name || '', customerPhone: state?.slots?.phone || '',
    };
  }

  // Unknown/stale stage - don't get stuck, hand back to the normal flow.
  await clearSession(memoryId);
  return null;
}

async function handleCollectingContact(memoryId, state, message, languageNote = '', planQuestionNote = '') {
  const known = ['name', 'phone'].filter((k) => state.slots[k]).map((k) => `${k}: ${state.slots[k]}`).join(', ') || 'nothing yet';
  const extracted = await extractContact(message, known);
  state.slots.name = state.slots.name || extracted.name;
  state.slots.phone = state.slots.phone || extracted.phone;

  if (state.slots.name && state.slots.phone) {
    const plan = getConsultationPaymentLink(state.planKey);
    const caseFile = [
      'Consultation payment - link shared',
      `Name: ${state.slots.name}`,
      `Phone: ${state.slots.phone}`,
      `Plan: ${state.planLabel}`,
      `Link sent: ${plan.url}`,
    ].join(' | ');

    state.stage = 'awaiting_receipt';
    await setSession(memoryId, state);

    const reply = await generateStageReply({
      contextSummary: `Customer wants the ${state.planLabel} and has now given their name (${state.slots.name}) and phone (${state.slots.phone}).\n\nPayment link: ${plan.url}`,
      instruction: 'Thank them warmly, confirm the plan name and price, share the payment link exactly as given (do not alter it), and ask them to share a screenshot/receipt here once they have paid so the team can confirm and follow up.',
      languageNote,
      planQuestionNote,
    });

    return {
      reply: reply || (looksHinglishOrHindi(message)
        ? `Thank you! Aapka ${state.planLabel} ka payment link yeh raha: ${plan.url}\nPayment ke baad receipt/screenshot yahin share kar dijiyega. - Mannat`
        : `Thank you! Here's your payment link for the ${state.planLabel}: ${plan.url}\nOnce you've paid, please share the receipt/screenshot here. - Mannat`),
      leadStatus: 'HOT', productInterest: state.planLabel, escalate: false, escalateReason: caseFile,
    };
  }

  await setSession(memoryId, state);
  const missing = !state.slots.name && !state.slots.phone ? 'their name and a contact phone number' : !state.slots.name ? 'their name' : 'a contact phone number';
  const reply = await generateStageReply({
    contextSummary: `Customer wants to pay for the ${state.planLabel}. Before sharing the payment link, we still need ${missing}.`,
    instruction: `Ask warmly for ${missing} so the team can follow up either way (whether or not the payment goes through). Do not share any link yet.`,
    languageNote,
    planQuestionNote,
  });

  return {
    reply: reply || (looksHinglishOrHindi(message)
      ? `Bilkul! Payment link bhejne se pehle please apna naam aur contact number share kar dijiye, taaki team follow up kar sake. - Mannat`
      : `Sure! Before I send the payment link, could you please share your name and a contact number so the team can follow up? - Mannat`),
    leadStatus: 'HOT', productInterest: state.planLabel, escalate: false, escalateReason: '',
  };
}

async function handleAwaitingReceipt(memoryId, state, message, languageNote = '', planQuestionNote = '') {
  const plan = getConsultationPaymentLink(state.planKey);
  const paidNote = PAID_WORDS.test(message) ? 'Customer indicates payment is done.' : 'Customer replied after receiving the link (payment not explicitly confirmed in words - please verify).';
  const caseFile = [
    'Consultation payment - follow-up',
    `Name: ${state.slots.name}`,
    `Phone: ${state.slots.phone}`,
    `Plan: ${state.planLabel}`,
    `Link sent: ${plan.url || 'n/a'}`,
    paidNote,
    `Customer's message: ${message}`,
  ].join(' | ');

  // One follow-up turn is enough to log/escalate this - clear so the
  // conversation doesn't stay stuck in this flow for every message after.
  await clearSession(memoryId);

  const reply = await generateStageReply({
    contextSummary: `Customer already has the ${state.planLabel} payment link and just replied: "${message}".`,
    instruction: 'Thank them warmly and let them know the team will confirm the payment and reach out shortly to get started. Do not ask for the receipt again if they already said they have paid - just acknowledge.',
    languageNote,
    planQuestionNote,
  });

  return {
    reply: reply || (looksHinglishOrHindi(message)
      ? `Thank you! Humari team payment confirm karke aapko jald hi contact karegi. - Mannat`
      : `Thank you! Our team will confirm the payment and reach out to you shortly. - Mannat`),
    leadStatus: 'HOT', productInterest: state.planLabel, escalate: true, escalateReason: caseFile,
    customerName: state.slots.name || '', customerPhone: state.slots.phone || '',
  };
}

module.exports = { maybeHandleConsultationPayment, looksLikePaidPlanSwitch };
