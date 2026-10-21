// Persistent, low-cost lead activity tracker. Uses the existing Redis REST store;
// no AI calls are required for routine status updates or hourly checks.
const INDEX = 'gemrishi:lead-tracker:index';
const TTL_SECONDS = 45 * 86400;
const STAFF = {
  neel: { name: 'Neel Das', phone: '+91 98179 75972' },
  yogesh: { name: 'Yogesh', phone: '+91 70158 68891' },
  vishvas: { name: 'Vishvas', phone: '+91 98179 75977' },
  lakshya: { name: 'Lakshya', phone: '+91 91388 49106' },
  sales: { name: 'Mannat Chawla', phone: '+91 98179 75978' },
};
const DIGITS = (v) => String(v || '').replace(/\D/g, '');
function last10(v) { const d = DIGITS(v); return d.length >= 10 ? d.slice(-10) : ''; }
function keyFor(phone) { return last10(phone) ? `gemrishi:lead-tracker:${last10(phone)}` : ''; }

function redisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}
async function redis(path) {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error('Redis credentials are not configured');
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return res.json().catch(() => ({}));
}
async function read(phone) {
  const key = keyFor(phone);
  if (!key) return null;
  const r = await redis(`/get/${encodeURIComponent(key)}`);
  if (!r?.result) return null;
  try { return JSON.parse(r.result); } catch { return null; }
}
async function write(record) {
  const key = keyFor(record.phone);
  if (!key) return false;
  record.updatedAt = new Date().toISOString();
  await redis(`/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(record))}/EX/${TTL_SECONDS}`);
  await redis(`/zadd/${encodeURIComponent(INDEX)}/${Date.now()}/${encodeURIComponent(last10(record.phone))}`);
  return true;
}
function brief(text, max = 180) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function routeForName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('neel')) return 'neel';
  if (n.includes('yogesh')) return 'yogesh';
  if (n.includes('vishvas')) return 'vishvas';
  if (n.includes('lakshya')) return 'lakshya';
  if (n.includes('mannat')) return 'sales';
  return '';
}
async function scheduleTwoHourReminder(phone) {
  const token = process.env.QSTASH_TOKEN;
  const rawBaseUrl = String(process.env.LEAD_TRACKER_BASE_URL || '');
  const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl.slice(0, -1) : rawBaseUrl;
  const secret = process.env.TEAM_MONITOR_SECRET || process.env.CRON_SECRET || '';
  if (!token || !baseUrl || !secret) return false;
  const destination = `${baseUrl}/api/lead-tracker-reminder`;
  const res = await fetch(`https://qstash.upstash.io/v2/publish/${encodeURIComponent(destination)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Upstash-Delay': '2h',
      'Upstash-Forward-Authorization': `Bearer ${secret}`,
    },
    body: JSON.stringify({ phone }),
  });
  if (!res.ok) throw new Error(`QStash schedule failed: ${res.status}`);
  return true;
}
async function recordForwarded(item) {
  const phone = item?.customerPhone || item?.phone || '';
  if (!last10(phone)) return false;
  const now = new Date().toISOString();
  const route = STAFF[item.route] ? item.route : 'sales';
  const old = await read(phone);
  // Keep the earliest open lead record for the same phone; update its context.
  const record = {
    ...(old || {}),
    phone: String(phone),
    customerName: item.customerName || old?.customerName || '',
    product: item.productInterest || old?.product || '',
    budget: item.customerBudget || old?.budget || '',
    assignedTo: STAFF[route].name,
    route,
    source: item.platform || old?.source || '',
    handoffId: item.id || old?.handoffId || '',
    forwardedAt: old?.forwardedAt || now,
    firstContactAt: old?.firstContactAt || '',
    lastStaffAt: old?.lastStaffAt || '',
    lastCustomerAt: old?.lastCustomerAt || '',
    lastMessage: old?.lastMessage || '',
    lastDirection: old?.lastDirection || '',
    staffMessages: Number(old?.staffMessages || 0),
    customerMessages: Number(old?.customerMessages || 0),
    status: old?.status || 'not_contacted',
    reminderSentAt: old?.reminderSentAt || '',
    summary: brief([item.productInterest, item.customerBudget && `Budget ${item.customerBudget}`, item.trigger || item.reason].filter(Boolean).join(' · '), 220),
  };
  await write(record);
  if (!record.reminderScheduledAt && !record.firstContactAt && !['sold', 'lost'].includes(record.status)) {
    try {
      const scheduled = await scheduleTwoHourReminder(record.phone);
      if (scheduled) { record.reminderScheduledAt = new Date().toISOString(); await write(record); }
    } catch (err) { console.error('[leadTracker] QStash reminder scheduling failed:', err.message); }
  }
  return true;
}
async function recordMessage({ phone, direction, text, accountNumber = '', staffName = '', timestamp = new Date().toISOString() }) {
  if (!last10(phone)) return false;
  const record = await read(phone);
  if (!record) return false; // Only track leads that Mannat actually forwarded.
  const isClosed = ['sold', 'lost'].includes(record.status);
  if (direction === 'outgoing') {
    record.staffMessages = Number(record.staffMessages || 0) + 1;
    record.firstContactAt = record.firstContactAt || timestamp;
    record.lastStaffAt = timestamp;
    record.lastDirection = 'staff';
    if (!isClosed) record.status = 'waiting_customer';
    record.lastStaffName = staffName || STAFF[routeForName(staffName)]?.name || record.assignedTo;
  } else {
    record.customerMessages = Number(record.customerMessages || 0) + 1;
    record.lastCustomerAt = timestamp;
    record.lastDirection = 'customer';
    if (!isClosed) record.status = Number(record.staffMessages || 0) > 0 ? 'in_conversation' : 'not_contacted';
  }
  record.lastMessage = brief(text);
  if (accountNumber) record.lastAccountNumber = accountNumber;
  record.reminderSentAt = ''; // New activity can qualify for a future reminder only if still untouched.
  return write(record);
}
async function recordSale(phone, amount, reportedBy = '') {
  if (!last10(phone) || !(Number(amount) > 0)) return false;
  const record = await read(phone);
  if (!record) return false;
  record.status = 'sold';
  record.saleAmount = Number(amount);
  record.saleCurrency = 'INR';
  record.soldAt = new Date().toISOString();
  record.saleReportedBy = brief(reportedBy, 80);
  record.summary = brief(`Sold for INR ${Number(amount)}; reported by ${reportedBy || record.assignedTo || 'sales team'}`, 220);
  return write(record);
}
async function listRecent(days = 30, limit = 500) {
  const min = Date.now() - days * 86400000;
  const r = await redis(`/zrangebyscore/${encodeURIComponent(INDEX)}/${min}/+${'inf'}/LIMIT/0/${limit}`);
  const ids = Array.isArray(r?.result) ? r.result : [];
  const records = [];
  for (const id of ids) {
    const record = await read(id);
    if (record) records.push(record);
  }
  return records;
}
async function claimReminder(phone) {
  const k = `gemrishi:lead-tracker:reminded:${last10(phone)}`;
  const r = await redis(`/set/${encodeURIComponent(k)}/1/EX/${TTL_SECONDS}/NX`);
  return r?.result === 'OK';
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.DAILY_ALERT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 3900) }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
  return true;
}
async function queueStaffReminder(record, ageHours) {
  const route = record.route;
  if (!STAFF[route]) return false;
  const line = `⏰ FOLLOW-UP REMINDER: ${record.customerName || 'Customer'} (${record.phone}) was forwarded to you ${ageHours}h ago and no outgoing WhatsApp message is visible yet. Interested in: ${record.product || 'not specified'}. Please contact them and update the lead.`;
  // The existing handoff check-in flow delivers queued messages when the staff member next checks in.
  await redis(`/rpush/${encodeURIComponent(`gemrishi:staff-pending:${route}`)}/${encodeURIComponent(line)}`);
  await redis(`/expire/${encodeURIComponent(`gemrishi:staff-pending:${route}`)}/${7 * 86400}`);
  return true;
}
function ageHours(iso) {
  const t = new Date(iso || '').getTime();
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 3600000) : 0;
}
async function runOneReminder(phone) {
  if (process.env.ENABLE_TEAM_MONITOR !== 'true') return { skipped: true, reason: 'team monitor is disabled' };
  const record = await read(phone);
  if (!record) return { skipped: true, reason: 'lead record not found' };
  if (record.status === 'sold' || record.status === 'lost' || record.firstContactAt) return { skipped: true, reason: 'lead already contacted or closed' };
  const age = ageHours(record.forwardedAt);
  if (age < 1.9) return { skipped: true, reason: 'not yet due' };
  if (!(await claimReminder(record.phone))) return { skipped: true, reason: 'reminder already claimed' };
  record.reminderSentAt = new Date().toISOString();
  record.status = 'not_contacted';
  await write(record);
  let queued = false;
  try { queued = await queueStaffReminder(record, Math.floor(age)); }
  catch (err) { console.error('[leadTracker] staff reminder queue failed:', err.message); }
  const body = `🚨 GemRishi lead tracker: no outgoing WhatsApp message visible ${Math.floor(age)}h after handoff.\\nAssigned: ${record.assignedTo}\\nCustomer: ${record.customerName || 'Unknown'} (${record.phone})\\nReminder ${queued ? 'queued for salesperson next check-in' : 'could not be queued'}.`;
  try { await sendTelegram(body); } catch (err) { console.error('[leadTracker] reminder alert failed:', err.message); }
  return { reminded: true, assignedTo: record.assignedTo, queued };
}
async function runHourly() {
  if (String(process.env.LEAD_TRACKER_ENABLED || 'true').toLowerCase() === 'false') return { paused: true, reason: 'LEAD_TRACKER_ENABLED=false' };
  if (process.env.ENABLE_TEAM_MONITOR !== 'true') return { paused: true, reason: 'ENABLE_TEAM_MONITOR is not true; refusing to infer no-contact status without message monitoring' };
  const records = await listRecent(30, 500);
  const reminders = [];
  for (const record of records) {
    if (record.status === 'sold' || record.status === 'lost' || record.firstContactAt || record.reminderSentAt) continue;
    const age = ageHours(record.forwardedAt);
    if (age < 2) continue;
    if (!(await claimReminder(record.phone))) continue;
    record.reminderSentAt = new Date().toISOString();
    record.status = 'not_contacted';
    await write(record);
    let queued = false;
    try { queued = await queueStaffReminder(record, Math.floor(age)); }
    catch (err) { console.error('[leadTracker] staff reminder queue failed:', err.message); }
    reminders.push({ assignedTo: record.assignedTo, phone: record.phone, ageHours: Math.floor(age), queued });
  }
  if (reminders.length) {
    const body = ['🚨 GemRishi lead tracker: no WhatsApp contact visible 2+ hours after handoff.', '', ...reminders.map((r, i) => `${i + 1}. ${r.assignedTo} — ${r.phone} — ${r.ageHours}h — staff reminder ${r.queued ? 'queued for next check-in' : 'not queued'}`), '', 'This checks monitored WhatsApp messages only; phone calls and unmonitored numbers may not appear.'].join('\n');
    try { await sendTelegram(body); } catch (err) { console.error('[leadTracker] reminder alert failed:', err.message); }
  }
  return { tracked: records.length, reminders };
}
function istDate(value) { return new Date(value || Date.now()).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
async function runDailySummary() {
  if (process.env.ENABLE_TEAM_MONITOR !== 'true') return { paused: true, reason: 'ENABLE_TEAM_MONITOR is not true; daily contact report would be incomplete' };
  const records = await listRecent(30, 500);
  const today = istDate(new Date());
  const todayRecords = records.filter((r) => istDate(r.forwardedAt) === today);
  const groups = {};
  for (const r of todayRecords) {
    const k = r.assignedTo || 'Unassigned';
    groups[k] ||= { total: 0, contacted: 0, replies: 0, sold: 0, pending: 0 };
    groups[k].total += 1;
    if (r.firstContactAt) groups[k].contacted += 1;
    if (Number(r.customerMessages || 0) > 0) groups[k].replies += 1;
    if (r.status === 'sold') groups[k].sold += 1;
    if (!r.firstContactAt && !['sold', 'lost'].includes(r.status)) groups[k].pending += 1;
  }
  const lines = Object.entries(groups).map(([name, g]) => `${name}: ${g.total} forwarded | ${g.contacted} contacted | ${g.replies} customer-message leads | ${g.sold} reported sold | ${g.pending} not contacted`);
  const text = [`📊 GemRishi Lead Tracker — ${today} (IST)`, '', ...(lines.length ? lines : ['No forwarded leads recorded today.']), '', 'Contact status reflects monitored WhatsApp messages only. Phone calls and unmonitored accounts are not visible.'].join('\n');
  const sent = await sendTelegram(text);
  return { date: today, total: todayRecords.length, groups, sent };
}
module.exports = { recordForwarded, recordMessage, recordSale, listRecent, runOneReminder, runHourly, runDailySummary, _internal: { last10, keyFor, routeForName, ageHours, brief } };
