/**
 * Payment link helpers for the Kundli flow's "ready to buy" step.
 *
 * Per the confirmed design decision (see the "Kundli Flow Feasibility
 * Checklist" doc): products stay on Shopify's own checkout (Razorpay runs
 * underneath as the payment gateway, unchanged), and consultations use
 * separate, pre-made payment-page links, one per plan. Nothing here talks
 * to Razorpay directly, and nothing here invents a price - nothing beyond
 * a Shopify cart permalink and a lookup into a configured link table.
 */

// TODO(Ravi): confirm this is the correct checkout-enabled domain before
// turning the flow on. Set GEMRISH_SHOPIFY_DOMAIN in Vercel to override.
const DEFAULT_SHOPIFY_DOMAIN = 'rudraksha.gemrishi.com';

function shopifyDomain() {
  return process.env.GEMRISH_SHOPIFY_DOMAIN || DEFAULT_SHOPIFY_DOMAIN;
}

/**
 * Builds a Shopify cart permalink for one or more variants, per Shopify's
 * documented format: /cart/{variantId}:{qty} or, for multiple items,
 * /cart/{id1}:{qty1},{id2}:{qty2}.
 * @param {{variantId: string, quantity?: number}[]} items
 * @returns {string|null} null if no valid items were given
 */
function buildProductCartLink(items = []) {
  const parts = items
    .filter((item) => item && item.variantId)
    .map((item) => `${item.variantId}:${Math.max(1, Number(item.quantity) || 1)}`);
  if (parts.length === 0) return null;
  return `https://${shopifyDomain()}/cart/${parts.join(',')}`;
}

/**
 * Consultation plans are pre-made payment pages, not Shopify products, so
 * they're just a name -> URL lookup. THIS TABLE IS A PLACEHOLDER - it has
 * not been filled in with GemRishi's real consultation plans/links yet.
 * Configure it either by editing this object once the real list is in
 * hand, or by setting GEMRISH_CONSULTATION_PLANS in Vercel to a JSON
 * string of the same shape, e.g.:
 *   {"gemstone_consultation": {"label": "Gemstone Consultation", "url": "https://..."}}
 */
const PLACEHOLDER_CONSULTATION_PLANS = {
  // 'gemstone_consultation': { label: 'Gemstone Consultation', url: '' },
  // 'rudraksha_consultation': { label: 'Rudraksha Consultation', url: '' },
};

function consultationPlans() {
  const raw = process.env.GEMRISH_CONSULTATION_PLANS;
  if (!raw) return PLACEHOLDER_CONSULTATION_PLANS;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[paymentLinks] GEMRISH_CONSULTATION_PLANS is not valid JSON, using placeholder table:', err.message);
    return PLACEHOLDER_CONSULTATION_PLANS;
  }
}

/**
 * @param {string} planKey
 * @returns {{configured: boolean, label?: string, url?: string}}
 */
function getConsultationPaymentLink(planKey) {
  const plans = consultationPlans();
  const plan = plans[planKey];
  if (!plan || !plan.url) return { configured: false };
  return { configured: true, label: plan.label || planKey, url: plan.url };
}

function listConsultationPlans() {
  return Object.entries(consultationPlans())
    .filter(([, plan]) => plan?.url)
    .map(([key, plan]) => ({ key, label: plan.label || key }));
}

module.exports = {
  buildProductCartLink,
  getConsultationPaymentLink,
  listConsultationPlans,
  shopifyDomain,
};
