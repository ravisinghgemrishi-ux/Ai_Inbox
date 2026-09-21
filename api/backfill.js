const { replyToComment, sendConversationMessage, messageReplyIdempotencyKey, listInboxConversations, listInboxConversationMessages, listCommentedPosts, listPostComments } = require('../lib/zernioClient');
const { generateReply } = require('../lib/replyEngine');
const { logLead } = require('../lib/leadLog');
const { classifyIntent, extractProduct } = require('../lib/intentRouter');
const { lookupLiveProduct, formatLiveProductData } = require('../lib/productResolver');
const { addTurn } = require('../lib/memoryStore');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const token = process.env.BACKFILL_ADMIN_TOKEN || process.env.ZERNIO_WEBHOOK_SECRET || '';
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || supplied !== token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.ZERNIO_API_KEY) return res.status(503).json({ ok: false, error: 'ZERNIO_API_KEY is not configured' });

  const maxActions = Math.max(1, Math.min(Number(process.env.BACKFILL_MAX_ACTIONS || 20), 50));
  const maxPosts = Math.max(1, Math.min(Number(process.env.BACKFILL_MAX_POSTS || 20), 50));
  const result = { ok: true, mode: 'pending-only', maxActions, scanned: { conversations: 0, messages: 0, posts: 0, comments: 0 }, replied: { dms: 0, comments: 0 }, skipped: { alreadyReplied: 0, own: 0, empty: 0, unsupported: 0 }, failed: [] };

  try {
    for (const platform of ['instagram', 'facebook']) {
      if (totalReplied(result) >= maxActions) break;
      await processDMs(platform, maxActions, result);
    }
    for (const platform of ['instagram', 'facebook']) {
      if (totalReplied(result) >= maxActions) break;
      await processComments(platform, maxPosts, maxActions, result);
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error('[backfill] fatal error:', err);
    result.ok = false;
    result.failed.push({ stage: 'fatal', error: err.message });
    return res.status(500).json(result);
  }
};

function totalReplied(result) { return result.replied.dms + result.replied.comments; }

async function processDMs(platform, maxActions, result) {
  let cursor;
  for (let pageNo = 0; pageNo < 3 && totalReplied(result) < maxActions; pageNo += 1) {
    const page = await listInboxConversations({ apiKey: process.env.ZERNIO_API_KEY, platform, status: 'active', limit: 100, cursor, sortOrder: 'desc' });
    const conversations = Array.isArray(page?.data) ? page.data : [];
    result.scanned.conversations += conversations.length;
    for (const conversation of conversations) {
      if (totalReplied(result) >= maxActions) break;
      await processConversation(conversation, result);
    }
    if (!page?.pagination?.hasMore || !page.pagination.nextCursor) break;
    cursor = page.pagination.nextCursor;
  }
}

async function processConversation(conversation, result) {
  const { id: conversationId, accountId, platform } = conversation || {};
  if (!conversationId || !accountId || !platform) { result.skipped.unsupported += 1; return; }
  let page;
  try {
    page = await listInboxConversationMessages({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, limit: 100, sortOrder: 'desc' });
  } catch (err) {
    result.failed.push({ type: 'dm-read', conversationId, error: err.message });
    return;
  }
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  result.scanned.messages += messages.length;
  if (!messages.length) return;
  const latestIncomingIndex = messages.findIndex(m => m?.direction === 'incoming');
  if (latestIncomingIndex < 0) return;
  if (messages.slice(0, latestIncomingIndex).some(m => m?.direction === 'outgoing')) { result.skipped.alreadyReplied += 1; return; }
  const inbound = messages[latestIncomingIndex];
  const text = String(inbound?.message || '').trim();
  if (!text) { result.skipped.empty += 1; return; }

  const context = messages.slice(0, 12).reverse().map(m => {
    const body = String(m?.message || '').trim();
    return body ? `${m?.direction === 'outgoing' ? 'ASSISTANT' : 'CUSTOMER'}: ${body}` : '';
  }).filter(Boolean).join('\n');
  const ai = await makeReply({ platform, type: platform === 'whatsapp' ? 'whatsapp' : 'dm', text, context });
  if (!ai) return;
  try {
    await sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text: ai.reply, idempotencyKey: messageReplyIdempotencyKey({ conversationId, accountId, messageId: inbound.id, text: ai.reply }) });
  } catch (err) {
    result.failed.push({ type: 'dm-send', conversationId, messageId: inbound.id, error: err.message });
    return;
  }
  result.replied.dms += 1;
  await safeMemory('conversation', `${platform}:${conversationId}`, 'customer', text);
  await safeMemory('conversation', `${platform}:${conversationId}`, 'assistant', ai.reply);
  await safeLog({ platform, contact: conversation.participantUsername || conversation.participantName || inbound.senderName || 'unknown', type: 'dm', message: text, reply: ai.reply, leadStatus: ai.leadStatus, productInterest: ai.productInterest || ai.product, escalated: ai.escalate, notes: [ai.escalateReason, 'backfill=pending-dm', `intent=${ai.intent.intent}`, ai.live.found ? 'live_product_data=found' : 'live_product_data=not_found'].filter(Boolean).join(' | ') });
}

async function processComments(platform, maxPosts, maxActions, result) {
  let cursor;
  let postsProcessed = 0;
  for (let pageNo = 0; pageNo < 3 && postsProcessed < maxPosts && totalReplied(result) < maxActions; pageNo += 1) {
    const page = await listCommentedPosts({ apiKey: process.env.ZERNIO_API_KEY, platform, limit: 100, cursor, sortBy: 'date', sortOrder: 'desc' });
    const rows = Array.isArray(page?.data) ? page.data : [];
    result.scanned.posts += rows.length;
    for (const row of rows) {
      if (postsProcessed >= maxPosts || totalReplied(result) >= maxActions) break;
      postsProcessed += 1;
      await processPostComments(row, platform, result, maxActions);
    }
    if (!page?.pagination?.hasMore || !page.pagination.nextCursor) break;
    cursor = page.pagination.nextCursor;
  }
}

async function processPostComments(row, platform, result, maxActions) {
  const postId = row?.id || row?.postId;
  const accountId = row?.accountId || row?.account?.id;
  if (!postId || !accountId) { result.skipped.unsupported += 1; return; }
  let page;
  try { page = await listPostComments({ apiKey: process.env.ZERNIO_API_KEY, postId, accountId, limit: 100 }); }
  catch (err) { result.failed.push({ type: 'comment-read', postId, error: err.message }); return; }
  const comments = Array.isArray(page?.comments) ? page.comments : [];
  result.scanned.comments += comments.length;
  for (const comment of comments) {
    if (totalReplied(result) >= maxActions) break;
    if (comment?.from?.isOwner === true) { result.skipped.own += 1; continue; }
    if (!comment?.canReply) { result.skipped.unsupported += 1; continue; }
    let hasOwnerReply = Array.isArray(comment.replies) && comment.replies.some(r => r?.from?.isOwner === true);
    if (!hasOwnerReply && Number(comment.replyCount || 0) > (Array.isArray(comment.replies) ? comment.replies.length : 0)) {
      try {
        const repliesPage = await listPostComments({ apiKey: process.env.ZERNIO_API_KEY, postId: comment.id, accountId, limit: 100 });
        const replies = Array.isArray(repliesPage?.comments) ? repliesPage.comments : [];
        hasOwnerReply = replies.some(r => r?.from?.isOwner === true);
      } catch (err) { result.failed.push({ type: 'comment-replies-read', commentId: comment.id, error: err.message }); continue; }
    }
    if (hasOwnerReply) { result.skipped.alreadyReplied += 1; continue; }
    const text = String(comment?.message || '').trim();
    if (!text) { result.skipped.empty += 1; continue; }
    const ai = await makeReply({ platform, type: 'comment', text, context: `POST CONTEXT: ${row?.caption || row?.content || ''}` });
    if (!ai) continue;
    try { await replyToComment({ apiKey: process.env.ZERNIO_API_KEY, postId, accountId, commentId: comment.id, text: ai.reply }); }
    catch (err) { result.failed.push({ type: 'comment-send', commentId: comment.id, error: err.message }); continue; }
    result.replied.comments += 1;
    await safeLog({ platform, contact: comment?.from?.username || comment?.from?.name || 'unknown', type: 'comment', message: text, reply: ai.reply, leadStatus: ai.leadStatus, productInterest: ai.productInterest || ai.product, escalated: ai.escalate, notes: [ai.escalateReason, 'backfill=pending-comment', `intent=${ai.intent.intent}`, ai.live.found ? 'live_product_data=found' : 'live_product_data=not_found'].filter(Boolean).join(' | ') });
  }
}

async function makeReply({ platform, type, text, context }) {
  try {
    const intent = classifyIntent(text);
    const product = extractProduct(text);
    const live = await lookupLiveProduct(product || text);
    const result = await generateReply({ platform, type, message: text, contextText: `${context}\n\nINTENT: ${intent.intent} (confidence ${intent.confidence})\nPRODUCT: ${product || 'not explicitly identified'}`, liveProductData: formatLiveProductData(live) });
    return { ...result, intent, product, live };
  } catch (err) { console.error('[backfill] AI reply generation failed:', err.message); return null; }
}

async function safeMemory(scope, id, role, text) {
  try { await addTurn(scope, id, { role, text }); }
  catch (err) { console.error('[backfill] memory write failed:', err.message); }
}

async function safeLog(payload) {
  try { await logLead(payload); }
  catch (err) { console.error('[backfill] lead log failed:', err.message); }
}
