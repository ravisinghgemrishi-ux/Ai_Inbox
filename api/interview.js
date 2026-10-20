// Admin endpoint for the sales interview (2026-10-20, Ravi).
//   POST /api/interview  header x-admin-token: <INTERVIEW_ADMIN_TOKEN>
//   body { action: 'start', route: 'neel', conversationId, accountId }
//   body { action: 'status', route: 'neel' }   -> progress + all answers
const crypto = require('crypto');
const interview = require('../lib/salesInterview');
const handoff = require('../lib/handoff');
const { sendConversationMessage } = require('../lib/zernioClient');

function authorised(req) {
  const want = process.env.INTERVIEW_ADMIN_TOKEN || '';
  const got = String(req.headers['x-admin-token'] || '');
  if (!want || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!authorised(req)) return res.status(401).json({ ok: false });
  const body = await readBody(req);
  const route = String(body.route || 'neel');
  const r = handoff.ROUTES[route];
  if (!r) return res.status(400).json({ ok: false, error: 'unknown route' });
  try {
    if (body.action === 'start') {
      const { conversationId, accountId } = body;
      if (!conversationId || !accountId) return res.status(400).json({ ok: false, error: 'conversationId and accountId required' });
      const send = (text, i) => sendConversationMessage({ apiKey: process.env.ZERNIO_API_KEY, conversationId, accountId, text, idempotencyKey: `interview-start-${route}-${Date.now()}-${i}` });
      const out = await interview.start({ route, person: r.person, send });
      return res.status(200).json({ ok: true, ...out });
    }
    const state = await interview.getState(route);
    const answers = await interview.answers(route);
    return res.status(200).json({ ok: true, total: interview.QUESTIONS.length, state, answers });
  } catch (err) {
    console.error('[interview] admin error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
