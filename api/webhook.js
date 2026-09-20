const {
  verifyWebhookSignature,
  replyToComment,
  sendConversationMessage,
} = require('../lib/zernioClient');
const { generateReply } = require('../lib/replyEngine');
const { logLead } = require('../lib/leadLog');

module.exports.config = { api: { bodyParser: false } };

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-late-signature'] || req.headers['x-zernio-signature'];

  const validSignature = verifyWebhookSignature({
    rawBody,
    signatureHeader: signature,
    secret: process.env.ZERNIO_WEBHOOK_SECRET,
  });

  if (!validSignature) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  res.status(200).json({ received: true });
  console.log('[webhook] received event:', rawBody);

  try {
    await handleEvent(body);
  } catch (err) {
    console.error('[webhook] error handling event:', err);
  }
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleEvent(event) {
  const eventType = event?.event;
  if (eventType === 'comment.received') return handleComment(event);
  if (eventType === 'message.received') return handleMessage(event);
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

  const result = await generateReply({
    platform,
    type: 'comment',
    message: commentText,
    contextText: postCaption,
  });

  let sendError = '';
  if (!result.escalate && postId) {
    try {
      await replyToComment({
        apiKey: process.env.ZERNIO_API_KEY,
        postId,
        accountId,
        commentId,
        text: result.reply,
      });
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
  const senderHandle =
    conversation.participantUsername ||
    conversation.participantName ||
    message.contactId ||
    'unknown';

  if (!messageText || !conversationId) return;

  const result = await generateReply({
    platform,
    type: platform === 'whatsapp' ? 'whatsapp' : 'dm',
    message: messageText,
  });

  let sendError = '';
  if (!result.escalate) {
    try {
      await sendConversationMessage({
        apiKey: process.env.ZERNIO_API_KEY,
        conversationId,
        accountId,
        text: result.reply,
      });
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
