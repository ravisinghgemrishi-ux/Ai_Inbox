function classifyIntent(message = '') {
  const text = String(message).toLowerCase().trim();
  const has = (patterns) => patterns.some((p) => p.test(text));

  if (!text) return { intent: 'unknown', confidence: 0 };
  if (has([/refund/, /return/, /replace/, /damaged/, /wrong item/, /complaint/, /angry/, /disappointed/])) return { intent: 'support_issue', confidence: 0.98 };
  if (has([/order/, /tracking/, /track my/, /shipment/, /deliver(y|ies)/, /where.*order/])) return { intent: 'order_status', confidence: 0.96 };
  if (has([/discount/, /offer/, /coupon/, /promo/, /negotiate/, /kam.*price/])) return { intent: 'offer_or_discount', confidence: 0.92 };
  if (has([/astrologer/, /astrology/, /kundli/, /birth chart/, /consultation/, /consult/])) return { intent: 'consultation', confidence: 0.96 };
  if (has([/price/, /cost/, /kitne ka/, /kitna hai/, /rate/, /₹/, /rs\.?\s*\d/])) return { intent: 'price', confidence: 0.96 };
  if (has([/recommend/, /suggest/, /mere liye/, /for me/, /which.*wear/, /kaunsa/, /konsa/, /suitable/])) return { intent: 'recommendation', confidence: 0.9 };
  if (has([/original/, /authentic/, /genuine/, /certificate/, /certified/, /real.*rudraksha/])) return { intent: 'authenticity', confidence: 0.9 };
  if (has([/mukhi/, /rudraksha/, /mala/, /bracelet/, /gauri shankar/, /trijuti/, /ganesha rudraksha/])) return { intent: 'product_info', confidence: 0.88 };
  if (has([/buy/, /purchase/, /order kar/, /chahiye/, /send.*link/, /website link/, /cod/, /payment/])) return { intent: 'purchase', confidence: 0.94 };
  if (has([/hello/, /hi\b/, /hey\b/, /thanks/, /thank you/, /nice/, /beautiful/, /wow/])) return { intent: 'general_engagement', confidence: 0.75 };
  return { intent: 'general_question', confidence: 0.55 };
}

function extractProduct(message = '') {
  const text = String(message);
  const mukhi = text.match(/\b(1[0-4]|[1-9])\s*mukhi\b/i);
  if (mukhi) return `${mukhi[1]} Mukhi Rudraksha`;
  if (/gauri\s*shankar/i.test(text)) return 'Gauri Shankar Rudraksha';
  if (/siddha\s*mala/i.test(text)) return 'Siddha Mala';
  if (/panch\s*mukhi\s*(nepal)?\s*mala/i.test(text)) return 'Panch Mukhi Nepal Mala';
  if (/rudraksha\s*mala/i.test(text)) return 'Rudraksha Mala';
  if (/rudraksha\s*bracelet/i.test(text)) return 'Rudraksha Bracelet';
  return '';
}

module.exports = { classifyIntent, extractProduct };
