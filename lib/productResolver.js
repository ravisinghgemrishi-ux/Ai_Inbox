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
      return { found: products.length > 0, source: 'gemrishi_product_api', products: products.slice(0, 5).map(compactProduct) };
    } finally { clearTimeout(timeout); }
  } catch (err) {
    console.error('[productResolver] live lookup failed:', err.message);
    return { found: false, source: 'error', products: [], error: err.message };
  }
}

function formatLiveProductData(result) {
  if (!result?.found || !result.products?.length) return '';
  return JSON.stringify({ source: result.source, products: result.products });
}

module.exports = { lookupLiveProduct, formatLiveProductData };
