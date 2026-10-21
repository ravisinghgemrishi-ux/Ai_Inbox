// =============================================================================
// callWindow.js - when Mannat is allowed to promise "a call" and what to say
//
// Added 2026-10-07 (Ravi). Two things, both about the specific promise of a
// PHONE CALL back (not the general "team will get back to you" working-hours
// note in api/webhook.js, which stays 10 AM - 8 PM and is unchanged):
//
//   1. Any lead captured after 8 PM IST must be told office hours are over
//      for the day and the call will come TOMORROW after 10 AM - never
//      "today"/"before end of day".
//   2. Any lead captured before 10 AM IST must be told the call will come
//      TODAY after 10 AM, not immediately.
//   Between 10 AM and 7 PM, no override is needed - the existing "today" /
//   "shortly" language is already correct.
//
// This is also the fix for Bug 6 (false call confirmation - Jon Sena was
// told "hamari team abhi aapko call kar rahi hai", which Mannat cannot know
// to be true): immediateCallNote() detects a customer explicitly asking for
// a call RIGHT NOW and gives the model a deterministic instruction to say
// the team has been notified and WHEN the call will come - never that it is
// happening at this exact moment.
//
// IST has no DST, fixed +5:30, so a plain offset is safe without a timezone
// library (same approach as lib/humanTakeoverGuard.js's separate 10 AM - 8 PM
// working-hours math, which this file deliberately does not touch or reuse -
// that one governs auto-resume timing, this one governs what Mannat SAYS).
// =============================================================================

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const CALL_WINDOW_START_MIN = 10 * 60; // 10:00 AM IST
// 2026-10-20 (Ravi): office hours 10 AM - 8 PM, all 7 days (same as the
// working-hours note customers already see).
const CALL_WINDOW_END_MIN = 20 * 60; // 8:00 PM IST

function istMinutesOfDay(d = new Date()) {
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// 'before_hours' (<10 AM) | 'in_hours' (10 AM - 8 PM) | 'after_hours' (>=8 PM)
function callWindowState(d = new Date()) {
  const min = istMinutesOfDay(d);
  if (min >= CALL_WINDOW_END_MIN) return 'after_hours';
  if (min < CALL_WINDOW_START_MIN) return 'before_hours';
  return 'in_hours';
}

// Short instruction fragment describing WHEN the call will happen - for the
// model to work into a natural sentence, not a sentence to paste verbatim.
function callTimingInstruction(d = new Date(), hindi = false) {
  const state = callWindowState(d);
  if (state === 'after_hours') {
    return hindi
      ? 'Abhi hamara office time (10 AM - 8 PM) khatam ho chuka hai, isliye call AAJ nahi - KAL (TOMORROW) 10 AM ke baad aayega. Kabhi bhi "aaj" ya "thodi hi der mein" na bole.'
      : "Our office hours (10 AM - 8 PM) are over for today, so the call will NOT come today - it will come TOMORROW after 10 AM. Never say \"today\" or \"shortly\"."
  }
  if (state === 'before_hours') {
    return hindi
      ? 'Hamara office 10 AM par khulta hai, isliye call AAJ hi 10 AM ke baad aayega, abhi nahi. Kabhi bhi "abhi" ya "turant" na bole.'
      : 'Our office opens at 10 AM, so the call will come TODAY after 10 AM, not right now. Never say "right now" or "immediately".'
  }
  return hindi
    ? 'Hum office hours (10 AM - 8 PM) mein hain, toh team jald hi (aaj hi) call karegi.'
    : "We're within office hours (10 AM - 8 PM), so the team will call shortly (today).";
}

// A customer explicitly asking for a call RIGHT NOW / IMMEDIATELY (English
// and Hindi/Hinglish) - the exact Jon Sena pattern ("call now", "aabi", a
// common misspelling of "abhi"). Deliberately narrower than a bare "call kar
// do" (please call me) - that alone carries no urgency and already gets the
// normal timing note from formLead.js/the escalation flow.
const URGENCY_WORD = '(abhi|abi|aabi|turant|turrant|jaldi)';
const IMMEDIATE_CALL_PATTERN = new RegExp(
  `\\bcall\\s*(me\\s*)?(right\\s*)?now\\b|\\bcall\\s*(me\\s*)?immediately\\b|\\bcall\\s*(me\\s*)?asap\\b`
  + `|\\b${URGENCY_WORD}\\b[^.?!\\n]{0,20}\\bcall\\b|\\bcall\\b[^.?!\\n]{0,20}\\b${URGENCY_WORD}\\b`,
  'i',
);

function looksLikeImmediateCallRequest(message = '') {
  return IMMEDIATE_CALL_PATTERN.test(String(message || ''));
}

// Deterministic per-turn NOTE (same pattern as detectReplyLanguageNote /
// formLead's notes) - '' when the customer did not ask for an immediate call.
function immediateCallNote(message, hindi = false, d = new Date()) {
  if (!looksLikeImmediateCallRequest(message)) return '';
  const timing = callTimingInstruction(d, hindi);
  return [
    'FIX 6 (false call confirmation): the customer is asking for a call RIGHT NOW. Mannat has no way of knowing whether or when a human will actually call, so she must NEVER say the call is happening right now / is already in progress / "abhi ho rahi hai" - that may be false and has upset customers before.',
    `Instead say the team has been notified and will call, with this timing: ${timing}`,
  ].join(' ');
}

// 2026-10-20 (Ravi): "Mujhe call kiiiye" got "Main abhi call nahi kar sakti"
// and nobody was told. ANY request for a call is now a hand-over: the team
// is told (escalation) and Mannat says when they will call.
const CALL_REQUEST_PATTERN = /\b(call|phone|fone|ring)\s*(me|mujhe|muje|humein|hume)?\s*(back\s*)?(k+i+y+e|k+i+j+i+y+e|kariye|kariyega|kijiyega|karo|kar\s*do|kar\s*dijiye|kar\s*dena|kardo|karna|krdo|kro|kare|karein|karen|please|plz|pls|back)\b|\b(mujhe|muje|humein|hume)\s*(call|phone|fone)\b|\bcall\s*me\b|\bcan\s*(you|someone|anyone)\s*(please\s*)?call\b|\b(give|need|want)\s*(me\s*)?a\s*call\b|\bcall\s*back\b/i;

function looksLikeCallRequest(message = '') {
  return CALL_REQUEST_PATTERN.test(String(message || '')) || looksLikeImmediateCallRequest(message);
}

function callRequestNote(message, hindi = false, d = new Date()) {
  if (!looksLikeCallRequest(message)) return '';
  if (looksLikeImmediateCallRequest(message)) return immediateCallNote(message, hindi, d);
  return [
    'CALL REQUEST: the customer wants a phone call. Never say you cannot call or ask them to keep chatting instead.',
    'Say you have passed their request to the team and a team member will call them on this number, with this timing:',
    callTimingInstruction(d, hindi),
    'Keep it short. Never say the call is happening right now. Set escalate=true.',
  ].join(' ');
}

// 2026-10-20 (Ravi): outside office hours Mannat IS the salesperson - no
// one from the team is around, so she closes the sale herself and, whenever
// she hands over, tells the customer when the team will be back.
function afterHoursNote(hindi = false, d = new Date()) {
  const state = callWindowState(d);
  if (state === 'in_hours') return '';
  const back = state === 'after_hours'
    ? (hindi ? 'kal subah 10 baje ke baad' : 'tomorrow after 10 AM')
    : (hindi ? 'aaj subah 10 baje ke baad' : 'today after 10 AM');
  return [
    `OFFICE CLOSED RIGHT NOW (team works 10 AM - 8 PM, all 7 days). You are the salesperson now:`,
    'help the customer choose, answer every question yourself using the playbook, share the product page link so they can order directly, and explain payment options.',
    `Only if they need a person (call, video, custom design, complaint, negotiation), tell them clearly the team will contact them ${back} (office hours 10 AM - 8 PM) and set escalate=true.`,
    'Never say a team member will reply or call right now.',
  ].join(' ');
}

// 2026-10-21 (Ravi): when a lead is forwarded, tell the customer their
// requirement went to the team - and when, given office hours.
const FORWARDED_MARKER = /shared your requirements? with our team|requirement humari team ko share/i;
function forwardedLine(hindi = false, d = new Date()) {
  const state = callWindowState(d);
  if (state === 'in_hours') {
    return hindi
      ? 'Aapki requirement humari team ko share kar di hai ✅ Team jaldi aapse contact karegi.'
      : "I've shared your requirements with our team ✅ They'll get in touch with you shortly.";
  }
  const back = state === 'after_hours'
    ? (hindi ? 'kal subah 10 baje ke baad' : 'tomorrow after 10 AM')
    : (hindi ? 'aaj subah 10 baje ke baad' : 'today after 10 AM');
  return hindi
    ? `Aapki requirement humari team ko share kar di hai ✅ Team aapse ${back} contact karegi (office time 10 AM - 8 PM).`
    : `I've shared your requirements with our team ✅ They'll contact you ${back} (office hours 10 AM - 8 PM).`;
}

module.exports = {
  forwardedLine,
  FORWARDED_MARKER,
  afterHoursNote,
  looksLikeCallRequest,
  callRequestNote,
  IST_OFFSET_MINUTES,
  CALL_WINDOW_START_MIN,
  CALL_WINDOW_END_MIN,
  istMinutesOfDay,
  callWindowState,
  callTimingInstruction,
  looksLikeImmediateCallRequest,
  immediateCallNote,
};
