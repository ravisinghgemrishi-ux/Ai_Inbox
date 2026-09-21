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
  ]);

  const email = results[0].status === 'fulfilled' ? results[0].value : { configured: Boolean(process.env.ESCALATION_EMAIL_WEBHOOK_URL), sent: false, error: results[0].reason?.message };
  const whatsapp = results[1].status === 'fulfilled' ? results[1].value : { configured: Boolean(process.env.ESCALATION_WHATSAPP_WEBHOOK_URL), sent: false, error: results[1].reason?.message };

  return { skipped: false, email, whatsapp };
}

module.exports = { notifyEscalation };
