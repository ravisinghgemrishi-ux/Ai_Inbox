// Hourly lead follow-up monitor. Runs on Vercel Cron; no Gemini calls.
function authorised(req) {
  const auth = String(req.headers?.authorization || '');
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const u = new URL(req.url, 'http://localhost');
  if (process.env.TEAM_MONITOR_SECRET && u.searchParams.get('token') === process.env.TEAM_MONITOR_SECRET) return true;
  return !process.env.CRON_SECRET && /vercel-cron/i.test(String(req.headers?.['user-agent'] || ''));
}
module.exports = async (req, res) => {
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });
  try {
    const result = await require('../lib/leadTracker').runHourly();
    console.log('[lead-tracker-hourly]', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (err) {
    console.error('[lead-tracker-hourly] failed:', err.message);
    return res.status(500).json({ error: 'lead tracker run failed' });
  }
};
