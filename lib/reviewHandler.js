// =============================================================================
// reviewHandler.js — Google Business Profile reviews (via Zernio)
//
// Added 2026-09-29 (Ravi): GemRishi's Google Business Profile is connected in
// Zernio. Zernio delivers new Google reviews as a `review.new` webhook event
// and accepts replies at POST /v1/inbox/reviews/{reviewId}/reply
// (docs.zernio.com/reviews/reply-to-inbox-review). Google Business has no chat
// in Zernio - reviews are the channel.
//
// Ravi's decision (2026-09-29): ALL reviews are auto-replied, every rating.
//   - Happy reviews get a short, personal thank-you.
//   - Unhappy reviews (1-3 stars) get a sincere apology + an invitation to
//     call the team, AND the team gets an FYI alert (Telegram/email) with the
//     review and the posted reply, so someone can follow up personally.
//   - REVIEW_AUTO_REPLY_MIN_RATING (default 1 = everything) can be raised,
//     e.g. to 4, to hold low ratings for human approval instead.
const FYI_BELOW_RATING = 4;
//   - a review that already has a reply is never touched.
//   - review.updated events (edits, or our own reply being added) are ignored.
//
// Only active when ENABLE_REVIEW_REPLIES === 'true'. With it off, new reviews
// are still logged to the lead sheet so nothing is missed.
// =============================================================================

const crypto = require('crypto');

const REVIEW_RULES = [
  'THIS IS A PUBLIC GOOGLE REVIEW OF GEMRISHI, NOT A CHAT. Your reply will be posted publicly under the review, as the business owner\'s response.',
  'Write 2-3 short sentences. Thank the reviewer by first name if a name is given, and refer to something specific they wrote.',
  'Reply in the same language as the review (English, Hindi or Hinglish).',
  'Do NOT: quote any price, share links, share phone numbers (except as instructed below for unhappy reviews), ask for their details, pitch products, mention AI, or sign as Mannat. End with "- Team GemRishi".',
  'If the review is unhappy: apologise sincerely without arguing or admitting specific fault, and invite them to contact us directly at +91 98179 75978 so the team can make it right.',
  'If the review has no text (rating only): a warm one-line thank you is enough.',
  'Set escalate=false and leadStatus to NOT_A_LEAD unless the reviewer asks to buy something.',
].join('\n');

function minAutoRating() {
  const n = Number(process.env.REVIEW_AUTO_REPLY_MIN_RATING || 1);
  return Number.isFinite(n) ? n : 1;
}

function cleanReviewReply(text) {
  let t = String(text || '').trim();
  t = t.replace(/\s*[-–—]\s*Mannat\s*$/i, '').trim();
  if (!/Team GemRishi\s*$/i.test(t)) t = `${t}\n- Team GemRishi`;
  return t;
}

function reviewReplyIdempotencyKey(reviewId) {
  return `review-reply-${crypto.createHash('sha256').update(String(reviewId)).digest('hex').slice(0, 32)}`;
}

async function handleReview(event, deps) {
  const { generateReply, replyToReview, logLead, notifyEscalation, claimReplySlot, markReplySent, releaseReplySlot } = deps;
  const review = event.review || {};
  const account = event.account || {};
  const accountId = account.accountId || account.id || account._id;
  const reviewId = review.id;
  const rating = Number(review.rating || 0);
  const text = String(review.text || '').trim();
  const reviewer = review.reviewer?.name || review.reviewer?.displayName || 'Google reviewer';
  const stars = rating ? `${rating}★` : 'no rating';
  const messageForLog = `[${stars}] ${text || '(rating only, no text)'}`;
  const platform = 'googlebusiness';

  if (!reviewId) return;
  if (review.hasReply) {
    console.log('[review] already has a reply, skipping:', reviewId);
    return;
  }

  const enabled = process.env.ENABLE_REVIEW_REPLIES === 'true';
  if (!enabled) {
    await logLead({
      platform, contact: reviewer, type: 'review', message: messageForLog,
      reply: '(not sent - Google review replies are switched off)',
      leadStatus: 'NOT_A_LEAD', productInterest: '', escalated: false,
      notes: `review_replies_disabled | rating=${rating}`,
    });
    return;
  }

  const replyKey = `review:${reviewId}`;
  try {
    const slot = await claimReplySlot(replyKey);
    if (!slot.allowed) { console.log('[review] reply suppressed:', slot.reason); return; }
  } catch (err) {
    console.error('[review] reply gate unavailable; continuing:', err.message);
  }

  const result = await generateReply({
    platform,
    type: 'google_review',
    message: `${stars} Google review from ${reviewer}: "${text || '(no text, rating only)'}"`,
    contextText: REVIEW_RULES,
    liveProductData: '',
  });
  const draft = cleanReviewReply(result.reply);
  const autoPost = rating >= minAutoRating() && Boolean(accountId);

  if (!autoPost) {
    await releaseReplySlot(replyKey);
    const reason = `${stars} Google review - NOT posted automatically, needs a person to approve. Suggested reply: "${draft}"`;
    await logLead({
      platform, contact: reviewer, type: 'review', message: messageForLog,
      reply: `(draft, not posted) ${draft}`,
      leadStatus: 'NOT_A_LEAD', productInterest: '', escalated: true,
      notes: `negative_review_held_for_human | rating=${rating}`,
    });
    try {
      await notifyEscalation({ platform: 'Google review', contact: reviewer, type: 'review', message: messageForLog, reply: draft, reason, leadStatus: 'REVIEW' });
    } catch (err) {
      console.error('[review] escalation alert failed; review remains logged:', err.message);
    }
    return;
  }

  let sendError = '';
  try {
    await replyToReview({ apiKey: process.env.ZERNIO_API_KEY, reviewId, accountId, text: draft, idempotencyKey: reviewReplyIdempotencyKey(reviewId) });
    try { await markReplySent(replyKey); } catch (err) { console.error('[review] reply posted but Redis update failed:', err.message); }
  } catch (err) {
    sendError = `Review reply failed: ${err.message}`;
    console.error('[review]', sendError);
    await releaseReplySlot(replyKey);
    try {
      await notifyEscalation({ platform: 'Google review', contact: reviewer, type: 'review', message: messageForLog, reply: draft, reason: `${sendError}. Suggested reply: "${draft}"`, leadStatus: 'REVIEW' });
    } catch { /* logged below */ }
  }

  if (!sendError && rating && rating < FYI_BELOW_RATING) {
    try {
      await notifyEscalation({
        platform: 'Google review', contact: reviewer, type: 'review', message: messageForLog, reply: draft, leadStatus: 'REVIEW',
        reason: `FYI: ${stars} Google review - Mannat already replied publicly: "${draft}". Please follow up personally with the customer.`,
      });
    } catch (err) {
      console.error('[review] FYI alert failed; review remains logged:', err.message);
    }
  }

  await logLead({
    platform, contact: reviewer, type: 'review', message: messageForLog,
    reply: sendError ? `(send failed, see notes) ${draft}` : draft,
    leadStatus: result.leadStatus || 'NOT_A_LEAD', productInterest: result.productInterest || '',
    escalated: Boolean(sendError),
    notes: [`review_auto_reply | rating=${rating}`, sendError].filter(Boolean).join(' | '),
  });
}

module.exports = { handleReview, cleanReviewReply, REVIEW_RULES };
