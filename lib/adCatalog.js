/**
 * Ad / reel catalog (2026-10-24, Ravi): which stone a customer is asking
 * about when they come from an ad or a reel and just say "how much for this
 * stone?" / "Can you check the price of a product?".
 *
 * Meta sends the ad's id (and for Instagram the post/reel id) with the first
 * message. Every running ad, its creative, its Instagram post and its video
 * id point to one ENTRY below. To add a new ad: add its ids to AD_IDS (or a
 * keyword to KEYWORDS) - ids not found here are saved in Redis
 * (gemrishi:unmapped-ads) so they can be added.
 *
 * rule: 'big_stone' -> 10+ carat/ratti: "very unique requirement", collect
 *       details, forward to the team (lib/requirementRules.js).
 *       'unique'    -> rare / not on the website: collect details, forward.
 */

const ENTRIES = {
  ys21: {
    product: '21 Carat Natural Ceylon Yellow Sapphire (Pukhraj)',
    facts: '21 carats, unheated and untreated, sourced directly from Sri Lanka. Price on request - this piece is NOT listed on the website.',
    carat: 21,
    rule: 'big_stone',
  },
  ysBenefits: {
    product: 'Yellow Sapphire (Pukhraj)',
    facts: 'Video on Yellow Sapphire benefits (Jupiter: wealth, wisdom, career). Share live in-stock Yellow Sapphire options with prices.',
  },
  kashmir: {
    product: 'Kashmir Blue Sapphire',
    facts: 'Story video on the rare Kashmir Sapphire. Kashmir sapphires are extremely rare - price and availability on request only.',
    rule: 'unique',
  },
  invest: {
    product: 'Natural gemstones (investment)',
    facts: 'Video: foreign buyers invest in natural gemstones because they are limited. The ad says "DM us GEM". Ask which stone and budget they have in mind.',
  },
  trust: {
    product: 'Natural lab-certified gemstones',
    facts: 'Brand video: natural, untreated, lab-certified, mine-direct gemstones, five generations of jewellers. Ask which stone they are looking for.',
  },
  buyingTips: {
    product: 'Gemstone buying guide',
    facts: 'Video: 5 questions to ask before buying a gemstone (natural/untreated, GIA/IGI certificate, origin...). Ask which stone they want to buy.',
  },
  realOrFake: {
    product: 'Gemstone authenticity check',
    facts: 'Video: how to know if a gemstone is real (certificate, expert check). Offer certified options and ask which stone.',
  },
  diamondRing: {
    product: 'Certified Natural Diamond Ring in 14k Gold (1.29 ct)',
    facts: '1.29 carat natural certified diamond set in a 14k gold ring; international shipping available.',
  },
  amethyst: {
    product: 'Amethyst',
    facts: 'Video on Amethyst for stress, anxiety and overthinking (Third Eye chakra). Share live Amethyst options if listed.',
  },
};

// ad id / creative id / Instagram post id / video id -> entry key
const AD_IDS = {
  '1017567408024262': 'diamondRing',
  '1040212882370216': 'ys21',
  '1041106115614558': 'ysBenefits',
  '1058648363853761': 'trust',
  '1076316775407796': 'invest',
  '1077997948435985': 'ys21',
  '1082674027731096': 'ys21',
  '1084443274428958': 'ys21',
  '1128779192877360': 'ys21',
  '1133393295807398': 'ysBenefits',
  '1138428788658968': 'invest',
  '1140762365572402': 'kashmir',
  '120250828372390262': 'kashmir',
  '120250828558070262': 'ysBenefits',
  '120251031276530262': 'buyingTips',
  '120251032847820262': 'realOrFake',
  '120251032859370262': 'amethyst',
  '120251032877710262': 'ysBenefits',
  '120251032893890262': 'diamondRing',
  '120251045851250262': 'ys21',
  '120251045884650262': 'ys21',
  '120251045888250262': 'ys21',
  '120251045892670262': 'ys21',
  '120251046304200262': 'ys21',
  '120251046304990262': 'trust',
  '120251046308930262': 'kashmir',
  '120251046315830262': 'ysBenefits',
  '120251046327320262': 'invest',
  '120251046358090262': 'ys21',
  '120251046358110262': 'ysBenefits',
  '120251046358120262': 'invest',
  '120251046358130262': 'kashmir',
  '120251046450830262': 'trust',
  '120251046490000262': 'invest',
  '120251046490010262': 'ysBenefits',
  '120251046490020262': 'kashmir',
  '120251046490030262': 'trust',
  '120251046490040262': 'ys21',
  '120251046541980262': 'kashmir',
  '120251046541990262': 'trust',
  '120251046542000262': 'ys21',
  '120251046542010262': 'ysBenefits',
  '120251046542020262': 'invest',
  '1279695314302429': 'ysBenefits',
  '1355924273119240': 'trust',
  '1414329767392538': 'ys21',
  '1427482542834211': 'ys21',
  '1440642291543538': 'invest',
  '1449193793806384': 'ys21',
  '1529133512598930': 'ys21',
  '1559773126184086': 'trust',
  '1595197605166799': 'ys21',
  '1615457003461886': 'realOrFake',
  '1634745901464022': 'kashmir',
  '1635205974746338': 'trust',
  '1638082381233488': 'invest',
  '1655795299235494': 'invest',
  '1657002995959812': 'invest',
  '1681383470315888': 'ys21',
  '1689173872873731': 'ys21',
  '1711857320575083': 'ys21',
  '1715767126673957': 'ys21',
  '1745359127309633': 'diamondRing',
  '1749418866171644': 'ysBenefits',
  '1759104785161764': 'kashmir',
  '1789505662162175': 'invest',
  '17954112489273558': 'trust',
  '17970096896965836': 'invest',
  '17973555030157272': 'ys21',
  '18101556485061450': 'buyingTips',
  '18122117822314983': 'ysBenefits',
  '18122546519057520': 'amethyst',
  '1829662514910349': 'invest',
  '18344643766259080': 'realOrFake',
  '18639161572056394': 'kashmir',
  '18639387877031103': 'diamondRing',
  '2010259286300662': 'kashmir',
  '2020188998641206': 'kashmir',
  '2024266258240619': 'kashmir',
  '2124413824877486': 'kashmir',
  '2212758012992321': 'buyingTips',
  '2238384190062563': 'ysBenefits',
  '2250242619092253': 'ysBenefits',
  '2305161366909048': 'kashmir',
  '2307647329803811': 'ys21',
  '2327683644740580': 'ys21',
  '2361806424355588': 'ysBenefits',
  '2705682929834946': 'trust',
  '2782067572195221': 'ysBenefits',
  '2804818229915383': 'amethyst',
  '2910972995968270': 'kashmir',
  '2950166525360313': 'ysBenefits',
  '2970815539948478': 'buyingTips',
  '3398736780314416': 'trust',
  '3734537326717745': 'amethyst',
  '39520389374273179': 'ysBenefits',
  '4062530614054707': 'trust',
  '4340348112852474': 'ysBenefits',
  '4422932357841695': 'kashmir',
  '4583277605279801': 'ysBenefits',
  '984431488046418': 'realOrFake',
  '991551266621249': 'trust'
};

// When only the ad's text comes through (no id we know).
const KEYWORDS = [
  [/21[\s-]*carat yellow sapphire|21 ?ct yellow/i, 'ys21'],
  [/kashmir sapphire/i, 'kashmir'],
  [/diamond ring in 14k/i, 'diamondRing'],
  [/amethyst/i, 'amethyst'],
  [/foreign buyers|dm us gem\b/i, 'invest'],
  [/yellow sapphire, associated with the planet jupiter/i, 'ysBenefits'],
];

function entryFor(key) {
  return key && ENTRIES[key] ? { key, ...ENTRIES[key] } : null;
}

// Fields where Meta/Zernio put the ad / post / story reference.
function referenceBlobs(event = {}) {
  const m = event.message || {};
  const c = event.conversation || {};
  return [
    event.metadata, event.referral, c.metadata, m.metadata, m.referral,
    m.attachments, m.replyTo, m.reply_to, m.story, m.context, m.ads_context_data,
  ].filter(Boolean);
}

// -> { entry, adRef } ; entry is null when an ad/post reference exists but
// is not in the catalog (adRef is then saved as unmapped by the caller).
function matchAd(event) {
  const blobs = referenceBlobs(event);
  if (!blobs.length) return { entry: null, adRef: '' };
  const text = JSON.stringify(blobs);
  const ids = text.match(/\d{14,20}/g) || [];
  for (const id of ids) {
    if (AD_IDS[id]) return { entry: entryFor(AD_IDS[id]), adRef: id };
  }
  for (const [re, key] of KEYWORDS) {
    if (re.test(text)) return { entry: entryFor(key), adRef: `keyword:${key}` };
  }
  const looksLikeAd = /referral|ctwa|ad_id|source_id|ads_context|story|reel|shared_post|ig_post/i.test(text);
  return { entry: null, adRef: looksLikeAd ? (ids[0] || 'unknown') : '' };
}

function adEntryNote(entry) {
  if (!entry) return '';
  return `AD / REEL CONTEXT: this customer came from our ad/reel about "${entry.product}" - ${entry.facts} `
    + 'When they say "this stone", "this", "how much", "price?" or "Can you check the price of a product?", they mean THIS item. '
    + 'Answer about it directly; never ask which stone they mean.';
}

module.exports = { ENTRIES, AD_IDS, matchAd, adEntryNote, entryFor };
