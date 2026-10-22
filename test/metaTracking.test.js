'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const clientPath = require.resolve('../lib/zernioClient');
const metaPath = require.resolve('../lib/metaTracking');
let nextResponse = { eventsReceived: 1, eventsFailed: 0, traceId: 'test-trace' };
let nextError = null;
const calls = [];
require.cache[clientPath] = {
  id: clientPath,
  filename: clientPath,
  loaded: true,
  exports: {
    sendWhatsAppConversion: async (payload) => {
      calls.push(payload);
      if (nextError) throw nextError;
      return nextResponse;
    },
  },
};
delete require.cache[metaPath];
const meta = require('../lib/metaTracking');

test.beforeEach(() => {
  calls.length = 0;
  nextResponse = { eventsReceived: 1, eventsFailed: 0, traceId: 'test-trace' };
  nextError = null;
  process.env.META_TRACKING = 'on';
  process.env.ZERNIO_API_KEY = 'test-key';
  process.env.LEAD_ALERT_WHATSAPP_ACCOUNT_ID = 'fallback-account';
});

test('LeadSubmitted uses the inbound WhatsApp account and sends no budget as revenue', async () => {
  const result = await meta.leadSubmitted({
    phone: '+91 98765 43210',
    conversationId: 'customer-conversation-1',
    accountId: 'source-account-1',
    productInterest: 'Rudraksha',
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountId, 'source-account-1');
  assert.equal(calls[0].eventName, 'LeadSubmitted');
  assert.equal(calls[0].conversationId, 'customer-conversation-1');
  assert.equal('value' in calls[0], false);
  assert.equal('currency' in calls[0], false);
});

test('LeadSubmitted falls back to configured account only when source account is missing', async () => {
  const result = await meta.leadSubmitted({ phone: '9876543210' });
  assert.equal(result.sent, true);
  assert.equal(calls[0].accountId, 'fallback-account');
});

test('a successful HTTP response without an accepted-event count is not reported as confirmed', async () => {
  nextResponse = { traceId: 'ack-only' };
  const result = await meta.leadSubmitted({ phone: '9876543210', accountId: 'source-account' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'receipt_unconfirmed');
});

test('provider-reported failures are not reported as sent', async () => {
  nextResponse = { eventsReceived: 0, eventsFailed: 1, failures: [{ message: 'invalid event' }] };
  const result = await meta.leadSubmitted({ phone: '9876543210', accountId: 'source-account' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'provider_reported_failure');
});

test('Purchase requires positive actual sale value and sends INR with a unique order id', async () => {
  const invalid = await meta.purchase({ phone: '9876543210', amount: 0, accountId: 'source-account' });
  assert.equal(invalid.sent, false);
  assert.equal(calls.length, 0);

  const result = await meta.purchase({
    phone: '9876543210',
    amount: 45000,
    accountId: 'source-account',
    conversationId: 'customer-conversation-1',
    orderId: 'sale-command:message-123',
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountId, 'source-account');
  assert.equal(calls[0].eventName, 'Purchase');
  assert.equal(calls[0].value, 45000);
  assert.equal(calls[0].currency, 'INR');
  assert.equal(calls[0].conversationId, 'customer-conversation-1');
  assert.match(calls[0].eventId, /^purchase-/);
});

test('sale command parser handles common phone and amount formats', () => {
  assert.deepEqual(meta.parseSaleCommand('sold 9876543210 45000'), { phone: '9876543210', amount: 45000 });
  assert.deepEqual(meta.parseSaleCommand('sale +91 98765-43210 45k'), { phone: '9876543210', amount: 45000 });
  assert.equal(meta.parseSaleCommand('hello'), null);
});
