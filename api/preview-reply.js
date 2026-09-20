const { generateReply } = require('../lib/replyEngine');

module.exports = async (req, res) => {
  try {
    const { platform = 'facebook', type = 'dm', message = '', contextText } = req.query || {};
    if (!message) return res.status(400).json({ ok: false, error: 'message query param required' });
    const result = await generateReply({ platform, type, message, contextText });
    res.status(200).json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
