/**
 * Seller / B2B-supplier inbound - strict brush-off (rewritten 2026-10-04).
 *
 * Ravi, quality batch FIX 11: if someone messages GemRishi wanting to SELL
 * us stones / Rudraksha / stock (not buy), Mannat says - right there - that
 * we buy only from certified sources, and gives Neel's number to connect.
 *   - She does NOT ask for or take their name, number, city or anything else.
 *   - NO lead-log row, NO customer profile, NO alert, NO handoff is created.
 *     (api/webhook.js checks this BEFORE any identity/logging step.)
 *   - Works on DMs and public comments alike.
 *   - If the same seller keeps messaging, they get one short reminder of
 *     Neel's number, then silence (so it never becomes a back-and-forth).
 *
 * The only thing stored is a tiny technical flag ("this chat is a seller",
 * 7 days) so follow-up messages are recognised - no personal details.
 * Replaces the old City/Name/Phone collection flow (2026-09-24).
 */

const { looksHinglishOrHindi } = require('./knowledgeBase');

const NEEL_NUMBER = '+91 98179 75972';
const FLAG_TTL_SECONDS = 7 * 24 * 60 * 60;

function redisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function redisCommand(path) {
  const { url, token } = redisConfig();
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return res.json().catch(() => ({}));
}

function flagKey(scopeId) {
  return `gemrishi:seller-chat:${String(scopeId).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 150)}`;
}

function brushOff(hindi) {
  return hindi
    ? `Sampark karne ke liye dhanyavaad! Hum sirf certified sources se hi stones lete hain. Aap is baare mein Neel ji se ${NEEL_NUMBER} par connect kar sakte hain.`
    : `Thank you for reaching out! We only source from certified suppliers. You can connect with Neel on ${NEEL_NUMBER} regarding this.`;
}

function reminder(hindi) {
  return hindi
    ? `Is baare mein kripya Neel ji se ${NEEL_NUMBER} par hi baat karein. Dhanyavaad!`
    : `For this, please connect with Neel directly on ${NEEL_NUMBER}. Thank you!`;
}

/**
 * @returns {Promise<null | { reply: string }>}
 *   null  -> not a seller, carry on normally.
 *   { reply: '...' } -> send this (and nothing else). reply '' -> stay silent.
 */
async function maybeHandleSellerInquiry({ enabled = true, scopeId, message, intent }) {
  if (!enabled) return null;
  const hindi = looksHinglishOrHindi(message);
  let count = 0;
  try {
    const r = await redisCommand(`/get/${encodeURIComponent(flagKey(scopeId))}`);
    count = Number(r?.result || 0);
  } catch (err) { console.error('[seller] flag read failed:', err.message); }

  if (!count && intent?.intent !== 'seller_inquiry') return null;

  try { await redisCommand(`/set/${encodeURIComponent(flagKey(scopeId))}/${count + 1}/EX/${FLAG_TTL_SECONDS}`); }
  catch (err) { console.error('[seller] flag write failed:', err.message); }

  if (count === 0) return { reply: brushOff(hindi) };
  if (count === 1) return { reply: reminder(hindi) };
  return { reply: '' }; // already told twice - stay silent
}

module.exports = { maybeHandleSellerInquiry, NEEL_NUMBER };
