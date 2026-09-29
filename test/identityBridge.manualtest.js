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
process.env.WEBHOOK_FAST_ACK = 'false'; // tests await each reply
process.env.HUMAN_TYPING_DELAY_SCALE = '0.001'; // real bubbles, near-zero pauses
process.env.MESSAGE_BATCH_WAIT_MS = '60'; // real batching, short wait

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
    case 'hset': { const h = store.get(key) || {}; h[rest[0]] = rest[1]; store.set(key, h); return 1; }
    case 'hgetall': { const h = store.get(key); if (!h) return []; return Object.entries(h).flat(); }
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
    const result = redisExec(parts); // executes on request, like real Redis
    return { ok: true, json: async () => ({ result }) };
  }
  if (url.includes('zernio.com')) {
    sent.push({ url, body: JSON.parse(opts.body || '{}'), headers: opts.headers || {} });
    return { ok: true, json: async () => ({ ok: true }) };
  }
  throw new Error('unexpected fetch ' + url);
};

// ---------- stub heavy modules ----------
const lib = (f) => path.join(__dirname, '..', 'lib', f);
const stub = (f, exports) => { require.cache[require.resolve(lib(f))] = { id: lib(f), filename: lib(f), loaded: true, exports }; };
const aiCalls = [];
stub('replyEngine.js', { generateReply: async (a) => {
  aiCalls.push(a);
  const m = a.message;
  return {
    leadStatus: /price|pukhraj|emerald/i.test(m) ? 'HOT' : 'WARM',
    reply: /MULTI/.test(m) ? 'Hi Rahul! Great choice.\n\nWe have Pukhraj around 5 ratti in stock.\n\nLoose stone or in a ring?' : `AI-REPLY(${m.slice(0, 30)})`, leadStatus: 'WARM', escalate: false,
    customerName: (m.match(/name is (\w+)/i) || [])[1] || '',
    customerCity: (m.match(/from (\w+)/i) || [])[1] || '',
    customerPhone: (m.match(/\b(\d{10})\b/) || [])[1] || '',
    customerBudget: (m.match(/budget is (\d+)/i) || [])[1] || '',
    customerPurpose: /career/i.test(m) ? 'career growth' : '',
    productInterest: /pukhraj|yellow sapphire/i.test(m) ? 'Yellow Sapphire ~5 ratti' : '',
  };
} });
const leads = [];
stub('leadLog.js', { logLead: async (l) => leads.push(l) });
const alerts = [];
stub('escalationNotifier.js', { notifyEscalation: async (a) => { alerts.push(a); }, notifyHotLead: async () => {} });
const aiMarked = [];
stub('humanTakeoverGuard.js', { checkHumanTakeover: async () => ({ silence: false }), markAiSent: async (id, t) => { aiMarked.push({ t, sentBefore: sent.length }); } });
const flowCalls = [];
stub('kundliFlow.js', { maybeHandleKundliTurn: async (a) => { flowCalls.push(a); return null; } });
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
  const onlyMsgs = () => sent.filter((x) => x.url.endsWith('/messages')).length;
  const b2 = onlyMsgs();
  await waMsg('919812300006', 'hello', 'dup-1'); await waMsg('919812300006', 'hello', 'dup-1');
  const a2 = onlyMsgs();
  check('Duplicate webhook answered once', () => assert.strictEqual(a2, b2 + 1));

  // 13. ANIL'S REAL CONVERSATION (2026-09-29): facts must survive the handoff
  await igDm('anil', 'can we talk on whatsapp');
  await igDm('anil', 'hi my name is Rahul');
  await igDm('anil', 'i am from Hisar');
  await igDm('anil', 'i want yellow sapphire around 5 ratti for career growth');
  await igDm('anil', 'my budget is 50000');
  await igDm('anil', 'can we continue on whatsapp');
  const tokAnil = tokenIn(lastSentTo('anil').body.message);
  await waMsg('918726559209', `Hi GemRishi, I'd like to continue here. Ref: ${tokAnil}`);
  await waMsg('918726559209', 'whats my name');
  const ctxName = lastAiFor('whats my name').contextText;
  check('Anil: WhatsApp knows name, city, product, budget, purpose', () => {
    for (const x of ['Name: Rahul', 'City: Hisar', 'Yellow Sapphire', 'Budget: 50000', 'Purpose: career growth']) assert(ctxName.includes(x), 'missing ' + x);
  });
  check('Anil: full Instagram chat carried over (incl. message 2)', () => assert(ctxName.includes('my name is Rahul')));
  // 25 more messages on Instagram - the original "my name is Rahul" message
  // falls out of the 12-message window, but the saved facts must remain.
  for (let i = 0; i < 25; i++) await igDm('anil', `question number ${i}`);
  await igDm('anil', 'remind me what i wanted');
  const ctxLate = lastAiFor('remind me what i wanted').contextText;
  check('Anil: facts survive 25+ messages later (old message gone, facts kept)', () => {
    assert(!ctxLate.includes('my name is Rahul'), 'old message should have aged out');
    assert(ctxLate.includes('Name: Rahul') && ctxLate.includes('Budget: 50000') && ctxLate.includes('City: Hisar'));
  });
  await igDm('anil', 'back on instagram, any update?');
  check('Anil: facts also shown back on Instagram', () => assert(lastAiFor('back on instagram').contextText.includes('Name: Rahul')));

  // 14. GOOGLE REVIEWS
  process.env.ENABLE_REVIEW_REPLIES = 'true';
  const review = (id, rating, text, extra = {}) => post({ id: 'evt-' + id, event: 'review.new', account: { accountId: 'gbp-acc', platform: 'googlebusiness' },
    review: { id: `accounts/1/locations/2/reviews/${id}`, platform: 'googlebusiness', rating, text, reviewer: { name: 'Priya Sharma' }, createdAt: new Date().toISOString(), hasReply: false, ...extra } });
  const reviewSends = () => sent.filter((x) => x.url.includes('/inbox/reviews/'));
  const r0 = reviewSends().length;
  await review('r5', 5, 'Beautiful Pukhraj, great service!');
  const r5 = reviewSends().slice(-1)[0]; const rAfter5 = reviewSends().length;
  check('5-star review: reply posted automatically, signed Team GemRishi, correct endpoint', () => {
    assert.strictEqual(rAfter5, r0 + 1);
    assert(r5.url.includes(encodeURIComponent('accounts/1/locations/2/reviews/r5')), r5.url);
    assert.strictEqual(r5.body.accountId, 'gbp-acc'); assert(/Team GemRishi$/.test(r5.body.message));
  });
  const a0 = alerts.length; const r1 = reviewSends().length;
  await review('r2', 2, 'Delivery was late and nobody replied');
  const rAfter2 = reviewSends().length; const aAfter2 = alerts.length; const lastReason = alerts[alerts.length - 1]?.reason || '';
  check('2-star review: reply posted automatically AND team gets an FYI alert', () => {
    assert.strictEqual(rAfter2, r1 + 1);
    assert.strictEqual(aAfter2, a0 + 1); assert(/FYI: 2★/.test(lastReason) && /already replied publicly/.test(lastReason));
  });
  const a5 = alerts.length; await review('r5b', 5, 'Lovely');
  const a5after = alerts.length;
  check('5-star review: no alert needed', () => assert.strictEqual(a5after, a5));
  await review('r5', 5, 'Beautiful Pukhraj, great service!'); // Zernio redelivers the same event
  await post({ id: 'evt-r5-again', event: 'review.new', account: { accountId: 'gbp-acc' }, review: { id: 'accounts/1/locations/2/reviews/r5', rating: 5, text: 'x', reviewer: { name: 'P' }, hasReply: false } });
  check('Same review delivered twice: replied once', () => assert.strictEqual(reviewSends().filter((x) => x.url.includes(encodeURIComponent('reviews/r5') + '/reply')).length, 1));
  const r2 = reviewSends().length;
  await review('r6', 5, 'Great', { hasReply: true });
  await post({ id: 'evt-upd', event: 'review.updated', account: { accountId: 'gbp-acc' }, review: { id: 'accounts/1/locations/2/reviews/r7', rating: 5, text: 'edited', reviewer: { name: 'A' }, hasReply: false } });
  process.env.ENABLE_REVIEW_REPLIES = 'false';
  const l0 = leads.length;
  await review('r8', 5, 'Nice');
  const r3 = reviewSends().length; const l1 = leads.length; const lastReply = leads[leads.length - 1].reply;
  check('Already-replied, review.updated, and switch-off: nothing posted (switch-off still logged)', () => {
    assert.strictEqual(r3, r2);
    assert.strictEqual(l1, l0 + 1); assert(/switched off/.test(lastReply));
  });

  // 15. HUMAN-LIKE TYPING
  const s0 = sent.length; const m0 = aiMarked.length;
  await waMsg('919812377777', 'MULTI please');
  const waBubbles = sent.slice(s0);
  const msgs = waBubbles.filter((x) => x.url.endsWith('/messages'));
  const typings = waBubbles.filter((x) => x.url.endsWith('/typing'));
  const marks = aiMarked.slice(m0);
  check('WhatsApp reply sent as 3 separate bubbles with typing indicator before each', () => {
    assert.deepStrictEqual(msgs.map((x) => x.body.message), ['Hi Rahul! Great choice.', 'We have Pukhraj around 5 ratti in stock.', 'Loose stone or in a ring?']);
    assert.strictEqual(typings.length, 3);
    assert.strictEqual(new Set(msgs.map((x) => x.headers?.['Idempotency-Key'] || '')).size, 3);
  });
  check('Each bubble registered as Mannat\'s BEFORE it is sent (human-takeover safety)', () => {
    for (const b of ['Hi Rahul! Great choice.', 'We have Pukhraj around 5 ratti in stock.', 'Loose stone or in a ring?']) {
      const mk = marks.find((x) => x.t === b); assert(mk, 'not marked: ' + b);
      const sendIdx = waBubbles.findIndex((x) => x.body.message === b);
      assert(mk.sentBefore <= s0 + sendIdx, 'marked after sending: ' + b);
    }
  });
  const c0 = sent.length;
  await igComment('multiuser', 'MULTI comment');
  const cSends = sent.slice(c0).filter((x) => x.url.includes('/inbox/comments/'));
  check('Public comment stays ONE message (no bubbles)', () => assert.strictEqual(cSends.length, 1));
  process.env.HUMAN_TYPING = 'false';
  const o0 = sent.length; await waMsg('919812377778', 'MULTI off');
  const offMsgs = sent.slice(o0).filter((x) => x.url.endsWith('/messages')).length;
  process.env.HUMAN_TYPING = '';
  check('HUMAN_TYPING=false: back to one message', () => assert.strictEqual(offMsgs, 1));

  // 16. QUICK MESSAGES ANSWERED TOGETHER
  const q0 = aiCalls.length; const qs0 = sent.filter((x) => x.url.endsWith('/messages')).length;
  await Promise.all([
    waMsg('919812388888', 'hi'),
    new Promise((r) => setTimeout(r, 10)).then(() => waMsg('919812388888', 'pukhraj chahiye')),
    new Promise((r) => setTimeout(r, 25)).then(() => waMsg('919812388888', 'price kya hai')),
  ]);
  const burstCalls = aiCalls.slice(q0);
  const burstSends = sent.filter((x) => x.url.endsWith('/messages')).length - qs0;
  check('3 quick messages -> Mannat reads all 3 and replies ONCE', () => {
    assert.strictEqual(burstCalls.length, 1, 'AI called ' + burstCalls.length + ' times');
    for (const t of ['hi', 'pukhraj chahiye', 'price kya hai']) assert(burstCalls[0].message.includes(t), 'missing ' + t);
    assert.strictEqual(burstSends, 1);
  });
  // two customers bursting at the same time stay separate
  const p0 = aiCalls.length;
  await Promise.all([waMsg('919812300101', 'A1 emerald'), waMsg('919812300202', 'B1 ruby'), waMsg('919812300101', 'A2 price'), waMsg('919812300202', 'B2 size')]);
  const pc = aiCalls.slice(p0);
  check('Two customers bursting at once: one reply each, never mixed', () => {
    assert.strictEqual(pc.length, 2);
    const a = pc.find((c) => c.message.includes('A1')); const b = pc.find((c) => c.message.includes('B1'));
    assert(a && a.message.includes('A2') && !a.message.includes('B')); assert(b && b.message.includes('B2') && !b.message.includes('A'));
  });
  // a message sent after the wait gets its own reply
  const l2 = aiCalls.length;
  await waMsg('919812388888', 'thanks');
  const l3 = aiCalls.length;
  check('A later message (after the wait) gets its own normal reply', () => assert.strictEqual(l3, l2 + 1));

  // 17. ONE-TIME WHATSAPP INVITATION
  const INV = /would it be okay to continue on WhatsApp|WhatsApp par baat continue karein/;
  const lastMsgsTo = (conv, since) => sent.slice(since).filter((x) => x.url.includes(encodeURIComponent(conv)) && x.url.endsWith('/messages')).map((x) => x.body.message).join('\n');
  let k = sent.length; await igDm('inv1', 'hello');
  const firstReply = lastMsgsTo('inv1', k);
  k = sent.length; await igDm('inv1', 'emerald price?');
  const secondReply = lastMsgsTo('inv1', k);
  check('Invite: never in the first reply; asked once interest is shown', () => { assert(!INV.test(firstReply)); assert(INV.test(secondReply), secondReply); });
  const ai0 = aiCalls.length; k = sent.length; await igDm('inv1', 'haan');
  const yesReply = lastMsgsTo('inv1', k); const aiAfterYes = aiCalls.length;
  check('Invite: customer says "haan" -> personal WhatsApp link, no AI guesswork', () => { assert(/wa\.me\/919817975977/.test(yesReply) && /WH-/.test(yesReply), yesReply); assert.strictEqual(aiAfterYes, ai0); });
  k = sent.length; await igDm('inv1', 'emerald 5 ratti price again?');
  const afterAccept = lastMsgsTo('inv1', k);
  check('Invite: never asked again after yes', () => assert(!INV.test(afterAccept)));

  await igDm('inv2', 'hi'); await igDm('inv2', 'pukhraj price');
  k = sent.length; await igDm('inv2', 'nahi yahin theek hai');
  const noCtx = lastAiFor('nahi yahin').contextText; const noReply = lastMsgsTo('inv2', k);
  k = sent.length; for (const q of ['emerald price', 'pukhraj price 5 ratti', 'ok']) await igDm('inv2', q);
  const laterNo = lastMsgsTo('inv2', k);
  check('Invite: customer says no -> respected, AI told, never asked again', () => {
    assert(/prefers to continue chatting here/.test(noCtx)); assert(!/wa\.me/.test(noReply)); assert(!INV.test(laterNo));
  });

  await igDm('inv3', 'hi'); await igDm('inv3', 'emerald price');
  k = sent.length; await igDm('inv3', 'what is the origin?'); await igDm('inv3', 'pukhraj price'); await igDm('inv3', 'price of ruby');
  const ignored = lastMsgsTo('inv3', k);
  check('Invite: customer ignores it -> normal chat, never asked again', () => { assert(!INV.test(ignored)); assert(!/wa\.me/.test(ignored)); });

  k = sent.length; await waMsg('919812399990', 'hi'); await waMsg('919812399990', 'emerald price');
  const waSide = sent.slice(k).filter((x) => x.url.endsWith('/messages')).map((x) => x.body.message).join('\n');
  k = sent.length; await igDm('anil', 'emerald price please');
  const anilSide = lastMsgsTo('anil', k);
  check('Invite: never on WhatsApp itself, never to customers already linked to WhatsApp', () => { assert(!INV.test(waSide)); assert(!INV.test(anilSide)); });

  const cm0 = sent.length; await igComment('commenter9', 'emerald price?');
  const cm1 = sent.slice(cm0).find((x) => x.url.includes('/inbox/comments/'))?.body.message || '';
  const cm2i = sent.length; await igComment('commenter9', 'pukhraj price?');
  const cm2 = sent.slice(cm2i).find((x) => x.url.includes('/inbox/comments/'))?.body.message || '';
  check('Comment: one soft WhatsApp line with the number, only once per person', () => { assert(/98179 75977/.test(cm1), cm1); assert(!/98179 75977/.test(cm2)); });

  // 18. NEVER ASK FOR THE NUMBER ON WHATSAPP
  let w0 = sent.length;
  await waMsg('919812366666', 'my order is damaged, I want a refund');
  const escReply = sent.slice(w0).filter((x) => x.url.endsWith('/messages')).map((x) => x.body.message).join('\n');
  const escCtx = lastAiFor('order is damaged').contextText;
  const flowMem = flowCalls[flowCalls.length - 1]?.existingMemory || '';
  check('WhatsApp escalation: never asks for contact number (asks name only)', () => {
    assert(!/contact number|phone/i.test(escReply), escReply);
    assert(/share your name/i.test(escReply), escReply);
  });
  check('WhatsApp: AI told the number is known; Kundli/payment flows get it pre-filled', () => {
    assert(/Never ask for their number/.test(escCtx)); assert(/Phone: \+919812366666/.test(escCtx));
    assert(/My contact number is \+919812366666/.test(flowMem), flowMem);
  });
  await waMsg('919812366666', 'my name is Sunita');
  w0 = sent.length; await waMsg('919812366666', 'still no refund, very bad');
  const esc2 = sent.slice(w0).filter((x) => x.url.endsWith('/messages')).map((x) => x.body.message).join('\n');
  check('WhatsApp: once name is known too, no details asked at all', () => { assert(!/share your (name|contact)|contact number/i.test(esc2), esc2); });
  // Instagram customer who gave their number earlier (Anil gave none; use new one)
  await igDm('igp', 'hi'); 
  await post({ event: 'message.received', account: { platform: 'instagram', accountId: 'acc-ig' }, conversation: { id: 'igp', participantUsername: 'igp_user', participantId: 'igsid_igp' }, message: { id: 'm-igp-ph', text: 'my name is Kavita, number 9876543210' } });
  await igDm('igp', 'which stone is good for me?');
  const igFlow = flowCalls[flowCalls.length - 1]?.existingMemory || '';
  const igCtx = lastAiFor('which stone is good').contextText;
  check('Instagram: name and number given earlier are known in later messages (no re-asking)', () => {
    assert(/My name is Kavita/.test(igFlow) && /My contact number is 9876543210/.test(igFlow), igFlow);
    assert(/Name: Kavita/.test(igCtx) && /Phone: 9876543210/.test(igCtx));
  });

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
