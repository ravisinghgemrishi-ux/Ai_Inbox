// =============================================================================
// salesInterview.js - Mannat interviews a team member on WhatsApp to learn
// how GemRishi wants every kind of customer question handled.
//
// Added 2026-10-20 (Ravi). Mannat sends one question at a time from her
// WhatsApp line (+91 74969 97220) with 3 options. The person replies 1, 2 or
// 3, or types their own answer. Every answer is logged in the lead log sheet
// (type "sales_training") and kept in Redis, then turned into Mannat's sales
// playbook.
//
// Replies the person can send at any time:
//   1 / 2 / 3        pick that option (they can add a note after it)
//   any other text   their own answer
//   skip             next question
//   back             redo the previous question
//   pause            stop for now (the next message continues where they left)
// =============================================================================

const QUESTIONS = [
  // --- PRICE & OFFERS ---
  { topic: 'Discount', ask: 'Koi discount milega?', options: [
    'Website price hi best price hai, discount nahi - politely mana karo',
    'Mannat khud thoda discount de sakti hai (aap limit batayein, jaise 5%)',
    'Discount ki baat team karegi - lead team ko forward karo' ] },
  { topic: 'Bargaining', ask: 'Thoda kam karo na, final kitna lagaoge?', options: [
    'Price fixed hai, value samjhao (certificate, guarantee, energisation)',
    'Ek baar thoda kam kar sakte ho, uske baad fixed',
    'Negotiation hamesha team karegi - number lo aur forward karo' ] },
  { topic: 'Price without details', ask: 'Price? / Pp (koi stone ya size nahi bataya)', options: [
    'Pehle poocho kaunsa stone, kitni ratti aur budget kya hai',
    'Ad wale stone ki starting price batao, phir size/budget poocho',
    'Popular 2-3 stones ki starting price ek saath batao' ] },
  { topic: 'Too expensive', ask: 'Bahut mehenga hai / bahar sasta mil raha hai', options: [
    'Quality, certificate, guarantee aur 122 saal ki legacy samjhao',
    'Unke budget mein chhota/dusra option dikhao',
    'Dono - value samjhao aur budget wala option bhi do' ] },
  { topic: 'Festive / running offers', ask: 'Abhi koi offer chal raha hai?', options: [
    'Abhi koi offer nahi - normal price batao',
    'Haan, ek fixed offer hai (aap batayein kya: jaise free ring, free energisation)',
    'Offer ke liye team se confirm karwao' ] },
  { topic: 'Bulk / multiple stones', ask: '2-3 stone saath lunga to kam karoge?', options: [
    'Haan, multiple stones par team special price degi - forward karo',
    'Nahi, har stone ki price same rahegi',
    'Mannat chhota fixed discount de sakti hai (aap batayein kitna)' ] },
  { topic: 'Price per ratti', ask: 'Per ratti rate kya hai?', options: [
    'Har stone ki total price hoti hai, per ratti rate nahi - specific stone ki price batao',
    'Approx per ratti range bata do, phir exact stone dikhao',
    'Budget aur size poochkar matching stones dikhao' ] },

  // --- TRUST & AUTHENTICITY ---
  { topic: 'Real or fake', ask: 'Asli hai ya nakli? Trust kaise karein?', options: [
    'Lab certificate + Lifetime Authenticity Guarantee Card + 122 saal ki legacy batao',
    'Showroom visit ya video call par stone dikhane ka offer do',
    'Dono - guarantee batao aur video call/visit offer karo' ] },
  { topic: 'Certificate', ask: 'Certificate milega? Kaunsi lab ka?', options: [
    'Har stone ke saath free lab certificate; IIGJ (Rs 2,100) / IGI (Rs 3,500) upgrade optional',
    'Har stone ke saath free certificate - lab ka naam team batayegi',
    'Certificate details team confirm karegi' ] },
  { topic: 'Own lab test', ask: 'Main bahar kisi lab mein check karwa sakta hoon?', options: [
    'Haan bilkul, kisi bhi govt lab mein check karwa lo - hum guarantee dete hain',
    'Haan, aur agar nakli nikla to poora paisa wapas',
    'Team se confirm karwao' ] },
  { topic: 'Natural vs lab-made', ask: 'Natural hai ya lab-created?', options: [
    'Sab natural hain, lab-created nahi bechte',
    'Natural hi hain - certificate mein likha hota hai',
    'Stone ke product page/certificate par likha hota hai' ] },
  { topic: 'Heated / treated', ask: 'Heated hai? Treated hai?', options: [
    'Har stone ka treatment uske certificate/product page par likha hai - specific stone check karke batao',
    'Unheated chahiye to team se confirm karwao',
    'Dono - page dekho aur unheated ke liye team ko forward karo' ] },
  { topic: 'Origin', ask: 'Ceylon ka hai? Burma ka? Origin kya hai?', options: [
    'Product page par jo origin likha hai wahi batao',
    'Origin team confirm karegi',
    'Page wala origin batao, specific origin ke liye team ko forward karo' ] },
  { topic: 'Buyback', ask: 'Baad mein wapas bechna ho to loge?', options: [
    'Haan, buyback hai (aap batayein kitne % par)',
    'Exchange/upgrade hota hai, cash buyback nahi',
    'Team se confirm karwao' ] },

  // --- PAYMENT ---
  { topic: 'COD', ask: 'Cash on delivery milega?', options: [
    'Nahi, sirf online/advance payment',
    'Haan, COD available hai (koi limit ho to batayein)',
    'Thoda advance lekar baaki COD' ] },
  { topic: 'Payment methods', ask: 'Payment kaise karun?', options: [
    'Website par online (UPI/card/netbanking)',
    'UPI/bank transfer - team details degi',
    'Dono - website ya team se direct' ] },
  { topic: 'EMI', ask: 'EMI milegi?', options: [
    'Haan, website checkout par card EMI available hai',
    'Nahi, EMI nahi hai',
    'Team se confirm karwao' ] },
  { topic: 'Advance / token', ask: 'Abhi thoda advance de deta hoon, stone hold kar lo', options: [
    'Haan, advance lekar stone hold kar sakte hain (kitne din, aap batayein)',
    'Nahi, full payment par hi order confirm',
    'Team decide karegi - forward karo' ] },
  { topic: 'GST bill', ask: 'GST bill milega?', options: [
    'Haan, har order par GST invoice milta hai',
    'Maangne par GST invoice milta hai',
    'Team se confirm karwao' ] },

  // --- DELIVERY ---
  { topic: 'Delivery time', ask: 'Kitne din mein delivery hogi?', options: [
    'Loose stone 3-5 din, ring/pendant 7-10 din',
    'Aap sahi time batayein (stone aur ring alag)',
    'Team order ke time confirm karegi' ] },
  { topic: 'Delivery charges', ask: 'Delivery charge kitna hai?', options: [
    'India mein free delivery',
    'Free above ek amount (aap batayein), neeche charge',
    'Team confirm karegi' ] },
  { topic: 'International', ask: 'Main USA/UK/Dubai mein hoon, wahan bhejoge?', options: [
    'Haan, 195+ countries mein bhejte hain (UPS/FedEx/EMS), 2 lakh se upar free',
    'Haan, shipping charge team batayegi',
    'International order team handle karegi - forward karo' ] },
  { topic: 'Safety', ask: 'Raste mein kho gaya / toot gaya to?', options: [
    'Fully insured shipping hai - hamari zimmedari',
    'Tamper-proof packing + tracking milti hai',
    'Dono batao' ] },
  { topic: 'Store pickup', ask: 'Main showroom se le sakta hoon?', options: [
    'Haan, Ambala/Shimla/Solan kisi bhi showroom se',
    'Sirf Ambala se',
    'Team se time fix karwao' ] },

  // --- RETURNS ---
  { topic: 'Return / refund', ask: 'Pasand nahi aaya to return hoga?', options: [
    'Haan, kuch din mein return (aap batayein kitne din)',
    'Return nahi, sirf exchange',
    'Return/exchange team decide karegi' ] },
  { topic: 'Exchange / upgrade', ask: 'Baad mein bada stone lena ho to purana exchange hoga?', options: [
    'Haan, purana stone value mein adjust karke upgrade',
    'Nahi',
    'Team se confirm karwao' ] },
  { topic: 'Ring size wrong', ask: 'Ring size galat ho gaya to?', options: [
    'Free mein size theek karke denge',
    'Size change ka chhota charge',
    'Team handle karegi' ] },

  // --- RING / PENDANT MAKING ---
  { topic: 'Metal options', ask: 'Ring kis metal mein banegi?', options: [
    'Silver, gold, panchdhatu - teeno',
    'Sirf silver aur gold',
    'Stone ke hisaab se suggest karo (jaise Pukhraj gold mein)' ] },
  { topic: 'Making charges', ask: 'Ring banane ka kitna lagega?', options: [
    'Approx range batao (aap batayein: silver Rs __, gold Rs __)',
    'Design aur metal par depend - team quote degi',
    'Website par ring designs ke prices dikhao' ] },
  { topic: 'Ring size', ask: 'Mujhe apna ring size nahi pata', options: [
    'Ghar par dhaage se naapne ka tarika batao',
    'Purani ring ka size bhejne ko kaho',
    'Dono batao' ] },
  { topic: 'Design photos', ask: 'Ring ke designs dikhao', options: [
    'Website ki ring collection ka link do',
    'Team photos bhejegi - forward karo',
    'Collection ke naam batao aur link do' ] },
  { topic: 'Custom design', ask: 'Apna design banwana hai / naam likhwana hai', options: [
    'Haan, Personalized Astro Rings - team details legi',
    'Haan, extra charge lagega - team quote degi',
    'Nahi, sirf website designs' ] },

  // --- ASTROLOGY ---
  { topic: 'Which stone for me', ask: 'Mujhe kaunsa stone pehnna chahiye? (kundli nahi di)', options: [
    'Free Kundli flow chalao - DOB, time, place lekar recommend karo',
    'Unki problem/goal poochkar general suggest karo',
    'Astrologer consultation (paid) suggest karo' ] },
  { topic: 'Rashi-based', ask: 'Meri rashi Mesh hai, kaunsa stone?', options: [
    'Rashi ke hisaab se general stone batao, sath mein kundli check suggest karo',
    'Sirf kundli dekhkar hi batate hain - DOB lo',
    'Consultation par bhejo' ] },
  { topic: 'Suits me / side effects', ask: 'Ye stone mujhe suit karega? Nuksan to nahi hoga?', options: [
    'Kundli check ke baad hi pehnein - free kundli flow chalao',
    'Trial ke liye kuch din pehnkar dekhne ko kaho',
    'Astrologer se consult karwao' ] },
  { topic: 'Two stones together', ask: 'Do stone saath pehen sakta hoon?', options: [
    'Kuch combinations theek nahi hote - astrologer se check karwao',
    'General rule batao (jaise Neelam-Manik saath nahi)',
    'Kundli flow/consultation par bhejo' ] },
  { topic: 'Wearing method', ask: 'Kaise pehnu? Kaunsa din, ungli, mantra?', options: [
    'Stone ke saath wearing guide milti hai - basic din/ungli batao',
    'Team/astrologer delivery ke time batayega',
    'Basic batao aur guide card ka zikr karo' ] },
  { topic: 'Energisation', ask: 'Abhimantrit/energise karke doge?', options: [
    'Haan, har stone Vrindavan mein Vedic vidhi se free energise hota hai',
    'Haan, extra charge par',
    'Team se confirm karwao' ] },
  { topic: 'How long for results', ask: 'Kitne din mein asar dikhega?', options: [
    'Koi guarantee nahi - traditionally 30-45 din mein feel hota hai',
    'Har insaan alag hota hai - consultation suggest karo',
    'Result ka time mat batao, sirf tradition ki baat karo' ] },
  { topic: 'Cheaper substitute', ask: 'Neelam bahut mehenga hai, sasta option?', options: [
    'Upratna (jaise Neelam ki jagah Amethyst/Neeli) suggest karo',
    'Chhoti ratti ka asli stone dikhao',
    'Dono options do' ] },
  { topic: 'Minimum ratti', ask: 'Kitni ratti ka pehnu?', options: [
    'Body weight ke hisaab se rule batao (jaise 10 kg = 1 ratti)',
    'Astrologer/kundli ke hisaab se',
    'Budget ke hisaab se jitna bada ho sake' ] },

  // --- PRODUCT DETAILS ---
  { topic: 'Ratti or carat', ask: 'Ratti mein batao ya carat mein?', options: [
    'Dono batao - ratti pehle, carat bracket mein',
    'Customer jo bole usi mein',
    'Sirf carat (website wala)' ] },
  { topic: 'Real photo / video', ask: 'Is stone ki asli photo/video bhejo', options: [
    'Product page par photos/video hain - link do',
    'Team exact stone ki video bhejegi - forward karo',
    'Dono - link do aur video ke liye forward karo' ] },
  { topic: 'Video call', ask: 'Video call par stone dikhao', options: [
    'Haan, team video call schedule karegi (10 AM - 7 PM)',
    'Nahi, sirf photos/video',
    'Team decide karegi - forward karo' ] },
  { topic: 'Out of stock / exact size', ask: 'Exact 7.25 ratti chahiye, nahi hai to?', options: [
    'Nearest sizes dikhao (thoda kam/zyada)',
    'Team se arrange karwane ka offer do - forward karo',
    'Dono - nearest dikhao aur arrange ka offer do' ] },

  // --- SALES PROCESS ---
  { topic: 'Ready to buy', ask: 'Theek hai, ye wala chahiye. Kaise lun?', options: [
    'Product page link do - website par khud order kare',
    'Number lo, team call karke order le',
    'Dono - link do aur number bhi lo' ] },
  { topic: 'Will think', ask: 'Sochke batata hoon', options: [
    'Theek hai bolo, number lekar kal team follow-up kare',
    'Koi reason poocho (price/trust) aur us par help karo',
    'Dono - reason poocho aur number lo' ] },
  { topic: 'When to ask number', ask: '(Mannat customer ka number kab maange?)', options: [
    'Jab customer ko stone pasand aa jaye / price pooch le',
    'Pehle 2-3 messages mein hi',
    'Sirf jab customer buy karna chahe ya call maange' ] },
  { topic: 'Talk to astrologer / Rishi ji', ask: 'Mujhe Rishi ji / astrologer se baat karni hai', options: [
    'Paid consultation plans batao',
    'Team call arrange karegi - forward karo',
    'Pehle free kundli, phir consultation offer' ] },
  { topic: 'Late night customer', ask: '(Raat 11 baje customer ready to buy hai)', options: [
    'Link do taaki abhi order kar sake + subah team call',
    'Number lo, subah 10 baje ke baad team call karegi',
    'Dono' ] },

  // --- AFTER SALES ---
  { topic: 'Order status', ask: 'Mera order kahan hai?', options: [
    'Order number lo aur team ko forward karo',
    'Website par tracking dekhne ko kaho',
    'Dono' ] },
  { topic: 'Complaint', ask: 'Stone toot gaya / galat stone aaya', options: [
    'Sorry bolo, photo + order number lo, Neel ko turant forward',
    'Replacement ka promise karo',
    'Team handle karegi - forward karo' ] },

  // --- RUDRAKSHA ---
  { topic: 'Rudraksha real', ask: 'Rudraksha asli hai? Nepali hai ya Indonesian?', options: [
    'Product page par origin likha hai + lab/X-ray certificate',
    'Sab Nepali hain',
    'Team confirm karegi' ] },
  { topic: 'Rudraksha with stone', ask: 'Stone ke saath Rudraksha bhi pehnu?', options: [
    'Sirf jab customer khud pooche tab suggest karo',
    'Hamesha matching Rudraksha suggest karo',
    'Astrologer se poochne ko kaho' ] },

  // --- OTHER ---
  { topic: 'Gift', ask: 'Gift karna hai, packing achhi milegi?', options: [
    'Haan, premium gift box mein aata hai',
    'Gift wrap extra charge par',
    'Team confirm karegi' ] },
  { topic: 'Reseller / wholesale', ask: 'Main jeweller hoon, wholesale doge?', options: [
    'B2B enquiry - Neel ko forward karo',
    'Nahi, sirf retail',
    'Wholesale price list team bhejegi - forward karo' ] },
  { topic: 'Not interested / angry', ask: 'Pareshan mat karo / block kar dunga', options: [
    'Sorry bolo aur chup ho jao',
    'Sorry bolo, ek baar number lekar team ko de do',
    'Team ko forward karo, Mannat ruk jaye' ] },
];

const STATE_TTL = 30 * 86400;

function redisCfg() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}
async function redis(path) {
  const { url, token } = redisCfg();
  if (!url || !token) throw new Error('Redis not configured');
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis ${res.status}`);
  return res.json().catch(() => ({}));
}
const stateKey = (route) => `gemrishi:interview:${route}`;
const answersKey = (route) => `gemrishi:interview:${route}:answers`;

async function getState(route) {
  const r = await redis(`/get/${encodeURIComponent(stateKey(route))}`);
  return r?.result ? JSON.parse(r.result) : null;
}
async function setState(route, state) {
  await redis(`/set/${encodeURIComponent(stateKey(route))}/${encodeURIComponent(JSON.stringify(state))}/EX/${STATE_TTL}`);
}

function questionText(i) {
  const q = QUESTIONS[i];
  return [
    `Q${i + 1}/${QUESTIONS.length} - ${q.topic}`,
    `Customer: "${q.ask}"`,
    'Mannat kya kare?',
    `1) ${q.options[0]}`,
    `2) ${q.options[1]}`,
    `3) ${q.options[2]}`,
    '',
    '1, 2 ya 3 bhejiye - ya apna jawab likhiye. (skip / back / pause)',
  ].join('\n');
}

// What did they answer? { kind: 'option'|'own'|'skip'|'back'|'pause', option, note }
function parseAnswer(text) {
  const t = String(text || '').trim();
  if (/^(skip|next|agla|aage)\b/i.test(t)) return { kind: 'skip' };
  if (/^(back|pichla|previous|wapas)\b/i.test(t)) return { kind: 'back' };
  if (/^(pause|stop|baad\s*mein|later|ruko)\b/i.test(t)) return { kind: 'pause' };
  const m = t.match(/^\(?([123])(?![\d.,])\)?(?:\s*[).:,-]?\s*(.*))?$/s);
  if (m) return { kind: 'option', option: Number(m[1]), note: (m[2] || '').trim() };
  if (/^(option\s*)?(one|ek)\b/i.test(t)) return { kind: 'option', option: 1, note: '' };
  if (/^(option\s*)?(two|do)\b/i.test(t) && t.length < 6) return { kind: 'option', option: 2, note: '' };
  if (/^(option\s*)?(three|teen)\b/i.test(t)) return { kind: 'option', option: 3, note: '' };
  return { kind: 'own', note: t };
}

function answerSummary(i, a) {
  const q = QUESTIONS[i];
  if (a.kind === 'option') return `Option ${a.option}: ${q.options[a.option - 1]}${a.note ? ` | Note: ${a.note}` : ''}`;
  return `Own answer: ${a.note}`;
}

// deps: { send(text, n), log(row) }
async function start({ route, person, send }) {
  await setState(route, { idx: 0, paused: false, startedAt: new Date().toISOString() });
  await send(`Namaste ${person} ji! 🙏 Main Mannat (GemRishi AI).\n\nMujhe customers se bilkul aapke tarike se baat karni hai, isliye ${QUESTIONS.length} chhote sawal poochungi - har sawal mein customer kya poochta hai aur 3 options. Bas 1, 2 ya 3 bhejiye, ya apna jawab likh dijiye. Kabhi bhi "pause" likh kar ruk sakte hain, baad mein wahi se shuru hoga.`, 0);
  await send(questionText(0), 1);
  return { ok: true, total: QUESTIONS.length };
}

async function isActive(route) {
  try { const s = await getState(route); return Boolean(s && !s.done); } catch { return false; }
}

async function handleReply({ route, person, text, send, log }) {
  const s = await getState(route);
  if (!s || s.done) return { handled: false };
  if (s.paused) {
    s.paused = false;
    await setState(route, s);
    await send(`Welcome back ${person} ji! Wahi se shuru karte hain 👇`, 0);
    await send(questionText(s.idx), 1);
    return { handled: true, resumed: true };
  }
  const a = parseAnswer(text);
  if (a.kind === 'pause') {
    s.paused = true;
    await setState(route, s);
    await send(`Theek hai, ruk jaati hoon. Jab free hon, koi bhi message bhejiye - Q${s.idx + 1} se continue karenge. 🙏`, 0);
    return { handled: true, paused: true };
  }
  if (a.kind === 'back') {
    s.idx = Math.max(0, s.idx - 1);
    await setState(route, s);
    await send(questionText(s.idx), 0);
    return { handled: true };
  }
  if (a.kind !== 'skip') {
    const summary = answerSummary(s.idx, a);
    const q = QUESTIONS[s.idx];
    try { await redis(`/hset/${encodeURIComponent(answersKey(route))}/${s.idx + 1}/${encodeURIComponent(JSON.stringify({ topic: q.topic, ask: q.ask, answer: summary, at: new Date().toISOString() }))}`); }
    catch (err) { console.error('[interview] answer save failed:', err.message); }
    try {
      await log({
        platform: 'whatsapp', contact: person, type: 'sales_training',
        message: `Q${s.idx + 1} ${q.topic}: "${q.ask}"`,
        reply: summary, leadStatus: 'NOT_A_LEAD', productInterest: '', escalated: false,
        notes: `sales_training | answered_by=${person}`,
      });
    } catch (err) { console.error('[interview] log failed:', err.message); }
  }
  s.idx += 1;
  if (s.idx >= QUESTIONS.length) {
    s.done = true;
    await setState(route, s);
    await send(`Bahut bahut shukriya ${person} ji! 🙏 Saare ${QUESTIONS.length} sawal ho gaye. Aapke jawab save ho gaye hain - ab main customers se isi tarike se baat karungi.`, 0);
    return { handled: true, done: true };
  }
  await setState(route, s);
  await send(questionText(s.idx), 0);
  return { handled: true };
}

async function answers(route) {
  const r = await redis(`/hgetall/${encodeURIComponent(answersKey(route))}`);
  const flat = Array.isArray(r?.result) ? r.result : [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push({ q: Number(flat[i]), ...JSON.parse(flat[i + 1]) }); } catch { /* skip */ }
  }
  return out.sort((x, y) => x.q - y.q);
}

module.exports = { QUESTIONS, questionText, parseAnswer, answerSummary, start, isActive, handleReply, answers, getState };
