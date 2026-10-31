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
//   - never throws and never delays the customer's reply for long (5 s cap)
//
// Vercel setting: CRM_LEAD_WEBHOOK_URL (empty = switched off).
// =============================================================================

const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
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

function buildPayload(lead) {
  const name = String(lead.name || '').trim() || (lead.handle ? `@${String(lead.handle).replace(/^@/, '')}` : 'Customer');
  const summary = [
    lead.lastMessage ? `Customer: ${String(lead.lastMessage).slice(0, 300)}` : '',
    lead.escalateReason ? `Why: ${String(lead.escalateReason).split(' | ')[0].slice(0, 200)}` : '',
    lead.reply ? `Mannat: ${String(lead.reply).slice(0, 300)}` : '',
    lead.handle && !/^\+?\d+$/.test(String(lead.handle)) ? `Handle: ${lead.handle}` : '',
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
    chat_link: String(lead.chatLink || ''),
  };
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try {
      res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (!res || !res.ok) {
      console.error('[crmLeadWebhook] CRM rejected lead:', res?.status);
      return { sent: false, reason: `http_${res?.status || 'error'}` };
    }
    if (redis) {
      try { await redis(`/set/${key}/${level}/EX/${DEDUPE_TTL_SECONDS}`); } catch (_) { /* best effort */ }
    }
    return { sent: true, level, payload };
  } catch (err) {
    console.error('[crmLeadWebhook] send failed:', err.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendQualifiedLead, _internal: { phoneDigits, platformLabel, qualifies, buildPayload } };
