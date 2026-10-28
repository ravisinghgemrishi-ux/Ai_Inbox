// =============================================================================
// handoff.js - ONE clean handoff per customer, to the right person
//
// Added 2026-10-04 (Ravi, quality batch FIX 6 + FIX 15). Replaces the old
// pattern where an email/Telegram fired every time a detail appeared
// ("Hot lead, worth a follow-up" many times a day for the same people).
//
// Routing (interim, while Mannat is Instagram-only):
//   SALES / calls / form leads        -> Mannat Chawla  (+91 98179 75978)
//   ESCALATIONS + B2B                 -> Neel Das       (+91 98179 75972)
//
// How it works:
//   1. queueForward() records "this customer should be handed over" in Redis
//      with a due time a few minutes ahead (the settle pause, so a customer
//      who is still typing finishes first). Every new message from the same
//      customer pushes the due time back (touchPending).
//   2. When due, flushDue() sends the WHOLE chat as one record (Telegram +
//      email to that person) - EXACTLY ONCE per customer per route. Done.
//   Due items are flushed (a) by a delayed task right after queueing, (b) on
//   any later webhook event, (c) by the daily 7 PM job - so none is lost.
//
// WhatsApp delivery to staff is not possible yet: Mannat has no WhatsApp
// sending line (the ...977 line is now Vishvas's), and WhatsApp only lets a
// business message a number first with an approved template. Telegram +
// email carry the record until the new business number is connected.
// =============================================================================

const { getMemory, formatMemory } = require('./memoryStore');

function settleSeconds() { return Number(process.env.HANDOFF_SETTLE_SECONDS || 180); }
const SALES_ONCE_TTL = 30 * 86400; // one sales handoff per customer per 30 days
const ESCALATION_ONCE_TTL = 24 * 3600; // one escalation handoff per customer per day
const DUE_ZSET = 'gemrishi:handoff:due';

const ROUTES = {
  sales: {
    label: 'SALES', person: 'Mannat Chawla', phone: '+91 98179 75978',
    email: () => process.env.SALES_HANDOFF_EMAIL || 'mannatchawla.fcbl@gmail.com',
  },
  neel: {
    label: 'NEEL (50K+ / ESCALATION / B2B)', person: 'Neel Das', phone: '+91 98179 75972',
    email: () => process.env.ESCALATION_HANDOFF_EMAIL || 'Neel.das@gemrishi.com',
  },
  // 2026-10-20 (Ravi): leads under Rs 50,000 (or budget not known) go to
  // Yogesh and Vishvas in turn.
  yogesh: {
    label: 'LEAD UNDER 50K', person: 'Yogesh', phone: '+91 70158 68891',
    email: () => process.env.YOGESH_HANDOFF_EMAIL || '',
  },
  vishvas: {
    label: 'LEAD UNDER 50K', person: 'Vishvas', phone: '+91 98179 75977',
    email: () => process.env.VISHVAS_HANDOFF_EMAIL || '',
  },
  // 2026-10-21 (Ravi): every Rudraksha lead goes to Lakshya.
  lakshya: {
    label: 'RUDRAKSHA LEAD', person: 'Lakshya', phone: '+91 91388 49106',
    email: () => process.env.LAKSHYA_HANDOFF_EMAIL || '',
  },
};

function isRudrakshaLead(item = {}) {
  return /rudra(k|ksh|x)|\bmukhi\b|gauri\s*shankar|jaap\s*mala/i.test([item.productInterest, item.interest].filter(Boolean).join(' '));
}

function redisCfg() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function redis(path) {
  const { url, token } = redisCfg();
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return res.json().catch(() => ({}));
}

// --- phone numbers (critical for FIX 9 matching) ---------------------------
// Compare on the LAST 10 DIGITS only: "+91 98179 75978", "919817975978",
// "098179-75978" and "9817975978" are all the same person.
function last10(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

async function markContacted(number) {
  const n = last10(number);
  if (!n) return;
  try { await redis(`/set/${encodeURIComponent(`gemrishi:contacted:${n}`)}/${encodeURIComponent(new Date().toISOString())}/EX/${60 * 86400}`); }
  catch (err) { console.error('[handoff] markContacted failed:', err.message); }
}

async function contactedAt(number) {
  const n = last10(number);
  if (!n) return '';
  try { const r = await redis(`/get/${encodeURIComponent(`gemrishi:contacted:${n}`)}`); return r?.result || ''; }
  catch (err) { console.error('[handoff] contacted check failed:', err.message); return ''; }
}

// --- routing -----------------------------------------------------------------
const NEEL_REASONS = /order|track|refund|return|replace|damaged|wrong|complaint|angry|discount|negotiat|human_required|talk to|b2b|wholesale|bulk|legal|medical|guarantee/i;

// 2026-10-20 (Ravi): every WhatsApp lead (sales, complaints, B2B - all
// types) goes to Neel only. Instagram routing is unchanged.
function routeFor({ category = '', escalate = false, escalateReason = '', intent = '', platform = '' } = {}) {
  if (String(platform).toLowerCase().includes('whatsapp')) return 'neel';
  if (category === 'b2b' || intent === 'b2b_inquiry') return 'neel';
  if (escalate && NEEL_REASONS.test(`${escalateReason} ${intent}`)) return 'neel';
  if (['support_issue', 'order_status', 'offer_or_discount'].includes(intent) && escalate) return 'neel';
  return 'sales';
}

// =============================================================================
// 2026-10-20 (Ravi): budget routing for every lead Mannat forwards
// (WhatsApp and Instagram):
//   - complaints / orders / refunds / B2B / "talk to a person" -> Neel
//   - budget above Rs 50,000                                    -> Neel
//   - budget up to 50k, or not known -> Yogesh and Vishvas in turn
// The person a customer is given is remembered for 30 days, so the same
// customer always reaches the same person (unless their budget later goes
// to 50k+, then Neel).
// =============================================================================
// Late-night 'send to all three' was replaced (2026-10-20, Ravi): after
// hours Mannat sells herself and leads follow the normal budget rule.
const LATE_NIGHT_ROUTES = ['neel', 'yogesh', 'vishvas'];
function isLateNight(d = new Date()) {
  const from = Number(process.env.LATE_LEADS_FROM_HOUR || 20);
  const to = Number(process.env.LATE_LEADS_TO_HOUR || 10);
  const istHour = (d.getUTCHours() + 5 + Math.floor((d.getUTCMinutes() + 30) / 60)) % 24;
  return istHour >= from || istHour < to;
}

const BUDGET_SPLIT = () => Number(process.env.LEAD_BUDGET_SPLIT || 50000);
// 2026-10-25 (Ravi): leads under 50k go one by one to Lakshya, Yogesh, Vishvas.
const ROUND_ROBIN = ['lakshya', 'yogesh', 'vishvas'];

function parseBudget(text) {
  const t = String(text || '').toLowerCase().replace(/,/g, '');
  let best = 0;
  const re = /(\d+(?:\.\d+)?)\s*(k\b|thousand|hazar|hajar|hazaar|hzr|lakhs?\b|lacs?\b|lac\b|l\b|cr\b|crore)?/g;
  let m;
  while ((m = re.exec(t))) {
    let v = Number(m[1]);
    const u = m[2] || '';
    // "15000 hzr" already means 15,000 - only scale small numbers.
    if (/^k|thousand|haz|haj|hzr/.test(u) && v < 1000) v *= 1000;
    else if (/^la|^l$/.test(u) && v < 1000) v *= 100000;
    else if (/^cr/.test(u) && v < 1000) v *= 10000000;
    if (Number.isFinite(v) && v >= 500 && v > best) best = v; // ignore ratti/carat-sized numbers
  }
  return best;
}

// 2026-10-28 (Ravi): a budget typed in the chat ("budget 20k", "Rs 15000
// tak", "2 lakh") counts even when the form field is empty. Needs a clear
// money cue so phone numbers, ratti and carat sizes are not read as budget.
function budgetFromChat(text) {
  const t = String(text || '').replace(/,/g, '');
  const num = '\\d+(?:\\.\\d+)?';
  const unit = '(?:k\\b|thousand|hazar|hajar|hazaar|hzr|lakhs?\\b|lacs?\\b|lac\\b|crore|cr\\b)';
  const patterns = [
    new RegExp(`budget[^\\d\\n]{0,25}(${num}\\s*${unit}?)`, 'i'),
    new RegExp(`(?:₹|\\brs\\.?|\\binr)\\s*(${num}\\s*${unit}?)`, 'i'),
    new RegExp(`(${num}\\s*${unit})`, 'i'),
    new RegExp(`(${num})\\s*(?:rs\\b|rupees?|rupaye|tak|ke andar|me chahiye)`, 'i'),
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && parseBudget(m[1]) >= 500) return m[1].trim();
  }
  return '';
}

async function assignRoute(item, { escalateToNeel = false } = {}) {
  if (escalateToNeel) return 'neel';
  if (isRudrakshaLead(item)) return 'lakshya'; // 2026-10-21 (Ravi): all Rudraksha leads
  const budget = parseBudget(item.customerBudget);
  if (budget >= BUDGET_SPLIT()) return 'neel'; // 2026-10-24 (Ravi): Rs 50,000 or more (1 lakh+) -> Neel; under 50k -> Yogesh/Vishvas
  const key = `gemrishi:handoff:assigned:${customerKey(item)}`;
  try {
    const got = await redis(`/get/${encodeURIComponent(key)}`);
    if (got?.result && ROUND_ROBIN.includes(got.result)) return got.result;
    const n = await redis(`/incr/${encodeURIComponent('gemrishi:handoff:rr')}`);
    const route = ROUND_ROBIN[(Number(n?.result || 1) - 1) % ROUND_ROBIN.length];
    await redis(`/set/${encodeURIComponent(key)}/${route}/EX/${30 * 86400}`);
    return route;
  } catch (err) {
    console.error('[handoff] round-robin failed, using Yogesh:', err.message);
    return 'yogesh';
  }
}

// Escalation reasons that always belong with Neel (not budget-routed).
function needsNeel({ category = '', escalate = false, escalateReason = '', intent = '' } = {}) {
  if (category === 'b2b' || intent === 'b2b_inquiry') return true;
  if (intent === 'support_issue') return true;
  // 2026-10-25 (Ravi): a pre-sale question ("cash on delivery?") is classified
  // order_status; only send it to Neel when the AI also asked for a person.
  if (intent === 'order_status' && escalate) return true;
  return Boolean(escalate) && /order|track|refund|return|replace|damaged|wrong|complaint|angry|legal|medical|guarantee|b2b|wholesale|bulk|human_required|frustrat/i.test(`${escalateReason} ${intent}`);
}

// FIX (2026-10-07, Ravi): Mannat told customers things like "I will check the
// available pieces with our team and share the photos shortly" - but the team
// was only alerted when a customer gave a phone number or the AI flagged an
// escalation, so the promise went nowhere (shevangisingh26septt: 5 ratti
// Neelam, Rs 50k budget, never contacted). Any reply that promises a team
// follow-up now also hands the chat to the team (once per customer, as usual).
const TEAM_WORDS = '(team|gemologist|expert|specialist|colleague|astrologer|hamari team|humari team|hamaari team|humaari team|hamare|humare|hamaare|humaare)';
const PROMISE_PATTERNS = [
  new RegExp(`${TEAM_WORDS}[^.?!\\n]{0,90}\\b(will|shall|'ll)\\b[^.?!\\n]{0,40}\\b(call|contact|reach|get back|share|send|confirm|check|update|message|connect)`, 'i'),
  new RegExp(`\\b(i|i'll|i will|i am|i'm|let me)\\b[^.?!\\n]{0,60}\\b(check|confirm|get|pull|arrange)[^.?!\\n]{0,60}${TEAM_WORDS}`, 'i'),
  new RegExp(`${TEAM_WORDS}[^.?!\\n]{0,60}(se|ke saath)?[^.?!\\n]{0,40}(confirm|check|pata)\\s*kar[^.?!\\n]{0,30}(batati|batata|bataungi|bataenge|batayenge|bhejti|bhejungi|bhejenge)`, 'i'),
  new RegExp(`${TEAM_WORDS}[^.?!\\n]{0,80}(call|contact|sampark|message|baat)\\s*kar(enge|egi|ega|ke)`, 'i'),
  /\b(share|send)\s*(the\s*)?(photos|pictures|images|details)[^.?!\n]{0,40}\b(shortly|soon|jaldi)\b/i,
  // 2026-10-17 audit: English promises with no "team" word, and "have our
  // gemologist ..." phrasing, never alerted anyone (amitamalik7, nupur6860).
  /\b(i'll|i will|let me|i shall)\s+(confirm|check|verify|find out|get back)\b[^.?!\n]{0,60}\b(price|availability|stock|details|options|photos?|video)/i,
  new RegExp(`\\b(have|get|ask)\\s+(our|the|a)\\s+${TEAM_WORDS}[^.?!\\n]{0,40}\\b(select|pick|choose|share|send|check|call|contact|reach|confirm|source)`, 'i'),
  /\b(confirm|check)\s*kar\w*\s*(ke|kar)?\s*(batati|batata|bataungi|bataunga|bhejti|bhejungi)\b/i,
];
function promisesTeamFollowUp(reply) {
  const t = String(reply || '');
  if (!t) return false;
  return PROMISE_PATTERNS.some((re) => re.test(t));
}

// 2026-10-21: a Meta form lead can land on Instagram DM AND WhatsApp at once
// (two GR ids); dedupeKey = the form's phone keeps it to ONE forward, ONE person.
function customerKey({ grId, platform, contact, dedupeKey }) {
  return String(dedupeKey || grId || `${platform || 'social'}:${contact || 'unknown'}`).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 120);
}

// --- queue / touch / flush ---------------------------------------------------
async function queueForward(item) {
  const route = ROUTES[item.route] ? item.route : 'sales';
  // 2026-10-20: a call request is its own alert even if this customer was
  // already forwarded today (keySuffix 'call').
  const key = item.keySuffix ? `${customerKey(item)}:${item.keySuffix}` : customerKey(item);
  const id = `${route}:${key}`;
  try {
    const done = await redis(`/get/${encodeURIComponent(`gemrishi:handoff:sent:${id}`)}`);
    if (done?.result) return { queued: false, reason: 'already_forwarded' };
    // 2026-10-25 (Ravi): ONE alert per customer. If another person already has
    // (or is about to get) this customer, do not alert a second person unless
    // this is a hard Neel case (complaint / B2B / budget 50k+). Call requests
    // (keySuffix) always go through.
    if (!item.keySuffix && !item.hardNeel) {
      for (const other of Object.keys(ROUTES)) {
        if (other === route) continue;
        const oid = `${other}:${key}`;
        const [sent, pending] = await Promise.all([
          redis(`/get/${encodeURIComponent(`gemrishi:handoff:sent:${oid}`)}`),
          redis(`/get/${encodeURIComponent(`gemrishi:handoff:item:${oid}`)}`),
        ]);
        if (sent?.result || pending?.result) return { queued: false, reason: `already_with_${other}` };
      }
    }
    const record = { ...item, route, key, id, queuedAt: item.queuedAt || new Date().toISOString() };
    const existing = await redis(`/get/${encodeURIComponent(`gemrishi:handoff:item:${id}`)}`);
    if (existing?.result) {
      // keep the richest details we have (later turns usually know more)
      try {
        const old = JSON.parse(existing.result);
        for (const k of Object.keys(old)) if (!record[k] && old[k]) record[k] = old[k];
        record.queuedAt = old.queuedAt || record.queuedAt;
      } catch { /* ignore */ }
    }
    const due = Date.now() + settleSeconds() * 1000;
    await redis(`/set/${encodeURIComponent(`gemrishi:handoff:item:${id}`)}/${encodeURIComponent(JSON.stringify(record))}/EX/${7 * 86400}`);
    await redis(`/zadd/${encodeURIComponent(DUE_ZSET)}/${due}/${encodeURIComponent(id)}`);
    return { queued: true, id, due };
  } catch (err) {
    console.error('[handoff] queue failed:', err.message);
    return { queued: false, reason: err.message };
  }
}

// A new message from a customer with a pending handoff pushes it back, so
// the team gets the record only once they have finished typing.
async function touchPending(item) {
  for (const route of Object.keys(ROUTES)) {
    const id = `${route}:${customerKey(item)}`;
    try {
      const score = await redis(`/zscore/${encodeURIComponent(DUE_ZSET)}/${encodeURIComponent(id)}`);
      if (score?.result) await redis(`/zadd/${encodeURIComponent(DUE_ZSET)}/${Date.now() + settleSeconds() * 1000}/${encodeURIComponent(id)}`);
    } catch { /* best effort */ }
  }
}

function formatRecord(item, transcript) {
  const r = ROUTES[item.route] || ROUTES.sales;
  const lines = [
    `📨 GemRishi handoff - ${r.label} -> ${r.person}`,
    `Customer name: ${item.customerName || 'not given'}`,
    `Customer phone: ${item.customerPhone || 'not given'}`,
  ];
  if (item.customerCity) lines.push(`City: ${item.customerCity}`);
  if (item.customerBudget) lines.push(`Budget: ${item.customerBudget}`);
  if (item.productInterest) lines.push(`Interested in: ${item.productInterest}`);
  if (item.preference) lines.push(`Contact preference: ${item.preference}`);
  lines.push(`Platform: ${item.platform || 'unknown'} (${item.contact || 'unknown'})`);
  if (item.trigger) lines.push(`Why now: ${item.trigger}`);
  if (item.reason) lines.push(`Note: ${item.reason}`);
  lines.push('', 'FULL CHAT:', transcript || '(chat history not available)');
  return lines.join('\n');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
  return true;
}

async function sendEmail(to, subject, body) {
  const url = process.env.LEAD_LOG_WEBHOOK_URL;
  if (!url || !to) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ notifyEmail: to, emailSubject: subject, emailBody: body }),
    });
    if (!res.ok) throw new Error(`email endpoint ${res.status}`);
    return true;
  } finally { clearTimeout(timeout); }
}

// 2026-10-20 (Ravi): the lead also lands on the person's own WhatsApp, sent
// from Mannat's WhatsApp line as an approved UTILITY template (WhatsApp only
// lets a business message someone first with a template). Off until
// LEAD_ALERT_WHATSAPP_ACCOUNT_ID (Mannat's Zernio WhatsApp account) and
// LEAD_ALERT_TEMPLATE are set. Template body variables, in order:
//   {{1}} name  {{2}} phone  {{3}} interested in  {{4}} budget
//   {{5}} platform  {{6}} why forwarded  {{7}} last customer messages
function oneLine(v, max = 300) {
  // WhatsApp template values: no newlines/tabs, no 4+ spaces, not empty.
  const t = String(v || '').replace(/[\r\n\t]+/g, ' | ').replace(/ {2,}/g, ' ').trim();
  return (t || '-').slice(0, max);
}
function lastCustomerLines(transcript, n = 3) {
  return String(transcript || '').split('\n').filter((l) => /^\s*Customer:/i.test(l))
    .slice(-n).map((l) => l.replace(/^\s*Customer:\s*/i, '').trim()).join(' / ');
}
function whatsappAlertParams(item, transcript) {
  return [
    oneLine(item.customerName || 'not given', 60),
    oneLine(item.customerPhone || 'not given', 30),
    oneLine(item.productInterest || 'not clear yet', 80),
    oneLine(item.customerBudget || 'not given', 40),
    oneLine(`${item.platform || 'unknown'} (${item.contact || ''})`, 80),
    oneLine([item.trigger, item.reason].filter(Boolean).join(' - ') || 'genuine lead', 150),
    oneLine(lastCustomerLines(transcript) || '(no messages)', 400),
  ];
}
// =============================================================================
// 2026-10-20 (Ravi): getting a lead onto a team member's own WhatsApp, from
// Mannat's line (+91 74969 97220). Tried in this order:
//   1. CHECK-IN: if the person messaged the 220 number in the last 24 hours
//      (e.g. "Any new lead for me"), WhatsApp lets us send a normal message -
//      the full lead goes straight into that chat.
//   2. TEMPLATE: the approved mannat_lead_alert template.
//   3. DIRECT SEND: Meta's template-free utility message (only if the
//      account is eligible).
//   4. Otherwise the lead waits in their pending list and is sent the moment
//      they check in. Telegram always gets a copy as well.
// =============================================================================
const WINDOW_TTL = 23 * 3600; // a little under WhatsApp's 24h window
function staffWindowKey(route) { return `gemrishi:staff-window:${route}`; }
function staffPendingKey(route) { return `gemrishi:staff-pending:${route}`; }

function routeForStaffNumber(number) {
  const n = last10(number);
  if (!n) return '';
  for (const [route, r] of Object.entries(ROUTES)) if (last10(r.phone) === n) return route;
  return '';
}

// 2026-10-25 (Ravi): short Hinglish handoff - what Mannat did, what the
// customer said, and what the salesperson should do next. No chat dump.
function whatsappLeadText(item, transcript) {
  const r = ROUTES[item.route] || ROUTES.sales;
  const who = `${item.customerName || 'Customer'}${item.customerPhone ? `, ${item.customerPhone}` : ''}`;
  const bits = [];
  if (item.productInterest) bits.push(item.productInterest);
  if (item.customerBudget) bits.push(`budget ${item.customerBudget}`);
  if (item.customerCity) bits.push(item.customerCity);
  const did = bits.length
    ? `Maine inse baat kar li hai: ${bits.join(', ')}.`
    : 'Maine inse basic baat kar li hai.';
  const said = lastCustomerLines(transcript, 2);
  const lines = [
    `🔔 ${r.person}, naya lead: *${who}* (${item.platform || 'unknown'})`,
    did,
    item.trigger || item.reason ? `Kyun aapko bheja: ${[item.trigger, item.reason].filter(Boolean).join(' - ')}.` : '',
    said ? `Customer ne last bola: "${said.slice(0, 200)}"` : '',
    'Ab aap inse baat karo, price/options confirm karo aur yahan se handle karo.',
  ].filter(Boolean);
  return lines.join('\n').slice(0, 1200);
}

async function sendInWindow(route, text, idempotencyKey) {
  const raw = await redis(`/get/${encodeURIComponent(staffWindowKey(route))}`);
  if (!raw?.result) return false;
  const w = JSON.parse(raw.result);
  const { sendConversationMessage } = require('./zernioClient');
  await sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId: w.conversationId, accountId: w.accountId, text, idempotencyKey });
  return true;
}

// 2026-10-25 (Ravi): plain text to one team member's WhatsApp - straight in if
// their 24h window is open, otherwise waiting for their next check-in.
async function notifyStaff(route, text, idempotencyKey) {
  try { if (await sendInWindow(route, text, idempotencyKey)) return 'window'; }
  catch (err) { console.error('[handoff] notifyStaff send failed:', err.message); }
  try {
    await redis(`/rpush/${encodeURIComponent(staffPendingKey(route))}/${encodeURIComponent(text)}`);
    await redis(`/expire/${encodeURIComponent(staffPendingKey(route))}/${7 * 86400}`);
    return 'pending';
  } catch (err) { console.error('[handoff] notifyStaff pending failed:', err.message); }
  return false;
}

async function sendWhatsAppAlert(item, transcript) {
  const accountId = process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID;
  const r = ROUTES[item.route] || ROUTES.sales;
  if (!accountId || !r.phone) return false;
  const text = whatsappLeadText(item, transcript);
  const idem = `lead-alert-${item.id || item.key}`.slice(0, 110);
  const zc = require('./zernioClient');
  // 1. check-in window
  try { if (await sendInWindow(item.route, text, `${idem}-w`)) return 'window'; }
  catch (err) { console.error('[handoff] in-window send failed:', err.message); }
  // 2. approved template
  if (process.env.LEAD_ALERT_TEMPLATE && String(process.env.LEAD_ALERT_TEMPLATE_CONFIRMED || '').toLowerCase() === 'true') {
    try {
      await zc.sendWhatsAppTemplate({
        apiKey: process.env.ZERNIO_API_KEY, accountId, to: r.phone, templateName: process.env.LEAD_ALERT_TEMPLATE,
        language: process.env.LEAD_ALERT_TEMPLATE_LANG || 'en', params: whatsappAlertParams(item, transcript), idempotencyKey: `${idem}-t`,
      });
      return 'template';
    } catch (err) { console.error('[handoff] template send failed:', err.message); }
  }
  // 3. Meta Direct Send (template-free utility)
  if (String(process.env.LEAD_ALERT_DIRECT_SEND || 'off').toLowerCase() !== 'off') {
    try {
      // WhatsApp Direct Send allows max 1024 characters (2026-10-21).
      const short = text.length > 1000 ? `${text.slice(0, 990)}\n…` : text;
      await zc.sendWhatsAppDirectUtility({ apiKey: process.env.ZERNIO_API_KEY, accountId, to: r.phone, text: short, idempotencyKey: `${idem}-d` });
      return 'direct_send';
    } catch (err) { console.error('[handoff] direct-send failed:', err.message); }
  }
  // 4. wait for the person to check in
  try {
    await redis(`/rpush/${encodeURIComponent(staffPendingKey(item.route))}/${encodeURIComponent(text)}`);
    await redis(`/expire/${encodeURIComponent(staffPendingKey(item.route))}/${7 * 86400}`);
    console.log('[handoff] lead waiting for check-in:', item.route);
    return 'pending'; // saved - goes out the moment they check in
  } catch (err) { console.error('[handoff] pending save failed:', err.message); }
  return false;
}

async function openStaffWindow({ route, conversationId, accountId }) {
  if (!conversationId || !accountId) return;
  await redis(`/set/${encodeURIComponent(staffWindowKey(route))}/${encodeURIComponent(JSON.stringify({ conversationId, accountId, at: new Date().toISOString() }))}/EX/${WINDOW_TTL}`);
}

// A team member messaged Mannat's WhatsApp ("Any new lead for me"): open
// their 24h window, send everything waiting for them, and confirm.
// A template alert ("New GemRishi lead for ...") the person never got:
// failed outright (Meta 131042 billing) or stuck on "sent" for 20+ minutes.
function isUndelivered(m) {
  if (m?.direction !== 'outgoing') return false;
  if (m.deliveryStatus === 'failed') return true;
  const isTemplate = Boolean(m?.metadata?.templateName);
  return isTemplate && m.deliveryStatus === 'sent' && Date.now() - new Date(m.createdAt).getTime() > 20 * 60 * 1000;
}

// Turn a template alert into the short Hinglish staff message.
function templateToShort(text, person) {
  const g = (re) => ((text.match(re) || [])[1] || '').trim();
  const phone = g(/Phone:\s*(.+)/); const src = g(/Source:\s*(.+)/);
  const interest = g(/Interested in:\s*(.+)/); const reason = g(/Reason for forwarding:\s*(.+)/);
  const said = g(/Recent customer messages:\s*(.+)/);
  const who = /not given/i.test(phone) ? src : phone;
  return [`🔔 ${person}, naya lead: *${who}* (alert pehle deliver nahi hua tha)`,
    `Maine inse baat kar li hai: ${interest || 'requirement'}.`,
    reason ? `Kyun aapko bheja: ${reason}.` : '',
    said ? `Customer ne last bola: "${said}"` : '',
    'Ab aap inse baat karo, price/options confirm karo aur yahan se handle karo.'].filter(Boolean).join('\n');
}

async function failedAlerts({ route, conversationId, accountId }) {
  const { listInboxConversationMessages } = require('./zernioClient');
  const data = await listInboxConversationMessages({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, limit: 100, sortOrder: 'desc' });
  const msgs = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data?.data) ? data.data : []);
  const since = Date.now() - 7 * 86400 * 1000;
  const out = [];
  // Text that DID reach the person (e.g. a manual re-send) - a failed alert
  // whose customer phone appears there was already passed on. Spaces removed
  // so "+91 92164 06145" matches "+919216406145".
  const delivered = msgs.filter((m) => m?.direction === 'outgoing' && !isUndelivered(m)).map((m) => String(m.message || '')).join('\n').replace(/\s/g, '');
  for (const m of msgs) {
    if (!isUndelivered(m)) continue;
    const text = String(m.message || '');
    const tpl = /^New GemRishi lead for/.test(text);
    // Old format ("🔔 New lead ... Phone: / Name:"), the 2026-10-25 short
    // Hinglish format, and the template alert ("New GemRishi lead for ...").
    if (!tpl && !/^🔔 (New lead|[^\n]*naya lead)/.test(text)) continue;
    const head = text.split('\n')[0];
    const ph = (text.match(/Phone:\s*(\+?\d[\d ]{8,})/) || head.match(/(\+?\d[\d ]{8,}\d)/) || [])[1];
    if (ph && delivered.includes(ph.replace(/\s/g, ''))) continue;
    const ig = tpl ? (text.match(/Source: instagram \(([^)]+)\)/) || [])[1] : '';
    if (ig && delivered.includes(ig)) continue;
    const nm = ((text.match(/Name:\s*(.+)/) || head.match(/\*([^*,]+)/) || [])[1] || '').trim();
    if (nm && !/not given|customer/i.test(nm) && nm.length > 3 && delivered.toLowerCase().includes(nm.toLowerCase().replace(/\s/g, ''))) continue;
    if (new Date(m.createdAt).getTime() < since) continue;
    const mark = `gemrishi:staff-resent:${m.id}`;
    const fresh = await redis(`/set/${encodeURIComponent(mark)}/1/EX/${7 * 86400}/NX`);
    if (fresh?.result !== 'OK') continue; // already re-sent once
    out.push(tpl ? templateToShort(text, ROUTES[route]?.person || '') : m.message);
  }
  return out.reverse(); // oldest first
}

async function staffCheckIn({ route, conversationId, accountId }) {
  const r = ROUTES[route];
  if (!r || !conversationId || !accountId) return { ok: false };
  const { sendConversationMessage } = require('./zernioClient');
  const send = (text, i) => sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text, idempotencyKey: `checkin-${route}-${Date.now()}-${i}` });
  const wasOpen = Boolean((await redis(`/get/${encodeURIComponent(staffWindowKey(route))}`))?.result);
  await openStaffWindow({ route, conversationId, accountId });
  let pending = [];
  try {
    const got = await redis(`/lrange/${encodeURIComponent(staffPendingKey(route))}/0/-1`);
    pending = Array.isArray(got?.result) ? got.result : [];
    if (pending.length) await redis(`/del/${encodeURIComponent(staffPendingKey(route))}`);
  } catch (err) { console.error('[handoff] pending read failed:', err.message); }
  // 2026-10-21: Direct Send / template alerts are accepted by the API and
  // then fail on Meta's side (131042 billing/currency) - they never arrived.
  // Re-send every failed lead alert of the last 3 days to this person.
  try { pending = pending.concat(await failedAlerts({ route, conversationId, accountId })); }
  catch (err) { console.error('[handoff] failed-alert lookup failed:', err.message); }
  // Already checked in today and nothing waiting -> stay quiet (no spam).
  if (wasOpen && !pending.length) return { ok: true, delivered: 0, quiet: true };
  const first = pending.length
    ? `✅ Hi ${r.person}, ${pending.length} lead${pending.length > 1 ? 's' : ''} waiting for you - sending now. New leads will come here for the next 24 hours.`
    : `✅ Hi ${r.person}, no new leads right now. New leads will come here for the next 24 hours - message again tomorrow to keep receiving them.`;
  await send(first, 0);
  for (let i = 0; i < pending.length; i += 1) {
    try { await send(pending[i], i + 1); } catch (err) { console.error('[handoff] pending send failed:', err.message); }
  }
  return { ok: true, delivered: pending.length };
}

async function deliver(item) {
  let transcript = '';
  try {
    if (item.memoryScope && item.memoryId) transcript = formatMemory(await getMemory(item.memoryScope, item.memoryId));
  } catch (err) { console.error('[handoff] transcript read failed:', err.message); }
  const text = formatRecord(item, transcript);
  const r = ROUTES[item.route] || ROUTES.sales;
  const subject = `GemRishi handoff (${r.label}) - ${item.customerName || item.contact || 'customer'}`;
  // 2026-10-20 (Ravi): no emails - lead records go by Telegram (and by
  // WhatsApp once the mannat_lead_alert template is approved). Set
  // HANDOFF_EMAILS=on to bring emails back.
  const emailsOn = String(process.env.HANDOFF_EMAILS || 'off').toLowerCase() === 'on';
  const results = await Promise.allSettled([sendTelegram(text), emailsOn ? sendEmail(r.email(), subject, text) : Promise.resolve(false), sendWhatsAppAlert(item, transcript)]);
  for (const x of results) if (x.status === 'rejected') console.error('[handoff] one channel failed:', x.reason?.message);
  const ok = results.some((x) => x.status === 'fulfilled' && x.value);
  if (!ok) throw new Error(results.map((x) => x.reason?.message || 'not configured').join('; '));
}

async function flushDue({ max = 10 } = {}) {
  let ids = [];
  try {
    const r = await redis(`/zrangebyscore/${encodeURIComponent(DUE_ZSET)}/-inf/${Date.now()}/LIMIT/0/${max}`);
    ids = Array.isArray(r?.result) ? r.result : [];
  } catch (err) { console.error('[handoff] due read failed:', err.message); return 0; }
  let sent = 0;
  for (const id of ids) {
    try {
      // claim: only one invocation may send this record, exactly once
      const claim = await redis(`/zrem/${encodeURIComponent(DUE_ZSET)}/${encodeURIComponent(id)}`);
      if (Number(claim?.result || 0) !== 1) continue;
      const raw = await redis(`/get/${encodeURIComponent(`gemrishi:handoff:item:${id}`)}`);
      if (!raw?.result) continue;
      const item = JSON.parse(raw.result);
      const ttl = item.route === 'neel' ? ESCALATION_ONCE_TTL : SALES_ONCE_TTL;
      const first = await redis(`/set/${encodeURIComponent(`gemrishi:handoff:sent:${id}`)}/${encodeURIComponent(new Date().toISOString())}/EX/${ttl}/NX`);
      if (first && first.result !== 'OK') continue; // already forwarded
      try {
        await deliver(item);
        sent += 1;
        await redis(`/del/${encodeURIComponent(`gemrishi:handoff:item:${id}`)}`);
      } catch (err) {
        console.error('[handoff] delivery failed, will retry:', err.message);
        await redis(`/del/${encodeURIComponent(`gemrishi:handoff:sent:${id}`)}`);
        await redis(`/zadd/${encodeURIComponent(DUE_ZSET)}/${Date.now() + 120000}/${encodeURIComponent(id)}`);
      }
    } catch (err) { console.error('[handoff] flush item failed:', err.message); }
  }
  return sent;
}

module.exports = { budgetFromChat, isRudrakshaLead, ROUTES, LATE_NIGHT_ROUTES, isLateNight, routeFor, assignRoute, needsNeel, parseBudget, routeForStaffNumber, staffCheckIn, openStaffWindow, queueForward, touchPending, flushDue, markContacted, contactedAt, last10, settleSeconds, promisesTeamFollowUp, notifyStaff, _internal: { failedAlerts, isUndelivered, templateToShort, formatRecord, customerKey, whatsappAlertParams, whatsappLeadText, sendWhatsAppAlert } };
