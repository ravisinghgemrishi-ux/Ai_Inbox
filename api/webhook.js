const crypto = require('crypto');
const {
  verifyWebhookSignature,
  replyToComment,
  sendConversationMessage,
} = require('../lib/zernioClient');
const { generateReply } = require('../lib/replyEngine');
const { logLead } = require('../lib/leadLog');

module.exports.config = { api: { bodyParser: false } };

function eventKey(event, rawBody) {
  return String(
    event?.id ||
    event?.eventId ||
    event?.webhookEventId ||
    event?.comment?.id ||
    event?.message?.id ||
    crypto.createHash('sha256').update(rawBody).digest('hex'),
  );
}

async function claimEvent(key) {
  // Redis is optional; without it the handler still works, but duplicate protection is unavailable.
  const redisUrl = process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL;
  const redisToken = process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN;
  if (!redisUrl || !redisToken) return true;

  const url = redisUrl.replace(/\/$/, '') + `/set/${encodeURIComponent(`gemrishi:webhook:${key}`)}/1/EX/86400/NX`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${redisToken}` },
  });
  if (!res.ok) throw new Error(`Redis dedupe error ${res.status}`);
  const data = await res.json();
  return data?.result === 'OK';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Unable to read request body' });
  }

  const signature = req.headers['x-late-signature'] || req.headers['x-zernio-signature'];
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;

  // Production webhooks must be signed. Never accept an unsigned event when a secret is configured.
  if (secret && !verifyWebhookSignature({ rawBody, signatureHeader: signature, secret })) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!secret && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Webhook secret is not configured' });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    const claimed = await claimEvent(eventKey(body, rawBody));
    if (!claimed) return res.status(200).json({ received: true, duplicate: true });
  } catch (err) {
    // Redis failure must not make the inbound webhook silently disappear.
    console.error('[webhook] dedupe unavailable:', err.message);
  }

  // Keep the response fast for Zernio, but do not intentionally detach processing.
  // Vercel will keep the function alive while this promise is awaited.
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
  if (!commentText) return;

  const result = await generateReply({ platform, type: 'comment', message: commentText, contextText: postCaption });
  let sendError = '';

  if (!result.escalate && postId && accountId) {
    try {
      await replyToComment({ apiKey: process.env.ZERNIO_API_KEY, postId, accountId, commentId, text: result.reply });
    } catch (err) {
      console.error('[webhook] replyToComment failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
    }
  }

  await logLead({
    platform,
    contact: authorHandle,
    type: 'comment',
    message: commentText,
    reply: result.escalate ? '(held for human review)' : sendError ? '(send failed, see notes)' : result.reply,
    leadStatus: result.leadStatus,
    productInterest: result.productInterest,
    escalated: result.escalate || Boolean(sendError),
    notes: result.escalateReason || sendError,
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

  const result = await generateReply({ platform, type: platform === 'whatsapp' ? 'whatsapp' : 'dm', message: messageText });
  let sendError = '';

  if (!result.escalate && accountId) {
    try {
      await sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text: result.reply });
    } catch (err) {
      console.error('[webhook] sendConversationMessage failed:', err.message);
      sendError = `Reply send failed: ${err.message}`;
    }
  }

  await logLead({
    platform,
    contact: senderHandle,
    type: platform === 'whatsapp' ? 'whatsapp' : 'dm',
    message: messageText,
    reply: result.escalate ? '(held for human review)' : sendError ? '(send failed, see notes)' : result.reply,
    leadStatus: result.leadStatus,
    productInterest: result.productInterest,
    escalated: result.escalate || Boolean(sendError),
    notes: result.escalateReason || sendError,
  });
}
