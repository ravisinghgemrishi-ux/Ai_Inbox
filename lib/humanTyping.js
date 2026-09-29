// =============================================================================
// humanTyping.js — send DM / WhatsApp replies the way a person chats
//
// Added 2026-09-29 (Ravi): instead of one long block of text arriving
// instantly, Mannat's reply is sent as 1-3 short message bubbles with a
// natural pause before each one, and a "typing..." indicator where the
// platform supports it (Zernio: WhatsApp and Facebook Messenger yes;
// Instagram no - there it's just the natural pauses).
//
// Only for DMs / WhatsApp. Public comment and review replies stay a single
// message. Switch off with HUMAN_TYPING=false (one Vercel setting).
// =============================================================================

const MAX_BUBBLES = 3;
const MIN_BUBBLE_CHARS = 12;

function isEnabled() {
  return process.env.HUMAN_TYPING !== 'false';
}

function splitSentences(text) {
  // Keep URLs intact; split after . ! ? । followed by a space.
  return String(text).match(/[^.!?।]+(?:[.!?।]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) || [String(text)];
}

// Turn one reply into 1-3 natural chat bubbles.
function splitIntoBubbles(reply) {
  const text = String(reply || '').trim();
  if (!text) return [];
  let parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  // One long paragraph with no breaks: split by sentences into ~2 halves.
  if (parts.length === 1 && text.length > 160 && !/https?:\/\//.test(text)) {
    const sentences = splitSentences(text);
    if (sentences.length >= 3) {
      const mid = Math.ceil(sentences.length / 2);
      parts = [sentences.slice(0, mid).join(' '), sentences.slice(mid).join(' ')];
    }
  }

  // Merge tiny fragments into their neighbour (a lone "Ji!" looks odd).
  const merged = [];
  for (const p of parts) {
    if (merged.length && (p.length < MIN_BUBBLE_CHARS || merged[merged.length - 1].length < MIN_BUBBLE_CHARS)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${p}`;
    } else merged.push(p);
  }

  // Never more than MAX_BUBBLES: fold the rest into the last bubble.
  if (merged.length > MAX_BUBBLES) {
    const head = merged.slice(0, MAX_BUBBLES - 1);
    head.push(merged.slice(MAX_BUBBLES - 1).join('\n\n'));
    return head;
  }
  return merged;
}

// Roughly how long a person takes to type this: ~1.2s + 30ms per character,
// between 1.5s and 6s, with a little randomness so it doesn't feel robotic.
function typingDelayMs(text, { first = false } = {}) {
  const base = 1200 + String(text).length * 30;
  const clamped = Math.min(6000, Math.max(1500, base));
  const jitter = 0.85 + Math.random() * 0.3;
  const scale = Number(process.env.HUMAN_TYPING_DELAY_SCALE || 1); // tests only
  return Math.round((first ? Math.min(clamped, 3000) : clamped) * jitter * (Number.isFinite(scale) ? scale : 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// send(text, index) -> Promise; typing() -> Promise (best effort);
// beforeSend(text) -> Promise (register the bubble as AI-sent BEFORE it goes
// out, so the human-takeover detector never mistakes it for a human reply).
async function sendLikeHuman({ reply, send, typing, beforeSend, sleepFn = sleep }) {
  const bubbles = isEnabled() ? splitIntoBubbles(reply) : [String(reply || '').trim()].filter(Boolean);
  const sent = [];
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    if (isEnabled()) {
      if (typing) await Promise.resolve(typing()).catch(() => {});
      await sleepFn(typingDelayMs(b, { first: i === 0 }));
    }
    if (beforeSend) await Promise.resolve(beforeSend(b)).catch(() => {});
    try {
      await send(b, i);
      sent.push(b);
    } catch (err) {
      err.partial = { sentCount: sent.length, total: bubbles.length };
      throw err;
    }
  }
  return { bubbles: sent };
}

module.exports = { splitIntoBubbles, typingDelayMs, sendLikeHuman, isEnabled };
