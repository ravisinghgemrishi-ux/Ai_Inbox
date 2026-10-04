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
  if (!ten) return { sent: false, reason: 'no phone number yet' };

  const row = {
    handle: String(handle || ''), customerId: String(customerId || ''), name: String(name || ''),
    phone: `+91${ten}`, city: String(city || ''), budget: String(budget || ''),
    interest: String(interest || ''), leadStatus: String(leadStatus || ''),
  };
  const key = `gemrishi:iglead:${row.customerId || ten}`;
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16);
  try {
    const prev = await redis(`/get/${encodeURIComponent(key)}`);
    if (prev?.result === fingerprint) return { sent: false, reason: 'unchanged' };
  } catch { /* if Redis is down, just send */ }

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
    console.error('[instagramLeads] sheet write failed:', err.message);
    return { sent: false, reason: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { recordInstagramLead, _last10: last10 };
