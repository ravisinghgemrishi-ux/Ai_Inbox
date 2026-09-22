/**
 * Thin client for the GemRishi Astrology Engine's Finder Bridge
 * (https://gemrishi-astrology-engine.vercel.app/api/finder).
 *
 * That endpoint is a separate, already-live Vercel project. It geocodes the
 * birth place, calls the Navamsha chart API, computes Dasha + D9, and runs
 * the Rudraksha recommendation engine (v4.0) against a verified Shopify
 * catalog snapshot - all in one POST. This file only wraps that call with
 * the timeout / error-shape conventions already used elsewhere in this repo
 * (see productResolver.js) so a slow or failing engine never blocks a reply.
 *
 * Required by the engine: date, time, place, purpose. Everything else is
 * optional. See ASTROLOGY_ENGINE_URL below to point this at a different
 * deployment (e.g. a staging copy) without touching call sites.
 */

const DEFAULT_ENGINE_URL = 'https://gemrishi-astrology-engine.vercel.app';
const REQUEST_TIMEOUT_MS = 12000;

function engineBaseUrl() {
  return (process.env.ASTROLOGY_ENGINE_URL || DEFAULT_ENGINE_URL).replace(/\/$/, '');
}

/**
 * @param {object} birthDetails
 * @param {string} birthDetails.name
 * @param {string} birthDetails.date - "YYYY-MM-DD"
 * @param {string} birthDetails.time - "HH:MM" or "HH:MM:SS" (24h)
 * @param {string} birthDetails.place - free-text place name; the engine geocodes it
 * @param {string} birthDetails.purpose - free-text reason (e.g. "wealth", "protection from negativity")
 * @param {number} [birthDetails.budget]
 * @returns {Promise<{success: boolean, data?: object, error?: string, status?: number}>}
 */
async function getKundliReading({ name, date, time, place, purpose, budget } = {}) {
  if (!date || !time || !place || !purpose) {
    return { success: false, error: 'missing_required_field' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${engineBaseUrl()}/api/finder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, date, time, place, purpose, budget }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) {
      return { success: false, status: res.status, error: data?.error || `engine returned ${res.status}` };
    }
    return { success: true, data };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : err.message;
    console.error('[astrologyEngineClient] finder call failed:', reason);
    return { success: false, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The current running Mahadasha (major planetary period), the single
 * strongest signal the recommendation engine uses. Mirrors the identical
 * helper inside the astrology engine's own recommend/route.js so results
 * stay consistent with what that engine would compute itself.
 */
function currentMahadasha(dasha) {
  const periods = dasha?.output?.mahadashas;
  if (!Array.isArray(periods)) return null;
  const now = new Date();
  return periods.find((period) => {
    const start = new Date(period.start);
    const end = new Date(period.end);
    return now >= start && now < end;
  }) || null;
}

module.exports = { getKundliReading, currentMahadasha, engineBaseUrl };
