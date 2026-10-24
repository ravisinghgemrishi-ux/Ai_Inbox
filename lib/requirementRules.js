/**
 * Requirement fallback rules (2026-10-24, Ravi):
 *
 *  1. BIG STONE - the customer asks for a stone of 10 carat / 10 ratti or more
 *     (or came from an ad showing one, like the 21 ct Yellow Sapphire):
 *     "This is a very unique requirement" -> take name + number (+ budget)
 *     and forward to the team.
 *  2. BUDGET - Rs 50,000 or more -> the lead goes to Neel
 *     (lib/handoff.js assignRoute, LEAD_BUDGET_SPLIT).
 *  3. UNIQUE / NOT ON THE WEBSITE - the customer asks for a specific item
 *     Mannat cannot find on the website (no live product / link), or a rare
 *     item from an ad (Kashmir sapphire): take name, number, budget and all
 *     details and forward to the team.
 *
 * Rules 1 and 3 run only on DMs / WhatsApp (never ask for a number in a
 * public comment). The first time, Mannat sends a fixed, clear message and
 * the chat is forwarded; afterwards she continues normally (with a note that
 * the team already has the requirement) and never asks again for details the
 * customer already gave.
 */

const SIZE_RE = /(\d+(?:\.\d+)?)\s*[-+]?\s*(carats?|cts?|karats?|kerats?|ratt?is?|rati)\b/gi;
const BIG_STONE_MIN = () => Number(process.env.BIG_STONE_MIN || 10);

// Largest stone size (carat or ratti) the customer mentions, if >= 10.
function bigStoneAsk(text) {
  const t = String(text || '');
  let best = null;
  let m;
  SIZE_RE.lastIndex = 0;
  while ((m = SIZE_RE.exec(t))) {
    const size = Number(m[1]);
    if (!Number.isFinite(size) || size < BIG_STONE_MIN() || size > 500) continue;
    const unit = /rat/i.test(m[2]) ? 'ratti' : 'carat';
    if (!best || size > best.size) best = { size, unit };
  }
  // "14k gold" style mentions are not stone sizes - the regex needs a size
  // word, so they never match.
  return best;
}

const GEM_WORDS = /\b(ruby|manik|pearl|moti|coral|moonga|munga|emerald|panna|sapphire|pukhraj|neelam|nilam|diamond|heera|hira|gomed|hessonite|cat'?s?\s*eye|lehsunia|opal|amethyst|topaz|tanzanite|garnet|turquoise|firoza|spinel|alexandrite|aquamarine|zircon|moonstone|tourmaline|peridot|citrine|jade|lapis|kashmir|burm|padparadscha|pitambari|stone|ratna|gem)\b/i;
const SPECIFIC_GEM = /\b(ruby|manik|pearl|moti|coral|moonga|munga|emerald|panna|sapphire|pukhraj|neelam|nilam|diamond|heera|hira|gomed|hessonite|cat'?s?\s*eye|lehsunia|opal|amethyst|topaz|tanzanite|garnet|turquoise|firoza|spinel|alexandrite|aquamarine|zircon|moonstone|tourmaline|peridot|citrine|jade|lapis|kashmir|burm\w*|padparadscha|pitambari)\b/i;
const ASK_WORDS = /(\?|price|rate|cost|kitn|kitne|daam|available|availability|have|milega|chahiye|want|need|buy|order|send|dikha|show|options?|details?|info)/i;
const PRICE_OR_INFO = /(how much|price|rate|cost|kitn|kitne|daam|available|availability|can i get more info|more info|details|check the price|buy|purchase|order|interested)/i;

function looksHindi(text) {
  return /[ऀ-ॿ]/.test(text) || /\b(hai|hain|kya|kitna|kitne|chahiye|aap|mujhe|ji|nahi|bhai|kaise|kab)\b/i.test(text);
}

function detailsAsk({ hindi, haveName, havePhone, haveBudget }) {
  const want = [];
  if (!haveName) want.push(hindi ? 'naam' : 'name');
  if (!havePhone) want.push(hindi ? 'number' : 'number');
  if (!haveBudget) want.push(hindi ? 'budget' : 'budget');
  if (!want.length) return '';
  const list = want.length === 1 ? want[0] : `${want.slice(0, -1).join(', ')} ${hindi ? 'aur' : 'and'} ${want[want.length - 1]}`;
  return list;
}

function bigStoneReply({ hindi, size, unit, known }) {
  const ask = detailsAsk({ hindi, ...known });
  const sz = size ? `${size} ${unit}` : '';
  if (hindi) {
    return ask
      ? `Ye ek bahut unique requirement hai 💎${sz ? ` (${sz})` : ''} Aap apna ${ask} share kar dijiye - hamare gem expert aapko personally best options share karenge.`
      : `Ye ek bahut unique requirement hai 💎 Aapki details hamari team ko share kar di hain - hamare gem expert aapko personally best options share karenge.`;
  }
  return ask
    ? `This is a very unique requirement 💎${sz ? ` (${sz})` : ''} Please share your ${ask} - our gem expert will personally share the best options with you.`
    : 'This is a very unique requirement 💎 I have shared your details with our team - our gem expert will personally share the best options with you.';
}

function uniqueReply({ hindi, known }) {
  const ask = detailsAsk({ hindi, ...known });
  if (hindi) {
    return ask
      ? `Ye ek special requirement hai 💎 Aap apna ${ask} aur jo bhi details chahiye (size, shape, ring/loose) share kar dijiye - hamari team aapke liye best options arrange karke share karegi.`
      : 'Ye ek special requirement hai 💎 Aapki details hamari team ko share kar di hain - team aapke liye best options arrange karke share karegi.';
  }
  return ask
    ? `This is a special requirement 💎 Please share your ${ask} and any details (size, shape, loose or ring) - our team will arrange and share the best options for you.`
    : 'This is a special requirement 💎 I have shared your details with our team - they will arrange and share the best options for you.';
}

/**
 * @returns null, or { rule: 'big_stone'|'unique', reason, reply, product }
 * reply is the fixed first message (null when a rule fired before in this
 * chat - then only `note` is used to steer the normal reply).
 */
function evaluate({ message = '', memory = '', intent = '', live = null, adEntry = null, type = 'dm', known = {}, alreadyFired = false }) {
  if (type === 'comment') return null;
  const text = String(message || '');
  const hindi = looksHindi(text) || looksHindi(String(memory).split('\n').slice(-4).join(' '));
  const fromAdQuestion = adEntry && (PRICE_OR_INFO.test(text) || /^(hi|hello|hey|hii+|namaste|gem)\b/i.test(text.trim()) || text.trim().length < 25);

  let fired = null;
  // Rule 1: 10+ carat / ratti asked, or the ad shows such a stone.
  const big = bigStoneAsk(text);
  if (big && (GEM_WORDS.test(text) || ASK_WORDS.test(text) || adEntry)) {
    fired = { rule: 'big_stone', reason: `unique_requirement_big_stone | ${big.size} ${big.unit}`, product: adEntry?.product || `${big.size} ${big.unit} ${(text.match(SPECIFIC_GEM) || ['stone'])[0]}`, size: big.size, unit: big.unit };
  } else if (adEntry?.rule === 'big_stone' && fromAdQuestion) {
    fired = { rule: 'big_stone', reason: `unique_requirement_big_stone | ad: ${adEntry.product}`, product: adEntry.product, size: adEntry.carat || '', unit: 'carat' };
  } else if (adEntry?.rule === 'unique' && fromAdQuestion) {
    fired = { rule: 'unique', reason: `unique_requirement | ad: ${adEntry.product}`, product: adEntry.product };
  } else if (
    // Rule 3: a specific item asked for that the website search can't find.
    (['price', 'purchase', 'product_info'].includes(String(intent))
      || (String(intent) === 'general_question' && /\b(have|available|availability|milega|milegi|chahiye|price|rate|kitne|kitna)\b/i.test(text)))
    && SPECIFIC_GEM.test(text)
    // only a real "searched and not there" - never a sheet/API outage
    && live && live.found === false && !['error', 'sheet_unavailable', 'empty_query'].includes(String(live.source || ''))
    && !adEntry
  ) {
    fired = { rule: 'unique', reason: 'unique_requirement_not_on_website', product: '' };
  }
  if (!fired) return null;

  const note = `REQUIREMENT RULE (${fired.rule === 'big_stone' ? 'very unique / 10+ carat-ratti stone' : 'special item not on the website'}): `
    + 'our team has been given this requirement and will personally share options. Do not say we do not have it and do not quote a price you were not given. '
    + 'Thank the customer for any name/number/budget they share, and never ask again for a detail they already gave.';
  if (alreadyFired) return { ...fired, reply: null, note };
  const reply = fired.rule === 'big_stone'
    ? bigStoneReply({ hindi, size: fired.size, unit: fired.unit, known })
    : uniqueReply({ hindi, known });
  return { ...fired, reply, note };
}

module.exports = { evaluate, bigStoneAsk, detailsAsk };
