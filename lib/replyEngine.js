const {
  BRAND_VOICE,
  CATALOG_NOTES,
  ESCALATION_RULES,
  LEAD_QUALIFICATION_RUBRIC,
} = require('./knowledgeBase');

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const SYSTEM_INSTRUCTION = `${BRAND_VOICE}

--- CATALOG NOTES ---
${CATALOG_NOTES}

--- ESCALATION RULES ---
${ESCALATION_RULES}

--- LEAD SCORING ---
${LEAD_QUALIFICATION_RUBRIC}`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    leadStatus: { type: 'string', enum: ['HOT', 'WARM', 'COLD', 'NOT_A_LEAD'] },
    productInterest: { type: 'string' },
    escalate: { type: 'boolean' },
    escalateReason: { type: 'string' },
  },
  required: ['reply', 'leadStatus', 'productInterest', 'escalate', 'escalateReason'],
};

async function generateReply({ platform, type, message, contextText }) {
  const userParts = [];

  if (contextText) {
    userParts.push({
      text: `[Context: this is a ${type} on ${platform}. The post/thread context is: "${contextText}"]`,
    });
  }
  userParts.push({ text: `Customer's ${type} message on ${platform}: "${message}"` });

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 800,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[replyEngine] generation failed:', err.message);
    return {
      reply: "Thanks for reaching out! Our team will get back to you shortly.",
      leadStatus: 'WARM',
      productInterest: '',
      escalate: true,
      escalateReason: `Model call failed or returned invalid JSON: ${err.message}`,
    };
  }
}

module.exports = { generateReply };
