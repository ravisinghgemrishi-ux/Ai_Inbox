// =============================================================================
// commentDelay.js - wait 30-60 seconds before Mannat answers a comment
//
// Added 2026-10-28 (Ravi): an Instagram comment answered within a few seconds
// looks like a bot. Mannat now replies to Instagram comments (public reply
// and the private DM copy) a random 30-60 seconds after the comment arrived.
// Time already spent writing the reply counts toward the wait, so the
// customer sees the answer 30-60 seconds after commenting, not later.
//
// Vercel settings (all optional):
//   COMMENT_REPLY_DELAY_MIN_SEC   default 30
//   COMMENT_REPLY_DELAY_MAX_SEC   default 60   (0 and 0 = no delay)
//   COMMENT_REPLY_DELAY_PLATFORMS default "instagram" (comma list, or "all")
// =============================================================================

const HARD_CAP_SEC = 90; // the webhook must finish well inside maxDuration

function readSec(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, HARD_CAP_SEC) : fallback;
}

function appliesTo(platform) {
  const list = String(process.env.COMMENT_REPLY_DELAY_PLATFORMS || 'instagram').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('all')) return true;
  return list.includes(String(platform || '').toLowerCase());
}

// Picks this comment's target delay once (call at the start of handling).
function pickTargetMs(platform, rand = Math.random) {
  if (!appliesTo(platform)) return 0;
  let min = readSec('COMMENT_REPLY_DELAY_MIN_SEC', 30);
  let max = readSec('COMMENT_REPLY_DELAY_MAX_SEC', 60);
  if (max < min) [min, max] = [max, min];
  return Math.round((min + rand() * (max - min)) * 1000);
}

// How much longer to wait before sending, given when handling started.
function remainingMs(targetMs, startedAt, now = Date.now()) {
  return Math.max(0, targetMs - (now - startedAt));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitBeforeReply(targetMs, startedAt, sleepFn = sleep) {
  const ms = remainingMs(targetMs, startedAt);
  if (ms > 0) await sleepFn(ms);
  return ms;
}

module.exports = { pickTargetMs, remainingMs, waitBeforeReply, appliesTo };
