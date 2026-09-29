// Manual end-to-end test for the GR Customer ID + WhatsApp handoff.
// Runs the REAL api/webhook.js with Redis, Zernio, Gemini, lead log and alerts
// replaced by in-memory fakes.   Run:  node test/identityBridge.manual-test.js
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

process.env.REDIS_KV_REST_API_URL = 'https://fake-redis';
process.env.REDIS_KV_REST_API_TOKEN = 'x';
process.env.ZERNIO_API_KEY = 'x';
process.env.ENABLE_IDENTITY_BRIDGE = 'true';
delete process.env.ZERNIO_WEBHOOK_SECRET;

// ---------- fake Upstash Redis REST ----------
const store = new Map();
function redisExec(parts) {
  const [cmd, key, ...rest] = parts;
  switch (cmd) {
    case 'get': return store.has(key) ? store.get(key) : null;
    case 'set': { const nx = rest.includes('NX'); if (nx && store.has(key)) return null; store.set(key, rest[0]); return 'OK'; }
    case 'del': store.delete(key); return 1;
    case 'incr': { const v = Number(store.get(key) || 0) + 1; store.set(key, String(v)); return v; }
    case 'expire': return 1;
    case 'rpush': case 'lpush': { const l = store.get(key) || []; cmd === 'rpush' ? l.push(rest[0]) : l.unshift(rest[0]); store.set(key, l); return l.length; }
    case 'ltrim': { const l = store.get(key) || []; let [a, b] = rest.map(Number); if (a < 0) a = Math.max(0, l.length + a); if (b < 0) b = l.length + b; store.set(key, l.slice(a, b + 1)); return 'OK'; }
    case 'lrange': { const l = store.get(key) || []; return l.slice(0); }
    default: throw new Error('fake redis: unsupported ' + cmd);
  }
}
const sent = [];
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://fake-redis')) {
    const parts = url.slice('https://fake-redis/'.length).split('/').map(decodeURIComponent);
    await new Promise((r) => setTimeout(r, Math.random() * 5)); // shuffle ordering like a real network
    return { ok: true, json: async () => ({ result: redisExec(parts) }) };
  }
  if (url.includes('zernio.com')) {
    sent.push({ url, body: JSON.parse(opts.body || '{}') });
    return { ok: true, json: async () => ({ ok: true }) };
  }
  throw new Error('unexpected fetch ' + url);
};

// ---------- stub heavy modules ----------
const lib = (f) => path.join(__dirname, '..', 'lib', f);
const stub = (f, exports) => { require.cache[require.resolve(lib(f))] = { id: lib(f), filename: lib(f), loaded: true, exports }; };
const aiCalls = [];
stub('replyEngine.js', { generateReply: async (a) => { aiCalls.push(a); return { reply: `AI-REPLY(${a.message.slice(0, 30)})`, leadStatus: 'WARM', escalate: false }; } });
const leads = [];
stub('leadLog.js', { logLead: async (l) => leads.push(l) });
stub('escalationNotifier.js', { notifyEscalation: async () => {}, notifyHotLead: async () => {} });
stub('humanTakeoverGuard.js', { checkHumanTakeover: async () => ({ silence: false }), markAiSent: async () => {} });
stub('kundliFlow.js', { maybeHandleKundliTurn: async () => null });
stub('consultationFlow.js', { maybeHandleConsultationPayment: async () => null });
stub('sellerInquiryFlow.js', { maybeHandleSellerInquiry: async () => null });
stub('productResolver.js', { lookupLiveProduct: async () => ({ found: false, products: [] }), formatLiveProductData: () => '' });

const webhook = require('../api/webhook');

let seq = 0;
function post(body) {
  return new Promise((resolve) => {
    const req = new EventEmitter(); req.method = 'POST'; req.headers = {};
    const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    webhook(req, res);
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}
const igDm = (conv, text, extra = {}) => post({ event: 'message.received', account: { platform: 'instagram', accountId: 'acc-ig' }, conversation: { id: conv, participantUsername: conv + '_user', participantId: 'igsid_' + conv }, message: { id: `m${++seq}`, text, ...extra } });
const waMsg = (phone, text, id) => post({ event: 'message.received', account: { platform: 'whatsapp', accountId: 'acc-wa' }, conversation: { id: 'wa_' + phone, participantPhone: phone }, message: { id: id || `m${++seq}`, text } });
const igComment = (author, text) => post({ event: 'comment.received', account: { platform: 'instagram', accountId: 'acc-ig' }, post: { id: 'post-1' }, comment: { id: `c${++seq}`, text, author: { id: 'igu_' + author, username: author } } });
const lastSentTo = (convOrPost) => [...sent].reverse().find((s) => s.url.includes(encodeURIComponent(convOrPost)));
const tokenIn = (text) => (String(text).match(/WH-[A-Z0-9]{7}/) || [])[0];
const lastAiFor = (needle) => [...aiCalls].reverse().find((c) => c.message.includes(needle));
const results = [];
const check = (name, fn) => results.push([name, fn]);

(async () => {
  // 1. Instagram DM -> WhatsApp -> correct customer
  await igDm('convA', 'mujhe 5 ratti pukhraj chahiye');
  await igDm('convA', 'whatsapp pe baat kar sakte hai?');
  const replyA = lastSentTo('convA').body.message;
  const tokA = tokenIn(replyA);
  check('IG DM reply contains wa.me link with token', () => { assert(tokA, replyA); assert(replyA.includes('wa.me/919817975977?text=')); });
  await waMsg('919812300001', `Hi GemRishi, I'd like to continue here. Ref: ${tokA}`);
  const aiA = lastAiFor(tokA);
  check('WhatsApp with token is linked and sees Instagram history', () => {
    assert(aiA.contextText.includes('CUSTOMER CONTINUITY')); assert(aiA.contextText.includes('pukhraj'));
  });
  const grA = store.get('gemrishi:gr:link:instagram:igsid_conva');
  check('WhatsApp phone linked to same GR id', () => assert.strictEqual(store.get('gemrishi:gr:link:whatsapp:919812300001'), grA));
  check('Handoff record marked linked', () => assert.strictEqual(JSON.parse(store.get(`gemrishi:gr:handoff:${tokA}`)).status, 'linked'));

  // 2. Asking for WhatsApp twice (before using it) reuses the same token
  await igDm('convR', 'whatsapp?');
  const tokR1 = tokenIn(lastSentTo('convR').body.message);
  await igDm('convR', 'whatsapp number bhejo');
  const tokR2 = tokenIn(lastSentTo('convR').body.message);
  check('Same chat asking twice reuses token', () => assert.strictEqual(tokR2, tokR1));

  // 3. Five simultaneous customers, zero cross-linking
  const products = ['5 mukhi rudraksha', 'emerald panna', 'kundli reading', '7 mukhi rudraksha', 'neelam gemstone'];
  const convs = products.map((_, i) => `sim${i}`);
  await Promise.all(convs.map((c, i) => igDm(c, `interested in ${products[i]}`)));
  await Promise.all(convs.map((c) => igDm(c, 'send on whatsapp please')));
  const toks = convs.map((c) => tokenIn(lastSentTo(c).body.message));
  check('5 simultaneous customers got 5 distinct tokens', () => assert.strictEqual(new Set(toks).size, 5));
  const phones = convs.map((_, i) => `91990000000${i}`);
  await Promise.all(convs.map((c, i) => waMsg(phones[i], `Hi GemRishi, I'd like to continue here. Ref: ${toks[i]}`)));
  check('5 simultaneous WhatsApp links each reach their OWN customer', () => {
    convs.forEach((c, i) => {
      const gr = store.get(`gemrishi:gr:link:instagram:igsid_${c}`);
      assert.strictEqual(store.get(`gemrishi:gr:link:whatsapp:${phones[i]}`), gr, `customer ${i}`);
      const ctx = lastAiFor(toks[i]).contextText;
      assert(ctx.includes(products[i]), `customer ${i} missing own context`);
      products.forEach((p, j) => { if (j !== i) assert(!ctx.includes(p), `customer ${i} saw customer ${j}'s context`); });
    });
    assert.strictEqual(new Set(phones.map((p) => store.get(`gemrishi:gr:link:whatsapp:${p}`))).size, 5);
  });

  // 4. Instagram comment -> WhatsApp
  await igComment('rahul123', 'price? whatsapp pe details do');
  const commentReply = [...sent].reverse().find((s) => s.url.includes('/inbox/comments/')).body.message;
  const tokC = tokenIn(commentReply);
  check('Comment reply gives code + number (links not clickable in comments)', () => { assert(tokC); assert(commentReply.includes('98179 75977')); });
  await waMsg('919812300002', `Hello ${tokC}`);
  check('Comment -> WhatsApp linked to commenter', () => assert.strictEqual(store.get('gemrishi:gr:link:whatsapp:919812300002'), store.get('gemrishi:gr:link:instagram:igu_rahul123')));

  // 5. Direct WhatsApp, new then returning
  await waMsg('919812300003', 'hi, rudraksha price?');
  const grNew = store.get('gemrishi:gr:link:whatsapp:919812300003');
  check('Direct WhatsApp creates a new customer', () => assert(grNew && !Object.values([...store.entries()]).includes(undefined)));
  await waMsg('919812300003', 'aur 7 mukhi?');
  check('Returning WhatsApp customer keeps same GR id', () => assert.strictEqual(store.get('gemrishi:gr:link:whatsapp:919812300003'), grNew));

  // 6. Invalid token -> no merge
  await waMsg('919812300004', 'Ref: WH-ZZZZZZZ');
  check('Invalid token does not merge', () => {
    const gr = store.get('gemrishi:gr:link:whatsapp:919812300004');
    assert(gr && ![...store.keys()].some((k) => k.startsWith('gemrishi:gr:link:instagram') && store.get(k) === gr));
    assert(lastAiFor('WH-ZZZZZZZ').contextText.includes('could not be matched'));
  });

  // 7. Expired token -> no merge
  await igDm('convE', 'whatsapp?');
  const tokE = tokenIn(lastSentTo('convE').body.message);
  store.delete(`gemrishi:gr:handoff:${tokE}`); // simulate 72h expiry
  await waMsg('919812300005', `Ref: ${tokE}`);
  check('Expired token does not merge', () => assert.notStrictEqual(store.get('gemrishi:gr:link:whatsapp:919812300005'), store.get('gemrishi:gr:link:instagram:igsid_conve')));

  // 8. Someone else re-using a token -> rejected
  await waMsg('919812399999', `Ref: ${tokA}`);
  check('Used token cannot be claimed by another number', () => assert.notStrictEqual(store.get('gemrishi:gr:link:whatsapp:919812399999'), grA));

  // 9. Number already linked to another customer presenting a token -> conflict, not re-pointed
  await igDm('convF', 'whatsapp');
  const tokF = tokenIn(lastSentTo('convF').body.message);
  await waMsg('919812300003', `Ref: ${tokF}`); // this number belongs to grNew
  check('Conflicting link is not silently merged', () => assert.strictEqual(store.get('gemrishi:gr:link:whatsapp:919812300003'), grNew));

  // 10. Facebook Messenger -> no AI reply
  const before = sent.length;
  await post({ event: 'message.received', account: { platform: 'facebook', accountId: 'fb' }, conversation: { id: 'fbconv' }, message: { id: 'fbm1', text: 'hello whatsapp' } });
  const after = sent.length;
  check('Facebook Messenger gets no reply', () => assert.strictEqual(after, before));

  // 11. Duplicate webhook -> one response
  const b2 = sent.length;
  await waMsg('919812300006', 'hello', 'dup-1'); await waMsg('919812300006', 'hello', 'dup-1');
  const a2 = sent.length;
  check('Duplicate webhook answered once', () => assert.strictEqual(a2, b2 + 1));

  // 12. Switch OFF -> behaviour exactly as before
  process.env.ENABLE_IDENTITY_BRIDGE = 'false';
  await igDm('convOff', 'whatsapp pe baat karo');
  check('Switch off: no link added, no GR record', () => {
    assert(!/wa\.me/.test(lastSentTo('convOff').body.message));
    assert(!store.has('gemrishi:gr:link:instagram:igsid_convoff'));
  });

  let pass = 0;
  for (const [name, fn] of results) {
    try { fn(); pass++; console.log('PASS', name); } catch (e) { console.log('FAIL', name, '\n   ', e.message); }
  }
  console.log(`\n${pass}/${results.length} passed`);
  console.log('\nSample IG reply:\n' + replyA);
  console.log('\nSample comment reply:\n' + commentReply);
  process.exit(pass === results.length ? 0 : 1);
})();
