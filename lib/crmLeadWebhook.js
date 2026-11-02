// =============================================================================
// crmLeadWebhook.js - send qualified leads to the GemRishi CRM (Zaptriq)
//
// Added 2026-10-31 (Ravi): when a chat becomes HOT or is escalated, Mannat
// POSTs the lead to the CRM's "Mannat webhook" workflow. The CRM then creates
// or updates the contact, assigns an owner (Yogesh / Vishvas / Lakshay
// round robin), and opens a deal:
//   platform contains "Instagram" -> GemRishi Sheet pipeline
//   anything else (WhatsApp)       -> WhatsApp Ad Leads pipeline
//
// Rules on this side:
//   - only HOT or escalated chats; never support / complaint cases
//   - a phone number is required (the CRM matches contacts by phone), so an
//     Instagram chat is sent once the customer shares a number
//   - at most once per customer per 24 h, plus one more send if a HOT lead
//     is later escalated
//   - never throws; runs after the reply is sent (15 s wait, one retry)
//
// Vercel setting: CRM_LEAD_WEBHOOK_URL (empty = switched off).
//
// 2026-11-01 (Ravi): sales staff must see the WHOLE Mannat chat in the CRM
// notes before they call, not just the last message.
//   - The qualifying send now carries the full recent chat (`transcript`,
//     also placed in `summary`, which the CRM writes into the note).
//   - After a lead is in the CRM, every later turn of the same chat is sent
//     to a second, note-only CRM workflow (sendChatUpdate). That workflow
//     adds a note and nothing else: no staff alert, no deal, no owner change.
//     Vercel setting: CRM_CHAT_UPDATE_WEBHOOK_URL (empty = switched off).
// =============================================================================

const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
// Chat updates keep flowing for 30 days after the lead first reached the CRM.
const IN_CRM_TTL_SECONDS = 30 * 24 * 60 * 60;
// Keep notes readable; when a chat is longer, keep its most recent part.
const TRANSCRIPT_MAX_CHARS = 3500;
const SUPPORT_RE = /return|refund|replace|exchange|damaged|wrong item|complaint/i;

function phoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && /^[6-9]/.test(d)) return `91${d}`;
  return d.length >= 10 ? d : '';
}

function platformLabel(platform, { fromAd = false, type = '' } = {}) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('instagram')) return type === 'comment' ? 'Instagram Comment' : 'Instagram DM';
  if (p.includes('whatsapp')) return fromAd ? 'WhatsApp Ad' : 'WhatsApp';
  if (p.includes('facebook') || p.includes('messenger')) return 'Facebook DM';
  return p ? p[0].toUpperCase() + p.slice(1) : 'Unknown';
}

// Decide whether this turn should go to the CRM, and with what level.
function qualifies({ leadStatus, escalated, intent, escalateReason }) {
  if (intent === 'support_issue' || SUPPORT_RE.test(String(escalateReason || ''))) return '';
  if (escalated) return 'esc';
  if (String(leadStatus || '').toUpperCase() === 'HOT') return 'hot';
  return '';
}

function clipTranscript(text) {
  const t = String(text || '').trim();
  if (t.length <= TRANSCRIPT_MAX_CHARS) return t;
  return `(earlier messages cut)\n…${t.slice(-TRANSCRIPT_MAX_CHARS)}`;
}

// 2026-11-02 (Ravi): WhatsApp leads were landing in the CRM named
// "@+919690200444". Use the customer's WhatsApp / Instagram profile name when
// Mannat did not catch a name in the chat; a bare phone number is never a name.
const LOOKS_LIKE_PHONE = /^[@+\s\d()-]+$/;
function displayName(lead) {
  const name = String(lead.name || '').trim();
  if (name && !LOOKS_LIKE_PHONE.test(name)) return name;
  const profile = String(lead.profileName || '').trim();
  if (profile && !LOOKS_LIKE_PHONE.test(profile)) return profile;
  const handle = String(lead.handle || '').replace(/^@/, '').trim();
  if (handle && !LOOKS_LIKE_PHONE.test(handle)) return `@${handle}`;
  return 'Customer';
}

function buildPayload(lead) {
  const name = displayName(lead);
  const transcript = clipTranscript(lead.transcript);
  const summary = [
    lead.escalateReason ? `Why: ${String(lead.escalateReason).split(' | ')[0].slice(0, 200)}` : '',
    lead.handle && !/^\+?\d+$/.test(String(lead.handle)) ? `Handle: ${lead.handle}` : '',
    transcript
      ? `--- Full chat with Mannat ---\n${transcript}`
      : [
        lead.lastMessage ? `Customer: ${String(lead.lastMessage).slice(0, 300)}` : '',
        lead.reply ? `Mannat: ${String(lead.reply).slice(0, 300)}` : '',
      ].filter(Boolean).join('\n'),
  ].filter(Boolean).join('\n');
  return {
    name,
    phone: `+${phoneDigits(lead.phone)}`,
    email: String(lead.email || ''),
    platform: platformLabel(lead.platform, { fromAd: lead.fromAd, type: lead.type }),
    lead_status: String(lead.leadStatus || 'HOT').toUpperCase(),
    escalated: lead.escalated ? 'Yes' : 'No',
    product_interest: String(lead.productInterest || ''),
    budget: String(lead.budget || ''),
    purpose: String(lead.purpose || ''),
    summary,
    transcript,
    chat_link: String(lead.chatLink || ''),
  };
}

// 2026-11-02 (Ravi): the CRM often takes longer than 5 s to answer, and 10
// leads were dropped as "This operation was aborted" in two days. The send
// now waits up to 15 s and tries once more after a timeout, network error or
// 5xx. It runs after the customer's reply has already gone out, so the
// customer never waits on it.
const POST_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 2000;
async function postOnce(fetchFn, url, payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}
async function postJson(fetchFn, url, payload, { timeoutMs = POST_TIMEOUT_MS, retryDelayMs = RETRY_DELAY_MS } = {}) {
  let res;
  try {
    res = await postOnce(fetchFn, url, payload, timeoutMs);
    if (res && (res.ok || res.status < 500)) return res;
  } catch (err) {
    console.warn('[crmLeadWebhook] first try failed, retrying:', err.message);
  }
  await new Promise((r) => setTimeout(r, retryDelayMs));
  return postOnce(fetchFn, url, payload, timeoutMs);
}

// redis(path) -> Promise<{result}>; fetchFn for tests.
async function sendQualifiedLead(lead, { redis, fetchFn = fetch, url = process.env.CRM_LEAD_WEBHOOK_URL } = {}) {
  try {
    if (!url) return { sent: false, reason: 'disabled' };
    const level = qualifies(lead);
    if (!level) return { sent: false, reason: 'not_qualified' };
    const digits = phoneDigits(lead.phone);
    if (!digits) return { sent: false, reason: 'no_phone' };

    const key = encodeURIComponent(`gemrishi:crm-lead:${digits}`);
    let previous = '';
    if (redis) {
      try { previous = (await redis(`/get/${key}`))?.result || ''; } catch (_) { previous = ''; }
    }
    if (previous === 'esc' || (previous === 'hot' && level === 'hot')) return { sent: false, reason: 'already_sent' };

    const payload = buildPayload(lead);
    const res = await postJson(fetchFn, url, payload);
    if (!res || !res.ok) {
      console.error('[crmLeadWebhook] CRM rejected lead:', res?.status);
      return { sent: false, reason: `http_${res?.status || 'error'}` };
    }
    if (redis) {
      try { await redis(`/set/${key}/${level}/EX/${DEDUPE_TTL_SECONDS}`); } catch (_) { /* best effort */ }
      try { await redis(`/set/${inCrmKey(digits)}/1/EX/${IN_CRM_TTL_SECONDS}`); } catch (_) { /* best effort */ }
    }
    return { sent: true, level, payload };
  } catch (err) {
    console.error('[crmLeadWebhook] send failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

function inCrmKey(digits) {
  return encodeURIComponent(`gemrishi:crm-in:${digits}`);
}

// A later turn of a chat whose lead is already in the CRM -> note-only
// workflow. Sends only this turn's messages, so the CRM notes build up the
// full conversation over time. Never throws; 5 s cap.
async function sendChatUpdate(lead, { redis, fetchFn = fetch, url = process.env.CRM_CHAT_UPDATE_WEBHOOK_URL } = {}) {
  try {
    if (!url) return { sent: false, reason: 'disabled' };
    if (!redis) return { sent: false, reason: 'no_redis' };
    const digits = phoneDigits(lead.phone);
    if (!digits) return { sent: false, reason: 'no_phone' };
    let inCrm = '';
    try { inCrm = (await redis(`/get/${inCrmKey(digits)}`))?.result || ''; } catch (_) { inCrm = ''; }
    // Leads sent before this change only have the 24 h dedupe key.
    if (!inCrm) {
      try { inCrm = (await redis(`/get/${encodeURIComponent(`gemrishi:crm-lead:${digits}`)}`))?.result || ''; } catch (_) { inCrm = ''; }
    }
    if (!inCrm) return { sent: false, reason: 'not_in_crm' };

    const turn = [
      lead.lastMessage ? `Customer: ${String(lead.lastMessage).slice(0, 1500)}` : '',
      lead.reply ? `Mannat: ${String(lead.reply).slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n');
    if (!turn) return { sent: false, reason: 'empty' };

    const payload = {
      name: displayName(lead),
      phone: `+${digits}`,
      platform: platformLabel(lead.platform, { fromAd: lead.fromAd, type: lead.type }),
      lead_status: String(lead.leadStatus || '').toUpperCase(),
      escalated: lead.escalated ? 'Yes' : 'No',
      product_interest: String(lead.productInterest || ''),
      transcript: turn,
    };
    const res = await postJson(fetchFn, url, payload);
    if (!res || !res.ok) {
      console.error('[crmLeadWebhook] CRM rejected chat update:', res?.status);
      return { sent: false, reason: `http_${res?.status || 'error'}` };
    }
    return { sent: true, payload };
  } catch (err) {
    console.error('[crmLeadWebhook] chat update failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendQualifiedLead, sendChatUpdate, _internal: { phoneDigits, platformLabel, qualifies, buildPayload, clipTranscript, displayName, postJson } };
