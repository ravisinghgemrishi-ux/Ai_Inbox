const crypto = require('crypto');

const ZERNIO_API_BASE = 'https://zernio.com/api/v1';

function verifyWebhookSignature({ rawBody, signatureHeader, secret }) {
  if (!secret) return true;
  if (!signatureHeader) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

async function zernioRequest(path, { method = 'POST', apiKey, body, idempotencyKey } = {}) {
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
    body: {
      name,
      url,
      secret,
      events: ['comment.received', 'message.received'],
    },
  });
}

function replyToComment({ apiKey, postId, accountId, commentId, text }) {
  return zernioRequest(`/inbox/comments/${postId}`, {
    apiKey,
    body: { accountId, message: text, commentId },
  });
}

function sendConversationMessage({ apiKey, conversationId, accountId, text, category }) {
  return zernioRequest(`/inbox/conversations/${conversationId}/messages`, {
    apiKey,
    body: { accountId, message: text, ...(category ? { category } : {}) },
  });
}

module.exports = {
  verifyWebhookSignature,
  registerWebhook,
  replyToComment,
  sendConversationMessage,
};
