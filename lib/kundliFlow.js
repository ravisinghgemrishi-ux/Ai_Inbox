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
const { buildProductPageLink } = require('./paymentLinks');
const { looksLikePaidPlanSwitch } = require('./consultationFlow');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days - abandoned flows expire, don't linger

const CANCEL_WORDS = /\b(cancel|never ?mind|not now|skip this|chodo|rehne do|baad mein|stop)\b/i;

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
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

const REPLY_SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
};

async function generateStageReply({ instruction, contextSummary, languageNote = '', planQuestionNote = '' }) {
  const systemInstruction = `${BRAND_VOICE}\n\n--- CONSULTATION PLAN NOTES (for context if the customer asks about paid plans) ---\n${CONSULTATION_PLAN_NOTES}\n\n--- KUNDLI FLOW CONTEXT ---\n${contextSummary}\n\n--- WHAT TO DO THIS TURN ---${planQuestionNote ? `\n${planQuestionNote}\n` : ''}\n${instruction}\n\nIf the customer's message also asked something else this turn (pricing, what's included in a paid plan, the difference between free and paid, authenticity, timelines, etc.), answer that briefly first using the notes above, then continue with what this turn needs. Never silently ignore a direct question just to keep collecting details.${languageNote ? `\n\n${languageNote}` : ''}\n\nStay in character as Mannat. Match the customer's language (English/Hindi/Hinglish) based on how they've been writing. Keep it warm and conversational, not like a form.`;
  try {
    const result = await callGemini({ systemInstruction, userText: '(generate the next message now)', schema: REPLY_SCHEMA, maxOutputTokens: 500 });
    return String(result?.reply || '').trim();
  } catch (err) {
    console.error('[kundliFlow] reply generation failed:', err.message);
    return '';
  }
}

// ---------------------------------------------------------- Slot filling --

const REQUIRED_SLOTS = ['name', 'date', 'time', 'place', 'purpose', 'phone'];
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
async function maybeHandleKundliTurn({ enabled, type, memoryId, message, intent, existingMemory = '' }) {
  if (!enabled) return null;
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
  const isGemstonePurchaseAsk = intent?.intent === 'purchase' && GEMSTONE_NAME_PATTERN.test(message);
  if (isFreshStart && intent?.intent !== 'consultation' && intent?.intent !== 'personal_problem' && intent?.intent !== 'recommendation' && !isGemstonePurchaseAsk) return null;

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
      for (const key of REQUIRED_SLOTS) if (prefill[key]) state.slots[key] = prefill[key];
    }

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
  const known = REQUIRED_SLOTS.filter((k) => state.slots[k]).map((k) => `${k}: ${state.slots[k]}`).join(', ') || 'nothing yet';
  const extracted = await extractSlots(message, known);
  const slots = { ...state.slots };
  for (const key of REQUIRED_SLOTS) if (extracted[key]) slots[key] = extracted[key];
  state.slots = slots;

  const missing = missingSlots(slots);
  if (missing.length > 0) {
    const reply = await generateStageReply({
      contextSummary: `Collecting birth details for a Kundli reading before recommending a gemstone or Rudraksha. Already have: ${REQUIRED_SLOTS.filter((k) => slots[k]).map((k) => `${k}=${slots[k]}`).join(', ') || 'nothing yet'}.`,
      instruction: `Ask naturally for ${SLOT_LABELS[missing[0]]}${missing.length > 1 ? ` (you'll ask for the rest after)` : ''}. If they just gave you something, briefly acknowledge it first. Ask for ONE thing at a time, don't dump a form. If a detail (like their name) already appears above under "Already have", don't ask for it again.`,
      languageNote,
      planQuestionNote,
    });
    await setSession(memoryId, state);
    return {
      reply: reply || (looksHinglishOrHindi(message)
        ? `Aap apna ${SLOT_LABELS[missing[0]]} bata sakte hain? - Mannat`
        : `Could you share your ${SLOT_LABELS[missing[0]]}? - Mannat`),
      leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
    };
  }

  // All slots present - generate the chart.
  const engineResult = await getKundliReading(state.slots);
  if (!engineResult.success) {
    await clearSession(memoryId);
    return {
      reply: looksHinglishOrHindi(message)
        ? 'Aapki details mil gayi, dhanyavaad! Kundli generate karte waqt thodi technical dikkat aa rahi hai, toh main aapki details humari astrology team ko bhej rahi hoon - wo aapse jaldi hi Kundli aur recommendation ke saath contact karenge. - Mannat'
        : "Got your details, thank you! There's a small technical hiccup generating the Kundli, so I'm passing your details to our astrology team - they'll contact you shortly with your Kundli and recommendation. - Mannat",
      leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: true, escalateReason: 'kundli_engine_unavailable',
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

  const reply = await generateStageReply({
    contextSummary: `Just generated the customer's Kundli. Purpose they gave: "${state.slots.purpose}". Current Mahadasha lord: ${activeDasha?.lord || 'unavailable'}.`,
    instruction: `Explain briefly and warmly what their current planetary period (Mahadasha lord: ${activeDasha?.lord || 'unavailable'}) traditionally means in relation to what they asked about ("${state.slots.purpose}") - as tradition, never as a guarantee or medical/outcome claim. Then ask: would they like a gemstone recommendation, or a Rudraksha recommendation, based on this.`,
    languageNote,
    planQuestionNote,
  });
  return {
    reply: reply || (looksHinglishOrHindi(message)
      ? `Aapki Kundli ready hai! Aapke current Mahadasha lord ${activeDasha?.lord || 'abhi calculate ho raha hai'} hain. Kya aap gemstone recommendation chahenge ya Rudraksha? - Mannat`
      : `Your Kundli is ready! Your current Mahadasha lord is ${activeDasha?.lord || 'still being calculated'}. Would you like a gemstone recommendation or a Rudraksha one? - Mannat`),
    leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
  };
}

const UNSURE_WORDS = /\b(not sure|dont know|don't know|no idea|confus|pata nahi|kuch bhi|aap hi bata|you decide|suggest you|recommend you)\b/i;
const BUDGET_NUMBER = /(\d[\d,]{1,7})/;

async function handleChoosingCategory(memoryId, state, message, languageNote = '') {
  const planQuestionNote = detectPlanQuestionNote(message);
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
      leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '',
    };
  }

  const wantsGemstone = /gem(stone)?|ratna/i.test(message);
  const wantsRudraksha = /rudraksh|mukhi|mala/i.test(message);

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
        : "No worries at all! Could you share what budget you have in mind? That'll help me suggest the right fit for you. - Mannat"), leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '' };
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
      : "Would you like to know more about a gemstone or a Rudraksha? - Mannat"), leadStatus: 'HOT', productInterest: 'Kundli Consultation', escalate: false, escalateReason: '' };
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
  const reply = await generateStageReply({
    contextSummary: `Recommending in the ${category} category. Top pick: ${primaryName} (reasons: ${reasons || 'general fit'}). Relevant catalog notes:\n${catalogNotes}`,
    instruction: `Present ${primaryName} as the top recommendation with a brief, warm reason (never a guarantee). Mention the indicative price range from the catalog notes if listed, framed as indicative and to be confirmed. Then ask if they'd like to go ahead with this one. If it feels natural (don't force it every time), you can also briefly mention that a paid astrologer consultation plan is available too, for a personalised written Kundli and a real call - and offer to explain what's included if they're interested.`,
    languageNote,
    planQuestionNote,
  });
  return {
    reply: reply || (looksHinglishOrHindi(message)
      ? `Aapke liye ${primaryName} sabse suitable lag raha hai! Kya aap iske saath aage badhna chahenge? - Mannat`
      : `${primaryName} looks like the best fit for you! Would you like to go ahead with this one? - Mannat`),
    leadStatus: 'HOT', productInterest: primaryName, escalate: false, escalateReason: '',
  };
}

async function handleBuyDecision(memoryId, state, message, languageNote = '') {
  const planQuestionNote = detectPlanQuestionNote(message);
  const readyToBuy = /\b(yes|haan|ready|buy|confirm|order|le[nl]ooo?|proceed|book)\b/i.test(message);
  const declining = /\b(no|nahi|not now|later)\b/i.test(message);

  if (!readyToBuy || declining) {
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
      : "No rush at all, just let me know whenever you're ready! - Mannat"), leadStatus: declining ? 'WARM' : 'HOT', productInterest: state.category === 'gemstone' ? state.recommendation?.primary?.gem : state.recommendation?.primary?.name, escalate: false, escalateReason: '' };
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
    `Phone: ${state.slots.phone || 'not given'}`,
    `DOB: ${state.slots.date} ${state.slots.time}`,
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
    customerName: state.slots.name || '', customerPhone: state.slots.phone || '',
  };
}

module.exports = { maybeHandleKundliTurn };
