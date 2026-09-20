const crypto = require('crypto');
const {
  verifyWebhookSignature,
  replyToComment,
  sendConversationMessage,
} = require('../lib/zernioClient');
const { generateReply } = require('../lib/replyEngine');
const { logLead } = require('../lib/leadLog');
const { classifyIntent, extractProduct } = require('../lib/intentRouter');
const { getMemory, addTurn, formatMemory } = require('../lib/memoryStore');
const { lookupLiveProduct, formatLiveProductData } = require('../lib/productResolver');

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

async function markReplySent(key) {
  await redisCommand(`/set/${encodeURIComponent(`gemrishi:reply-sent:${key}`)}/1/EX/604800`);
  await redisCommand(`/del/${encodeURIComponent(`gemrishi:reply-processing:${key}`)}`);
}

async function releaseReplySlot(key) {
  try { await redisCommand(`/del/${encodeURIComponent(`gemrishi:reply-processing:${key}`)}`); } catch (err) { console.error('[webhook] failed to release reply slot:', err.message); }
}

async function loadContext(scope, id) {
  try { return formatMemory(await getMemory(scope, id)); }
  catch (err) { console.error('[webhook] memory read failed:', err.message); return ''; }
}

async function saveTurn(scope, id, role, text) {
  try { await addTurn(scope, id, { role, text }); }
  catch (err) { console.error('[webhook] memory write failed:', err.message); }
}

async function buildAIContext(messageText, platform, existingMemory, postCaption = '') {
  const intent = classifyIntent(messageText);
  const product = extractProduct(messageText);
  const live = await lookupLiveProduct(product || messageText);
  const parts = [
    `INTENT: ${intent.intent} (confidence ${intent.confidence})`,
    product ? `PRODUCT: ${product}` : 'PRODUCT: not explicitly identified',
    existingMemory ? `RECENT CONVERSATION:\n${existingMemory}` : 'RECENT CONVERSATION: none',
  ];
  if (postCaption) parts.push(`POST CONTEXT: ${postCaption}`);
  return { contextText: parts.join('\n\n'), liveProductData: formatLiveProductData(live), intent, product, live };
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
    console.error('[webhook] duplicate protection unavailable; refusing to auto-reply:', err.message);
    return res.status(503).json({ received: true, processed: false, error: 'Duplicate protection unavailable' });
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

  let slot;
  try {
    slot = await claimReplySlot(`comment:${commentId || inboundSafeId(event)}`);
    if (!slot.allowed) {
      console.log('[webhook] reply suppressed:', slot.reason, commentId || 'unknown');
      return;
    }
  } catch (err) {
    console.error('[webhook] reply gate unavailable:', err.message);
    return;
  }

  const memoryId = `${platform || 'social'}:${authorHandle}:${postId || 'unknown'}`;
  const existingMemory = await loadContext('comment', memoryId);
  const aiContext = await buildAIContext(commentText, platform, existingMemory, postCaption);
  const result = await generateReply({ platform, type: 'comment', message: commentText, contextText: aiContext.contextText, liveProductData: aiContext.liveProductData });
  let sendError = '';

  if (postId && accountId && result.reply) {
    try {
      await replyToComment({ apiKey: process.env.ZERNIO_API_KEY, postId, accountId, commentId, text: result.reply });
      await markReplySent(`comment:${commentId || inboundSafeId(event)}`);
    } catch (err) {
      console.error('[webhook] replyToComment failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
      await releaseReplySlot(`comment:${commentId || inboundSafeId(event)}`);
    }
  } else {
    await releaseReplySlot(`comment:${commentId || inboundSafeId(event)}`);
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
}

async function handleMessage(event) {
  const message = event.message || {};
  const conversation = event.conversation || {};
  const account = event.account || {};
  if (event.metadata?.standby || message.metadata?.standby) return;

  const platform = account.platform || conversation.platform;
  const accountId = account.accountId || account.id;
  const conversationId = conversation.id || conversation.conversationId;
  const messageText = message.text || message.message || '';
  const senderHandle = conversation.participantUsername || conversation.participantName || message.contactId || 'unknown';
  if (!messageText || !conversationId) return;

  let slot;
  try {
    slot = await claimReplySlot(`message:${message.id || message.messageId || crypto.createHash('sha256').update(`${conversationId}|${messageText}`).digest('hex')}`);
    if (!slot.allowed) {
      console.log('[webhook] message reply suppressed:', slot.reason);
      return;
    }
  } catch (err) {
    console.error('[webhook] message reply gate unavailable:', err.message);
    return;
  }

  const memoryId = `${platform || 'social'}:${conversationId}`;
  const existingMemory = await loadContext('conversation', memoryId);
  const aiContext = await buildAIContext(messageText, platform, existingMemory);
  const result = await generateReply({ platform, type: platform === 'whatsapp' ? 'whatsapp' : 'dm', message: messageText, contextText: aiContext.contextText, liveProductData: aiContext.liveProductData });
  let sendError = '';
  const replyKey = `message:${message.id || message.messageId || crypto.createHash('sha256').update(`${conversationId}|${messageText}`).digest('hex')}`;

  if (accountId && result.reply) {
    try {
      await sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text: result.reply });
      await markReplySent(replyKey);
    } catch (err) {
      console.error('[webhook] sendConversationMessage failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
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
    platform, contact: senderHandle, type: platform === 'whatsapp' ? 'whatsapp' : 'dm', message: messageText,
    reply: sendError ? '(send failed, see notes)' : result.reply,
    leadStatus: result.leadStatus, productInterest: result.productInterest || aiContext.product,
    escalated: result.escalate || Boolean(sendError),
    notes: [result.escalateReason, `intent=${aiContext.intent.intent}`, aiContext.live.found ? 'live_product_data=found' : 'live_product_data=not_found', sendError].filter(Boolean).join(' | '),
  });
}

function inboundSafeId(event) {
  return crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 24);
}
