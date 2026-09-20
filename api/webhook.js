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

async function claimEvent(key, ttlSeconds = 86400) {
  const redisUrl = process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL;
  const redisToken = process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN;
  if (!redisUrl || !redisToken) return true;
  const url = redisUrl.replace(/\/$/, '') + `/set/${encodeURIComponent(`gemrishi:webhook:${key}`)}/1/EX/${ttlSeconds}/NX`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${redisToken}` } });
  if (!res.ok) throw new Error(`Redis dedupe error ${res.status}`);
  const data = await res.json();
  return data?.result === 'OK';
}

async function loadContext(scope, id) {
  try {
    const turns = await getMemory(scope, id);
    return formatMemory(turns);
  } catch (err) {
    console.error('[webhook] memory read failed:', err.message);
    return '';
  }
}

async function saveTurn(scope, id, role, text) {
  try {
    await addTurn(scope, id, { role, text });
  } catch (err) {
    console.error('[webhook] memory write failed:', err.message);
  }
}

async function buildAIContext(messageText, type, platform, existingMemory, postCaption = '') {
  const intent = classifyIntent(messageText);
  const product = extractProduct(messageText);
  const live = await lookupLiveProduct(product || messageText);
  const liveData = formatLiveProductData(live);
  const parts = [
    `INTENT: ${intent.intent} (confidence ${intent.confidence})`,
    product ? `PRODUCT: ${product}` : 'PRODUCT: not explicitly identified',
    existingMemory ? `RECENT CONVERSATION:\n${existingMemory}` : 'RECENT CONVERSATION: none',
  ];
  if (postCaption) parts.push(`POST CONTEXT: ${postCaption}`);
  return { contextText: parts.join('\n\n'), liveProductData: liveData, intent, product, live };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch { return res.status(400).json({ error: 'Unable to read request body' }); }

  const signature = req.headers['x-late-signature'] || req.headers['x-zernio-signature'];
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (secret && !verifyWebhookSignature({ rawBody, signatureHeader: signature, secret })) return res.status(401).json({ error: 'Invalid signature' });
  if (!secret && process.env.NODE_ENV === 'production') return res.status(503).json({ error: 'Webhook secret is not configured' });

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const key = stableInboundKey(body, rawBody);
  try {
    const claimed = await claimEvent(key);
    if (!claimed) {
      console.log('[webhook] ignored duplicate inbound action:', key);
      return res.status(200).json({ received: true, duplicate: true });
    }
  } catch (err) {
    console.error('[webhook] dedupe unavailable; refusing to auto-reply:', err.message);
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
  const eventType = event?.event;
  if (eventType === 'comment.received') return handleComment(event);
  if (eventType === 'message.received') return handleMessage(event);
  console.log('[webhook] ignored event type:', eventType);
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

  const memoryScope = 'comment';
  const memoryId = `${platform || 'social'}:${authorHandle}:${postId || 'unknown'}`;
  const existingMemory = await loadContext(memoryScope, memoryId);
  const aiContext = await buildAIContext(commentText, 'comment', platform, existingMemory, postCaption);

  const result = await generateReply({
    platform,
    type: 'comment',
    message: commentText,
    contextText: aiContext.contextText,
    liveProductData: aiContext.liveProductData,
  });
  let sendError = '';

  if (postId && accountId && result.reply) {
    try {
      await replyToComment({ apiKey: process.env.ZERNIO_API_KEY, postId, accountId, commentId, text: result.reply });
    } catch (err) {
      console.error('[webhook] replyToComment failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
    }
  }

  if (!sendError) {
    await saveTurn(memoryScope, memoryId, 'customer', commentText);
    await saveTurn(memoryScope, memoryId, 'assistant', result.reply);
  }

  await logLead({
    platform,
    contact: authorHandle,
    type: 'comment',
    message: commentText,
    reply: sendError ? '(send failed, see notes)' : result.reply,
    leadStatus: result.leadStatus,
    productInterest: result.productInterest || aiContext.product,
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

  const memoryScope = 'conversation';
  const existingMemory = await loadContext(memoryScope, `${platform || 'social'}:${conversationId}`);
  const aiContext = await buildAIContext(messageText, platform === 'whatsapp' ? 'whatsapp' : 'dm', platform, existingMemory);

  const result = await generateReply({
    platform,
    type: platform === 'whatsapp' ? 'whatsapp' : 'dm',
    message: messageText,
    contextText: aiContext.contextText,
    liveProductData: aiContext.liveProductData,
  });
  let sendError = '';

  if (accountId && result.reply) {
    try {
      await sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text: result.reply });
    } catch (err) {
      console.error('[webhook] sendConversationMessage failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
    }
  }

  if (!sendError) {
    await saveTurn(memoryScope, `${platform || 'social'}:${conversationId}`, 'customer', messageText);
    await saveTurn(memoryScope, `${platform || 'social'}:${conversationId}`, 'assistant', result.reply);
  }

  await logLead({
    platform,
    contact: senderHandle,
    type: platform === 'whatsapp' ? 'whatsapp' : 'dm',
    message: messageText,
    reply: sendError ? '(send failed, see notes)' : result.reply,
    leadStatus: result.leadStatus,
    productInterest: result.productInterest || aiContext.product,
    escalated: result.escalate || Boolean(sendError),
    notes: [result.escalateReason, `intent=${aiContext.intent.intent}`, aiContext.live.found ? 'live_product_data=found' : 'live_product_data=not_found', sendError].filter(Boolean).join(' | '),
  });
}
