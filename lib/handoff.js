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
    label: 'ESCALATION / B2B', person: 'Neel Das', phone: '+91 98179 75972',
    email: () => process.env.ESCALATION_HANDOFF_EMAIL || 'Neel.das@gemrishi.com',
  },
};

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

function routeFor({ category = '', escalate = false, escalateReason = '', intent = '' } = {}) {
  if (category === 'b2b' || intent === 'b2b_inquiry') return 'neel';
  if (escalate && NEEL_REASONS.test(`${escalateReason} ${intent}`)) return 'neel';
  if (['support_issue', 'order_status', 'offer_or_discount'].includes(intent) && escalate) return 'neel';
  return 'sales';
}

function customerKey({ grId, platform, contact }) {
  return String(grId || `${platform || 'social'}:${contact || 'unknown'}`).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 120);
}

// --- queue / touch / flush ---------------------------------------------------
async function queueForward(item) {
  const route = ROUTES[item.route] ? item.route : 'sales';
  const key = customerKey(item);
  const id = `${route}:${key}`;
  try {
    const done = await redis(`/get/${encodeURIComponent(`gemrishi:handoff:sent:${id}`)}`);
    if (done?.result) return { queued: false, reason: 'already_forwarded' };
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

async function deliver(item) {
  let transcript = '';
  try {
    if (item.memoryScope && item.memoryId) transcript = formatMemory(await getMemory(item.memoryScope, item.memoryId));
  } catch (err) { console.error('[handoff] transcript read failed:', err.message); }
  const text = formatRecord(item, transcript);
  const r = ROUTES[item.route] || ROUTES.sales;
  const subject = `GemRishi handoff (${r.label}) - ${item.customerName || item.contact || 'customer'}`;
  const results = await Promise.allSettled([sendTelegram(text), sendEmail(r.email(), subject, text)]);
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

module.exports = { ROUTES, routeFor, queueForward, touchPending, flushDue, markContacted, contactedAt, last10, settleSeconds, _internal: { formatRecord, customerKey } };
