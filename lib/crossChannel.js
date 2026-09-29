// =============================================================================
// crossChannel.js — thin layer between api/webhook.js and identityBridge.js
//
// Added 2026-09-29 (Ravi). Keeps the webhook change to a handful of lines:
//   prepareInbound()   -> who is this customer (GR id), and for WhatsApp,
//                         what did they already discuss on Instagram
//   addHandoffCta()    -> if an Instagram customer asks for WhatsApp, append
//                         a customer-specific wa.me link to Mannat's reply
//
// Both functions return null / the unchanged reply when
// ENABLE_IDENTITY_BRIDGE is not "true", or on ANY error — so with the switch
// off (or Redis unhappy) Mannat behaves exactly as it did before.
// =============================================================================

const bridge = require('./identityBridge');
const { getMemory, formatMemory } = require('./memoryStore');

// Was 8 (2026-09-29 live test): Anil's Instagram chat had 12 messages and
// "my name is Rahul" was message 3, so it was cut off before WhatsApp saw it.
// Now carries the whole stored chat (memoryStore keeps the last 12).
const LINKED_CONTEXT_TURNS = 12;

function factsNote(f = {}) {
  const lines = [
    f.name && `- Name: ${f.name}`,
    f.phone && `- Phone: ${f.phone}`,
    f.city && `- City: ${f.city}`,
    f.product_interest && `- Interested in: ${f.product_interest}`,
    f.budget && `- Budget: ${f.budget}`,
    f.purpose && `- Purpose: ${f.purpose}`,
  ].filter(Boolean);
  if (!lines.length) return '';
  return `KNOWN CUSTOMER FACTS (told to us earlier, possibly on another channel - treat as true, use naturally, never ask for these again):\n${lines.join('\n')}`;
}

function channelOf(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('whatsapp')) return 'whatsapp';
  if (p.includes('instagram') || p === 'ig') return 'instagram';
  if (p.includes('facebook') || p === 'fb') return 'facebook';
  return p || 'social';
}

async function prepareInbound({ platform, event, messageText, conversationId, platformUserId, handle }) {
  if (!bridge.isEnabled()) return null;
  try {
    const channel = channelOf(platform);

    if (channel !== 'whatsapp') {
      const customer = await bridge.getOrCreateCustomer(channel, platformUserId || handle, { handle });
      if (!customer) return null;
      const facts = customer.created ? {} : await bridge.getCustomerFacts(customer.grId);
      return {
        grId: customer.grId, channel,
        matchStatus: customer.created ? 'new_customer' : 'returning_customer',
        contextNote: factsNote(facts),
      };
    }

    const resolved = await bridge.resolveWhatsAppCustomer({ event, messageText, conversationId });
    if (!resolved?.grId) return null;

    // Shared memory: pull the recent Instagram conversation(s) this customer
    // is linked to, so the WhatsApp chat continues from there.
    const profile = await bridge.getCustomer(resolved.grId);
    const contexts = (profile?.linked_contexts || []).slice(-2);
    const memoryBlocks = [];
    const notes = [];
    for (const ctx of contexts) {
      try {
        const turns = (await getMemory(ctx.scope, ctx.memoryId)).slice(-LINKED_CONTEXT_TURNS);
        if (turns.length) memoryBlocks.push(formatMemory(turns));
      } catch (err) {
        console.error('[crossChannel] linked memory read failed:', err.message);
      }
      notes.push(`came from ${ctx.channel}${ctx.is_public_comment ? ' (a comment on a post)' : ' (DM)'}`
        + (ctx.product_interest ? `, interested in: ${ctx.product_interest}` : ''));
    }

    let contextNote = '';
    if (resolved.matchStatus === 'linked') {
      contextNote = `CUSTOMER CONTINUITY: This customer just moved from ${resolved.handoff.source_channel} to WhatsApp using their personal handoff link, so this is the SAME customer as the earlier conversation shown in RECENT CONVERSATION. Welcome them warmly on WhatsApp, continue from where the earlier chat left off, and do NOT ask again for details they already gave. Their message contains a reference code like WH-XXXXXXX: ignore it, never repeat it back.`;
    } else if (notes.length) {
      contextNote = `CUSTOMER CONTINUITY: Returning customer who earlier ${notes.join('; ')}. Earlier messages are in RECENT CONVERSATION; continue naturally.`;
    } else if (resolved.token) {
      // Token present but not accepted (expired / invalid / already used /
      // conflict). Never merge; just be helpful from scratch.
      contextNote = 'NOTE: The customer\'s message contains a reference code like WH-XXXXXXX that could not be matched to an earlier conversation. Do not mention the code. Greet them, and politely ask what they were looking for so you can help.';
    }

    return {
      grId: resolved.grId,
      channel,
      matchStatus: resolved.matchStatus,
      handoffId: resolved.token || '',
      linkedMemoryText: memoryBlocks.join('\n'),
      contextNote: [factsNote(await bridge.getCustomerFacts(resolved.grId)), contextNote].filter(Boolean).join('\n\n'),
    };
  } catch (err) {
    console.error('[crossChannel] prepareInbound failed; continuing without identity:', err.message);
    return null;
  }
}

async function addHandoffCta({
  identity, reply, messageText, existingMemory = '', memoryScope, memoryId, conversationId = '',
  platformUserId = '', commentId = '', postId = '', isComment = false, hindi = false,
  intent = '', productInterest = '', customerName = '',
}) {
  const unchanged = { reply, handoffId: '' };
  if (!bridge.isEnabled() || !identity?.grId || identity.channel === 'whatsapp') return unchanged;
  if (!reply || !bridge.wantsWhatsApp(messageText)) return unchanged;
  if (/wa\.me\//i.test(reply)) return unchanged; // never two links in one reply
  try {
    const summary = [existingMemory.split('\n').slice(-6).join('\n'), `Customer: ${messageText}`].filter(Boolean).join('\n');
    const handoff = await bridge.createHandoff({
      grId: identity.grId,
      sourceChannel: identity.channel,
      sourcePlatformUserId: platformUserId,
      sourceConversationId: conversationId,
      sourceMemoryScope: memoryScope,
      sourceMemoryId: memoryId,
      sourceCommentId: commentId,
      sourcePostId: postId,
      isPublicComment: isComment,
      intent,
      productInterest,
      customerName,
      conversationSummary: summary,
    });
    if (!handoff) return unchanged; // safe fallback: normal reply, no broken CTA
    const cta = bridge.handoffCtaText(handoff.handoff_id, { hindi, isComment });
    return { reply: `${reply}\n\n${cta}`, handoffId: handoff.handoff_id };
  } catch (err) {
    console.error('[crossChannel] handoff creation failed; sending normal reply:', err.message);
    return unchanged;
  }
}

// After every reply: remember what the customer told us, on their GR profile.
async function saveCustomerFacts(identity, result, fallbackProduct = '') {
  if (!bridge.isEnabled() || !identity?.grId || !result) return;
  try {
    await bridge.updateCustomerFacts(identity.grId, {
      name: result.customerName,
      phone: result.customerPhone,
      city: result.customerCity,
      budget: result.customerBudget,
      purpose: result.customerPurpose,
      product_interest: result.productInterest || fallbackProduct,
    });
  } catch (err) {
    console.error('[crossChannel] saving customer facts failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// WhatsApp invitation (added 2026-09-29, Ravi)
// Mannat gently asks ONCE per customer to continue on WhatsApp - never in the
// first reply, only once the customer shows real interest - then waits for
// their answer. Yes -> personal WhatsApp link (the customer messages first,
// so we get their number, linked to their Instagram chat). No / no answer ->
// carry on normally, never ask again. Honest reasons only.
// ---------------------------------------------------------------------------
const INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;
const INTEREST_INTENTS = new Set(['price', 'purchase', 'product_info', 'recommendation', 'consultation', 'authenticity']);
const YES_PATTERN = /^\s*(yes|yeah|yep|ya|yup|ok|okay|okk+|sure|haan|han|ha|haa|hanji|haan ji|ji|ji haan|ji ha|theek hai|thik hai|chalo|bilkul|zaroor|jarur|done|👍|go ahead|why not)\b[\s!.🙂😊👍🙏]*$/i;
const NO_PATTERN = /^\s*(no|nope|nah|nahi|nhi|nahin|na|not now|later|baad mein|abhi nahi|yahin|yahi|here is fine|here only|yahin theek|instagram pe hi|dm pe hi)\b/i;

const INVITE_EN = "By the way, would it be okay to continue on WhatsApp? It's easier for me to share product links and certificate details there, and our team can follow up with you personally 😊";
const INVITE_HI = 'Waise, kya hum WhatsApp par baat continue karein? Wahan main product links aur certificate details aasani se share kar paungi, aur humari team bhi aapko personally help kar payegi 😊';
// Comments: public, links not clickable, no back-and-forth - one soft line.
const COMMENT_INVITE_EN = 'For full details, feel free to message us on WhatsApp: +91 98179 75977 😊';
const COMMENT_INVITE_HI = 'Poori details ke liye aap humein WhatsApp par message kar sakte hain: +91 98179 75977 😊';

function inviteKey(grId) { return `gemrishi:gr:wa-invite:${grId}`; }

async function inviteState(grId) {
  const { url, token } = { url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''), token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '' };
  if (!url || !token) return null;
  const res = await fetch(`${url}/get/${encodeURIComponent(inviteKey(grId))}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  const d = await res.json().catch(() => ({}));
  return d?.result || null;
}

async function setInviteState(grId, state) {
  const url = (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, '');
  const token = process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '';
  if (!url || !token) return;
  const res = await fetch(`${url}/set/${encodeURIComponent(inviteKey(grId))}/${encodeURIComponent(state)}/EX/${INVITE_TTL_SECONDS}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  await res.json().catch(() => ({}));
}

function inviteEnabled() {
  return bridge.isEnabled() && process.env.WHATSAPP_INVITE !== 'false';
}

// BEFORE the AI reply: is this the customer's answer to our invitation?
// Returns { result } to send instead of an AI reply (they said yes),
// { contextNote } (they said no), or null (anything else - carry on).
async function handleInviteAnswer({ identity, messageText, existingMemory = '', memoryScope, memoryId, conversationId = '', platformUserId = '', hindi = false }) {
  if (!inviteEnabled() || !identity?.grId || identity.channel === 'whatsapp') return null;
  try {
    if ((await inviteState(identity.grId)) !== 'asked') return null;
    const text = String(messageText || '').trim();
    if (YES_PATTERN.test(text)) {
      const handoff = await bridge.createHandoff({
        grId: identity.grId, sourceChannel: identity.channel, sourcePlatformUserId: platformUserId,
        sourceConversationId: conversationId, sourceMemoryScope: memoryScope, sourceMemoryId: memoryId,
        intent: 'whatsapp_invite_accepted',
        conversationSummary: [existingMemory.split('\n').slice(-6).join('\n'), `Customer: ${text}`].filter(Boolean).join('\n'),
      });
      if (!handoff) return null; // safe fallback: normal reply
      await setInviteState(identity.grId, 'accepted');
      const lead = hindi ? 'Bahut badhiya! 😊' : 'Great! 😊';
      return {
        result: {
          reply: `${lead}\n\n${bridge.handoffCtaText(handoff.handoff_id, { hindi })}`,
          leadStatus: 'HOT', productInterest: '', escalate: false, escalateReason: '',
        },
        handoffId: handoff.handoff_id,
      };
    }
    if (NO_PATTERN.test(text)) {
      await setInviteState(identity.grId, 'declined');
      return { contextNote: 'NOTE: The customer prefers to continue chatting here rather than on WhatsApp. Respect that completely: acknowledge briefly if natural, help them fully here, and never suggest WhatsApp again.' };
    }
    // Anything else (a new question, ignoring it): carry on, never re-ask.
    await setInviteState(identity.grId, 'no_answer');
    return null;
  } catch (err) {
    console.error('[crossChannel] invite answer check failed; normal reply:', err.message);
    return null;
  }
}

// AFTER the AI reply: add the one-time invitation line if the moment is right.
async function maybeAppendInvite({ identity, reply, intent = '', leadStatus = '', existingMemory = '', isComment = false, fromGeneralReply = true, escalated = false, hadCta = false, hindi = false }) {
  const unchanged = { reply, invited: false };
  if (!inviteEnabled() || !identity?.grId || identity.channel === 'whatsapp' || !reply) return unchanged;
  if (!fromGeneralReply || escalated || hadCta) return unchanged;
  const earlierCustomerTurns = (String(existingMemory).match(/^Customer:/gm) || []).length;
  if (!isComment && earlierCustomerTurns < 1) return unchanged; // DMs: never in the first reply
  const interested = INTEREST_INTENTS.has(intent) || leadStatus === 'HOT' || (!isComment && earlierCustomerTurns >= 3);
  if (!interested) return unchanged;
  if (/whats\s*app|wa\.me/i.test(reply)) return unchanged; // reply already mentions WhatsApp
  try {
    if (await inviteState(identity.grId)) return unchanged; // asked before, whatever the answer
    const profile = await bridge.getCustomer(identity.grId);
    if ((profile?.channels?.whatsapp || []).length) return unchanged; // already on WhatsApp
    if (isComment) {
      await setInviteState(identity.grId, 'comment_invited'); // no answer expected
      return { reply: `${reply}\n\n${hindi ? COMMENT_INVITE_HI : COMMENT_INVITE_EN}`, invited: true };
    }
    await setInviteState(identity.grId, 'asked');
    return { reply: `${reply}\n\n${hindi ? INVITE_HI : INVITE_EN}`, invited: true };
  } catch (err) {
    console.error('[crossChannel] invite check failed; reply unchanged:', err.message);
    return unchanged;
  }
}

function identityNotes(identity, handoffId) {
  if (!identity) return '';
  return [`gr=${identity.grId}`, identity.matchStatus ? `match=${identity.matchStatus}` : '', handoffId || identity.handoffId ? `handoff=${handoffId || identity.handoffId}` : '']
    .filter(Boolean).join(' ');
}

module.exports = { prepareInbound, addHandoffCta, saveCustomerFacts, handleInviteAnswer, maybeAppendInvite, identityNotes, channelOf };
