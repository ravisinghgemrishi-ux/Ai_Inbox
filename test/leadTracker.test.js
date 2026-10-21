const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../lib/leadTracker');

test('normalizes Indian phone numbers to the last ten digits', () => {
  assert.equal(_internal.last10('+91 98179 75978'), '9817975978');
  assert.equal(_internal.last10('919817975978'), '9817975978');
  assert.equal(_internal.last10('not a phone'), '');
});

test('creates a stable lead key from the phone', () => {
  assert.equal(_internal.keyFor('+91 98179 75978'), 'gemrishi:lead-tracker:9817975978');
  assert.equal(_internal.keyFor('unknown'), '');
});

test('summaries are one-line and bounded', () => {
  assert.equal(_internal.brief('photos\nplease\tsoon'), 'photos please soon');
  assert.equal(_internal.brief('x'.repeat(250), 40).length, 40);
});

test('route mapping is based on the known salesperson name', () => {
  assert.equal(_internal.routeForName('Neel Das'), 'neel');
  assert.equal(_internal.routeForName('Lakshya'), 'lakshya');
  assert.equal(_internal.routeForName('unknown'), '');
});
