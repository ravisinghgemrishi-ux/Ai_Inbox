// =============================================================================
// instagramLeads.js - organic Instagram leads -> "Instagram Leads (Mannat)" tab
//
// Added 2026-10-04 (Ravi). The "Gemstone Meta Leads" spreadsheet holds the
// Meta form leads. This adds the OTHER kind: customers who came to Mannat on
// Instagram on their own (not via a Meta form) and GAVE THEIR PHONE NUMBER.
// One row per customer, newest first. The row is created the first time the
// customer gives a number and updated (name, city, budget, interest, status)
// as they share more. The team's own columns (Status, Sales Assigned, Notes)
// are never touched - see Instagram-Leads-Sheet-Script.gs.
//
// Only sends when something actually changed for that customer, so a chatty
// customer doesn't cause a sheet write on every message.
//
// Off until INSTAGRAM_LEADS_WEBHOOK_URL is set in Vercel.
// =============================================================================

const crypto = require('crypto');

function last10(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

// 2026-10-17 audit: every number used to become "+91" + last 10 digits, so
// foreign customers were saved wrong (Melbourne +61 424 002 700 became
// +91 1424002700). Indian numbers are normalised as before; a number given
// with its own country code keeps it.
function normalizePhone(v) {
  const raw = String(v || '').trim();
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  const hasCode = /^(\+|00)/.test(raw);
  if (raw.startsWith('00')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d.slice(2))) return `+${d}`;
  if (!hasCode && d.length === 10 && /^[6-9]/.test(d)) return `+91${d}`;
  if (!hasCode && d.length === 11 && d.startsWith('0') && /^[6-9]/.test(d.slice(1))) return `+91${d.slice(1)}`;
  if (d.length >= 10 && d.length <= 15) return hasCode || d.length > 10 ? `+${d}` : d;
  return '';
}

async function redis(path) {
  const url = (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, '');
  const token = process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '';
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return res.json().catch(() => ({}));
}

async function recordInstagramLead({ platform, type, handle, customerId = '', name = '', phone = '', city = '', budget = '', interest = '', leadStatus = '', isFormLead = false }) {
  const url = process.env.INSTAGRAM_LEADS_WEBHOOK_URL;
  if (!url) return { sent: false, reason: 'not configured' };
  if (String(platform || '').toLowerCase() !== 'instagram' || type !== 'dm') return { sent: false, reason: 'not an Instagram DM' };
  if (isFormLead) return { sent: false, reason: 'Meta form lead - already in the main tab' };
  const ten = last10(phone);
  const fullPhone = normalizePhone(phone);
  if (!ten || !fullPhone) return { sent: false, reason: 'no phone number yet' };

  const row = {
    handle: String(handle || ''), customerId: String(customerId || ''), name: String(name || ''),
    phone: fullPhone, city: String(city || ''), budget: String(budget || ''),
    interest: String(interest || ''), leadStatus: String(leadStatus || ''),
  };
  const key = `gemrishi:iglead:${row.customerId || ten}`;
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16);
  try {
    const prev = await redis(`/get/${encodeURIComponent(key)}`);
    if (prev?.result === fingerprint) return { sent: false, reason: 'unchanged' };
  } catch { /* if Redis is down, just send */ }

  // 2026-10-17 audit: one retry - 4 writes failed 8-11 Oct (2 timeouts, 2
  // temporary 404s). The sheet script updates the same row per customer, so a
  // retry never creates a duplicate.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, redirect: 'follow',
        body: JSON.stringify({ ...row, secret: process.env.TEAM_MONITOR_SECRET || '' }),
      });
      if (!res.ok) throw new Error(`Instagram leads sheet returned ${res.status}`);
      try { await redis(`/set/${encodeURIComponent(key)}/${fingerprint}/EX/${90 * 86400}`); } catch { /* ignore */ }
      return { sent: true };
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
    } finally {
      clearTimeout(timeout);
    }
  }
  console.error('[instagramLeads] sheet write failed:', lastErr?.message);
  return { sent: false, reason: lastErr?.message };
}

module.exports = { recordInstagramLead, _last10: last10, _normalizePhone: normalizePhone };
