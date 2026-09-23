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

// Telegram alert channel - added 2026-09-23 as a more reliable alternative
// to the CallMeBot WhatsApp route (Ravi found CallMeBot unreliable/flaky).
// Telegram's own Bot API is called directly here (no Apps Script/CallMeBot
// middleman needed) - just needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID set
// in Vercel. If either is missing, this is skipped exactly like the
// email/WhatsApp webhooks above when their URL isn't configured.
function formatTelegramMessage({ platform, contact, type, message, reason, leadStatus, productInterest }) {
  const lines = [
    '🔔 GemRishi - human needed',
    `Platform: ${platform || 'unknown'}`,
    `Contact: ${contact || 'unknown'}`,
    `Type: ${type || 'unknown'}`,
    `Lead status: ${leadStatus || 'unknown'}`,
  ];
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

async function notifyEscalation({ platform, contact, type, message, reply, reason, leadStatus, productInterest }) {
  // Email/WhatsApp alerts stay OFF until explicitly enabled after core handoff testing.
  if (process.env.ENABLE_ESCALATION_ALERTS !== 'true') {
    console.log('[escalation] external alerts disabled; handoff remains logged in lead sheet.');
    return { skipped: true, reason: 'external_alerts_disabled' };
  }

  const payload = {
    event: 'gemrishi.ai_inbox.escalation',
    timestamp: new Date().toISOString(),
    platform, contact, type, message, reply, reason, leadStatus, productInterest,
  };

  const key = alertKey({ platform, contact, message });
  try {
    const claimed = await claimAlert(key);
    if (!claimed) return { skipped: true, reason: 'duplicate_alert' };
  } catch (err) {
    console.error('[escalation] Redis alert dedup unavailable:', err.message);
  }

  const results = await Promise.allSettled([
    postWebhook(process.env.ESCALATION_EMAIL_WEBHOOK_URL, payload, 'email'),
    postWebhook(process.env.ESCALATION_WHATSAPP_WEBHOOK_URL, payload, 'WhatsApp'),
    postTelegram(payload),
  ]);

  const email = results[0].status === 'fulfilled' ? results[0].value : { configured: Boolean(process.env.ESCALATION_EMAIL_WEBHOOK_URL), sent: false, error: results[0].reason?.message };
  const whatsapp = results[1].status === 'fulfilled' ? results[1].value : { configured: Boolean(process.env.ESCALATION_WHATSAPP_WEBHOOK_URL), sent: false, error: results[1].reason?.message };
  const telegram = results[2].status === 'fulfilled' ? results[2].value : { configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), sent: false, error: results[2].reason?.message };

  return { skipped: false, email, whatsapp, telegram };
}

module.exports = { notifyEscalation };
