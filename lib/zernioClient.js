const crypto = require('crypto');

const ZERNIO_API_BASE = 'https://zernio.com/api/v1';

function verifyWebhookSignature({ rawBody, signatureHeader, secret }) {
  if (!secret || !signatureHeader) return false;
  const normalized = String(signatureHeader).replace(/^sha256=/i, '').trim();
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(normalized, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function zernioRequest(path, { method = 'POST', apiKey, body, idempotencyKey } = {}) {
  if (!apiKey) throw new Error('ZERNIO_API_KEY is not configured');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`${ZERNIO_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Zernio API error ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

function registerWebhook({ apiKey, url, secret, name = 'GemRishi AI Inbox' }) {
  return zernioRequest('/webhooks/settings', {
    apiKey,
    body: { name, url, secret, events: ['comment.received', 'message.received'] },
  });
}

function commentReplyIdempotencyKey({ postId, accountId, commentId, text }) {
  const fingerprint = [postId, accountId, commentId, text].map(value => String(value ?? '')).join('|');
  const digest = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  return `comment-reply-${commentId || 'unknown'}-${digest}`;
}

function messageReplyIdempotencyKey({ conversationId, accountId, messageId, text }) {
  const fingerprint = [conversationId, accountId, messageId, text].map(value => String(value ?? '')).join('|');
  const digest = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  return `dm-reply-${messageId || 'unknown'}-${digest}`;
}

function replyToComment({ apiKey, postId, accountId, commentId, text }) {
  return zernioRequest(`/inbox/comments/${encodeURIComponent(postId)}`, {
    apiKey,
    body: { accountId, message: text, commentId },
    idempotencyKey: commentId ? commentReplyIdempotencyKey({ postId, accountId, commentId, text }) : undefined,
  });
}

function sendConversationMessage({ apiKey, conversationId, accountId, text, category, idempotencyKey }) {
  return zernioRequest(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {
    apiKey,
    body: { accountId, message: text, ...(category ? { category } : {}) },
    idempotencyKey,
  });
}

function listInboxConversations({ apiKey, accountId, platform, status = 'active', limit = 100, cursor, sortOrder = 'desc' }) {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (platform) params.set('platform', platform);
  if (status) params.set('status', status);
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  if (sortOrder) params.set('sortOrder', sortOrder);
  return zernioRequest(`/inbox/conversations?${params.toString()}`, { apiKey, method: 'GET' });
}

function listInboxConversationMessages({ apiKey, conversationId, accountId, limit = 100, cursor, sortOrder = 'desc' }) {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  if (sortOrder) params.set('sortOrder', sortOrder);
  return zernioRequest(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages?${params.toString()}`, { apiKey, method: 'GET' });
}

function listCommentedPosts({ apiKey, accountId, platform, limit = 100, cursor, sortBy = 'date', sortOrder = 'desc' }) {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (platform) params.set('platform', platform);
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  if (sortBy) params.set('sortBy', sortBy);
  if (sortOrder) params.set('sortOrder', sortOrder);
  return zernioRequest(`/inbox/comments?${params.toString()}`, { apiKey, method: 'GET' });
}

function listPostComments({ apiKey, postId, accountId, limit = 100, cursor }) {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (limit) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  return zernioRequest(`/inbox/comments/${encodeURIComponent(postId)}?${params.toString()}`, { apiKey, method: 'GET' });
}

module.exports = {
  verifyWebhookSignature,
  registerWebhook,
  replyToComment,
  sendConversationMessage,
  commentReplyIdempotencyKey,
  messageReplyIdempotencyKey,
  listInboxConversations,
  listInboxConversationMessages,
  listCommentedPosts,
  listPostComments,
};
