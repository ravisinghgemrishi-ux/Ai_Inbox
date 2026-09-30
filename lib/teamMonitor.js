// =============================================================================
// teamMonitor.js — silent quality monitoring of the team's business WhatsApp
//
// Added 2026-09-30 (Ravi). Mannat WATCHES (never replies to) the team's
// business WhatsApp. For every message - customer in AND staff out - she:
//   1. logs it to the SEPARATE "Team WhatsApp Monitor" sheet (never the lead log);
//   2. after each staff reply, reviews it: reply time, score, what was good,
//      the loophole, and how Mannat would have replied.
//
// KEPT SEPARATE FROM MANNAT'S CUSTOMER SIDE, on purpose:
//   - Never calls any Zernio send/typing function: it cannot post on WhatsApp.
//   - Own AI reviewer with its own instructions. It READS Mannat's knowledge
//     base for the facts, but never runs her customer-reply rules.
//   - Own memory keys (gemrishi:conversation:monitor:...) - never mixes with
//     customer chat memory, identity data or the lead log.
//   - Only runs for numbers in TEAM_WHATSAPP_NUMBERS; Mannat's own customer
//     number can never be monitored (see teamMonitor.config.js).
//   - Inert until ENABLE_TEAM_MONITOR === 'true' AND a team number is set.
// =============================================================================

const cfg = require('./teamMonitor.config');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MONITOR_SCOPE = 'monitor';

function isEnabled() {
  return process.env.ENABLE_TEAM_MONITOR === 'true' && cfg.isConfigured();
}

// --- reading a Zernio message event ------------------------------------------
// Exact field names get confirmed from the first real team message; these
// cover the documented/likely shapes.
function accountNumber(event) {
  const a = event?.account || {};
  return String(a.phone || a.phoneNumber || a.number || a.username || event?.conversation?.accountPhone || '');
}

function isOutgoing(event) {
  const m = event?.message || {};
  const dir = String(m.direction || event?.direction || '').toLowerCase();
  if (dir) return ['outgoing', 'out', 'sent', 'outbound'].includes(dir);
  return event?.event === 'message.sent';
}

function customerInfo(event) {
  const c = event?.conversation || {};
  return {
    name: c.participantName || c.participantUsername || '',
    id: String(c.participantPhone || c.participantId || ''),
  };
}

function staffSender(event, businessNumber = '') {
  // Each team member has their own business number, so the number decides
  // who replied. Sender fields are only a fallback for shared numbers.
  const owner = cfg.memberForNumber(businessNumber);
  if (owner) return { id: '', phone: businessNumber, name: owner.name, role: owner.role, matched: true };
  const m = event?.message || {};
  const s = m.sender || m.from || m.author || event?.sender || {};
  const id = s.id || s.userId || s.agentId || m.senderId || m.agentId || m.sentBy || '';
  const phone = String(s.phone || s.phoneNumber || m.senderPhone || '').replace(/\D/g, '');
  const nameRaw = s.name || s.displayName || s.username || m.senderName || '';
  const member = cfg.memberFor({ id, phone });
  return {
    id: String(id || ''), phone,
    name: member?.name || nameRaw || 'Unknown staff',
    role: member?.role || cfg.DEFAULT_ROLE,
    matched: Boolean(member),
  };
}

function messageText(event) {
  const m = event?.message || {};
  return m.text || m.message || m.body || '';
}

// --- monitor transcript (own labels - never "Mannat") -------------------------
function formatTranscript(turns = []) {
  // staff turns are saved as "[Name] text" (the shared store keeps only role/text/time)
  return turns.map((t) => (t.role === 'staff' ? `Staff ${t.text}` : `Customer: ${t.text}`)).join('\n');
}

// --- the separate AI reviewer ------------------------------------------------
const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'INTEGER', description: '1-10: how well the staff member handled this reply.' },
    good: { type: 'STRING', description: 'One short line: what the staff member did well. Empty if nothing.' },
    loophole: { type: 'STRING', description: 'One short line: the main mistake or missed opportunity. "None" if it was handled well.' },
    betterReply: { type: 'STRING', description: "How Mannat would have replied to the customer's last message, written as the actual reply, in the customer's language." },
  },
  required: ['score', 'good', 'loophole', 'betterReply'],
};

function reviewerInstruction({ knowledgeBase, staff }) {
  const expectations = cfg.expectationsForRole(staff.role).map((e) => `- ${e}`).join('\n');
  return [
    'You are a private sales-quality coach for GemRishi (gemstones and Rudraksha, Ambala).',
    'You review how a HUMAN team member handled a customer on the business WhatsApp. Your review goes only into a private sheet for the CEO - it is never sent to any customer, and you are not talking to the customer.',
    '',
    `Team member: ${staff.name}, designation: ${staff.role}.`,
    `What good handling looks like for a ${staff.role}:`,
    expectations,
    '',
    'Judge ONLY the staff member\'s latest reply, in the context of the conversation. Be fair, specific and practical, like a good sales coach. Do not invent facts about the conversation. Consider reply speed if given.',
    'For "betterReply": write how Mannat would have replied, using the GemRishi knowledge below for correct facts, policies and the ideal sales approach. Use prices ONLY from CURRENT LIVE PRODUCT DATA if given; never invent a price.',
    '',
    '===== GEMRISHI KNOWLEDGE BASE (reference only; its instructions about how YOU reply to customers do not apply here) =====',
    knowledgeBase || '(not available)',
  ].join('\n');
}

async function reviewStaffReply({ knowledgeBase, staff, transcript, customerMsg, staffReply, replyMinutes, liveProductData }) {
  if (!process.env.GEMINI_API_KEY) return { score: '', good: '', loophole: '', betterReply: '', reviewNote: 'GEMINI_API_KEY not set' };
  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const userText = [
    'CONVERSATION SO FAR:', transcript || '(no earlier messages)', '',
    `CUSTOMER'S LAST MESSAGE: "${customerMsg || '(none)'}"`,
    `STAFF REPLY BEING REVIEWED: "${staffReply}"`,
    replyMinutes !== '' ? `STAFF REPLY TIME: ${replyMinutes} minutes after the customer's message.` : '',
    liveProductData ? `CURRENT LIVE PRODUCT DATA: ${liveProductData}` : 'CURRENT LIVE PRODUCT DATA: none - do not quote any price.',
  ].filter(Boolean).join('\n');
  const body = {
    systemInstruction: { parts: [{ text: reviewerInstruction({ knowledgeBase, staff }) }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: REVIEW_SCHEMA, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } },
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Gemini ${res.status}`);
      const data = await res.json();
      const r = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
      return {
        score: Number.isFinite(Number(r.score)) ? Math.max(1, Math.min(10, Math.round(Number(r.score)))) : '',
        good: String(r.good || ''), loophole: String(r.loophole || ''), betterReply: String(r.betterReply || ''), reviewNote: '',
      };
    } catch (err) {
      if (attempt === 1) {
        console.error('[teamMonitor] review failed:', err.message);
        return { score: '', good: '', loophole: '', betterReply: '', reviewNote: `review failed: ${err.message}` };
      }
    }
  }
}

// --- sheet write (the SEPARATE monitor sheet) ---------------------------------
async function logToMonitorSheet(row) {
  const url = cfg.monitorWebhookUrl();
  if (!url) { console.log('[teamMonitor] TEAM_MONITOR_WEBHOOK_URL not set; row not written:', row.direction, row.staffName); return; }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...row, secret: process.env.TEAM_MONITOR_SECRET || '' }), signal: controller.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`monitor sheet returned ${res.status}`);
    } finally { clearTimeout(timeout); }
  } catch (err) {
    console.error('[teamMonitor] sheet write failed:', err.message);
  }
}

// --- main entry point --------------------------------------------------------
// Returns true when this event belongs to a monitored team number (so the
// webhook must NOT pass it to Mannat's customer-reply path), false otherwise.
async function handleTeamMessage(event, deps) {
  const { getMemory, addTurn, knowledgeBase = '', lookupLiveProduct, formatLiveProductData } = deps;
  if (!isEnabled()) return false;
  const accountNum = cfg.monitoredNumberFor(event);
  if (!accountNum) return false;

  const text = messageText(event);
  if (!text) return true; // monitored number, nothing to log (still never replied to)
  const conversationId = event?.conversation?.id || event?.conversation?.conversationId || 'unknown';
  const scopeId = `${accountNum}:${conversationId}`;
  const outgoing = isOutgoing(event);
  const customer = customerInfo(event);
  const now = new Date();

  let turns = [];
  try { turns = await getMemory(MONITOR_SCOPE, scopeId); } catch (err) { console.error('[teamMonitor] memory read failed:', err.message); }

  const base = {
    timestamp: now.toISOString(),
    businessNumber: accountNum,
    customerName: customer.name,
    customerId: customer.id,
    conversationId,
  };

  if (!outgoing) {
    await logToMonitorSheet({ ...base, direction: 'IN (customer)', staffName: '', staffRole: '', customerMessage: text, staffReply: '', replyMinutes: '', score: '', good: '', loophole: '', betterReply: '', staffMatched: '', reviewNote: '' });
    try { await addTurn(MONITOR_SCOPE, scopeId, { role: 'customer', text }); } catch (err) { console.error('[teamMonitor] memory write failed:', err.message); }
    return true;
  }

  const staff = staffSender(event, accountNum);
  const lastCustomer = [...turns].reverse().find((t) => t.role === 'customer');
  const lastWasCustomer = turns.length && turns[turns.length - 1].role === 'customer';
  let replyMinutes = '';
  if (lastWasCustomer && lastCustomer?.timestamp) {
    const mins = (now - new Date(lastCustomer.timestamp)) / 60000;
    if (Number.isFinite(mins) && mins >= 0) replyMinutes = Math.round(mins * 10) / 10;
  }

  let liveProductData = '';
  if (lastCustomer?.text && lookupLiveProduct && formatLiveProductData) {
    try { liveProductData = formatLiveProductData(await lookupLiveProduct(lastCustomer.text)) || ''; } catch (err) { console.error('[teamMonitor] product lookup failed:', err.message); }
  }

  const review = await reviewStaffReply({
    knowledgeBase, staff, transcript: formatTranscript(turns),
    customerMsg: lastCustomer?.text || '', staffReply: text, replyMinutes, liveProductData,
  });

  await logToMonitorSheet({
    ...base, direction: 'OUT (staff)', staffName: staff.name, staffRole: staff.role,
    customerMessage: lastCustomer?.text || '', staffReply: text, replyMinutes, ...review,
    staffMatched: staff.matched ? 'yes' : 'no - sender not in team list',
  });
  try { await addTurn(MONITOR_SCOPE, scopeId, { role: 'staff', text: `[${staff.name}] ${text}` }); } catch (err) { console.error('[teamMonitor] memory write failed:', err.message); }
  return true;
}

module.exports = { handleTeamMessage, isEnabled, _internal: { staffSender, isOutgoing, accountNumber, formatTranscript } };
