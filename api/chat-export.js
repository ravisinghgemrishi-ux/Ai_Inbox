// =============================================================================
// chat-export.js - read-only export of chat history for customer research
//
// Added 2026-11-02 (Ravi): export the last 60 days of Mannat AI WhatsApp,
// Instagram DMs and the sales team's WhatsApp chats to study customer buying
// mindset and personas. Read-only: it never sends, archives or changes chats.
//
// Usage (GET, call repeatedly with the returned nextCursor until done=true):
//   /api/chat-export?account=<zernio account id>
//       &since=2026-09-03[&cursor=...][&pageSize=40]
// Response: NDJSON. First line is a meta object
//   {"meta":true,"account":..,"conversations":n,"messages":n,"nextCursor":..,"done":bool}
// then one line per message.
//
// Runs ONLY on a preview deployment (branch chat-export), which Vercel
// protects with Vercel Authentication - only logged-in team members can open
// it. On production it answers 404, so the public site never exposes chats.
// Delete the branch when the export is finished.
// =============================================================================
const zc = require('../lib/zernioClient');

const BUDGET_MS = 200000;
const CONCURRENCY = 6;

async function allMessages(apiKey, conv, sinceMs, deadline) {
  const out = [];
  let cursor;
  for (let page = 0; page < 20 && Date.now() < deadline; page += 1) {
    const data = await zc.listInboxConversationMessages({ apiKey, conversationId: conv.id, accountId: conv.accountId, limit: 100, cursor, sortOrder: 'desc' });
    const msgs = Array.isArray(data?.messages) ? data.messages : (Array.isArray(data?.data) ? data.data : []);
    let reachedOld = false;
    for (const m of msgs) {
      const t = Date.parse(m.createdAt || m.sentAt || '');
      if (t && t < sinceMs) { reachedOld = true; continue; }
      out.push(m);
    }
    const next = data?.pagination?.nextCursor;
    if (reachedOld || !data?.pagination?.hasMore || !next) break;
    cursor = next;
  }
  return out;
}

function row(conv, m) {
  const att = Array.isArray(m.attachments) ? m.attachments.map((a) => a.type || 'file').join(',') : '';
  const ad = conv.adAttribution || {};
  const meta = conv.metadata || {};
  return {
    account: conv.accountUsername || conv.accountId,
    platform: conv.platform,
    conversation: conv.id,
    customer_name: conv.participantName || '',
    customer_id: conv.participantUsername || conv.participantId || '',
    ad_campaign: ad.campaignName || '',
    ad_name: ad.name || '',
    ad_headline: meta.ctwa_headline || '',
    time: m.createdAt || m.sentAt || '',
    direction: m.direction,
    sent_via: m.sentVia || m.metadata?.sentVia || '',
    sender: m.senderName || '',
    text: m.message || m.text || '',
    attachments: att,
    deleted: Boolean(m.isDeleted),
  };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (process.env.VERCEL_ENV !== 'preview') return res.status(404).json({ ok: false, error: 'Not found' });
  const apiKey = process.env.ZERNIO_API_KEY;
  if (!apiKey) return res.status(503).json({ ok: false, error: 'ZERNIO_API_KEY missing' });

  const account = url.searchParams.get('account') || '';
  if (!account) return res.status(400).json({ ok: false, error: 'account is required' });
  const sinceMs = Date.parse(url.searchParams.get('since') || '') || (Date.now() - 60 * 864e5);
  const cursor = url.searchParams.get('cursor') || undefined;
  const pageSize = Math.max(5, Math.min(Number(url.searchParams.get('pageSize') || 40), 100));
  const deadline = Date.now() + BUDGET_MS;

  try {
    const page = await zc.listInboxConversations({ apiKey, accountId: account, status: '', limit: pageSize, cursor, sortOrder: 'desc' });
    const convs = Array.isArray(page?.data) ? page.data : [];
    const inRange = convs.filter((c) => !c.updatedTime || Date.parse(c.updatedTime) >= sinceMs);
    const reachedOld = inRange.length < convs.length;

    const lines = [];
    let messages = 0;
    let failed = 0;
    for (let i = 0; i < inRange.length; i += CONCURRENCY) {
      const batch = inRange.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((c) => allMessages(apiKey, c, sinceMs, deadline).catch((e) => { failed += 1; return { error: e.message }; })));
      batch.forEach((c, k) => {
        const r = results[k];
        if (!Array.isArray(r)) { lines.push(JSON.stringify({ conversation: c.id, error: r.error })); return; }
        r.sort((a, b) => Date.parse(a.createdAt || a.sentAt) - Date.parse(b.createdAt || b.sentAt));
        for (const m of r) { lines.push(JSON.stringify(row(c, m))); messages += 1; }
      });
      if (Date.now() > deadline) break;
    }

    const nextCursor = page?.pagination?.nextCursor || '';
    const done = reachedOld || !page?.pagination?.hasMore || !nextCursor;
    const meta = { meta: true, account, conversations: inRange.length, messages, failed, nextCursor: done ? '' : nextCursor, done };
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send([JSON.stringify(meta), ...lines].join('\n'));
  } catch (err) {
    console.error('[chat-export] failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
module.exports.config = { maxDuration: 300 };
