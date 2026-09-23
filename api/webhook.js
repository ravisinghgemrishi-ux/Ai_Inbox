const crypto = require('crypto');
const {
  verifyWebhookSignature,
  replyToComment,
  sendConversationMessage,
  messageReplyIdempotencyKey,
} = require('../lib/zernioClient');
const { generateReply } = require('../lib/replyEngine');
const { logLead } = require('../lib/leadLog');
const { classifyIntent, extractProduct } = require('../lib/intentRouter');
const { getMemory, addTurn, formatMemory } = require('../lib/memoryStore');
const { lookupLiveProduct, formatLiveProductData } = require('../lib/productResolver');
const { mergeEscalation } = require('../lib/escalationPolicy');
const { notifyEscalation } = require('../lib/escalationNotifier');
const { maybeHandleKundliTurn } = require('../lib/kundliFlow');
const { maybeHandleConsultationPayment } = require('../lib/consultationFlow');

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

async function buildAIContext(messageText, platform, existingMemory, postCaption = '') {
  const intent = classifyIntent(messageText);
  const product = extractProduct(messageText);
  const live = await lookupLiveProduct(product || messageText);
  const parts = [
    `INTENT: ${intent.intent} (confidence ${intent.confidence})`,
    product ? `PRODUCT: ${product}` : 'PRODUCT: not explicitly identified',
    existingMemory ? `RECENT CONVERSATION:\n${existingMemory}` : 'RECENT CONVERSATION: none',
  ];
  if (existingMemory && WHATSAPP_NUMBER_PATTERN.test(existingMemory)) {
    parts.push('NOTE: You already shared the WhatsApp consultation number earlier in this conversation - do not paste it again in this reply unless the customer explicitly asks for it a second time.');
  }
  if (postCaption) parts.push(`POST CONTEXT: ${postCaption}`);
  return { contextText: parts.join('\n\n'), liveProductData: formatLiveProductData(live), intent, product, live };
}

async function sendEscalationAlert(result, details) {
  if (!result?.escalate) return;
  try {
    await notifyEscalation({ ...details, reason: result.escalateReason, leadStatus: result.leadStatus, productInterest: result.productInterest });
  } catch (err) {
    console.error('[escalation] alert failed; lead remains logged:', err.message);
  }
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

  const inboundKey = stableInboundKey(body, rawBody);
  try {
    const claimed = await claimInbound(inboundKey);
    if (!claimed) {
      console.log('[webhook] ignored duplicate inbound action:', inboundKey);
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (err) {
    console.error('[webhook] duplicate protection unavailable; continuing with reply:', err.message);
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

async function handleEvent(event) {
  if (event?.event === 'comment.received') return handleComment(event);
  if (event?.event === 'message.received') return handleMessage(event);
  console.log('[webhook] ignored event type:', event?.event);
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

  const existingMemory = await loadContext('comment', memoryId);
  const aiContext = await buildAIContext(commentText, platform, existingMemory, postCaption);
  let result = await generateReply({ platform, type: 'comment', message: commentText, contextText: aiContext.contextText, liveProductData: aiContext.liveProductData });
  result = mergeEscalation(result, commentText, false);
  let sendError = '';

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
    await saveTurn('comment', memoryId, 'assistant', result.reply);
  }

  await logLead({
    platform, contact: authorHandle, type: 'comment', message: commentText,
    reply: sendError ? '(send failed, see notes)' : result.reply,
    leadStatus: result.leadStatus, productInterest: result.productInterest || aiContext.product,
    escalated: result.escalate || Boolean(sendError),
    notes: [result.escalateReason, `intent=${aiContext.intent.intent}`, aiContext.live.found ? 'live_product_data=found' : 'live_product_data=not_found', sendError].filter(Boolean).join(' | '),
  });

  await sendEscalationAlert(result, {
    platform, contact: authorHandle, type: 'comment', message: commentText,
    reply: sendError ? '(send failed, see notes)' : result.reply,
  });
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
  const messageText = message.text || message.message || '';
  const senderHandle = conversation.participantUsername || conversation.participantName || message.contactId || 'unknown';
  if (!messageText || !conversationId) return;

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
  const existingMemory = await loadContext('conversation', memoryId);
  const aiContext = await buildAIContext(messageText, platform, existingMemory);

  // Mannat 2.0: an isolated, additive branch (see lib/kundliFlow.js) that
  // only ever engages when ENABLE_KUNDLI_FLOW=true. It returns null when
  // not applicable, and the normal replyEngine path below runs unchanged -
  // this line is the ENTIRE footprint of that feature on the live flow.
  let result = await maybeHandleKundliTurn({
    enabled: process.env.ENABLE_KUNDLI_FLOW === 'true',
    type: messageType,
    memoryId,
    message: messageText,
    intent: aiContext.intent,
  });
  // Consultation-plan payment flow (see lib/consultationFlow.js) - live by
  // default, independent of the Kundli flow above. Only engages when the
  // customer names a specific paid plan; otherwise it returns null and the
  // normal replyEngine path below runs unchanged.
  if (!result) {
    result = await maybeHandleConsultationPayment({
      enabled: process.env.ENABLE_CONSULTATION_PAYMENT_FLOW !== 'false',
      type: messageType,
      memoryId,
      message: messageText,
      intent: aiContext.intent,
    });
  }
  if (!result) {
    result = await generateReply({ platform, type: messageType, message: messageText, contextText: aiContext.contextText, liveProductData: aiContext.liveProductData });
  }
  result = mergeEscalation(result, messageText, false);
  let sendError = '';

  if (accountId && result.reply) {
    try {
      const idempotencyKey = messageId
        ? messageReplyIdempotencyKey({ conversationId, accountId, messageId })
        : undefined;
      await sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text: result.reply, idempotencyKey });
      try { await markReplySent(replyKey); }
      catch (err) { console.error('[webhook] DM sent but Redis status update failed:', err.message); }
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
    await saveTurn('conversation', memoryId, 'assistant', result.reply);
  }

  await logLead({
    platform, contact: senderHandle, type: messageType, message: messageText,
    reply: sendError ? '(send failed, see notes)' : result.reply,
    leadStatus: result.leadStatus, productInterest: result.productInterest || aiContext.product,
    escalated: result.escalate || Boolean(sendError),
    notes: [result.escalateReason, `intent=${aiContext.intent.intent}`, aiContext.live.found ? 'live_product_data=found' : 'live_product_data=not_found', sendError].filter(Boolean).join(' | '),
  });

  await sendEscalationAlert(result, {
    platform, contact: senderHandle, type: messageType, message: messageText,
    reply: sendError ? '(send failed, see notes)' : result.reply,
  });
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
