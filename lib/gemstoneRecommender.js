/**
 * Rule-based gemstone recommendation.
 *
 * This is the piece that does NOT already exist anywhere - the astrology
 * engine's recommend endpoint (v4.0) only scores Rudraksha against a live
 * Shopify catalog. There is no gemstone equivalent yet, so this file is a
 * deliberately simple v1: it mirrors the SAME scoring shape the Rudraksha
 * engine uses (purpose match + current Mahadasha lord) so the two branches
 * of the Kundli flow feel consistent, but it scores against the planet-gem
 * mapping and catalog notes already reviewed and approved in
 * knowledgeBase.js (GEMSTONE_CATALOG_NOTES) rather than inventing new
 * copy or prices.
 *
 * Deliberately NOT included, to match the price-safety rule already in
 * replyEngine.js: no Shopify variant IDs (none are mapped for gemstones
 * yet) and no fixed price - the catalog notes' indicative ranges are
 * surfaced instead, exactly as Mannat already does in normal chat.
 */

// Keep this in sync with GEMSTONE_CATALOG_NOTES' "Quick planet-to-gem
// reference" in knowledgeBase.js. Duplicated intentionally (small, stable
// table) rather than parsed out of the prose notes at runtime.
const GEMSTONE_RULES = [
  { gem: 'Ruby (Manikya)', planet: 'Sun', purposes: ['leadership', 'confidence', 'vitality', 'career', 'growth', 'authority', 'power', 'name', 'fame'] },
  { gem: 'Pearl (Moti)', planet: 'Moon', purposes: ['emotional', 'balance', 'peace', 'mind', 'intuition', 'calm', 'family', 'harmony'] },
  { gem: 'Red Coral (Moonga)', planet: 'Mars', purposes: ['courage', 'confidence', 'leadership', 'protection', 'energy', 'strength'] },
  { gem: 'Emerald (Panna)', planet: 'Mercury', purposes: ['communication', 'intellect', 'business', 'creativity', 'education', 'learning', 'speech'] },
  { gem: 'Yellow Sapphire (Pukhraj)', planet: 'Jupiter', purposes: ['wealth', 'wisdom', 'marriage', 'spiritual', 'growth', 'prosperity', 'knowledge'] },
  { gem: 'Diamond (Heera)', planet: 'Venus', purposes: ['love', 'luxury', 'beauty', 'comfort', 'fame', 'relationship', 'marriage'] },
  { gem: 'Blue Sapphire (Neelam)', planet: 'Saturn', purposes: ['success', 'protection', 'fame', 'transformation', 'business', 'promotion', 'discipline'] },
  { gem: 'Gomed (Hessonite)', planet: 'Rahu', purposes: ['clarity', 'foreign', 'success', 'protection', 'obstacles', 'illusion'] },
  { gem: "Cat's Eye (Lehsunia)", planet: 'Ketu', purposes: ['spiritual', 'protection', 'intuition', 'focus', 'transformation', 'fearlessness'] },
];

function normalize(value) {
  return String(value || '').toLowerCase().trim();
}

function purposeScore(purpose, rule) {
  const p = normalize(purpose);
  if (!p) return 0;
  return rule.purposes.some((keyword) => p.includes(normalize(keyword))) ? 50 : 0;
}

function dashaScore(activeDasha, rule) {
  if (!activeDasha?.lord) return 0;
  return normalize(activeDasha.lord) === normalize(rule.planet) ? 50 : 0;
}

/**
 * @param {object} input
 * @param {string} [input.purpose] - the customer's stated reason, free text
 * @param {{lord: string, start: string, end: string}|null} [input.activeDasha] - from astrologyEngineClient.currentMahadasha()
 * @returns {{primary: object|null, alternatives: object[]}}
 */
function recommendGemstone({ purpose, activeDasha } = {}) {
  const ranked = GEMSTONE_RULES
    .map((rule) => {
      const purposePart = purposeScore(purpose, rule);
      const dashaPart = dashaScore(activeDasha, rule);
      const score = purposePart + dashaPart;
      if (score === 0) return null;
      const reasons = [];
      if (purposePart) reasons.push('matches what you told me you\'re looking for');
      if (dashaPart) reasons.push(`matches your current Mahadasha lord (${activeDasha.lord})`);
      return { gem: rule.gem, planet: rule.planet, score, reasons };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // Fallback: if nothing scored (no purpose match and/or no dasha data),
  // still surface the gem tied to the current Mahadasha lord alone, since
  // that's the traditional starting point for "what should I wear" -
  // never leave the customer with nothing after they've shared their chart.
  if (ranked.length === 0 && activeDasha?.lord) {
    const rule = GEMSTONE_RULES.find((r) => normalize(r.planet) === normalize(activeDasha.lord));
    if (rule) {
      ranked.push({ gem: rule.gem, planet: rule.planet, score: 10, reasons: [`traditionally associated with your current Mahadasha lord (${activeDasha.lord})`] });
    }
  }

  return { primary: ranked[0] || null, alternatives: ranked.slice(1, 3) };
}

module.exports = { recommendGemstone, GEMSTONE_RULES };
