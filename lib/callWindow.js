// =============================================================================
// callWindow.js - when Mannat is allowed to promise "a call" and what to say
//
// Added 2026-10-07 (Ravi). Two things, both about the specific promise of a
// PHONE CALL back (not the general "team will get back to you" working-hours
// note in api/webhook.js, which stays 10 AM - 8 PM and is unchanged):
//
//   1. Any lead captured after 7 PM IST must be told office hours are over
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
const CALL_WINDOW_END_MIN = 19 * 60; // 7:00 PM IST

function istMinutesOfDay(d = new Date()) {
  const ist = new Date(d.getTime() + IST_OFFSET_MINUTES * 60000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

// 'before_hours' (<10 AM) | 'in_hours' (10 AM - 7 PM) | 'after_hours' (>=7 PM)
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
      ? 'Abhi hamara office time (10 AM - 7 PM) khatam ho chuka hai, isliye call AAJ nahi - KAL (TOMORROW) 10 AM ke baad aayega. Kabhi bhi "aaj" ya "thodi hi der mein" na bole.'
      : "Our office hours (10 AM - 7 PM) are over for today, so the call will NOT come today - it will come TOMORROW after 10 AM. Never say \"today\" or \"shortly\"."
  }
  if (state === 'before_hours') {
    return hindi
      ? 'Hamara office 10 AM par khulta hai, isliye call AAJ hi 10 AM ke baad aayega, abhi nahi. Kabhi bhi "abhi" ya "turant" na bole.'
      : 'Our office opens at 10 AM, so the call will come TODAY after 10 AM, not right now. Never say "right now" or "immediately".'
  }
  return hindi
    ? 'Hum office hours (10 AM - 7 PM) mein hain, toh team jald hi (aaj hi) call karegi.'
    : "We're within office hours (10 AM - 7 PM), so the team will call shortly (today).";
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

module.exports = {
  IST_OFFSET_MINUTES,
  CALL_WINDOW_START_MIN,
  CALL_WINDOW_END_MIN,
  istMinutesOfDay,
  callWindowState,
  callTimingInstruction,
  looksLikeImmediateCallRequest,
  immediateCallNote,
};
