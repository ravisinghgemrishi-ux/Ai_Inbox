const crypto = require('crypto');

function redisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function redisCommand(path) {
  const { url, token } = redisConfig();
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return res.json().catch(() => ({}));
}

async function claimAlert(key, ttlSeconds = 86400) {
  const result = await redisCommand(`/set/${encodeURIComponent(`gemrishi:escalation-alert:${key}`)}/1/EX/${ttlSeconds}/NX`);
  return result?.result === 'OK';
}

function alertKey({ platform, contact, message }) {
  return crypto.createHash('sha256').update(`${platform}|${contact}|${message}`).digest('hex').slice(0, 32);
}

async function postWebhook(url, payload, label) {
  if (!url) return { configured: false, sent: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${label} webhook returned ${res.status}`);
    return { configured: true, sent: true };
  } finally {
    clearTimeout(timeout);
  }
}

// Email alert channel - reworked 2026-09-24 (Ravi) to route by CATEGORY
// instead of one generic address, and to send through the same Google Apps
// Script Web App already used for lead-sheet logging (lib/leadLog.js /
// LEAD_LOG_WEBHOOK_URL) - no new email service, since that script already
// runs with an authenticated Google account that can send mail via MailApp.
// See apps-script-webhook.gs's doPost(): a payload with notifyEmail set is
// treated as "send this email" and does NOT add a row to the lead sheet
// (logLead() already writes that row separately for every message).
//
// Routing (Ravi, 2026-09-24; general bucket widened same day to also CC
// Neel as a backup so nothing gets missed if Mannat is unavailable -
// Telegram already reaches everyone regardless):
//   - category 'seller'  -> Sameer + Neel (a seller/manufacturer/stock
//     offer - lib/sellerInquiryFlow.js sets this category after collecting
//     City/Name/Phone).
//   - everything else that escalates (product questions the AI can't
//     answer, images, prices, support issues, etc.) -> Mannat Chawla + Neel.
function emailRecipientsFor(category) {
  if (category === 'seller') return 'Sameer@gemrishi.com,Neel.das@gemrishi.com';
  return 'mannatchawla.fcbl@gmail.com,Neel.das@gemrishi.com';
}

function formatEmailSubject({ category, platform, customerName }) {
  const label = category === 'seller' ? 'Seller/Manufacturer inquiry' : 'Customer needs human help';
  const who = customerName ? ` - ${customerName}` : '';
  return `GemRishi AI Inbox: ${label}${who} (${platform || 'unknown'})`;
}

// Ravi's explicit requirement (2026-09-24): whatever notification goes to
// Neel, Sameer, or Mannat MUST include the customer's name and phone number
// so the team can get in touch - so those two lines always come first here,
// even when they're blank (per Ravi's own answer for the general bucket:
// "send whatever is known, don't block asking for it").
function formatEmailBody({ platform, contact, type, message, reason, leadStatus, productInterest, category, customerName, customerPhone, customerCity }) {
  const lines = [
    category === 'seller'
      ? 'New seller/manufacturer inquiry - please connect back.'
      : 'A customer/enquiry needs human follow-up.',
    '',
    `Customer name: ${customerName || 'not given'}`,
    `Customer phone: ${customerPhone || 'not given'}`,
  ];
  if (category === 'seller') lines.push(`City: ${customerCity || 'not given'}`);
  lines.push(
    `Platform: ${platform || 'unknown'}`,
    `Platform contact/handle: ${contact || 'unknown'}`,
    `Type: ${type || 'unknown'}`,
    `Lead status: ${leadStatus || 'unknown'}`,
  );
  if (productInterest) lines.push(`Product interest: ${productInterest}`);
  if (reason) lines.push(`Notes: ${reason}`);
  if (message) lines.push(`Customer's message: ${String(message).slice(0, 800)}`);
  return lines.join('\n');
}

async function postAppsScriptEmail({ to, subject, body }) {
  const url = process.env.LEAD_LOG_WEBHOOK_URL;
  if (!url || !to) return { configured: false, sent: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifyEmail: to, emailSubject: subject, emailBody: body }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Apps Script email endpoint returned ${res.status}`);
    return { configured: true, sent: true };
  } finally {
    clearTimeout(timeout);
  }
}

// Telegram alert channel - added 2026-09-23 as a more reliable alternative
// to the CallMeBot WhatsApp route (Ravi found CallMeBot unreliable/flaky).
// Telegram's own Bot API is called directly here (no Apps Script/CallMeBot
// middleman needed) - just needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set
// in Vercel. If either is missing, this is skipped exactly like the
// email/WhatsApp webhooks above when their URL isn't configured.
//
// Updated 2026-09-24 (Ravi): Telegram must keep receiving EVERY category
// (sellers, escalations, enquiries) - this was already true (it's on every
// notifyEscalation call, unconditional on category) - this update just adds
// the category label and the customer name/phone/city fields Ravi asked for
// on every channel, not only email.
function formatTelegramMessage({ platform, contact, type, message, reason, leadStatus, productInterest, category, customerName, customerPhone, customerCity }) {
  const lines = [
    category === 'seller' ? '🏷️ GemRishi - SELLER/MANUFACTURER INQUIRY' : '🔔 GemRishi - human needed',
    `Customer name: ${customerName || 'not given'}`,
    `Customer phone: ${customerPhone || 'not given'}`,
  ];
  if (category === 'seller') lines.push(`City: ${customerCity || 'not given'}`);
  lines.push(
    `Platform: ${platform || 'unknown'}`,
    `Contact: ${contact || 'unknown'}`,
    `Type: ${type || 'unknown'}`,
    `Lead status: ${leadStatus || 'unknown'}`,
  );
  if (productInterest) lines.push(`Product interest: ${productInterest}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (message) lines.push(`Message: ${String(message).slice(0, 500)}`);
  return lines.join('\n');
}

async function postTelegram(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { configured: false, sent: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: formatTelegramMessage(payload) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Telegram API returned ${res.status}: ${await res.text().catch(() => '')}`);
    return { configured: true, sent: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function notifyEscalation({ platform, contact, type, message, reply, reason, leadStatus, productInterest, category, customerName, customerPhone, customerCity }) {
  // Email/WhatsApp/Telegram alerts stay OFF until explicitly enabled after core handoff testing.
  if (process.env.ENABLE_ESCALATION_ALERTS !== 'true') {
    console.log('[escalation] external alerts disabled; handoff remains logged in lead sheet.');
    return { skipped: true, reason: 'external_alerts_disabled' };
  }

  const payload = {
    event: 'gemrishi.ai_inbox.escalation',
    timestamp: new Date().toISOString(),
    platform, contact, type, message, reply, reason, leadStatus, productInterest,
    category: category || '', customerName: customerName || '', customerPhone: customerPhone || '', customerCity: customerCity || '',
  };

  const key = alertKey({ platform, contact, message });
  try {
    const claimed = await claimAlert(key);
    if (!claimed) return { skipped: true, reason: 'duplicate_alert' };
  } catch (err) {
    console.error('[escalation] Redis alert dedup unavailable:', err.message);
  }

  const emailTo = emailRecipientsFor(payload.category);
  const emailSubject = formatEmailSubject(payload);
  const emailBody = formatEmailBody(payload);

  const results = await Promise.allSettled([
    postAppsScriptEmail({ to: emailTo, subject: emailSubject, body: emailBody }),
    postWebhook(process.env.ESCALATION_WHATSAPP_WEBHOOK_URL, payload, 'WhatsApp'),
    postTelegram(payload),
  ]);

  const email = results[0].status === 'fulfilled' ? results[0].value : { configured: Boolean(process.env.LEAD_LOG_WEBHOOK_URL), sent: false, error: results[0].reason?.message };
  const whatsapp = results[1].status === 'fulfilled' ? results[1].value : { configured: Boolean(process.env.ESCALATION_WHATSAPP_WEBHOOK_URL), sent: false, error: results[1].reason?.message };
  const telegram = results[2].status === 'fulfilled' ? results[2].value : { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), sent: false, error: results[2].reason?.message };

  return { skipped: false, email, whatsapp, telegram };
}

// HOT-lead alert channel - added 2026-09-24 (Ravi, after checking a real
// conversation with a customer - shahil.sharma7_0_0_0 - who asked the price
// of a Pukhraj and was correctly marked HOT but never escalated).
//
// A plain price/product question is intentionally never an escalation (see
// knowledgeBase.js's ESCALATION_RULES) - it's marked HOT and left for the
// team to notice in the lead sheet instead, on purpose. In practice that
// means a customer who's clearly ready to buy can sit with no real
// follow-up unless someone happens to be scanning the sheet right then -
// exactly the "lead gets lost" case Ravi originally asked to prevent.
//
// This sends the SAME email/Telegram channels a lighter "worth a follow-up"
// alert for a HOT, non-escalated lead, so nothing depends on someone
// remembering to check the sheet. It reuses the same
// ENABLE_ESCALATION_ALERTS switch (already on) rather than adding a second
// one to flip. Deduped per platform+contact (NOT per exact message, unlike
// notifyEscalation's dedup) with a 12-hour cooldown, so one active
// conversation that stays HOT across several messages pings the team once,
// not on every single HOT-tagged reply - after that, the lead sheet is
// still there for anything further. A genuine escalation on the same
// conversation is a separate alert/key entirely and is never suppressed by
// this.
const HOT_LEAD_ALERT_TTL_SECONDS = 12 * 60 * 60;

function hotLeadAlertKey({ platform, contact }) {
  return crypto.createHash('sha256').update(`hotlead|${platform}|${contact}`).digest('hex').slice(0, 32);
}

async function claimHotLeadAlert(key, ttlSeconds = HOT_LEAD_ALERT_TTL_SECONDS) {
  const result = await redisCommand(`/set/${encodeURIComponent(`gemrishi:hotlead-alert:${key}`)}/1/EX/${ttlSeconds}/NX`);
  return result?.result === 'OK';
}

function formatHotLeadEmailSubject({ platform, customerName }) {
  const who = customerName ? ` - ${customerName}` : '';
  return `GemRishi AI Inbox: Hot lead, worth a follow-up${who} (${platform || 'unknown'})`;
}

function formatHotLeadEmailBody({ platform, contact, type, message, leadStatus, productInterest, customerName, customerPhone }) {
  const lines = [
    'A customer looks ready to buy - worth a follow-up. This is not a blocked/urgent case (the AI already replied and is not stuck), just an opportunity to close: a plain price/product question is never escalated on its own, so nobody gets pinged unless you check the sheet - this is that ping.',
    '',
    `Customer name: ${customerName || 'not given'}`,
    `Customer phone: ${customerPhone || 'not given'}`,
    `Platform: ${platform || 'unknown'}`,
    `Platform contact/handle: ${contact || 'unknown'}`,
    `Type: ${type || 'unknown'}`,
    `Lead status: ${leadStatus || 'HOT'}`,
  ];
  if (productInterest) lines.push(`Product interest: ${productInterest}`);
  if (message) lines.push(`Customer's message: ${String(message).slice(0, 800)}`);
  return lines.join('\n');
}

function formatHotLeadTelegramMessage({ platform, contact, type, message, leadStatus, productInterest, customerName, customerPhone }) {
  const lines = [
    '🔥 GemRishi - hot lead, worth a follow-up (not stuck, just an opportunity)',
    `Customer name: ${customerName || 'not given'}`,
    `Customer phone: ${customerPhone || 'not given'}`,
    `Platform: ${platform || 'unknown'}`,
    `Contact: ${contact || 'unknown'}`,
    `Type: ${type || 'unknown'}`,
    `Lead status: ${leadStatus || 'HOT'}`,
  ];
  if (productInterest) lines.push(`Product interest: ${productInterest}`);
  if (message) lines.push(`Message: ${String(message).slice(0, 500)}`);
  return lines.join('\n');
}

async function postTelegramHotLead(payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { configured: false, sent: false };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: formatHotLeadTelegramMessage(payload) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Telegram API returned ${res.status}: ${await res.text().catch(() => '')}`);
    return { configured: true, sent: true };
  } finally {
    clearTimeout(timeout);
  }
}

// Always routes to the same general bucket as a non-seller escalation
// (Mannat + Neel) - a HOT lead from the seller/manufacturer flow doesn't
// occur (that flow escalates outright, it never produces a HOT lead status
// left un-escalated), so there's no seller-routing case to handle here.
async function notifyHotLead({ platform, contact, type, message, leadStatus, productInterest, customerName, customerPhone }) {
  if (process.env.ENABLE_ESCALATION_ALERTS !== 'true') {
    console.log('[hot-lead] external alerts disabled; lead remains logged in lead sheet.');
    return { skipped: true, reason: 'external_alerts_disabled' };
  }

  const key = hotLeadAlertKey({ platform, contact });
  try {
    const claimed = await claimHotLeadAlert(key);
    if (!claimed) return { skipped: true, reason: 'duplicate_alert' };
  } catch (err) {
    console.error('[hot-lead] Redis alert dedup unavailable:', err.message);
  }

  const payload = {
    platform, contact, type, message, leadStatus, productInterest,
    customerName: customerName || '', customerPhone: customerPhone || '',
  };
  const emailSubject = formatHotLeadEmailSubject(payload);
  const emailBody = formatHotLeadEmailBody(payload);

  const results = await Promise.allSettled([
    postAppsScriptEmail({ to: 'mannatchawla.fcbl@gmail.com,Neel.das@gemrishi.com', subject: emailSubject, body: emailBody }),
    postTelegramHotLead(payload),
  ]);

  const email = results[0].status === 'fulfilled' ? results[0].value : { configured: Boolean(process.env.LEAD_LOG_WEBHOOK_URL), sent: false, error: results[0].reason?.message };
  const telegram = results[1].status === 'fulfilled' ? results[1].value : { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), sent: false, error: results[1].reason?.message };

  return { skipped: false, email, telegram };
}

module.exports = { notifyEscalation, notifyHotLead };
