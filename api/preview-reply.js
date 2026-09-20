const { generateReply } = require('../lib/replyEngine');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    const { platform = 'facebook', type = 'dm', message = '', contextText, liveProductData = '' } = req.query || {};
    if (!message) return res.status(400).json({ ok: false, error: 'message query param required' });
    const result = await generateReply({ platform, type, message, contextText, liveProductData });
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('[preview-reply] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
