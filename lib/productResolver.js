const crypto = require('crypto');

// Added 2026-09-24 (Ravi): lookupLiveProduct was hitting the live product API
// over the network on every single customer message, with no caching at all -
// so a customer asking about the same Rudraksha three times in one
// conversation ("what's the price?" ... "is it available?" ... "confirm the
// price again") triggered three separate live calls for identical data, each
// eating into reply time (up to the 4.5s timeout below). A short cache fixes
// this without any real staleness risk - 90 seconds is long enough to cover
// a customer's back-and-forth questions about the same product, short enough
// that a genuine price/stock change on the live catalog shows up again
// within a minute or two either way.
//
// Same philosophy as the Gemini context-cache in replyEngine.js: this is a
// pure speed/cost optimization layered on top of the existing behavior. If
// Redis isn't configured, or the cache read/write fails for any reason, this
// falls straight back to a live lookup every time - exactly today's
// behavior, never worse. Only a SUCCESSFUL live lookup is ever cached - a
// timeout or API error is never cached, so a transient failure can't get
// "stuck" and blocks the very next message from retrying for real.
const PRODUCT_CACHE_TTL_SECONDS = 90;
const PRODUCT_CACHE_REDIS_PREFIX = 'gemrishi:product-cache:';

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
    console.error('[productResolver] failed to cache live product lookup:', err.message);
  }
}

function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const product = raw.product || raw.data || raw.item || raw;
  if (Array.isArray(product)) return product.map(normalizeProduct).filter(Boolean);
  const available = product.available ?? product.inStock ?? (typeof product.stock === 'number' ? product.stock > 0 : null);
  return {
    id: product.id || product._id || product.productId || '',
    title: product.title || product.name || '',
    price: product.price ?? product.salePrice ?? product.finalPrice ?? null,
    currency: product.currency || 'INR',
    available,
    url: product.url || product.productUrl || product.link || '',
    description: product.description || '',
    origin: product.origin || product.Origin || '',
    grade: product.grade || product.quality || '',
  };
}

function compactProduct(product) {
  if (!product) return null;
  const out = {};
  for (const key of ['id', 'title', 'price', 'currency', 'available', 'url', 'origin', 'grade']) {
    if (product[key] !== null && product[key] !== undefined && product[key] !== '') out[key] = product[key];
  }
  if (product.description) out.description = String(product.description).slice(0, 1000);
  return out;
}

async function lookupLiveProduct(query) {
  const base = process.env.GEMRISH_PRODUCT_API_URL;
  if (!base || !query) return { found: false, source: 'not_configured', products: [] };

  const cached = await readCachedProduct(query);
  if (cached) return cached;

  const url = base.includes('{query}')
    ? base.replace('{query}', encodeURIComponent(query))
    : `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`product API returned ${res.status}`);
      const raw = await res.json();
      const normalized = normalizeProduct(raw);
      const products = Array.isArray(normalized) ? normalized : normalized ? [normalized] : [];
      const result = { found: products.length > 0, source: 'gemrishi_product_api', products: products.slice(0, 5).map(compactProduct) };
      await writeCachedProduct(query, result);
      return result;
    } finally { clearTimeout(timeout); }
  } catch (err) {
    console.error('[productResolver] live lookup failed:', err.message);
    // Deliberately not cached - a timeout/API error should never block the
    // very next message from trying again for real.
    return { found: false, source: 'error', products: [], error: err.message };
  }
}

function formatLiveProductData(result) {
  if (!result?.found || !result.products?.length) return '';
  return JSON.stringify({ source: result.source, products: result.products });
}

module.exports = { lookupLiveProduct, formatLiveProductData };
