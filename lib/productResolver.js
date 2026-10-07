const crypto = require('crypto');

// =============================================================================
// productResolver.js — Mannat's live product knowledge base
//
// Rewritten 2026-09-28 (Ravi): Mannat now reads GemRishi's product catalogue
// straight from Google Sheets. Ravi's rule: the sheet mirrors the website and
// is updated whenever prices or inventory change, so whatever is in the sheet
// can be quoted to customers directly. Anything NOT in the sheet -> "subject
// to availability, our team will confirm".
//
// Sources (in order):
//   1. Google Sheets listed in PRODUCT_SHEETS (defaults to the gemstone sheet
//      "GemRishi Inv - Website"). A Rudraksha sheet is added by appending it to
//      PRODUCT_SHEETS — no code change needed.
//   2. The old GEMRISH_PRODUCT_API_URL lookup, only if that env var is ever set
//      and the sheets found nothing. (As of 2026-09-28 it is NOT set.)
//
// PRODUCT_SHEETS format:  label|spreadsheetId|gid ; label|spreadsheetId|gid
//   e.g. gemstones|1eeWZUtX...|339108187;rudraksha|1AbC...|0
//
// Requirement: each sheet must be shared "Anyone with the link -> Viewer".
// These are the same public prices shown on the website, so nothing private
// is exposed. Read-only; this code never writes to the sheets.
//
// Business rules baked in (confirmed by Ravi):
//   - "Price (INR)" is what the customer pays; "Sell Price (INR)" is the
//     crossed-out MRP.
//   - Rings / pendants / bracelets are the metal setting only; the stone is
//     priced separately (total = stone + setting).
//   - Only in-stock items are offered (Stock 0 or "Out of Stock" = not offered).
//   - Customers get the product PAGE link only. Image links are never passed
//     to the model (they currently point to localhost and don't work anyway).
//
// Performance: the whole catalogue (~1.8k rows) is fetched once and kept in
// memory for 30 minutes per warm function instance. If a refresh fails, the
// last good copy keeps being used. Per-query results are also cached in Redis
// for 90s (same as before), and failures are never cached.
// =============================================================================

const DEFAULT_SHEETS = [
  { label: 'gemstones', id: '1eeWZUtXcBNv9cZ26bwe_SV0atuJpxb1N2__WEHdUYK0', gid: '339108187' },
];
const CATALOG_TTL_MS = 30 * 60 * 1000;
const SHEET_FETCH_TIMEOUT_MS = 6000;
const MAX_RESULTS = 5;
const MAX_SETTINGS = 3;

// ---------------------------------------------------------------------------
// Redis per-query cache (unchanged behaviour, new key version)
// ---------------------------------------------------------------------------
const PRODUCT_CACHE_TTL_SECONDS = 90;
const PRODUCT_CACHE_REDIS_PREFIX = 'gemrishi:product-cache:v2:';

function productCacheRedisConfig() {
  return {
    url: (process.env.REDIS_KV_REST_API_URL || process.env.REDIS_URL || '').replace(/\/$/, ''),
    token: process.env.REDIS_KV_REST_API_TOKEN || process.env.REDIS_K_TOKEN || '',
  };
}

async function productCacheRedisCommand(path, method = 'GET') {
  const { url, token } = productCacheRedisConfig();
  if (!url || !token) return null;
  const res = await fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return res.json().catch(() => ({}));
}

function productCacheKey(query) {
  const normalized = String(query || '').trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return `${PRODUCT_CACHE_REDIS_PREFIX}${hash}`;
}

async function readCachedProduct(query) {
  try {
    const data = await productCacheRedisCommand(`/get/${encodeURIComponent(productCacheKey(query))}`);
    if (!data?.result) return null;
    return JSON.parse(data.result);
  } catch {
    return null;
  }
}

async function writeCachedProduct(query, result) {
  try {
    await productCacheRedisCommand(`/set/${encodeURIComponent(productCacheKey(query))}/${encodeURIComponent(JSON.stringify(result))}/EX/${PRODUCT_CACHE_TTL_SECONDS}`, 'POST');
  } catch (err) {
    console.error('[productResolver] failed to cache product lookup:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Sheet loading
// ---------------------------------------------------------------------------
function sheetSources() {
  const raw = (process.env.PRODUCT_SHEETS || '').trim();
  if (!raw) return DEFAULT_SHEETS;
  return raw
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [label, id, gid] = s.split('|').map((x) => (x || '').trim());
      return { label: label || 'products', id, gid: gid || '0' };
    })
    .filter((s) => s.id);
}

// RFC4180-style CSV parser (handles quoted fields with commas/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchSheetCsv(source) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(source.id)}/export?format=csv&gid=${encodeURIComponent(source.gid)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHEET_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`sheet ${source.label} returned ${res.status}`);
    const text = await res.text();
    // A private sheet returns Google's HTML login page instead of CSV.
    if (/^\s*<(!doctype|html)/i.test(text)) {
      throw new Error(`sheet ${source.label} is not shared as "Anyone with the link -> Viewer"`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Column detection by header name, so a Rudraksha sheet with different
// headers still works. Checked in order; first match wins.
const COLUMN_RULES = {
  image: (h) => h.includes('image') || h.includes('photo') || h.includes('img'),
  mrp: (h) => h.includes('mrp') || h.includes('compare') || h === 'sellprice' || h === 'sellpriceinr',
  price: (h) => ['price', 'priceinr', 'saleprice', 'offerprice', 'sellingprice', 'finalprice', 'variantprice'].includes(h),
  name: (h) => ['productname', 'name', 'title', 'producttitle', 'product'].includes(h),
  type: (h) => ['type', 'category', 'producttype', 'productcategory'].includes(h),
  stock: (h) => ['stock', 'quantity', 'qty', 'inventory', 'inventoryqty', 'variantinventoryqty', 'stockqty'].includes(h),
  availability: (h) => h === 'availability' || h === 'available' || h === 'instock',
  url: (h) => ['producturl', 'url', 'link', 'productlink', 'productpage'].includes(h),
  sku: (h) => h === 'sku' || h === 'variantsku',
  ratti: (h) => h === 'ratti' || h === 'rati',
  carat: (h) => h === 'carat' || h === 'ct',
  weight: (h) => h === 'weight' || h.startsWith('weight'),
  origin: (h) => h === 'origin' || h === 'country',
  shape: (h) => h === 'shape',
  color: (h) => h === 'color' || h === 'colour',
  cut: (h) => h === 'cut',
  treatment: (h) => h.includes('treatment') || h === 'metal',
  certificate: (h) => h.includes('certificat'),
  delivery: (h) => h.includes('delivery'),
  mukhi: (h) => h.includes('mukhi'),
  description: (h) => h.includes('description') || h === 'body' || h === 'bodyhtml' || h === 'details',
};
// Columns that are internal bookkeeping and never useful to a customer.
const IGNORED_HEADERS = new Set(['dateadded', 'timeadded', 'status', 'createdat', 'updatedat', 'id', 'handle']);

function mapColumns(headers) {
  const map = {};
  const used = new Set();
  headers.forEach((raw, idx) => {
    const h = normHeader(raw);
    for (const [key, test] of Object.entries(COLUMN_RULES)) {
      if (test(h)) {
        if (!(key in map)) map[key] = idx;
        used.add(idx);
        return;
      }
    }
  });
  const extras = headers
    .map((raw, idx) => ({ raw: String(raw).trim(), idx }))
    .filter(({ raw, idx }) => raw && !used.has(idx) && !IGNORED_HEADERS.has(normHeader(raw)));
  return { map, extras };
}

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => {
  const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// Stone names: English canonical + Hindi/Jyotish name, incl. common misspellings
// seen in the catalogue (EMARALD, EMRALD, ONEX...) and in customer chats.
const STONES = [
  ['Yellow Sapphire', 'Pukhraj', /\b(yellow\s*sapph?ire|pukh?raa?j|pukraj|pushp?araa?g)\b/, ['पुखराज']],
  ['Pitambari (Bi-colour Sapphire)', 'Pitambari Neelam', /\b(pitambari|neelambari|bi-?\s*colou?r\s*sapph?ire)\b/, []],
  ['Purple Sapphire', 'Purple Sapphire', /\bpurple\s*sapph?ire\b/, []],
  ['Blue Sapphire', 'Neelam', /\b(blue\s*sapph?ire|neel[a]?m|nilam)\b/, ['नीलम']],
  ['White Sapphire', 'Safed Pukhraj', /\b(white\s*sapph?ire|safed\s*pukh?raa?j)\b/, []],
  ['Pink Sapphire', 'Pink Pukhraj', /\bpink\s*sapph?ire\b/, []],
  ['Ruby', 'Manik', /\b(ruby|rubi|manik|manikya|maa?nik)\b/, ['माणिक', 'माणिक्य', 'माणिक']],
  ['Emerald', 'Panna', /\b(emerald|emarald|emrald|emrold|emerlad|panna|pannah)\b/, ['पन्ना']],
  ['White Coral', 'Safed Moonga', /\b(white\s*coral|safed\s*moo?nga|safed\s*munga)\b/, []],
  ['Red Coral', 'Moonga', /\b(red\s*coral|coral|moo?nga|munga)\b/, ['मूंगा', 'मूँगा']],
  ['Pearl', 'Moti', /\b(pearl|moti|mukta)\b/, ['मोती']],
  ['Hessonite', 'Gomed', /\b(hessonite|gomedh?|gomedak)\b/, ['गोमेद']],
  ["Cat's Eye", 'Lehsuniya', /\b(cat'?s?\s*eye|catseye|leh?sun\w*|lahsun\w*|vaidurya)\b/, ['लहसुनिया']],
  ['Diamond', 'Heera', /\b(diamond|heera|hira)\b/, ['हीरा']],
  ['Opal', 'Opal', /\bopal\b/, ['ओपल']],
  ['Zircon', 'Jarkan', /\b(zircon|jarkan)\b/, []],
  ['Amethyst', 'Katela', /\b(amethyst|katela|jamunia)\b/, ['कटेला']],
  ['Citrine', 'Sunela', /\b(citrine|sunela)\b/, ['सुनेला']],
  ['Turquoise', 'Firoza', /\b(turquoise|fi?roza|feroza|firoja)\b/, ['फिरोजा']],
  ['Garnet', 'Garnet', /\bgarnet\b/, []],
  ['Moonstone', 'Chandrakant', /\b(moon\s*stone|chandrakant)\b/, []],
  ['Onyx', 'Sulemani', /\b(onyx|onex|sulemani)\b/, []],
  ['Peridot', 'Zabarjad', /\b(peridot|zabarjad)\b/, []],
  ['Aquamarine', 'Beruj', /\b(aqu?armine|aquamarine|beruj|beruz)\b/, []],
  ['Blue Topaz', 'Blue Topaz', /\bblue\s*topaz\b/, []],
  ['Topaz', 'Topaz', /\btopaz\b/, []],
  ['Lapis Lazuli', 'Lajward', /\b(lapis|lajwa?r[dt])\b/, []],
  ['Iolite', 'Neeli', /\b(iolite|kaka\s*neeli|neeli)\b/, []],
  ['Tanzanite', 'Tanzanite', /\btanzanite\b/, []],
  ['Tourmaline', 'Tourmaline', /\btourmaline\b/, []],
  ['Spinel', 'Spinel', /\bspinel\b/, []],
  ['Jade', 'Jade', /\bjade\b/, []],
  ["Tiger's Eye", "Tiger's Eye", /\btiger'?s?\s*eye\b/, []],
  ['Rose Quartz', 'Rose Quartz', /\brose\s*quartz\b/, []],
  ['Crystal', 'Sphatik', /\b(sphatik|sphatic|clear\s*quartz|crystal)\b/, ['स्फटिक']],
  ['Malachite', 'Malachite', /\bmalachite\b/, []],
  ['Labradorite', 'Labradorite', /\blabradorite\b/, []],
  ['Carnelian', 'Carnelian', /\bcarnelian\b/, []],
  ['Hakik', 'Aqeeq', /\b(hakik|haqeeq|aqeeq|akik|agate)\b/, ['हकीक']],
  ['Morganite', 'Morganite', /\bmorganite\b/, []],
  ['Kunzite', 'Kunzite', /\bkunzite\b/, []],
  ['Pyrite', 'Pyrite', /\bpyrite\b/, []],
  ['Gun Metal', 'Gun Metal', /\bgun\s*metal\b/, []],
];

function detectStones(text) {
  const t = String(text || '').toLowerCase();
  let found = [];
  for (const [canonical, hindi, re, deva] of STONES) {
    if (re.test(t) || deva.some((d) => t.includes(d))) found.push({ canonical, hindi });
  }
  const has = (c) => found.some((s) => s.canonical === c);
  let out = found;
  // "White/Pink Sapphire" must not also count as Yellow Sapphire via "pukhraj".
  if (has('White Sapphire') || has('Pink Sapphire')) out = out.filter((s) => s.canonical !== 'Yellow Sapphire');
  // "White Coral" is not Red Coral; "Pitambari neelam" is not plain Neelam.
  if (has('White Coral')) out = out.filter((s) => s.canonical !== 'Red Coral');
  if (has('Pitambari (Bi-colour Sapphire)')) out = out.filter((s) => s.canonical !== 'Blue Sapphire');
  found = out;
  // "Blue Topaz" should not also match plain Topaz.
  if (found.some((s) => s.canonical === 'Blue Topaz')) return found.filter((s) => s.canonical !== 'Topaz');
  return found;
}

function categoryOf(typeValue, name) {
  const t = `${typeValue} ${name}`.toLowerCase();
  if (/rudraksh/.test(t)) return 'rudraksha';
  if (/\bring\b/.test(String(typeValue).toLowerCase())) return 'ring';
  if (/pendant|locket/.test(String(typeValue).toLowerCase())) return 'pendant';
  if (/bracelet/.test(String(typeValue).toLowerCase())) return 'bracelet';
  if (/gem|stone/.test(String(typeValue).toLowerCase())) return 'gemstone';
  return clean(typeValue).toLowerCase() || 'product';
}

function metalOf(text) {
  const t = String(text || '').toLowerCase();
  if (/silver|chandi|925/.test(t)) return 'silver';
  if (/gold|sona|\b(14|18|22)\s*k/.test(t)) return 'gold';
  if (/panch\s*dh?atu|panchdhatu/.test(t)) return 'panchdhatu';
  if (/copper|tamba/.test(t)) return 'copper';
  return '';
}

function isInStock(row, map) {
  const availability = map.availability !== undefined ? clean(row[map.availability]).toLowerCase() : '';
  const stock = map.stock !== undefined ? num(row[map.stock]) : null;
  if (/out\s*of\s*stock|sold\s*out|unavailable/.test(availability)) return false;
  if (/0\s*stock/.test(availability)) return false;
  if (stock !== null && stock <= 0) return false;
  return true;
}

function buildProducts(csvText, source) {
  const rows = parseCsv(csvText).filter((r) => r.some((c) => clean(c)));
  if (rows.length < 2) return [];
  const { map, extras } = mapColumns(rows[0]);
  if (map.name === undefined) {
    console.error(`[productResolver] sheet ${source.label}: no product name column found`);
    return [];
  }
  const get = (row, key) => (map[key] !== undefined ? clean(row[map[key]]) : '');
  const out = [];
  for (const row of rows.slice(1)) {
    const rawName = get(row, 'name');
    if (!rawName) continue;
    // One catalogue row had a whole marketing paragraph pasted into the name.
    const name = rawName.length > 140 ? `${rawName.slice(0, 137).trim()}...` : rawName;
    const type = get(row, 'type');
    const category = source.label.toLowerCase().includes('rudraksh') ? 'rudraksha' : categoryOf(type, name);
    const stones = category === 'gemstone' ? detectStones(name) : [];
    const stone = stones[0] || null;
    const treatment = get(row, 'treatment');
    const product = {
      source: source.label,
      category,
      name,
      stone: stone ? `${stone.canonical} (${stone.hindi})` : undefined,
      price_inr: num(get(row, 'price')),
      mrp_inr: num(get(row, 'mrp')),
      ratti: num(get(row, 'ratti')),
      carat: num(get(row, 'carat')),
      mukhi: num(get(row, 'mukhi')) ?? num((name.match(/(\d+)\s*mukhi/i) || [])[1]),
      origin: get(row, 'origin'),
      shape: get(row, 'shape'),
      color: get(row, 'color'),
      cut: get(row, 'cut'),
      treatment_or_metal: treatment,
      certificate: get(row, 'certificate').slice(0, 300),
      delivery: get(row, 'delivery'),
      description: get(row, 'description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
      url: /^https?:\/\//i.test(get(row, 'url')) ? get(row, 'url') : '',
      sku: get(row, 'sku'),
    };
    // Unknown extra columns (useful for the Rudraksha sheet) — short values only.
    const extra = {};
    for (const { raw, idx } of extras) {
      const v = clean(row[idx]);
      if (v && v.length <= 200 && !/localhost/i.test(v)) extra[raw] = v;
    }
    if (Object.keys(extra).length) product.extra = extra;

    product._inStock = isInStock(row, map);
    product._stoneKey = stone ? stone.canonical : '';
    product._metal = category === 'gemstone' ? '' : metalOf(`${name} ${treatment} ${type}`);
    product._search = [name, stone?.canonical, stone?.hindi, product.origin, product.color, product.shape,
      product.cut, treatment, type, category, product.sku, Object.values(extra).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
    if (product.price_inr === null || product.price_inr <= 0) product._inStock = false; // never quote a blank price
    out.push(product);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Catalogue cache (in memory, stale-while-revalidate)
// ---------------------------------------------------------------------------
let catalogState = { at: 0, products: null, loading: null };

async function loadCatalog() {
  const sources = sheetSources();
  const settled = await Promise.allSettled(sources.map(async (s) => buildProducts(await fetchSheetCsv(s), s)));
  const products = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') products.push(...r.value);
    else console.error(`[productResolver] failed to load sheet ${sources[i].label}:`, r.reason?.message);
  });
  return products;
}

async function getCatalog() {
  const fresh = catalogState.products && Date.now() - catalogState.at < CATALOG_TTL_MS;
  if (fresh) return catalogState.products;
  if (!catalogState.loading) {
    catalogState.loading = loadCatalog()
      .then((products) => {
        if (products.length) catalogState = { at: Date.now(), products, loading: null };
        else catalogState.loading = null; // keep last good copy
        return catalogState.products;
      })
      .catch((err) => {
        console.error('[productResolver] catalogue refresh failed:', err.message);
        catalogState.loading = null;
        return catalogState.products;
      });
  }
  // Stale copy available -> answer instantly, refresh in the background.
  if (catalogState.products) return catalogState.products;
  return (await catalogState.loading) || [];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(('the and for with you your what price rate kya hai hain kitna kitne kitni ka ki ke ko me mein '
  + 'please plz pls chahiye chaiye bata batao batana send share details detail available availability stock '
  + 'have want need show about this that from are can how much cost rs inr rupees ratti rati carat ring pendant '
  + 'gemstone stone original natural real best good price? hello hii hi sir mam ji bhai').split(/\s+/));

function parseQuery(query) {
  const q = String(query || '').toLowerCase();
  const rattiM = q.match(/(\d+(?:\.\d+)?)\s*(?:ratti|rati|रत्ती|रती)/);
  const caratM = q.match(/(\d+(?:\.\d+)?)\s*(?:carat|carats|ct|cts|kerat)\b/);
  const mukhiM = q.match(/(\d+)\s*(?:mukhi|mukh|मुखी)/);
  let type = '';
  if (/\bring\b|rings|angoothi|anguthi|अंगूठी/.test(q)) type = 'ring';
  else if (/pendant|locket|लॉकेट/.test(q)) type = 'pendant';
  else if (/bracelet|kada/.test(q)) type = 'bracelet';
  const wantsRudraksha = /rudr?aksh|रुद्राक्ष|mukhi|मुखी/.test(q);
  const tokens = q.split(/[^a-z0-9\u0900-\u097f']+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return {
    q,
    stones: detectStones(q).map((s) => s.canonical),
    ratti: rattiM ? Number(rattiM[1]) : null,
    carat: caratM ? Number(caratM[1]) : null,
    mukhi: mukhiM ? Number(mukhiM[1]) : null,
    type,
    metal: metalOf(q),
    wantsRudraksha,
    tokens,
  };
}

function scoreProduct(p, pq) {
  let score = 0;
  for (const t of pq.tokens) if (p._search.includes(t)) score += 2;
  if (pq.ratti && p.ratti) score += Math.max(0, 10 - Math.abs(p.ratti - pq.ratti) * 4);
  if (pq.carat && p.carat) score += Math.max(0, 10 - Math.abs(p.carat - pq.carat) * 6);
  if (pq.mukhi && p.mukhi === pq.mukhi) score += 15;
  if (pq.type && p.category === pq.type) score += 5;
  if (pq.metal && p._metal === pq.metal) score += 3;
  return score;
}

function publicView(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('_') || k === 'sku') continue;
    if (v === null || v === undefined || v === '' || (typeof v === 'object' && !Object.keys(v).length)) continue;
    out[k] = v;
  }
  return out;
}

function summarize(list) {
  const prices = list.map((p) => p.price_inr).filter((x) => x);
  const rattis = list.map((p) => p.ratti).filter((x) => x);
  return {
    in_stock_count: list.length,
    price_range_inr: prices.length ? [Math.min(...prices), Math.max(...prices)] : undefined,
    ratti_range: rattis.length ? [Math.min(...rattis), Math.max(...rattis)] : undefined,
  };
}

function searchCatalog(catalog, query) {
  const pq = parseQuery(query);
  const inStock = catalog.filter((p) => p._inStock);

  let candidates;
  if (pq.stones.length) {
    candidates = inStock.filter((p) => pq.stones.includes(p._stoneKey));
  } else if (pq.wantsRudraksha) {
    candidates = inStock.filter((p) => p.category === 'rudraksha');
  } else if (pq.type && !pq.tokens.length) {
    candidates = inStock.filter((p) => p.category === pq.type);
  } else {
    candidates = inStock;
  }

  // Stone/rudraksha named but none in stock -> tell the model explicitly.
  if (!candidates.length && (pq.stones.length || pq.wantsRudraksha)) {
    const catalogHasIt = pq.stones.length
      ? catalog.some((p) => pq.stones.includes(p._stoneKey))
      : catalog.some((p) => p.category === 'rudraksha');
    return {
      found: false,
      source: 'google_sheet',
      reason: catalogHasIt ? 'out_of_stock' : 'not_in_catalogue',
      asked_for: pq.stones.length ? pq.stones : ['Rudraksha'],
      products: [],
    };
  }

  const scored = candidates
    .map((p) => ({ p, s: scoreProduct(p, pq) }))
    .filter(({ s }) => pq.stones.length || pq.wantsRudraksha || s > 0)
    .sort((a, b) => b.s - a.s || (a.p.price_inr || 0) - (b.p.price_inr || 0));

  if (!scored.length) return { found: false, source: 'google_sheet', products: [] };

  const result = {
    found: true,
    source: 'google_sheet',
    products: scored.slice(0, MAX_RESULTS).map(({ p }) => publicView(p)),
  };
  if (pq.stones.length || pq.wantsRudraksha) result.summary = summarize(candidates);

  // Asked for a stone in a ring/pendant -> also give the cheapest matching settings.
  if (pq.stones.length && (pq.type === 'ring' || pq.type === 'pendant' || pq.type === 'bracelet')) {
    const settings = inStock
      .filter((p) => p.category === pq.type && (!pq.metal || p._metal === pq.metal))
      .sort((a, b) => a.price_inr - b.price_inr)
      .slice(0, MAX_SETTINGS);
    if (settings.length) result.settings = settings.map(publicView);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Legacy product API (only used if GEMRISH_PRODUCT_API_URL is ever set)
// ---------------------------------------------------------------------------
function normalizeApiProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const product = raw.product || raw.data || raw.item || raw;
  if (Array.isArray(product)) return product.map(normalizeApiProduct).filter(Boolean);
  return {
    name: product.title || product.name || '',
    price_inr: product.price ?? product.salePrice ?? product.finalPrice ?? null,
    available: product.available ?? product.inStock ?? (typeof product.stock === 'number' ? product.stock > 0 : null),
    url: product.url || product.productUrl || product.link || '',
    description: String(product.description || '').slice(0, 500),
    origin: product.origin || product.Origin || '',
  };
}

async function lookupViaProductApi(query) {
  const base = process.env.GEMRISH_PRODUCT_API_URL;
  if (!base) return null;
  const url = base.includes('{query}')
    ? base.replace('{query}', encodeURIComponent(query))
    : `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`product API returned ${res.status}`);
    const normalized = normalizeApiProduct(await res.json());
    const products = Array.isArray(normalized) ? normalized : normalized ? [normalized] : [];
    return { found: products.length > 0, source: 'gemrishi_product_api', products: products.slice(0, MAX_RESULTS).map(publicView) };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API (same exports and signatures as before)
// ---------------------------------------------------------------------------
async function lookupLiveProduct(query) {
  if (!query || !String(query).trim()) return { found: false, source: 'empty_query', products: [] };

  const cached = await readCachedProduct(query);
  if (cached) return cached;

  try {
    const catalog = await getCatalog();
    let result = catalog.length
      ? searchCatalog(catalog, query)
      : { found: false, source: 'sheet_unavailable', products: [] };

    if (!result.found && !result.reason) {
      const apiResult = await lookupViaProductApi(query).catch((err) => {
        console.error('[productResolver] legacy API lookup failed:', err.message);
        return null;
      });
      if (apiResult?.found) result = apiResult;
    }

    // Only cache real answers — never a failed sheet load.
    if (result.source !== 'sheet_unavailable') await writeCachedProduct(query, result);
    return result;
  } catch (err) {
    console.error('[productResolver] lookup failed:', err.message);
    return { found: false, source: 'error', products: [], error: err.message };
  }
}

const QUOTING_RULES = [
  'These are GemRishi\'s live, in-stock products. Quote ONLY products and prices listed here; never invent a product, price or stock level.',
  'price_inr is the final price the customer pays. mrp_inr is the crossed-out MRP; you may mention it as the MRP, but the price to quote is price_inr.',
  // FIX (2026-10-07, Ravi): Mannat told one customer a listed price was "per
  // carat" and another, an hour later, that it was the total - she was
  // guessing. The catalogue price is for the whole stone.
  'price_inr is the TOTAL price for that one complete stone or item as listed (its full carat/ratti weight) - it is NEVER a per-carat or per-ratti rate. If a customer asks "is this per carat?", say clearly that it is the total price for the whole stone. Never multiply or divide a listed price by carats yourself.',
  // FIX (2026-10-07, Ravi): Mannat told a Facebook commenter that ALL GemRishi
  // stones are unheated and untreated, then told an emerald buyer that
  // emeralds are "traditionally oiled" and offered "untreated options".
  'treatment_or_metal is the treatment for THAT ONE stone only, exactly as recorded (e.g. "Unheated and Untreated", "Unheated and Untreated (Oiling Only)"). Quote it word for word for that stone. Never generalise it: do not say "all our stones are untreated", and do not describe what a whole variety or origin is "usually" or "traditionally" treated with. If a customer needs a specific treatment (e.g. "no oil at all", "no heat") and no listed stone clearly matches, say our gemologist will confirm which stones meet it - do not offer options you cannot see here.',
  'Only show products of the stone/item the customer is asking about. If they say "show me all" or "show whatever you have" while discussing a stone, show more of THAT stone, never unrelated items such as pendants or other gemstones.',
  'Items with category ring/pendant/bracelet are the metal SETTING only. The gemstone is priced separately: for a gemstone ring or pendant, total = stone price + setting price.',
  'When recommending a specific product, share its product page url so the customer can see photos and full details. Never share image links.',
  'Never send a payment or checkout link; after sharing details, a team member helps with the order.',
  'Check the customer\'s requested size (ratti/carat), origin or budget against the listed fields. If nothing is an exact fit, say so honestly and offer the closest listed options.',
  'If the customer asks for something not listed here, or it is out of stock, say it is subject to availability and our team will confirm.',
];

function formatLiveProductData(result) {
  if (!result) return '';
  if (!result.found) {
    if (result.reason === 'out_of_stock' || result.reason === 'not_in_catalogue') {
      return JSON.stringify({
        source: result.source,
        status: result.reason,
        asked_for: result.asked_for,
        instruction: 'None currently in stock / listed. Tell the customer it is subject to availability and our team will confirm, then hand off to the team. Do not quote a price.',
      });
    }
    return '';
  }
  const payload = { source: result.source, rules: QUOTING_RULES, products: result.products };
  if (result.summary) payload.summary_of_all_matching_in_stock = result.summary;
  if (result.settings) payload.cheapest_matching_settings = result.settings;
  return JSON.stringify(payload);
}

module.exports = { lookupLiveProduct, formatLiveProductData, _internal: { parseCsv, buildProducts, searchCatalog, parseQuery } };
