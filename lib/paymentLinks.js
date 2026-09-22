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

// Confirmed by Ravi: rudraksha.gemrishi.com is the live, checkout-enabled
// domain with an active payment gateway. Set GEMRISH_SHOPIFY_DOMAIN in
// Vercel only if this ever needs to be overridden (e.g. a staging store).
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
 * Plain product PAGE link (not a cart/checkout link) - just navigates the
 * customer to the product so they can review and buy it themselves. Lower-
 * friction than a cart link (Ravi's call: share the product link, let the
 * customer go buy it themselves rather than a pre-loaded cart).
 * @param {string} productHandle
 * @returns {string|null}
 */
function buildProductPageLink(productHandle) {
  if (!productHandle) return null;
  return `https://${shopifyDomain()}/products/${productHandle}`;
}

/**
 * Consultation plans are pre-made Razorpay payment pages, not Shopify
 * products, so they're just a name -> URL lookup.
 *
 * SOURCE OF TRUTH (2026-09-23): Ravi sent 5 Razorpay links, matched to the
 * 6-tier plan table (Free/199/499/1199/2999/4999) by the price already
 * encoded in each link's own name - three of the five (_1199, _2999, _4999)
 * name their price exactly, which is what anchors this mapping; the base
 * link and "_1" link are the two tiers below that (199, then 499) in the
 * same sequence. There is no link for the Free tier - it has no payment.
 * If this mapping is ever wrong, just correct the "url" values below.
 */
const DEFAULT_CONSULTATION_PLANS = {
  consultation_199: { label: 'Consultation - Rs 199', url: 'https://rzp.io/rzp/Astrologer_Consulatation' },
  consultation_499: { label: 'Consultation - Rs 499', url: 'https://rzp.io/rzp/Astrologer_Consulatation_1' },
  consultation_1199: { label: 'Consultation - Rs 1,199', url: 'https://rzp.io/rzp/Astrologer_Consulatation_1199' },
  consultation_2999: { label: 'Consultation - Rs 2,999', url: 'https://rzp.io/rzp/Astrologer_Consulatation_2999' },
  consultation_4999: { label: 'Consultation - Rs 4,999', url: 'https://rzp.io/rzp/Astrologer_Consulatation_4999' },
};

function consultationPlans() {
  const raw = process.env.GEMRISH_CONSULTATION_PLANS;
  if (!raw) return DEFAULT_CONSULTATION_PLANS;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[paymentLinks] GEMRISH_CONSULTATION_PLANS is not valid JSON, using the built-in default plan table:', err.message);
    return DEFAULT_CONSULTATION_PLANS;
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
  buildProductPageLink,
  getConsultationPaymentLink,
  listConsultationPlans,
  shopifyDomain,
};
