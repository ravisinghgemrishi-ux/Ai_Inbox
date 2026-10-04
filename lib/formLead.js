// =============================================================================
// formLead.js - Meta ad FORM leads (Instagram "I filled out your form...")
//
// Added 2026-10-04 (Ravi, quality batch FIX 8, 8b, 9).
// A form lead arrives as one Instagram DM like:
//   Hello! I filled out your form and would like to know more about your business.
//   Which Sapphire ?: Pitambari          (or: What is your  Purpose?: Investment)
//   Average Budget ?: 20k-50k
//   Full name: Datta bhagde
//   WhatsApp number: +917796138999
//   City: Nashik
// (field order varies). Mannat is the BRIDGE, not the closer: one warm
// opening message, a gemologist calls the same number before end of day,
// and she captures the preferred time window + call or WhatsApp chat.
//
// Every form lead is also recorded for the 7 PM check (api/daily-alert.js),
// which flags any lead whose number never received a staff WhatsApp message.
// =============================================================================

const { last10 } = require('./handoff');

const FORM_MARKER = /filled\s*(out|in)\s*(your|the)\s*form/i;

function isFormLead(text) {
  const t = String(text || '');
  return FORM_MARKER.test(t) || (/full\s*name\s*:/i.test(t) && /(whats\s*app|phone)\s*(number)?\s*:/i.test(t));
}

function parseFormLead(text) {
  const out = { name: '', phone: '', city: '', budget: '', requirement: '', purpose: '', raw: String(text || '') };
  for (const line of String(text || '').split(/\n+/)) {
    const m = line.match(/^\s*([^:]{2,60}?)\s*\??\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (/full\s*name|^name/.test(key)) out.name = val;
    else if (/whats\s*app|phone|mobile|contact/.test(key)) out.phone = val.replace(/[^\d+]/g, '');
    else if (/city|location/.test(key)) out.city = val;
    else if (/budget/.test(key)) out.budget = val;
    else if (/purpose/.test(key)) out.purpose = val;
    else if (/which|stone|sapphire|gem|product|interest/.test(key)) out.requirement = val;
  }
  return out;
}

// Rough tier from the budget text, so a 15-50k jewellery lead and an
// above-3L investment lead get different opening details.
function budgetTier(budget) {
  const b = String(budget || '').toLowerCase().replace(/\s+/g, '');
  if (/above3l|3l\+|>3l|above3lakh/.test(b)) return 'premium';
  if (/1l-3l|above1l|1lakh/.test(b)) return 'high';
  if (/50k-1l/.test(b)) return 'mid';
  return 'entry';
}

const TIER_GUIDE = {
  entry: 'ENTRY budget (up to ~50k): keep it simple - a good certified everyday-wear stone in their budget, suitable for a ring or pendant.',
  mid: 'MID budget (50k-1L): better colour/clarity grade, certified, good for a quality ring.',
  high: 'HIGH budget (1L-3L): fine grade stones, premium certification options (IIGJ / IGI), heirloom-quality jewellery.',
  premium: 'PREMIUM / INVESTMENT budget (above 3L): rare top-grade or collector stones, origin matters (e.g. Kashmir / Ceylon), full lab certification, value retention. Sound expert and discreet.',
};

// Context note for the FIRST reply to a form lead (FIX 8 + 8b).
function firstReplyNote(lead, hindi) {
  const want = [lead.requirement && `wants: ${lead.requirement}`, lead.purpose && `purpose: ${lead.purpose}`].filter(Boolean).join(', ');
  return [
    'META AD FORM LEAD - THIS IS THE FIRST REPLY. The customer already filled a form; their details are below. Follow this exactly:',
    `- Details: name ${lead.name || '(not given)'}, ${want || 'requirement not stated'}, budget ${lead.budget || '(not given)'}, city ${lead.city || '(not given)'}, number ${lead.phone || '(not given)'}.`,
    '- Greet them by first name. Acknowledge exactly what they asked for. NEVER re-ask anything already in the form (name, number, city, budget, stone/purpose).',
    `- Give a short, approximate idea of what their budget gets them - ${TIER_GUIDE[budgetTier(lead.budget)]} Use prices only from CURRENT_LIVE_PRODUCT_DATA; otherwise speak in general terms, no invented numbers.`,
    '- Mention their city naturally once if it fits (e.g. delivery to their city). Do not cluster many facts together.',
    '- Tell them our GEMOLOGIST will call them on the same number before end of day today. Always say "gemologist", never "customer support agent".',
    '- In the same message ask: what time window suits them, and would they prefer a call or a WhatsApp chat.',
    '- No photos, no product links, no WhatsApp invite, no long chat. Max 3 short blocks. Do not ask for anything else.',
    hindi ? '- Reply in the customer\'s language.' : '',
  ].filter(Boolean).join('\n');
}

// Context note for LATER replies in the same form-lead chat.
const FOLLOWUP_NOTE = 'META AD FORM LEAD (follow-up): our gemologist will call this customer today. If they told you a time window and call/WhatsApp preference, thank them briefly and confirm the gemologist will reach out accordingly. Keep replies very short. Do not negotiate, do not commit final prices, do not send photos or links, do not ask for details they already gave in the form. If they ask something simple, answer briefly and say the gemologist will cover the details on the call.';

const PREFERENCE_HINT = /\b(call|phone|whats\s*app|chat|morning|evening|afternoon|night|am|pm|baje|subah|shaam|dopahar|raat|anytime|any\s*time|\d{1,2}\s*(?:-|to)\s*\d{1,2})\b/i;
function looksLikePreference(text) { return PREFERENCE_HINT.test(String(text || '')); }

// --- day log for the 7 PM check -------------------------------------------
function istDate(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}
function istTime(iso) {
  const d = new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

async function redis(path) {
  const url = (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, '');
  const token = process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '';
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return res.json().catch(() => ({}));
}

function dayKey(date) { return `gemrishi:formleads:${date}`; }
function convKey(memoryId) { return `gemrishi:formlead-conv:${String(memoryId).replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 150)}`; }

// Records the lead (once per number per day) and marks the conversation.
async function recordFormLead({ lead, platform, contact, memoryId }) {
  const now = new Date().toISOString();
  const date = istDate();
  const entry = { ...lead, raw: undefined, platform, contact, memoryId, recordedAt: now, date };
  try {
    const id = last10(lead.phone) || String(contact || 'unknown');
    await redis(`/hset/${encodeURIComponent(dayKey(date))}/${encodeURIComponent(id)}/${encodeURIComponent(JSON.stringify(entry))}`);
    await redis(`/expire/${encodeURIComponent(dayKey(date))}/${10 * 86400}`);
    await redis(`/set/${encodeURIComponent(convKey(memoryId))}/${encodeURIComponent(JSON.stringify({ id, date }))}/EX/${7 * 86400}`);
  } catch (err) { console.error('[formLead] record failed:', err.message); }
  return entry;
}

// Is this conversation a form lead? Returns { id, date } or null.
async function formLeadForConversation(memoryId) {
  try {
    const r = await redis(`/get/${encodeURIComponent(convKey(memoryId))}`);
    return r?.result ? JSON.parse(r.result) : null;
  } catch { return null; }
}

async function savePreference(ref, text) {
  if (!ref?.id || !ref?.date) return;
  try {
    const r = await redis(`/hget/${encodeURIComponent(dayKey(ref.date))}/${encodeURIComponent(ref.id)}`);
    if (!r?.result) return;
    const entry = JSON.parse(r.result);
    entry.preference = String(text || '').slice(0, 200);
    await redis(`/hset/${encodeURIComponent(dayKey(ref.date))}/${encodeURIComponent(ref.id)}/${encodeURIComponent(JSON.stringify(entry))}`);
  } catch (err) { console.error('[formLead] preference save failed:', err.message); }
}

async function leadsForDay(date = istDate()) {
  try {
    const r = await redis(`/hgetall/${encodeURIComponent(dayKey(date))}`);
    const arr = Array.isArray(r?.result) ? r.result : [];
    const out = [];
    for (let i = 1; i < arr.length; i += 2) { try { out.push(JSON.parse(arr[i])); } catch { /* skip */ } }
    return out.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  } catch (err) { console.error('[formLead] day read failed:', err.message); return []; }
}

module.exports = { isFormLead, parseFormLead, budgetTier, firstReplyNote, FOLLOWUP_NOTE, looksLikePreference, recordFormLead, formLeadForConversation, savePreference, leadsForDay, istDate, istTime };
