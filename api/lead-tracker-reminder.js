// One-off delayed lead reminder delivered by QStash after the 2-hour wait.
function authorised(req) {
  const auth = String(req.headers?.authorization || '');
  if (process.env.TEAM_MONITOR_SECRET && auth === `Bearer ${process.env.TEAM_MONITOR_SECRET}`) return true;
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  return false;
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!authorised(req)) return res.status(401).json({ error: 'unauthorised' });
  const phone = req.body?.phone;
  if (!phone || !/\\d{10,15}/.test(String(phone).replace(/\\D/g, ''))) {
    return res.status(400).json({ error: 'valid phone required' });
  }
  try {
    const result = await require('../lib/leadTracker').runOneReminder(phone);
    console.log('[lead-tracker-reminder]', JSON.stringify({ result, phoneLast4: String(phone).replace(/\\D/g, '').slice(-4) }));
    return res.status(200).json(result);
  } catch (err) {
    console.error('[lead-tracker-reminder] failed:', err.message);
    return res.status(500).json({ error: 'lead reminder failed' });
  }
};
