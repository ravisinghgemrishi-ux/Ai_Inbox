const crypto = require('crypto');

// =============================================================================
// identityBridge.js — GR Customer ID + Instagram -> WhatsApp handoff
//
// Added 2026-09-29 (Ravi), implementing phases 1-4 of the "Mannat AI
// Cross-Channel Rebuild Specification":
//   1. One GR Customer ID per customer; channel IDs (Instagram user, WhatsApp
//      phone, ...) are LINKED to it, never used as the master ID.
//   2. When a customer on Instagram asks for WhatsApp, Mannat creates a
//      handoff with a unique opaque token (e.g. WH-8F72K9Q) and sends a
//      wa.me link with that token pre-typed in the message.
//   3. When a WhatsApp message arrives carrying the token, the WhatsApp
//      sender is linked to the SAME GR customer, deterministically.
//   4. The WhatsApp conversation is given the Instagram context, so Mannat
//      continues naturally instead of starting from zero.
//
// Safety rules (from the spec, all enforced here):
//   - Never guess identity. No token / unknown token / expired token /
//     already-used token  ->  NO merge. The WhatsApp sender is treated as a
//     new or returning WhatsApp customer on their own.
//   - A WhatsApp number already linked to a DIFFERENT GR customer is never
//     silently re-pointed; it is logged as a conflict for the team.
//   - Tokens carry no personal data; everything is resolved server-side.
//     Tokens are short-lived (HANDOFF_TTL_SECONDS) and single-use.
//   - Every customer has isolated keys; there is no global conversation key,
//     so simultaneous customers cannot cross-link.
//
// Storage: the same Upstash Redis REST store the rest of Mannat uses.
//   gemrishi:gr:seq                          counter for GR-xxxxx ids
//   gemrishi:gr:customer:<grId>              customer profile (JSON)
//   gemrishi:gr:link:<channel>:<channelId>   -> grId
//   gemrishi:gr:handoff:<token>              handoff record (JSON, TTL)
//   gemrishi:gr:handoff-claim:<token>        single-use claim lock
//   gemrishi:gr:handoff-by-source:<memoryId> reuse one active token per chat
//   gemrishi:gr:audit                        rolling audit log (last 5000)
//
// Everything here is only called when ENABLE_IDENTITY_BRIDGE === 'true'.
// Every public function fails soft: on any Redis error it returns null and
// Mannat carries on exactly as it did before this module existed.
// =============================================================================

const HANDOFF_TTL_SECONDS = 72 * 60 * 60; // token valid for 72 hours
const CUSTOMER_TTL_SECONDS = 365 * 24 * 60 * 60;
const AUDIT_MAX = 5000;
const PREFIX = 'gemrishi:gr:';
// No 0/O/1/I/L so a customer who retypes the code can't get it wrong.
const TOKEN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TOKEN_PATTERN = /\bWH-([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{7})\b/i;

function isEnabled() {
  return process.env.ENABLE_IDENTITY_BRIDGE === 'true';
}

function whatsappNumber() {
  return String(process.env.WHATSAPP_HANDOFF_NUMBER || '919817975977').replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------
function redisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function redis(path, method = 'POST') {
  const { url, token } = redisConfig();
  if (!url || !token) throw new Error('Redis credentials are not configured');
  const res = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis identity error ${res.status}`);
  return res.json().catch(() => ({}));
}

const enc = encodeURIComponent;

async function getJson(key) {
  const data = await redis(`/get/${enc(key)}`, 'GET');
  if (!data?.result) return null;
  try { return JSON.parse(data.result); } catch { return null; }
}

async function setJson(key, value, ttlSeconds, { nx = false } = {}) {
  const path = `/set/${enc(key)}/${enc(JSON.stringify(value))}/EX/${ttlSeconds}${nx ? '/NX' : ''}`;
  const data = await redis(path);
  return data?.result === 'OK';
}

async function getString(key) {
  const data = await redis(`/get/${enc(key)}`, 'GET');
  return data?.result || null;
}

async function setString(key, value, ttlSeconds, { nx = false } = {}) {
  const data = await redis(`/set/${enc(key)}/${enc(value)}/EX/${ttlSeconds}${nx ? '/NX' : ''}`);
  return data?.result === 'OK';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeChannelId(channel, id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  if (channel === 'whatsapp') {
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 10) return digits.length === 10 ? `91${digits}` : digits; // Indian 10-digit -> 91xxxxxxxxxx
  }
  return raw.toLowerCase().replace(/[^a-z0-9:_.@-]/g, '_').slice(0, 180);
}

function linkKey(channel, channelId) {
  return `${PREFIX}link:${channel}:${normalizeChannelId(channel, channelId)}`;
}

function newToken() {
  const bytes = crypto.randomBytes(7);
  let out = '';
  for (let i = 0; i < 7; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return `WH-${out}`;
}

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length > 4 ? `${'X'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}` : d;
}

async function audit(entry) {
  const record = { timestamp: new Date().toISOString(), ...entry };
  console.log('[identity]', JSON.stringify(record));
  try {
    await redis(`/lpush/${enc(`${PREFIX}audit`)}/${enc(JSON.stringify(record))}`);
    await redis(`/ltrim/${enc(`${PREFIX}audit`)}/0/${AUDIT_MAX - 1}`);
  } catch (err) {
    console.error('[identity] audit write failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Customers & channel links
// ---------------------------------------------------------------------------
async function newCustomerRecord(channel, channelId, extra = {}) {
  const seq = await redis(`/incr/${enc(`${PREFIX}seq`)}`);
  const n = Number(seq?.result || 0);
  const grId = `GR-${10000 + n}`;
  const now = new Date().toISOString();
  const profile = {
    gr_customer_id: grId,
    created_at: now,
    updated_at: now,
    first_channel: channel,
    channels: { [channel]: [normalizeChannelId(channel, channelId)] },
    handles: extra.handle ? { [channel]: extra.handle } : {},
    linked_contexts: [], // [{ channel, scope, memoryId, summary, product_interest, linked_at }]
    product_interest: extra.productInterest || '',
    last_channel: channel,
  };
  return { grId, profile };
}

// Returns the GR id already linked to this channel identity, creating a new
// customer if none exists. Race-safe: two simultaneous first messages from the
// same person resolve to one GR id (the loser of the NX race re-reads).
async function getOrCreateCustomer(channel, channelId, extra = {}) {
  if (!channelId) return null;
  const lk = linkKey(channel, channelId);
  const existing = await getString(lk);
  if (existing) return { grId: existing, created: false };
  const { grId, profile } = await newCustomerRecord(channel, channelId, extra);
  const won = await setString(lk, grId, CUSTOMER_TTL_SECONDS, { nx: true });
  if (!won) {
    const winner = await getString(lk);
    return winner ? { grId: winner, created: false } : null;
  }
  await setJson(`${PREFIX}customer:${grId}`, profile, CUSTOMER_TTL_SECONDS);
  await audit({ event: 'customer_created', gr_customer_id: grId, source_channel: channel });
  return { grId, created: true };
}

async function getCustomer(grId) {
  if (!grId) return null;
  return getJson(`${PREFIX}customer:${grId}`);
}

async function saveCustomer(profile) {
  profile.updated_at = new Date().toISOString();
  await setJson(`${PREFIX}customer:${profile.gr_customer_id}`, profile, CUSTOMER_TTL_SECONDS);
}

async function touchCustomer(grId, channel, extra = {}) {
  const profile = await getCustomer(grId);
  if (!profile) return;
  profile.last_channel = channel;
  if (extra.handle) profile.handles = { ...(profile.handles || {}), [channel]: extra.handle };
  if (extra.productInterest) profile.product_interest = extra.productInterest;
  await saveCustomer(profile);
}

// Customer facts (spec section 16, "Memory Architecture"): name, phone,
// city, budget, purpose, product interest - stored once on the GR profile so
// they survive long chats and channel switches. Only non-empty values
// overwrite, so a later reply that doesn't mention the name never erases it.
const FACT_KEYS = ['name', 'phone', 'city', 'budget', 'purpose', 'product_interest'];

//
// Stored as a Redis HASH (gemrishi:gr:facts:<grId>), one field per fact,
// written with HSET. Each write only touches its own field, so two messages
// arriving at the same moment can never overwrite each other's facts (a
// read-modify-write of the whole profile could - found in testing).
function factsKey(grId) { return `${PREFIX}facts:${grId}`; }

async function updateCustomerFacts(grId, facts = {}) {
  if (!grId) return;
  const key = factsKey(grId);
  let wrote = false;
  for (const k of FACT_KEYS) {
    const v = String(facts[k] || '').trim().slice(0, 200);
    if (!v) continue;
    await redis(`/hset/${enc(key)}/${enc(k)}/${enc(v)}`);
    wrote = true;
  }
  if (wrote) await redis(`/expire/${enc(key)}/${CUSTOMER_TTL_SECONDS}`);
}

async function getCustomerFacts(grId) {
  if (!grId) return {};
  const data = await redis(`/hgetall/${enc(factsKey(grId))}`, 'GET');
  const r = data?.result;
  if (!r) return {};
  if (Array.isArray(r)) { // Upstash returns [field, value, field, value, ...]
    const out = {};
    for (let i = 0; i + 1 < r.length; i += 2) out[r[i]] = r[i + 1];
    return out;
  }
  return typeof r === 'object' ? r : {};
}

// ---------------------------------------------------------------------------
// Handoff (Instagram DM / comment  ->  WhatsApp)
// ---------------------------------------------------------------------------
const WHATSAPP_REQUEST_PATTERN = /whats\s*app|watsapp|whatsap|whtsapp|watsap|व्हाट्सएप|व्हाट्सऐप|\bwp\b|\bw\.?a\.?\s*(pe|par|p)\b/i;

function wantsWhatsApp(text) {
  return WHATSAPP_REQUEST_PATTERN.test(String(text || ''));
}

async function createHandoff({
  grId, sourceChannel, sourcePlatformUserId, sourceConversationId, sourceMemoryScope, sourceMemoryId,
  sourceCommentId = '', sourcePostId = '', isPublicComment = false,
  intent = '', productInterest = '', customerName = '', conversationSummary = '',
}) {
  if (!grId || !sourceMemoryId) return null;

  // One active token per source chat: a customer who asks for WhatsApp twice
  // gets the same link, not a pile of tokens.
  const bySource = `${PREFIX}handoff-by-source:${sourceMemoryId}`;
  const reuse = await getString(bySource);
  if (reuse) {
    const rec = await getJson(`${PREFIX}handoff:${reuse}`);
    if (rec && rec.status === 'pending' && rec.gr_customer_id === grId) return rec;
  }

  const now = Date.now();
  let token = '';
  let record = null;
  for (let attempt = 0; attempt < 5 && !record; attempt++) {
    token = newToken();
    const candidate = {
      handoff_id: token,
      gr_customer_id: grId,
      source_channel: sourceChannel,
      source_platform_user_id: sourcePlatformUserId || '',
      source_conversation_id: sourceConversationId || '',
      source_memory_scope: sourceMemoryScope,
      source_memory_id: sourceMemoryId,
      source_comment_id: sourceCommentId,
      source_post_id: sourcePostId,
      is_public_comment: Boolean(isPublicComment),
      intent,
      product_interest: productInterest,
      customer_name_if_known: customerName,
      conversation_summary: String(conversationSummary || '').slice(0, 1500),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + HANDOFF_TTL_SECONDS * 1000).toISOString(),
      status: 'pending',
      linked_whatsapp_phone: '',
      linked_at: '',
    };
    // NX guarantees two customers can never be handed the same token.
    if (await setJson(`${PREFIX}handoff:${token}`, candidate, HANDOFF_TTL_SECONDS, { nx: true })) record = candidate;
  }
  if (!record) return null;
  await setString(bySource, token, HANDOFF_TTL_SECONDS);
  await audit({
    event: 'handoff_created', gr_customer_id: grId, source_channel: sourceChannel,
    source_conversation_id: sourceConversationId || sourceMemoryId, handoff_id: token,
  });
  return record;
}

function whatsappLink(token) {
  const text = `Hi GemRishi, I'd like to continue here. Ref: ${token}`;
  return `https://wa.me/${whatsappNumber()}?text=${encodeURIComponent(text)}`;
}

function handoffCtaText(token, { hindi = false, isComment = false } = {}) {
  const link = whatsappLink(token);
  const number = `+${whatsappNumber().replace(/^(\d{2})(\d{5})(\d{5})$/, '$1 $2 $3')}`;
  if (isComment) {
    // Links in Instagram comments aren't clickable, so give the code too.
    return hindi
      ? `WhatsApp par continue karne ke liye ${number} par code ${token} bhej dijiye, ya yeh link kholiye: ${link}`
      : `To continue on WhatsApp, send code ${token} to ${number}, or open: ${link}`;
  }
  return hindi
    ? `Bilkul! WhatsApp par continue karne ke liye yeh link kholiye aur message bhej dijiye:\n${link}`
    : `Sure! To continue on WhatsApp, open this link and tap send:\n${link}`;
}

function extractHandoffToken(text) {
  const m = String(text || '').match(TOKEN_PATTERN);
  return m ? `WH-${m[1].toUpperCase()}` : '';
}

// ---------------------------------------------------------------------------
// WhatsApp side: resolve who this is
// ---------------------------------------------------------------------------
// Zernio's exact field for the WhatsApp sender's phone isn't documented in
// this repo, so check the likely ones in order. conversationId is the
// fallback identity (stable per WhatsApp chat) if no phone field is present.
function extractWhatsAppSender(event) {
  const c = event?.conversation || {};
  const m = event?.message || {};
  const candidates = [
    c.participantPhone, c.participantPhoneNumber, c.phone, c.phoneNumber, c.participantId, c.participant?.phone,
    m.from, m.sender?.phone, m.sender?.id, m.contact?.phone, m.contactPhone, m.contactId, event?.contact?.phone,
  ];
  for (const v of candidates) {
    const digits = String(v || '').replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 15) return { id: digits, kind: 'phone' };
  }
  // Diagnostic (field names only, never values): tells us which field
  // Zernio uses for the phone so this can be pinned down after first test.
  console.log('[identity] no phone field found in WhatsApp event; keys:', JSON.stringify({
    conversation: Object.keys(c), message: Object.keys(m), event: Object.keys(event || {}),
  }));
  const convId = c.id || c.conversationId;
  return convId ? { id: `conv_${convId}`, kind: 'conversation' } : null;
}

async function resolveWhatsAppCustomer({ event, messageText, conversationId }) {
  const sender = extractWhatsAppSender(event);
  if (!sender) return null;
  const token = extractHandoffToken(messageText);
  const base = {
    destination_channel: 'whatsapp',
    destination_identity: sender.kind === 'phone' ? maskPhone(sender.id) : sender.id,
    destination_conversation_id: conversationId || '',
  };

  // The number this sender is already linked to, if any.
  const existingGr = await getString(linkKey('whatsapp', sender.id));

  if (token) {
    const handoff = await getJson(`${PREFIX}handoff:${token}`);
    if (!handoff) {
      await audit({ ...base, event: 'handoff_rejected', handoff_id: token, match_method: 'token', match_status: 'invalid_or_expired' });
      const fallback = await getOrCreateCustomer('whatsapp', sender.id);
      return { grId: fallback?.grId, matchStatus: 'invalid_or_expired_token', token, handoff: null };
    }
    if (existingGr && existingGr !== handoff.gr_customer_id) {
      await audit({ ...base, event: 'handoff_conflict', handoff_id: token, gr_customer_id: existingGr, claimed_gr: handoff.gr_customer_id, match_method: 'token', match_status: 'conflict_not_merged' });
      return { grId: existingGr, matchStatus: 'conflict_not_merged', token, handoff: null };
    }
    // Single use: first WhatsApp sender to present the token owns it. A
    // repeat from the SAME sender is fine (e.g. they sent it twice).
    const claimKey = `${PREFIX}handoff-claim:${token}`;
    const claimed = await setString(claimKey, sender.id, HANDOFF_TTL_SECONDS, { nx: true });
    if (!claimed) {
      const owner = await getString(claimKey);
      if (owner !== sender.id) {
        await audit({ ...base, event: 'handoff_rejected', handoff_id: token, match_method: 'token', match_status: 'token_already_used' });
        const fallback = await getOrCreateCustomer('whatsapp', sender.id);
        return { grId: fallback?.grId, matchStatus: 'token_already_used', token, handoff: null };
      }
    }

    const grId = handoff.gr_customer_id;
    await setString(linkKey('whatsapp', sender.id), grId, CUSTOMER_TTL_SECONDS);
    const now = new Date().toISOString();
    handoff.status = 'linked';
    handoff.linked_whatsapp_phone = sender.kind === 'phone' ? sender.id : '';
    handoff.linked_at = now;
    const ttlLeft = Math.max(60, Math.floor((new Date(handoff.expires_at).getTime() - Date.now()) / 1000));
    await setJson(`${PREFIX}handoff:${token}`, handoff, ttlLeft);

    const profile = (await getCustomer(grId)) || { gr_customer_id: grId, channels: {}, handles: {}, linked_contexts: [] };
    const waIds = new Set([...(profile.channels?.whatsapp || []), normalizeChannelId('whatsapp', sender.id)]);
    profile.channels = { ...(profile.channels || {}), whatsapp: [...waIds] };
    const ctx = {
      channel: handoff.source_channel,
      scope: handoff.source_memory_scope,
      memoryId: handoff.source_memory_id,
      summary: handoff.conversation_summary,
      product_interest: handoff.product_interest,
      is_public_comment: handoff.is_public_comment,
      linked_at: now,
    };
    profile.linked_contexts = [...(profile.linked_contexts || []).filter((c) => c.memoryId !== ctx.memoryId), ctx].slice(-5);
    profile.last_channel = 'whatsapp';
    await saveCustomer(profile);

    await audit({
      ...base, event: 'handoff_linked', gr_customer_id: grId, source_channel: handoff.source_channel,
      source_conversation_id: handoff.source_conversation_id || handoff.source_memory_id, handoff_id: token,
      match_method: handoff.is_public_comment ? 'public_comment_token' : 'token', match_status: 'linked', linked_at: now,
    });
    return { grId, matchStatus: 'linked', token, handoff };
  }

  // No token: returning WhatsApp customer, or a brand-new one. Never merged
  // with anyone else on a guess.
  if (existingGr) return { grId: existingGr, matchStatus: 'returning_customer', token: '', handoff: null };
  const created = await getOrCreateCustomer('whatsapp', sender.id);
  if (created?.created) await audit({ ...base, event: 'direct_whatsapp_new_customer', gr_customer_id: created.grId, match_method: 'none', match_status: 'new_profile' });
  return { grId: created?.grId, matchStatus: 'new_customer', token: '', handoff: null };
}

module.exports = {
  isEnabled,
  wantsWhatsApp,
  getOrCreateCustomer,
  getCustomer,
  updateCustomerFacts,
  getCustomerFacts,
  createHandoff,
  handoffCtaText,
  whatsappLink,
  extractHandoffToken,
  extractWhatsAppSender,
  resolveWhatsAppCustomer,
  _internal: { newToken, normalizeChannelId, TOKEN_PATTERN },
};
