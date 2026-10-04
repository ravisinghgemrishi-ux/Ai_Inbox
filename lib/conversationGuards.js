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

module.exports = { contextNotes, cleanReply, detectCategoryChoice, categoryAlreadyAsked, phoneAskCount, _patterns: { CATEGORY_QUESTION, PHONE_ASK } };
