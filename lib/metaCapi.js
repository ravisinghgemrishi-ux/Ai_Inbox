// Meta Conversions API for non-WhatsApp lead sources.
// Requires META_CAPI_DATASET_ID and META_CAPI_ACCESS_TOKEN. Safe no-op if absent.
const crypto = require('crypto');

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v23.0';
function sha256(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized ? crypto.createHash('sha256').update(normalized).digest('hex') : undefined;
}
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length === 10 ? '91' + digits : digits;
}
function enabled() {
  return String(process.env.META_CAPI_ENABLED || 'off').toLowerCase() === 'on' &&
    Boolean(process.env.META_CAPI_DATASET_ID && process.env.META_CAPI_ACCESS_TOKEN);
}
function eventId(source, identity) {
  return crypto.createHash('sha256').update(String(source) + ':' + String(identity)).digest('hex');
}
async function sendLead({ source, identity, phone, email, externalId, eventSourceUrl, clientIpAddress, clientUserAgent } = {}) {
  if (!enabled()) return { sent: false, reason: 'meta_capi_not_configured' };
  if (!source || !identity) return { sent: false, reason: 'missing_source_or_identity' };
  const userData = {};
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) userData.ph = [sha256(normalizedPhone)];
  if (email) userData.em = [sha256(email)];
  if (externalId) userData.external_id = [sha256(externalId)];
  if (clientIpAddress) userData.client_ip_address = clientIpAddress;
  if (clientUserAgent) userData.client_user_agent = clientUserAgent;
  if (!userData.ph && !userData.em && !userData.external_id) {
    return { sent: false, reason: 'missing_match_key' };
  }
  const event = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId(source, identity),
    action_source: source === 'website' ? 'website' : source === 'instagram_form' || source === 'instagram_organic' ? 'chat' : 'system_generated',
    user_data: userData,
    custom_data: { lead_source: source },
    ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
  };
  try {
    const url = new URL('https://graph.facebook.com/' + GRAPH_VERSION + '/' +
      encodeURIComponent(process.env.META_CAPI_DATASET_ID) + '/events');
    url.searchParams.set('access_token', process.env.META_CAPI_ACCESS_TOKEN);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event] }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || Number(body.events_received || 0) < 1 || body.error) {
      console.error('[meta-capi] lead event failed', JSON.stringify({ source, status: response.status, error: body.error?.message || '', events_received: body.events_received }));
      return { sent: false, reason: body.error?.message || 'meta_api_did_not_confirm_event', eventsReceived: Number(body.events_received || 0) };
    }
    console.log('[meta-capi] lead event provider accepted', JSON.stringify({ source, eventsReceived: body.events_received, fbtrace_id: body.fbtrace_id || '' }));
    return { sent: true, eventsReceived: Number(body.events_received), traceId: body.fbtrace_id || '' };
  } catch (error) {
    console.error('[meta-capi] request failed', String(error.message || error));
    return { sent: false, reason: String(error.message || error) };
  }
}
module.exports = { sendLead, enabled, _internal: { sha256, normalizePhone, eventId } };
