// =============================================================================
// messageBatcher.js — read several quick messages together, reply once
//
// Added 2026-09-29 (Ravi): customers often send 2-3 messages in a row
// ("hi" ... "pukhraj chahiye" ... "price kya hai"). Answering each one
// separately is an obvious bot giveaway. Like a person, Mannat now waits a
// few seconds after a DM / WhatsApp message; if more messages arrive from
// the same chat in that time, she reads them all together and sends ONE
// reply to the lot.
//
// How it works (each incoming message is its own serverless call):
//   1. mark "the latest message in this chat is me", then add my text to the
//      chat's waiting list;
//   2. wait MESSAGE_BATCH_WAIT_MS (default 8s);
//   3. if a newer message arrived meanwhile, stop - that one will answer
//      everything; otherwise take the whole waiting list and answer it.
// If the list is already empty (a previous call answered it), stop too.
// Any Redis problem -> no batching, just answer this message (never worse
// than before). Comments and reviews are never batched.
// =============================================================================

const WAIT_DEFAULT_MS = 8000;
const KEY_TTL_SECONDS = 120;

function waitMs() {
  const n = Number(process.env.MESSAGE_BATCH_WAIT_MS ?? WAIT_DEFAULT_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectBurst({ chatId, messageKey, text, redis }) {
  const ms = waitMs();
  if (!ms) return { answerNow: true, text };
  const enc = encodeURIComponent;
  const latestKey = `gemrishi:burst-latest:${chatId}`;
  const listKey = `gemrishi:burst:${chatId}`;
  try {
    // Latest marker FIRST, then the text - so a call that wakes up in between
    // sees it is no longer the latest and leaves the text for the newer one.
    await redis(`/set/${enc(latestKey)}/${enc(messageKey)}/EX/${KEY_TTL_SECONDS}`);
    await redis(`/rpush/${enc(listKey)}/${enc(String(text).slice(0, 2000))}`);
    await redis(`/expire/${enc(listKey)}/${KEY_TTL_SECONDS}`);
  } catch (err) {
    console.error('[batcher] unavailable; answering this message on its own:', err.message);
    return { answerNow: true, text };
  }

  await sleep(ms);

  try {
    const latest = await redis(`/get/${enc(latestKey)}`);
    if (latest?.result && latest.result !== messageKey) {
      return { answerNow: false, reason: 'newer_message_will_answer' };
    }
    const list = await redis(`/lrange/${enc(listKey)}/0/-1`);
    await redis(`/del/${enc(listKey)}`);
    const items = Array.isArray(list?.result) ? list.result : [];
    if (!items.length) return { answerNow: false, reason: 'already_answered' };
    return { answerNow: true, text: items.join('\n'), count: items.length };
  } catch (err) {
    console.error('[batcher] read failed; answering this message on its own:', err.message);
    return { answerNow: true, text };
  }
}

module.exports = { collectBurst, waitMs };
