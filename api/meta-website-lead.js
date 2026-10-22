// Secure website lead -> Meta Conversions API endpoint.
// Configure META_CAPI_ENABLED=on, META_CAPI_DATASET_ID, META_CAPI_ACCESS_TOKEN,
// META_CAPI_WEBHOOK_SECRET, and WEBSITE_ALLOWED_HOSTS (comma-separated hostnames).
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const expected = String(process.env.META_CAPI_WEBHOOK_SECRET || '');
  const supplied = String(req.headers['x-meta-lead-secret'] || '');
  if (!expected || !supplied || supplied.length !== expected.length ||
      !require('crypto').timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ ok: false, error: 'invalid_body' });
  const sourceUrl = String(body.eventSourceUrl || '');
  let parsedUrl;
  try { parsedUrl = new URL(sourceUrl); } catch { return res.status(400).json({ ok: false, error: 'invalid_event_source_url' }); }
  if (parsedUrl.protocol !== 'https:') return res.status(400).json({ ok: false, error: 'https_required' });
  const allowed = String(process.env.WEBSITE_ALLOWED_HOSTS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || !allowed.includes(parsedUrl.hostname.toLowerCase())) {
    return res.status(403).json({ ok: false, error: 'website_host_not_allowed' });
  }
  if (!body.eventId || (!body.phone && !body.email)) {
    return res.status(400).json({ ok: false, error: 'event_id_and_contact_required' });
  }
  const metaCapi = require('../lib/metaCapi');
  const result = await metaCapi.sendLead({
    source: 'website',
    identity: String(body.eventId),
    phone: body.phone,
    email: body.email,
    externalId: body.customerId,
    eventSourceUrl: sourceUrl,
    clientIpAddress: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
    clientUserAgent: String(req.headers['user-agent'] || ''),
  });
  if (!result.sent) return res.status(result.reason === 'meta_capi_not_configured' ? 503 : 502).json({ ok: false, ...result });
  return res.status(200).json({ ok: true, eventsReceived: result.eventsReceived, traceId: result.traceId });
};
