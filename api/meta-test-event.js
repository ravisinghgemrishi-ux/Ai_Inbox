// Preview-only Meta Test Events trigger. Sends one synthetic Lead, never a Purchase.
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Fail closed outside Vercel Preview; do not rely on URL shape or caller input.
  if (process.env.VERCEL_ENV !== 'preview') {
    return res.status(404).json({ error: 'Not found' });
  }
  const testCode = String(process.env.META_CAPI_TEST_EVENT_CODE || '').trim();
  if (!testCode || !process.env.META_CAPI_DATASET_ID || !process.env.META_CAPI_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Preview test trigger is not configured' });
  }
  // The Test Events code doubles as the trigger guard; it is not a Graph API access token.
  const supplied = String(req.headers['x-test-event-code'] || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(testCode);
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Fixed, non-personal synthetic data. No user-supplied identifiers accepted.
  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: 'gemrishi-preview-test-' + crypto.randomUUID(),
    action_source: 'system_generated',
    user_data: {
      external_id: [crypto.createHash('sha256').update('gemrishi-preview-synthetic-test-lead').digest('hex')],
    },
    custom_data: { lead_source: 'preview_test', test_event: true },
  };
  const url = new URL('https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v23.0') + '/' +
    encodeURIComponent(process.env.META_CAPI_DATASET_ID) + '/events');
  url.searchParams.set('access_token', process.env.META_CAPI_ACCESS_TOKEN);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event], test_event_code: testCode }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error || Number(body.events_received || 0) < 1) {
      console.error('[meta-test-trigger] Meta did not confirm event', JSON.stringify({
        status: response.status, error: body.error?.message || '', events_received: body.events_received,
      }));
      return res.status(502).json({ sent: false, error: 'Meta did not confirm the test event' });
    }
    return res.status(200).json({ sent: true, eventName: 'Lead', eventsReceived: Number(body.events_received), testMode: true });
  } catch (error) {
    console.error('[meta-test-trigger] request failed', String(error.message || error));
    return res.status(502).json({ sent: false, error: 'Meta test event request failed' });
  }
};
