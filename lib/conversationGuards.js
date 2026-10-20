// =============================================================================
// conversationGuards.js - deterministic backstops on every customer reply
//
// Added 2026-10-04 (Ravi, quality batch FIX 1 + FIX 3). The 7-day audit
// (26 Sep - 3 Oct) found three habits that frustrated customers:
//   - "Gemstone or Rudraksha?" asked again and again (umma.why answered
//     "Both" and got the same question ~4 times).
//   - The phone number asked again and again, even before answering the
//     customer's actual question (Mahender Verma, ~6 times in a row).
//   - "- Mannat" signed at the bottom of mid-conversation replies.
// Prompt rules alone did not stop these, so - same pattern as the price and
// address safety nets in replyEngine.js - this file checks the finished
// reply against the conversation history and removes the repeated line.
// It never adds facts and never empties a reply: if stripping would leave
// almost nothing, the original reply is kept.
// =============================================================================

// A question that offers BOTH categories, e.g. "gemstone or Rudraksha?",
// "gemstone ke baare mein ya Rudraksha?".
const CATEGORY_QUESTION = /(gem\s*stone|gemstone|ratna)[^?\n]{0,80}\b(or|ya|aur)\b[^?\n]{0,40}rudraksh|rudraksh[^?\n]{0,80}\b(or|ya|aur)\b[^?\n]{0,40}(gem\s*stone|gemstone|ratna)/i;

// Asking the customer for their number.
const PHONE_ASK = /(phone|contact|mobile|whats\s*app)\s*(number|no\.?|nmbr)?[^.?!\n]{0,60}(share|send|bata|de\s*dijiye|dijiye|provide|give|could you|can you|please)|(share|send|bata|provide|give)[^.?!\n]{0,40}(phone|contact|mobile)\s*(number|no\.?)?|number\s*(share|bata|de)/i;

const GEMSTONE_WORDS = /\b(gem\s*stones?|ratna|ruby|manikya|pearl|moti|coral|moonga|emerald|panna|sapphire|pukhraj|neelam|diamond|heera|gomed|hessonite|cat'?s?\s*eye|lehsunia|opal|topaz|pitambari|ceylon|kashmir)\b/i;
const RUDRAKSHA_WORDS = /\b(rudraksh\w*|mukhi|mala|gauri\s*shankar|trijuti)\b/i;
const BOTH_WORDS = /\b(both|dono|dono\s*hi|both\s*of\s*them|all|sab)\b/i;

function assistantLines(memory) {
  return String(memory || '').split('\n').filter((l) => /^\s*Mannat:/i.test(l));
}
function customerLines(memory) {
  return String(memory || '').split('\n').filter((l) => /^\s*Customer:/i.test(l));
}

// What has the customer chosen so far? 'gemstone' | 'rudraksha' | 'both' | ''
function detectCategoryChoice(memory, message) {
  const texts = [...customerLines(memory).map((l) => l.replace(/^\s*Customer:\s*/i, '')), String(message || '')];
  let choice = '';
  for (const t of texts) {
    const g = GEMSTONE_WORDS.test(t);
    const r = RUDRAKSHA_WORDS.test(t);
    if (g && r) choice = 'both';
    else if (g) choice = 'gemstone';
    else if (r) choice = 'rudraksha';
    else if (choice === '' && BOTH_WORDS.test(t) && t.trim().split(/\s+/).length <= 4) choice = 'both';
  }
  return choice;
}

function categoryAlreadyAsked(memory) {
  return assistantLines(memory).some((l) => CATEGORY_QUESTION.test(l));
}

function phoneAskCount(memory) {
  return assistantLines(memory).filter((l) => PHONE_ASK.test(l)).length;
}

// Short note added to the AI context for this turn (FIX 1, FIX 2, FIX 3).
function contextNotes({ memory, message, knownPhone = '' }) {
  const notes = [];
  const choice = detectCategoryChoice(memory, message);
  const asked = categoryAlreadyAsked(memory);
  if (choice === 'gemstone') {
    notes.push('CATEGORY: the customer is interested in GEMSTONES. Talk only about gemstones. Do NOT mention Rudraksha at all in this reply, and never ask "gemstone or Rudraksha" again.');
  } else if (choice === 'rudraksha') {
    notes.push('CATEGORY: the customer is interested in RUDRAKSHA. Talk only about Rudraksha. Do NOT ask "gemstone or Rudraksha" again.');
  } else if (choice === 'both') {
    notes.push('CATEGORY: the customer said BOTH. Do not ask the gemstone-or-Rudraksha question again. In this reply: first explain the suitable gemstone briefly, then the suitable Rudraksha briefly, then ask which ONE they would like to know more about or buy.');
  } else if (asked) {
    notes.push('CATEGORY: you already asked gemstone-or-Rudraksha once. Never ask it again. If still unclear, assume GEMSTONE (our ads are gemstone ads) and answer about gemstones.');
  } else {
    notes.push('CATEGORY: our ads are gemstone ads - lean to gemstones. Do not bring up Rudraksha unless the customer does. If the customer asks to see or know about a gemstone, answer about that gemstone straight away - never deflect into a category question.');
  }
  if (knownPhone) {
    notes.push('PHONE: we already have the customer\'s number. Never ask for it.');
  } else if (phoneAskCount(memory) >= 1) {
    notes.push('PHONE: you already asked for their number once. Do NOT ask again in this reply. Answer their actual question fully.');
  } else {
    notes.push('PHONE: always answer the customer\'s actual question FIRST. Never make an answer or recommendation wait for their phone number. Ask for it at most once in the whole chat, only when they are clearly ready to buy.');
  }
  return notes.join('\n');
}

function splitSentences(block) {
  return String(block).match(/[^.?!\n]+[.?!]*\s*/g) || [String(block)];
}

function stripMatching(reply, pattern) {
  const blocks = String(reply || '').split(/\n\s*\n/);
  const out = [];
  for (const block of blocks) {
    if (!pattern.test(block)) { out.push(block); continue; }
    const kept = splitSentences(block).filter((s) => !pattern.test(s)).join('').trim();
    if (kept) out.push(kept);
  }
  return out.join('\n\n').trim();
}

// FIX 1 + FIX 3 backstop on the finished reply.
function cleanReply({ reply, memory, message, knownPhone = '', isFirstReply = false }) {
  const original = String(reply || '').trim();
  if (!original) return original;
  let text = original;

  const choice = detectCategoryChoice(memory, message);
  if (categoryAlreadyAsked(memory) || choice) text = stripMatching(text, CATEGORY_QUESTION);
  if (choice === 'gemstone') text = stripMatching(text, RUDRAKSHA_WORDS);

  if (knownPhone || phoneAskCount(memory) >= 1) text = stripMatching(text, PHONE_ASK);

  // "- Mannat" only on the first reply of a chat.
  if (!isFirstReply) text = text.replace(/\s*[-–—]\s*Mannat\s*$/i, '').trim();

  // Never leave the customer with a stub.
  if (text.length < 10) return isFirstReply ? original : original.replace(/\s*[-–—]\s*Mannat\s*$/i, '').trim();
  return text;
}


// =============================================================================
// 2026-10-20 audit (aju61423): a customer asked for a 9.15 ratti Pukhraj four
// times, got the 8.20 ct ₹13,020 stone pushed back each time, got angry
// ("block kr rha", "MSG krna hi bekar hai") and Mannat kept pitching. Two
// deterministic checks now hand such a chat to the team instead:
//   - the customer asks for the same size (ratti/carat) a THIRD time, or
//   - the customer is annoyed or says they no longer want it.
// A plain "thanks, bye" only asks for a short polite close (no escalation).
// =============================================================================
const FRUSTRATION = /\bblock\b|bekar|bekaar|bakwas|faltu|pagal|\b(ni|nhi|nahi|nahin)\s*chahiye|chahiye\s*(hi\s*)?(ni|nhi|nahi|nahin)\b|bar\s*bar|baar\s*baar|kitni\s*baar|tab\s*se|tbse|already\s*told|told\s*you|not\s*interested|useless|waste\s*of\s*time|stop\s*(sending|messaging)|irritat|annoy|gussa/i;
const CONFUSED = /\bsam[a]?jh?\s*(me\s*)?(nhi|nahi|nahin|ni|na)\b|\b(didn'?t|did not|don'?t)\s*understand\b|\bnot\s*clear\b|\bconfus/i;
const LEAVING = /\b(bye|byee+|tata|good\s*night|gn)\b/i;

// Sizes the customer asked for, e.g. "9.15 ratti", "8.4 carat", "5 rati".
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(ratti|rati|ratt?i|carats?|ct|cts|crt)\b/gi;
function sizesIn(text) {
  const out = [];
  let m;
  const re = new RegExp(SIZE_RE.source, 'gi');
  while ((m = re.exec(String(text || '')))) {
    const unit = /^r/i.test(m[2]) ? 'ratti' : 'carat';
    out.push(`${Number(m[1])} ${unit}`);
  }
  return out;
}

function handoverCheck({ memory, message, knownPhone = '' }) {
  const msg = String(message || '');
  const earlier = customerLines(memory).map((l) => l.replace(/^\s*Customer:\s*/i, ''));
  let repeatedSize = '';
  for (const size of sizesIn(msg)) {
    const times = earlier.filter((l) => sizesIn(l).includes(size)).length + 1;
    if (times >= 3) { repeatedSize = size; break; }
  }
  // "Tbse bol rha 9.15 chahiye" - a bare number already asked twice with a unit.
  if (!repeatedSize) {
    const nums = msg.match(/\d+\.\d+/g) || [];
    for (const n of nums) {
      const prior = earlier.flatMap(sizesIn).filter((x) => x.startsWith(`${Number(n)} `));
      if (prior.length >= 2) { repeatedSize = prior[0]; break; }
    }
  }
  const frustrated = FRUSTRATION.test(msg);
  const leaving = !frustrated && !repeatedSize && LEAVING.test(msg);
  const escalate = Boolean(frustrated || repeatedSize);

  const notes = [];
  if (escalate) {
    notes.push([
      'HANDOVER (important):',
      repeatedSize ? `The customer has now asked for exactly ${repeatedSize} at least three times.` : '',
      frustrated ? 'The customer is annoyed or says they do not want it any more.' : '',
      'In this reply: do NOT suggest any other product or size and do NOT paste product links again.',
      repeatedSize ? `Answer plainly in one or two sentences what we have in exactly ${repeatedSize} and its price from the live data (or that we do not have it in their budget).` : '',
      'Apologise once, briefly. Say a team member will personally help them.',
      knownPhone ? 'We already have their number - do not ask for it.' : 'If you have not asked before, ask once for their phone number so the team can call.',
      'Never argue, never say "aisa mat kijiye". Set escalate=true.',
    ].filter(Boolean).join(' '));
  } else if (CONFUSED.test(msg)) {
    // 2026-10-20: "Kuch samjh nhi aya" got two NEW stones and three links.
    notes.push('CONFUSED: the customer did not understand your last reply. Re-explain the SAME options in very simple words, in 2-3 short lines. Do NOT add new products, prices or links.');
  } else if (leaving) {
    notes.push('CLOSING: the customer is saying goodbye. Reply in one short, warm line. Do NOT suggest any product or paste any link.');
  }
  return {
    escalate,
    reason: repeatedSize ? `customer_asked_same_size_3x(${repeatedSize})` : (frustrated ? 'customer_frustrated' : ''),
    leaving,
    note: notes.join('\n'),
  };
}

module.exports = { handoverCheck, contextNotes, cleanReply, detectCategoryChoice, categoryAlreadyAsked, phoneAskCount, _patterns: { CATEGORY_QUESTION, PHONE_ASK } };
