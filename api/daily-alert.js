// =============================================================================
// api/daily-alert.js - 7 PM IST "uncontacted form leads" alert
//
// Added 2026-10-04 (Ravi, quality batch FIX 9). Every day at 7:00 PM IST:
//   - takes today's Meta ad form leads (recorded by lib/formLead.js);
//   - checks each lead's number against the numbers our staff have messaged
//     on the monitored team WhatsApp (lib/handoff.js markContacted, written by
//     the Team Monitor). Numbers are compared on the LAST 10 DIGITS, so
//     "+91 98...", "9198..." and "98..." all match;
//   - for every lead NEVER messaged, alerts the TEAM ONLY (never the customer):
//       1. Telegram alert
//       2. urgent email to Sameer@gemrishi.com
//       3. log-sheet style copy by email to Neel.das@gemrishi.com
//     Each entry shows the lead's details and the time it was recorded.
//   - also sends out any one-time handoffs still waiting (lib/handoff.js).
//
// Limitation (honest): a phone CALL made from a personal phone is invisible
// to us - only WhatsApp messages from the monitored team numbers count as
// "contacted". A lead that was only called will still show here.
//
// Triggered by the Vercel cron in vercel.json (13:30 UTC = 7:00 PM IST).
// Manual run: /api/daily-alert?token=<TEAM_MONITOR_SECRET>[&date=YYYY-MM-DD][&dry=1]
// =============================================================================

const formLead = require('../lib/formLead');
const handoff = require('../lib/handoff');

// 'token' = manual run with the secret; 'cron' = Vercel's scheduler (either
// CRON_SECRET if set, or Vercel's cron user-agent - then only once per day,
// so nobody can spam the team by calling the URL).
function authorisation(req) {
  const auth = String(req.headers?.authorization || '');
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return 'cron';
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || '';
  if (process.env.TEAM_MONITOR_SECRET && token === process.env.TEAM_MONITOR_SECRET) return 'token';
  if (!process.env.CRON_SECRET && /vercel-cron/i.test(String(req.headers?.['user-agent'] || ''))) return 'cron-ua';
  return '';
}

async function claimDay(date) {
  const url = (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, '');
  const token = process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '';
  if (!url || !token) return true;
  const res = await fetch(`${url}/set/${encodeURIComponent(`gemrishi:daily-alert:${date}`)}/1/EX/172800/NX`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const d = await res.json().catch(() => ({}));
  return d?.result === 'OK';
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.DAILY_ALERT_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
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
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifyEmail: to, emailSubject: subject, emailBody: body }),
  });
  if (!res.ok) throw new Error(`email endpoint ${res.status}`);
  return true;
}

function leadLine(l, i) {
  const want = [l.requirement, l.purpose].filter(Boolean).join(' / ');
  return [
    `${i + 1}. ${l.name || 'Name not given'} - ${l.phone || 'no number'}`,
    `   Recorded at ${formLead.istTime(l.recordedAt)} IST, still not contacted`,
    `   ${[want && `Wants: ${want}`, l.budget && `Budget: ${l.budget}`, l.city && `City: ${l.city}`].filter(Boolean).join(' | ')}`,
    l.preference ? `   Preference: ${l.preference}` : '',
    `   Instagram: ${l.contact || 'unknown'}`,
  ].filter(Boolean).join('\n');
}

function sheetCopy(leads, date) {
  const header = 'Date,Recorded (IST),Name,Number,Wants,Budget,City,Preference,Instagram';
  const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
  const rows = leads.map((l) => [date, formLead.istTime(l.recordedAt), l.name, l.phone, [l.requirement, l.purpose].filter(Boolean).join(' / '), l.budget, l.city, l.preference, l.contact].map(esc).join(','));
  return [header, ...rows].join('\n');
}

// 2026-10-04 (Ravi): the "contacted" check relies on the Team Monitor. While
// monitoring is paused (ENABLE_TEAM_MONITOR not 'true') every lead would look
// "not contacted", so the alert pauses too and resumes on its own when the
// monitor is switched back on. DAILY_ALERT=off also pauses it by hand.
// Waiting one-time handoffs are still sent either way.
function alertActive() {
  if (String(process.env.DAILY_ALERT || 'on').toLowerCase() === 'off') return false;
  return process.env.ENABLE_TEAM_MONITOR === 'true';
}

async function run({ date, dry }) {
  if (!alertActive()) {
    const flushed = dry ? 0 : await handoff.flushDue({ max: 50 });
    return { date, paused: 'staff monitoring is off, so the uncontacted-leads alert is paused', handoffsFlushed: flushed, sent: {} };
  }
  const leads = await formLead.leadsForDay(date);
  const pending = [];
  for (const l of leads) {
    if (!handoff.last10(l.phone)) { pending.push(l); continue; }
    if (!(await handoff.contactedAt(l.phone))) pending.push(l);
  }
  const flushed = dry ? 0 : await handoff.flushDue({ max: 50 });
  const summary = { date, totalFormLeads: leads.length, notContacted: pending.length, handoffsFlushed: flushed, sent: {} };
  if (dry) return { ...summary, pending };

  if (!pending.length) {
    if (leads.length) {
      try { summary.sent.telegram = await sendTelegram(`✅ GemRishi 7 PM check (${date}): all ${leads.length} form lead(s) today were contacted on WhatsApp.`); }
      catch (err) { summary.sent.telegramError = err.message; }
    }
    return summary;
  }

  const body = [
    `${pending.length} of ${leads.length} Meta form lead(s) from today (${date}) have NOT been contacted on WhatsApp yet:`,
    '',
    ...pending.map(leadLine),
    '',
    'Please call / message them now. (Calls from a personal phone are not visible to this check.)',
  ].join('\n');

  const results = await Promise.allSettled([
    sendTelegram(`🚨 GemRishi 7 PM check\n${body}`),
    sendEmail(process.env.DAILY_ALERT_URGENT_EMAIL || 'Sameer@gemrishi.com', `URGENT: ${pending.length} form lead(s) not contacted today (${date})`, body),
    sendEmail(process.env.DAILY_ALERT_LOG_EMAIL || 'Neel.das@gemrishi.com', `Form leads not contacted - log (${date})`, `${body}\n\n--- Sheet copy (CSV) ---\n${sheetCopy(pending, date)}`),
  ]);
  ['telegram', 'urgentEmail', 'logEmail'].forEach((k, i) => {
    summary.sent[k] = results[i].status === 'fulfilled' ? results[i].value : `error: ${results[i].reason?.message}`;
  });
  return summary;
}

module.exports = async (req, res) => {
  const how = authorisation(req);
  if (!how) return res.status(401).json({ error: 'unauthorised' });
  const url = new URL(req.url, 'http://localhost');
  const date = how === 'token' ? (url.searchParams.get('date') || formLead.istDate()) : formLead.istDate();
  const dry = how === 'token' && url.searchParams.get('dry') === '1';
  if (how !== 'token' && !(await claimDay(date))) return res.status(200).json({ skipped: 'already ran today', date });
  try {
    const out = await run({ date, dry });
    console.log('[daily-alert]', JSON.stringify({ ...out, pending: undefined }));
    return res.status(200).json(out);
  } catch (err) {
    console.error('[daily-alert] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

module.exports._run = run;
