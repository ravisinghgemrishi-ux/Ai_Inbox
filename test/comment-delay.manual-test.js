// Run: node test/comment-delay.manual-test.js
const assert = require('assert');

function fresh(env) {
  for (const k of ['COMMENT_REPLY_DELAY_MIN_SEC', 'COMMENT_REPLY_DELAY_MAX_SEC', 'COMMENT_REPLY_DELAY_PLATFORMS']) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../lib/commentDelay')];
  return require('../lib/commentDelay');
}

let d = fresh({});
assert.strictEqual(d.pickTargetMs('instagram', () => 0), 30000, 'min 30s');
assert.strictEqual(d.pickTargetMs('instagram', () => 1), 60000, 'max 60s');
for (let i = 0; i < 500; i++) {
  const ms = d.pickTargetMs('instagram');
  assert(ms >= 30000 && ms <= 60000, `out of range: ${ms}`);
}
assert.strictEqual(d.pickTargetMs('facebook'), 0, 'Facebook comments not delayed by default');
assert.strictEqual(d.pickTargetMs('Instagram', () => 0.5), 45000, 'platform name case-insensitive');

// Time spent writing the reply counts toward the wait.
assert.strictEqual(d.remainingMs(45000, 1000, 13000), 33000);
assert.strictEqual(d.remainingMs(30000, 0, 50000), 0, 'never negative');

// Settings
d = fresh({ COMMENT_REPLY_DELAY_MIN_SEC: '0', COMMENT_REPLY_DELAY_MAX_SEC: '0' });
assert.strictEqual(d.pickTargetMs('instagram'), 0, 'off switch');
d = fresh({ COMMENT_REPLY_DELAY_PLATFORMS: 'all' });
assert(d.pickTargetMs('facebook') >= 30000, '"all" covers Facebook');
d = fresh({ COMMENT_REPLY_DELAY_MAX_SEC: '500' });
assert(d.pickTargetMs('instagram', () => 1) <= 90000, 'hard cap 90s');

(async () => {
  d = fresh({});
  let slept = 0;
  const waited = await d.waitBeforeReply(40000, Date.now() - 10000, async (ms) => { slept = ms; });
  assert(slept > 29000 && slept <= 30000 && waited === slept, `slept ${slept}`);
  console.log('comment-delay: all assertions passed');
})();
