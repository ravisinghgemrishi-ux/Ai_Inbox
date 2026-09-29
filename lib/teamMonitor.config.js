// =============================================================================
// teamMonitor.config.js — WhatsApp team monitoring settings
//
// Added 2026-09-30 (Ravi): Mannat SILENTLY monitors the team's business
// WhatsApp for the CEO. She NEVER replies on WhatsApp - she only watches every
// message (incoming + outgoing), logs it, reviews how the staff member handled
// it, and drafts how she would have handled it, all into a Google Sheet.
//
// ONLY THIS FILE changes when the team details arrive. Fill in TEAM_MEMBERS and
// TEAM_WHATSAPP_NUMBERS below, commit, and monitoring is live. Nothing else
// needs editing.
//
// The monitor runs only for numbers listed in TEAM_WHATSAPP_NUMBERS, so it can
// never touch the customer-facing Instagram/WhatsApp side by accident.
// =============================================================================

// The team's business WhatsApp number(s) to monitor, digits only, country code
// included (e.g. '9198XXXXXXXX'). These must be connected in Zernio with BOTH
// message.received and message.sent events ticked.
//   TODO(Ravi, tomorrow): add the real number(s).
const TEAM_WHATSAPP_NUMBERS = [
  // '9198XXXXXXXX',
];

// The people who reply on that business WhatsApp. Mannat uses this to name the
// person, know their role, and put their chats in their own sheet tab.
//   - id:    how Zernio identifies the sender of an outgoing reply. We confirm
//            the exact value from the first real message; often the agent's
//            phone or a Zernio user id. Leave '' for now if unknown.
//   - name:  person's name (also the sheet tab name).
//   - phone: their own phone/login, digits only, if known (a second way to match).
//   - role:  designation - shapes what Mannat expects of them.
//   TODO(Ravi, tomorrow): add each person.
const TEAM_MEMBERS = [
  // { id: '', name: 'Sameer',   phone: '', role: 'CRO' },
  // { id: '', name: 'Neel Das', phone: '', role: 'Sales Lead' },
  // { id: '', name: '',         phone: '', role: 'Salesperson' },
];

// What "good" looks like, per role. Mannat scores each conversation against the
// matching role's expectations. Tune freely.
const ROLE_EXPECTATIONS = {
  'Salesperson': [
    'Reply quickly (ideally within a few minutes during working hours).',
    'Greet warmly and use the customer\'s name.',
    'Answer the actual question; give clear product details and price when asked.',
    'Ask for the sale or the next step (share options, offer to send photos, propose a call).',
    'Collect name and contact if not already known.',
    'Follow up if the customer goes quiet rather than letting the lead die.',
    'Polite, professional tone; never rude, dismissive or one-word.',
  ],
  'Sales Lead': [
    'Everything expected of a salesperson, to a higher standard.',
    'Handle tricky or high-value customers well; step in where a junior would struggle.',
    'Move serious leads towards closing, not just answering questions.',
  ],
  'CRO': [
    'Strategic, high-value handling; strong objection handling and negotiation.',
    'Protect margins while closing; escalate or discount thoughtfully.',
    'Set the example for tone and process.',
  ],
  'default': [
    'Reply promptly and politely.',
    'Answer the customer\'s question clearly.',
    'Move the conversation towards a sale or a clear next step.',
    'Never leave a genuine lead unanswered.',
  ],
};

const DEFAULT_ROLE = 'Salesperson';

// Google Sheet that receives the monitor rows. Written to via the same
// Apps Script webhook style as the lead log; set TEAM_MONITOR_WEBHOOK_URL in
// Vercel to that sheet's endpoint. If unset, Mannat logs to console only
// (safe: monitoring simply doesn't write until the sheet is wired up).
function monitorWebhookUrl() {
  return process.env.TEAM_MONITOR_WEBHOOK_URL || '';
}

// Mannat's OWN customer-facing number(s). These can NEVER be monitored, even
// if listed above by mistake - otherwise Mannat would silently stop replying
// to customers there. Extra ones can be added via env MANNAT_REPLY_NUMBERS
// (comma-separated).
function protectedNumbers() {
  const extra = String(process.env.MANNAT_REPLY_NUMBERS || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);
  return ['919817975977', ...extra];
}

function isMonitoredNumber(number) {
  const d = String(number || '').replace(/\D/g, '');
  if (!d) return false;
  if (protectedNumbers().includes(d)) return false;
  return TEAM_WHATSAPP_NUMBERS.map((n) => String(n).replace(/\D/g, '')).includes(d);
}

function memberFor({ id, phone } = {}) {
  const did = String(id || '');
  const dph = String(phone || '').replace(/\D/g, '');
  for (const m of TEAM_MEMBERS) {
    if (m.id && did && m.id === did) return m;
    if (m.phone && dph && String(m.phone).replace(/\D/g, '') === dph) return m;
  }
  return null;
}

function expectationsForRole(role) {
  return ROLE_EXPECTATIONS[role] || ROLE_EXPECTATIONS.default;
}

function isConfigured() {
  return TEAM_WHATSAPP_NUMBERS.length > 0;
}

module.exports = {
  TEAM_WHATSAPP_NUMBERS, TEAM_MEMBERS, ROLE_EXPECTATIONS, DEFAULT_ROLE,
  monitorWebhookUrl, isMonitoredNumber, protectedNumbers, memberFor, expectationsForRole, isConfigured,
};
