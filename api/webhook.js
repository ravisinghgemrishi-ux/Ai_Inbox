const crypto = require('crypto');
const {
  verifyWebhookSignature,
  replyToComment,
  replyToReview,
  sendTypingIndicator,
  sendConversationMessage,
  listInboxConversations,
  sendPrivateReply,
  messageReplyIdempotencyKey,
} = require('../lib/zernioClient');
const { generateReply } = require('../lib/replyEngine');
const { logLead } = require('../lib/leadLog');
const { classifyIntent, extractProduct } = require('../lib/intentRouter');
const { getMemory, addTurn, formatMemory } = require('../lib/memoryStore');
const { lookupLiveProduct, formatLiveProductData, _internal: productInternals } = require('../lib/productResolver');
const { mergeEscalation } = require('../lib/escalationPolicy');
const { notifyEscalation, notifyHotLead } = require('../lib/escalationNotifier');
const { maybeHandleKundliTurn } = require('../lib/kundliFlow');
const { maybeHandleConsultationPayment } = require('../lib/consultationFlow');
const { maybeHandleSellerInquiry } = require('../lib/sellerInquiryFlow');
const { detectReplyLanguageNote, looksHinglishOrHindi, replyShouldBeHindi } = require('../lib/knowledgeBase');
const { checkHumanTakeover, markAiSent, markAiSentAnyChat, recordOutgoingMessage, isHumanActive } = require('../lib/humanTakeoverGuard');
// Added 2026-09-29 (Ravi): GR Customer ID + Instagram->WhatsApp handoff.
// Inert unless ENABLE_IDENTITY_BRIDGE=true (see lib/crossChannel.js).
const { prepareInbound, addHandoffCta, saveCustomerFacts, handleInviteAnswer, maybeAppendInvite, identityNotes } = require('../lib/crossChannel');
const { handleReview } = require('../lib/reviewHandler');
const { handleTeamMessage, handleAccountEvent } = require('../lib/teamMonitor');
const { getMemory: monitorGetMemory, addTurn: monitorAddTurn } = require('../lib/memoryStore');
const { KNOWLEDGE_BASE } = require('../lib/replyEngine');
const { sendLikeHuman } = require('../lib/humanTyping');
const { collectBurst } = require('../lib/messageBatcher');
// Added 2026-10-04 (Ravi, quality batch): reply guards, one-time handoff,
// Meta form leads.
const guards = require('../lib/conversationGuards');
const handoff = require('../lib/handoff');
const identityBridge = require('../lib/identityBridge');
const salesInterview = require('../lib/salesInterview');
const metaTracking = require('../lib/metaTracking');
const formLead = require('../lib/formLead');
const callWindow = require('../lib/callWindow');
const { recordInstagramLead } = require('../lib/instagramLeads');

// Added 2026-09-29 (Ravi): Zernio was delivering every message twice - it
// gives up waiting after ~15s, and Mannat takes longer than that to write a
// reply, so Zernio retried. Now the webhook answers "received" straight away
// and writes/sends the reply in the background (Vercel's waitUntil keeps the
// function alive until it finishes). The duplicate check still runs BEFORE
// the quick answer, so a retry is still recognised and ignored.
let waitUntil = null;
try { ({ waitUntil } = require('@vercel/functions')); } catch { waitUntil = null; }

module.exports.config = { api: { bodyParser: false } };

function redisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function redisCommand(path, method = 'POST') {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error('Redis credentials are not configured');
  const res = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return res.json().catch(() => ({}));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableInboundKey(event, rawBody) {
  if (event?.comment?.id) return `comment:${event.comment.id}`;
  if (event?.comment?.commentId) return `comment:${event.comment.commentId}`;
  if (event?.message?.id) return `message:${event.message.id}`;
  if (event?.message?.messageId) return `message:${event.message.messageId}`;
  if (event?.id) return `event:${event.id}`;
  if (event?.eventId) return `event:${event.eventId}`;
  if (event?.webhookEventId) return `event:${event.webhookEventId}`;
  return `body:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

async function claimInbound(key, ttlSeconds = 86400) {
  const data = await redisCommand(`/set/${encodeURIComponent(`gemrishi:webhook:${key}`)}/1/EX/${ttlSeconds}/NX`);
  return data?.result === 'OK';
}

async function claimReplySlot(key, processingTtl = 90) {
  const replied = await redisCommand(`/get/${encodeURIComponent(`gemrishi:reply-sent:${key}`)}`);
  if (replied?.result) return { allowed: false, reason: 'already_replied' };
  const processing = await redisCommand(`/set/${encodeURIComponent(`gemrishi:reply-processing:${key}`)}/1/EX/${processingTtl}/NX`);
  if (processing?.result !== 'OK') return { allowed: false, reason: 'already_processing' };
  return { allowed: true, reason: 'claimed' };
}

// Investigated 2026-09-23 (Ravi reported duplicate/conflicting replies to the
// same customer message - see the sheet rows for "Ashad Khan" and the
// "Idempotency-Key was already used with a different request" error on
// gangwarpiyush07). Root cause for the latter: this write is what records
// "this message has already been answered" so a redelivered webhook (which
// is normal, expected behaviour - most platforms retry a webhook that didn't
// respond fast enough) gets recognised as a duplicate and skipped. It used
// to be a single fire-and-forget attempt - if THIS write itself hit a
// transient Redis error right after a successful send, no record was left,
// so a later redelivery of the same message sailed through unrecognised,
// generated a fresh (differently-worded) AI reply, and got rejected by
// Zernio for reusing an idempotency key with different content. Retrying
// this specific write closes that gap.
async function markReplySent(key, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await redisCommand(`/set/${encodeURIComponent(`gemrishi:reply-sent:${key}`)}/1/EX/604800`);
      await redisCommand(`/del/${encodeURIComponent(`gemrishi:reply-processing:${key}`)}`);
      return;
    } catch (err) {
      console.error(`[webhook] markReplySent attempt ${attempt + 1}/${attempts} failed:`, err.message);
      if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
    }
  }
  console.error('[webhook] markReplySent permanently failed after retries; a redelivery of this message may not be recognised as a duplicate:', key);
}

async function releaseReplySlot(key) {
  try { await redisCommand(`/del/${encodeURIComponent(`gemrishi:reply-processing:${key}`)}`); } catch (err) { console.error('[webhook] failed to release reply slot:', err.message); }
}

// Second, independent duplicate guard - catches the OTHER pattern Ravi found
// (three back-to-back messages from "Ashad Khan", same text, each answered
// differently). That case couldn't have been caught by the ID-based checks
// above even if Redis were perfectly reliable, because each delivery
// apparently carried its own distinct message id (three genuinely "new"
// messages, from Zernio/Facebook's point of view) - most likely the
// customer's own client re-sending after a network hiccup. This layer
// doesn't care about message ids at all: if the exact same text arrives for
// the exact same conversation within a short window, it's treated as one
// customer turn, not three. Short TTL on purpose - a customer legitimately
// repeating themselves a minute later still gets a normal reply.
const CONTENT_DEDUP_TTL_SECONDS = 20;

function normalizeForContentDedup(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
}

async function claimContentSlot(scopeId, text) {
  const hash = crypto.createHash('sha256').update(normalizeForContentDedup(text)).digest('hex').slice(0, 24);
  const key = `gemrishi:recent-text:${scopeId}:${hash}`;
  try {
    const data = await redisCommand(`/set/${encodeURIComponent(key)}/1/EX/${CONTENT_DEDUP_TTL_SECONDS}/NX`);
    return data?.result === 'OK';
  } catch (err) {
    console.error('[webhook] content-dedup unavailable; continuing:', err.message);
    return true; // fail open, same philosophy as the rest of this pipeline
  }
}

// Added 2026-09-30 (Ravi): LOOP GUARD. Mannat got stuck in an endless
// bot-to-bot loop with the RBI's official WhatsApp channel (its welcome
// message re-fired after every reply of hers, ~250 replies in 45 min). These
// guards stop Mannat talking to any automated sender, whatever the platform:
//  1. BLOCKED_SENDERS env (comma-separated numbers/handles) - never replied to.
//  2. Same text from the same chat more than 3x in 6h -> stop replying.
//  3. More than 30 messages from one chat in 10 min -> pause that chat 1h.
// Each guard logs ONE sheet row when it trips, then stays silent.
const LOOP_SAME_TEXT_LIMIT = Number(process.env.LOOP_SAME_TEXT_LIMIT || 3);
const LOOP_SAME_TEXT_WINDOW_S = 6 * 3600;
const LOOP_FLOOD_LIMIT = Number(process.env.LOOP_FLOOD_LIMIT || 30);
const LOOP_FLOOD_WINDOW_S = 10 * 60;
const LOOP_PAUSE_S = 3600;

function isBlockedSender(...ids) {
  const list = String(process.env.BLOCKED_SENDERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  for (const raw of ids) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v) continue;
    const digits = v.replace(/\D/g, '');
    if (list.includes(v) || (digits.length >= 8 && list.some((b) => b.replace(/\D/g, '') === digits))) return true;
  }
  return false;
}

async function redisIncrWithTtl(key, ttl) {
  const data = await redisCommand(`/incr/${encodeURIComponent(key)}`);
  const n = Number(data?.result || 0);
  if (n === 1) await redisCommand(`/expire/${encodeURIComponent(key)}/${ttl}`);
  return n;
}

// Returns { stop: false } or { stop: true, firstTrip: bool, reason }.
async function checkLoopGuard(scopeId, text) {
  try {
    const pauseKey = `gemrishi:loop-pause:${scopeId}`;
    const paused = await redisCommand(`/get/${encodeURIComponent(pauseKey)}`);
    if (paused?.result) return { stop: true, firstTrip: false, reason: paused.result };

    const hash = crypto.createHash('sha256').update(normalizeForContentDedup(text)).digest('hex').slice(0, 24);
    const sameCount = await redisIncrWithTtl(`gemrishi:loop-text:${scopeId}:${hash}`, LOOP_SAME_TEXT_WINDOW_S);
    const floodCount = await redisIncrWithTtl(`gemrishi:loop-flood:${scopeId}`, LOOP_FLOOD_WINDOW_S);

    let reason = '';
    if (sameCount > LOOP_SAME_TEXT_LIMIT) reason = `same message repeated ${sameCount}x (likely a bot)`;
    else if (floodCount > LOOP_FLOOD_LIMIT) reason = `${floodCount} messages in 10 min (likely a bot)`;
    if (!reason) return { stop: false };

    // Same-text trips stay silent for that text; floods pause the whole chat.
    const ttl = sameCount > LOOP_SAME_TEXT_LIMIT ? LOOP_SAME_TEXT_WINDOW_S : LOOP_PAUSE_S;
    const set = await redisCommand(`/set/${encodeURIComponent(pauseKey)}/${encodeURIComponent(reason)}/EX/${ttl}/NX`);
    return { stop: true, firstTrip: set?.result === 'OK', reason };
  } catch (err) {
    console.error('[webhook] loop guard unavailable; continuing:', err.message);
    return { stop: false };
  }
}

async function loadContext(scope, id) {
  try { return formatMemory(await getMemory(scope, id)); }
  catch (err) { console.error('[webhook] memory read failed:', err.message); return ''; }
}

async function saveTurn(scope, id, role, text) {
  try { await addTurn(scope, id, { role, text }); }
  catch (err) { console.error('[webhook] memory write failed:', err.message); }
}

// Ravi found real conversations (2026-09-23) where Mannat repeated the
// WhatsApp consultation number in almost every reply of the same
// conversation, unprompted - a habit rather than something the customer
// asked for again. The prompt already says not to do this, but a factual
// flag ("you already gave this") is far more reliable for the model to act
// on than a general "don't overuse it" instruction, so this checks the
// recent-conversation text (which includes Mannat's own past replies, saved
// by saveTurn) for the number and surfaces that plainly.
const WHATSAPP_NUMBER_PATTERN = /98179\s*75978|98179\s*75972/;

// FIX (2026-10-07, Ravi): cheap, deterministic Indian-mobile scan for the
// human-takeover "silence" path below - deliberately NOT the AI-based
// extractContact() in lib/consultationFlow.js, to keep the "a silenced
// conversation costs nothing extra beyond the one Zernio read" promise.
const INDIA_MOBILE_PATTERN = /(?:\+?91[\s-]?)?([6-9]\d{9})\b/;
function extractPhoneFromText(text) {
  const m = String(text || '').match(INDIA_MOBILE_PATTERN);
  return m ? `+91${m[1]}` : '';
}

// FIX (2026-10-07, Ravi): the product lookup used to read ONLY the latest
// message. Real case (shevangisingh26septt): after asking about Sri Lankan
// Neelam, the follow-ups "Price?", "Show me all" and "50k" named no stone, so
// Mannat found nothing (or matched random pendants) and kept saying she would
// "check with the team". If the latest message names no stone/Rudraksha, the
// lookup now also uses the stone (and size) from the most recent message in
// the chat that named one.
function productQueryWithContext(messageText, product, existingMemory) {
  const base = product || messageText;
  // Never let this helper break a reply: if anything is off, search as before.
  try { return addStoneFromChat(base, messageText, existingMemory); }
  catch (err) { console.error('[webhook] product context lookup skipped:', err.message); return base; }
}

function addStoneFromChat(base, messageText, existingMemory) {
  if (typeof productInternals?.parseQuery !== 'function') return base;
  const pq = productInternals.parseQuery(messageText);
  if (pq.stones.length || pq.wantsRudraksha || !existingMemory) return base;
  const lines = String(existingMemory).split(/\n+/).reverse();
  let ratti = pq.ratti; let carat = pq.carat;
  for (const line of lines) {
    const lq = productInternals.parseQuery(line);
    if (!ratti && lq.ratti) ratti = lq.ratti;
    if (!carat && lq.carat) carat = lq.carat;
    if (!lq.stones.length && !lq.wantsRudraksha) continue;
    const bits = [lq.stones.join(' ')];
    if (lq.wantsRudraksha && lq.mukhi) bits.push(`${lq.mukhi} mukhi rudraksha`);
    else if (lq.wantsRudraksha) bits.push('rudraksha');
    if (!pq.ratti && ratti) bits.push(`${ratti} ratti`);
    if (!pq.carat && carat) bits.push(`${carat} carat`);
    return `${bits.filter(Boolean).join(' ')} ${base}`.trim();
  }
  return base;
}

async function buildAIContext(messageText, platform, existingMemory, postCaption = '', type = 'dm') {
  const intent = classifyIntent(messageText);
  const product = extractProduct(messageText);
  const live = await lookupLiveProduct(productQueryWithContext(messageText, product, existingMemory));
  const parts = [
    `INTENT: ${intent.intent} (confidence ${intent.confidence})`,
    product ? `PRODUCT: ${product}` : 'PRODUCT: not explicitly identified',
    existingMemory ? `RECENT CONVERSATION:\n${existingMemory}` : 'RECENT CONVERSATION: none',
  ];
  if (existingMemory && WHATSAPP_NUMBER_PATTERN.test(existingMemory)) {
    parts.push('NOTE: You already shared the WhatsApp consultation number earlier in this conversation - do not paste it again in this reply unless the customer explicitly asks for it a second time.');
  }
  // Fix (2026-09-23, Ravi): found conversations where Mannat drifted from
  // Hinglish into plain English mid-conversation - see knowledgeBase.js's
  // detectReplyLanguageNote for why a deterministic per-turn note is used
  // instead of relying only on the general "match their language" prose.
  const languageNote = detectReplyLanguageNote(messageText, existingMemory, { platform });
  if (languageNote) parts.push(languageNote);
  if (postCaption) parts.push(`POST CONTEXT: ${postCaption}`);
  parts.push(`CONTACT NUMBER: if you give the customer a WhatsApp/phone number to reach GemRishi or for a consultation, give ${contactNumberFor(platform, type)} (and no other number, except a showroom's own number when giving its address).`);
  return { contextText: parts.join('\n\n'), liveProductData: formatLiveProductData(live), intent, product, live };
}

// Best-effort fallback so a general enquiry that escalates (product
// questions, images, prices, "rest everything" the AI can't answer) still
// carries a phone number when one is plainly visible in what the customer
// wrote - without ever blocking on it. Per Ravi's explicit instruction
// (2026-09-24): for this general bucket, send whatever is already known,
// never ask/hold up the handoff waiting for name+phone (that's reserved for
// lib/sellerInquiryFlow.js, which collects City/Name/Phone by design before
// escalating). A structured flow's own customerName/customerPhone (kundli,
// consultation, seller) always takes priority over this regex guess.
const PHONE_FALLBACK_PATTERN = /(\+?\d[\d\s-]{8,14}\d)/;
function extractFallbackPhone(text) {
  const match = String(text || '').match(PHONE_FALLBACK_PATTERN);
  return match ? match[1].replace(/[\s-]/g, '') : '';
}

// Handoff note - added 2026-09-24 (Ravi); extended same day after Ravi's
// live-test review of the general-escalation path (Mannat/Neel bucket),
// where he noticed the AI asked for an order number but never asked for the
// customer's name/phone, and never gave the customer a way to reach GemRishi
// directly themselves. Whenever a message escalates to a human (across
// Instagram DMs, comments, WhatsApp - any channel), the reply now always:
//   1) tells the customer when the team will actually follow up (working
//      hours, unchanged from before);
//   2) asks (once, never forces/blocks) for name + contact number, but ONLY
//      if we don't already have both - a flow that already collected them
//      itself (e.g. lib/sellerInquiryFlow.js's City/Name/Phone slots) is
//      never re-asked;
//   3) gives the customer GemRishi's own contact number, so they have a way
//      to reach out proactively rather than only waiting.
// Applied deterministically here, in ONE place right after mergeEscalation()
// decides escalate=true, so it's never skipped or paraphrased away
// regardless of which reply source produced the message (replyEngine,
// kundliFlow, consultationFlow, sellerInquiryFlow) - same "deterministic
// safety net" pattern as detectReplyLanguageNote elsewhere in this codebase.
// 10 AM - 8 PM, all 7 days (Monday-Sunday, no weekly off), per Ravi.
//
// GEMRISHI_CONTACT_NUMBER reuses the existing Ambala HQ showroom number
// already used elsewhere in this codebase (lib/knowledgeBase.js's
// SHOWROOM_LOCATIONS) - TODO(Ravi): confirm this is the right number to hand
// out as a general "reach us directly" line for an escalated customer, or
// tell me which number you'd rather use instead.
const GEMRISHI_CONTACT_NUMBER = '+91 98179 75978';
// 2026-10-21 (Ravi): the number Mannat gives a customer depends on where they
// are: Instagram DMs -> Mannat Chawla's +91 98179 75978; everything else
// (WhatsApp, Instagram/Facebook comments, Facebook, reviews) -> +91 74969 97220.
const IG_DM_CONTACT_NUMBER = '+91 98179 75978';
const DEFAULT_CONTACT_NUMBER = '+91 74969 97220';
function contactNumberFor(platform = '', type = '') {
  const p = String(platform).toLowerCase();
  return p.includes('instagram') && type !== 'comment' ? IG_DM_CONTACT_NUMBER : DEFAULT_CONTACT_NUMBER;
}

const WORKING_HOURS_NOTE_EN = "We've noted your query and shared it with the concerned team member - they'll personally get back to you between 10 AM - 8 PM (all 7 days, Monday to Sunday).";
const WORKING_HOURS_NOTE_HI = 'Aapki query note kar li hai aur concerned team member ko bhej di hai - wo aapse 10 AM se 8 PM ke beech (Monday se Sunday, saare 7 din) khud personally contact karenge.';
const ASK_NAME_PHONE_NOTE_EN = "If you haven't already, please share your name and contact number so the team can reach you directly.";
const ASK_NAME_PHONE_NOTE_HI = 'Agar aapne abhi tak apna naam aur contact number nahi diya hai, toh please share kar dijiye taaki team aapse jaldi contact kar sake.';
const contactShareNoteEn = (n) => `You can also reach us directly at ${n}.`;
const contactShareNoteHi = (n) => `Aap humein seedha ${n} par bhi contact kar sakte hain.`;

function appendWorkingHoursNote(reply, message, existingMemory, result, platform = '', type = '') {
  if (!reply) return reply;
  // 2026-10-04 (audit): this long note was appended to EVERY escalated reply,
  // so the same paragraph repeated down the chat. Now once per conversation.
  if (/10 AM - 8 PM|10 AM se 8 PM/.test(String(existingMemory || ''))) return reply;
  const isHindi = replyShouldBeHindi(message, existingMemory, { platform }) || looksHinglishOrHindi(message);
  // 2026-10-21 (Ravi: keep WhatsApp short): on WhatsApp the long paragraph
  // (number to call, 7 days...) is replaced by the one-line "requirement
  // shared with the team" message - and none if the reply already says when.
  if (platform === 'whatsapp') {
    if (callWindow.FORWARDED_MARKER.test(`${reply}\n${existingMemory || ''}`)) return reply;
    // 2026-10-21 check: don't stack "I'll confirm the price with the team"
    // AND "requirement shared with the team" - the second one covers it.
    const trimmed = String(reply).replace(PRICE_CONFIRM_LINE, '').replace(/\n{3,}/g, '\n\n').trim() || reply;
    return `${trimmed}\n\n${callWindow.forwardedLine(isHindi)}`;
  }
  const parts = [isHindi ? WORKING_HOURS_NOTE_HI : WORKING_HOURS_NOTE_EN];
  // Only ask for what's actually missing (on WhatsApp the number is known).
  if (!result?.customerName && !result?.customerPhone) {
    parts.push(isHindi ? ASK_NAME_PHONE_NOTE_HI : ASK_NAME_PHONE_NOTE_EN);
  } else if (!result?.customerName) {
    parts.push(isHindi ? 'Agar aap apna naam share kar dein toh team aapse aasani se connect kar payegi.' : 'If you could share your name, the team can reach you easily.');
  } else if (!result?.customerPhone) {
    parts.push(isHindi ? 'Agar aap apna contact number share kar dein toh team aapse jaldi contact kar payegi.' : 'If you could share your contact number, the team can reach you quickly.');
  }
  const contactNo = contactNumberFor(platform, type);
  parts.push(isHindi ? contactShareNoteHi(contactNo) : contactShareNoteEn(contactNo));
  const note = parts.join(' ');
  if (reply.includes(note)) return reply; // never duplicate if already present
  return `${reply}\n\n${note}`;
}

// Replaced 2026-10-04 (Ravi, FIX 6 + FIX 15): instead of an email/Telegram
// every time a message escalated or looked HOT (the same customer pinged the
// team many times a day), the chat is queued for ONE handoff to the right
// person - sales -> Mannat Chawla, escalations/B2B -> Neel - sent once the
// customer has stopped typing (see lib/handoff.js).
// 2026-10-21 (Ravi: "form data is going on insta dm and whatsapp both"):
// one Meta form can open a chat on Instagram AND WhatsApp (two GR ids). The
// first channel's GR id owns the lead; the other channel is linked to it so
// the team gets ONE forward, to ONE person, for the whole customer.
async function formLeadDedupeKey(grId, formPhone) {
  if (!grId) return '';
  try {
    const digits = String(formPhone || '').replace(/\D/g, '').slice(-10);
    if (digits.length === 10) {
      const k = `gemrishi:formlead:${digits}`;
      await redisCommand(`/set/${encodeURIComponent(k)}/${encodeURIComponent(grId)}/EX/${30 * 86400}/NX`);
      const owner = (await redisCommand(`/get/${encodeURIComponent(k)}`))?.result;
      if (owner && owner !== grId) {
        await redisCommand(`/set/${encodeURIComponent(`gemrishi:handoff:alias:${grId}`)}/${encodeURIComponent(owner)}/EX/${30 * 86400}`);
        return owner;
      }
      return '';
    }
    return (await redisCommand(`/get/${encodeURIComponent(`gemrishi:handoff:alias:${grId}`)}`))?.result || '';
  } catch (err) {
    console.error('[handoff] form-lead dedupe lookup failed:', err.message);
    return '';
  }
}

async function queueHandoff({ result, identity, platform, contact, memoryScope, memoryId, conversationId = '', accountId = '', intent = '', trigger = '', extra = {} }) {
  try {
    // 2026-10-20 (Ravi): budget routing for WhatsApp AND Instagram -
    // problems / B2B / 50k+ -> Neel; under 50k or unknown -> Yogesh and
    // Vishvas in turn (see lib/handoff.js assignRoute).
    const budgetText = [result?.customerBudget, extra.customerBudget].filter(Boolean).join(' ');
    // Meta conversion is sent only in the explicit sales-qualified block below.
    // Do not send here: queueHandoff may run for unqualified leads and would
    // double-count the same customer when the qualified block also fires.
    const escalateToNeel = extra.route === 'neel' || handoff.needsNeel({ category: result?.category, escalate: result?.escalate, escalateReason: result?.escalateReason, intent });
    const dedupeKey = await formLeadDedupeKey(identity?.grId || '', extra.formPhone);
    const route = await handoff.assignRoute({ grId: identity?.grId || '', platform, contact, customerBudget: budgetText, dedupeKey, productInterest: [result?.productInterest, extra.productInterest].filter(Boolean).join(' / ') }, { escalateToNeel });
    const q = await handoff.queueForward({
      route, grId: identity?.grId || '', platform, contact, memoryScope, memoryId,
      customerName: result?.customerName || identity?.knownName || '',
      customerPhone: result?.customerPhone || identity?.knownPhone || '',
      customerCity: result?.customerCity || '',
      customerBudget: result?.customerBudget || '',
      productInterest: result?.productInterest || '',
      reason: result?.escalate ? result?.escalateReason || '' : '',
      trigger,
      ...extra,
      dedupeKey,
      // 2026-10-21: extra.route (e.g. 'sales' for form leads) must not override
      // the budget routing decided above.
      route,
    });
    if (q.queued) scheduleFlush();
    return q;
  } catch (err) {
    console.error('[handoff] queue failed; lead remains logged:', err.message);
    return { queued: false };
  }
}

// SAFETY NET (2026-10-04, Ravi): if anything in the reply pipeline breaks,
// the customer still gets a short, honest reply instead of silence, and the
// lead sheet shows it ("safety_net_reply") so misses are visible.
function safetyNetResult(message, err) {
  const hindi = looksHinglishOrHindi(message);
  return {
    reply: hindi
      ? 'Message karne ke liye dhanyavaad! Humari team aapko jaldi reply karegi.'
      : 'Thanks for your message! Our team will get back to you shortly.',
    leadStatus: 'WARM', productInterest: '', escalate: true,
    escalateReason: `safety net - reply pipeline error: ${err?.message || 'unknown'}`,
    safetyNet: true,
  };
}

// Decide whether this turn should hand the customer to a person.
const PRICE_CONFIRM_LINE = /\s*(I'll confirm the exact current price with the team and get back to you\.|Exact current price main team se confirm karke batati hoon\.)/g;

// 2026-10-21 (Ravi): "inform the customer their requirements are shared with
// the team". Skipped when the reply already says the team will follow up, or
// the customer was already told in this chat.
function withForwardedLine(reply, { trigger = '', existingMemory = '', hindi = false, now = new Date() } = {}) {
  const text = String(reply || '').trim();
  if (!trigger || !text) return text;
  if (callWindow.FORWARDED_MARKER.test(text) || callWindow.FORWARDED_MARKER.test(String(existingMemory || ''))) return text;
  if (handoff.promisesTeamFollowUp(text)) return text;
  return `${text}\n\n${callWindow.forwardedLine(hindi, now)}`;
}

function handoffTrigger({ result, identity, inviteAnswer, cta, isComment }) {
  const phone = result?.customerPhone || identity?.knownPhone || '';
  if (result?.escalate) return 'needs a person (escalation)';
  if (inviteAnswer?.forward === 'whatsapp_yes') return 'customer said YES to connecting on WhatsApp';
  if (cta?.wantsWhatsApp) return 'customer asked to talk on WhatsApp';
  if (phone && inviteAnswer?.forward === 'whatsapp_no') return 'customer prefers to stay on Instagram - call/message them on the number given';
  if (phone && inviteAnswer?.forward === 'whatsapp_no_answer') return 'serious buyer, number given';
  if (!isComment && phone && result?.leadStatus === 'HOT') return 'HOT lead, number given';
  // FIX (2026-10-07): Mannat promised a team follow-up (photos, price check,
  // call) - make sure the team actually hears about it.
  if (handoff.promisesTeamFollowUp(result?.reply)) return 'Mannat told the customer the team will follow up - please reply to them';
  return '';
}

// Runs a background task without holding up the reply (Vercel keeps the
// function alive for it). Used for the delayed handoff flush.
function runInBackground(promise) {
  const p = Promise.resolve(promise).catch((err) => console.error('[webhook] background task failed:', err.message));
  if (waitUntil) { try { waitUntil(p); } catch { /* not in a request context */ } }
  return p;
}

function scheduleFlush() {
  const waitMs = (handoff.settleSeconds() + 5) * 1000;
  // Only wait inside the function if that fits comfortably; otherwise the
  // next webhook event / the 7 PM job flushes it.
  if (waitMs <= Number(process.env.HANDOFF_INLINE_WAIT_MAX_MS || 250000)) {
    runInBackground(sleep(waitMs).then(() => handoff.flushDue()));
  }
}

function isStandby() {
  return String(process.env.MANNAT_STANDBY || '').trim().toLowerCase() === 'on';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let rawBody;
  try { rawBody = await readRawBody(req); } catch { return res.status(400).json({ error: 'Unable to read request body' }); }

  const signature = req.headers['x-late-signature'] || req.headers['x-zernio-signature'];
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (secret && !verifyWebhookSignature({ rawBody, signatureHeader: signature, secret })) return res.status(401).json({ error: 'Invalid signature' });
  if (!secret && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Webhook secret is not configured' });

  let body;
  try { body = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  // STANDBY (2026-10-05, Ravi): MANNAT_STANDBY=on puts Mannat fully on hold -
  // no replies (DMs, comments, any platform), no alerts, no handoffs, no sheet
  // writes. Events are acknowledged (so Zernio doesn't retry or disable the
  // webhook) and dropped; customers' messages stay in the normal Instagram /
  // Facebook inboxes for the team. Messages that arrive during standby are NOT
  // answered later when standby is switched off.
  if (isStandby()) {
    console.log('[webhook] standby: event acknowledged, no action taken');
    return res.status(200).json({ received: true, standby: true });
  }

  const inboundKey = stableInboundKey(body, rawBody);
  // 2026-10-21: one-off replay of specific events (REPLAY_EVENT_IDS, comma
  // separated) - lets a fixed bug's missed messages be redelivered once.
  // The 3 Meta-ad chats missed on 21 Oct 2026 (ad tag bug) are listed here
  // once; safe to leave (each replays at most once) and remove later.
  const replayIds = [
    ...String(process.env.REPLAY_EVENT_IDS || '').split(','),
    '9ece9442-1891-4150-8033-458161be64ed', 'dc1596a7-4446-42f7-af0f-6dd909e83d29', // Sandeep
    '09da54e0-5c69-4b22-b593-e2266a490ee2', // chirayupandya41
    'bef64e94-ce83-4398-aeb0-cd59ac0ec8c0', // Vartika
  ].map((x) => x.trim()).filter(Boolean);
  const isReplay = body?.id && replayIds.includes(String(body.id))
    && await claimInbound(`replay:${body.id}`).catch(() => false);
  try {
    const claimed = isReplay ? true : await claimInbound(inboundKey);
    if (!claimed) {
      console.log('[webhook] ignored duplicate inbound action:', inboundKey);
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (err) {
    console.error('[webhook] duplicate protection unavailable; continuing with reply:', err.message);
  }

  if (waitUntil && process.env.WEBHOOK_FAST_ACK !== 'false') {
    waitUntil(handleEvent(body).catch((err) => console.error('[webhook] error handling event (background):', err)));
    return res.status(200).json({ received: true, processing: 'background' });
  }

  try {
    await handleEvent(body);
    return res.status(200).json({ received: true, processed: true });
  } catch (err) {
    console.error('[webhook] error handling event:', err);
    return res.status(500).json({ received: true, processed: false });
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Added 2026-09-30 (Ravi): WhatsApp account discovery + safety lock.
// Zernio identifies business numbers only by an internal account id, so we
// log each WhatsApp account we see (once per 6h) to learn which id is which
// number. MANNAT_WHATSAPP_ACCOUNT_IDS (comma-separated) then locks Mannat's
// WhatsApp auto-replies to her OWN account(s): any other WhatsApp account
// (e.g. staff numbers) is never auto-replied to. Unset = old behaviour.
async function logAccountSeen(event) {
  const a = event?.account || {};
  if (String(a.platform || '').toLowerCase() !== 'whatsapp') return;
  const id = String(a.accountId || a.id || a._id || '');
  if (!id) return;
  try {
    const r = await redisCommand(`/set/${encodeURIComponent(`gemrishi:account-seen:${id}`)}/1/EX/21600/NX`);
    if (r?.result !== 'OK') return;
  } catch { /* logging only */ }
  const safe = {};
  for (const [k, v] of Object.entries(a)) if (typeof v !== 'object') safe[k] = v;
  console.log(`[account-seen] ${JSON.stringify({ event: event?.event, ...safe })}`);
}

function mannatWhatsAppAllowed(event) {
  const list = String(process.env.MANNAT_WHATSAPP_ACCOUNT_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return true;
  const a = event?.account || {};
  if (String(a.platform || '').toLowerCase() !== 'whatsapp') return true;
  return list.includes(String(a.accountId || a.id || a._id || ''));
}

// Interim (2026-10-04, Ravi FIX 14): Mannat has no WhatsApp line of her own
// right now, so she never auto-replies on WhatsApp. Set
// MANNAT_WHATSAPP_REPLIES=on once her new business number is connected
// (and list it in MANNAT_WHATSAPP_ACCOUNT_IDS / MANNAT_REPLY_NUMBERS).
function mannatWhatsAppRepliesOn() {
  return String(process.env.MANNAT_WHATSAPP_REPLIES || 'off').toLowerCase() === 'on';
}

// =============================================================================
// 2026-10-20 (Ravi): on Mannat's WhatsApp line (+91 74969 97220) she replies
// ONLY in chats that came from Meta:
//   - a Meta Click-to-WhatsApp ad (Meta attaches a `referral` / ctwa_clid to
//     the first message),
//   - a Meta lead form (form answers pasted as "Full name: ... Phone: ...").
// Instagram customers are sent to Mannat Chawla's number (98179 75978), not
// here. Every other chat: Mannat stays silent and nothing is logged - the
// team replies from the app. Once a chat qualifies it stays active 90 days.
// Off-switch: WHATSAPP_ONLY_ADS_AND_INSTA=off (Mannat replies to everyone).
// =============================================================================
function whatsappEntrySignal(event, messageText) {
  const m = event?.message || {};
  const c = event?.conversation || {};
  // 2026-10-21: Zernio puts Meta's ad referral at the TOP level of the
  // event (event.metadata.referral), not on the message or conversation.
  const meta = { ...(c.metadata || {}), ...(m.metadata || {}), ...((event && event.metadata) || {}) };
  if (meta.referral || meta.ctwa_clid || meta.ctwa_source_id || m.referral || event?.referral) return 'meta_ad';
  if (formLead.isFormLead(messageText)) return 'meta_form';
  // 2026-10-21 (Ravi): comment customers are told to WhatsApp "INSTA" to 220.
  if (/\b(insta|instagram)\b/i.test(String(messageText || ''))) return 'comment_invite';
  return '';
}
// 2026-10-21 check: chats from Click-to-WhatsApp ads start with Meta's
// "Hello! Can I get more info on this?" and Mannat asked "which product?".
// The ad's own headline/text comes with the first message - tell her.
function adContextNote(event) {
  const meta = { ...((event?.conversation || {}).metadata || {}), ...((event?.message || {}).metadata || {}), ...((event && event.metadata) || {}) };
  // Zernio also stores the ad headline on the conversation as ctwa_headline.
  const ref = meta.referral || event?.message?.referral || event?.referral || (meta.ctwa_headline ? { headline: meta.ctwa_headline, source_url: meta.ctwa_source_url } : null);
  if (!ref || typeof ref !== 'object') return '';
  const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const parts = [clean(ref.headline), clean(ref.body)].filter(Boolean);
  const url = clean(ref.source_url || ref.sourceUrl);
  if (!parts.length && !url) return '';
  return `AD CONTEXT: this customer came from a Meta ad${parts.length ? ` - "${parts.join(' - ')}"` : ''}${url ? ` (${url})` : ''}. `
    + 'If their message is generic (like "Can I get more info on this?"), assume they mean what this ad shows: answer about it directly '
    + '(price/options from live data) instead of asking which product they want.';
}

function onlyAdsAndInstaOn() {
  return String(process.env.WHATSAPP_ONLY_ADS_AND_INSTA || 'on').toLowerCase() !== 'off';
}
// Meta's default Click-to-WhatsApp greeting (pre-typed in the customer's box).
const CTWA_DEFAULT_GREETING = /^hello!?\s*can i get more info on this\??$/i;

function adMetaFrom(conv) {
  const md = (conv && conv.metadata) || {};
  return md.ctwa_clid || md.ctwa_source_id || md.ctwa_source_type === 'ad';
}

async function conversationAdSignal(event, { waits = [0, 3000, 5000] } = {}) {
  const accId = event?.account?.accountId || event?.account?.id || '';
  const convId = String(event?.conversation?.id || event?.conversation?.conversationId || '');
  const sender = identityBridge.extractWhatsAppSender(event);
  const phone = sender?.kind === 'phone' ? sender.id : '';
  const text = String(event?.message?.text || event?.message?.message || '').trim();
  for (const ms of waits) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    try {
      const page = await listInboxConversations({ apiKey: process.env.ZERNIO_API_KEY, accountId: accId, platform: 'whatsapp', status: '', limit: 30, sortOrder: 'desc' });
      const list = Array.isArray(page?.data) ? page.data : (Array.isArray(page?.conversations) ? page.conversations : []);
      const conv = list.find((c) => String(c.id || c._id) === convId || (phone && String(c.participantId || '').replace(/\D/g, '') === phone));
      if (conv && adMetaFrom(conv)) return 'meta_ad';
    } catch (err) { console.error('[wa-gate] conversation lookup failed:', err.message); }
  }
  // Last resort: Meta's default ad greeting is only typed by ad clicks.
  if (CTWA_DEFAULT_GREETING.test(text)) return 'meta_ad_greeting';
  return '';
}

async function whatsappChatAllowed(event) {
  if (!onlyAdsAndInstaOn()) return true;
  const conversationId = event?.conversation?.id || event?.conversation?.conversationId || '';
  if (!conversationId) return false;
  const key = `gemrishi:wa-active:${conversationId}`;
  try {
    const got = await redisCommand(`/get/${encodeURIComponent(key)}`);
    if (got?.result) return true;
  } catch (err) { console.error('[wa-gate] redis read failed:', err.message); }
  const text = String(event?.message?.text || event?.message?.message || '');
  let signal = whatsappEntrySignal(event, text);
  // 2026-10-21: Meta's ad tag (ctwa_*) lands on the Zernio conversation ~3s
  // AFTER the first message arrives, so it is missing from the webhook. Look
  // it up on the conversation, waiting a few seconds if needed.
  if (!signal) signal = await conversationAdSignal(event);
  if (!signal) {
    console.log('[wa-gate] not a Meta ad / form chat - Mannat stays silent:', conversationId);
    return false;
  }
  try { await redisCommand(`/set/${encodeURIComponent(key)}/${encodeURIComponent(signal)}/EX/${90 * 86400}`); }
  catch (err) { console.error('[wa-gate] redis write failed:', err.message); }
  console.log('[wa-gate] chat activated:', conversationId, signal);
  return true;
}

async function handleEvent(event) {
  // Any due one-time handoffs go out now (cheap check, runs in background).
  runInBackground(handoff.flushDue());
  if (event?.event === 'message.received' || event?.event === 'message.sent') await logAccountSeen(event);
  // Added 2026-09-30 (Ravi): alert if a team / Mannat WhatsApp number is
  // disconnected from Zernio (monitoring would silently stop otherwise).
  if (event?.event === 'account.disconnected' || event?.event === 'account.connected') {
    try { await handleAccountEvent(event); } catch (err) { console.error('[webhook] account event error:', err.message); }
    return;
  }
  if (event?.event === 'comment.received') return handleComment(event);
  // Added 2026-09-30 (Ravi): team WhatsApp monitoring. A message (incoming OR
  // the staff's own outgoing reply) on a monitored business number is watched
  // and logged only - Mannat never replies there. If the monitor claims it,
  // we return immediately, so it never reaches the customer-reply/send code.
  if (event?.event === 'message.received' || event?.event === 'message.sent') {
    try {
      const claimed = await handleTeamMessage(event, { getMemory: monitorGetMemory, addTurn: monitorAddTurn, knowledgeBase: KNOWLEDGE_BASE, lookupLiveProduct, formatLiveProductData });
      if (claimed) return;
    } catch (err) {
      console.error('[webhook] team monitor error (message not on customer path):', err.message);
      if (event?.event === 'message.sent') return; // outgoing staff replies never go to the customer path
    }
  }
  // FIX 2026-10-16 (Ravi): an outgoing DM that Mannat didn't send = a team
  // member replied. Silence Mannat for that chat right away (real time),
  // instead of only noticing on the customer's next message.
  // Off-switch: TAKEOVER_REALTIME=off in Vercel.
  if (event?.event === 'message.sent') {
    if (String(process.env.TAKEOVER_REALTIME || 'on').toLowerCase() === 'off') { console.log('[webhook] ignored event type: message.sent'); return; }
    return handleOutgoingDm(event);
  }
  if (event?.event === 'message.received') {
    const p = String(event?.account?.platform || event?.conversation?.platform || '').toLowerCase();
    if (p.includes('whatsapp') && !mannatWhatsAppRepliesOn()) {
      console.log('[webhook] WhatsApp auto-replies are off (Mannat is Instagram-only for now) - not replying');
      return;
    }
    if (!mannatWhatsAppAllowed(event)) {
      console.log('[webhook] WhatsApp account is not Mannat\'s - not auto-replying:', event?.account?.accountId || event?.account?.id);
      return;
    }
    // 2026-10-20 (Ravi): Neel / Yogesh / Vishvas / Mannat Chawla message the
    // 220 number ("Any new lead for me") -> their waiting leads are sent and
    // new ones arrive in that chat for 24 hours. Never an AI reply.
    if (p.includes('whatsapp')) {
      const sender = identityBridge.extractWhatsAppSender(event);
      const staffRoute = sender?.kind === 'phone' ? handoff.routeForStaffNumber(sender.id) : '';
      if (staffRoute) {
        const convId = event?.conversation?.id || event?.conversation?.conversationId;
        const accId = event?.account?.accountId || event?.account?.id;
        // 2026-10-20: "sold 9876543210 45000" -> Purchase event to Meta.
        const sale = metaTracking.parseSaleCommand(event?.message?.text || event?.message?.message || '');
        if (sale) {
          const reply = (text) => sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId: convId, accountId: accId, text, idempotencyKey: `sale-reply-${event?.message?.id || Date.now()}` });
          try {
            if (sale.error === 'phone') await reply('Customer ka 10 digit number bhi likhiye, jaise: sold 9876543210 45000');
            else if (sale.error === 'amount') await reply(`Amount bhi likhiye, jaise: sold ${sale.phone} 45000`);
            else {
              let attribution = null;
              try {
                const raw = await redisCommand(`/get/${encodeURIComponent(`gemrishi:meta-attribution:${String(sale.phone).replace(/\D/g, '').slice(-10)}`)}`);
                if (raw?.result) attribution = JSON.parse(raw.result);
              } catch (lookupErr) {
                console.error('[sale] Meta attribution lookup failed:', lookupErr.message);
              }
              const r = await metaTracking.purchase({
                phone: sale.phone,
                amount: sale.amount,
                reportedBy: handoff.ROUTES[staffRoute].person,
                accountId: attribution?.accountId || '',
                conversationId: attribution?.conversationId || '',
                orderId: event?.message?.id ? `sale-command:${event.message.id}` : undefined,
              });
              await reply(r.sent
                ? `✅ Sale noted: ${sale.phone} - Rs ${sale.amount.toLocaleString('en-IN')}. Meta accepted the event.`
                : `Sale noted, but Meta tracking is unconfirmed (${String(r.reason || '').slice(0, 80)}). Ravi ko bata dijiye.`);
            }
          } catch (err) { console.error('[sale] failed:', err.message); }
          return;
        }
        // 2026-10-20: sales interview in progress -> this message is an answer.
        try {
          const msgId = event?.message?.id || '';
          const staffText = String(event?.message?.text || event?.message?.message || '').trim();
          // "training" / "start training" / "interview" starts (or restarts) it.
          if (/^(start\s*)?(training|interview|train\s*mannat)\b/i.test(staffText) && !(await salesInterview.isActive(staffRoute))) {
            const fresh0 = msgId ? (await redisCommand(`/set/${encodeURIComponent(`gemrishi:interview:msg:${msgId}`)}/1/EX/86400/NX`))?.result === 'OK' : true;
            if (fresh0) {
              await handoff.openStaffWindow({ route: staffRoute, conversationId: convId, accountId: accId });
              const send0 = (text, i) => sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId: convId, accountId: accId, text, idempotencyKey: `interview-start-${msgId || Date.now()}-${i}` });
              await salesInterview.start({ route: staffRoute, person: handoff.ROUTES[staffRoute].person, send: send0 });
            }
            return;
          }
          if (await salesInterview.isActive(staffRoute)) {
            const fresh = msgId ? (await redisCommand(`/set/${encodeURIComponent(`gemrishi:interview:msg:${msgId}`)}/1/EX/86400/NX`))?.result === 'OK' : true;
            if (fresh) {
              await handoff.openStaffWindow({ route: staffRoute, conversationId: convId, accountId: accId });
              const send = (text, i) => sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId: convId, accountId: accId, text, idempotencyKey: `interview-${msgId || Date.now()}-${i}` });
              await salesInterview.handleReply({ route: staffRoute, person: handoff.ROUTES[staffRoute].person, text: event?.message?.text || event?.message?.message || '', send, log: logLead });
            }
            return;
          }
        } catch (err) { console.error('[interview] failed:', err.message); return; }
        try {
          const res = await handoff.staffCheckIn({ route: staffRoute, conversationId: convId, accountId: accId });
          console.log('[staff-checkin]', staffRoute, JSON.stringify(res));
        } catch (err) { console.error('[staff-checkin] failed:', err.message); }
        return;
      }
    }
    if (p.includes('whatsapp') && !(await whatsappChatAllowed(event))) return;
    return handleMessage(event);
  }
  // Added 2026-09-29 (Ravi): Google Business Profile reviews. review.updated
  // (an edit, or our own reply being added) is deliberately ignored.
  if (event?.event === 'review.new') {
    return handleReview(event, { generateReply, replyToReview, logLead, notifyEscalation, claimReplySlot, markReplySent, releaseReplySlot });
  }
  console.log('[webhook] ignored event type:', event?.event);
}

async function handleOutgoingDm(event) {
  const message = event.message || {};
  const conversation = event.conversation || {};
  const account = event.account || {};
  const dir = String(message.direction || event.direction || '').toLowerCase();
  if (dir && !['outgoing', 'out', 'sent', 'outbound'].includes(dir)) return;
  const platform = account.platform || conversation.platform;
  const conversationId = conversation.id || conversation.conversationId;
  const text = message.text || message.message || '';
  if (!conversationId || !text) return;
  const memoryId = `${platform || 'social'}:${conversationId}`;
  const res = await recordOutgoingMessage({ memoryId, text });
  if (res.human) {
    console.log('[webhook] team member replied - Mannat silenced for this chat:', memoryId);
    // 2026-10-17 audit: remember what the team said, so when Mannat takes
    // back over she stays consistent with it (manavpatel22011986 case).
    await saveTurn('conversation', memoryId, 'team', text);
  }
}

// --- Comment -> DM (2026-10-17, Ravi) ---------------------------------------
// Which comments get a DM: Instagram by default (COMMENT_DM_PLATFORMS, comma
// list; "off" disables). Pure emoji / praise comments and non-leads get only
// the public reply - a DM for "🔥🔥" would feel like spam.
// 2026-10-21 (Ravi): keep WhatsApp chats short and simple.
const WHATSAPP_SHORT_NOTE = 'WHATSAPP STYLE: keep it short and simple - at most 2 short blocks, under 40 words in total, plain everyday words, '
  + 'one thing at a time and at most one question. A price or a product link is fine; no long explanations or lists. '
  + 'The customer is already chatting on WhatsApp - never ask whether they prefer WhatsApp chat or a call on WhatsApp, and never give them a number to WhatsApp.';

// 2026-10-21 (Ravi): the private DM to Instagram commenters stays ON, and the
// full answer is ALSO given publicly under the comment.
function shouldDmCommenter({ platform, commentText, result }) {
  const setting = String(process.env.COMMENT_DM_PLATFORMS || 'instagram').toLowerCase();
  if (setting === 'off') return false;
  if (!setting.split(',').map((x) => x.trim()).includes(String(platform || '').toLowerCase())) return false;
  if (!/[\p{L}\p{N}]/u.test(String(commentText || ''))) return false; // emoji / stickers only
  if (/^\s*(nice|wow|beautiful|awesome|great|super|amazing|good|love|lovely|jai|om|har har mahadev|radhe|thanks?|thank you|👍)\W*$/i.test(commentText)) return false;
  if (['COLD', 'NOT_A_LEAD'].includes(result?.leadStatus)) return false;
  if (result?.safetyNet || result?.generationFailed) return false;
  return true;
}

// 2026-10-21 (Ravi): solve the question right under the comment.
function commentAnswerNote(existingMemory = '') {
  const repeat = /^Customer:/m.test(String(existingMemory || ''));
  return 'PUBLIC COMMENT: answer the customer\'s question fully right here in the comment reply (2-3 short lines) - '
    + 'give the price/details/link from the live product data if you have it. Do NOT tell them to DM, inbox or WhatsApp us; '
    + 'the system adds the WhatsApp line itself when it is needed.'
    + (repeat ? ' This customer has already commented here before - answer what they are asking now, do not repeat your earlier reply.' : '');
}

function commentDmPublicReply(commentText, existingMemory = '') {
  const hindi = looksHinglishOrHindi(commentText) || looksHinglishOrHindi(existingMemory);
  const en = ['Hi! I\'ve sent you the details in your DMs 🙏', 'Sent you a DM with the details! 💎', 'Hi! Please check your DMs, I\'ve shared the details there 🙏'];
  const hi = ['Namaste! Aapko DM mein details bhej di hain 🙏', 'Ji, details aapke DM mein bhej di hain 💎', 'Aapke DM mein details share kar di hain, please check kijiye 🙏'];
  const list = hindi ? hi : en;
  return list[Math.floor(Math.random() * list.length)];
}

// When the commenter replies to that DM, Mannat should know what she already
// told them. Saved by Instagram username for 7 days (the DM conversation id
// isn't known when the private reply is sent).
async function saveCommentDmSeed(handle, commentText, dmText) {
  const h = String(handle || '').toLowerCase();
  if (!h || h === 'unknown') return;
  const value = JSON.stringify({ comment: String(commentText).slice(0, 500), dm: String(dmText).slice(0, 1500) });
  try { await redisCommand(`/set/${encodeURIComponent(`gemrishi:comment-dm-seed:${h}`)}/${encodeURIComponent(value)}/EX/${7 * 86400}`); }
  catch (err) { console.error('[webhook] comment DM seed save failed:', err.message); }
}

async function useCommentDmSeed(handle, memoryId) {
  const h = String(handle || '').toLowerCase();
  if (!h || h === 'unknown') return '';
  try {
    const key = encodeURIComponent(`gemrishi:comment-dm-seed:${h}`);
    const data = await redisCommand(`/get/${key}`);
    if (!data?.result) return '';
    const seed = JSON.parse(data.result);
    await redisCommand(`/del/${key}`);
    await saveTurn('conversation', memoryId, 'customer', `(commented on our post) ${seed.comment}`);
    await saveTurn('conversation', memoryId, 'assistant', seed.dm);
    return `Customer: (commented on our post) ${seed.comment}\nMannat: ${seed.dm}`;
  } catch (err) {
    console.error('[webhook] comment DM seed read failed:', err.message);
    return '';
  }
}

async function handleComment(event) {
  const comment = event.comment || {};
  const post = event.post || {};
  const account = event.account || {};
  const platform = account.platform || post.platform;
  const accountId = account.accountId || account.id;
  const postId = post.id || post.platformPostId;
  const commentId = comment.id || comment.commentId;
  const commentText = comment.text || comment.content || comment.message || '';
  const authorHandle = comment.author?.username || comment.author?.name || 'unknown';
  const postCaption = post.caption || post.content || '';

  if (comment.author?.isOwnAccount === true) {
    console.log('[webhook] ignored own-account comment:', commentId || 'unknown');
    return;
  }
  if (!commentText) return;

  const replyKey = `comment:${commentId || inboundSafeId(event)}`;
  let slot = { allowed: true, reason: 'redis_unavailable' };
  try {
    slot = await claimReplySlot(replyKey);
    if (!slot.allowed) {
      console.log('[webhook] reply suppressed:', slot.reason, commentId || 'unknown');
      return;
    }
  } catch (err) {
    console.error('[webhook] reply gate unavailable; continuing with comment reply:', err.message);
  }

  const memoryId = `${platform || 'social'}:${authorHandle}:${postId || 'unknown'}`;

  // FIX 11 (2026-10-04): a seller gets the certified-only brush-off with
  // Neel's number - and NOTHING is logged, saved or alerted.
  const sellerTurn = await maybeHandleSellerInquiry({
    enabled: process.env.ENABLE_SELLER_INQUIRY_FLOW !== 'false',
    scopeId: `${platform || 'social'}:${authorHandle}`, message: commentText, intent: classifyIntent(commentText),
  });
  if (sellerTurn) {
    if (sellerTurn.reply && postId && accountId) {
      try {
        await replyToComment({ apiKey: process.env.ZERNIO_API_KEY, postId, accountId, commentId, text: sellerTurn.reply });
        await markReplySent(replyKey);
      } catch (err) { console.error('[webhook] seller reply failed:', err.message); await releaseReplySlot(replyKey); }
    } else {
      await releaseReplySlot(replyKey);
    }
    return;
  }

  // Second, content-based dedup layer (independent of the message-ID gate
  // above): catches the case where the same customer text arrives twice
  // under genuinely different IDs (a resend), which the ID-based gate above
  // cannot see. See claimContentSlot's comment for the diagnosed case this
  // covers (Ashad Khan, 2026-09-23 sheet review).
  try {
    const contentOk = await claimContentSlot(memoryId, commentText);
    if (!contentOk) {
      console.log('[webhook] comment reply suppressed: duplicate text within window', commentId || 'unknown');
      await releaseReplySlot(replyKey);
      await logLead({
        platform, contact: authorHandle, type: 'comment', message: commentText,
        reply: '(not sent - duplicate of a just-answered message)',
        leadStatus: 'WARM', productInterest: '', escalated: false,
        notes: 'suppressed_duplicate_within_20s',
      });
      return;
    }
  } catch (err) {
    console.error('[webhook] content-dedup check failed; continuing with comment reply:', err.message);
  }

  let existingMemory = '';
  let identity = null;
  let aiContext = { contextText: '', liveProductData: '', intent: classifyIntent(commentText), product: '', live: { found: false } };
  let result;
  try {
    existingMemory = await loadContext('comment', memoryId);
    identity = await prepareInbound({ platform, event, messageText: commentText, platformUserId: comment.author?.id, handle: authorHandle });
    aiContext = await buildAIContext(commentText, platform, existingMemory, postCaption, 'comment');
    if (identity?.contextNote) aiContext.contextText += `\n\n${identity.contextNote}`;
    aiContext.contextText += `\n\n${guards.contextNotes({ memory: existingMemory, message: commentText, knownPhone: identity?.knownPhone || '' })}`;
    const commentCallNote = callWindow.immediateCallNote(commentText, looksHinglishOrHindi(commentText));
    if (commentCallNote) aiContext.contextText += `\n\n${commentCallNote}`;
    aiContext.contextText += `\n\n${commentAnswerNote(existingMemory)}`;
    result = await generateReply({ platform, type: 'comment', message: commentText, contextText: aiContext.contextText, liveProductData: aiContext.liveProductData, intent: aiContext.intent.intent });
  } catch (err) {
    // SAFETY NET (2026-10-04): never leave a customer unanswered because
    // something broke (sheet 401, Gemini credits, a timeout...).
    console.error('[webhook] comment pipeline failed - sending safety-net reply:', err.message);
    result = safetyNetResult(commentText, err);
  }
  result = mergeEscalation(result, commentText, false);
  result = { ...result, reply: guards.cleanReply({ reply: result.reply, memory: existingMemory, message: commentText, knownPhone: result.customerPhone || identity?.knownPhone || '', isFirstReply: !existingMemory }) };
  if (result.escalate) result = { ...result, reply: appendWorkingHoursNote(result.reply, commentText, existingMemory, result, platform, 'comment') };
  const cta = await addHandoffCta({
    identity, reply: result.reply, messageText: commentText, existingMemory, memoryScope: 'comment', memoryId,
    platformUserId: comment.author?.id || authorHandle, commentId, postId, isComment: true,
    hindi: looksHinglishOrHindi(commentText) || looksHinglishOrHindi(existingMemory),
    intent: aiContext.intent.intent, productInterest: result.productInterest || aiContext.product || '', customerName: result.customerName || '',
  });
  result = { ...result, reply: cta.reply };
  const invite = await maybeAppendInvite({
    identity, reply: result.reply, intent: aiContext.intent.intent, leadStatus: result.leadStatus,
    knownName: result.customerName || identity?.knownName || '', knownPhone: result.customerPhone || identity?.knownPhone || '',
    existingMemory, isComment: true, fromGeneralReply: true, escalated: Boolean(result.escalate),
    hadCta: Boolean(cta.handoffId), hindi: looksHinglishOrHindi(commentText) || looksHinglishOrHindi(existingMemory),
  });
  result = { ...result, reply: invite.reply };
  await saveCustomerFacts(identity, result, aiContext.product || '');
  let sendError = '';

  // 2026-10-17 (Ravi): Instagram's own comment auto-DM was switched off, so
  // Mannat now DMs the commenter herself with the full answer, and the public
  // reply is a short "sent you a DM". If the DM can't be sent, the full answer
  // goes in the public reply exactly as before.
  let dmSent = false;
  if (postId && accountId && commentId && result.reply && shouldDmCommenter({ platform, commentText, result })) {
    try {
      const dmText = result.reply;
      await markAiSentAnyChat(dmText);
      await sendPrivateReply({ apiKey: process.env.ZERNIO_API_KEY, postId, commentId, accountId, text: dmText });
      dmSent = true;
      await saveCommentDmSeed(authorHandle, commentText, dmText);
      // 2026-10-21 (Ravi): the public reply keeps the full answer (solve it
      // under the comment); the DM is an extra private copy.
      result = { ...result, dmReply: dmText };
    } catch (err) {
      console.error('[webhook] private reply (comment DM) failed - answering publicly instead:', err.message);
    }
  }

  if (postId && accountId && result.reply) {
    try {
      await replyToComment({ apiKey: process.env.ZERNIO_API_KEY, postId, accountId, commentId, text: result.reply });
      try { await markReplySent(replyKey); }
      catch (err) { console.error('[webhook] reply sent but Redis status update failed:', err.message); }
    } catch (err) {
      console.error('[webhook] replyToComment failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
      result = mergeEscalation(result, commentText, true);
      await releaseReplySlot(replyKey);
    }
  } else {
    await releaseReplySlot(replyKey);
  }

  if (!sendError) {
    await saveTurn('comment', memoryId, 'customer', commentText);
    await saveTurn('comment', memoryId, 'assistant', result.dmReply || result.reply);
  }

  await logLead({
    platform, contact: authorHandle, type: 'comment', message: commentText,
    reply: sendError ? '(send failed, see notes)' : (dmSent ? `[Public + DM] ${result.reply}` : result.reply),
    leadStatus: result.leadStatus, productInterest: result.productInterest || aiContext.product,
    escalated: result.escalate || Boolean(sendError),
    notes: [result.escalateReason, `intent=${aiContext.intent.intent}`, aiContext.live.found ? 'live_product_data=found' : 'live_product_data=not_found', identityNotes(identity, cta.handoffId), result.modelTier ? `model=${result.modelTier}` : '', result.safetyNet ? 'safety_net_reply' : '', dmSent ? 'comment_dm_sent' : '', sendError].filter(Boolean).join(' | '),
    replySuggestion: result.replyImprovement || '',
  });

  const commentTrigger = handoffTrigger({ result: { ...result, reply: result.dmReply || result.reply }, identity, inviteAnswer: null, cta, isComment: true });
  if (commentTrigger) {
    await queueHandoff({ result, identity, platform, contact: authorHandle, memoryScope: 'comment', memoryId, intent: aiContext.intent.intent, trigger: commentTrigger });
  }
}

async function handleMessage(event) {
  const message = event.message || {};
  const conversation = event.conversation || {};
  const account = event.account || {};
  if (event.metadata?.standby || message.metadata?.standby) return;

  const platform = account.platform || conversation.platform;
  const accountId = account.accountId || account.id;
  const conversationId = conversation.id || conversation.conversationId;
  const messageId = message.id || message.messageId;
  let messageText = message.text || message.message || '';
  const senderHandle = conversation.participantUsername || conversation.participantName || message.contactId || 'unknown';
  if (!messageText || !conversationId) return;

  // LOOP GUARD (2026-09-30) - runs before anything else can reply.
  if (isBlockedSender(conversation.participantPhone, conversation.participantId, conversation.participantUsername, message.contactId, senderHandle)) {
    console.log('[webhook] blocked sender ignored:', senderHandle);
    return;
  }
  const loop = await checkLoopGuard(`${platform || 'social'}:${conversationId}`, messageText);
  if (loop.stop) {
    console.log('[webhook] loop guard - not replying:', conversationId, loop.reason);
    if (loop.firstTrip) {
      await logLead({
        platform, contact: senderHandle, type: platform === 'whatsapp' ? 'whatsapp' : 'dm', message: messageText,
        reply: `(Mannat stopped replying - ${loop.reason}. Check this chat; add the number to BLOCKED_SENDERS if it is a bot.)`,
        leadStatus: 'NOT_A_LEAD', productInterest: '', escalated: false,
        notes: 'loop_guard_stopped',
      });
    }
    return;
  }

  const replyKey = `message:${messageId || crypto.createHash('sha256').update(`${conversationId}|${messageText}`).digest('hex')}`;
  let slot = { allowed: true, reason: 'redis_unavailable' };
  try {
    slot = await claimReplySlot(replyKey);
    if (!slot.allowed) {
      console.log('[webhook] message reply suppressed:', slot.reason);
      return;
    }
  } catch (err) {
    console.error('[webhook] message reply gate unavailable; continuing with DM reply:', err.message);
  }

  const messageType = platform === 'whatsapp' ? 'whatsapp' : 'dm';

  // Second, content-based dedup layer (independent of the message-ID gate
  // above): catches the case where the same customer text arrives twice
  // under genuinely different message IDs (a resend / redelivery with a
  // fresh ID), which the ID-based gate above cannot see. This is what
  // caught "Ashad Khan" getting 3 separately-worded AI replies to the same
  // question within ~400ms (2026-09-23 sheet review) - each arrived as a
  // distinct messageId, so the ID-based gate let all three through.
  try {
    const contentOk = await claimContentSlot(`${platform || 'social'}:${conversationId}`, messageText);
    if (!contentOk) {
      console.log('[webhook] message reply suppressed: duplicate text within window', conversationId);
      await releaseReplySlot(replyKey);
      await logLead({
        platform, contact: senderHandle, type: messageType, message: messageText,
        reply: '(not sent - duplicate of a just-answered message)',
        leadStatus: 'WARM', productInterest: '', escalated: false,
        notes: 'suppressed_duplicate_within_20s',
      });
      return;
    }
  } catch (err) {
    console.error('[webhook] content-dedup check failed; continuing with DM reply:', err.message);
  }

  // Ravi, confirmed 2026-09-23: stop auto-replying to Facebook DMs entirely
  // (Instagram DMs/comments and Facebook comments are unaffected; WhatsApp
  // stays off until it's connected separately). This also sidesteps the
  // Facebook 24-hour messaging-window failures seen earlier, since we no
  // longer attempt to send into that window at all. The lead is still
  // logged (not silently dropped) so nothing goes unseen - it's just not
  // auto-replied.
  if (isFacebookDmPlatform(platform) && messageType === 'dm') {
    await logLead({
      platform, contact: senderHandle, type: messageType, message: messageText,
      reply: '(not sent - Facebook DM auto-reply is currently disabled)',
      leadStatus: 'WARM', productInterest: '', escalated: false,
      notes: 'facebook_dm_auto_reply_disabled',
    });
    return;
  }

  const memoryId = `${platform || 'social'}:${conversationId}`;

  // Added 2026-09-29 (Ravi): wait a few seconds for follow-up messages and
  // answer them all together in one reply, like a person would.
  const burst = await collectBurst({
    chatId: memoryId,
    messageKey: messageId || replyKey,
    text: messageText,
    redis: (path) => redisCommand(path),
  });
  if (!burst.answerNow) {
    console.log('[webhook] message folded into a combined reply:', burst.reason);
    await releaseReplySlot(replyKey);
    return;
  }
  if (burst.count > 1) console.log(`[webhook] answering ${burst.count} quick messages together`);
  messageText = burst.text;

  // Human-takeover guard (DMs only, per Ravi 2026-09-24) - see
  // lib/humanTakeoverGuard.js for the full design and its one hard
  // limitation (a phone-call handoff can never be detected this way).
  // Checked BEFORE loading AI context/calling Gemini, so a silenced
  // conversation costs nothing extra beyond the one Zernio read.
  let takeover = { silence: false, justDetectedHuman: false, resumed: false };
  if (accountId) {
    try {
      takeover = await checkHumanTakeover({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, memoryId });
    } catch (err) {
      console.error('[webhook] human-takeover check failed; continuing with normal AI reply:', err.message);
    }
  }

  if (takeover.silence) {
    await saveTurn('conversation', memoryId, 'customer', messageText);
    await logLead({
      platform, contact: senderHandle, type: messageType, message: messageText,
      reply: '(not sent - a team member is already handling this conversation; AI is monitoring only)',
      leadStatus: 'WARM', productInterest: '', escalated: false,
      notes: takeover.justDetectedHuman ? 'human_takeover_detected' : 'human_takeover_silence_continuing',
    });
    // FIX (2026-10-07, Ravi): a customer can share their WhatsApp number
    // WHILE a staff member has already taken over (AI only monitoring) -
    // two real same-day cases (jatin.tyagi24, ilujain89) never reached the
    // Instagram Organic sheet because this branch returned before
    // recordInstagramLead() further down ever ran. No AI call added here
    // (see extractPhoneFromText above) so the "costs nothing extra" promise
    // for a silenced conversation still holds.
    if (platform === 'instagram' && messageType === 'dm') {
      const phone = extractPhoneFromText(messageText);
      if (phone) {
        await recordInstagramLead({
          platform, type: messageType, handle: senderHandle, phone,
          leadStatus: 'WARM', isFormLead: formLead.isFormLead(messageText),
        }).catch((err) => console.error('[webhook] recordInstagramLead (human-takeover path) failed:', err.message));
      }
    }
    await releaseReplySlot(replyKey);
    return;
  }

  // FIX 11 (2026-10-04, Ravi): sellers get the certified-only brush-off with
  // Neel's number, BEFORE any customer profile, memory or lead row exists.
  // Nothing about them is logged, saved or alerted.
  const sellerTurn = await maybeHandleSellerInquiry({
    enabled: process.env.ENABLE_SELLER_INQUIRY_FLOW !== 'false',
    scopeId: memoryId, message: messageText, intent: classifyIntent(messageText),
  });
  if (sellerTurn) {
    if (sellerTurn.reply && accountId) {
      try {
        await sendLikeHuman({
          reply: sellerTurn.reply,
          typing: () => sendTypingIndicator({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId }),
          beforeSend: (text) => markAiSent(memoryId, text),
          send: (text) => sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text }),
        });
        await markReplySent(replyKey);
      } catch (err) { console.error('[webhook] seller reply failed:', err.message); await releaseReplySlot(replyKey); }
    } else {
      await releaseReplySlot(replyKey);
    }
    return;
  }

  let identity = null;
  let ownMemory = '';
  let existingMemory = '';
  let aiContext = { contextText: '', liveProductData: '', intent: classifyIntent(messageText), product: '', live: { found: false } };
  let pipelineError = null;
  // FIX 8 (2026-10-04): Meta ad form leads.
  const isNewFormLead = formLead.isFormLead(messageText);
  let formRef = null;
  let parsedForm = null;
  let handover = { escalate: false, reason: '', note: '' };
  try {
    identity = await prepareInbound({
      platform, event, messageText, conversationId,
      platformUserId: conversation.participantId || `conv_${conversationId}`, handle: senderHandle,
    });
    ownMemory = await loadContext('conversation', memoryId);
    // 2026-10-17: first DM after Mannat DMed them about their comment.
    if (!ownMemory && platform === 'instagram') ownMemory = await useCommentDmSeed(conversation.participantUsername || senderHandle, memoryId);
    // For a WhatsApp customer who arrived via a handoff link, their earlier
    // Instagram chat is placed before this chat's own history.
    existingMemory = [identity?.contactMemoryText, identity?.linkedMemoryText, ownMemory].filter(Boolean).join('\n');
    // A pending handoff for this customer waits until they finish typing.
    await handoff.touchPending({ grId: identity?.grId || '', platform, contact: senderHandle });
    aiContext = await buildAIContext(messageText, platform, existingMemory);
    if (identity?.contextNote) aiContext.contextText += `\n\n${identity.contextNote}`;
    if (isNewFormLead) {
      parsedForm = formLead.parseFormLead(messageText);
      await formLead.recordFormLead({ lead: parsedForm, platform, contact: senderHandle, memoryId });
      formRef = { new: true };
      aiContext.contextText += `\n\n${formLead.firstReplyNote(parsedForm, looksHinglishOrHindi(messageText))}`;
    } else {
      formRef = await formLead.formLeadForConversation(memoryId);
      if (formRef) {
        aiContext.contextText += `\n\n${formLead.followupNote(looksHinglishOrHindi(messageText))}`;
        if (formLead.looksLikePreference(messageText)) await formLead.savePreference(formRef, messageText);
      }
    }
    aiContext.contextText += `\n\n${guards.contextNotes({ memory: existingMemory, message: messageText, knownPhone: identity?.knownPhone || parsedForm?.phone || '' })}`;
    // 2026-10-20 audit: same size asked 3x / annoyed customer -> stop
    // pitching and hand the chat to the team (see conversationGuards.js).
    handover = guards.handoverCheck({ memory: existingMemory, message: messageText, knownPhone: identity?.knownPhone || parsedForm?.phone || '' });
    if (handover.note) aiContext.contextText += `\n\n${handover.note}`;
    // FIX 6 (2026-10-07, Ravi): "call now" must never be answered with a
    // false "team is calling you right now" - and must respect office hours
    // (after 7 PM -> tomorrow after 10 AM; before 10 AM -> today after 10 AM).
    // 2026-10-20: any call request (not only "call now") -> team calls.
    const immediateCallNote = callWindow.callRequestNote(messageText, replyShouldBeHindi(messageText, existingMemory, { platform }) || looksHinglishOrHindi(messageText));
    if (immediateCallNote) aiContext.contextText += `\n\n${immediateCallNote}`;
    const offHoursNote = callWindow.afterHoursNote(replyShouldBeHindi(messageText, existingMemory, { platform }) || looksHinglishOrHindi(messageText));
    if (offHoursNote) aiContext.contextText += `\n\n${offHoursNote}`;
    if (platform === 'whatsapp') aiContext.contextText += `\n\n${WHATSAPP_SHORT_NOTE}`;
    const adNote = adContextNote(event);
    if (adNote) aiContext.contextText += `\n\n${adNote}`;
  } catch (err) {
    pipelineError = err;
    console.error('[webhook] DM context build failed - will use safety net if needed:', err.message);
  }

  // Seller/manufacturer inquiry flow (see lib/sellerInquiryFlow.js) - checked
  // FIRST, before the customer-facing Kundli/consultation flows, since
  // someone offering to SELL to GemRishi must never be mis-read as a
  // customer asking about buying/consultation. Live by default (Ravi,
  // 2026-09-24), same on/off convention as the consultation flow below.
  // Added 2026-09-29 (Ravi): is this the customer's answer to Mannat's
  // one-time "shall we continue on WhatsApp?" question?
  const dmHindi = replyShouldBeHindi(messageText, existingMemory, { platform }) || looksHinglishOrHindi(messageText) || looksHinglishOrHindi(existingMemory);
  const inviteAnswer = (formRef || pipelineError) ? null : await handleInviteAnswer({
    identity, messageText, existingMemory, memoryScope: 'conversation', memoryId,
    conversationId, platformUserId: conversation.participantId || senderHandle, hindi: dmHindi,
  });
  if (inviteAnswer?.contextNote) aiContext.contextText += `\n\n${inviteAnswer.contextNote}`;
  let fromGeneralReply = false;

  let result = inviteAnswer?.result || null;
  const skipFlows = Boolean(formRef) || Boolean(pipelineError);
  try {
  if (pipelineError) throw pipelineError;
  // Mannat 2.0: an isolated, additive branch (see lib/kundliFlow.js) that
  // only ever engages when ENABLE_KUNDLI_FLOW=true. It returns null when
  // not applicable, and the normal replyEngine path below runs unchanged -
  // this line is the ENTIRE footprint of that feature on the live flow.
  if (!result && !skipFlows) {
    result = await maybeHandleKundliTurn({
      enabled: process.env.ENABLE_KUNDLI_FLOW === 'true',
      type: messageType,
      memoryId,
      message: messageText,
      intent: aiContext.intent,
      existingMemory,
    });
  }
  // Consultation-plan payment flow (see lib/consultationFlow.js) - live by
  // default, independent of the Kundli flow above. Only engages when the
  // customer names a specific paid plan; otherwise it returns null and the
  // normal replyEngine path below runs unchanged.
  if (!result && !skipFlows) {
    result = await maybeHandleConsultationPayment({
      enabled: process.env.ENABLE_CONSULTATION_PAYMENT_FLOW !== 'false',
      type: messageType,
      memoryId,
      message: messageText,
      intent: aiContext.intent,
      existingMemory,
    });
  }
  if (!result) {
    result = await generateReply({ platform, type: messageType, message: messageText, contextText: aiContext.contextText, liveProductData: aiContext.liveProductData, intent: aiContext.intent.intent, forceSmart: Boolean(formRef) });
    fromGeneralReply = true;
  }
  } catch (err) {
    // SAFETY NET (2026-10-04): never silence because something broke.
    console.error('[webhook] DM pipeline failed - sending safety-net reply:', err.message);
    result = safetyNetResult(messageText, err);
    fromGeneralReply = false;
  }
  result = mergeEscalation(result, messageText, false);
  if (handover.escalate) result = { ...result, escalate: true, escalateReason: result.escalateReason || handover.reason };
  // Already-known name/phone (e.g. the WhatsApp number itself) count as given.
  result = {
    ...result,
    customerName: result.customerName || identity?.knownName || parsedForm?.name || '',
    customerPhone: result.customerPhone || identity?.knownPhone || parsedForm?.phone || '',
    customerCity: result.customerCity || parsedForm?.city || '',
    customerBudget: result.customerBudget || parsedForm?.budget || '',
  };
  // FIX 1 + FIX 3 backstop: no repeated category question, no repeated
  // phone ask, "- Mannat" only on the first reply.
  if (!inviteAnswer?.result) {
    result = { ...result, reply: guards.cleanReply({ reply: result.reply, memory: existingMemory, message: messageText, knownPhone: result.customerPhone, isFirstReply: !ownMemory }) };
  }
  if (result.escalate) result = { ...result, reply: appendWorkingHoursNote(result.reply, messageText, existingMemory, result, platform, 'dm') };
  const cta = formRef ? { reply: result.reply, handoffId: '' } : await addHandoffCta({
    identity, reply: result.reply, messageText, existingMemory, memoryScope: 'conversation', memoryId,
    conversationId, platformUserId: conversation.participantId || senderHandle, isComment: false,
    hindi: looksHinglishOrHindi(messageText) || looksHinglishOrHindi(existingMemory),
    intent: aiContext.intent.intent, productInterest: result.productInterest || aiContext.product || '', customerName: result.customerName || '',
  });
  result = { ...result, reply: cta.reply };
  const invite = await maybeAppendInvite({
    identity, reply: result.reply, intent: aiContext.intent.intent, leadStatus: result.leadStatus,
    existingMemory, fromGeneralReply, escalated: Boolean(result.escalate),
    hadCta: Boolean(cta.handoffId || inviteAnswer?.handoffId || cta.wantsWhatsApp), hindi: dmHindi,
    knownName: result.customerName || '', knownPhone: result.customerPhone || '',
    blocked: Boolean(formRef) || aiContext.intent.intent === 'b2b_inquiry',
  });
  result = { ...result, reply: invite.reply };
  await saveCustomerFacts(identity, result, aiContext.product || '');
  let sendError = '';

  // FIX 6 / 8 / 15: one handoff per customer, to the right person.
  // (Worked out before sending so the customer can be told about it.)
  let trigger = handoffTrigger({ result, identity, inviteAnswer, cta, isComment: false });
  const extra = {};
  if (formRef) {
    trigger = trigger || (formRef.new ? 'Meta ad form lead - gemologist to call today' : '');
    extra.route = 'sales';
    if (parsedForm?.phone) extra.formPhone = parsedForm.phone;
    if (parsedForm) extra.productInterest = [parsedForm.requirement, parsedForm.purpose].filter(Boolean).join(' / ');
    if (!formRef.new && formLead.looksLikePreference(messageText)) extra.preference = messageText.slice(0, 200);
  }
  if (aiContext.intent.intent === 'b2b_inquiry') { extra.route = 'neel'; trigger = trigger || 'B2B / wholesale enquiry'; }
  if (callWindow.looksLikeCallRequest(messageText)) { extra.keySuffix = 'call'; trigger = 'CUSTOMER ASKED FOR A CALL - please call them'; }
  // 2026-10-21 (Ravi): tell the customer their requirement went to the team
  // (any time of day - after hours with the office timing). Once per chat.
  result = { ...result, reply: withForwardedLine(result.reply, { trigger, existingMemory, hindi: dmHindi }) };

  let stoppedForHuman = false;
  if (accountId && result.reply) {
    try {
      const idempotencyKey = messageId
        ? messageReplyIdempotencyKey({ conversationId, accountId, messageId })
        : undefined;
      // Added 2026-09-29 (Ravi): sent like a person chatting - 1-3 short
      // bubbles, natural pauses, "typing..." where supported. Each bubble is
      // registered with markAiSent BEFORE it is sent so the human-takeover
      // detector always recognises it as Mannat's, never as a team member's.
      const sentRes = await sendLikeHuman({
        reply: result.reply,
        typing: () => sendTypingIndicator({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId }),
        beforeSend: (text) => markAiSent(memoryId, text),
        // FIX 2026-10-16: a team member jumped in while Mannat was typing -
        // drop the rest of her reply rather than talk over them.
        shouldStop: () => isHumanActive(memoryId),
        send: (text, i) => sendConversationMessage({
          apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text,
          idempotencyKey: idempotencyKey ? (i === 0 ? idempotencyKey : `${idempotencyKey}-p${i}`) : undefined,
        }),
      });
      try { await markReplySent(replyKey); }
      catch (err) { console.error('[webhook] DM sent but Redis status update failed:', err.message); }
      if (sentRes?.stopped) {
        stoppedForHuman = true;
        const partial = (sentRes.bubbles || []).join('\n\n');
        console.log('[webhook] team member took over mid-reply - rest of Mannat reply dropped:', memoryId);
        result = { ...result, reply: partial };
      } else {
        await markAiSent(memoryId, result.reply);
      }
    } catch (err) {
      console.error('[webhook] sendConversationMessage failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
      result = mergeEscalation(result, messageText, true);
      await releaseReplySlot(replyKey);
    }
  } else {
    await releaseReplySlot(replyKey);
  }

  if (!sendError) {
    await saveTurn('conversation', memoryId, 'customer', messageText);
    if (result.reply) await saveTurn('conversation', memoryId, 'assistant', result.reply);
  }

  await logLead({
    platform, contact: senderHandle, type: messageType, message: messageText,
    reply: sendError ? '(send failed, see notes)' : (stoppedForHuman && !result.reply ? '(not sent - a team member replied while Mannat was typing)' : result.reply),
    leadStatus: result.leadStatus, productInterest: result.productInterest || aiContext.product,
    escalated: result.escalate || Boolean(sendError),
    notes: [result.escalateReason, `intent=${aiContext.intent.intent}`, aiContext.live.found ? 'live_product_data=found' : 'live_product_data=not_found', identityNotes(identity, cta.handoffId || inviteAnswer?.handoffId), invite.invited ? 'whatsapp_invite_asked' : '', inviteAnswer?.forward === 'whatsapp_yes' || inviteAnswer?.result ? 'whatsapp_invite_accepted' : '', inviteAnswer?.contextNote ? 'whatsapp_invite_declined' : '', formRef?.new ? 'meta_form_lead' : (formRef ? 'meta_form_lead_followup' : ''), parsedForm?.altPhone ? `form_gave_two_numbers(also:${parsedForm.altPhone})` : '', result.modelTier ? `model=${result.modelTier}` : '', result.safetyNet ? 'safety_net_reply' : '', stoppedForHuman ? 'human_takeover_mid_reply' : '', sendError].filter(Boolean).join(' | '),
    replySuggestion: result.replyImprovement || '',
  });

  // 2026-10-04 (Ravi): organic Instagram customers who gave their number ->
  // "Instagram Leads (Mannat)" tab in the Gemstone Meta Leads sheet.
  if (!sendError) {
    // 2026-10-17 audit: a return/complaint is a support case, not a HOT sale.
    const isSupportCase = aiContext.intent.intent === 'support_issue' || /return|refund|replace|exchange|damaged|wrong item|complaint/i.test(`${result.escalateReason || ''}`);
    await recordInstagramLead({
      platform, type: messageType, handle: senderHandle, customerId: identity?.grId || '',
      name: result.customerName, phone: result.customerPhone, city: result.customerCity,
      budget: result.customerBudget, interest: isSupportCase ? `SUPPORT: ${result.productInterest || 'return/complaint'}` : result.productInterest, leadStatus: isSupportCase ? 'SUPPORT (not a sale)' : result.leadStatus,
      isFormLead: Boolean(formRef),
    });
  }

  if (trigger) {
    await queueHandoff({ result, identity, platform, contact: senderHandle, memoryScope: 'conversation', memoryId, conversationId, accountId, intent: aiContext.intent.intent, trigger, extra });
  }

  // Report only a real, sales-qualified WhatsApp handoff as LeadSubmitted.
  // Never send a customer's budget as conversion revenue; metaTracking omits
  // value/currency for this event. Support/complaint cases are not leads.
  const supportCaseForMeta = aiContext.intent.intent === 'support_issue' ||
    /return|refund|replace|exchange|damaged|wrong item|complaint/i.test(String(result.escalateReason || ''));
  if (platform === 'whatsapp' && trigger && ['HOT', 'WARM'].includes(String(result.leadStatus || '').toUpperCase()) && !supportCaseForMeta) {
    try {
      const leadPhone = result.customerPhone || identity?.knownPhone || parsedForm?.phone || '';
      // Keep a short-lived source-account/conversation map so a later staff
      // "sold" command can report the purchase against the original customer chat.
      // This is attribution metadata only; it does not change sales routing.
      if (leadPhone && accountId && conversationId) {
        try {
          const attribution = JSON.stringify({ accountId: String(accountId), conversationId: String(conversationId), savedAt: Date.now() });
          await redisCommand(`/set/${encodeURIComponent(`gemrishi:meta-attribution:${String(leadPhone).replace(/\D/g, '').slice(-10)}`)}/${encodeURIComponent(attribution)}/EX/604800`);
        } catch (storeErr) {
          console.error('[meta] attribution map save failed (lead event may still send):', storeErr.message);
        }
      }
      const metaResult = await metaTracking.leadSubmitted({
        phone: leadPhone,
        conversationId,
        accountId,
        productInterest: result.productInterest || aiContext.product || extra.productInterest || '',
      });
      console.log('[meta] qualified lead conversion outcome', JSON.stringify({ sent: metaResult.sent, reason: metaResult.reason || '', traceId: metaResult.traceId || '' }));
    } catch (err) {
      // Conversion tracking must never break customer replies or lead handoff.
      console.error('[meta] qualified lead conversion threw:', err.message);
    }
  }
}

function inboundSafeId(event) {
  return crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 24);
}

// Ravi reported (2026-09-23) that Facebook DMs were still getting auto-replies
// even after the disable block below was live. Root cause: that check only
// matched the exact string "facebook", but Zernio (like most social APIs)
// can label a Facebook Page's DM inbox as "messenger" or similar instead of
// "facebook" - so the strict match silently missed those events and they
// fell through to the normal auto-reply path. This matches common variants
// case-insensitively so it can't be missed by a labelling difference again.
function isFacebookDmPlatform(platform) {
  const normalized = String(platform || '').trim().toLowerCase();
  return ['facebook', 'fb', 'messenger', 'facebook_messenger', 'fb_messenger', 'facebookmessenger'].includes(normalized);
}

// test hooks (2026-10-07)
module.exports._productQueryWithContext = productQueryWithContext;
module.exports._handoffTrigger = handoffTrigger;
module.exports._shouldDmCommenter = shouldDmCommenter;
module.exports._whatsappEntrySignal = whatsappEntrySignal;
module.exports._contactNumberFor = contactNumberFor;
module.exports._conversationAdSignal = conversationAdSignal;
module.exports._commentDmPublicReply = commentDmPublicReply;
module.exports._WHATSAPP_SHORT_NOTE = WHATSAPP_SHORT_NOTE;
module.exports._withForwardedLine = withForwardedLine;
module.exports._appendWorkingHoursNote = appendWorkingHoursNote;
module.exports._adContextNote = adContextNote;
module.exports._formLeadDedupeKey = formLeadDedupeKey;
