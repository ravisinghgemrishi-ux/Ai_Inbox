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

const LINKED_CONTEXT_TURNS = 8;

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
      return customer ? { grId: customer.grId, channel, matchStatus: customer.created ? 'new_customer' : 'returning_customer' } : null;
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
      contextNote,
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

function identityNotes(identity, handoffId) {
  if (!identity) return '';
  return [`gr=${identity.grId}`, identity.matchStatus ? `match=${identity.matchStatus}` : '', handoffId || identity.handoffId ? `handoff=${handoffId || identity.handoffId}` : '']
    .filter(Boolean).join(' ');
}

module.exports = { prepareInbound, addHandoffCta, identityNotes, channelOf };
