// Added 2026-09-30 (Ravi): imports a team number's earlier WhatsApp chats into
// the Team WhatsApp Monitor sheet. Read-only on WhatsApp - it never sends.
// Usage (GET): /api/team-history?token=<TEAM_MONITOR_SECRET>&number=917015868891[&cursor=...]
// Call repeatedly with the returned nextCursor until done=true.
const zc = require('../lib/zernioClient');
const { importHistory } = require('../lib/teamMonitor');

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const token = process.env.TEAM_MONITOR_SECRET || '';
  if (!token || url.searchParams.get('token') !== token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.ZERNIO_API_KEY) return res.status(503).json({ ok: false, error: 'ZERNIO_API_KEY missing' });
  const number = url.searchParams.get('number') || '';
  const cursor = url.searchParams.get('cursor') || '';
  try {
    const result = await importHistory({ zc, apiKey: process.env.ZERNIO_API_KEY, number, cursor, budgetMs: 45000 });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[team-history] failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
module.exports.config = { maxDuration: 300 };
