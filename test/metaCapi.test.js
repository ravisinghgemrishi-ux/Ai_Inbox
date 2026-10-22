'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const capi = require('../lib/metaCapi');

const keys = ['META_CAPI_ENABLED','META_CAPI_DATASET_ID','META_CAPI_ACCESS_TOKEN','META_CAPI_TEST_EVENT_CODE','META_GRAPH_VERSION'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
const originalFetch = global.fetch;
test.after(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  global.fetch = originalFetch;
});

test('normalizes Indian phone and hashes identifiers without exposing raw phone', () => {
  assert.equal(capi._internal.normalizePhone('+91 98765-43210'), '919876543210');
  assert.equal(capi._internal.normalizePhone('9876543210'), '919876543210');
  assert.match(capi._internal.sha256('9876543210'), /^[a-f0-9]{64}$/);
  assert.notEqual(capi._internal.sha256('9876543210'), '9876543210');
});

test('is safely disabled until explicit CAPI configuration is present', async () => {
  process.env.META_CAPI_ENABLED = 'off';
  process.env.META_CAPI_DATASET_ID = 'dataset';
  process.env.META_CAPI_ACCESS_TOKEN = 'secret';
  process.env.META_CAPI_TEST_EVENT_CODE = 'TEST123';
  let called = false;
  global.fetch = async () => { called = true; throw new Error('must not call'); };
  const result = await capi.sendLead({ source: 'instagram_form', identity: 'lead-1', phone: '9876543210' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'meta_capi_not_configured');
  assert.equal(called, false);
});

test('includes Meta Test Events code only when configured and requires provider acknowledgement', async () => {
  process.env.META_CAPI_ENABLED = 'on';
  process.env.META_CAPI_DATASET_ID = '123456';
  process.env.META_CAPI_ACCESS_TOKEN = 'test-token';
  process.env.META_CAPI_TEST_EVENT_CODE = 'TEST123';
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ events_received: 1, fbtrace_id: 'trace-test' }) };
  };
  const result = await capi.sendLead({ source: 'instagram_form', identity: 'lead-2', phone: '+91 98765 43210', externalId: 'gr-2' });
  assert.equal(result.sent, true);
  assert.equal(result.eventsReceived, 1);
  assert.equal(result.testMode, true);
  assert.match(captured.url, /123456/);
  assert.equal(captured.body.test_event_code, 'TEST123');
  assert.equal(captured.body.data[0].event_name, 'Lead');
  assert.equal(captured.body.data[0].action_source, 'chat');
  assert.equal(captured.body.data[0].custom_data.lead_source, 'instagram_form');
  assert.match(captured.body.data[0].user_data.ph[0], /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(captured.body).includes('9876543210'), false);

  delete process.env.META_CAPI_TEST_EVENT_CODE;
  global.fetch = async (url, options) => {
    captured = { url: String(url), body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
  };
  const livePayload = await capi.sendLead({ source: 'instagram_form', identity: 'lead-3', email: 'test@example.com' });
  assert.equal(livePayload.sent, true);
  assert.equal(Object.hasOwn(captured.body, 'test_event_code'), false);

  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const unconfirmed = await capi.sendLead({ source: 'website', identity: 'web-1', email: 'test@example.com', eventSourceUrl: 'https://shop.example.com/thanks' });
  assert.equal(unconfirmed.sent, false);
  assert.equal(unconfirmed.reason, 'meta_api_did_not_confirm_event');
});
