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
const { markContacted } = require('./handoff');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MONITOR_SCOPE = 'monitor';

// Own tiny Redis helper: marks each message as logged so the live monitor and
// the history import never write the same message twice.
async function redis(path) {
  const url = (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, '');
  const token = process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '';
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return res.json().catch(() => ({}));
}
// Returns true the FIRST time a message id is seen (so: go ahead and log).
async function claimMessage(messageId) {
  if (!messageId) return true;
  try {
    const r = await redis(`/set/${encodeURIComponent(`gemrishi:monitor-logged:${messageId}`)}/1/EX/${200 * 86400}/NX`);
    return !r || r.result === 'OK';
  } catch { return true; } // never lose a row because Redis hiccuped
}

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

// Added 2026-09-30 (Ravi): photos, voice notes, documents etc. are logged
// too, as a label plus any caption, so no reply is invisible to the CEO.
const MEDIA_LABELS = {
  audio: 'Voice note', voice: 'Voice note', ptt: 'Voice note',
  image: 'Photo', photo: 'Photo', video: 'Video', document: 'Document', file: 'Document',
  sticker: 'Sticker', location: 'Location', contacts: 'Contact card', contact: 'Contact card',
};
function describeMessage(m = {}) {
  const text = String(m.text || m.message || m.body || m.caption || '').trim();
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const types = atts.map((a) => String(a?.type || '').toLowerCase()).filter(Boolean);
  const msgType = String(m.type || m.messageType || '').toLowerCase();
  if (!types.length && MEDIA_LABELS[msgType]) types.push(msgType);
  const labels = [...new Set(types.map((t) => MEDIA_LABELS[t] || 'Attachment'))];
  const media = labels.map((l) => `[${l}]`).join(' ');
  return { text: [media, text].filter(Boolean).join(' '), mediaOnly: Boolean(media) && !text };
}

function messageText(event) {
  return describeMessage(event?.message || {}).text;
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
    // 2026-10-04: was 8s - the sheet script (lock + append) often needs
    // longer, which caused ~286 "aborted" errors in a week.
    const timeout = setTimeout(() => controller.abort(), 25000);
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

  // FIX 16 (2026-10-04, Ravi): staff-to-staff chats (both sides are company
  // numbers) are internal - not logged at all, and never replied to.
  const customer = customerInfo(event);
  if (cfg.isCompanyNumber(customer.id) || cfg.isCompanyNumber(customer.name)) return true;

  const described = describeMessage(event?.message || {});
  const text = described.text;
  if (!text) return true; // monitored number, nothing to log (still never replied to)
  if (!(await claimMessage(event?.message?.id))) return true; // already logged
  const conversationId = event?.conversation?.id || event?.conversation?.conversationId || 'unknown';
  const scopeId = `${accountNum}:${conversationId}`;
  const outgoing = isOutgoing(event);
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
    // FIX 5 (2026-10-04): no half-row for an incoming message any more. It is
    // held in the monitor memory and written together with the staff reply,
    // on ONE row (customer message left, staff reply right, review alongside).
    try { await addTurn(MONITOR_SCOPE, scopeId, { role: 'customer', text }); } catch (err) { console.error('[teamMonitor] memory write failed:', err.message); }
    return true;
  }

  // A staff member messaged this customer: counts as "contacted" (FIX 9).
  await markContacted(customer.id);

  const staff = staffSender(event, accountNum);
  // All customer messages since the last staff reply, grouped together.
  const pending = [];
  for (let i = turns.length - 1; i >= 0 && turns[i].role === 'customer'; i -= 1) pending.unshift(turns[i]);
  const isFollowUp = pending.length === 0;
  const customerMsg = isFollowUp ? '' : pending.map((t) => t.text).join('\n');
  let replyMinutes = '';
  if (!isFollowUp && pending[0]?.timestamp) {
    const mins = (now - new Date(pending[0].timestamp)) / 60000;
    if (Number.isFinite(mins) && mins >= 0) replyMinutes = Math.round(mins * 10) / 10;
  }

  let liveProductData = '';
  if (customerMsg && lookupLiveProduct && formatLiveProductData) {
    try { liveProductData = formatLiveProductData(await lookupLiveProduct(customerMsg)) || ''; } catch (err) { console.error('[teamMonitor] product lookup failed:', err.message); }
  }

  let review;
  if (described.mediaOnly) review = { score: '', good: '', loophole: '', betterReply: '', reviewNote: 'media reply (voice note/photo/file) - content not visible, not scored' };
  else if (isFollowUp) review = { score: '', good: '', loophole: '', betterReply: '', reviewNote: 'staff follow-up message (no new customer message) - not scored' };
  else {
    review = await reviewStaffReply({
      knowledgeBase, staff, transcript: formatTranscript(turns.slice(0, turns.length - pending.length)),
      customerMsg, staffReply: text, replyMinutes, liveProductData,
    });
  }

  await logToMonitorSheet({
    ...base, direction: 'OUT (staff)', staffName: staff.name, staffRole: staff.role,
    customerMessage: isFollowUp ? '(follow-up - no new customer message)' : customerMsg, staffReply: text, replyMinutes, ...review,
    staffMatched: staff.matched ? 'yes' : 'no - sender not in team list',
  });
  try { await addTurn(MONITOR_SCOPE, scopeId, { role: 'staff', text: `[${staff.name}] ${text}` }); } catch (err) { console.error('[teamMonitor] memory write failed:', err.message); }
  return true;
}

// --- ALERT: a team (or Mannat's own) WhatsApp number disconnected ------------
// Added 2026-09-30 (Ravi). A staff member can unlink their number from their
// phone (WhatsApp Business > Settings > Account > Business Platform >
// Disconnect), which silently stops all monitoring. Zernio sends
// account.disconnected; we alert Ravi on Telegram + email immediately and add
// a row to the monitor sheet. (Meta's notice is best-effort, per Zernio docs.)
function accountPhoneDigits(a = {}) {
  for (const v of [a.username, a.phone, a.phoneNumber, a.displayName]) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length >= 10) return d.length === 10 ? `91${d}` : d;
  }
  return '';
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) { console.error('[teamMonitor] telegram alert failed:', err.message); }
}

async function sendEmail(subject, body) {
  const url = process.env.LEAD_LOG_WEBHOOK_URL;
  const to = process.env.TEAM_MONITOR_ALERT_EMAIL || 'Ravi@gemrishi.com';
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifyEmail: to, emailSubject: subject, emailBody: body }) });
  } catch (err) { console.error('[teamMonitor] email alert failed:', err.message); }
}

async function handleAccountEvent(event) {
  const a = event?.account || {};
  if (String(a.platform || '').toLowerCase() !== 'whatsapp') return false;
  const phone = accountPhoneDigits(a);
  const member = cfg.memberForNumber(phone);
  const isMannat = cfg.protectedNumbers().includes(phone);
  if (!member && !isMannat) return false;
  const who = member ? `${member.name} (${member.role})` : 'Mannat AI (customer WhatsApp)';
  const disconnected = event?.event === 'account.disconnected';
  const reason = a.reason || a.disconnectionType || event?.reason || '';
  const title = disconnected ? '⚠️ WhatsApp number DISCONNECTED from Zernio' : '✅ WhatsApp number connected to Zernio';
  const body = [title, `Who: ${who}`, `Number: +${phone}`, reason ? `Reason: ${reason}` : '',
    disconnected ? (member ? 'Monitoring of this number has STOPPED until it is reconnected.' : 'Mannat can no longer reply to customers on this number until it is reconnected.') : 'Monitoring is active for this number.'].filter(Boolean).join('\n');
  console.log(`[teamMonitor] account event: ${body.replace(/\n/g, ' | ')}`);
  if (disconnected) {
    await sendTelegram(body);
    await sendEmail(`GemRishi: ${who} WhatsApp disconnected`, body);
  }
  if (isEnabled()) {
    await logToMonitorSheet({ timestamp: new Date().toISOString(), businessNumber: phone, customerName: '', customerId: '', conversationId: '',
      direction: disconnected ? 'ALERT - DISCONNECTED' : 'ALERT - CONNECTED', staffName: member?.name || '', staffRole: member?.role || '',
      customerMessage: '', staffReply: '', replyMinutes: '', score: '', good: '', loophole: '', betterReply: '', staffMatched: '', reviewNote: body });
  }
  return true;
}

// --- HISTORY IMPORT: log a team number's earlier chats ------------------------
// Added 2026-09-30 (Ravi). Reads each conversation of a team number through
// Zernio and writes every message to the monitor sheet in batches. History is
// logged as-is (not AI-scored) to keep it fast; reply times are calculated.
// Runs in small time-boxed batches; returns nextCursor until done.
async function postRowsToSheet(rows) {
  const url = cfg.monitorWebhookUrl();
  if (!url || !rows.length) return;
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
    body: JSON.stringify({ secret: process.env.TEAM_MONITOR_SECRET || '', rows }),
  });
  if (!res.ok) throw new Error(`monitor sheet returned ${res.status}`);
  const out = await res.json().catch(() => ({}));
  if (out && out.ok === false) throw new Error(`monitor sheet refused rows: ${out.error || 'unknown'}`);
}

function msgTime(m) {
  const t = m?.createdAt || m?.sentAt || m?.timestamp || m?.date || m?.created_at;
  const d = t ? new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

async function findAccountId(zc, apiKey, phone) {
  const data = await zc.listAccounts({ apiKey, platform: 'whatsapp' });
  const list = Array.isArray(data?.accounts) ? data.accounts : Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  for (const a of list) {
    if (accountPhoneDigits(a) === phone) return String(a._id || a.id || a.accountId || '');
  }
  return '';
}

async function importHistory({ zc, apiKey, number, cursor = '', budgetMs = 45000 }) {
  const started = Date.now();
  const phone = String(number || '').replace(/\D/g, '');
  const member = cfg.memberForNumber(phone);
  if (!member) throw new Error(`+${phone} is not in the team list`);
  const accountId = await findAccountId(zc, apiKey, phone);
  if (!accountId) throw new Error(`+${phone} is not connected in Zernio`);
  const out = { number: phone, staff: member.name, accountId, conversations: 0, messagesLogged: 0, skippedAlreadyLogged: 0, nextCursor: '', done: false };
  let convCursor = cursor || undefined;
  while (Date.now() - started < budgetMs) {
    const page = await zc.listInboxConversations({ apiKey, accountId, platform: 'whatsapp', status: '', limit: 20, cursor: convCursor, sortOrder: 'desc' });
    const convs = Array.isArray(page?.data) ? page.data : Array.isArray(page?.conversations) ? page.conversations : [];
    for (const conv of convs) {
      out.conversations += 1;
      const rows = [];
      let msgCursor; const all = [];
      for (let p = 0; p < 20; p += 1) {
        const mp = await zc.listInboxConversationMessages({ apiKey, conversationId: conv.id, accountId, limit: 100, cursor: msgCursor, sortOrder: 'asc' });
        const ms = Array.isArray(mp?.messages) ? mp.messages : Array.isArray(mp?.data) ? mp.data : [];
        all.push(...ms);
        const next = mp?.pagination?.nextCursor || mp?.nextCursor;
        if (!next || !(mp?.pagination?.hasMore ?? true) || !ms.length) break;
        msgCursor = next;
      }
      all.sort((x, y) => (msgTime(x)?.getTime() || 0) - (msgTime(y)?.getTime() || 0));
      // FIX 16: skip internal staff-to-staff conversations entirely.
      const participant = String(conv.participantPhone || conv.participantId || '');
      if (cfg.isCompanyNumber(participant) || cfg.isCompanyNumber(conv.participantName)) continue;
      // FIX 5: customer messages are grouped and written on the SAME row as
      // the staff reply that answered them.
      let buffer = [];
      for (const m of all) {
        const d = describeMessage(m);
        if (!d.text) continue;
        const outgoing = String(m.direction || '').toLowerCase() === 'outgoing';
        const when = msgTime(m);
        const fresh = await claimMessage(m.id);
        if (!outgoing) { if (fresh) buffer.push({ text: d.text, when }); else out.skippedAlreadyLogged += 1; continue; }
        await markContacted(participant);
        if (!fresh) { out.skippedAlreadyLogged += 1; buffer = []; continue; }
        let replyMinutes = '';
        if (buffer[0]?.when && when) {
          const mins = (when - buffer[0].when) / 60000;
          if (mins >= 0) replyMinutes = Math.round(mins * 10) / 10;
        }
        rows.push({
          timestamp: (when || new Date()).toISOString(), businessNumber: phone,
          customerName: conv.participantName || conv.participantUsername || '', customerId: participant,
          conversationId: conv.id, direction: 'OUT (staff)',
          staffName: member.name, staffRole: member.role,
          customerMessage: buffer.length ? buffer.map((b) => b.text).join('\n') : '(follow-up - no new customer message)',
          staffReply: d.text,
          replyMinutes, score: '', good: '', loophole: '', betterReply: '', staffMatched: 'yes',
          reviewNote: 'history import - not AI-scored',
        });
        buffer = [];
      }
      // Customer messages with no staff reply yet: one row, so nothing is hidden.
      if (buffer.length) {
        rows.push({
          timestamp: (buffer[buffer.length - 1].when || new Date()).toISOString(), businessNumber: phone,
          customerName: conv.participantName || conv.participantUsername || '', customerId: participant,
          conversationId: conv.id, direction: 'IN (no staff reply yet)',
          staffName: member.name, staffRole: member.role,
          customerMessage: buffer.map((b) => b.text).join('\n'), staffReply: '',
          replyMinutes: '', score: '', good: '', loophole: '', betterReply: '', staffMatched: '',
          reviewNote: 'history import - customer message not answered in this chat',
        });
      }
      for (let i = 0; i < rows.length; i += 200) await postRowsToSheet(rows.slice(i, i + 200));
      out.messagesLogged += rows.length;
    }
    const next = page?.pagination?.nextCursor || page?.nextCursor;
    if (!next || !convs.length || page?.pagination?.hasMore === false) { out.done = true; return out; }
    convCursor = next;
  }
  out.nextCursor = convCursor || '';
  return out;
}

module.exports = { handleTeamMessage, handleAccountEvent, importHistory, isEnabled, _internal: { staffSender, isOutgoing, accountNumber, formatTranscript, describeMessage } };
