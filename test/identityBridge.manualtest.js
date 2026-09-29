const assert = require('assert'); const path = require('path'); const { EventEmitter } = require('events');
Object.assign(process.env, { REDIS_KV_REST_API_URL: 'https://fake-redis', REDIS_KV_REST_API_TOKEN: 'x', ZERNIO_API_KEY: 'x', GEMINI_API_KEY: 'g',
  ENABLE_IDENTITY_BRIDGE: 'true', ENABLE_TEAM_MONITOR: 'true', TEAM_MONITOR_WEBHOOK_URL: 'https://sheet-hook', TEAM_MONITOR_SECRET: 'k1', MESSAGE_BATCH_WAIT_MS: '30', HUMAN_TYPING_DELAY_SCALE: '0.001' });
delete process.env.ZERNIO_WEBHOOK_SECRET;
const cfg = require('/home/claude/live4/lib/teamMonitor.config.js');
cfg.TEAM_WHATSAPP_NUMBERS.push('919999900000', '919817975977'); // 2nd = Mannat's own number, listed BY MISTAKE
cfg.TEAM_MEMBERS.push({ id: 'agent-neel', name: 'Neel Das', phone: '', role: 'Sales Lead' });

const store = new Map(); const sheetRows = []; const zernio = []; const reviewCalls = []; let customerAiCalls = 0; let leadLogCalls = 0; let reviewFail = false;
function ex(p){const[c,k,...r]=p;switch(c){case 'get':return store.has(k)?store.get(k):null;case 'set':{if(r.includes('NX')&&store.has(k))return null;store.set(k,r[0]);return 'OK';}case 'del':store.delete(k);return 1;case 'incr':{const v=Number(store.get(k)||0)+1;store.set(k,String(v));return v;}case 'expire':return 1;case 'rpush':case 'lpush':{const l=store.get(k)||[];l.push(r[0]);store.set(k,l);return l.length;}case 'ltrim':{const l=store.get(k)||[];let[a,b]=r.map(Number);if(a<0)a=Math.max(0,l.length+a);if(b<0)b=l.length+b;store.set(k,l.slice(a,b+1));return 'OK';}case 'lrange':return(store.get(k)||[]).slice(0);case 'hset':{const h=store.get(k)||{};h[r[0]]=r[1];store.set(k,h);return 1;}case 'hgetall':{const h=store.get(k);return h?Object.entries(h).flat():[];}default:throw new Error(c);}}
global.fetch = async (u, o = {}) => { u = String(u);
  if (u.startsWith('https://fake-redis')) { const p = u.slice(19).split('/').map(decodeURIComponent); return { ok: true, json: async () => ({ result: ex(p) }) }; }
  if (u === 'https://sheet-hook') { sheetRows.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) }; }
  if (u.includes('generativelanguage')) { const b = JSON.parse(o.body); reviewCalls.push(b); if (reviewFail) return { ok: false, status: 500, text: async () => 'x' };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ score: 5, good: 'Polite', loophole: 'Took 12 minutes and never shared the price', betterReply: 'Namaste Ramesh ji! 5 ratti Pukhraj ₹44,500 mein available hai. Photo bhej doon?' }) }] } }] }) }; }
  if (u.includes('zernio')) { zernio.push(u.split('/api/v1')[1] || u); return { ok: true, json: async () => ({}) }; }
  throw new Error('unexpected fetch ' + u); };
const lib = (f) => path.join('/home/claude/live4/lib', f); const stub = (f, e) => { require.cache[require.resolve(lib(f))] = { id: lib(f), filename: lib(f), loaded: true, exports: e }; };
stub('replyEngine.js', { KNOWLEDGE_BASE: 'KB: free lab certificate; IIGJ 2100; store in Ambala.', generateReply: async () => { customerAiCalls++; return { reply: 'CUSTOMER-REPLY', leadStatus: 'WARM', escalate: false }; } });
stub('leadLog.js', { logLead: async () => { leadLogCalls++; } });
stub('escalationNotifier.js', { notifyEscalation: async () => {}, notifyHotLead: async () => {} });
stub('humanTakeoverGuard.js', { checkHumanTakeover: async () => ({ silence: false }), markAiSent: async () => {} });
for (const f of ['kundliFlow.js', 'consultationFlow.js', 'sellerInquiryFlow.js']) stub(f, { maybeHandleKundliTurn: async () => null, maybeHandleConsultationPayment: async () => null, maybeHandleSellerInquiry: async () => null });
stub('productResolver.js', { lookupLiveProduct: async (q) => ({ found: /pukhraj/i.test(q) }), formatLiveProductData: (r) => (r?.found ? 'Yellow Sapphire 5 ratti ₹44,500 https://gemrishi.com/p/1' : '') });
const wh = require('/home/claude/live4/api/webhook.js');
const post = (b) => new Promise((res) => { const req = new EventEmitter(); req.method = 'POST'; req.headers = {}; wh(req, { status() { return this; }, json(x) { res(x); } }); setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(b))); req.emit('end'); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const team = (id, text, extra = {}) => ({ event: 'message.received', account: { platform: 'whatsapp', phone: '919999900000', accountId: 'acc-team' }, conversation: { id: 'tc1', participantName: 'Ramesh', participantPhone: '919812345678' }, message: { id, text }, ...extra });
const R = []; const check = (n, f) => { try { f(); R.push('PASS ' + n); } catch (e) { R.push('FAIL ' + n + ' :: ' + e.message); } };

(async () => {
  await post(team('t1', '5 ratti pukhraj ka price kya hai?'));
  await wait(40);
  // pretend the customer wrote 12 minutes ago
  const k = [...store.keys()].find((x) => x.startsWith('gemrishi:conversation:monitor:')); const l = store.get(k); const t = JSON.parse(l[0]); t.timestamp = new Date(Date.now() - 12 * 60000).toISOString(); l[0] = JSON.stringify(t);
  await post({ ...team('t2', 'ji dekh ke batata hu'), event: 'message.sent', message: { id: 't2', text: 'ji dekh ke batata hu', direction: 'outgoing', sender: { id: 'agent-neel', name: 'Neel Das' } } });
  await wait(60);
  const inRow = sheetRows.find((r) => r.direction === 'IN (customer)'); const out = sheetRows.find((r) => r.direction === 'OUT (staff)');

  check('Team number: Mannat sends NOTHING on WhatsApp (no message, no typing)', () => assert.strictEqual(zernio.length, 0, JSON.stringify(zernio)));
  check("Team number: Mannat's customer-reply brain is never used", () => assert.strictEqual(customerAiCalls, 0));
  check('Team number: nothing written to the customer lead log', () => assert.strictEqual(leadLogCalls, 0));
  check('Team number: no customer memory / identity data created', () => { const bad = [...store.keys()].filter((x) => !x.startsWith('gemrishi:conversation:monitor:') && !/^gemrishi:webhook:message:/.test(x)); assert.strictEqual(bad.length, 0, bad.join(',')); });
  check('Incoming customer message logged', () => { assert(inRow); assert.strictEqual(inRow.customerName, 'Ramesh'); assert(/pukhraj/.test(inRow.customerMessage)); });
  check('Staff reply logged with name, designation, customer message and reply time', () => { assert.strictEqual(out.staffName, 'Neel Das'); assert.strictEqual(out.staffRole, 'Sales Lead'); assert(/pukhraj/.test(out.customerMessage)); assert(out.replyMinutes >= 11.5 && out.replyMinutes <= 12.5, out.replyMinutes); assert.strictEqual(out.staffMatched, 'yes'); });
  check('Rows carry the private sheet key', () => assert.strictEqual(out.secret, 'k1'));
  check('Review fields filled: score, good, loophole, better reply', () => { assert.strictEqual(out.score, 5); assert(/price/.test(out.loophole)); assert(/44,500/.test(out.betterReply)); });
  const rv = reviewCalls[0]; const sys = rv?.systemInstruction?.parts?.[0]?.text || ''; const usr = rv?.contents?.[0]?.parts?.[0]?.text || '';
  check('Reviewer is SEPARATE: own coach instructions + reads the knowledge base', () => { assert(/private sales-quality coach/.test(sys)); assert(/free lab certificate/.test(sys)); assert(/Sales Lead/.test(sys)); });
  check('Reviewer gets real prices, reply time, and a clean transcript (no "Mannat" confusion)', () => { assert(/44,500/.test(usr)); assert(/12(\.\d)? minutes/.test(usr), usr); assert(!/Mannat:/.test(usr)); });

  reviewFail = true; await post({ ...team('t3', 'ok'), event: 'message.sent', message: { id: 't3', text: 'ok', direction: 'outgoing', sender: { id: 'agent-neel' } } }); await wait(60); reviewFail = false;
  const failRow = sheetRows.filter((r) => r.direction === 'OUT (staff)').pop();
  check('If the AI review fails: row still logged, no fake customer text', () => { assert(/review failed/.test(failRow.reviewNote)); assert(!/Thanks for reaching out/.test(JSON.stringify(failRow))); assert.strictEqual(zernio.length, 0); });

  await post({ ...team('t4', 'who dis'), message: { id: 't4', text: 'bhai kaun', direction: 'outgoing', sender: { id: 'x-unknown', name: 'Rohit' } }, event: 'message.sent' }); await wait(50);
  check('Unknown sender still logged, flagged for identification', () => { const r = sheetRows.filter((x) => x.direction === 'OUT (staff)').pop(); assert.strictEqual(r.staffName, 'Rohit'); assert(/not in team list/.test(r.staffMatched)); });

  // Mannat's own number was listed by mistake -> must STILL reply to customers
  const z0 = zernio.length, s0 = sheetRows.length;
  await post({ event: 'message.received', account: { platform: 'whatsapp', phone: '919817975977', accountId: 'acc-mannat' }, conversation: { id: 'mc1', participantPhone: '917777700000' }, message: { id: 'm1', text: 'hello' } }); await wait(250);
  check("Mannat's own number can never be monitored: customers still get replies", () => { assert(zernio.length > z0, 'no reply sent'); assert.strictEqual(sheetRows.length, s0, 'was logged to monitor sheet'); });

  const z1 = zernio.length, s1 = sheetRows.length;
  await post({ event: 'message.sent', account: { platform: 'whatsapp', phone: '919817975977', accountId: 'acc-mannat' }, conversation: { id: 'mc1' }, message: { id: 'm2', text: 'CUSTOMER-REPLY', direction: 'outgoing' } }); await wait(80);
  check("Mannat's own sent messages are ignored (no loop, no logging)", () => { assert.strictEqual(zernio.length, z1); assert.strictEqual(sheetRows.length, s1); });

  const z2 = zernio.length;
  await post({ event: 'message.received', account: { platform: 'whatsapp', phone: '918888888888', accountId: 'acc-other' }, conversation: { id: 'cc1', participantPhone: '917777711111' }, message: { id: 'c1', text: 'hi' } }); await wait(250);
  check('Other customer numbers: normal Mannat replies, unchanged', () => assert(zernio.length > z2));

  process.env.ENABLE_TEAM_MONITOR = 'false'; const s2 = sheetRows.length;
  await post(team('t9', 'hi again')); await wait(250);
  check('Monitor switched OFF: nothing written to monitor sheet', () => assert.strictEqual(sheetRows.length, s2));

  console.log(R.join('\n')); console.log(`\n${R.filter((r) => r.startsWith('PASS')).length}/${R.length} passed`); process.exit(R.every((r) => r.startsWith('PASS')) ? 0 : 1);
})();
